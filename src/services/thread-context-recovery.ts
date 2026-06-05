import { logger } from "../core/logger.ts";
import { fetchQwenChatHistory } from "./qwen.ts";
import {
  getRecentThreadContextTurns,
  insertRecoveredThreadContextTurn,
} from "./thread-context-store.ts";

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function extractTextFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part: any) =>
        firstString(part?.text, part?.content, part?.value, part?.data?.text) ||
        (part && typeof part === "object" ? JSON.stringify(part) : String(part)),
      )
      .join("\n");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
}

function extractHistoryMessages(payload: any): any[] {
  const candidates = [
    payload?.data?.messages,
    payload?.data?.chat?.messages,
    payload?.data?.content_list,
    payload?.data?.items,
    payload?.messages,
    payload?.chat?.messages,
    payload?.content_list,
  ];

  for (const candidate of candidates) {
    const items = asArray(candidate);
    if (items.length > 0) return items;
  }

  return [];
}

function normalizeRole(value: unknown): "user" | "assistant" | null {
  const role = typeof value === "string" ? value.toLowerCase() : "";
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "ai" || role === "bot") {
    return "assistant";
  }
  return null;
}

function extractMessageContent(message: any): string {
  return extractTextFromContent(
    message?.content ??
      message?.text ??
      message?.answer ??
      message?.message ??
      message?.content_list ??
      message?.contents,
  ).trim();
}

export async function recoverThreadContextFromQwenHistory(params: {
  sessionId: string;
  accountId?: string | null;
  chatId?: string | null;
  force?: boolean;
}): Promise<number> {
  if (!params.chatId) return 0;
  if (!params.force && getRecentThreadContextTurns(params.sessionId, 1).length > 0) {
    return 0;
  }

  try {
    const payload = await fetchQwenChatHistory(
      params.chatId,
      params.accountId && params.accountId !== "global"
        ? params.accountId
        : undefined,
    );
    const messages = extractHistoryMessages(payload);
    let recovered = 0;

    for (const message of messages) {
      const role = normalizeRole(message?.role ?? message?.author ?? message?.type);
      if (!role) continue;
      const content = extractMessageContent(message);
      if (!content) continue;

      insertRecoveredThreadContextTurn({
        sessionId: params.sessionId,
        role,
        content,
        qwenAccountId: params.accountId ?? null,
        qwenChatId: params.chatId,
        qwenParentId: firstString(message?.parent_id, message?.parentId),
        qwenResponseId: firstString(
          message?.response_id,
          message?.responseId,
          message?.fid,
          message?.id,
        ),
        metadata: {
          recoveredAt: new Date().toISOString(),
        },
      });
      recovered++;
    }

    if (recovered > 0) {
      logger.info("[thread-context] recovered turns from Qwen history", {
        sessionId: params.sessionId,
        chatId: params.chatId,
        recovered,
      });
    }

    return recovered;
  } catch (error) {
    logger.warn("[thread-context] Qwen history recovery failed", {
      sessionId: params.sessionId,
      chatId: params.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
