/*
 * File: validation.ts
 * Project: QwenBridge
 * Description: Request parsing and validation for chat completions
 */

import { Context } from "hono";
import { OpenAIRequest, Message } from "../../utils/types.ts";
import { QwenFileEntry, processImagesForQwen } from "../upload.ts";
import { logger, isToolcallDebugEnabled } from "../../core/logger.js";
import { config } from "../../core/config.ts";
import { getBasicHeaders } from "../../services/auth-http.ts";
import { buildToolInstructions } from "../../tools/instructions.ts";

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
  currentPrompt: string;
  allFiles: QwenFileEntry[];
  currentFiles: QwenFileEntry[];
  shouldParseToolCalls: boolean;
  modelId: string;
  enableThinking: boolean;
}

export async function parseRequestBody(c: Context): Promise<ParsedRequest> {
  const body: OpenAIRequest = await c.req.json();
  logIncomingChatRequest(c, body);
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

  const {
    systemPromptParts,
    promptParts,
    currentPromptParts,
    allFiles,
    currentFiles,
  } = await buildPromptFromMessages(messages, uploadHeaders);

  const shouldParseToolCalls = injectToolInstructions(systemPromptParts, body);

  const systemPrompt = systemPromptParts.join("");
  const prompt = promptParts.join("");
  const currentPrompt = currentPromptParts.join("");

  const modelId = body.model.replace("-no-thinking", "");
  const enableThinking = !body.model.endsWith("-no-thinking");

  return {
    body,
    isStream,
    isInternalSummarizationRequest,
    conversationKey,
    systemPrompt,
    prompt,
    currentPrompt,
    allFiles,
    currentFiles,
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
  currentPromptParts: string[];
  allFiles: QwenFileEntry[];
  currentFiles: QwenFileEntry[];
}> {
  const promptParts: string[] = [];
  const currentPromptParts: string[] = [];
  const systemPromptParts: string[] = [];
  const toolCallNamesById = new Map<string, string>();
  const allFiles: QwenFileEntry[] = [];
  const currentFiles: QwenFileEntry[] = [];
  const currentStartIndex = getCurrentPromptStartIndex(messages);

  // Pre-build tool_call_id -> name mapping in O(n)
  for (const msg of messages) {
    if (
      msg.role === "assistant" &&
      msg.tool_calls &&
      Array.isArray(msg.tool_calls)
    ) {
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
          if (i >= currentStartIndex) currentFiles.push(...files);
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
      const segment = `User: ${contentStr || ""}\n\n`;
      promptParts.push(segment);
      if (i >= currentStartIndex) currentPromptParts.push(segment);
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
            assistantContentParts.length > 0 ? toolCallStr : toolCallStr.trim(),
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
      const segment = `Assistant: ${assistantContent.trim()}\n\n`;
      promptParts.push(segment);
      if (i >= currentStartIndex) currentPromptParts.push(segment);
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
      const segment = `Tool Response (${toolName || "tool"}): ${contentStr || ""}\n\n`;
      promptParts.push(segment);
      if (i >= currentStartIndex) currentPromptParts.push(segment);
    }
  }

  return {
    systemPromptParts,
    promptParts,
    currentPromptParts,
    allFiles,
    currentFiles,
  };
}

function previewText(value: unknown, max = 220): string {
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else if (Array.isArray(value)) {
    text = value
      .map((part: any) => {
        if (part?.type === "text") return part.text || "";
        if (part?.type) return `[${part.type}]`;
        return JSON.stringify(part);
      })
      .join(" ");
  } else if (value !== null && value !== undefined) {
    text = JSON.stringify(value);
  }

  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function contentLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.length;
  if (value !== null && value !== undefined)
    return JSON.stringify(value).length;
  return 0;
}

function logIncomingChatRequest(c: Context, body: OpenAIRequest): void {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray((body as any).tools) ? (body as any).tools : [];
  const requestId = c.req.header("x-request-id") || null;
  const toolChoice = (body as any).tool_choice || null;

  logger.info("[chat] request received", {
    requestId,
    model: body.model,
    stream: body.stream ?? false,
    conversationId: body.conversation_id || null,
    sessionId: body.session_id || null,
    messagesCount: messages.length,
    toolsCount: tools.length,
    toolChoice,
  });

  if (!config.logging.chatRequests) return;

  const last = messages[messages.length - 1];
  const firstUser = messages.find((msg) => msg.role === "user");

  logger.debug("[chat] request details", {
    requestId,
    userAgent: c.req.header("user-agent") || null,
    model: body.model,
    stream: body.stream ?? false,
    conversationId: body.conversation_id || null,
    sessionId: body.session_id || null,
    user: body.user || null,
    messagesCount: messages.length,
    toolsCount: tools.length,
    toolChoice,
    roles: messages.map((msg) => msg.role),
    firstUserPreview: firstUser ? previewText(firstUser.content) : null,
    lastRole: last?.role || null,
    lastPreview: last ? previewText(last.content) : null,
    messageShape: messages.map((msg, index) => ({
      index,
      role: msg.role,
      contentType: Array.isArray(msg.content) ? "array" : typeof msg.content,
      contentLength: contentLength(msg.content),
      hasToolCalls: Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0,
      toolCallCount: Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0,
      toolCallId: msg.tool_call_id || null,
      name: msg.name || null,
      preview: previewText(msg.content, 140),
    })),
  });
}

function getCurrentPromptStartIndex(messages: Message[]): number {
  if (messages.length === 0) return 0;

  let last = messages.length - 1;
  while (last >= 0 && messages[last].role === "system") last--;
  if (last < 0) return messages.length;

  const lastRole = messages[last].role;
  if (lastRole === "user") return last;

  if (lastRole === "tool" || lastRole === "function") {
    let firstTrailingTool = last;
    while (
      firstTrailingTool - 1 >= 0 &&
      (messages[firstTrailingTool - 1].role === "tool" ||
        messages[firstTrailingTool - 1].role === "function")
    ) {
      firstTrailingTool--;
    }
    return firstTrailingTool;
  }

  return last;
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

  const instructions = buildToolInstructions(toolsJson, bodyAny.tool_choice);
  systemPromptParts.push(instructions);

  if (
    isToolcallDebugEnabled() &&
    bodyAny.tool_choice &&
    typeof bodyAny.tool_choice === "object" &&
    bodyAny.tool_choice.function
  ) {
    logger.debug("[chat] forced tool_choice", {
      forcedTool: bodyAny.tool_choice.function.name,
    });
  }

  return true;
}
