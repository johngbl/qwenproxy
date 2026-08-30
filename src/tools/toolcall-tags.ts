/**
 * Central tool-call marker module.
 *
 * The Qwen upstream filters/corrupts the conventional `<tool_call>` token in
 * the SSE stream. We deliberately use a private tag (`<qpx_call>`) that does
 * NOT contain the `tool_call` substring, so the provider passes it through
 * untouched. Every place that *emits* (prompt instructions, history replay) or
 * *parses* (response parser) tool calls reads from this module — the two sides
 * can never drift apart.
 *
 * Override with QWEN_TOOL_OPEN / QWEN_TOOL_CLOSE env vars if needed (e.g. to
 * dodge a future provider filter that learns this tag).
 *
 * The parser still accepts the legacy `<tool_call>` token from model output
 * for backward compatibility (in-flight sessions, models fine-tuned on it).
 */

const DEFAULT_OPEN = "<qpx_call>";
const DEFAULT_CLOSE = "</qpx_call>";

export const TOOL_CALL_OPEN: string =
  (process.env.QWEN_TOOL_OPEN || DEFAULT_OPEN).trim() || DEFAULT_OPEN;
export const TOOL_CALL_CLOSE: string =
  (process.env.QWEN_TOOL_CLOSE || DEFAULT_CLOSE).trim() || DEFAULT_CLOSE;

function tagName(tag: string): string {
  return tag
    .replace(/^<\/?/, "")
    .replace(/>$/, "")
    .trim();
}

/** All accepted open tag names (custom + legacy). */
export function getOpenNames(): string[] {
  return Array.from(new Set([tagName(TOOL_CALL_OPEN), "tool_call", "tool_calls"]));
}

/** All accepted close tag names (custom + legacy). */
export function getCloseNames(): string[] {
  return Array.from(new Set([tagName(TOOL_CALL_CLOSE), "tool_call", "tool_calls", "tool"]));
}

/** Wrap a JSON payload in the canonical open/close tags. */
export function wrapToolCallPayload(json: string): string {
  return `${TOOL_CALL_OPEN}\n${json}\n${TOOL_CALL_CLOSE}`;
}

function matchesAt(buffer: string, i: number, value: string): boolean {
  if (i + value.length > buffer.length) return false;
  for (let j = 0; j < value.length; j++) {
    const c = buffer.charCodeAt(i + j);
    const t = value.charCodeAt(j);
    if (c !== t && (c | 0x20) !== (t | 0x20)) return false;
  }
  return true;
}

/**
 * Find the first open tag in `buffer` (any accepted name, case-insensitive).
 * Returns position/length/tag string or null.
 */
export function findToolOpen(
  buffer: string,
): { index: number; length: number; tag: string } | null {
  let best: { index: number; length: number; tag: string } | null = null;
  for (const name of getOpenNames()) {
    const re = new RegExp(`<${name}\\b[^>]*>`, "i");
    const m = buffer.match(re);
    if (m && m.index !== undefined) {
      if (!best || m.index < best.index) {
        best = { index: m.index, length: m[0].length, tag: m[0] };
      }
    }
  }
  return best;
}

/**
 * At buffer position `i`, is there a whitespace-tolerant close tag?
 * Accepts `</qpx_call>`, `</tool_call >` (space before `>`), `</tool>`, etc.
 * Returns the total length consumed, or null.
 */
export function matchToolCloseAt(buffer: string, i: number): number | null {
  for (const name of getCloseNames()) {
    const prefix = `</${name}`;
    if (!matchesAt(buffer, i, prefix)) continue;
    let j = i + prefix.length;
    // Allow optional whitespace before closing `>`
    while (j < buffer.length && /\s/.test(buffer[j])) j++;
    if (buffer[j] === ">") return j + 1 - i;
  }
  return null;
}

/** Bare name of an open tag actually seen in the stream (e.g. 'qpx_call'). */
export function openTagName(openTag: string): string {
  const m = openTag.match(/^<\/?([a-zA-Z_][\w-]*)/);
  return m ? m[1] : tagName(TOOL_CALL_OPEN);
}

/** Matching close tag string for an open tag actually seen in the stream. */
export function closeTagFor(openTag: string): string {
  return `</${openTagName(openTag)}>`;
}

/**
 * True when `text` contains the start of any accepted open tag.
 * Used in stream-handler to detect tool-call signals in a chunk.
 */
export function textContainsToolCallStart(text: string): boolean {
  const lower = text.toLowerCase();
  for (const name of getOpenNames()) {
    if (lower.includes(`<${name.toLowerCase()}`)) return true;
  }
  return false;
}

/**
 * Strip leading stray close tags (`</qpx_call>`, `</tool_call>`, `</tool>`)
 * that the provider sometimes injects before real content.
 */
export function stripLeadingStrayCloses(s: string): string {
  const re = /^\s*<\/(?:qpx_call|tool_call|tool_calls|tool)\s*>/i;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) s = s.substring(m[0].length);
  return s;
}

/**
 * Strip trailing stray close tags that leak after the real payload.
 */
export function stripTrailingStrayCloses(s: string): string {
  const re = /<\/(?:qpx_call|tool_call|tool_calls|tool)\s*>\s*$/i;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) s = s.substring(0, s.length - m[0].length);
  return s;
}

/** Strip both leading and trailing stray close tags. */
export function sanitizeStrayCloses(s: string): string {
  return stripTrailingStrayCloses(stripLeadingStrayCloses(s));
}
