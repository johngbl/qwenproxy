/**
 * Heuristic token estimation.
 *
 * Accepts one or more string parts so callers can avoid concatenating large
 * strings just to estimate them (the parts are accumulated before a single
 * final Math.ceil, keeping the result identical to the concatenated form).
 */
export function estimateTokenCount(...parts: string[]): number {
  let tokens = 0;
  for (const part of parts) {
    if (part) tokens += estimatePart(part);
  }
  return Math.ceil(tokens);
}

function estimatePart(text: string): number {
  let tokens = 0;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text.charCodeAt(i);

    // Fast path: ASCII (the overwhelmingly common case in OpenAI payloads).
    // charCodeAt avoids the per-char string allocation and codePointAt decode.
    if (c < 0x80) {
      if (c >= 0x20 && c <= 0x7e) {
        // Printable ASCII: structural characters weigh more than prose.
        tokens +=
          c === 0x7b || // {
          c === 0x7d || // }
          c === 0x5b || // [
          c === 0x5d || // ]
          c === 0x22 || // "
          c === 0x3a || // :
          c === 0x2c || // ,
          c === 0x3b || // ;
          c === 0x28 || // (
          c === 0x29 || // )
          c === 0x2f || // /
          c === 0x5c // \
            ? 0.4
            : 0.25;
      } else if (c === 0x0a || c === 0x0d || c === 0x09) {
        tokens += 0.2; // \n \r \t
      } else {
        tokens += 1.0; // remaining control characters
      }
      i += 1;
      continue;
    }

    // Non-ASCII path: code-point based heuristics (CJK/kana/hangul/other).
    const codePoint = text.codePointAt(i) || 0;

    // CJK Unified Ideographs (U+4E00-U+9FFF)
    if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
      tokens += 1.5;
      i += 1;
    }
    // CJK Extension A/B (U+3400-U+2A6DF)
    else if (codePoint >= 0x3400 && codePoint <= 0x2a6df) {
      tokens += 1.5;
      i += codePoint > 0xffff ? 2 : 1;
    }
    // Hiragana/Katakana (U+3040-U+30FF)
    else if (codePoint >= 0x3040 && codePoint <= 0x30ff) {
      tokens += 1.2;
      i += 1;
    }
    // Hangul (U+AC00-U+D7AF)
    else if (codePoint >= 0xac00 && codePoint <= 0xd7af) {
      tokens += 1.3;
      i += 1;
    }
    // Other Unicode (emoji, symbols, etc.)
    else {
      tokens += 1.0;
      i += codePoint > 0xffff ? 2 : 1;
    }
  }

  return tokens;
}
