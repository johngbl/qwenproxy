export function estimateTokenCount(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
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
    // ASCII printable (space to ~)
    else if (codePoint >= 0x20 && codePoint <= 0x7e) {
      if (
        char === "{" ||
        char === "}" ||
        char === "[" ||
        char === "]" ||
        char === '"' ||
        char === ":" ||
        char === "," ||
        char === ";" ||
        char === "(" ||
        char === ")" ||
        char === "/" ||
        char === "\\"
      ) {
        tokens += 0.4;
      } else {
        tokens += 0.25;
      }
      i += 1;
    }
    // Newlines and whitespace
    else if (char === "\n" || char === "\r" || char === "\t") {
      tokens += 0.2;
      i += 1;
    }
    // Other Unicode (emoji, symbols, etc.)
    else {
      tokens += 1.0;
      i += codePoint > 0xffff ? 2 : 1;
    }
  }

  return Math.ceil(tokens);
}
