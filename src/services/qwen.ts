import crypto from "crypto";
import {
  getQwenHeaders,
  getBasicHeaders,
  isAuthMockEnabled,
} from "./auth-http.ts";
import { v4 as uuidv4 } from "uuid";
import { UpstreamRateLimit, UpstreamError, AuthError } from "../core/errors.js";
import { buildQwenRequestHeaders, QWEN_WEB_VERSION } from "./qwen-headers.ts";
import { config } from "../core/config.js";
import { logger, isToolcallDebugEnabled } from "../core/logger.js";
import { getDatabase } from "../core/database.js";

export class RetryableQwenStreamError extends UpstreamRateLimit {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RetryableQwenStreamError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class QwenUpstreamError extends UpstreamError {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;

  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = "QwenUpstreamError";
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
  }
}

export class QwenSessionExpiredError extends AuthError {
  readonly accountId: string;

  constructor(message: string, accountId: string) {
    super(message);
    this.name = "QwenSessionExpiredError";
    this.accountId = accountId;
  }
}

interface SessionEntry {
  accountId: string;
  parentId: string | null;
  timestamp: number;
}

export interface LogicalThreadEntry {
  accountId: string;
  chatSessionId: string;
  parentId: string | null;
  instructionsSent: boolean;
  timestamp: number;
}

const sessionStates: Map<string, SessionEntry> =
  (globalThis as any)._sessionStates || new Map();
(globalThis as any)._sessionStates = sessionStates;

// In-memory cache for logical thread states (backed by SQLite)
const logicalThreadStates: Map<string, LogicalThreadEntry> =
  (globalThis as any)._logicalThreadStates || new Map();
(globalThis as any)._logicalThreadStates = logicalThreadStates;

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function cleanupStaleSessions() {
  const now = Date.now();
  for (const [key, entry] of sessionStates.entries()) {
    if (now - entry.timestamp > SESSION_TTL_MS) {
      sessionStates.delete(key);
    }
  }
  // Cleanup stale entries from SQLite
  try {
    const db = getDatabase();
    const cutoff = new Date(now - SESSION_TTL_MS).toISOString();
    db.prepare("DELETE FROM logical_thread_states WHERE updated_at < ?").run(
      cutoff,
    );
  } catch {}
  for (const [key, entry] of logicalThreadStates.entries()) {
    if (now - entry.timestamp > SESSION_TTL_MS) {
      logicalThreadStates.delete(key);
    }
  }
}

export function getLogicalThreadState(
  logicalSessionId: string | null | undefined,
): LogicalThreadEntry | null {
  if (!logicalSessionId) return null;

  // Check in-memory cache first
  const cached = logicalThreadStates.get(logicalSessionId);
  if (cached && Date.now() - cached.timestamp <= SESSION_TTL_MS) {
    return cached;
  }
  if (cached) {
    logicalThreadStates.delete(logicalSessionId);
  }

  if (isAuthMockEnabled()) return null;

  // Fallback to SQLite
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT session_id, account_id, chat_session_id, parent_id, instructions_sent, updated_at FROM logical_thread_states WHERE session_id = ?",
      )
      .get(logicalSessionId) as
      | {
          session_id: string;
          account_id: string;
          chat_session_id: string;
          parent_id: string | null;
          instructions_sent: number;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;

    const timestamp = new Date(row.updated_at).getTime();
    if (Date.now() - timestamp > SESSION_TTL_MS) {
      db.prepare("DELETE FROM logical_thread_states WHERE session_id = ?").run(
        logicalSessionId,
      );
      return null;
    }

    const entry: LogicalThreadEntry = {
      accountId: row.account_id,
      chatSessionId: row.chat_session_id,
      parentId: row.parent_id,
      instructionsSent: row.instructions_sent === 1,
      timestamp,
    };

    // Populate in-memory cache
    logicalThreadStates.set(logicalSessionId, entry);
    return entry;
  } catch (err) {
    logger.warn("[Qwen] Failed to read logical thread from SQLite", {
      sessionId: logicalSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function updateLogicalThreadState(
  logicalSessionId: string,
  entry: Omit<LogicalThreadEntry, "timestamp" | "instructionsSent"> & {
    instructionsSent?: boolean;
  },
): void {
  if (
    !logicalSessionId ||
    entry.chatSessionId === undefined ||
    entry.chatSessionId === null
  )
    return;
  if (logicalThreadStates.size > 10000) cleanupStaleSessions();
  const existing = logicalThreadStates.get(logicalSessionId);
  const merged = {
    ...entry,
    instructionsSent:
      entry.instructionsSent ?? existing?.instructionsSent ?? false,
    timestamp: Date.now(),
  };

  // Update in-memory cache
  logicalThreadStates.set(logicalSessionId, merged);

  if (isAuthMockEnabled()) return;

  // Persist to SQLite
  try {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO logical_thread_states (session_id, account_id, chat_session_id, parent_id, instructions_sent, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET
         account_id = excluded.account_id,
         chat_session_id = excluded.chat_session_id,
         parent_id = excluded.parent_id,
         instructions_sent = excluded.instructions_sent,
         updated_at = datetime('now')`,
    ).run(
      logicalSessionId,
      entry.accountId,
      entry.chatSessionId,
      entry.parentId ?? null,
      merged.instructionsSent ? 1 : 0,
    );
  } catch (err) {
    logger.warn("[Qwen] Failed to persist logical thread to SQLite", {
      sessionId: logicalSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function updateLogicalThreadParent(
  logicalSessionId: string | null | undefined,
  parentId: string | null,
  accountId: string,
  chatSessionId: string,
): void {
  if (!logicalSessionId || !chatSessionId) return;
  updateLogicalThreadState(logicalSessionId, {
    accountId,
    chatSessionId,
    parentId,
    instructionsSent: true,
  });
}

export function updateSessionParent(
  sessionId: string,
  parentId: string | null,
  accountId?: string,
) {
  if (!sessionId) return;

  if (sessionStates.size > 10000) {
    cleanupStaleSessions();
  }

  const existing = sessionStates.get(sessionId);
  sessionStates.set(sessionId, {
    accountId: accountId || existing?.accountId || "global",
    parentId,
    timestamp: Date.now(),
  });
}

export function clearAllSessionsForAccount(accountId: string): void {
  let removed = 0;

  for (const [key, entry] of sessionStates.entries()) {
    if (entry.accountId === accountId) {
      sessionStates.delete(key);
      removed++;
    }
  }

  for (const [key, entry] of logicalThreadStates.entries()) {
    if (entry.accountId === accountId) {
      logicalThreadStates.delete(key);
      removed++;
    }
  }

  // Also clear from SQLite
  try {
    const db = getDatabase();
    const result = db
      .prepare("DELETE FROM logical_thread_states WHERE account_id = ?")
      .run(accountId);
    removed += result.changes;
  } catch {}

  console.log(`[Qwen] Cleared ${removed} session(s) for account ${accountId}`);
}

function getSessionParent(
  sessionId: string,
  accountId?: string,
): string | null | undefined {
  const entry = sessionStates.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > SESSION_TTL_MS) {
    sessionStates.delete(sessionId);
    return undefined;
  }
  if (accountId && entry.accountId !== accountId) {
    return undefined;
  }
  return entry.parentId;
}

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: "user" | "assistant";
  content: string;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: {
    thinking_enabled: boolean;
    output_schema: string;
    research_mode: string;
    auto_thinking: boolean;
    thinking_mode: string;
    thinking_format: string;
    auto_search: boolean;
  };
  extra: {
    meta: {
      subChatType: string;
    };
  };
  sub_chat_type: string;
  parent_id: string | null;
}

export interface QwenPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  chat_id: string | null;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
}

interface PublicQwenModel {
  id: string;
  name: string;
  object: "model";
  owned_by: string;
  created: number;
  context_window?: number;
  capabilities?: any;
}

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const modelsCache = new Map<
  string,
  { models: PublicQwenModel[]; fetchedAt: number }
>();

const nativeToolsDisabled = new Set<string>();
const disablingNativeToolsInProgress = new Set<string>();
const lastSyncedPersonalizationHashes = new Map<string, string>();

function shortContentHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function textSize(value: unknown): {
  chars: number | null;
  bytes: number | null;
  hash: string | null;
} {
  if (typeof value !== "string") {
    return { chars: null, bytes: null, hash: null };
  }
  return {
    chars: value.length,
    bytes: Buffer.byteLength(value, "utf8"),
    hash: shortContentHash(value),
  };
}

export async function syncQwenRequestPersonalization(
  instruction: string,
  accountId?: string,
  metadata: {
    model?: string;
    toolsCount?: number;
    sessionId?: string | null;
    promptChars?: number;
  } = {},
): Promise<void> {
  if (isAuthMockEnabled()) return;
  if (!instruction.trim()) return;

  const cacheKey = accountId || "global";
  const { headers } = await getQwenHeaders(false, accountId);
  const requestHeaders = buildQwenRequestHeaders({
    cookie: headers["cookie"],
    userAgent: headers["user-agent"],
    bxUa: headers["bx-ua"],
    bxUmidtoken: headers["bx-umidtoken"],
    bxV: headers["bx-v"],
    extra: {
      Referer: `${config.qwen.baseUrl}/settings/personalization`,
    },
  });

  const payload = {
    personalization: {
      name: "",
      description:
        "Always follow the active personalized instructions. Always think in English, and always answer in the language of the user's question. Always remember and consider the full conversation history and context when responding.",
      style: null,
      instruction,
      enable_for_new_chat: true,
    },
  };

  const sent = textSize(instruction);
  const cachedHash = lastSyncedPersonalizationHashes.get(cacheKey);
  if (sent.hash && cachedHash === sent.hash) {
    console.log(
      `[Qwen] Personalization unchanged | ${metadata.model || "?"} | ${metadata.toolsCount ?? 0} tool(s) | ${sent.chars} chars`,
    );
    logger.debug("[Qwen] personalization sync skipped from cache", {
      accountId: cacheKey,
      model: metadata.model || null,
      tools: metadata.toolsCount ?? 0,
      promptChars: metadata.promptChars ?? null,
      sessionId: metadata.sessionId ?? null,
      sent,
    });
    return;
  }

  let existing = { chars: null, bytes: null, hash: null } as ReturnType<
    typeof textSize
  >;
  if (sent.hash && !cachedHash && config.qwen.personalizationVerifyGet) {
    try {
      const existingResponse = await fetch(
        `${config.qwen.baseUrl}/api/v2/users/user/settings`,
        {
          method: "GET",
          headers: requestHeaders,
        },
      );
      const existingRaw = await existingResponse.text();
      let existingJson: any = null;
      try {
        existingJson = existingRaw ? JSON.parse(existingRaw) : null;
      } catch {
        existingJson = null;
      }
      existing = textSize(existingJson?.data?.personalization?.instruction);
      if (existing.hash === sent.hash) {
        lastSyncedPersonalizationHashes.set(cacheKey, sent.hash);
        console.log(
          `[Qwen] Personalization unchanged | ${metadata.model || "?"} | ${metadata.toolsCount ?? 0} tool(s) | ${sent.chars} chars | verified=true`,
        );
        logger.debug("[Qwen] personalization sync skipped after GET", {
          accountId: cacheKey,
          model: metadata.model || null,
          tools: metadata.toolsCount ?? 0,
          promptChars: metadata.promptChars ?? null,
          sessionId: metadata.sessionId ?? null,
          sent,
          existing,
        });
        return;
      }
    } catch (err) {
      logger.debug("[Qwen] personalization pre-check failed; updating anyway", {
        accountId: cacheKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const response = await fetch(
    `${config.qwen.baseUrl}/api/v2/users/user/settings/update`,
    {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(payload),
    },
  );
  const raw = await response.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  if (!response.ok || json?.success === false) {
    console.warn(
      `[Qwen] Personalization sync failed | account=${cacheKey} | status=${response.status} | sent=${sent.chars} chars/${sent.bytes} bytes | response=${raw.slice(0, 240)}`,
    );
    throw new QwenUpstreamError(
      `Qwen personalization update failed: ${response.status} ${raw.slice(0, 300)}`,
      "PersonalizationUpdateFailed",
      response.status >= 500 ? 502 : response.status,
    );
  }

  const returnedInstruction = json?.data?.personalization?.instruction;
  const returned = textSize(returnedInstruction);
  let stored = { chars: null, bytes: null, hash: null } as ReturnType<
    typeof textSize
  >;

  if (config.qwen.personalizationVerifyGet) {
    const verifyResponse = await fetch(
      `${config.qwen.baseUrl}/api/v2/users/user/settings`,
      {
        method: "GET",
        headers: requestHeaders,
      },
    );
    const verifyRaw = await verifyResponse.text();
    let verifyJson: any = null;
    try {
      verifyJson = verifyRaw ? JSON.parse(verifyRaw) : null;
    } catch {
      verifyJson = null;
    }
    stored = textSize(verifyJson?.data?.personalization?.instruction);
  }

  const matchReturned = returned.hash !== null && returned.hash === sent.hash;
  const matchStored = stored.hash === null ? null : stored.hash === sent.hash;
  if (sent.hash && (matchReturned || matchStored === true)) {
    lastSyncedPersonalizationHashes.set(cacheKey, sent.hash);
  }
  console.log(
    `[Qwen] Personalization synced | ${metadata.model || "?"} | ${metadata.toolsCount ?? 0} tool(s) | ${sent.chars} chars${matchStored === null ? "" : ` | verified=${matchStored}`}`,
  );
  logger.debug("[Qwen] personalization sync details", {
    accountId: cacheKey,
    model: metadata.model || null,
    tools: metadata.toolsCount ?? 0,
    promptChars: metadata.promptChars ?? null,
    sessionId: metadata.sessionId ?? null,
    sent,
    returned,
    existing,
    stored,
    matchReturned,
    matchStored,
  });
}

const DISABLE_TOOLS_TIMEOUT_MS = 15000;
const DISABLE_TOOLS_MAX_RETRIES = 3;
const DISABLE_TOOLS_BACKOFF_MS = 2000;

export async function disableNativeTools(accountId?: string): Promise<void> {
  const cacheKey = accountId || "global";
  if (
    nativeToolsDisabled.has(cacheKey) ||
    disablingNativeToolsInProgress.has(cacheKey)
  ) {
    return;
  }
  disablingNativeToolsInProgress.add(cacheKey);

  try {
    const { headers } = await getQwenHeaders(false, accountId);

    const payload = {
      tools_enabled: {
        web_extractor: false,
        web_search_image: false,
        web_search: false,
        image_gen_tool: false,
        code_interpreter: false,
        history_retriever: false,
        image_edit_tool: false,
        bio: false,
        image_zoom_in_tool: false,
      },
    };

    const requestHeaders = buildQwenRequestHeaders({
      cookie: headers["cookie"],
      userAgent: headers["user-agent"],
      bxUa: headers["bx-ua"],
      bxUmidtoken: headers["bx-umidtoken"],
      bxV: headers["bx-v"],
    });

    let lastError: string | null = null;
    for (let attempt = 1; attempt <= DISABLE_TOOLS_MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        DISABLE_TOOLS_TIMEOUT_MS,
      );
      try {
        const response = await fetch(
          `${config.qwen.baseUrl}/api/v2/users/user/settings/update`,
          {
            method: "POST",
            headers: requestHeaders,
            body: JSON.stringify(payload),
            signal: controller.signal,
          },
        );
        clearTimeout(timeoutId);

        if (!response.ok) {
          const text = await response.text();
          lastError = `${response.status} - ${text}`;
          console.warn(
            `[Qwen] Failed to disable native tools for ${cacheKey} (attempt ${attempt}/${DISABLE_TOOLS_MAX_RETRIES}): ${lastError}`,
          );
        } else {
          console.log(
            `[Qwen] Native tools disabled successfully for ${cacheKey}.`,
          );
          nativeToolsDisabled.add(cacheKey);
          return;
        }
      } catch (err: any) {
        clearTimeout(timeoutId);
        lastError = err.message;
        console.warn(
          `[Qwen] Error disabling native tools for ${cacheKey} (attempt ${attempt}/${DISABLE_TOOLS_MAX_RETRIES}): ${lastError}`,
        );
      }

      if (attempt < DISABLE_TOOLS_MAX_RETRIES) {
        const backoff = DISABLE_TOOLS_BACKOFF_MS * attempt;
        console.log(`[Qwen] Retrying disable native tools in ${backoff}ms...`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    console.error(
      `[Qwen] Failed to disable native tools for ${cacheKey} after ${DISABLE_TOOLS_MAX_RETRIES} attempts. Last error: ${lastError}`,
    );
  } finally {
    disablingNativeToolsInProgress.delete(cacheKey);
  }
}

function formatPublicQwenModel(
  model: any,
  noThinking = false,
): PublicQwenModel {
  return {
    id: noThinking ? `${model.id}-no-thinking` : model.id,
    name: noThinking ? `${model.name} (No Thinking)` : model.name,
    object: "model",
    owned_by: model.owned_by || "qwen",
    created: model.info?.created_at || Date.now(),
    context_window: model.info?.meta?.max_context_length,
    capabilities: model.info?.meta?.capabilities,
  };
}

export async function deleteAllQwenChats(accountId?: string): Promise<boolean> {
  const { headers } = await getQwenHeaders(false, accountId);
  const response = await fetch(`${config.qwen.baseUrl}/api/v2/chats/`, {
    method: "DELETE",
    headers: buildQwenRequestHeaders({
      cookie: headers["cookie"],
      userAgent: headers["user-agent"],
      bxUa: headers["bx-ua"],
      bxUmidtoken: headers["bx-umidtoken"],
      bxV: headers["bx-v"],
      extra: {
        Referer: `${config.qwen.baseUrl}/settings/chats`,
        source: "web",
        timezone: new Date().toString().split(" (")[0],
        version: QWEN_WEB_VERSION,
      },
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Failed to delete chats from Qwen: ${response.status} ${raw.substring(0, 200)}`,
    );
  }

  const parsed = raw ? JSON.parse(raw) : null;
  const success = parsed?.success === true && parsed?.data?.status === true;
  if (!success) {
    throw new Error(
      `Qwen delete chats returned unexpected payload: ${raw.substring(0, 200)}`,
    );
  }

  clearAllSessionsForAccount(accountId || "global");
  return true;
}

export async function deleteQwenChat(
  chatId: string,
  accountId?: string,
): Promise<boolean> {
  if (!chatId) return false;
  const { headers } = await getQwenHeaders(false, accountId);
  const response = await fetch(
    `${config.qwen.baseUrl}/api/v2/chats/${encodeURIComponent(chatId)}`,
    {
      method: "DELETE",
      headers: buildQwenRequestHeaders({
        cookie: headers["cookie"],
        userAgent: headers["user-agent"],
        bxUa: headers["bx-ua"],
        bxUmidtoken: headers["bx-umidtoken"],
        bxV: headers["bx-v"],
        extra: {
          Referer: `${config.qwen.baseUrl}/settings/chats`,
          source: "web",
          timezone: new Date().toString().split(" (")[0],
          version: QWEN_WEB_VERSION,
        },
      }),
    },
  );

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Failed to delete Qwen chat ${chatId}: ${response.status} ${raw.substring(0, 200)}`,
    );
  }

  const parsed = raw ? JSON.parse(raw) : null;
  const success = parsed?.success === true && parsed?.data?.status === true;
  if (!success) {
    throw new Error(
      `Qwen delete chat returned unexpected payload: ${raw.substring(0, 200)}`,
    );
  }

  return true;
}

export async function fetchQwenChatHistory(
  chatId: string,
  accountId?: string,
): Promise<any> {
  if (!chatId) return null;
  const { headers } = await getQwenHeaders(false, accountId);
  const response = await fetch(
    `${config.qwen.baseUrl}/api/v2/chats/${encodeURIComponent(chatId)}`,
    {
      method: "GET",
      headers: buildQwenRequestHeaders({
        cookie: headers["cookie"],
        userAgent: headers["user-agent"],
        bxUa: headers["bx-ua"],
        bxUmidtoken: headers["bx-umidtoken"],
        bxV: headers["bx-v"],
        chatSessionId: chatId,
        extra: {
          Referer: `${config.qwen.baseUrl}/c/${chatId}`,
          source: "web",
          timezone: new Date().toString().split(" (")[0],
          version: QWEN_WEB_VERSION,
        },
      }),
    },
  );

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Qwen chat ${chatId}: ${response.status} ${raw.substring(0, 200)}`,
    );
  }
  return raw ? JSON.parse(raw) : null;
}

export async function fetchQwenModels(
  accountId?: string,
): Promise<PublicQwenModel[]> {
  const cacheKey = accountId || "global";
  const now = Date.now();
  const cached = modelsCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    return cached.models;
  }

  const { cookie, userAgent, bxV, bxUa, bxUmidtoken } =
    await getBasicHeaders(accountId);

  const response = await fetch(`${config.qwen.baseUrl}/api/models`, {
    headers: buildQwenRequestHeaders({
      cookie,
      userAgent,
      bxV,
      bxUa,
      bxUmidtoken,
      extra: {
        timezone: new Date().toString(),
        source: "web",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models from Qwen: ${response.status} ${response.statusText}`,
    );
  }

  const json = await response.json();
  if (json.data && Array.isArray(json.data)) {
    const models = json.data.flatMap((model: any) => [
      formatPublicQwenModel(model),
      formatPublicQwenModel(model, true),
    ]);

    modelsCache.set(cacheKey, { models, fetchedAt: now });
    return models;
  }

  return [];
}

export interface QwenFileEntry {
  type: string;
  file: any;
  id: string;
  url: string;
  name: string;
  [key: string]: any;
}

async function createQwenChatSession(
  headers: Record<string, string>,
  model: string,
): Promise<string> {
  if (isAuthMockEnabled()) {
    return process.env.TEST_SESSION_ID || "mock-session";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeouts.http);

  try {
    const response = await fetch(`${config.qwen.baseUrl}/api/v2/chats/new`, {
      method: "POST",
      headers: buildQwenRequestHeaders({
        cookie: headers["cookie"],
        userAgent: headers["user-agent"],
        bxUa: headers["bx-ua"],
        bxUmidtoken: headers["bx-umidtoken"],
        bxV: headers["bx-v"],
        extra: {
          Referer: `${config.qwen.baseUrl}/c/new-chat`,
          timezone: new Date().toString().split(" (")[0],
          source: "web",
          version: QWEN_WEB_VERSION,
        },
      }),
      body: JSON.stringify({
        title: "Nova Conversa",
        models: [model],
        chat_mode: "normal",
        chat_type: "t2t",
        timestamp: Date.now(),
        project_id: "",
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new QwenUpstreamError(
        `Qwen create chat failed: ${response.status} ${response.statusText} - ${raw.substring(0, 300)}`,
        "CreateChatFailed",
        response.status >= 500 ? 502 : response.status,
      );
    }

    const json = raw ? JSON.parse(raw) : null;
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
  } finally {
    clearTimeout(timeoutId);
  }
}

const precreatedChatSessions = new Map<string, string[]>();
const precreatingChatSessions = new Set<string>();

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

async function acquireNewQwenChatSession(
  headers: Record<string, string>,
  model: string,
  accountId?: string,
): Promise<string> {
  if (isQwenChatPoolEnabled()) {
    const key = chatPoolKey(accountId, model);
    const pooled = precreatedChatSessions.get(key);
    const chatId = pooled?.shift();

    if (chatId) {
      logger.debug("[Qwen] using pooled chat", {
        accountId: accountId || "global",
        model,
        chatId,
      });
      void scheduleQwenChatPoolRefill(headers, model, accountId);
      return chatId;
    }
  }

  const created = await createQwenChatSession(headers, model);
  logger.debug("[Qwen] created fresh chat", {
    accountId: accountId || "global",
    model,
    chatId: created,
  });
  if (isQwenChatPoolEnabled()) {
    void scheduleQwenChatPoolRefill(headers, model, accountId);
  }
  return created;
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
    while ((precreatedChatSessions.get(key)?.length ?? 0) < targetSize) {
      const chatId = await createQwenChatSession(headers, model);
      const current = precreatedChatSessions.get(key) ?? [];
      current.push(chatId);
      precreatedChatSessions.set(key, current);
    }
  } catch (err) {
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
    modelId.replace("-no-thinking", ""),
    accountId,
  );
}

function isQwenChatNotExistMessage(details: string): boolean {
  return (
    details.includes("is not exist") ||
    details.includes("not exist") ||
    details.includes("does not exist")
  );
}

function isQwenQuotaLimitMessage(details: string): boolean {
  const normalized = details.toLowerCase();
  return (
    normalized.includes("allocated quota exceeded") ||
    normalized.includes("quota exceeded") ||
    normalized.includes("increase your quota") ||
    normalized.includes("token-limit") ||
    normalized.includes("insufficient quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("ratelimited")
  );
}

function parseQwenJsonError(
  raw: string,
  status: number,
  accountId?: string,
): Error | null {
  const errorJson = JSON.parse(raw);
  const details =
    errorJson?.data?.details ||
    errorJson?.message ||
    errorJson?.error?.message ||
    "Qwen returned an error";

  if (typeof details === "string" && isQwenChatNotExistMessage(details)) {
    const attempt = errorJson?.data?.retryCount ?? 1;
    const retryAfterMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
    return new RetryableQwenStreamError(`Qwen: ${details}`, retryAfterMs);
  }

  if (
    typeof details === "string" &&
    (details.includes("chat is in progress") ||
      details.includes("The chat is in progress"))
  ) {
    const attempt = errorJson?.data?.retryCount ?? 1;
    const baseDelay = 2000;
    const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, 30000);
    const jitter = cappedDelay * 0.2 * Math.random();
    const retryAfterMs = Math.floor(cappedDelay + jitter);
    return new RetryableQwenStreamError(`Qwen: ${details}`, retryAfterMs);
  }

  if (errorJson?.success === false) {
    const code = errorJson.data?.code || errorJson.code || "UpstreamError";

    if (
      status === 401 ||
      code === "Unauthorized" ||
      (typeof details === "string" &&
        (details.includes("login") || details.includes("session")))
    ) {
      return new QwenSessionExpiredError(
        `Session expired: ${details}`,
        accountId || "global",
      );
    }

    const wait =
      errorJson.data?.num !== undefined
        ? ` Wait about ${errorJson.data.num} hour(s) before trying again.`
        : "";
    const message = `Qwen upstream error: ${code}: ${details}.${wait}`;

    if (
      code === "RateLimited" ||
      status === 429 ||
      (typeof details === "string" && isQwenQuotaLimitMessage(details))
    ) {
      return new UpstreamRateLimit(message);
    }

    const upstreamStatus = code === "Not_Found" ? 404 : 502;
    return new QwenUpstreamError(message, code, upstreamStatus);
  }

  if (errorJson?.error) {
    const message =
      typeof errorJson.error === "string"
        ? errorJson.error
        : errorJson.error.message || JSON.stringify(errorJson.error);
    if (isQwenQuotaLimitMessage(message)) {
      return new UpstreamRateLimit(`Qwen upstream error: ${message}`);
    }

    return new QwenUpstreamError(
      `Qwen upstream error: ${message}`,
      "UpstreamError",
      502,
    );
  }

  return null;
}

export async function createQwenStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId?: string | null,
  accountId?: string,
  files?: QwenFileEntry[],
  options?: {
    chatSessionId?: string | null;
    forceNewChat?: boolean;
  },
): Promise<{
  stream: ReadableStream;
  headers: Record<string, string>;
  uiSessionId: string;
  controller: AbortController;
  accountId: string;
  createdNewChat: boolean;
}> {
  // A new logical chat session should reuse the warmed header cache when available.
  // Header recapture is much more expensive and should be reserved for real refresh/login cases,
  // not for ordinary first prompts that simply need parent_id reset.
  const captured = await getQwenHeaders(
    options?.forceNewChat === true,
    accountId,
  );
  const { headers, parentMessageId } = captured;
  const model = modelId.replace("-no-thinking", "");
  let createdNewChat = false;
  let chatSessionId: string | null | undefined;
  if (options && "chatSessionId" in options) {
    if (options.chatSessionId === null || options.chatSessionId === "") {
      chatSessionId = await acquireNewQwenChatSession(
        headers,
        model,
        accountId,
      );
      createdNewChat = true;
    } else {
      chatSessionId = options.chatSessionId;
    }
  } else {
    chatSessionId = captured.chatSessionId;
    if (!chatSessionId) {
      chatSessionId = await acquireNewQwenChatSession(
        headers,
        model,
        accountId,
      );
      createdNewChat = true;
    }
  }

  const withCreatedChatMetadata = <T extends Error>(error: T): T => {
    if (createdNewChat && chatSessionId) {
      (error as any).createdNewChat = true;
      (error as any).chatSessionId = chatSessionId;
      (error as any).accountId = accountId ?? "global";
    }
    return error;
  };

  let actualParentId: string | null = parentMessageId;

  if (forcedParentId !== undefined) {
    actualParentId = forcedParentId;
    if (chatSessionId && forcedParentId === null) {
      updateSessionParent(chatSessionId, null, accountId ?? "global");
    }
  } else if (chatSessionId) {
    const storedParent = getSessionParent(chatSessionId, accountId ?? "global");
    if (storedParent !== undefined) {
      actualParentId = storedParent;
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const fid = uuidv4();

  const payload: QwenPayload = {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chat_id: chatSessionId || null,
    chat_mode: "normal",
    model: model,
    parent_id: actualParentId,
    messages: [
      {
        fid: fid,
        parentId: actualParentId,
        childrenIds: [],
        role: "user",
        content: prompt,
        user_action: "chat",
        files: files || [],
        timestamp: timestamp,
        models: [model],
        chat_type: "t2t",
        feature_config: {
          thinking_enabled: enableThinking,
          output_schema: "phase",
          research_mode: "normal",
          auto_thinking: false,
          thinking_mode: "Thinking",
          thinking_format: "summary",
          auto_search: false,
        },
        extra: {
          meta: {
            subChatType: "t2t",
          },
        },
        sub_chat_type: "t2t",
        parent_id: actualParentId,
      },
    ],
    timestamp: timestamp + 1,
  };

  const contentSize = textSize(prompt);
  const contentPreview = prompt.replace(/\s+/g, " ").trim().slice(0, 160);
  logger.debug("[Qwen] chat payload", {
    accountId: accountId ?? "global",
    model,
    chatId: chatSessionId || "new",
    parentId: actualParentId || null,
    content: contentSize,
    preview: contentPreview,
  });

  const url = chatSessionId
    ? `${config.qwen.baseUrl}/api/v2/chat/completions?chat_id=${chatSessionId}`
    : `${config.qwen.baseUrl}/api/v2/chat/completions`;

  const controller = new AbortController();
  const timeoutMs =
    enableThinking || modelId.includes("thinking")
      ? config.timeouts.reasoningModelTimeout
      : config.timeouts.totalRequestTimeout;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildQwenRequestHeaders({
        cookie: headers["cookie"],
        userAgent: headers["user-agent"],
        bxUa: headers["bx-ua"],
        bxUmidtoken: headers["bx-umidtoken"],
        bxV: headers["bx-v"],
        chatSessionId,
        extra: {
          Accept: "application/json",
          timezone: new Date().toString().split(" (")[0],
          "x-accel-buffering": "no",
        },
      }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    throw withCreatedChatMetadata(
      error instanceof Error ? error : new Error(String(error)),
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const responseContentType = response.headers.get("content-type") || "";
  if (response.ok && responseContentType.includes("application/json")) {
    const errText = await response.text().catch(() => "");
    throw withCreatedChatMetadata(
      parseQwenJsonError(errText, response.status, accountId) ??
        new QwenUpstreamError(
          `Qwen returned non-stream JSON response: ${errText.substring(0, 300)}`,
          "NonStreamJsonResponse",
          502,
        ),
    );
  }

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => "");
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      try {
        const parsedError = parseQwenJsonError(
          errText,
          response.status,
          accountId,
        );
        if (parsedError) {
          throw withCreatedChatMetadata(parsedError);
        }
      } catch (parseOrRetryError) {
        if (
          parseOrRetryError instanceof RetryableQwenStreamError ||
          parseOrRetryError instanceof QwenUpstreamError ||
          parseOrRetryError instanceof QwenSessionExpiredError
        ) {
          throw withCreatedChatMetadata(parseOrRetryError);
        }
        // Log unexpected parsing or retry errors to prevent silent failures
        logger.warn("Unexpected error during stream error parsing", {
          error: parseOrRetryError,
        });
      }
    }
    throw withCreatedChatMetadata(
      new Error(
        `Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${errText}`,
      ),
    );
  }

  return {
    stream: response.body,
    headers,
    uiSessionId: chatSessionId || "",
    controller,
    accountId: accountId ?? "global",
    createdNewChat,
  };
}
