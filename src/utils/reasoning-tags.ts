/*
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

export interface ReasoningTagParseResult {
  text: string;
  reasoning: string;
  detectedThinkTag: boolean;
  hadMalformedTag: boolean;
  hadUnclosedTag: boolean;
}

const THINK_OPEN_RE = /^<think\b[^>]*>/i;
const THINK_CLOSE_RE = /^<\/think\s*>/i;
const THINK_OPEN_LITERAL = "<think>";
const THINK_CLOSE_LITERAL = "</think>";

type ThinkTagMatch = {
  type: "open" | "close";
  index: number;
  value: string;
};

type ThinkTagScan = {
  match: ThinkTagMatch | null;
  partialIndex: number;
};

function advanceMarkdownCodeState(
  text: string,
  initialDelimiterLength = 0,
): number {
  let delimiterLength = initialDelimiterLength;

  for (let index = 0; index < text.length;) {
    if (text[index] !== "`") {
      index++;
      continue;
    }

    let runLength = 1;
    while (index + runLength < text.length && text[index + runLength] === "`") {
      runLength++;
    }

    if (delimiterLength === 0) {
      delimiterLength = runLength;
    } else if (runLength >= delimiterLength) {
      delimiterLength = 0;
    }

    index += runLength;
  }

  return delimiterLength;
}

function isPartialThinkTagTail(tailLower: string): boolean {
  if (!tailLower.startsWith("<")) return false;

  if (
    THINK_OPEN_LITERAL.startsWith(tailLower) ||
    THINK_CLOSE_LITERAL.startsWith(tailLower)
  ) {
    return true;
  }

  return (
    (tailLower.startsWith("<think") || tailLower.startsWith("</think")) &&
    !tailLower.includes(">")
  );
}

/** Find complete/partial think tags while ignoring Markdown code spans/fences. */
function scanThinkTagOutsideMarkdown(
  buffer: string,
  initialDelimiterLength = 0,
): ThinkTagScan {
  let delimiterLength = initialDelimiterLength;

  for (let index = 0; index < buffer.length;) {
    if (buffer[index] === "`") {
      let runLength = 1;
      while (
        index + runLength < buffer.length &&
        buffer[index + runLength] === "`"
      ) {
        runLength++;
      }

      if (delimiterLength === 0) {
        delimiterLength = runLength;
      } else if (runLength >= delimiterLength) {
        delimiterLength = 0;
      }

      index += runLength;
      continue;
    }

    if (delimiterLength === 0 && buffer[index] === "<") {
      const tail = buffer.substring(index);
      const open = tail.match(THINK_OPEN_RE);
      if (open) {
        return {
          match: { type: "open", index, value: open[0] },
          partialIndex: -1,
        };
      }

      const close = tail.match(THINK_CLOSE_RE);
      if (close) {
        return {
          match: { type: "close", index, value: close[0] },
          partialIndex: -1,
        };
      }

      if (isPartialThinkTagTail(tail.toLowerCase())) {
        return { match: null, partialIndex: index };
      }
    }

    index++;
  }

  return { match: null, partialIndex: -1 };
}

/**
 * Keep a trailing backtick run until the next feed. This allows a fenced
 * delimiter such as ``` to arrive as one + two backticks across chunks without
 * being misclassified as an inline-code open immediately followed by a close.
 */
function trailingBacktickRunIndex(buffer: string): number {
  if (!buffer.endsWith("`")) return -1;
  let index = buffer.length - 1;
  while (index > 0 && buffer[index - 1] === "`") index--;
  return index;
}

function safeFlushIndex(buffer: string, partialTagIndex: number): number {
  const trailingBackticks = trailingBacktickRunIndex(buffer);
  const candidates = [partialTagIndex, trailingBackticks].filter(
    (index) => index >= 0,
  );
  return candidates.length > 0 ? Math.min(...candidates) : buffer.length;
}

/**
 * Removes leaked Qwen <think> blocks before visible text reaches the tool parser.
 *
 * The upstream can emit tags split across chunks, nested tags, unmatched closing
 * tags, or an unclosed block at end of stream. Reasoning is fail-closed: once an
 * opening tag is observed, unclosed content remains reasoning and is never sent
 * back as visible text/tool-call markup. Literal tags inside Markdown inline or
 * fenced code are preserved unchanged.
 */
export class StreamingReasoningTagSanitizer {
  private buffer = "";
  private thinkDepth = 0;
  private malformedCurrentBlock = false;
  private visibleMarkdownDelimiterLength = 0;
  private reasoningMarkdownDelimiterLength = 0;

  private appendVisible(result: ReasoningTagParseResult, text: string): void {
    if (!text) return;
    result.text += text;
    this.visibleMarkdownDelimiterLength = advanceMarkdownCodeState(
      text,
      this.visibleMarkdownDelimiterLength,
    );
  }

  private appendReasoning(result: ReasoningTagParseResult, text: string): void {
    if (!text) return;
    result.reasoning += text;
    this.reasoningMarkdownDelimiterLength = advanceMarkdownCodeState(
      text,
      this.reasoningMarkdownDelimiterLength,
    );
  }

  feed(chunk: string): ReasoningTagParseResult {
    this.buffer += chunk;
    const result: ReasoningTagParseResult = {
      text: "",
      reasoning: "",
      detectedThinkTag: false,
      hadMalformedTag: false,
      hadUnclosedTag: false,
    };

    while (this.buffer.length > 0) {
      if (this.thinkDepth === 0) {
        const scan = scanThinkTagOutsideMarkdown(
          this.buffer,
          this.visibleMarkdownDelimiterLength,
        );
        const tag = scan.match;

        if (tag?.type === "close") {
          // A stray closing tag outside code is leaked protocol markup. Drop it
          // rather than exposing it to users or the tool-call parser.
          this.appendVisible(result, this.buffer.substring(0, tag.index));
          this.buffer = this.buffer.substring(tag.index + tag.value.length);
          result.detectedThinkTag = true;
          result.hadMalformedTag = true;
          continue;
        }

        if (tag?.type === "open") {
          this.appendVisible(result, this.buffer.substring(0, tag.index));
          this.buffer = this.buffer.substring(tag.index + tag.value.length);
          this.thinkDepth = 1;
          this.malformedCurrentBlock = false;
          this.reasoningMarkdownDelimiterLength = 0;
          continue;
        }

        const flushIndex = safeFlushIndex(this.buffer, scan.partialIndex);
        if (flushIndex > 0) {
          this.appendVisible(result, this.buffer.substring(0, flushIndex));
          this.buffer = this.buffer.substring(flushIndex);
        }
        break;
      }

      const scan = scanThinkTagOutsideMarkdown(
        this.buffer,
        this.reasoningMarkdownDelimiterLength,
      );
      const tag = scan.match;

      // Inside reasoning, malformed nested tags are tracked without leaking
      // their markup or prematurely ending the outer reasoning block.
      if (tag?.type === "open") {
        this.appendReasoning(result, this.buffer.substring(0, tag.index));
        this.buffer = this.buffer.substring(tag.index + tag.value.length);
        this.thinkDepth++;
        this.malformedCurrentBlock = true;
        continue;
      }

      if (tag?.type === "close") {
        this.appendReasoning(result, this.buffer.substring(0, tag.index));
        this.buffer = this.buffer.substring(tag.index + tag.value.length);
        this.thinkDepth--;
        result.detectedThinkTag = true;
        result.hadMalformedTag ||= this.malformedCurrentBlock;
        if (this.thinkDepth === 0) {
          this.malformedCurrentBlock = false;
          this.reasoningMarkdownDelimiterLength = 0;
        }
        continue;
      }

      const flushIndex = safeFlushIndex(this.buffer, scan.partialIndex);
      if (flushIndex > 0) {
        this.appendReasoning(result, this.buffer.substring(0, flushIndex));
        this.buffer = this.buffer.substring(flushIndex);
      }
      break;
    }

    return result;
  }

  flush(): ReasoningTagParseResult {
    const result: ReasoningTagParseResult = {
      text: "",
      reasoning: "",
      detectedThinkTag: false,
      hadMalformedTag: false,
      hadUnclosedTag: false,
    };

    if (this.thinkDepth > 0) {
      // Fail closed: an incomplete reasoning block must never become visible
      // response content or be interpreted as a tool call.
      this.appendReasoning(result, this.buffer);
      result.detectedThinkTag = true;
      result.hadMalformedTag = true;
      result.hadUnclosedTag = true;
    } else {
      // Partial protocol-looking text and trailing backticks outside reasoning
      // are literal content at end of stream.
      this.appendVisible(result, this.buffer);
    }

    this.buffer = "";
    this.thinkDepth = 0;
    this.malformedCurrentBlock = false;
    this.visibleMarkdownDelimiterLength = 0;
    this.reasoningMarkdownDelimiterLength = 0;

    return result;
  }
}
