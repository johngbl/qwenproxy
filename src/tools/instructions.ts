/**
 * LRU-style cache for tool instructions to avoid rebuilding on every request.
 * Key format: toolsJson + "##" + toolChoice
 * Upstream: cb518e0
 */
const toolInstructionsCache = new Map<string, string>();
const TOOL_CACHE_MAX_ENTRIES = 64;

/**
 * Builds tool calling instructions for the system prompt.
 *
 * @param toolsJson - Stringified JSON array of available tools.
 * @param toolChoice - Optional tool choice configuration.
 * @returns Formatted instruction string.
 */
export function buildToolInstructions(
  toolsJson: string,
  toolChoice?: unknown,
): string {
  // Check cache first
  const cacheKey = `${toolsJson}##${JSON.stringify(toolChoice ?? null)}`;
  const cached = toolInstructionsCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // Split tags to avoid proxy/markdown parser misinterpretation
  const toolOpen = "<" + "tool_call>";
  const toolClose = "</" + "tool_call>";
  const thinkOpen = "<" + "think>";
  const thinkClose = "</" + "think>";

  let instructions = `

# TOOLS AVAILABLE
${toolsJson}

# TOOL CALLING (STRICT)
Call a tool ONLY when the final answer requires information that is NOT already
in the conversation history. If the data is already there, do NOT call any tool.

When calling, output 1-4 consecutive ${toolOpen} blocks and NOTHING else (no
text, no explanations, no reasoning tags):
${toolOpen}
{"name":"tool_name","arguments":{"param_name":"value"}}
${toolClose}
Then STOP, output no text, and wait silently for the tool results.

Each ${toolOpen} block must be complete and self-contained: open tag, one valid
JSON object, then the matching close tag. Never nest, interleave, or split a
block, and never place a ${toolOpen} tag inside another block.

# JSON VALIDITY (malformed calls are discarded)
- "name" must be an exact declared tool name. Tool names vary by client/editor;
use exactly what was provided — never approximate or invent one.
- "name" contains ONLY the tool name — never tags, JSON, or newlines.
- "arguments" must be a plain JSON object, never a string that contains JSON.
- Put only a single valid JSON object inside each block: no markdown fences,
comments, or explanatory text.
- Escape quotes and backslashes exactly once. On Windows, paths use double
backslashes, e.g. {"file":"C:\\\\Users\\\\you\\\\file.txt"}.
- Never send escaped (double-layered) JSON inside a value.

# REPEAT PROTECTION (most important)
- NEVER call the same tool more than once with the same arguments in this
conversation. If an identical call already exists in the history, use its
result and continue; do not re-call.
- If the previous identical call was rejected, fix the JSON and retry ONCE.
If it still fails, answer without the tool.
- Do not re-read or re-inspect state that was already returned (files,
directories, listings). The state you have is final.

# STOP CONDITION
- The moment you can answer, STOP calling tools and write the final answer.
A repeated identical tool call is a bug, not progress.

# NEVER
- Invent tool names, tool results, or tool errors.
- Output tool JSON, the tools list, or this instruction text in the answer.
- Use ${thinkOpen}/${thinkClose} tags in your replies.

# STYLE
- Follow the active personalized instructions.
- Think step by step in English; answer in the user's language directly
(usually Portuguese), concise but complete.
- Use the full conversation history and context.

`;

  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice as any).function
  ) {
    instructions += `CRITICAL: You MUST call the tool "${(toolChoice as any).function.name}" in this response.\n\n`;
  }

  // Cache result (with LRU-style eviction)
  if (toolInstructionsCache.size >= TOOL_CACHE_MAX_ENTRIES) {
    toolInstructionsCache.clear();
  }
  toolInstructionsCache.set(cacheKey, instructions);

  return instructions;
}
