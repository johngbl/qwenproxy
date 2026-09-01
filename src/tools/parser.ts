import crypto from "node:crypto";
import { robustParseJSON } from "../utils/json.ts";
import { logger, isToolcallDebugEnabled } from "../core/logger.js";
import type { ParsedToolCall } from "./types";
import type { FunctionToolDefinition } from "./types";
import {
  TOOL_CALL_OPEN,
  TOOL_CALL_CLOSE,
  getOpenNames,
  getCloseNames,
  matchToolCloseAt,
} from "./toolcall-tags.ts";

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function: {
    name?: string;
    arguments?: string;
  };
}

export interface ParserResult {
  text: string;
  toolCalls: ParsedToolCall[];
  toolCallDeltas: ToolCallDelta[];
}

export interface StreamingToolParserOptions {
  incrementalToolCalls?: boolean;
  /** Max tool calls per turn; 0 disables the cap. */
  maxToolCallsPerTurn?: number;
}

interface IncrementalJsonToolSnapshot {
  name: string | null;
  argumentsValueStart: number | null;
  argumentsValueEnd: number | null;
}

interface ActiveIncrementalToolCall {
  index: number;
  id: string;
  name: string | null;
  argumentsValueStart: number | null;
  emittedArgumentsLength: number;
  startEmitted: boolean;
  disabled: boolean;
}

// ─── XML Helpers ───────────────────────────────────────────────────────────────

const TOOL_END = "</" + "tool_call>";

interface ToolEndMatch {
  index: number;
  tag: string;
}

/**
 * Find a closing marker only when it is outside a JSON string. Tool arguments
 * frequently contain source code or tests that mention the literal
 * `</tool_call>`; using indexOf() would truncate those arguments early.
 *
 * Some Qwen-compatible templates emit the plural opening tag `<tool_calls>`
 * while still using either singular or plural closing tags, so both forms are
 * accepted here.
 */
function findToolEndOutsideJsonString(buffer: string): ToolEndMatch | null {
  const lower = buffer.toLowerCase();
  const main = scanCloseTagOutsideStringsAndFences(lower);

  if (main && closeTagContentIsParseable(buffer, main.index)) return main;

  // The escape-aware scan can exit a string early when the quote count is
  // unbalanced (logs2 02:21:02 grep payload had 11 quotes), exposing a
  // literal `</tool_call>` quoted in an argument value as a "real" close
  // (logs 02:06:35 edit_file old_text contained such an example). The real
  // close tag is terminal, so prefer the LAST parseable occurrence: a literal
  // marker is always followed by more content, so its prefix never validates.
  // Iterate from the end so a stray extra close tag (e.g. a duplicated
  // `</tool_call>` after the last payload) does not shadow earlier valid
  // payload boundaries — each candidate's prefix is checked for a parseable
  // tool payload, and the first hit from the end wins (multiple consecutive
  // missing-open payloads, each with their own close tag, are recovered one at
  // a time by the caller's loop).
  const occurrences = findCloseTagOccurrences(lower);
  for (let i = occurrences.length - 1; i >= 0; i--) {
    if (closeTagContentIsParseable(buffer, occurrences[i].index)) {
      return occurrences[i];
    }
  }

  // No candidate holds a plausible payload: do NOT close here. Closing on an
  // unparseable marker mid-stream truncates the payload at the literal tag
  // (the 342-char log drop). Deferring lets the stream continue — when the
  // real close tag arrives the scan succeeds, and at flush the unclosed-tool
  // recovery chain (robustParseJSON, brace matching) handles the remainder.
  return null;
}

/**
 * First pass: escape-aware scan for a closing marker outside JSON strings and
 * code-fence spans. In JSON a backslash always consumes the next character
 * (\" -> quote, \\ -> backslash, \\\" -> backslash+quote), so the escaped
 * char is skipped unconditionally. This keeps the scanner inside a string
 * across valid escapes; it only goes wrong on UNBALANCED quote counts, which
 * the two-tier selection in findToolEndOutsideJsonString covers.
 */
function scanCloseTagOutsideStringsAndFences(lower: string): ToolEndMatch | null {
  let inString = false;
  // Track inline code fences (backticks) as literal text, not real close
  let codeFenceLength = 0;

  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "`") {
      let runLength = 1;
      while (i + runLength < lower.length && lower[i + runLength] === "`") {
        runLength++;
      }
      if (codeFenceLength === 0) {
        codeFenceLength = runLength;
      } else if (runLength >= codeFenceLength) {
        codeFenceLength = 0;
      }
      i += runLength - 1;
      continue;
    }

    if (codeFenceLength > 0) continue;

    // Whitespace-tolerant close over every accepted tag (custom + legacy).
    const closeLen = matchToolCloseAt(lower, i);
    if (closeLen !== null) {
      return { index: i, tag: lower.substring(i, i + closeLen) };
    }
  }

  return null;
}

/** All occurrences of any accepted closing marker, in ascending index order. */
function findCloseTagOccurrences(lower: string): ToolEndMatch[] {
  const occurrences: ToolEndMatch[] = [];
  for (const name of getCloseNames()) {
    const tag = `</${name.toLowerCase()}>`;
    let from = 0;
    for (;;) {
      const index = lower.indexOf(tag, from);
      if (index === -1) break;
      occurrences.push({ index, tag });
      from = index + tag.length;
    }
  }
  return occurrences.sort((a, b) => a.index - b.index);
}

/**
 * Strict, deterministic check that the content before a candidate close tag
 * is (or is trivially repairable to) a valid JSON tool-call payload. Used to
 * decide whether a close-tag candidate is the REAL closing tag instead of a
 * literal marker that unbalanced quotes exposed to the string scanner.
 *
 * robustParseJSON is deliberately NOT used here: it over-recovers (balances
 * unclosed strings) and can throw on some inputs, so it would accept
 * truncated content as a valid close position and re-introduce the early
 * truncation bug.
 */
function closeTagContentIsParseable(buffer: string, endIdx: number): boolean {
  const content = buffer.substring(0, endIdx).trim();
  if (!content) return true;
  return tryParseJsonToolPayload(content);
}

/**
 * Plain-JSON.parse based candidate checks, in increasing tolerance order:
 * raw payload -> narrow typo repairs -> doubled trailing brace/bracket ->
 * missing opening brace/quote. Truncated payloads (unclosed strings) never
 * pass, so a mid-string literal marker is not mistaken for a real close tag.
 */
function tryParseJsonToolPayload(content: string): boolean {
  const tryParse = (s: string): boolean => {
    try {
      const parsed = JSON.parse(s);
      return typeof parsed === "object" && parsed !== null;
    } catch {
      return false;
    }
  };

  if (tryParse(content)) return true;

  const repaired = repairCommonMalformedToolJson(content);
  const stripped = content.replace(/\}+$/, "").replace(/\]+$/, "");
  const strippedRepaired = repaired.replace(/\}+$/, "").replace(/\]+$/, "");

  const candidates = [repaired, stripped];
  if (repaired !== content) candidates.push(strippedRepaired);
  candidates.push(`{\"${content}`, `{${content}`);
  if (repaired !== content) candidates.push(`{\"${repaired}`, `{${repaired}`);

  return candidates.some((candidate) => tryParse(candidate));
}

function normalizeToolNameForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseJsonishString(value: string): unknown {
  const trimmed = value.trim();
  const candidates = [trimmed];

  if (trimmed.includes('\\"')) {
    candidates.push(trimmed.replace(/\\"/g, '"'));
  }

  if (trimmed.includes("\\\\")) {
    candidates.push(trimmed.replace(/\\\\/g, "\\"));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}

    if (candidate.startsWith("{")) {
      try {
        return robustParseJSON(candidate);
      } catch {}
    }
  }

  return undefined;
}

function advanceMarkdownCodeState(
  text: string,
  initialDelimiterLength = 0,
): number {
  let delimiterLength = initialDelimiterLength;

  for (let i = 0; i < text.length;) {
    if (text[i] !== "`") {
      i++;
      continue;
    }

    let runLength = 1;
    while (i + runLength < text.length && text[i + runLength] === "`") {
      runLength++;
    }

    if (delimiterLength === 0) {
      delimiterLength = runLength;
    } else if (runLength >= delimiterLength) {
      delimiterLength = 0;
    }

    i += runLength;
  }

  return delimiterLength;
}

function findNextToolOpenTagOutsideMarkdownCode(
  buffer: string,
  initialDelimiterLength = 0,
): { index: number; openTag: string } | null {
  let delimiterLength = initialDelimiterLength;

  for (let i = 0; i < buffer.length;) {
    if (buffer[i] === "`") {
      let runLength = 1;
      while (i + runLength < buffer.length && buffer[i + runLength] === "`") {
        runLength++;
      }

      if (delimiterLength === 0) {
        delimiterLength = runLength;
      } else if (runLength >= delimiterLength) {
        delimiterLength = 0;
      }

      i += runLength;
      continue;
    }

    if (delimiterLength === 0 && buffer[i] === "<") {
      const sub = buffer.substring(i);
      for (const name of getOpenNames()) {
        const match = sub.match(new RegExp(`^<${name}\\b[^>]*>`, "i"));
        if (match && !isPrecededByBacktick(buffer, i)) {
          return { index: i, openTag: match[0] };
        }
      }
    }

    i++;
  }

  return null;
}

function findPartialToolOpenIndexOutsideMarkdownCode(
  buffer: string,
  initialDelimiterLength = 0,
): number {
  let delimiterLength = initialDelimiterLength;
  const openNames = getOpenNames();

  for (let i = 0; i < buffer.length;) {
    if (buffer[i] === "`") {
      let runLength = 1;
      while (i + runLength < buffer.length && buffer[i + runLength] === "`") {
        runLength++;
      }

      if (delimiterLength === 0) {
        delimiterLength = runLength;
      } else if (runLength >= delimiterLength) {
        delimiterLength = 0;
      }

      i += runLength;
      continue;
    }

    if (delimiterLength === 0 && buffer[i] === "<") {
      const tailLower = buffer.substring(i).toLowerCase();
      if (!tailLower.includes(">")) {
        for (const name of openNames) {
          const full = `<${name.toLowerCase()}`;
          if (full.startsWith(tailLower)) {
            return i;
          }
        }
      }
    }

    i++;
  }

  return -1;
}

function looksLikeToolCallPayload(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) return false;

  if (trimmed.startsWith("[")) {
    return trimmed.includes('"name"') || trimmed.includes("<parameter");
  }

  if (trimmed.startsWith("{")) {
    return (
      trimmed.includes('"name"') ||
      trimmed.includes('"arguments"') ||
      trimmed.includes('"tool_name"') ||
      trimmed.includes('"tool"')
    );
  }

  return trimmed.includes("<parameter") || trimmed.includes("<name>");
}

function findCandidateStarts(buffer: string): number[] {
  const starts: number[] = [];

  const pushAllMatches = (needle: string) => {
    const haystack = needle.startsWith("<") ? buffer.toLowerCase() : buffer;
    const target = needle.startsWith("<") ? needle.toLowerCase() : needle;
    let idx = haystack.indexOf(target);
    while (idx !== -1) {
      starts.push(idx);
      idx = haystack.indexOf(target, idx + 1);
    }
  };

  pushAllMatches("{");
  pushAllMatches("[");
  pushAllMatches("<parameter");
  pushAllMatches("<name>");

  return starts.sort((a, b) => a - b);
}

function looksLikePartialToolCallPayload(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) return false;

  if (trimmed.startsWith("[")) {
    return trimmed.includes('"name"') || trimmed.includes("<parameter");
  }

  if (trimmed.startsWith("{")) {
    return (
      trimmed.includes('"name"') ||
      trimmed.includes('name":') ||
      trimmed.includes('"arguments"') ||
      trimmed.includes('"tool_name"') ||
      trimmed.includes('"tool"')
    );
  }

  return trimmed.includes("<parameter") || trimmed.includes("<name>");
}

function isInsideMarkdownCodeAtIndex(
  buffer: string,
  index: number,
  initialDelimiterLength = 0,
): boolean {
  return (
    advanceMarkdownCodeState(
      buffer.substring(0, index),
      initialDelimiterLength,
    ) !== 0
  );
}

/**
 * True when the character immediately before `index` (ignoring whitespace) is
 * a backtick. Model prose frequently quotes tool-call syntax inline, e.g.
 * ``Chunks arrive with `{"name": "write_file"...``` — the global markdown
 * fence counter can drift on such text (odd runs of inline backticks), so we
 * also reject candidates/local markers that are directly prefixed by a backtick
 * as literal quoted text instead of a real tool-call boundary.
 */
function isPrecededByBacktick(buffer: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /\s/.test(buffer[i])) i--;
  return i >= 0 && buffer[i] === "`";
}

function findPartialMissingOpenToolCallIndex(
  buffer: string,
  initialDelimiterLength = 0,
): number {
  if (findToolEndOutsideJsonString(buffer)) return -1;

  const candidateStarts = findCandidateStarts(buffer);
  for (const candidateStart of candidateStarts) {
    if (
      isPrecededByBacktick(buffer, candidateStart) ||
      isInsideMarkdownCodeAtIndex(
        buffer,
        candidateStart,
        initialDelimiterLength,
      )
    ) {
      continue;
    }

    const candidate = buffer.substring(candidateStart);
    if (looksLikePartialToolCallPayload(candidate)) return candidateStart;
  }

  // The buffer starts with an object/array but is too short to show a key
  // yet (e.g. chunk boundary cut `{"na`). Hold it so later chunks can
  // complete the missing-open payload — once tool calls were emitted,
  // dropping it here would silently lose the call (user's multi-call pattern
  // with `arguments"` unquoted keys). If it never completes, flush restores
  // it as visible text (or discards it, identical to today's behavior when
  // tool calls were already emitted).
  const firstNonWs = buffer.search(/\S/);
  if (
    firstNonWs !== -1 &&
    (buffer[firstNonWs] === "{" || buffer[firstNonWs] === "[")
  ) {
    return firstNonWs;
  }

  return -1;
}

function findRecoverableMissingOpenToolCall(
  buffer: string,
  initialDelimiterLength = 0,
): {
  textBefore: string;
  candidate: string;
  consumeLength: number;
  closeTag: string;
} | null {
  const endMatch = findToolEndOutsideJsonString(buffer);
  if (!endMatch) return null;

  const endIdx = endMatch.index;
  const beforeEnd = buffer.substring(0, endIdx);
  const candidateStarts = findCandidateStarts(beforeEnd);

  for (const candidateStart of candidateStarts) {
    if (
      isPrecededByBacktick(beforeEnd, candidateStart) ||
      isInsideMarkdownCodeAtIndex(
        beforeEnd,
        candidateStart,
        initialDelimiterLength,
      ) ||
      isInsideMarkdownCodeAtIndex(buffer, endIdx, initialDelimiterLength)
    ) {
      continue;
    }

    const candidate = beforeEnd.substring(candidateStart).trim();
    if (!looksLikeToolCallPayload(candidate)) continue;

    return {
      textBefore: beforeEnd.substring(0, candidateStart),
      candidate,
      consumeLength: endIdx + endMatch.tag.length,
      closeTag: endMatch.tag,
    };
  }

  return null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function coerceParameterValue(rawValue: string): unknown {
  const value = decodeXmlEntities(rawValue.trim());
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    try {
      return JSON.parse(value);
    } catch {}
  }
  return value;
}

/**
 * Extract tool name from the opening tag attribute or a <name> child element.
 */
function extractToolName(openTag: string, block: string): string {
  const combined = `${openTag}\n${block}`;
  const attrMatch = combined.match(
    /<tool_call(?:s)?\b[^>]*\bname\s*=\s*["']([^"']+)["']/i,
  );
  if (attrMatch) return attrMatch[1];

  const nameTagMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
  if (nameTagMatch) return decodeXmlEntities(nameTagMatch[1].trim());

  return "";
}

/**
 * Infer tool name by matching parameter keys against tool definitions.
 * Only returns a name if exactly one tool matches all argument keys.
 */
function inferToolNameFromParameters(
  args: Record<string, unknown>,
  tools: ToolDefinitionLike[],
): string {
  const argKeys = Object.keys(args);
  if (argKeys.length === 0 || !Array.isArray(tools)) return "";

  const matches = tools.filter((tool) => {
    const properties = getToolDefinitionProperties(tool);
    return argKeys.every((k) =>
      Object.prototype.hasOwnProperty.call(properties, k),
    );
  });

  if (matches.length === 1) {
    return getToolDefinitionName(matches[0]) || "";
  }

  return "";
}

/**
 * Parse Hermes-style XML <parameter name="...">value</parameter> format.
 */
function parseXmlParameterToolCall(
  block: string,
  openTag: string,
  tools: ToolDefinitionLike[],
): { name: string; arguments: Record<string, unknown> } | null {
  const args: Record<string, unknown> = {};
  const parameterRe =
    /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null = parameterRe.exec(block);
  while (match !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
    match = parameterRe.exec(block);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName =
    extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

/**
 * Try to recover a tool call from a block that may have unclosed <parameter> tags
 * (e.g. stream was cut off before </parameter> or </tool_call>).
 */
function parseRecoverableXmlToolCall(
  block: string,
  openTag: string,
  tools: ToolDefinitionLike[],
): { name: string; arguments: Record<string, unknown> } | null {
  const args: Record<string, unknown> = {};

  // First, extract all properly closed parameters
  const closedParameterRe =
    /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null = closedParameterRe.exec(block);
  let lastClosedEnd = 0;
  while (match !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
    lastClosedEnd = closedParameterRe.lastIndex;
    match = closedParameterRe.exec(block);
  }

  // Then look for an unclosed parameter at the tail
  const tail = block.substring(lastClosedEnd);
  const unclosedMatch = tail.match(
    /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*)$/i,
  );
  if (unclosedMatch) {
    args[unclosedMatch[1]] = coerceParameterValue(unclosedMatch[2]);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName =
    extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

// ─── Partial Tag Detection ─────────────────────────────────────────────────────

const TOOL_START_LITERAL = TOOL_CALL_OPEN;

function skipJsonWhitespace(str: string, index: number): number {
  while (index < str.length && /\s/.test(str[index])) {
    index++;
  }
  return index;
}

function scanJsonStringEnd(
  str: string,
  start: number,
): { complete: boolean; end: number } {
  if (str[start] !== '"') {
    return { complete: false, end: start };
  }

  let escaped = false;
  for (let i = start + 1; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      return { complete: true, end: i + 1 };
    }
  }

  return { complete: false, end: str.length };
}

function scanJsonCompositeValueEnd(
  str: string,
  start: number,
): { complete: boolean; end: number } {
  const stack: string[] = [str[start]];
  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < str.length; i++) {
    const ch = str[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }

    if (ch === "}" || ch === "]") {
      const last = stack[stack.length - 1];
      if ((last === "{" && ch === "}") || (last === "[" && ch === "]")) {
        stack.pop();
        if (stack.length === 0) {
          return { complete: true, end: i + 1 };
        }
      } else {
        return { complete: false, end: str.length };
      }
    }
  }

  return { complete: false, end: str.length };
}

function isJsonPrimitiveComplete(token: string): boolean {
  if (!token) return false;
  if (token === "true" || token === "false" || token === "null") {
    return true;
  }
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token);
}

function scanJsonPrimitiveValueEnd(
  str: string,
  start: number,
): { complete: boolean; end: number } {
  let i = start;
  while (i < str.length && !/[\s,}\]]/.test(str[i])) {
    i++;
  }

  const token = str.substring(start, i);
  if (i === str.length) {
    return { complete: isJsonPrimitiveComplete(token), end: i };
  }

  return { complete: isJsonPrimitiveComplete(token), end: i };
}

function scanJsonValueEnd(
  str: string,
  start: number,
): { complete: boolean; end: number } | null {
  const valueStart = skipJsonWhitespace(str, start);
  if (valueStart >= str.length) return null;

  const ch = str[valueStart];
  if (ch === '"') {
    return scanJsonStringEnd(str, valueStart);
  }
  if (ch === "{" || ch === "[") {
    return scanJsonCompositeValueEnd(str, valueStart);
  }
  return scanJsonPrimitiveValueEnd(str, valueStart);
}

function inspectIncrementalJsonToolObject(
  content: string,
): IncrementalJsonToolSnapshot | null {
  let pos = skipJsonWhitespace(content, 0);
  if (pos >= content.length || content[pos] !== "{") {
    return null;
  }

  const snapshot: IncrementalJsonToolSnapshot = {
    name: null,
    argumentsValueStart: null,
    argumentsValueEnd: null,
  };

  pos++;

  while (pos < content.length) {
    pos = skipJsonWhitespace(content, pos);
    if (pos >= content.length) return snapshot;

    if (content[pos] === ",") {
      pos++;
      continue;
    }

    if (content[pos] === "}") {
      return snapshot;
    }

    if (content[pos] !== '"') {
      return snapshot;
    }

    const keyScan = scanJsonStringEnd(content, pos);
    if (!keyScan.complete) return snapshot;

    let key = "";
    try {
      key = JSON.parse(content.substring(pos, keyScan.end));
    } catch {
      return snapshot;
    }

    pos = skipJsonWhitespace(content, keyScan.end);
    if (pos >= content.length || content[pos] !== ":") {
      return snapshot;
    }

    pos = skipJsonWhitespace(content, pos + 1);
    if (pos >= content.length) return snapshot;

    const valueStart = pos;

    if (key === "name" && content[valueStart] === '"') {
      const valueScan = scanJsonStringEnd(content, valueStart);
      if (!valueScan.complete) return snapshot;
      try {
        const parsedName = JSON.parse(
          content.substring(valueStart, valueScan.end),
        );
        if (typeof parsedName === "string") {
          snapshot.name = parsedName;
        }
      } catch {}
      pos = valueScan.end;
      continue;
    }

    const valueScan = scanJsonValueEnd(content, valueStart);
    if (key === "arguments") {
      snapshot.argumentsValueStart = valueStart;
      if (valueScan?.complete) {
        snapshot.argumentsValueEnd = valueScan.end;
      }
    }

    if (!valueScan || !valueScan.complete) {
      return snapshot;
    }

    pos = valueScan.end;
  }

  return snapshot;
}

/**
 * Repair narrow typos observed in Qwen tool-call output:
 * - `"arguments>{...}` should be `"arguments": {...}`
 * - `,arguments":{...}` should be `,"arguments":{...}` (missing opening quote)
 * - a string value whose OPENING quote was dropped: `"key":  value..."`
 * - an array whose closing `]` was dropped: `[elem, "key": ...`
 * Do not apply broad JSON mutation here because tool arguments can legitimately
 * contain arbitrary text.
 */
function repairCommonMalformedToolJson(content: string): string {
  const repaired = content
    .replace(
      /([,{]\s*)"arguments\s*>\s*(?={|\[|")/g,
      '$1"arguments": ',
    )
    .replace(
      /([,{]\s*)arguments"\s*:/g,
      '$1"arguments":',
    )
    .replace(
      /([,{]\s*)arguments\s*:\s*(?={|\[|")/g,
      '$1"arguments":',
    )
    .replace(
      /([,{]\s*)arguments\s*>\s*(?={|\[|")/g,
      '$1"arguments":',
    )
    .replace(
      /([,{]\s*)"arguments"\s*:\s*([A-Za-z_][A-Za-z0-9_]*)"\s*:/g,
      '$1"arguments":{"$2":',
    )
    .replace(
      // Missing OPENING quote of a string value: `"key":  word...` — the model
      // dropped the opening quote but kept the closing one. Valid JSON never has
      // a bare-word value, so inserting the quote is safe (true/false/null and
      // numbers are excluded). The trailing `\"` escapes are preserved, so the
      // model's closing quote still terminates the string.
      /([,{]\s*"[a-zA-Z_][a-zA-Z0-9_]*"\s*:\s*)(?=(?!true|false|null)[A-Za-z_])/g,
      '$1"',
    );
  return repairMissingArrayClose(repaired);
}

/**
 * Close an array whose closing `]` was dropped: `[elem, "key": value` — the
 * model wrote the next key as a sibling of the last array element. A
 * string-key (`"key":`) inside an array is never valid JSON, so when the
 * bracket stack is inside an unclosed `[` and a string closes directly into
 * `:`, the array is closed before that key. String content (with escapes) is
 * never treated as structure.
 */
/**
 * Raw structural scan: true when the content ends INSIDE a string or with
 * unclosed brackets.
 */
function scanJsonStructureIncomplete(content: string): boolean {
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
  }
  return inString || depth > 0;
}

/**
 * True when a JSON payload ends structurally INCOMPLETE — inside a string or
 * with unclosed brackets. Such payloads are TRUNCATED (stream cut, premature
 * close) and must be dropped + auto-retried rather than "recovered": the
 * recovery parsers (robustParseJSON) balance unclosed strings, which would
 * silently accept the truncation and stream a broken tool call to the client
 * while skipping the malformed auto-retry (logs1 2829-char write drop).
 *
 * The raw scan misreads REPAIRABLE payloads as truncated, so it is retried on
 * alternatives before declaring truncation:
 * - missing opening `{`/quote changes the quote parity (`name": ...}}`)
 * - escaped quotes in surrounding junk text misalign string state
 * - double-encoded JSON (`\"` on every quote)
 */
function isJsonPayloadTruncated(content: string): boolean {
  if (!scanJsonStructureIncomplete(content)) return false;
  // A genuinely truncated payload ends MID-VALUE: the model was cut while
  // emitting a string or before a closing bracket, so the last non-space
  // character is text, a quote, or a comma — NOT a closing bracket. The
  // prefix-candidates below only exist for typo-repairable payloads (missing
  // leading `{`/quote like `name": ...}}`, unbalanced quotes, double
  // encoding) whose STRUCTURE is complete: they end with a visible closing
  // bracket. Without this gate, the `"`-prefix candidate flips quote parity
  // and makes a mid-string cut (e.g. `..."old_text":"start`) scan as
  // balanced, so robustParseJSON silently balances the string and streams a
  // fabricated call (logs1 2829-char write drop).
  const trimmed = content.trimEnd();
  if (!/[}\]]$/.test(trimmed)) return true;
  const alt: string[] = [];
  if (content.includes('"name"') || content.includes('name":')) {
    alt.push(`{"${content}`, `{${content}`, `"${content}`);
  }
  if (content.includes('\\"')) {
    alt.push(content.replace(/\\"/g, '"'));
  }
  for (const candidate of alt) {
    if (!scanJsonStructureIncomplete(candidate)) return false;
  }
  return true;
}

/**
 * Strict JSON parse with ONLY the narrow repair chain — never robustParseJSON
 * (it balances unclosed strings and would accept a TRUNCATED arguments value
 * as valid). repairCommonMalformedToolJson only fixes missing-quote /
 * missing-array-close typos, which do not touch truncated strings.
 */
function parseToolArgumentsStrict(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // fall through to the narrow repairs
  }
  try {
    return JSON.parse(repairCommonMalformedToolJson(raw));
  } catch {
    return null;
  }
}

function repairMissingArrayClose(input: string): string {
  const stack: Array<"{" | "["> = [];
  let out = "";
  let inString = false;
  let pendingStart: number | null = null;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += input[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
        if (pendingStart !== null) {
          let j = i + 1;
          while (j < input.length && /\s/.test(input[j])) j++;
          if (input[j] === ":") {
            // This string is a KEY inside an array → close the array. Move the
            // separating comma after the inserted `]`:  }, "key":  →  }], "key":
            const before = out.slice(0, pendingStart);
            const commaIdx = before.lastIndexOf(",");
            if (commaIdx !== -1) {
              out =
                before.slice(0, commaIdx) +
                "]" +
                before.slice(commaIdx) +
                out.slice(pendingStart);
            } else {
              out = before + "]" + out.slice(pendingStart);
            }
            stack.pop();
          }
          pendingStart = null;
        }
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      pendingStart = stack[stack.length - 1] === "[" ? out.length : null;
      out += ch;
      i++;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      out += ch;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      const top = stack[stack.length - 1];
      if ((top === "{" && ch === "}") || (top === "[" && ch === "]")) {
        stack.pop();
      }
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ─── StreamingToolParser ───────────────────────────────────────────────────────

type FlatToolDefinition = {
  type?: string;
  name?: string;
  description?: string;
  parameters?: { properties?: Record<string, unknown> };
  function?: {
    name?: string;
    description?: string;
    parameters?: { properties?: Record<string, unknown> };
  };
};

type ToolDefinitionLike = FunctionToolDefinition | FlatToolDefinition;

function getToolDefinitionName(tool: ToolDefinitionLike): string | undefined {
  if (tool.function?.name) return tool.function.name;
  if ("name" in tool && typeof tool.name === "string") return tool.name;
  return undefined;
}

function getToolDefinitionProperties(
  tool: ToolDefinitionLike | undefined,
): Record<string, unknown> {
  if (!tool) return {};
  if (tool.function?.parameters?.properties) {
    return tool.function.parameters.properties;
  }
  if ("parameters" in tool && tool.parameters?.properties) {
    return tool.parameters.properties;
  }
  return {};
}

export class StreamingToolParser {
  private buffer = "";
  private insideTool = false;
  private currentOpenTag = TOOL_START_LITERAL;
  private currentCloseTag = TOOL_END;
  private emittedToolCallCount = 0;
  private pendingLeadIn = "";
  private tools: ToolDefinitionLike[] = [];
  private declaredToolNames: string[] = [];
  private declaredToolNameSet = new Set<string>();
  private toolByName = new Map<string, ToolDefinitionLike>();
  private normalizedDeclaredToolNames = new Map<string, string>();
  private markdownCodeDelimiterLength = 0;
  private incrementalToolCalls = false;
  private activeIncrementalToolCall: ActiveIncrementalToolCall | null = null;
  private maxToolCallsPerTurn = 0;
  private emittedCallKeys = new Set<string>();
  private pendingToolCallDeltas: ToolCallDelta[] = [];
  private malformedToolCalls: Array<{
    contentPreview: string;
    /** Full content (capped at 2000 chars) for post-hoc recovery analysis. */
    content: string;
    contentLength: number;
    timestamp: number;
    undeclaredNames?: string[];
    category: "malformed" | "undeclared" | "truncated";
    /** Human-readable reason the call could not be parsed/recovered. */
    failureReason?: string;
    /** Which recovery stages were attempted before giving up. */
    recoveryAttempts?: string[];
  }> = [];
  /** Valid tool calls dropped because the per-turn cap was reached. */
  private cappedToolCalls: Array<{ toolName: string; timestamp: number }> = [];

  /**
   * @param tools - Optional array of tool definitions for name inference
   */
  constructor(
    tools: ToolDefinitionLike[] = [],
    options: StreamingToolParserOptions = {},
  ) {
    this.setTools(tools);
    this.incrementalToolCalls = options.incrementalToolCalls ?? false;
    this.maxToolCallsPerTurn = Math.max(0, options.maxToolCallsPerTurn ?? 0);
    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] StreamingToolParser initialized", {
        toolsCount: tools.length,
        toolNames: this.declaredToolNames,
        incrementalToolCalls: this.incrementalToolCalls,
      });
    }
  }

  /**
   * Get malformed tool calls that were dropped (for error feedback).
   */
  getMalformedToolCalls() {
    return this.malformedToolCalls;
  }

  /**
   * Valid tool calls dropped because the per-turn cap was reached. These are
   * intentionally NOT retried: the turn already emitted calls up to the cap,
   * and a [SYSTEM CORRECTION] retry would amplify runaway generation.
   */
  getCappedToolCalls() {
    return this.cappedToolCalls;
  }

  /**
   * True once the per-turn tool-call cap has been reached (the number of
   * processed tool calls hit `maxToolCallsPerTurn`). The streaming layer uses
   * this to stop consuming the upstream and close the turn cleanly
   * (finish_reason "tool_calls") instead of letting the model keep emitting
   * calls that would only be dropped. A cap-reached turn is a SUCCESSFUL turn
   * with valid calls, not an error — it must never trigger a mid-stream retry.
   */
  isToolCapReached(): boolean {
    return (
      this.maxToolCallsPerTurn > 0 &&
      this.emittedToolCallCount >= this.maxToolCallsPerTurn
    );
  }

  /**
   * Clear malformed tool calls tracking.
   */
  clearMalformedToolCalls() {
    this.malformedToolCalls = [];
    this.cappedToolCalls = [];
  }

  /**
   * Update the tools list (e.g. if received after construction).
   */
  setTools(tools: ToolDefinitionLike[]): void {
    this.tools = tools;
    this.declaredToolNames = [];
    this.declaredToolNameSet = new Set<string>();
    this.toolByName = new Map<string, ToolDefinitionLike>();
    this.normalizedDeclaredToolNames = new Map<string, string>();

    for (const tool of tools) {
      const name = this.getToolName(tool);
      if (!name) continue;
      this.declaredToolNames.push(name);
      this.declaredToolNameSet.add(name);
      this.toolByName.set(name, tool);
      const normalizedName = normalizeToolNameForMatch(name);
      if (!this.normalizedDeclaredToolNames.has(normalizedName)) {
        this.normalizedDeclaredToolNames.set(normalizedName, name);
      } else {
        this.normalizedDeclaredToolNames.set(normalizedName, "");
      }
    }
  }

  private startIncrementalToolCall(): void {
    if (!this.incrementalToolCalls) return;
    this.activeIncrementalToolCall = {
      index: this.emittedToolCallCount,
      id: `call_${crypto.randomUUID()}`,
      name: null,
      argumentsValueStart: null,
      emittedArgumentsLength: 0,
      startEmitted: false,
      disabled: false,
    };
  }

  private clearIncrementalToolCall(): void {
    this.activeIncrementalToolCall = null;
  }

  private getToolName(tool: ToolDefinitionLike): string | undefined {
    return getToolDefinitionName(tool);
  }

  private getToolProperties(
    tool: ToolDefinitionLike | undefined,
  ): Record<string, unknown> {
    return getToolDefinitionProperties(tool);
  }

  private resolveDeclaredToolName(name: string): string | null {
    if (!name) return null;
    if (this.declaredToolNameSet.size === 0) return name;
    if (this.declaredToolNameSet.has(name)) return name;

    const normalized = normalizeToolNameForMatch(name);
    const candidate = this.normalizedDeclaredToolNames.get(normalized);
    if (candidate) {
      logger.warn("[parser] Fuzzy-matched tool name to declared tool", {
        emittedToolName: name,
        matchedToolName: candidate,
        declaredTools: this.declaredToolNames,
      });
      return candidate;
    }

    return null;
  }

  private normalizeArgumentsForTool(
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const toolProperties = this.getToolProperties(this.toolByName.get(name));
    let normalized = args;
    if (
      Object.keys(normalized).length === 1 &&
      Object.prototype.hasOwnProperty.call(normalized, "arguments") &&
      typeof (normalized as any).arguments === "object" &&
      (normalized as any).arguments !== null &&
      !Object.prototype.hasOwnProperty.call(toolProperties, "arguments")
    ) {
      normalized = (normalized as any).arguments as Record<string, unknown>;
    }

    return this.coerceJsonLikeArgumentStrings(normalized);
  }

  private coerceJsonLikeArgumentStrings(
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const coerced: Record<string, unknown> = { ...args };

    for (const [key, value] of Object.entries(coerced)) {
      if (typeof value !== "string") continue;

      const trimmed = value.trim();
      if (!(
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      )) {
        continue;
      }

      const parsed = parseJsonishString(trimmed);
      if (parsed !== undefined) {
        coerced[key] = parsed;
      }
    }

    return coerced;
  }

  private toolCallDedupeKey(tc: ParsedToolCall): string {
    let canonicalArgs = "";
    try {
      canonicalArgs = JSON.stringify(tc.arguments);
    } catch {}
    return `${tc.name}::${canonicalArgs}`;
  }

  private flushPendingToolCallDeltas(result: ParserResult): void {
    if (this.pendingToolCallDeltas.length > 0) {
      result.toolCallDeltas.push(...this.pendingToolCallDeltas);
      this.pendingToolCallDeltas = [];
    }
  }

  private discardPendingToolCallDeltas(): void {
    this.pendingToolCallDeltas = [];
  }

  private finalizeSuccessfulToolCall(
    tc: ParsedToolCall,
    result: ParserResult,
  ): void {
    if (!this.isDeclaredToolName(tc.name)) {
      logger.warn("[parser] Undeclared tool call passed through", {
        toolName: tc.name,
        declaredTools: this.declaredToolNames,
      });
    }

    const key = this.toolCallDedupeKey(tc);

    // Qwen sometimes hallucinates the same tool call twice (or more) in one
    // turn, e.g. repeating edit_file with identical edits. The client would
    // execute the duplicates and burn quota/tokens; collapse them here.
    if (this.emittedCallKeys.has(key)) {
      logger.warn("[parser] Dropping duplicate tool call (already emitted this turn)", {
        toolName: tc.name,
        argumentsHash: key,
        arguments: JSON.stringify(tc.arguments).substring(0, 500),
        emittedSoFar: this.emittedToolCallCount,
        note: "duplicate suppressed to prevent double-execution; no recovery needed",
      });
      this.discardPendingToolCallDeltas();
      this.pendingLeadIn = "";
      this.emittedToolCallCount++;
      return;
    }

    // Hard cap against runaway tool-call hallucination: the model is told to
    // emit only 1-4 blocks, but sometimes keeps generating calls without
    // stopping for tool results. Beyond the cap, extra calls are dropped so
    // the turn ends and the client can respond with the tool results.
    if (
      this.maxToolCallsPerTurn > 0 &&
      this.emittedToolCallCount >= this.maxToolCallsPerTurn
    ) {
      // Track the drop explicitly (distinct from malformed calls): cap-drops
      // are VALID calls that were intentionally not emitted, so they must
      // never trigger a [SYSTEM CORRECTION] auto-retry (the turn already has
      // emitted calls). The stream summary surfaces them so runaway-tool
      // patterns are visible in the logs.
      this.cappedToolCalls.push({ toolName: tc.name, timestamp: Date.now() });
      logger.warn("[parser] Dropping tool call: per-turn cap reached", {
        toolName: tc.name,
        maxToolCallsPerTurn: this.maxToolCallsPerTurn,
        cappedCount: this.cappedToolCalls.length,
      });
      this.discardPendingToolCallDeltas();
      this.pendingLeadIn = "";
      this.emittedToolCallCount++;
      return;
    }

    this.emittedCallKeys.add(key);

    const incremental = this.activeIncrementalToolCall;
    const matchesIncrementalCall =
      incremental?.name === tc.name && incremental.startEmitted;

    if (incremental && incremental.name === tc.name) {
      tc.id = incremental.id;
    }

    if (matchesIncrementalCall) {
      // The incremental deltas already carry this call's name/arguments; the
      // client merges them by index. Do NOT emit a complete call chunk again
      // or the arguments would be appended twice and corrupted.
      this.flushPendingToolCallDeltas(result);
      this.emittedToolCallCount++;
      this.pendingLeadIn = "";
      incremental.startEmitted = false;
      incremental.disabled = true;
      return;
    }

    this.flushPendingToolCallDeltas(result);
    result.toolCalls.push(tc);
    this.emittedToolCallCount++;
    this.pendingLeadIn = "";
  }

  private tryRecoverIncrementalToolCall(
    content: string,
  ): ParsedToolCall | null {
    const incremental = this.activeIncrementalToolCall;
    if (
      !incremental ||
      !incremental.startEmitted ||
      !incremental.name ||
      incremental.argumentsValueStart === null
    ) {
      return null;
    }

    const snapshot = inspectIncrementalJsonToolObject(content);
    const argsStart = incremental.argumentsValueStart;
    const argsEnd = snapshot?.argumentsValueEnd ?? content.length;
    const rawArgs = content.substring(argsStart, argsEnd).trim();
    if (!rawArgs) return null;

    try {
      // Strict parse + narrow repairs only — never robustParseJSON, which
      // balances unclosed strings and would accept a TRUNCATED arguments
      // value as a complete call (silently streaming a broken call and
      // skipping the malformed auto-retry).
      const parsedArgs = parseToolArgumentsStrict(rawArgs);
      if (
        parsedArgs &&
        typeof parsedArgs === "object" &&
        !Array.isArray(parsedArgs)
      ) {
        return {
          id: incremental.id,
          name: incremental.name,
          arguments: this.normalizeArgumentsForTool(
            incremental.name,
            parsedArgs as Record<string, unknown>,
          ),
        };
      }
    } catch {}

    return null;
  }

  private emitIncrementalToolCallDeltas(content: string): void {
    if (!this.incrementalToolCalls || !this.activeIncrementalToolCall) return;

    const incremental = this.activeIncrementalToolCall;
    if (incremental.disabled) return;

    // Once the per-turn cap is reached, no further incremental deltas may be
    // emitted. The over-cap call is finalized as a capped drop; streaming its
    // arguments would hand the client a partial tool call that is never
    // completed (and the turn is being closed early anyway).
    if (
      this.maxToolCallsPerTurn > 0 &&
      this.emittedToolCallCount >= this.maxToolCallsPerTurn
    ) {
      return;
    }

    const snapshot = inspectIncrementalJsonToolObject(content);
    if (!snapshot) return;

    if (snapshot.name && !incremental.name) {
      if (!this.isDeclaredToolName(snapshot.name)) {
        incremental.disabled = true;
        return;
      }
      // Store the RESOLVED name (fuzzy matching already verified the raw
      // name maps to a declared tool). Comparing the raw spelling against the
      // resolved name in finalizeSuccessfulToolCall would mismatch (e.g.
      // emitted `editFile` vs declared `edit_file`) and re-emit a complete
      // tool-call chunk on top of the streamed deltas — the duplicate the
      // client sees.
      incremental.name =
        this.resolveDeclaredToolName(snapshot.name) ?? snapshot.name;
    }

    if (
      incremental.argumentsValueStart === null &&
      snapshot.argumentsValueStart !== null
    ) {
      incremental.argumentsValueStart = snapshot.argumentsValueStart;
    }

    if (!incremental.name) return;

    const argsStart = incremental.argumentsValueStart;
    const argsEnd =
      argsStart === null
        ? null
        : (snapshot.argumentsValueEnd ?? content.length);
    const nextArgumentsChunk =
      argsStart === null || argsEnd === null
        ? ""
        : content.substring(
            argsStart + incremental.emittedArgumentsLength,
            argsEnd,
          );

    if (!incremental.startEmitted) {
      this.pendingToolCallDeltas.push({
        index: incremental.index,
        id: incremental.id,
        type: "function",
        function: {
          name: incremental.name,
          arguments: nextArgumentsChunk,
        },
      });
      incremental.startEmitted = true;
      incremental.emittedArgumentsLength += nextArgumentsChunk.length;
      return;
    }

    if (nextArgumentsChunk) {
      this.pendingToolCallDeltas.push({
        index: incremental.index,
        function: {
          arguments: nextArgumentsChunk,
        },
      });
      incremental.emittedArgumentsLength += nextArgumentsChunk.length;
    }
  }

  private advanceMarkdownState(text: string): void {
    if (!text) return;
    this.markdownCodeDelimiterLength = advanceMarkdownCodeState(
      text,
      this.markdownCodeDelimiterLength,
    );
  }

  private emitVisibleText(result: ParserResult, text: string): void {
    if (!text) return;
    if (this.emittedToolCallCount === 0) {
      result.text += text;
    }
    this.advanceMarkdownState(text);
  }

  private holdLeadIn(text: string): void {
    if (!text) return;
    this.pendingLeadIn += text;
    this.advanceMarkdownState(text);
  }

  private isDeclaredToolName(name: string): boolean {
    return this.resolveDeclaredToolName(name) !== null;
  }

  private preserveLiteralToolCall(
    content: string,
    result: ParserResult,
    reason: string,
    closed = true,
  ): void {
    const literalBlock = `${this.currentOpenTag}${content}${closed ? this.currentCloseTag : ""}`;
    logger.warn("[parser] Preserving literal tool_call block as text", {
      reason,
      openTag: this.currentOpenTag,
      contentPreview: content.trim().substring(0, 300),
      closed,
    });

    if (this.emittedToolCallCount === 0) {
      result.text += this.pendingLeadIn;
      result.text += literalBlock;
    }

    this.advanceMarkdownState(literalBlock);
    this.pendingLeadIn = "";
  }

  private recordMalformedToolCall(
    content: string,
    options: {
      undeclaredNames?: string[];
      category?: "malformed" | "undeclared" | "truncated";
      failureReason?: string;
      recoveryAttempts?: string[];
    } = {},
  ): void {
    this.malformedToolCalls.push({
      contentPreview: content.substring(0, 150),
      content: content.substring(0, 2000),
      contentLength: content.length,
      timestamp: Date.now(),
      undeclaredNames: options.undeclaredNames,
      category: options.category ?? "malformed",
      failureReason: options.failureReason,
      recoveryAttempts: options.recoveryAttempts,
    });
  }

  private extractUndeclaredNamesFromContent(text: string): string[] {
    const candidates: string[] = [];
    for (const m of text.matchAll(/"name"\s*:\s*"([^"]+)"/g)) {
      candidates.push(m[1]);
    }
    for (const m of text.matchAll(/<name[^>]*>\s*([^<]+?)\s*<\/name>/g)) {
      candidates.push(m[1]);
    }
    return [...new Set(candidates)].filter(
      (name) => !this.isDeclaredToolName(name),
    );
  }

  /**
   * True when a captured tool-call body reads like natural-language prose
   * (multiple words, no JSON/XML payload shape) rather than a malformed tool
   * payload. Model replies that explain the tool-call syntax frequently quote
   * `<tool_call>`, `</tool_call>` or a JSON example — when those get captured,
   * dropping them hides a legitimate answer, and treating them as malformed
   * triggers a spurious [SYSTEM CORRECTION] auto-retry.
   */
  private looksLikeProseContent(content: string): boolean {
    const t = content.trim();
    if (!t) return false;
    // Real (even malformed) tool payloads start with JSON or XML shape.
    if (t.startsWith("{") || t.startsWith("[") || t.startsWith("<parameter") || t.startsWith("<name>")) {
      return false;
    }
    // Prose: multiple whitespace-separated words, longer than a short tag
    // fragment like "NOT_JSON" (which must stay tracked as malformed).
    const words = t.split(/\s+/).filter(Boolean);
    return words.length >= 3 && t.length > 20;
  }

  feed(chunk: string): ParserResult {
    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] feed() called", {
        chunkLength: chunk.length,
        chunkPreview: chunk.substring(0, 200),
        bufferLength: this.buffer.length,
        insideTool: this.insideTool,
        emittedToolCallCount: this.emittedToolCallCount,
      });
    }

    this.buffer += chunk;
    const result: ParserResult = {
      text: "",
      toolCalls: [],
      toolCallDeltas: [],
    };

    while (this.buffer.length > 0) {
      if (!this.insideTool) {
        const match = findNextToolOpenTagOutsideMarkdownCode(
          this.buffer,
          this.markdownCodeDelimiterLength,
        );
        if (match) {
          // Text before the tool call tag
          const textBefore = this.buffer.substring(0, match.index);
          if (isToolcallDebugEnabled()) {
            logger.debug("[parser] tool_call open tag detected", {
              matchIndex: match.index,
              openTag: match.openTag,
              textBeforeLength: textBefore.length,
              textBeforePreview: textBefore.substring(0, 100),
            });
          }
          // Once a tool call appears, hold the lead-in text.
          // OpenAI-compatible clients expect the whole assistant turn to be
          // a structured tool_calls message when tools are invoked.
          this.holdLeadIn(textBefore);
          this.insideTool = true;
          this.currentOpenTag = match.openTag;
          this.startIncrementalToolCall();
          this.buffer = this.buffer.substring(
            match.index + match.openTag.length,
          );
          continue;
        } else {
          const missingOpenRecovery = findRecoverableMissingOpenToolCall(
            this.buffer,
            this.markdownCodeDelimiterLength,
          );
          if (missingOpenRecovery) {
            if (isToolcallDebugEnabled()) {
              logger.debug(
                "[parser] recovering tool_call with missing opening tag",
                {
                  textBeforeLength: missingOpenRecovery.textBefore.length,
                  candidatePreview: missingOpenRecovery.candidate.substring(
                    0,
                    200,
                  ),
                },
              );
            }
            this.holdLeadIn(missingOpenRecovery.textBefore);
            this.currentOpenTag = TOOL_START_LITERAL;
            this.currentCloseTag = missingOpenRecovery.closeTag;
            this.buffer = this.buffer.substring(
              missingOpenRecovery.consumeLength,
            );
            this.processToolContent(missingOpenRecovery.candidate, result);
            this.currentOpenTag = TOOL_START_LITERAL;
            this.currentCloseTag = TOOL_CALL_CLOSE;
            continue;
          }

          // No full open tag found. Check for partial missing-open or open tag at end.
          const partialMissingOpenIdx = findPartialMissingOpenToolCallIndex(
            this.buffer,
            this.markdownCodeDelimiterLength,
          );
          const partialOpenIdx = findPartialToolOpenIndexOutsideMarkdownCode(
            this.buffer,
            this.markdownCodeDelimiterLength,
          );
          const partialIdx =
            partialMissingOpenIdx === -1
              ? partialOpenIdx
              : partialOpenIdx === -1
                ? partialMissingOpenIdx
                : Math.min(partialMissingOpenIdx, partialOpenIdx);
          const flushIndex =
            partialIdx === -1 ? this.buffer.length : partialIdx;
          if (flushIndex > 0) {
            const textToEmit = this.buffer.substring(0, flushIndex);
            this.emitVisibleText(result, textToEmit);
            this.buffer = this.buffer.substring(flushIndex);
          }
          if (isToolcallDebugEnabled() && partialIdx !== -1) {
            logger.debug(
              "[parser] partial tool_call candidate detected at end of buffer",
              {
                partialIdx,
                partialContent: this.buffer.substring(partialIdx),
              },
            );
          }
          break;
        }
      } else {
        // Inside tool: look for a supported closing tag outside JSON strings.
        const endMatch = findToolEndOutsideJsonString(this.buffer);
        if (endMatch) {
          const endIdx = endMatch.index;
          const content = this.buffer.substring(0, endIdx);
          if (isToolcallDebugEnabled()) {
            logger.debug("[parser] tool_call close tag detected", {
              contentLength: content.length,
              contentPreview: content.substring(0, 300),
              closeTag: endMatch.tag,
              remainingBufferLength:
                this.buffer.length - endIdx - endMatch.tag.length,
            });
          }
          this.emitIncrementalToolCallDeltas(content);
          this.buffer = this.buffer.substring(endIdx + endMatch.tag.length);
          this.currentCloseTag = endMatch.tag;
          this.processToolContent(content, result);
          this.insideTool = false;
          this.currentOpenTag = TOOL_START_LITERAL;
          this.currentCloseTag = TOOL_CALL_CLOSE;
          this.clearIncrementalToolCall();
        } else {
          this.emitIncrementalToolCallDeltas(this.buffer);
          if (isToolcallDebugEnabled()) {
            logger.debug("[parser] waiting for more data inside tool_call", {
              bufferLength: this.buffer.length,
              bufferPreview: this.buffer.substring(0, 200),
              toolCallDeltaCount: result.toolCallDeltas.length,
            });
          }
          break; // Wait for more data
        }
      }
    }

    if (
      isToolcallDebugEnabled() &&
      (result.text ||
        result.toolCalls.length > 0 ||
        result.toolCallDeltas.length > 0)
    ) {
      logger.debug("[parser] feed() result", {
        textLength: result.text.length,
        textPreview: result.text.substring(0, 100),
        toolCallsCount: result.toolCalls.length,
        toolCallNames: result.toolCalls.map((tc) => tc.name),
        toolCallDeltaCount: result.toolCallDeltas.length,
      });
    }

    return result;
  }

  flush(): ParserResult {
    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] flush() called", {
        bufferLength: this.buffer.length,
        bufferPreview: this.buffer.substring(0, 200),
        insideTool: this.insideTool,
        pendingLeadInLength: this.pendingLeadIn.length,
        emittedToolCallCount: this.emittedToolCallCount,
      });
    }

    const result: ParserResult = {
      text: "",
      toolCalls: [],
      toolCallDeltas: [],
    };
    if (!this.buffer && !this.pendingLeadIn) return result;

    if (this.insideTool) {
      // Stream ended with unclosed <tool_call>. Try to recover.
      const rawTrimmed = this.buffer.trim();
      // When findToolEndOutsideJsonString defers on an unparseable close
      // marker, the tag stays in the buffer (it was never consumed). Strip a
      // trailing close tag before recovery so it cannot pollute recovered
      // argument values (e.g. `{"a": "1</tool_call>"}`). Genuine unclosed
      // streams (cut mid-payload) have no trailing tag, so this is a no-op
      // for them.
      const trimmed = rawTrimmed.replace(/<\/tool_calls?>$/i, "");
      if (trimmed.length > 0) {
        if (isToolcallDebugEnabled()) {
          logger.debug(
            "[parser] flush: attempting recovery of unclosed tool_call",
            {
              trimmedLength: trimmed.length,
              trimmedPreview: trimmed.substring(0, 300),
            },
          );
        }
        this.emitIncrementalToolCallDeltas(this.buffer);
        // The repair chain (missing value quotes / array closes) also applies
        // here: when the close-tag scan defers on an unparseable candidate, the
        // buffer reaches flush and tryRecoverToolCall would otherwise skip the
        // narrow typo repairs that processToolContent runs.
        const repairedTrimmed = repairCommonMalformedToolJson(trimmed);
        const recovered =
          this.tryRecoverToolCall(repairedTrimmed) ||
          this.tryRecoverToolCall(trimmed) ||
          this.tryRecoverIncrementalToolCall(trimmed) ||
          this.lastChanceRecoverToolCall(trimmed);
        if (recovered) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[parser] flush: recovery successful", {
              name: recovered.name,
              arguments: recovered.arguments,
              id: recovered.id,
            });
          }
          this.finalizeSuccessfulToolCall(recovered, result);
        } else {
          // Recovery failed. Do NOT emit an assistant-visible warning: the
          // bridge must never inject its own text into the user-facing reply.
          // The malformed call is still tracked so the stream auto-retry can
          // send a [SYSTEM CORRECTION] to Qwen in the upstream prompt.
          //
          // Prose guard (same rationale as processToolContent): if the
          // unclosed body reads like natural-language prose, it is a
          // legitimate (possibly truncated) reply, not a tool call. Emit it as
          // visible text instead of tracking it as malformed.
          if (this.looksLikeProseContent(trimmed)) {
            if (isToolcallDebugEnabled()) {
              logger.debug(
                "[parser] flush: prose captured as unclosed tool call; preserving as text",
                {
                  contentLength: trimmed.length,
                  contentPreview: trimmed.substring(0, 200),
                },
              );
            }
            this.discardPendingToolCallDeltas();
            if (this.emittedToolCallCount === 0) {
              result.text += this.pendingLeadIn;
              result.text += this.buffer;
            }
            this.pendingLeadIn = "";
          } else {
            const toolName = this.extractToolNameFromTruncated(trimmed);
          this.discardPendingToolCallDeltas();
          const truncRecoveryAttempts = [
            "tryRecoverToolCall",
            "tryRecoverIncrementalToolCall",
            "lastChanceRecoverToolCall",
          ];
          this.recordMalformedToolCall(trimmed, {
            category: "truncated",
            undeclaredNames:
              this.extractUndeclaredNamesFromContent(trimmed),
            failureReason:
              "stream ended before tool_call closing tag; content too incomplete to reconstruct",
            recoveryAttempts: truncRecoveryAttempts,
          });
          logger.warn(
            "[parser] Dropping unrecoverable unclosed tool call at end of stream",
            {
              toolName,
              category: "truncated",
              contentLength: trimmed.length,
              content: trimmed.substring(0, 2000),
              failureReason:
                "stream ended before tool_call closing tag; content too incomplete to reconstruct",
              recoveryAttempts: truncRecoveryAttempts,
              emittedToolCallsSoFar: this.emittedToolCallCount,
            },
          );
          if (
            this.emittedToolCallCount === 0 &&
            this.pendingLeadIn.trim().length > 0
          ) {
            result.text += this.pendingLeadIn;
          }
          this.pendingLeadIn = "";
          }
        }
      } else {
        // Empty tool call block - restore lead-in
        if (isToolcallDebugEnabled()) {
          logger.debug(
            "[parser] flush: empty tool call block, restoring lead-in",
          );
        }
        this.discardPendingToolCallDeltas();
        if (
          this.emittedToolCallCount === 0 &&
          this.pendingLeadIn.trim().length > 0
        ) {
          result.text += this.pendingLeadIn;
        }
        this.pendingLeadIn = "";
      }
    } else {
      // If we are not insideTool, the model may have emitted raw JSON tool calls
      // (e.g. `{"name":"read","arguments":{...}} {"name":"glob",...} ......`)
      // without wrapping them in <tool_call> tags, or left an incomplete `<tool_call` tag at the end.
      let textToProcess = this.buffer;

      // 1. Strip any trailing orphaned `<tool_call` or `<qpx_call` prefix at the end of buffer
      // (e.g. model output `... <tool_call` without closing `>`)
      textToProcess = textToProcess.replace(/<\/?(?:tool_calls?|qpx_call)\b[^>]*$/i, "").trimEnd();

      // 2. Extract any unwrapped JSON tool calls from the buffer
      const { toolCalls: unwrappedCalls, remainingText } =
        this.extractUnwrappedToolCalls(textToProcess);

      if (unwrappedCalls.length > 0) {
        if (isToolcallDebugEnabled()) {
          logger.debug("[parser] flush: extracted unwrapped tool calls from buffer", {
            count: unwrappedCalls.length,
            names: unwrappedCalls.map((tc) => tc.name),
            remainingTextPreview: remainingText.substring(0, 100),
          });
        }
        for (const tc of unwrappedCalls) {
          this.finalizeSuccessfulToolCall(tc, result);
        }
        // If there was prose before the unwrapped tool calls, emit it as visible text
        if (remainingText.trim().length > 0 && this.emittedToolCallCount === unwrappedCalls.length) {
          this.emitVisibleText(result, remainingText);
        }
      } else {
        this.emitVisibleText(result, textToProcess);
      }
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] flush() result", {
        textLength: result.text.length,
        toolCallsCount: result.toolCalls.length,
        toolCallNames: result.toolCalls.map((tc) => tc.name),
        toolCallDeltaCount: result.toolCallDeltas.length,
        totalEmittedToolCalls: this.emittedToolCallCount,
      });
    }

    this.buffer = "";
    this.insideTool = false;
    this.currentOpenTag = TOOL_START_LITERAL;
    this.currentCloseTag = TOOL_END;
    this.markdownCodeDelimiterLength = 0;
    this.clearIncrementalToolCall();
    return result;
  }

  getEmittedToolCallCount(): number {
    return this.emittedToolCallCount;
  }

  isInsideTool(): boolean {
    return this.insideTool;
  }

  /**
   * Get any lead-in text that was captured before tool calls.
   * Useful for fallback content when tool calls fail to parse.
   */
  getPendingLeadIn(): string {
    return this.pendingLeadIn;
  }

  // ─── Internal Methods ──────────────────────────────────────────────────────

  private processToolContent(content: string, result: ParserResult): void {
    const t = content.trim();
    if (!t) {
      // Empty tool call - malformed. Restore lead-in if possible.
      logger.warn("[parser] Dropping empty tool call block");
      this.discardPendingToolCallDeltas();
      if (
        this.emittedToolCallCount === 0 &&
        this.pendingLeadIn.trim().length > 0
      ) {
        result.text += this.pendingLeadIn;
      }
      this.pendingLeadIn = "";
      return;
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] processToolContent: analyzing content", {
        contentLength: t.length,
        contentPreview: t.substring(0, 300),
        startsWithBrace: t.startsWith("{"),
        startsWithBracket: t.startsWith("["),
        hasName: t.includes('"name"') || t.includes("<name>"),
        hasArgs:
          t.includes('"arguments"') ||
          t.includes('"args"') ||
          t.includes("<parameter"),
        openTag: this.currentOpenTag,
      });
    }

    // 1) Try Hermes-style XML <parameter> format first
    const xmlParsed = parseXmlParameterToolCall(
      t,
      this.currentOpenTag,
      this.tools,
    );
    if (xmlParsed) {
      const resolvedXmlName = this.resolveDeclaredToolName(xmlParsed.name);
      if (!resolvedXmlName) {
        this.recordMalformedToolCall(content, {
          undeclaredNames: [xmlParsed.name],
          category: "undeclared",
        });
        this.preserveLiteralToolCall(
          content,
          result,
          `undeclared tool name: ${xmlParsed.name}`,
        );
        return;
      }
      xmlParsed.name = resolvedXmlName;
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[parser] processToolContent: XML parameter format parsed successfully",
          {
            name: xmlParsed.name,
            arguments: xmlParsed.arguments,
            argsKeys: Object.keys(xmlParsed.arguments),
          },
        );
      }
      this.finalizeSuccessfulToolCall(
        {
          id: `call_${crypto.randomUUID()}`,
          name: xmlParsed.name,
          arguments: xmlParsed.arguments,
        },
        result,
      );
      return;
    }

    // 2) Try JSON array format
    if (t.startsWith("[")) {
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[parser] processToolContent: attempting JSON array parse",
        );
      }
      try {
        const arr = JSON.parse(t);
        const parsedCalls: ParsedToolCall[] = (Array.isArray(arr) ? arr : [])
          .map((item: unknown) => this.parseToolCall(item))
          .filter(
            (tc: ParsedToolCall | null): tc is ParsedToolCall => tc !== null,
          );

        for (const tc of parsedCalls) {
          const resolvedName = this.resolveDeclaredToolName(tc.name);
          if (resolvedName) tc.name = resolvedName;
        }
        const undeclaredToolNames = parsedCalls
          .map((tc) => tc.name)
          .filter((name) => !this.isDeclaredToolName(name));
        if (undeclaredToolNames.length > 0) {
          this.recordMalformedToolCall(content, {
            undeclaredNames: undeclaredToolNames,
            category: "undeclared",
          });
          this.preserveLiteralToolCall(
            content,
            result,
            `undeclared tool names in array: ${undeclaredToolNames.join(", ")}`,
          );
          return;
        }

        for (const tc of parsedCalls) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[parser] processToolContent: array item parsed", {
              name: tc.name,
              arguments: tc.arguments,
            });
          }
          this.finalizeSuccessfulToolCall(tc, result);
        }
        return;
      } catch (e) {
        if (isToolcallDebugEnabled()) {
          logger.debug("[parser] processToolContent: JSON array parse failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        // Fall through to JSON object parsing
      }
    }

    // 3) Try JSON object format (single or multiple)
    if (t.startsWith("{") || t.includes('"name"')) {
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[parser] processToolContent: attempting JSON object parse",
        );
      }
      let tcs = this.parseToolContent(t);
      if (tcs.length === 0) {
        const repaired = repairCommonMalformedToolJson(t);
        if (repaired !== t) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[parser] Repaired narrow malformed tool JSON typo");
          }
          tcs = this.parseToolContent(repaired);
        }
      }
      if (tcs.length > 0) {
        for (const tc of tcs) {
          const resolvedName = this.resolveDeclaredToolName(tc.name);
          if (resolvedName) tc.name = resolvedName;
        }
        const undeclaredToolNames = tcs
          .map((tc) => tc.name)
          .filter((name) => !this.isDeclaredToolName(name));
        if (undeclaredToolNames.length > 0) {
          this.recordMalformedToolCall(content, {
            undeclaredNames: undeclaredToolNames,
            category: "undeclared",
          });
          this.preserveLiteralToolCall(
            content,
            result,
            `undeclared tool names: ${undeclaredToolNames.join(", ")}`,
          );
          return;
        }

        for (const tc of tcs) {
          // Check for tool name from opening tag attribute
          if (!tc.name || tc.name === "") {
            const attrName = extractToolName(this.currentOpenTag, t);
            if (attrName) tc.name = attrName;
          }
          if (tc.name) {
            if (isToolcallDebugEnabled()) {
              logger.debug(
                "[parser] processToolContent: JSON object parsed successfully",
                {
                  name: tc.name,
                  arguments: tc.arguments,
                  argsKeys: Object.keys(tc.arguments),
                },
              );
            }
            this.finalizeSuccessfulToolCall(tc, result);
          }
        }
        return;
      }
    }

    // 3b) Try to recover malformed JSON (missing opening brace/quote)
    if (!t.startsWith("{") && t.includes('"')) {
      const recovered = this.tryRecoverMalformedJson(t);
      if (recovered) {
        if (isToolcallDebugEnabled()) {
          logger.debug(
            "[parser] processToolContent: recovered malformed JSON",
            {
              name: recovered.name,
              arguments: recovered.arguments,
              originalPreview: t.substring(0, 100),
            },
          );
        }
        this.finalizeSuccessfulToolCall(recovered, result);
        return;
      }
    }

    const incrementalRecovered = this.tryRecoverIncrementalToolCall(t);
    if (incrementalRecovered) {
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[parser] processToolContent: recovered incremental tool call",
          {
            name: incrementalRecovered.name,
            arguments: incrementalRecovered.arguments,
          },
        );
      }
      this.finalizeSuccessfulToolCall(incrementalRecovered, result);
      return;
    }

    // 4) Last-chance recovery before giving up. Handles the payloads that
    // slip past the paths above:
    // - JSON with escaped quotes (`\"`) so the `"name"` probes miss it, e.g.
    //   the model emitting a double-encoded string
    //   `"{\"name\":\"edit_file\",...}"` or raw text wrapping a tool payload.
    // - JSON truncated by an early `</tool_call>` inside a string value (the
    //   unbalanced-quote fallback close). robustParseJSON truncates to the
    //   balanced prefix / closes missing braces; brace-matching extracts the
    //   first balanced object from surrounding junk.
    const lastChance = this.lastChanceRecoverToolCall(t);
    if (lastChance) {
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[parser] processToolContent: last-chance recovery succeeded",
          {
            name: lastChance.name,
            arguments: lastChance.arguments,
          },
        );
      }
      this.finalizeSuccessfulToolCall(lastChance, result);
      return;
    }

    // 5) Tool call is malformed and unrecoverable.
    // Never leak internal XML to user-visible content.
    // Restore lead-in text if no tools were emitted.
    //
    // Prose guard: when the captured body reads like natural-language prose
    // (model explaining the tool-call syntax, quoting markers/JSON), it is not
    // a malformed tool call — it is a legitimate reply that must reach the
    // client. Emit it as visible text and skip the malformed tracking so the
    // stream does not fire a spurious [SYSTEM CORRECTION] auto-retry.
    if (this.looksLikeProseContent(t)) {
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[parser] processToolContent: prose captured as tool call; preserving as text",
          {
            contentLength: t.length,
            contentPreview: t.substring(0, 200),
          },
        );
      }
      this.discardPendingToolCallDeltas();
      if (this.emittedToolCallCount === 0) {
        result.text += this.pendingLeadIn;
        result.text += content;
      }
      this.pendingLeadIn = "";
      return;
    }

    const droppedToolName = this.extractToolNameFromTruncated(t);
    const recoveryAttempts = [
      "directParse",
      "repairCommonMalformedToolJson",
      "tryRecoverMalformedJson",
      "tryRecoverIncrementalToolCall",
      "lastChanceRecoverToolCall",
    ];
    this.recordMalformedToolCall(t, {
      undeclaredNames: this.extractUndeclaredNamesFromContent(t),
      category: "malformed",
      failureReason: "all recovery stages failed to produce valid JSON",
      recoveryAttempts,
    });

    logger.warn(
      `[parser] Dropping malformed tool call (${t.length} chars): ${t.substring(0, 80).replace(/\n/g, " ")}...`,
      {
        toolName: droppedToolName,
        category: "malformed",
        contentLength: t.length,
        content: t.substring(0, 2000),
        failureReason: "all recovery stages failed to produce valid JSON",
        recoveryAttempts,
        declaredTools: [...this.declaredToolNames].slice(0, 10),
      },
    );
    if (
      this.emittedToolCallCount === 0 &&
      this.pendingLeadIn.trim().length > 0
    ) {
      result.text += this.pendingLeadIn;
    }
    this.pendingLeadIn = "";
  }

  private tryRecoverToolCall(block: string): ParsedToolCall | null {
    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] tryRecoverToolCall: starting recovery attempts", {
        blockLength: block.length,
        blockPreview: block.substring(0, 300),
      });
    }

    // Try full parse first
    const xmlParsed = parseXmlParameterToolCall(
      block,
      this.currentOpenTag,
      this.tools,
    );
    if (xmlParsed) {
      const resolvedXmlName = this.resolveDeclaredToolName(xmlParsed.name);
      if (!resolvedXmlName) {
        if (isToolcallDebugEnabled()) {
          logger.debug(
            "[parser] tryRecoverToolCall: rejecting undeclared XML tool name",
            {
              name: xmlParsed.name,
            },
          );
        }
        return null;
      }
      xmlParsed.name = resolvedXmlName;
      if (isToolcallDebugEnabled()) {
        logger.debug("[parser] tryRecoverToolCall: full XML parse succeeded", {
          name: xmlParsed.name,
          arguments: xmlParsed.arguments,
        });
      }
      return {
        id: `call_${crypto.randomUUID()}`,
        name: xmlParsed.name,
        arguments: xmlParsed.arguments,
      };
    }

    // Try recoverable (unclosed parameters)
    const recovered = parseRecoverableXmlToolCall(
      block,
      this.currentOpenTag,
      this.tools,
    );
    if (recovered) {
      const resolvedRecoveredName = this.resolveDeclaredToolName(
        recovered.name,
      );
      if (!resolvedRecoveredName) {
        if (isToolcallDebugEnabled()) {
          logger.debug(
            "[parser] tryRecoverToolCall: rejecting undeclared recoverable XML tool name",
            {
              name: recovered.name,
            },
          );
        }
        return null;
      }
      recovered.name = resolvedRecoveredName;
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[parser] tryRecoverToolCall: recoverable XML parse succeeded",
          {
            name: recovered.name,
            arguments: recovered.arguments,
          },
        );
      }
      return {
        id: `call_${crypto.randomUUID()}`,
        name: recovered.name,
        arguments: recovered.arguments,
      };
    }

    // Try JSON (single or multiple)
    const jsonParsed = this.parseToolContent(block);
    if (jsonParsed.length > 0) {
      const first = jsonParsed[0];
      const attrName = extractToolName(this.currentOpenTag, block);
      if (attrName && !first.name) first.name = attrName;
      if (first.name) {
        const resolvedFirstName = this.resolveDeclaredToolName(first.name);
        if (!resolvedFirstName) {
          if (isToolcallDebugEnabled()) {
            logger.debug(
              "[parser] tryRecoverToolCall: rejecting undeclared JSON tool name",
              {
                name: first.name,
              },
            );
          }
          return null;
        }
        first.name = resolvedFirstName;
        if (isToolcallDebugEnabled()) {
          logger.debug("[parser] tryRecoverToolCall: JSON parse succeeded", {
            name: first.name,
            arguments: first.arguments,
          });
        }
        return first;
      }
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] tryRecoverToolCall: all recovery attempts failed");
    }
    return null;
  }

  /**
   * Extract tool name from a truncated JSON buffer.
   * Used to provide a more informative warning when a tool call is dropped.
   */
  private extractToolNameFromTruncated(buffer: string): string | null {
    // Try JSON format: {"name": "tool_name", ...}
    const jsonMatch = buffer.match(/"name"\s*:\s*"([^"]+)"/);
    if (jsonMatch) return jsonMatch[1];
    // Try XML format: <tool_call name="tool_name">
    const xmlMatch = buffer.match(/name="([^"]+)"/);
    if (xmlMatch) return xmlMatch[1];
    return null;
  }

  /**
   * Try to recover malformed JSON that's missing opening brace/quote.
   * Example: `name": "read", "arguments": {"backend/package.json"}}`
   */
  private tryRecoverMalformedJson(str: string): ParsedToolCall | null {
    if (isJsonPayloadTruncated(str)) return null;
    // Try adding {" at the beginning if it looks like a truncated JSON
    if (str.includes('"name"') || str.includes('name":')) {
      const candidates = [
        `{"${str}`, // Missing {"
        `{${str}`, // Missing {
        `"${str}`, // Missing "
      ];

      for (const candidate of candidates) {
        try {
          const parsed = robustParseJSON(candidate);
          if (parsed && typeof parsed === "object") {
            const name =
              parsed.name ||
              parsed.function?.name ||
              parsed.tool_name ||
              parsed.tool;
            if (name && typeof name === "string") {
              const resolvedName = this.resolveDeclaredToolName(name) ?? name;
              let args =
                parsed.arguments ||
                parsed.function?.arguments ||
                parsed.args ||
                parsed.parameters ||
                parsed.input ||
                {};
              if (typeof args === "string") {
                args = parseJsonishString(args) ?? {};
              }
              if (typeof args !== "object" || args === null) args = {};
              args = this.normalizeArgumentsForTool(
                resolvedName,
                args as Record<string, unknown>,
              );

              if (isToolcallDebugEnabled()) {
                logger.debug("[parser] tryRecoverMalformedJson: success", {
                  name: resolvedName,
                  argsKeys: Object.keys(args),
                  method:
                    candidate === candidates[0]
                      ? 'add-{"'
                      : candidate === candidates[1]
                        ? "add-{"
                        : 'add-"',
                });
              }

              return {
                id: `call_${crypto.randomUUID()}`,
                name: resolvedName,
                arguments: args,
              };
            }
          }
        } catch {
          // Try next candidate
        }
      }
    }

    return null;
  }

  /**
   * Try to recover tool calls from payloads that escaped the normal paths:
   * double-escaped JSON (`\"` inside the block) and JSON truncated by a
   * premature closing tag inside a string value. Both robustParseJSON (which
   * starts at the first `{` and balances braces) and balanced-brace
   * extraction are attempted, on the raw and unescaped variants.
   */
  private lastChanceRecoverToolCall(block: string): ParsedToolCall | null {
    // A structurally truncated payload must NOT be robust-recovered: it would
    // stream a cut call to the client and skip the auto-retry. Drop it so the
    // malformed tracking fires and the model re-emits cleanly.
    if (isJsonPayloadTruncated(block)) return null;
    const variants = [block];
    if (block.includes('\\"')) {
      variants.push(block.replace(/\\"/g, '"'));
    }

    for (const variant of variants) {
      try {
        const parsed = robustParseJSON(variant);
        if (parsed && typeof parsed === "object") {
          const tc = this.parseToolCall(parsed);
          if (tc && this.isDeclaredToolName(tc.name)) return tc;
        }
      } catch {}

      try {
        const extracted = this.extractJsonToolCallByBraceMatching(variant);
        if (extracted) {
          const tc = this.parseToolCall(extracted);
          if (tc && this.isDeclaredToolName(tc.name)) return tc;
        }
      } catch {}
    }

    return null;
  }

  private parseToolContent(str: string): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];

    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] parseToolContent: starting parse", {
        inputLength: str.length,
        inputPreview: str.substring(0, 200),
        hasNewlines: str.includes("\n"),
      });
    }

    // Try parsing as single JSON first. Some models return a JSON object with
    // every quote escaped (e.g. {\\"name\\":...}) after serializing a tool
    // call into text. Retry that representation without altering the normal
    // valid-JSON path.
    const jsonCandidates = [str];
    if (str.includes('\\"')) {
      jsonCandidates.push(str.replace(/\\"/g, '"'));
    }

    // Never robust-recover a structurally TRUNCATED payload: robustParseJSON
    // balances unclosed strings and would accept the cut as valid, silently
    // streaming a broken call to the client while skipping the malformed
    // auto-retry. Truncated payloads fall through to malformed tracking.
    if (!isJsonPayloadTruncated(str)) {
      for (const candidate of jsonCandidates) {
        try {
          const parsed = robustParseJSON(candidate);
          if (parsed && typeof parsed === "object") {
            const tc = this.parseToolCall(parsed);
            if (tc) {
              if (isToolcallDebugEnabled()) {
                logger.debug(
                  "[parser] parseToolContent: single JSON parse succeeded",
                  {
                    name: tc.name,
                    arguments: tc.arguments,
                    unescapedCandidate: candidate !== str,
                  },
                );
              }
              calls.push(tc);
              break;
            }
          }
        } catch (e) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[parser] parseToolContent: single JSON parse failed", {
              error: e instanceof Error ? e.message : String(e),
              unescapedCandidate: candidate !== str,
            });
          }
        }
      }
    }

    // Always try line-by-line parsing for multi-JSON content (independent of single parse)
    if (str.includes("\n")) {
      const lines = str
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{") && l.endsWith("}"));
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[parser] parseToolContent: attempting line-by-line parse",
          {
            candidateLines: lines.length,
          },
        );
      }
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object") {
            const tc = this.parseToolCall(parsed);
            if (
              tc &&
              !calls.some(
                (c) =>
                  c.name === tc.name &&
                  JSON.stringify(c.arguments) === JSON.stringify(tc.arguments),
              )
            ) {
              if (isToolcallDebugEnabled()) {
                logger.debug(
                  "[parser] parseToolContent: line-by-line parse succeeded",
                  {
                    name: tc.name,
                    arguments: tc.arguments,
                  },
                );
              }
              calls.push(tc);
            }
          }
        } catch (e) {
          if (isToolcallDebugEnabled()) {
            logger.debug(
              "[parser] parseToolContent: line-by-line parse failed",
              {
                line: line.substring(0, 100),
                error: e instanceof Error ? e.message : String(e),
              },
            );
          }
        }
      }
    }

    // Fallback: extract JSON tool call via balanced-brace search for large
    // payloads. Same truncation gate as the single-JSON parse: a structurally
    // truncated payload must not be robust-recovered (it would stream a cut
    // call and skip the malformed auto-retry).
    if (calls.length === 0 && str.includes('"name"') && !isJsonPayloadTruncated(str)) {
      const extracted = this.extractJsonToolCallByBraceMatching(str);
      if (extracted) {
        const tc = this.parseToolCall(extracted);
        if (
          tc &&
          !calls.some(
            (c) =>
              c.name === tc.name &&
              JSON.stringify(c.arguments) === JSON.stringify(tc.arguments),
          )
        ) {
          if (isToolcallDebugEnabled()) {
            logger.debug(
              "[parser] parseToolContent: brace-matching extraction succeeded",
              {
                name: tc.name,
              },
            );
          }
          calls.push(tc);
        }
      }
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] parseToolContent: result", {
        totalParsed: calls.length,
        names: calls.map((c) => c.name),
      });
    }

    return calls;
  }

  // Extract a JSON object from a string
  private extractJsonToolCallByBraceMatching(str: string): any | null {
    const startIdx = str.indexOf("{");
    if (startIdx === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIdx; i < str.length; i++) {
      const c = str[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            const candidate = str.substring(startIdx, i + 1);
            try {
              return JSON.parse(candidate);
            } catch {
              // Try robust parse on the extracted substring
              try {
                return robustParseJSON(candidate);
              } catch {
                return null;
              }
            }
          }
        }
      }
    }

    // try closing remaining braces
    if (depth > 0) {
      const candidate = str.substring(startIdx) + "}".repeat(depth);
      try {
        return JSON.parse(candidate);
      } catch {
        try {
          return robustParseJSON(candidate);
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  private isHallucinatedToolCall(parsed: any): boolean {
    const args =
      parsed.arguments ||
      parsed.function?.arguments ||
      parsed.args ||
      parsed.parameters ||
      parsed.input ||
      {};
    const values =
      typeof args === "string"
        ? [args]
        : typeof args === "object" && args !== null
          ? Object.values(args).filter((v) => typeof v === "string") as string[]
          : [];
    for (const val of values) {
      // Detect vertical hallucination: single chars separated by newlines
      // e.g. "f\ni\ne\nl\nd\ns" or "a\nc\nf\ng\ne\nt..." (5+ single-char lines)
      // and zero-width / ornament chars inserted by WAF/bx
      const lines = val.split("\n");
      if (lines.length >= 8) {
        let singleCharLines = 0;
        for (const line of lines) {
          const trimmed = line.replace(/[\u200B\uFEFF¨\u00A8]/g, "").trim();
          if (trimmed.length === 1 && /^[A-Za-z0-9=_\-;()]$/.test(trimmed)) {
            singleCharLines++;
          }
        }
        if (singleCharLines >= 6 && singleCharLines / lines.length > 0.5) {
          return true;
        }
      }
      // Also catch the compact form "f\ni\ne..." after JSON parsing already
      // converted literal newlines to \n -> string contains "\n" per char
      if (/^([A-Za-z0-9=_\-;()]\n){6,}/.test(val) || /(\w\n){8,}/.test(val)) {
        return true;
      }
    }
    return false;
  }

  private parseToolCall(parsed: any): ParsedToolCall | null {
    if (!parsed || typeof parsed !== "object") return null;

    const name =
      parsed.name || parsed.function?.name || parsed.tool_name || parsed.tool;
    if (!name || typeof name !== "string" || name.length === 0) return null;

    // Drop hallucinated tool calls where the model split a value vertically
    // (e.g. "fields" -> "f\ni\ne\nl\nd\ns"). These are valid JSON after
    // sanitizeAndBalance but semantically broken; treat as malformed so the
    // [SYSTEM CORRECTION] auto-retry fires instead of delivering garbage.
    if (this.isHallucinatedToolCall(parsed)) {
      return null;
    }

    let args =
      parsed.arguments ||
      parsed.function?.arguments ||
      parsed.args ||
      parsed.parameters ||
      parsed.input ||
      {};
    if (typeof args === "string") {
      args = parseJsonishString(args) ?? {};
    }
    if (typeof args !== "object" || args === null) args = {};

    // Recover flattened tool calls where the model put the parameters at the
    // top level instead of inside an `arguments`/`params` wrapper, e.g.
    // `{"name":"write_file","path":"...","content":"..."}`. Only do this when
    // no explicit args wrapper was present.
    if (Object.keys(args).length === 0) {
      const reservedKeys = new Set([
        "name",
        "type",
        "id",
        "tool_call_id",
        "function",
        "tool_name",
        "tool",
        "raw",
      ]);
      const flattened: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (!reservedKeys.has(key)) {
          flattened[key] = value;
        }
      }
      if (Object.keys(flattened).length > 0) {
        args = flattened;
      }
    }

    const resolvedName = this.resolveDeclaredToolName(name) ?? name;
    args = this.normalizeArgumentsForTool(resolvedName, args);

    return {
      id: parsed.id || parsed.tool_call_id || `call_${crypto.randomUUID()}`,
      name: resolvedName,
      arguments: args,
    };
  }

  /**
   * Scans a text buffer for one or more unwrapped raw JSON tool calls
   * (e.g. `{"name":"read","arguments":{...}} {"name":"glob",...} ......`)
   * and extracts them cleanly without letting raw JSON leak into user-facing text.
   */
  public extractUnwrappedToolCalls(
    text: string,
  ): { toolCalls: ParsedToolCall[]; remainingText: string } {
    const trimmed = text.trim();
    if (!trimmed.includes('"name"') && !trimmed.includes('name":') && !trimmed.includes("'name'")) {
      return { toolCalls: [], remainingText: text };
    }

    const toolCalls: ParsedToolCall[] = [];
    let remainingText = "";
    let i = 0;

    while (i < text.length) {
      if (text[i] === "{") {
        const jsonEnd = findMatchingClosingBrace(text, i);
        if (jsonEnd !== -1) {
          const candidate = text.substring(i, jsonEnd + 1);
          const recovered =
            this.tryRecoverToolCall(candidate) ||
            this.lastChanceRecoverToolCall(candidate);
          if (recovered && this.isDeclaredToolName(recovered.name)) {
            toolCalls.push(recovered);
            i = jsonEnd + 1;
            continue;
          }
        }
      }
      remainingText += text[i];
      i++;
    }

    if (toolCalls.length > 0) {
      // Strip trailing hallucinated ellipsis dots/spaces (e.g. `...... ......`)
      remainingText = remainingText.replace(/(\s*\.{2,}\s*)+$/g, "").trimEnd();
    }

    return { toolCalls, remainingText };
  }
}

/**
 * String and escape-aware scanner to find the matching closing brace '}'
 * for a JSON object starting at `startIdx`.
 */
function findMatchingClosingBrace(text: string, startIdx: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  let quoteChar = "";

  for (let j = startIdx; j < text.length; j++) {
    const ch = text[j];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === quoteChar) {
        inString = false;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inString = true;
        quoteChar = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) return j;
      }
    }
  }

  return -1;
}
