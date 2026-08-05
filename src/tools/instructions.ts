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

# TOOL CALLING (MANDATORY)
When a tool is needed, call it immediately and output only 1-4 consecutive ${toolOpen} blocks:
${toolOpen}
{"name":"tool_name","arguments":{"param_name":"value"}}
${toolClose}

# RULES
- Follow the active personalized instructions.
- Think in English; answer in the user's language.
- Use the full conversation history and context.
- Use only declared tool names; never invent one.
- JSON must be valid and contain "name" and "arguments".
- Never output raw tool JSON without the tags.
- After tool-call blocks, output no text and wait for tool results.
- Never use ${thinkOpen} or ${thinkClose} for reasoning.

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
