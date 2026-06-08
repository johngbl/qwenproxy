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
  // Split tags to avoid proxy parser misinterpretation
  const toolOpen = "<" + "tool_call>";
  const toolClose = "</" + "tool_call>";

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
    "8. Maximum 3 tool calls per response. After 3 calls, STOP immediately and wait for the user to process them.\n\n";

  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice as any).function
  ) {
    instructions += `CRITICAL: You MUST call the tool "${(toolChoice as any).function.name}" in this response.\n\n`;
  }

  return instructions;
}
