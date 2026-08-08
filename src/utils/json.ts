import { logger } from "../core/logger.js";

const isDebug = process.env.TOOLCALL_DEBUG === "1";

function sanitizeAndBalance(input: string): {
  result: string;
  openBraces: number;
  openBrackets: number;
  recoveredUnclosedString: boolean;
  /** Opening tokens `{`/`[` in the order they were opened (LIFO close order). */
  openStack: string[];
} {
  let out = "";
  let openBraces = 0;
  let openBrackets = 0;
  let openStack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      const validEscapes = ["n", "r", "t", "u", '"', "\\", "/"];
      if (validEscapes.includes(char)) {
        if (char === "u") {
          const next4 = input.substring(i + 1, i + 5);
          out += /^[0-9a-fA-F]{4}$/.test(next4) ? "\\" + char : "\\\\" + char;
        } else if (["n", "r", "t"].includes(char)) {
          // Local check: only double-escape if the 2 chars before this
          // backslash form a Windows drive letter + colon (e.g. C:\, D:/).
          // Scanning the whole input causes false positives with URLs
          // like https:// or paths embedded elsewhere in the string.
          const isWinPath = i >= 2 && /[a-zA-Z]:/.test(input.substring(i - 2, i));
          const nextChar = input[i + 1] || "";
          out +=
            isWinPath && /^[a-zA-Z0-9]/.test(nextChar)
              ? "\\\\" + char
              : "\\" + char;
        } else {
          out += "\\" + char;
        }
      } else {
        out += "\\\\" + char;
      }
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (inString) {
      if (char === "\n") out += "\\n";
      else if (char === "\r") out += "\\r";
      else if (char === "\t") out += "\\t";
      else if (char.charCodeAt(0) < 32)
        out += "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0");
      else out += char;
    } else {
      out += char;
      if (char === "{") {
        openBraces++;
        openStack.push("{");
      }
      if (char === "}") {
        openBraces--;
        openStack.pop();
      }
      if (char === "[") {
        openBrackets++;
        openStack.push("[");
      }
      if (char === "]") {
        openBrackets--;
        openStack.pop();
      }
    }
  }

  let recoveredUnclosedString = false;
  if (escaped) {
    out += "\\";
  }
  if (inString) {
    out += '"';
    recoveredUnclosedString = true;
  }

  return { result: out, openBraces, openBrackets, recoveredUnclosedString, openStack };
}

/**
 * Close unterminated containers in LIFO order (reverse of how they were
 * opened). Appending all `]` then all `}` (the old counting-only approach)
 * produces invalid JSON whenever an array is opened and then an object is
 * opened inside it before truncation, e.g.
 * `{"a":[{"old_text":"start` needs `}],}}` and not `]}}}`.
 */
function closeBraces(
  input: string,
  openBraces: number,
  openBrackets: number,
  openStack: string[],
): string {
  let out = input;
  for (let i = openStack.length - 1; i >= 0; i--) {
    out += openStack[i] === "{" ? "}" : "]";
  }
  if (openBraces > 0 || openBrackets > 0) {
    // Open tokens shorter than the counted opens (no stack entries for them)
    // cannot happen since the stack mirrors the counts; keep the historical
    // count-based close as a safety net for callers without a stack.
    if (openStack.length === 0) {
      if (openBrackets > 0) out += "]".repeat(openBrackets);
      if (openBraces > 0) out += "}".repeat(openBraces);
    }
  }
  return out;
}

/**
 * Fixes missing opening quotes in JSON values.
 * Handles cases like: {"key": value_without_quotes"}
 * Upstream: a63f054, 9328bde
 */
function fixMissingOpeningQuotes(input: string): string {
  let out = input;
  let prev: string;
  do {
    prev = out;
    // Pattern 1: {"key": value"} or {key: value"}
    out = out.replace(
      /([{,[]\s*"[a-zA-Z_][\w]*"\s*:\s*)([^"\s,}\]][^"\n]*?)"([\s,}\]])/g,
      '$1"$2"$3',
    );
    out = out.replace(
      /([{,[]\s*[a-zA-Z_][\w]*\s*:\s*)([^"\s,}\]][^"\n]*?)"([\s,}\]])/g,
      '$1"$2"$3',
    );
    // Pattern 2: {: value"} - upstream 9328bde
    out = out.replace(/(:\s*)([A-Za-z_][\w.-]*?)"([\s,}\]])/g, '$1"$2"$3');
  } while (out !== prev);
  return out;
}

export function robustParseJSON(str: string): any {
  if (isDebug) {
    logger.debug("[json] robustParseJSON: starting", {
      inputLength: str.length,
      inputPreview: str.substring(0, 200),
    });
  }

  let sanitized = str.trim();
  sanitized = sanitized
    .replace(/^```json\s*/, "")
    .replace(/```$/, "")
    .trim();

  const firstBrace = sanitized.indexOf("{");
  if (firstBrace === -1) {
    if (isDebug) {
      logger.debug("[json] robustParseJSON: no opening brace found");
    }
    return null;
  }

  let jsonPart = sanitized.substring(firstBrace);
  try {
    const result = JSON.parse(jsonPart);
    if (isDebug) {
      logger.debug("[json] robustParseJSON: direct parse succeeded", {
        resultType: typeof result,
        resultPreview: JSON.stringify(result).substring(0, 200),
      });
    }
    return result;
  } catch (e) {
    if (isDebug) {
      logger.debug("[json] robustParseJSON: direct parse failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    // Fix double-escaped quotes (e.g., \\" -> ") only after direct parse
    // fails, to avoid corrupting valid JSON with legitimate \\ sequences.
    jsonPart = jsonPart.replace(/\\\\"/g, '\\"');
  }

  let currentJson = jsonPart.replace(
    /([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g,
    '$1"$2"$3',
  );
  currentJson = currentJson.replace(
    /([{,]\s*)"([a-zA-Z0-9_]+)"\s*:\s*"\2"\s*:/g,
    '$1"$2":',
  );
  currentJson = currentJson.replace(
    /([{,]\s*)([a-zA-Z0-9_]+)\s*:\s*\2\s*:/g,
    "$1$2:",
  );

  // Fix missing opening quotes in values (upstream: a63f054, 9328bde)
  currentJson = fixMissingOpeningQuotes(currentJson);

  // Handle unquoted string values after colon (e.g., "command":export CI=true)
  // Matches: "key":value_without_quotes until comma, closing brace, or end
  currentJson = currentJson.replace(
    /"([a-zA-Z0-9_]+)":\s*([^"\s{\[\],}][^,}\]]*)/g,
    (match, key, value) => {
      // Don't quote if it's a number, boolean, or null
      if (/^(true|false|null|\d+(\.\d+)?)$/.test(value.trim())) {
        return match;
      }
      return `"${key}":"${value.trim()}"`;
    },
  );

  try {
    const result = JSON.parse(currentJson);
    if (isDebug) {
      logger.debug("[json] robustParseJSON: quote-fix parse succeeded", {
        resultType: typeof result,
        resultPreview: JSON.stringify(result).substring(0, 200),
      });
    }
    return result;
  } catch (e) {
    if (isDebug) {
      logger.debug("[json] robustParseJSON: quote-fix parse failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    /* continue */
  }

  let cleaned = currentJson.trim();
  while (
    cleaned.length > 0 &&
    !/[}\]"0-9a-z]/i.test(cleaned[cleaned.length - 1])
  ) {
    cleaned = cleaned.slice(0, -1).trim();
  }

  const {
    result: fixedJson,
    openBraces,
    openBrackets,
    recoveredUnclosedString,
    openStack: fixedJsonOpenStack,
  } = sanitizeAndBalance(cleaned);

  if (isDebug && recoveredUnclosedString) {
    logger.debug(
      "[json] robustParseJSON: recovered unclosed string at end of input",
      {
        originalPreview: cleaned.substring(0, 150),
      },
    );
  }

  let lastBalancedIndex = -1;

  {
    let ob = 0,
      bk = 0,
      ins = false,
      esc = false;
    for (let i = 0; i < fixedJson.length; i++) {
      const c = fixedJson[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') {
        ins = !ins;
        continue;
      }
      if (!ins) {
        if (c === "{") ob++;
        if (c === "}") ob--;
        if (c === "[") bk++;
        if (c === "]") bk--;
        if (ob === 0 && bk === 0) lastBalancedIndex = i;
      }
    }
  }

  let tempJson = fixedJson;
  if (
    lastBalancedIndex !== -1 &&
    (openBraces !== 0 ||
      openBrackets !== 0 ||
      fixedJson.length > lastBalancedIndex + 1)
  ) {
    tempJson = fixedJson.substring(0, lastBalancedIndex + 1);
    if (isDebug) {
      logger.debug("[json] robustParseJSON: truncated to balanced index", {
        lastBalancedIndex,
        originalLength: fixedJson.length,
        truncatedLength: tempJson.length,
      });
    }
  } else if (openBraces > 0 || openBrackets > 0) {
    tempJson = closeBraces(
      fixedJson,
      openBraces,
      openBrackets,
      fixedJsonOpenStack,
    );
    if (isDebug) {
      logger.debug("[json] robustParseJSON: closed braces", {
        openBraces,
        openBrackets,
        resultLength: tempJson.length,
      });
    }
  }

  try {
    const result = JSON.parse(tempJson);
    if (isDebug) {
      logger.debug("[json] robustParseJSON: balanced-parse succeeded", {
        resultType: typeof result,
        resultPreview: JSON.stringify(result).substring(0, 200),
      });
    }
    return result;
  } catch (e) {
    if (isDebug) {
      logger.debug("[json] robustParseJSON: balanced-parse failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    let aggressive = fixedJson.trim();
    if (aggressive.endsWith(",")) aggressive = aggressive.slice(0, -1);
    const {
      result: aggFixed,
      openBraces: ob,
      openBrackets: bk,
      recoveredUnclosedString: aggRecovered,
      openStack: aggOpenStack,
    } = sanitizeAndBalance(aggressive);

    if (isDebug && aggRecovered) {
      logger.debug(
        "[json] robustParseJSON: aggressive recovery of unclosed string",
        {
          originalPreview: aggressive.substring(0, 150),
        },
      );
    }

    try {
      const result = JSON.parse(closeBraces(aggFixed, ob, bk, aggOpenStack));
      if (isDebug) {
        logger.debug("[json] robustParseJSON: aggressive-parse succeeded", {
          resultType: typeof result,
          resultPreview: JSON.stringify(result).substring(0, 200),
        });
      }
      return result;
    } catch {
      if (isDebug) {
        logger.debug("[json] robustParseJSON: all parse attempts failed", {
          originalError: e instanceof Error ? e.message : String(e),
        });
      }
      throw e;
    }
  }
}
