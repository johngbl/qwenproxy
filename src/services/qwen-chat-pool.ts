import crypto from "crypto";
import { getQwenHeaders, isAuthMockEnabled } from "./auth-playwright.ts";
import { config, type ChatMode } from "../core/config.ts";
import { logger, isToolcallDebugEnabled } from "../core/logger.ts";
import {
  computeQuotaCooldownMs,
  markAccountRateLimited,
} from "../core/account-manager.ts";
import { mapClientModelToQwen } from "../core/model-alias.ts";
import { qwenUrl } from "./qwen-url.ts";
import { QwenUpstreamError } from "./qwen-errors.ts";
import {
  requestQwenTextInBrowser,
  buildCapturedQwenHeaders,
  readJsonTextResponse,
} from "./qwen.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function createQwenChatSession(
  headers: Record<string, string>,
  model: string,
  accountId?: string,
  chatMode: ChatMode = "thread",
): Promise<string> {
  if (isAuthMockEnabled()) {
    return process.env.TEST_SESSION_ID || "mock-session";
  }

  const response = await requestQwenTextInBrowser(
    accountId,
    "POST",
    "/api/v2/chats/new",
    buildCapturedQwenHeaders(headers, {
      referer: qwenUrl("/"),
    }),
    JSON.stringify(buildChatNewBody(model, chatMode)),
    { referrer: qwenUrl("/") },
  );

  const { raw, json } = await readJsonTextResponse(response, {
    strict: true,
  });
  if (!response.ok) {
    throw new QwenUpstreamError(
      `Qwen create chat failed: ${response.status} ${response.statusText} - ${raw.substring(0, 300)}`,
      "CreateChatFailed",
      response.status >= 500 ? 502 : response.status,
    );
  }

  const chatId =
    json?.chat_id ||
    json?.id ||
    json?.data?.chat_id ||
    json?.data?.id ||
    json?.data?.chat?.id;

  if (!chatId || typeof chatId !== "string") {
    throw new QwenUpstreamError(
      `Qwen create chat returned unexpected payload: ${raw.substring(0, 300)}`,
      "CreateChatInvalidResponse",
      502,
    );
  }

  return chatId;
}

/**
 * Body for POST /api/v2/chats/new, matching the real web client exactly
 * (verified in HAR): chatId:"" instead of a title. The API then defaults the
 * list title to "New chat", which isReusableUnusedChatTitle accepts so the
 * warm pool can still find and recycle the chat.
 */
export function buildChatNewBody(
  model: string,
  chatMode: ChatMode = "thread",
): Record<string, unknown> {
  return {
    chatId: "",
    models: [model],
    project_id: "",
    timestamp: Date.now(),
    chat_type: "t2t",
    // thread → normal (persisted), temp → local (ephemeral, not listed).
    chat_mode: chatMode === "temp" ? "local" : "normal",
  };
}

/**
 * True when a chat is an API-default-titled, never-messaged chat that the
 * warm pool may recycle. Both defaults exist in practice: chats created by
 * this project (title:"Nova Conversa") and chats created by the web client
 * without a title (API default "New chat").
 */
export function isReusableUnusedChatTitle(
  title: unknown,
): title is string {
  return title === "Nova Conversa" || title === "New chat";
}

/**
 * Fetch existing unused chats from the Qwen API.
 * Unused chats keep their API-default title ("Nova Conversa" or "New chat")
 * and created_at === updated_at.
 */
async function fetchUnusedChats(
  headers: Record<string, string>,
  accountId?: string,
): Promise<string[]> {
  try {
    const response = await requestQwenTextInBrowser(
      accountId,
      "GET",
      "/api/v2/chats/?page=1&exclude_project=true",
      buildCapturedQwenHeaders(headers, {
        extra: {
          accept: "application/json, text/plain, */*",
          "x-request-id": crypto.randomUUID(),
          source: "web",
        },
      }),
      undefined,
      { referrer: qwenUrl("/settings/chats") },
    );

    if (!response.ok) return [];

    const json: any = await response.json().catch(() => null);
    if (!json?.success || !Array.isArray(json.data)) return [];

    const unused: string[] = [];
    for (const chat of json.data) {
      if (
        isReusableUnusedChatTitle(chat.title) &&
        chat.created_at === chat.updated_at
      ) {
        unused.push(chat.id);
      }
    }
    return unused;
  } catch {
    return [];
  }
}

const precreatedChatSessions = new Map<string, string[]>();
const precreatingChatSessions = new Set<string>();
const inFlightWarmChats = new Set<string>();
const WARM_POOL_LOW_WATER = 3;

function warmChatKey(
  accountId: string | undefined,
  model: string,
  chatId: string,
) {
  return `${accountId || "global"}:${model}:${chatId}`;
}

function markWarmChatInFlight(
  accountId: string | undefined,
  model: string,
  chatId: string,
): void {
  inFlightWarmChats.add(warmChatKey(accountId, model, chatId));
}

export function releaseWarmChat(
  accountId: string | undefined,
  model: string,
  chatId: string,
): void {
  inFlightWarmChats.delete(warmChatKey(accountId, model, chatId));
}

function isWarmChatInFlight(
  accountId: string | undefined,
  model: string,
  chatId: string,
): boolean {
  return inFlightWarmChats.has(warmChatKey(accountId, model, chatId));
}

function chatPoolKey(accountId: string | undefined, model: string): string {
  return `${accountId || "global"}:${model}`;
}

function isQwenChatPoolEnabled(): boolean {
  return (
    config.qwen.chatPoolSize > 0 &&
    !isAuthMockEnabled() &&
    !config.qwen.personalizationFromRequest
  );
}

export async function acquireNewQwenChatSession(
  headers: Record<string, string>,
  model: string,
  accountId?: string,
  chatMode: ChatMode = "thread",
): Promise<{ chatId: string; leasedFromPool: boolean }> {
  if (isQwenChatPoolEnabled() && chatMode !== "temp") {
    const key = chatPoolKey(accountId, model);
    const pooled = precreatedChatSessions.get(key);
    const chatId = pooled?.shift();

    if (chatId) {
      logger.debug("[Qwen] using pooled chat", {
        accountId: accountId || "global",
        model,
        chatId,
      });

      // Proactive refill when pool drops below low-water mark
      markWarmChatInFlight(accountId, model, chatId);

      if (
        (pooled?.length ?? 0) < WARM_POOL_LOW_WATER &&
        !precreatingChatSessions.has(key)
      ) {
        void refillQwenChatPool(headers, model, accountId);
      } else {
        void scheduleQwenChatPoolRefill(headers, model, accountId);
      }
      return { chatId, leasedFromPool: true };
    }
  }

  const created = await createQwenChatSession(headers, model, accountId, chatMode);
  logger.debug("[Qwen] created fresh chat", {
    accountId: accountId || "global",
    model,
    chatId: created,
  });
  if (isQwenChatPoolEnabled() && chatMode !== "temp") {
    void scheduleQwenChatPoolRefill(headers, model, accountId);
  }
  return { chatId: created, leasedFromPool: false };
}

async function refillQwenChatPool(
  headers: Record<string, string>,
  model: string,
  accountId?: string,
): Promise<void> {
  if (!isQwenChatPoolEnabled()) return;
  const targetSize = config.qwen.chatPoolSize;

  const key = chatPoolKey(accountId, model);
  const pooled = precreatedChatSessions.get(key) ?? [];
  if (pooled.length >= targetSize || precreatingChatSessions.has(key)) return;

  precreatingChatSessions.add(key);
  try {
    // Reuse existing unused chats before creating new ones
    const existingIds = new Set(precreatedChatSessions.get(key) ?? []);
    let reused = 0;
    try {
      const unusedChats = await fetchUnusedChats(headers, accountId);
      for (const chatId of unusedChats) {
        if ((precreatedChatSessions.get(key)?.length ?? 0) >= targetSize) break;
        if (existingIds.has(chatId)) continue;
        if (isWarmChatInFlight(accountId, model, chatId)) continue;
        const current = precreatedChatSessions.get(key) ?? [];
        current.push(chatId);
        precreatedChatSessions.set(key, current);
        existingIds.add(chatId);
        reused++;
      }
      if (reused > 0) {
        console.log(
          `[WarmPool] Reused ${reused} existing unused chats for ${accountId || "global"}`,
        );
      }
    } catch (err: any) {
      console.warn(
        `[WarmPool] Failed to fetch unused chats for ${accountId || "global"}:`,
        err.message,
      );
    }

    // Create remaining chats needed
    let isFirst = true;
    while ((precreatedChatSessions.get(key)?.length ?? 0) < targetSize) {
      if (!isFirst) {
        // Reduced delay for faster warm pool filling (upstream: 3806cf6)
        await sleep(300 + Math.floor(Math.random() * 700));
      }
      isFirst = false;
      const chatId = await createQwenChatSession(headers, model, accountId);
      const current = precreatedChatSessions.get(key) ?? [];
      current.push(chatId);
      precreatedChatSessions.set(key, current);
    }
  } catch (err: any) {
    // Mark account as rate-limited if chat creation fails with RateLimited error
    if (err instanceof QwenUpstreamError) {
      if (err.upstreamCode === "RateLimited" || err.upstreamStatus === 429) {
        // Daily quota resets at the next UTC midnight — never the literal
        // "Wait about N hour(s)" hint (near midnight it over-blocks by ~22h).
        markAccountRateLimited(
          accountId || "global",
          computeQuotaCooldownMs(Date.now()),
          "RateLimited",
        );
        console.warn(
          `[WarmPool] Account ${accountId || "global"} rate-limited during chat creation. Marked for cooldown.`,
        );
      }
    }
    if (isToolcallDebugEnabled()) {
      logger.debug("[Qwen] Failed to refill chat pool", {
        accountId: accountId || "global",
        model,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    precreatingChatSessions.delete(key);
  }
}

function scheduleQwenChatPoolRefill(
  headers: Record<string, string>,
  model: string,
  accountId?: string,
): void {
  setTimeout(() => {
    void refillQwenChatPool(headers, model, accountId);
  }, 250);
}

export async function warmQwenChatPool(
  accountId: string | undefined,
  modelId: string,
): Promise<void> {
  if (!isQwenChatPoolEnabled()) return;
  const { headers } = await getQwenHeaders(false, accountId);
  await refillQwenChatPool(
    headers,
    mapClientModelToQwen(modelId),
    accountId,
  );
}
