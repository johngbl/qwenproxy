/*
 * File: validation.ts
 * Project: qproxy
 * Description: Request parsing and validation for chat completions
 */

import { Context } from "hono";
import { OpenAIRequest, Message } from "../../utils/types.ts";
import { QwenFileEntry, processImagesForQwen } from "../upload.ts";
import { logger, isToolcallDebugEnabled } from "../../core/logger.js";
import { getBasicHeaders } from "../../services/playwright.ts";

// Tag literals split to avoid proxy parser misinterpretation
const TOOL_CALL_OPEN = "<" + "tool_call>";
const TOOL_CALL_CLOSE = "</" + "tool_call>";

export interface ParsedRequest {
  body: OpenAIRequest;
  isStream: boolean;
  isInternalSummarizationRequest: boolean;
  conversationKey: string | null;
  systemPrompt: string;
  prompt: string;
  allFiles: QwenFileEntry[];
  shouldParseToolCalls: boolean;
  modelId: string;
  enableThinking: boolean;
}

export async function parseRequestBody(c: Context): Promise<ParsedRequest> {
  const body: OpenAIRequest = await c.req.json();
  const isStream = body.stream ?? false;
  const isInternalSummarizationRequest =
    c.req.header("X-Internal-Summarization") === "true";
  const conversationKey =
    typeof body.session_id === "string" && body.session_id.trim().length > 0
      ? body.session_id.trim()
      : typeof body.conversation_id === "string" &&
        body.conversation_id.trim().length > 0
        ? body.conversation_id.trim()
        : null;

  const messages = body.messages || [];
  let uploadHeaders: Record<string, string> | null = null;

  const { systemPromptParts, promptParts, allFiles } =
    await buildPromptFromMessages(messages, uploadHeaders);

  const shouldParseToolCalls = injectToolInstructions(systemPromptParts, body);

  const systemPrompt = systemPromptParts.join("");
  const prompt = promptParts.join("");

  const modelId = body.model.replace("-no-thinking", "");
  const enableThinking = !body.model.endsWith("-no-thinking");

  return {
    body,
    isStream,
    isInternalSummarizationRequest,
    conversationKey,
    systemPrompt,
    prompt,
    allFiles,
    shouldParseToolCalls,
    modelId,
    enableThinking,
  };
}

async function buildPromptFromMessages(
  messages: Message[],
  uploadHeaders: Record<string, string> | null,
): Promise<{
  systemPromptParts: string[];
  promptParts: string[];
  allFiles: QwenFileEntry[];
}> {
  const promptParts: string[] = [];
  const systemPromptParts: string[] = [];
  const toolCallNamesById = new Map<string, string>();
  const allFiles: QwenFileEntry[] = [];

  // Pre-build tool_call_id -> name mapping in O(n)
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id && tc.function?.name) {
          toolCallNamesById.set(tc.id, tc.function.name);
        }
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let contentStr = "";

    if (Array.isArray(msg.content)) {
      const imageParts = (msg.content as any[]).filter(
        (p: any) =>
          (p.type === "image_url" && p.image_url?.url) ||
          (p.type === "video_url" && p.video_url?.url) ||
          (p.type === "audio_url" && p.audio_url?.url) ||
          (p.type === "file_url" && p.file_url?.url),
      );

      if (imageParts.length > 0) {
        try {
          if (!uploadHeaders) {
            const { cookie, userAgent, bxV, bxUa, bxUmidtoken } =
              await getBasicHeaders();
            uploadHeaders = {
              cookie,
              "user-agent": userAgent,
              "bx-ua": bxUa,
              "bx-umidtoken": bxUmidtoken,
              "bx-v": bxV,
            };
          }
          const { text, files } = await processImagesForQwen(
            msg.content as any[],
            uploadHeaders,
          );
          contentStr = text;
          allFiles.push(...files);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : "Unknown error";
          console.error("[Chat] Failed to process images:", errMsg);
          contentStr = (msg.content as any[])
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n");
        }
      } else {
        contentStr = (msg.content as any[])
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n");
      }
    } else if (typeof msg.content === "object" && msg.content !== null) {
      contentStr = JSON.stringify(msg.content);
    } else {
      contentStr = msg.content || "";
    }

    if (msg.role === "system") {
      systemPromptParts.push((contentStr || "") + "\n\n");
    } else if (msg.role === "user") {
      promptParts.push(`User: ${contentStr || ""}\n\n`);
    } else if (msg.role === "assistant") {
      const assistantContentParts: string[] = [];
      const reasoning = (msg as any).reasoning_content;
      if (reasoning) {
        assistantContentParts.push(reasoning + "\n");
      }
      if (contentStr) {
        assistantContentParts.push(contentStr);
      }
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] processing assistant tool_calls in history", {
            messageIndex: i,
            toolCallsCount: msg.tool_calls.length,
            toolCallNames: msg.tool_calls.map((tc: any) => tc.function?.name),
          });
        }
        for (const tc of msg.tool_calls) {
          const args = tc.function?.arguments;
          let parsedArgs: any = {};
          if (typeof args === "string") {
            try {
              parsedArgs = JSON.parse(args);
            } catch (parseErr) {
              // Malformed JSON: preserve raw string for model visibility
              logger.warn("[chat] Failed to parse tool_call arguments", {
                toolCallId: tc.id,
                toolName: tc.function?.name,
                error: parseErr instanceof Error ? parseErr.message : "Unknown",
                rawArgs: args.substring(0, 200),
              });
              parsedArgs = { _raw: args };
            }
          } else if (args && typeof args === "object") {
            parsedArgs = args;
          }
          const payload = {
            name: tc.function?.name,
            arguments: parsedArgs,
          };
          const toolCallStr =
            "\n" +
            TOOL_CALL_OPEN +
            "\n" +
            JSON.stringify(payload) +
            "\n" +
            TOOL_CALL_CLOSE;
          assistantContentParts.push(
            assistantContentParts.length > 0
              ? toolCallStr
              : toolCallStr.trim(),
          );

          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] tool_call serialized to prompt", {
              toolName: tc.function?.name,
              toolCallId: tc.id,
              argsKeys: Object.keys(parsedArgs),
            });
          }
        }
      }
      const assistantContent = assistantContentParts.join("");
      promptParts.push(`Assistant: ${assistantContent.trim()}\n\n`);
    } else if (msg.role === "tool" || msg.role === "function") {
      let toolName =
        msg.name ||
        (msg.tool_call_id
          ? toolCallNamesById.get(msg.tool_call_id)
          : undefined);
      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] processing tool response in history", {
          messageIndex: i,
          toolName,
          toolCallId: msg.tool_call_id,
          contentLength: contentStr.length,
          contentPreview: contentStr.substring(0, 200),
        });
      }
      promptParts.push(
        `Tool Response (${toolName || "tool"}): ${contentStr || ""}\n\n`,
      );
    }
  }

  return { systemPromptParts, promptParts, allFiles };
}

function injectToolInstructions(
  systemPromptParts: string[],
  body: OpenAIRequest,
): boolean {
  const bodyAny = body as any;
  const declaredTools = Array.isArray(bodyAny.tools) ? bodyAny.tools : [];
  const shouldParseToolCalls = declaredTools.length > 0;

  if (!shouldParseToolCalls) return false;

  if (isToolcallDebugEnabled()) {
    logger.debug("[chat] tools provided in request", {
      toolsCount: declaredTools.length,
      toolNames: declaredTools.map((t: any) =>
        t.type === "function" ? t.function?.name : t.name,
      ),
      toolChoice: bodyAny.tool_choice || "none",
    });
  }

  const formattedTools = declaredTools.map((t: any) => {
    if (t.type === "function") {
      return {
        name: t.function.name,
        description: t.function.description || "",
        parameters: t.function.parameters,
      };
    }
    return t;
  });
  const toolsJson = JSON.stringify(formattedTools, null, 2);

  // Build instructions block using constants to keep tags out of literal source
  const instructions =
    "\n\n# TOOLS AVAILABLE\n" +
    "You have access to the following tools:\n" +
    toolsJson +
    "\n\n# TOOL CALLING FORMAT (MANDATORY)\n" +
    "To use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n" +
    TOOL_CALL_OPEN +
    "\n" +
    '{"name": "tool_name", "arguments": {"param_name": "value"}}' +
    "\n" +
    TOOL_CALL_CLOSE +
    "\n\nEXAMPLE OF MULTIPLE TOOL CALLS:\n" +
    TOOL_CALL_OPEN +
    "\n" +
    '{"name": "read_file", "arguments": {"path": "file1.txt"}}' +
    "\n" +
    TOOL_CALL_CLOSE +
    "\n" +
    TOOL_CALL_OPEN +
    "\n" +
    '{"name": "read_file", "arguments": {"path": "file2.txt"}}' +
    "\n" +
    TOOL_CALL_CLOSE +
    "\n\nCRITICAL RULES:\n" +
    "1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n" +
    "2. You can call multiple tools by outputting multiple " +
    TOOL_CALL_OPEN +
    " blocks consecutively.\n" +
    "3. Do NOT output any other text (explanations, chat, etc.) after your " +
    TOOL_CALL_OPEN +
    " blocks. Wait for the user to provide the tool response.\n" +
    '4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.\n' +
    "5. If you need to use a tool, do it IMMEDIATELY without preamble.\n\n";

  systemPromptParts.push(instructions);

  if (
    bodyAny.tool_choice &&
    typeof bodyAny.tool_choice === "object" &&
    bodyAny.tool_choice.function
  ) {
    const forcedTool = bodyAny.tool_choice.function.name;
    systemPromptParts.push(
      `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`,
    );

    if (isToolcallDebugEnabled()) {
      logger.debug("[chat] forced tool_choice", { forcedTool });
    }
  }

  return true;
}
