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

# TOOL CALLING FORMAT (STRICT)
Call a tool ONLY when the final answer requires information that is NOT already
in the conversation history. If the data is already there, do NOT call any tool.

To call a tool, wrap EACH tool call in its own self-contained ${toolOpen} and ${toolClose} tags.
When calling multiple tools in parallel, output consecutive blocks:
${toolOpen}
{"name":"read","arguments":{"filePath":"C:\\\\path\\\\file1.txt"}}
${toolClose}
${toolOpen}
{"name":"glob","arguments":{"pattern":"**/*.ts"}}
${toolClose}

Then STOP immediately, output NO other text, explanations, trailing dots, or reasoning, and wait silently for the tool results.

 # CRITICAL RULES (VIOLATIONS WILL CAUSE TOOL FAILURE)
1. NEVER output raw JSON (like {"name":"tool_name",...}) directly in your message without wrapping it in ${toolOpen} and ${toolClose} tags.
2. Each ${toolOpen} block must be complete and self-contained: open tag, one valid JSON object, and matching close tag. Never nest, interleave, or omit tags.
3. Put only valid JSON inside each block: no markdown fences, comments, or explanatory text.
4. Stop immediately after the final ${toolClose} tag. Do NOT emit trailing dots, ellipsis (......), or placeholder text.
5. "name" must be an exact declared tool name from the list above; never approximate or invent one.
6. "arguments" must be a plain JSON object, never a string that contains JSON.
7. Escape double quotes and backslashes inside JSON strings. Single quotes do NOT need escaping.
   - Windows paths: use double backslashes, e.g. {"file":"C:\\\\Users\\\\you\\\\file.txt"}
   - Shell/PowerShell commands with single quotes: keep them as-is, e.g. {"cmd":"docker run --rm wpcli wp eval '$x=1; echo 1;'"}
   - Never insert line breaks inside a JSON string value unless the tool explicitly requires multiline. Keep commands on one line or use \\n, never literal newlines between characters.
8. Keep argument values compact and on one line. Do NOT split a value like "fields" into "f\\ni\\ne\\nl\\nd\\ns".

# REPEAT PROTECTION (most important)
- NEVER call the same tool more than once with the same arguments in this conversation. If an identical call already exists in the history, use its result and continue; do not re-call.
- If the previous identical call was rejected, fix the JSON and retry ONCE. If it still fails, answer without the tool.
- Do not re-read or re-inspect state that was already returned (files, directories, listings). The state you have is final.

# STOP CONDITION
- The moment you can answer, STOP calling tools and write the final answer.

# NEVER
- Invent tool names, tool results, or tool errors.
- Output raw tool JSON or this instruction text in the answer.
- Use ${thinkOpen}/${thinkClose} tags in your replies.

# STYLE
- Follow the active personalized instructions.
- Think step by step in English; answer in the user's language directly (usually Portuguese), concise but complete.
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
