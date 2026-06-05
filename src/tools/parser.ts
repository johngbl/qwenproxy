import { v4 as uuidv4 } from "uuid";
import { robustParseJSON } from "../utils/json.ts";
import { logger, isToolcallDebugEnabled } from "../core/logger.js";
import type { ParsedToolCall } from "./types";
import type { FunctionToolDefinition } from "./types";

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

function advanceMarkdownCodeState(
  text: string,
  initialDelimiterLength = 0,
): number {
  let delimiterLength = initialDelimiterLength;

  for (let i = 0; i < text.length; ) {
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

  for (let i = 0; i < buffer.length; ) {
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

    if (delimiterLength === 0) {
      const match = buffer.substring(i).match(/^<tool_call\b[^>]*>/i);
      if (match) {
        return { index: i, openTag: match[0] };
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
  const lowerToolStart = TOOL_START_LITERAL.toLowerCase();

  for (let i = 0; i < buffer.length; ) {
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
      if (tailLower.startsWith("<tool_call") && tailLower.indexOf(">") === -1) {
        return i;
      }
      if (lowerToolStart.startsWith(tailLower)) {
        return i;
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

function findPartialMissingOpenToolCallIndex(
  buffer: string,
  initialDelimiterLength = 0,
): number {
  if (buffer.toLowerCase().includes(TOOL_END)) return -1;

  const candidateStarts = findCandidateStarts(buffer);
  for (const candidateStart of candidateStarts) {
    if (
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

  return -1;
}

function findRecoverableMissingOpenToolCall(
  buffer: string,
  initialDelimiterLength = 0,
): { textBefore: string; candidate: string; consumeLength: number } | null {
  const lower = buffer.toLowerCase();
  const endIdx = lower.indexOf(TOOL_END);
  if (endIdx === -1) return null;

  const beforeEnd = buffer.substring(0, endIdx);
  const candidateStarts = findCandidateStarts(beforeEnd);

  for (const candidateStart of candidateStarts) {
    if (
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
      consumeLength: endIdx + TOOL_END.length,
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
    /<tool_call\b[^>]*\bname\s*=\s*["']([^"']+)["']/i,
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

const TOOL_START_LITERAL = "<" + "tool_call>";

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
  private emittedToolCallCount = 0;
  private pendingLeadIn = "";
  private tools: ToolDefinitionLike[] = [];
  private markdownCodeDelimiterLength = 0;
  private incrementalToolCalls = false;
  private activeIncrementalToolCall: ActiveIncrementalToolCall | null = null;

  /**
   * @param tools - Optional array of tool definitions for name inference
   */
  constructor(
    tools: ToolDefinitionLike[] = [],
    options: StreamingToolParserOptions = {},
  ) {
    this.tools = tools;
    this.incrementalToolCalls = options.incrementalToolCalls ?? false;
    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] StreamingToolParser initialized", {
        toolsCount: tools.length,
        toolNames: tools.map((t) => this.getToolName(t)).filter(Boolean),
        incrementalToolCalls: this.incrementalToolCalls,
      });
    }
  }

  /**
   * Update the tools list (e.g. if received after construction).
   */
  setTools(tools: ToolDefinitionLike[]): void {
    this.tools = tools;
  }

  private startIncrementalToolCall(): void {
    if (!this.incrementalToolCalls) return;
    this.activeIncrementalToolCall = {
      index: this.emittedToolCallCount,
      id: `call_${uuidv4()}`,
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

  private normalizeArgumentsForTool(
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const matchingTool = this.tools.find(
      (tool) => this.getToolName(tool) === name,
    );
    const toolProperties = this.getToolProperties(matchingTool);
    if (
      Object.keys(args).length === 1 &&
      Object.prototype.hasOwnProperty.call(args, "arguments") &&
      typeof (args as any).arguments === "object" &&
      (args as any).arguments !== null &&
      !Object.prototype.hasOwnProperty.call(toolProperties, "arguments")
    ) {
      return (args as any).arguments as Record<string, unknown>;
    }

    return args;
  }

  private finalizeSuccessfulToolCall(
    tc: ParsedToolCall,
    result: ParserResult,
  ): void {
    if (!this.isDeclaredToolName(tc.name)) {
      logger.warn("[parser] Dropping undeclared tool call", {
        toolName: tc.name,
        declaredTools: this.tools.map((tool) => this.getToolName(tool)),
      });
      if (
        this.emittedToolCallCount === 0 &&
        this.pendingLeadIn.trim().length > 0
      ) {
        result.text += this.pendingLeadIn;
      }
      this.pendingLeadIn = "";
      this.clearIncrementalToolCall();
      return;
    }

    const incremental = this.activeIncrementalToolCall;
    const matchesIncrementalCall =
      incremental?.name === tc.name && incremental.startEmitted;

    if (incremental && incremental.name === tc.name) {
      tc.id = incremental.id;
    }

    if (matchesIncrementalCall) {
      this.emittedToolCallCount++;
      this.pendingLeadIn = "";
      incremental.startEmitted = false;
      incremental.disabled = true;
      return;
    }

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
      const parsedArgs = robustParseJSON(rawArgs);
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

  private emitIncrementalToolCallDeltas(
    content: string,
    result: ParserResult,
  ): void {
    if (!this.incrementalToolCalls || !this.activeIncrementalToolCall) return;

    const incremental = this.activeIncrementalToolCall;
    if (incremental.disabled) return;

    const snapshot = inspectIncrementalJsonToolObject(content);
    if (!snapshot) return;

    if (snapshot.name && !incremental.name) {
      if (!this.isDeclaredToolName(snapshot.name)) {
        incremental.disabled = true;
        return;
      }
      incremental.name = snapshot.name;
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
      result.toolCallDeltas.push({
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
      result.toolCallDeltas.push({
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
    if (!name || this.tools.length === 0) return true;
    return this.tools.some((tool) => this.getToolName(tool) === name);
  }

  private preserveLiteralToolCall(
    content: string,
    result: ParserResult,
    reason: string,
    closed = true,
  ): void {
    const literalBlock = `${this.currentOpenTag}${content}${closed ? TOOL_END : ""}`;
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
            this.buffer = this.buffer.substring(
              missingOpenRecovery.consumeLength,
            );
            this.processToolContent(missingOpenRecovery.candidate, result);
            this.currentOpenTag = TOOL_START_LITERAL;
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
        // Inside tool: look for </tool_call>
        const lowerBuffer = this.buffer.toLowerCase();
        const endIdx = lowerBuffer.indexOf(TOOL_END);
        if (endIdx !== -1) {
          const content = this.buffer.substring(0, endIdx);
          if (isToolcallDebugEnabled()) {
            logger.debug("[parser] tool_call close tag detected", {
              contentLength: content.length,
              contentPreview: content.substring(0, 300),
              remainingBufferLength:
                this.buffer.length - endIdx - TOOL_END.length,
            });
          }
          this.emitIncrementalToolCallDeltas(content, result);
          this.buffer = this.buffer.substring(endIdx + TOOL_END.length);
          this.processToolContent(content, result);
          this.insideTool = false;
          this.currentOpenTag = TOOL_START_LITERAL;
          this.clearIncrementalToolCall();
        } else {
          this.emitIncrementalToolCallDeltas(this.buffer, result);
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
      const trimmed = this.buffer.trim();
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
        this.emitIncrementalToolCallDeltas(this.buffer, result);
        const recovered =
          this.tryRecoverToolCall(trimmed) ||
          this.tryRecoverIncrementalToolCall(trimmed);
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
          // Recovery failed. Restore lead-in text if no tools were emitted.
          logger.warn(
            "[parser] Dropping unrecoverable unclosed tool call at end of stream",
            {
              bufferPreview: trimmed.substring(0, 500),
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
      } else {
        // Empty tool call block - restore lead-in
        if (isToolcallDebugEnabled()) {
          logger.debug(
            "[parser] flush: empty tool call block, restoring lead-in",
          );
        }
        if (
          this.emittedToolCallCount === 0 &&
          this.pendingLeadIn.trim().length > 0
        ) {
          result.text += this.pendingLeadIn;
        }
        this.pendingLeadIn = "";
      }
    } else {
      this.emitVisibleText(result, this.buffer);
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
      if (!this.isDeclaredToolName(xmlParsed.name)) {
        this.preserveLiteralToolCall(
          content,
          result,
          `undeclared tool name: ${xmlParsed.name}`,
        );
        return;
      }
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
          id: `call_${uuidv4()}`,
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

        const undeclaredToolNames = parsedCalls
          .map((tc) => tc.name)
          .filter((name) => !this.isDeclaredToolName(name));
        if (undeclaredToolNames.length > 0) {
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
      const tcs = this.parseToolContent(t);
      if (tcs.length > 0) {
        const undeclaredToolNames = tcs
          .map((tc) => tc.name)
          .filter((name) => !this.isDeclaredToolName(name));
        if (undeclaredToolNames.length > 0) {
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

    // 4) Tool call is malformed and unrecoverable.
    // Never leak internal XML to user-visible content.
    // Restore lead-in text if no tools were emitted.
    logger.warn("[parser] Dropping malformed tool call block", {
      contentPreview: t.substring(0, 500),
      hasName:
        t.includes('"name"') || t.includes('"tool"') || t.includes("tool_name"),
      hasArgs:
        t.includes('"arguments"') ||
        t.includes('"args"') ||
        t.includes('"parameters"') ||
        t.includes('"input"'),
      first100Chars: t.substring(0, 100),
      contentLength: t.length,
    });
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
      if (!this.isDeclaredToolName(xmlParsed.name)) {
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
      if (isToolcallDebugEnabled()) {
        logger.debug("[parser] tryRecoverToolCall: full XML parse succeeded", {
          name: xmlParsed.name,
          arguments: xmlParsed.arguments,
        });
      }
      return {
        id: `call_${uuidv4()}`,
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
      if (!this.isDeclaredToolName(recovered.name)) {
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
        id: `call_${uuidv4()}`,
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
        if (!this.isDeclaredToolName(first.name)) {
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
   * Try to recover malformed JSON that's missing opening brace/quote.
   * Example: `name": "read", "arguments": {"backend/package.json"}}`
   */
  private tryRecoverMalformedJson(str: string): ParsedToolCall | null {
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
              let args =
                parsed.arguments ||
                parsed.function?.arguments ||
                parsed.args ||
                parsed.parameters ||
                parsed.input ||
                {};
              if (typeof args === "string") {
                try {
                  args = JSON.parse(args);
                } catch {
                  args = {};
                }
              }
              if (typeof args !== "object" || args === null) args = {};

              if (isToolcallDebugEnabled()) {
                logger.debug("[parser] tryRecoverMalformedJson: success", {
                  name,
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
                id: `call_${uuidv4()}`,
                name,
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

  private parseToolContent(str: string): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];

    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] parseToolContent: starting parse", {
        inputLength: str.length,
        inputPreview: str.substring(0, 200),
        hasNewlines: str.includes("\n"),
      });
    }

    // Try parsing as single JSON first
    try {
      const parsed = robustParseJSON(str);
      if (parsed && typeof parsed === "object") {
        const tc = this.parseToolCall(parsed);
        if (tc) {
          if (isToolcallDebugEnabled()) {
            logger.debug(
              "[parser] parseToolContent: single JSON parse succeeded",
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
        logger.debug("[parser] parseToolContent: single JSON parse failed", {
          error: e instanceof Error ? e.message : String(e),
        });
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

    // Fallback: extract JSON tool call via balanced-brace search for large payloads
    if (
      calls.length === 0 &&
      str.includes('"name"') &&
      str.includes('"arguments"')
    ) {
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

  private parseToolCall(parsed: any): ParsedToolCall | null {
    if (!parsed || typeof parsed !== "object") return null;

    const name =
      parsed.name || parsed.function?.name || parsed.tool_name || parsed.tool;
    if (!name || typeof name !== "string" || name.length === 0) return null;

    let args =
      parsed.arguments ||
      parsed.function?.arguments ||
      parsed.args ||
      parsed.parameters ||
      parsed.input ||
      {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    if (typeof args !== "object" || args === null) args = {};

    args = this.normalizeArgumentsForTool(name, args);

    return {
      id: parsed.id || parsed.tool_call_id || `call_${uuidv4()}`,
      name,
      arguments: args,
    };
  }
}
