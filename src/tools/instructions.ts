import { TOOL_CALL_OPEN, TOOL_CALL_CLOSE } from "./toolcall-tags.js";
import { buildCompactToolManifest } from "./manifest.js";

/**
 * LRU-style cache for tool instructions to avoid rebuilding on every request.
 * Key format: toolsJson + "##" + toolChoice
 * Upstream: cb518e0
 */
const toolInstructionsCache = new Map<string, string>();
const TOOL_CACHE_MAX_ENTRIES = 64;

/**
 * Formats available tools into a compact TypeScript-like manifest if possible,
 * falling back to the raw string if parsing fails.
 */
function formatToolsRepresentation(toolsInput: string | unknown[]): string {
  if (typeof toolsInput === "string") {
    try {
      const parsed = JSON.parse(toolsInput);
      if (Array.isArray(parsed)) {
        const compact = buildCompactToolManifest(parsed);
        if (compact.trim().length > 0) return compact;
      }
    } catch {
      return toolsInput;
    }
    return toolsInput;
  }

  if (Array.isArray(toolsInput)) {
    const compact = buildCompactToolManifest(toolsInput);
    if (compact.trim().length > 0) return compact;
  }

  return String(toolsInput);
}

/**
 * Builds tool calling instructions for the system prompt.
 *
 * @param toolsJson - Stringified JSON array of available tools (or tools array).
 * @param toolChoice - Optional tool choice configuration.
 * @returns Formatted instruction string.
 */
export function buildToolInstructions(
  toolsJson: string | unknown[],
  toolChoice?: unknown,
): string {
  const toolsString = typeof toolsJson === "string" ? toolsJson : JSON.stringify(toolsJson);

  // Check cache first
  const cacheKey = `${toolsString}##${JSON.stringify(toolChoice ?? null)}`;
  const cached = toolInstructionsCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const manifest = formatToolsRepresentation(toolsJson);

  let forcedInstruction = "";
  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice as any).function?.name
  ) {
    forcedInstruction = `\nCRITICAL: You MUST call the tool "${(toolChoice as any).function.name}" in this response.\n`;
  }

  let instructions = `

# TOOLS AVAILABLE
${manifest}
${forcedInstruction}
[TOOL CALL CONTRACT - MANDATORY]
To invoke a tool, output a JSON object wrapped EXACTLY in ${TOOL_CALL_OPEN} and ${TOOL_CALL_CLOSE} tags:

${TOOL_CALL_OPEN}
{"name": "tool_name", "arguments": {"param_name": "value"}}
${TOOL_CALL_CLOSE}

CRITICAL RULES:
1. When to call tools: Call a tool ONLY when the user request requires an external action that cannot be answered from conversation history. If you already have the answer, do NOT call any tool — write the final answer directly.
2. Single vs Parallel: Emit at most ONE tool call per turn unless the user explicitly requested multiple independent operations. Each block must be complete and self-contained (never nested, interleaved, or omitted).
3. Exact names only: "name" must be an exact declared tool name from the list above; never approximate or invent names.
4. Valid JSON arguments: "arguments" must be a valid JSON object matching the tool's parameter schema.
5. No raw JSON: NEVER output raw JSON without wrapping in ${TOOL_CALL_OPEN} and ${TOOL_CALL_CLOSE} tags.
6. Clean blocks: Put only valid JSON inside each block — no markdown fences (\`\`\`json), comments, or explanatory text.
7. Stop immediately: Stop generating immediately after closing with ${TOOL_CALL_CLOSE}. Do not emit trailing dots, ellipsis (......), explanations, or reasoning after the tool call.
8. Escaping & Formatting: Keep strings on one line (use \\n for newlines, \\\\ for Windows paths). Do not split values across lines.
9. No duplicate calls: Never call the same tool with identical arguments if the result is already in the history.
`;

  // Cache result (with LRU-style eviction)
  if (toolInstructionsCache.size >= TOOL_CACHE_MAX_ENTRIES) {
    toolInstructionsCache.clear();
  }
  toolInstructionsCache.set(cacheKey, instructions);

  return instructions;
}


