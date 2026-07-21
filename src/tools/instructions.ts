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

  let instructions =
    "\n\n# TOOLS AVAILABLE\n" +
    "You have access to the following tools:\n" +
    toolsJson +
    "\n\n# TOOL CALLING FORMAT (MANDATORY)\n" +
    "To use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n" +
    toolOpen +
    "\n" +
    '{"name": "tool_name", "arguments": {"param_name": "value"}}' +
    "\n" +
    toolClose +
    "\n\nEXAMPLE OF MULTIPLE TOOL CALLS:\n" +
    toolOpen +
    "\n" +
    '{"name": "tool_name", "arguments": {"param": "value1"}}' +
    "\n" +
    toolClose +
    "\n" +
    toolOpen +
    "\n" +
    '{"name": "tool_name", "arguments": {"param": "value2"}}' +
    "\n" +
    toolClose +
    "\n\nCRITICAL RULES:\n" +
    "1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n" +
    "2. You can call multiple tools by outputting multiple " +
    toolOpen +
    " blocks consecutively.\n" +
    "3. Do NOT output any other text (explanations, chat, etc.) after your " +
    toolOpen +
    " blocks. Wait for the user to provide the tool response.\n" +
    '4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.\n' +
    "5. If you need to use a tool, do it IMMEDIATELY without preamble.\n" +
    "6. After outputting tool call blocks, you MUST STOP and wait for tool responses. NEVER continue generating on your own.\n" +
    "7. ONLY use tool names that are explicitly defined in the instructions. NEVER invent or guess tool names. If a tool is not listed, it does not exist.\n" +
    "8. Maximum 6 tool calls per response. After 6 calls, STOP immediately and wait for the user to process them.\n" +
    "9. Never use " + thinkOpen + " or " + thinkClose + " for your own reasoning. Only include them inside code blocks when writing code or examples.\n\n";

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
