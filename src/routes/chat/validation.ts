/*
 * File: validation.ts
 * Project: QwenProxy
 * Description: Request parsing and validation for chat completions
 */

import type { Context } from "hono";
import type { OpenAIRequest, Message } from "../../utils/types.ts";
import type { QwenFileEntry } from "../upload.ts";
import { processImagesForQwen } from "../upload.ts";
import { logger, isToolcallDebugEnabled } from "../../core/logger.js";
import { config } from "../../core/config.ts";
import { getBasicHeaders } from "../../services/auth-playwright.ts";
import { buildToolInstructions } from "../../tools/instructions.ts";
import {
  mapClientModelToQwen,
  stripThinkingSuffix,
  type ReasoningMode,
} from "../../core/model-alias.ts";

import {
  normalizeReasoningEffort,
  effortToReasoningMode,
} from "../../core/reasoning-effort.ts";

import { TOOL_CALL_OPEN, TOOL_CALL_CLOSE } from "../../tools/toolcall-tags.ts";

export interface ParsedRequest {
  body: OpenAIRequest;
  isStream: boolean;
  conversationKey: string | null;
  hasExplicitConversationKey: boolean;
  systemPrompt: string;
  toolInstructions: string;
  prompt: string;
  currentPrompt: string;
  allFiles: QwenFileEntry[];
  currentFiles: QwenFileEntry[];
  shouldParseToolCalls: boolean;
  modelId: string;
  enableThinking: boolean;
  reasoningMode: ReasoningMode;
  messageCount: number;
  currentMessageCount: number;
}

export async function parseRequestBody(c: Context): Promise<ParsedRequest> {
  const body: OpenAIRequest = await c.req.json();
  logIncomingChatRequest(c, body);
  const isStream = body.stream ?? false;
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

  const toolInstructions = injectToolInstructions(body);
  const shouldParseToolCalls = toolInstructions.length > 0;

  const systemPrompt = systemPromptParts.join("") + buildResponseFormatInstruction(body);
  const prompt = promptParts.join("");
  const currentPrompt = currentPromptParts.join("");

  // Thinking suffixes → base model + reasoning mode
  const { baseModel, enableThinking, reasoningMode } = stripThinkingSuffix(body.model);
  const modelId = mapClientModelToQwen(baseModel);

  // OpenAI `reasoning_effort` (none|minimal|low|medium|high|xhigh|max).
  // Precedence: an explicit model suffix wins — effort only acts on unsuffixed
  // models (reasoningMode "auto"). Absent/empty effort is a complete no-op.
  // Qwen has no medium gradient, so only the low tier is meaningful: it forces
  // Fast (thinking off). medium/high/max keep Qwen's own auto decision.
  // The camelCase alias is accepted too: OpenCode-style configs overlay the
  // raw `reasoningEffort` setting into the request body.
  const rawEffort = body.reasoning_effort ?? body.reasoningEffort;
  const effortMode =
    reasoningMode === "auto"
      ? effortToReasoningMode(normalizeReasoningEffort(rawEffort))
      : undefined;
  const finalReasoningMode = effortMode ?? reasoningMode;
  const finalEnableThinking = effortMode === "fast" ? false : enableThinking;

  return {
    body,
    isStream,
    conversationKey,
    hasExplicitConversationKey: conversationKey !== null,
    systemPrompt,
    toolInstructions,
    prompt,
    currentPrompt,
    allFiles,
    currentFiles,
    shouldParseToolCalls,
    modelId,
    enableThinking: finalEnableThinking,
    reasoningMode: finalReasoningMode,
    messageCount: promptParts.length,
    currentMessageCount: currentPromptParts.length,
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
      const isCurrentMessage = i >= currentStartIndex;
      const imageParts = (msg.content as any[]).filter(
        (p: any) =>
          (p.type === "image_url" && p.image_url?.url) ||
          (p.type === "video_url" && p.video_url?.url) ||
          (p.type === "audio_url" && p.audio_url?.url) ||
          (p.type === "file_url" && p.file_url?.url),
      );

      if (imageParts.length > 0 && isCurrentMessage) {
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
          currentFiles.push(...files);
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

  // Full request debug
  if (process.env.REQUEST_DEBUG === "true") {
    const bodyStr = JSON.stringify(body);
    console.log(
      `[Request] Full body | ${bodyStr.length} chars | ${bodyStr.substring(0, 2000)}`,
    );
    if (tools.length > 0) {
      console.log(
        `[Request] Tools | ${tools.length} definitions | ${JSON.stringify(tools).length} chars`,
      );
    }
    // Log each message role and content preview
    messages.forEach((msg: any, i: number) => {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
      console.log(
        `[Request] Message ${i} | role=${msg.role} | ${content.length} chars${hasToolCalls ? " | tool_calls=" + msg.tool_calls.length : ""}${msg.tool_call_id ? " | tool_call_id=" + msg.tool_call_id : ""} | preview=${content.substring(0, 100)}`,
      );
    });
  }

  // The debug payload below scans every message (regex previews + JSON
  // stringify), so skip building it unless it will actually be logged.
  if (!config.logging.chatRequests || !logger.isLevelEnabled("debug")) return;

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
  if (lastRole === "user") {
    // Check if there's a tool response right before this user message
    // If so, include it in the current prompt
    let toolStart = last - 1;
    while (
      toolStart >= 0 &&
      (messages[toolStart].role === "tool" ||
        messages[toolStart].role === "function")
    ) {
      toolStart--;
    }
    // If we found tool messages, also include the assistant message that made the tool calls
    if (toolStart < last - 1) {
      // toolStart points to the message before the first tool message
      // Check if it's an assistant message with tool_calls
      if (
        toolStart >= 0 &&
        messages[toolStart].role === "assistant" &&
        messages[toolStart].tool_calls &&
        messages[toolStart].tool_calls!.length > 0
      ) {
        return toolStart;
      }
      return toolStart + 1;
    }
    return last;
  }

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

// Structured outputs (doc §2.1 / checklist item 6): OpenAI's response_format
// is not natively supported by the Qwen web API, so the schema/JSON-mode
// constraint is enforced at the prompt level — the same approach as tools.
// json_object demands a bare JSON object; json_schema embeds the schema with a
// strict-mode note. Text mode (default) returns nothing and changes nothing.
function buildResponseFormatInstruction(body: OpenAIRequest): string {
  const bodyAny = body as any;
  const rf = bodyAny?.response_format;
  if (!rf || typeof rf !== "object") return "";

  if (rf.type === "json_object") {
    return (
      "\n\n[OUTPUT FORMAT]\n" +
      "Respond with a single valid JSON object only. " +
      "Do not wrap it in markdown code fences and do not add any text " +
      "before or after the JSON object."
    );
  }

  if (rf.type === "json_schema" && rf.json_schema?.schema) {
    const { name, description, schema, strict } = rf.json_schema;
    const strictNote =
      strict === true
        ? "The output MUST strictly conform to the schema: every required property present and no extra properties.\n"
        : "The output MUST conform to the following JSON schema.\n";
    return (
      "\n\n[OUTPUT FORMAT]\n" +
      (name ? `Output schema name: ${name}\n` : "") +
      (description ? `Schema description: ${description}\n` : "") +
      strictNote +
      "Respond with a single JSON object that matches this schema. " +
      "Do not wrap it in markdown code fences and do not add any text " +
      "before or after the JSON object.\n\n" +
      `Schema:\n${JSON.stringify(schema, null, 2)}`
    );
  }

  return "";
}

function injectToolInstructions(body: OpenAIRequest): string {
  const bodyAny = body as any;
  const declaredTools = Array.isArray(bodyAny.tools) ? bodyAny.tools : [];
  const shouldParseToolCalls = declaredTools.length > 0;

  if (!shouldParseToolCalls) return "";

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

  return instructions;
}
