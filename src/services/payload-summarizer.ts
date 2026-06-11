/**
 * Payload summarizer for large requests.
 *
 * When the total payload exceeds a threshold, this module:
 * 1. Splits messages into old (to summarize) and recent (to keep)
 * 2. Creates a temporary Qwen chat on a different account
 * 3. Sends old messages for summarization
 * 4. Returns the summary text
 * 5. Deletes the temporary chat
 */

import { config } from "../core/config.ts";
import { logger } from "../core/logger.ts";
import { getQwenHeaders } from "./auth-playwright.ts";
import { buildQwenRequestHeaders } from "./qwen-headers.ts";
import { v4 as uuidv4 } from "uuid";
import { loadAccounts } from "../core/accounts.ts";
import { getAccountCooldownInfo } from "../core/account-manager.ts";

const PAYLOAD_SIZE_THRESHOLD = 500_000; // 500KB
const SUMMARIZATION_TIMEOUT_MS = 60_000;

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

function findAvailableAccountId(excludeAccountId?: string): string | null {
  const accounts = loadAccounts();
  for (const account of accounts) {
    if (account.id === excludeAccountId) continue;
    const cooldown = getAccountCooldownInfo(account.id);
    if (!cooldown) return account.id;
  }
  // Fall back to any account including excluded
  for (const account of accounts) {
    const cooldown = getAccountCooldownInfo(account.id);
    if (!cooldown) return account.id;
  }
  return accounts[0]?.id ?? null;
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

    // Read SSE stream and extract text
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
  const recentMessages = messages.slice(messages.length - keepCount);

  if (oldMessages.length === 0) return null;

  // Build text from old messages
  const oldText = oldMessages
    .map((msg) => {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .map((p: any) => p.text || JSON.stringify(p))
                .join("\n")
            : JSON.stringify(msg.content);
      return `${msg.role}: ${content}`;
    })
    .join("\n\n");

  // Find a different account for summarization
  const summarizeAccountId = findAvailableAccountId(excludeAccountId);
  if (!summarizeAccountId) {
    logger.warn("[Summarizer] No available account for summarization");
    return null;
  }

  logger.warn(
    `[Summarizer] Payload too large (${Math.round(totalChars / 1000)}KB); summarizing ${oldMessages.length} old messages on account ${summarizeAccountId.substring(0, 8)}...`,
  );

  let chatId: string | null = null;
  try {
    const { headers } = await getQwenHeaders(false, summarizeAccountId);
    const modelClean = model.replace("-no-thinking", "");

    chatId = await createTempChat(headers, modelClean);
    logger.info(`[Summarizer] Temp chat created: ${chatId}`);

    const summary = await sendSummarizationRequest(
      headers,
      chatId,
      modelClean,
      oldText,
    );

    if (!summary) {
      logger.warn("[Summarizer] Empty summary returned");
      return null;
    }

    logger.info(
      `[Summarizer] Summary: ${summary.length} chars (from ${oldText.length} chars)`,
    );

    return {
      summary,
      originalChars: totalChars,
      summaryChars: summary.length,
    };
  } catch (err) {
    logger.error("[Summarizer] Failed:", {
      error: (err as Error).message,
    });
    return null;
  } finally {
    if (chatId) {
      void deleteQwenChatDirect(chatId, summarizeAccountId);
    }
  }
}

export function rebuildPromptWithSummary(
  systemPrompt: string,
  recentMessages: Array<{ role: string; content: any }>,
  summary: string,
): string {
  const recentText = recentMessages
    .map((msg) => {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .map((p: any) => p.text || JSON.stringify(p))
                .join("\n")
            : JSON.stringify(msg.content);
      return `${msg.role}: ${content}`;
    })
    .join("\n\n");

  const parts = [];
  if (systemPrompt) parts.push(systemPrompt);
  parts.push(`[Previous conversation summary]\n${summary}`);
  parts.push(recentText);

  return parts.join("\n\n");
}
