/**
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

const THINK_OPEN_RE = /<think\b[^>]*>/i;
const THINK_START_LITERAL = "<think>";
const THINK_CLOSE_LITERAL = "</think>";

function findPartialThinkOpenIndex(buffer: string): number {
  const lower = buffer.toLowerCase();
  const idx = lower.lastIndexOf("<think");
  if (idx !== -1 && lower.indexOf(">", idx) === -1) return idx;

  for (let i = 1; i < THINK_START_LITERAL.length; i++) {
    if (lower.endsWith(THINK_START_LITERAL.substring(0, i))) {
      return buffer.length - i;
    }
  }

  return -1;
}

export class StreamingReasoningTagSanitizer {
  private buffer = "";
  private insideThink = false;
  private currentOpenTag = "";

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
      if (!this.insideThink) {
        const openMatch = this.buffer.match(THINK_OPEN_RE);
        const openIndex = openMatch?.index ?? -1;

        if (openMatch && openIndex !== -1) {
          result.text += this.buffer.substring(0, openIndex);
          this.buffer = this.buffer.substring(openIndex + openMatch[0].length);
          this.currentOpenTag = openMatch[0];
          this.insideThink = true;
          continue;
        }

        const partialOpenIndex = findPartialThinkOpenIndex(this.buffer);
        const flushIndex =
          partialOpenIndex === -1 ? this.buffer.length : partialOpenIndex;
        if (flushIndex > 0) {
          result.text += this.buffer.substring(0, flushIndex);
          this.buffer = this.buffer.substring(flushIndex);
        }
        break;
      }

      const closeIndex = this.buffer.toLowerCase().indexOf(THINK_CLOSE_LITERAL);
      if (closeIndex !== -1) {
        result.reasoning += this.buffer.substring(0, closeIndex);
        this.buffer = this.buffer.substring(
          closeIndex + THINK_CLOSE_LITERAL.length,
        );
        this.insideThink = false;
        this.currentOpenTag = "";
        result.detectedThinkTag = true;
        continue;
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

    if (!this.buffer) {
      return result;
    }

    if (this.insideThink) {
      result.text = `${this.currentOpenTag}${this.buffer}`;
      result.detectedThinkTag = true;
      result.hadMalformedTag = true;
      result.hadUnclosedTag = true;
    } else {
      result.text = this.buffer;
    }

    this.buffer = "";
    this.insideThink = false;
    this.currentOpenTag = "";

    return result;
  }
}
