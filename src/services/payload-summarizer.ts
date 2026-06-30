/**
 * Payload summarizer for large requests.
 *
 * When the total payload exceeds a threshold, this module:
 * 1. Splits old messages into chunks and summarizes in parallel
 * 2. Truncates individual large messages in the recent set
 * 3. Rebuilds prompt with summary + truncated recent messages
 */

import { config } from "../core/config.ts";
import { logger } from "../core/logger.ts";
import { getQwenHeaders } from "./auth-playwright.ts";
import { buildQwenRequestHeaders } from "./qwen-headers.ts";
import { v4 as uuidv4 } from "uuid";
import { loadAccounts } from "../core/accounts.ts";
import { getAccountCooldownInfo } from "../core/account-manager.ts";

const PAYLOAD_SIZE_THRESHOLD = 100_000; // 100KB - Qwen TMD triggers around this size
const SUMMARIZATION_TIMEOUT_MS = 60_000;
const CHUNK_SIZE = 10; // messages per summarization chunk
const MAX_CHUNK_CHARS = 80_000; // 80KB max per chunk text
const MAX_SINGLE_MESSAGE_CHARS = 40_000; // 40KB max per individual message
const TOOL_MEMORY_MAX_ITEMS = 24;
const TOOL_MEMORY_ITEM_MAX_CHARS = 180;

const SUMMARIZE_PROMPT = `You are a conversation summarizer. Summarize the following conversation history concisely, preserving:
1. Key decisions and conclusions
2. Important code, file paths, or technical details
3. The current task/problem being solved
4. Any unresolved questions or pending work

Keep the summary information-dense but under 2000 tokens.

Conversation to summarize:`;

export interface SummarizeResult {
  summary: string;
  originalChars: number;
  summaryChars: number;
}

function estimatePayloadChars(
  messages: Array<{ role: string; content: any }>,
): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.text) total += part.text.length;
        else total += JSON.stringify(part).length;
      }
    } else if (msg.content) {
      total += JSON.stringify(msg.content).length;
    }
  }
  return total;
}

function summarizeCompactText(
  value: string,
  maxChars = TOOL_MEMORY_ITEM_MAX_CHARS,
): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}... [truncated]`;
}

function stringifyToolArgs(args: unknown): string {
  try {
    return summarizeCompactText(JSON.stringify(args), 220);
  } catch {
    return summarizeCompactText(String(args), 220);
  }
}

function extractMessageText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => part.text || JSON.stringify(part))
      .join("\n");
  }
  return content ? JSON.stringify(content) : "";
}

function buildToolMemory(messages: Array<any>): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const name = call?.function?.name || call?.name || "unknown_tool";
        let args: unknown = {};
        if (typeof call?.function?.arguments === "string") {
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            args = call.function.arguments;
          }
        } else if (call?.function?.arguments !== undefined) {
          args = call.function.arguments;
        }
        lines.push(
          `- call ${call?.id || "unknown"}: ${name}(${stringifyToolArgs(args)})`,
        );
        if (lines.length >= TOOL_MEMORY_MAX_ITEMS) return lines.join("\n");
      }
    }

    if (msg.role === "tool" || msg.role === "function") {
      const toolName = msg.name || msg.tool_call_id || "tool";
      lines.push(
        `- ${toolName} response: ${summarizeCompactText(extractMessageText(msg.content))}`,
      );
      if (lines.length >= TOOL_MEMORY_MAX_ITEMS) return lines.join("\n");
    }
  }

  return lines.join("\n");
}

function truncateMessageContent(content: any): any {
  if (typeof content === "string") {
    if (content.length <= MAX_SINGLE_MESSAGE_CHARS) return content;
    const keepStart = Math.floor(MAX_SINGLE_MESSAGE_CHARS * 0.7);
    const keepEnd = Math.floor(MAX_SINGLE_MESSAGE_CHARS * 0.25);
    return (
      content.substring(0, keepStart) +
      `\n\n[... truncated ${content.length - keepStart - keepEnd} chars ...]\n\n` +
      content.substring(content.length - keepEnd)
    );
  }
  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (part.text && part.text.length > MAX_SINGLE_MESSAGE_CHARS) {
        const keepStart = Math.floor(MAX_SINGLE_MESSAGE_CHARS * 0.7);
        const keepEnd = Math.floor(MAX_SINGLE_MESSAGE_CHARS * 0.25);
        return {
          ...part,
          text:
            part.text.substring(0, keepStart) +
            `\n\n[... truncated ${part.text.length - keepStart - keepEnd} chars ...]\n\n` +
            part.text.substring(part.text.length - keepEnd),
        };
      }
      return part;
    });
  }
  return content;
}

export function truncateMessages(
  messages: Array<{ role: string; content: any }>,
): Array<{ role: string; content: any }> {
  const truncatedMessages: Array<{ role: string; content: any }> = [];
  const toolMemorySource: Array<any> = [];

  for (const msg of messages) {
    const contentStr = extractMessageText(msg.content);
    if (contentStr.length <= MAX_SINGLE_MESSAGE_CHARS) {
      truncatedMessages.push(msg);
      continue;
    }

    if (
      (msg.role === "assistant" && Array.isArray((msg as any).tool_calls)) ||
      msg.role === "tool" ||
      msg.role === "function"
    ) {
      toolMemorySource.push(msg);
    }

    truncatedMessages.push({
      ...msg,
      content: truncateMessageContent(msg.content),
    });
  }

  const toolMemory = buildToolMemory(toolMemorySource);
  if (!toolMemory) return truncatedMessages;

  return [
    {
      role: "user",
      content: `[Earlier tool memory]\n${toolMemory}`,
    },
    ...truncatedMessages,
  ];
}

function messageToText(msg: { role: string; content: any }): string {
  return `${msg.role}: ${extractMessageText(msg.content)}`;
}

async function deleteQwenChatDirect(
  chatId: string,
  accountId: string,
): Promise<void> {
  try {
    const { headers } = await getQwenHeaders(false, accountId);
    const requestHeaders = buildQwenRequestHeaders({
      cookie: headers["cookie"],
      userAgent: headers["user-agent"],
      bxUa: headers["bx-ua"],
      bxUmidtoken: headers["bx-umidtoken"],
      bxV: headers["bx-v"],
      chatSessionId: chatId,
      extra: { Referer: `${config.qwen.baseUrl}/settings/chats` },
    });
    await fetch(
      `${config.qwen.baseUrl}/api/v2/chats/${encodeURIComponent(chatId)}`,
      { method: "DELETE", headers: requestHeaders },
    );
  } catch {
    // Best-effort cleanup
  }
}

async function createTempChat(
  headers: Record<string, string>,
  model: string,
): Promise<string> {
  const requestHeaders = buildQwenRequestHeaders({
    cookie: headers["cookie"],
    userAgent: headers["user-agent"],
    bxUa: headers["bx-ua"],
    bxUmidtoken: headers["bx-umidtoken"],
    bxV: headers["bx-v"],
    extra: { Referer: `${config.qwen.baseUrl}/c/new-chat` },
  });

  const response = await fetch(`${config.qwen.baseUrl}/api/v2/chats/new`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      title: "Summary",
      models: [model],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp: Date.now(),
      project_id: "",
    }),
  });

  const json = await response.json();
  const chatId = json?.data?.id || json?.data?.chat_id || json?.id;
  if (!chatId) throw new Error("Failed to create temp chat for summarization");
  return chatId;
}

async function sendSummarizationRequest(
  headers: Record<string, string>,
  chatId: string,
  model: string,
  textToSummarize: string,
): Promise<string> {
  const requestHeaders = buildQwenRequestHeaders({
    cookie: headers["cookie"],
    userAgent: headers["user-agent"],
    bxUa: headers["bx-ua"],
    bxUmidtoken: headers["bx-umidtoken"],
    bxV: headers["bx-v"],
    chatSessionId: chatId,
    extra: { "x-accel-buffering": "no" },
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    model: model.replace("-no-thinking", ""),
    parent_id: null,
    messages: [
      {
        fid: uuidv4(),
        parentId: null,
        childrenIds: [],
        role: "user",
        content: `${SUMMARIZE_PROMPT}\n\n${textToSummarize}`,
        user_action: "chat",
        files: [],
        timestamp,
        models: [model.replace("-no-thinking", "")],
        chat_type: "t2t",
        feature_config: {
          thinking_enabled: false,
          output_schema: "phase",
          research_mode: "normal",
          auto_thinking: false,
          thinking_mode: "Thinking",
          thinking_format: "summary",
          auto_search: false,
        },
        extra: { meta: { subChatType: "t2t" } },
        sub_chat_type: "t2t",
      },
    ],
    timestamp,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    SUMMARIZATION_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      `${config.qwen.baseUrl}/api/v2/chat/completions?chat_id=${chatId}`,
      {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Summarization request failed: ${response.status} ${errText.substring(0, 200)}`,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body for summarization");

    const decoder = new TextDecoder();
    let summary = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data);
          const content = event?.choices?.[0]?.delta?.content;
          if (content && event?.choices?.[0]?.delta?.phase === "answer") {
            summary += content;
          }
        } catch {
          // Skip malformed events
        }
      }
    }

    return summary.trim();
  } finally {
    clearTimeout(timeoutId);
  }
}

export function shouldSummarizePayload(
  messages: Array<{ role: string; content: any }>,
): boolean {
  return estimatePayloadChars(messages) > PAYLOAD_SIZE_THRESHOLD;
}

export async function summarizeLargePayload(
  messages: Array<{ role: string; content: any }>,
  model: string,
  excludeAccountId?: string,
): Promise<SummarizeResult | null> {
  const totalChars = estimatePayloadChars(messages);
  if (totalChars <= PAYLOAD_SIZE_THRESHOLD) return null;

  // Keep last 2 messages (recent context), summarize the rest
  const keepCount = Math.min(2, messages.length);
  const oldMessages = messages.slice(0, messages.length - keepCount);

  if (oldMessages.length === 0) return null;

  // Split old messages into chunks
  const chunks: Array<Array<{ role: string; content: any }>> = [];
  for (let i = 0; i < oldMessages.length; i += CHUNK_SIZE) {
    chunks.push(oldMessages.slice(i, i + CHUNK_SIZE));
  }

  // Find available accounts for parallel summarization
  const accounts = loadAccounts();
  const availableAccountIds = accounts
    .filter(
      (acc) => acc.id !== excludeAccountId && !getAccountCooldownInfo(acc.id),
    )
    .map((acc) => acc.id);

  if (availableAccountIds.length === 0) {
    const fallback = accounts.find((acc) => acc.id !== excludeAccountId);
    if (fallback) availableAccountIds.push(fallback.id);
    else if (accounts[0]) availableAccountIds.push(accounts[0].id);
  }

  if (availableAccountIds.length === 0) {
    logger.warn("[Summarizer] No available account for summarization");
    return null;
  }

  logger.warn(
    `[Summarizer] Payload too large (${Math.round(totalChars / 1000)}KB); splitting ${oldMessages.length} messages into ${chunks.length} chunk(s) for parallel summarization`,
  );

  // Summarize chunks in parallel, each on a different account
  const chunkSummaries = await Promise.allSettled(
    chunks.map(async (chunk, index) => {
      const accountId = availableAccountIds[index % availableAccountIds.length];
      let chunkText = chunk.map(messageToText).join("\n\n");

      // Truncate chunk if too large
      if (chunkText.length > MAX_CHUNK_CHARS) {
        chunkText = chunkText.substring(0, MAX_CHUNK_CHARS);
      }

      let chatId: string | null = null;
      try {
        const { headers } = await getQwenHeaders(false, accountId);
        const modelClean = model.replace("-no-thinking", "");

        chatId = await createTempChat(headers, modelClean);
        logger.info(
          `[Summarizer] Chunk ${index + 1}/${chunks.length}: chat ${chatId.substring(0, 8)} on ${accountId.substring(0, 8)}`,
        );

        const summary = await sendSummarizationRequest(
          headers,
          chatId,
          modelClean,
          chunkText,
        );

        if (!summary) {
          logger.warn(`[Summarizer] Chunk ${index + 1}: empty summary`);
          return null;
        }

        logger.info(`[Summarizer] Chunk ${index + 1}: ${summary.length} chars`);
        return summary;
      } catch (err) {
        logger.error(`[Summarizer] Chunk ${index + 1} failed:`, {
          error: (err as Error).message,
        });
        return null;
      } finally {
        if (chatId) {
          void deleteQwenChatDirect(chatId, accountId);
        }
      }
    }),
  );

  // Collect successful summaries
  const summaries = chunkSummaries
    .filter(
      (r): r is PromiseFulfilledResult<string | null> =>
        r.status === "fulfilled" && r.value !== null,
    )
    .map((r) => r.value as string);

  if (summaries.length === 0) {
    logger.warn("[Summarizer] All chunks failed");
    return null;
  }

  // Combine chunk summaries
  const combinedSummary = summaries.join("\n\n---\n\n");

  logger.warn(
    `[Summarizer] Combined ${summaries.length}/${chunks.length} chunk(s): ${combinedSummary.length} chars (from ${totalChars} chars)`,
  );

  return {
    summary: combinedSummary,
    originalChars: totalChars,
    summaryChars: combinedSummary.length,
  };
}

export function rebuildPromptWithSummary(
  systemPrompt: string,
  recentMessages: Array<{ role: string; content: any }>,
  summary: string,
): string {
  // Truncate individual large messages
  const truncatedMessages = truncateMessages(recentMessages);
  const truncatedChars = estimatePayloadChars(truncatedMessages);
  const originalChars = estimatePayloadChars(recentMessages);

  if (truncatedChars < originalChars) {
    logger.warn(
      `[Summarizer] Truncated recent messages: ${originalChars} → ${truncatedChars} chars`,
    );
  }

  const recentText = truncatedMessages.map(messageToText).join("\n\n");

  const parts = [];
  if (systemPrompt) parts.push(systemPrompt);
  parts.push(`[Previous conversation summary]\n${summary}`);
  parts.push(recentText);

  return parts.join("\n\n");
}
