import crypto from "crypto";
import {
  getQwenHeaders,
  getBasicHeaders,
  isAuthMockEnabled,
  isTokenExpiringSoon,
} from "./auth-playwright.ts";
import { v4 as uuidv4 } from "uuid";
import { UpstreamRateLimit, UpstreamError, AuthError } from "../core/errors.ts";
import { buildQwenRequestHeaders, QWEN_WEB_VERSION } from "./qwen-headers.ts";
import { config } from "../core/config.ts";
import { logger, isToolcallDebugEnabled } from "../core/logger.ts";
import { estimateTokenCount } from "../utils/context-truncation.ts";
import type {
  PersonalizationEstimationInfo,
  TokenEstimationContext,
} from "./token-estimation-metrics.ts";
import { getDatabase } from "../core/database.ts";
import { markAccountRateLimited } from "../core/account-manager.ts";
import {
  MAX_PAYLOAD_SIZE,
  syncModelMetadata,
} from "../core/model-registry.ts";
import { withAccountPage } from "./playwright.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function addIdleTimeoutToStream(
  stream: ReadableStream<Uint8Array>,
  controller: AbortController,
  idleTimeoutMs: number,
  label: string,
  onTimeout?: () => void,
  onDone?: () => void,
): ReadableStream<Uint8Array> {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const resetIdleTimer = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      const message = `${label} idle timeout after ${idleTimeoutMs}ms without upstream data`;
      clearIdleTimer();
      controller.abort();
      onTimeout?.();
      try {
        void stream.cancel(message).catch(() => {});
      } catch {}
    }, idleTimeoutMs);
  };

  return new ReadableStream<Uint8Array>({
    start() {
      reader = stream.getReader();
      resetIdleTimer();
    },
    async pull(streamController) {
      try {
        if (!reader) throw new Error("Stream reader was not initialized");
        const { done, value } = await reader.read();
        if (done) {
          clearIdleTimer();
          onDone?.();
          streamController.close();
          return;
        }
        resetIdleTimer();
        streamController.enqueue(value);
      } catch (error) {
        clearIdleTimer();
        onDone?.();
        streamController.error(error);
      }
    },
    cancel(reason) {
      clearIdleTimer();
      onDone?.();
      return reader ? reader.cancel(reason) : stream.cancel(reason);
    },
  });
}

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

export class QwenUpstreamUnavailableError extends RetryableQwenStreamError {
  readonly httpStatusCode: number;

  constructor(message: string, httpStatusCode: number) {
    super(message, 5000);
    this.name = "QwenUpstreamUnavailableError";
    this.httpStatusCode = httpStatusCode;
  }
}

export class QwenNetworkError extends RetryableQwenStreamError {
  constructor(message: string) {
    super(message, 3000);
    this.name = "QwenNetworkError";
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
  } catch (error) {
    logger.warn("Failed to clean up stale logical thread states", { error });
  }
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

  console.log(
    `🧹 [Qwen] Cleared ${removed} session(s) for account ${accountId}`,
  );
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
  id: string | null;
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: string;
  content: string;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  model: string;
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
  stream_options?: { include_usage: boolean };
  chatId?: string | null;
  chat_id: string | null;
  parentId?: string;
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
const activePersonalizationByAccount = new Map<
  string,
  PersonalizationEstimationInfo
>();

function getPersonalizationHashFromDb(accountId: string): string | null {
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT instruction_hash FROM personalization_cache WHERE account_id = ?",
      )
      .get(accountId) as { instruction_hash: string } | undefined;
    return row?.instruction_hash ?? null;
  } catch {
    return null;
  }
}

function setPersonalizationHashInDb(accountId: string, hash: string): void {
  try {
    const db = getDatabase();
    db.prepare(
      `
      INSERT INTO personalization_cache (account_id, instruction_hash, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(account_id) DO UPDATE SET instruction_hash = excluded.instruction_hash, updated_at = excluded.updated_at
    `,
    ).run(accountId, hash);
  } catch (err) {
    console.error(
      `[Qwen] Failed to persist personalization hash for ${accountId}:`,
      (err as Error).message,
    );
  }
}

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

function rememberActivePersonalization(
  accountId: string,
  instruction: string,
  metadata: {
    model?: string;
    toolsCount?: number;
  },
  source: PersonalizationEstimationInfo["source"],
): void {
  const size = textSize(instruction);
  if (size.chars === null || size.bytes === null || !size.hash) return;

  activePersonalizationByAccount.set(accountId, {
    accountId,
    model: metadata.model ?? null,
    toolCount: metadata.toolsCount ?? 0,
    chars: size.chars,
    bytes: size.bytes,
    hash: size.hash,
    estimatedTokens: estimateTokenCount(instruction),
    source,
    updatedAt: Date.now(),
  });
}

function getActivePersonalizationInfo(
  accountId: string,
): PersonalizationEstimationInfo | null {
  return activePersonalizationByAccount.get(accountId) ?? null;
}

function buildCapturedQwenHeaders(
  headers: Record<string, string>,
  options: {
    chatSessionId?: string | null;
    referer?: string;
    extra?: Record<string, string>;
  } = {},
): Record<string, string> {
  return buildQwenRequestHeaders({
    cookie: headers["cookie"],
    userAgent: headers["user-agent"],
    bxUa: headers["bx-ua"],
    bxUmidtoken: headers["bx-umidtoken"],
    bxV: headers["bx-v"],
    chatSessionId: options.chatSessionId,
    extra: {
      ...(options.referer ? { Referer: options.referer } : {}),
      ...(options.extra || {}),
    },
  });
}

const QWEN_SAFE_SETTINGS_PATCH = {
  ui: {
    autoTags: false,
    largeTextAsFile: false,
    splitLargeChunks: false,
  },
  mcp_remind: false,
  memory: {
    enable_memory: false,
    enable_history_memory: false,
    memory_version_reminder: false,
  },
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
} as const;

const QWEN_SAFE_SETTINGS_HASH = crypto
  .createHash("sha256")
  .update(JSON.stringify(QWEN_SAFE_SETTINGS_PATCH))
  .digest("hex")
  .slice(0, 12);

function buildQwenSettingsUpdatePayload(
  currentSettings: any,
  instruction: string,
): Record<string, unknown> {
  return {
    ...(currentSettings && typeof currentSettings === "object"
      ? currentSettings
      : {}),
    ui: {
      ...(currentSettings?.ui && typeof currentSettings.ui === "object"
        ? currentSettings.ui
        : {}),
      ...QWEN_SAFE_SETTINGS_PATCH.ui,
    },
    mcp_remind: QWEN_SAFE_SETTINGS_PATCH.mcp_remind,
    memory: {
      ...(currentSettings?.memory && typeof currentSettings.memory === "object"
        ? currentSettings.memory
        : {}),
      ...QWEN_SAFE_SETTINGS_PATCH.memory,
    },
    tools_enabled: {
      ...(currentSettings?.tools_enabled &&
      typeof currentSettings.tools_enabled === "object"
        ? currentSettings.tools_enabled
        : {}),
      ...QWEN_SAFE_SETTINGS_PATCH.tools_enabled,
    },
    personalization: {
      ...(currentSettings?.personalization &&
      typeof currentSettings.personalization === "object"
        ? currentSettings.personalization
        : {}),
      name: "",
      description:
        "Always follow the active personalized instructions. Always think in English, and always answer in the language of the user's question. Always remember and consider the full conversation history and context when responding.",
      style: null,
      instruction,
      enable_for_new_chat: true,
    },
  };
}

async function readJsonTextResponse(
  response: Response,
  options: { strict?: boolean } = {},
): Promise<{ raw: string; json: any }> {
  const raw = await response.text();
  if (!raw) {
    return { raw, json: null };
  }

  try {
    return { raw, json: JSON.parse(raw) };
  } catch (error) {
    if (options.strict) {
      throw error;
    }
    return { raw, json: null };
  }
}

export async function syncQwenRequestPersonalization(
  instruction: string,
  accountId?: string,
  metadata: {
    model?: string;
    toolsCount?: number;
    sessionId?: string | null;
    promptChars?: number;
    /** Bypass memory/DB/GET caches and always POST. Used on new chat creation. */
    forceSync?: boolean;
  } = {},
): Promise<boolean> {
  if (isAuthMockEnabled()) return true;
  // instruction pode ser vazia para limpar personalization

  const cacheKey = accountId || "global";

  // Proactive token renewal: refresh BEFORE attempting personalization
  // to avoid 401 errors that waste time on retry
  let forceRefresh = false;
  try {
    const basic = await getBasicHeaders(accountId);
    if (isTokenExpiringSoon(basic.cookie, 5)) {
      logger.debug("[Qwen] Token expiring soon, refreshing proactively", {
        accountId: cacheKey,
      });
      forceRefresh = true;
    }
  } catch {
    // If we can't check, let the normal flow handle it
  }

  const { headers } = await getQwenHeaders(forceRefresh, accountId);
  const requestHeaders = buildCapturedQwenHeaders(headers, {
    referer: `${config.qwen.baseUrl}/settings/personalization`,
  });

  let currentSettings: any = null;
  let payload = buildQwenSettingsUpdatePayload(currentSettings, instruction);

  const sent = textSize(instruction);
  const syncHash = sent.hash ? `${sent.hash}:${QWEN_SAFE_SETTINGS_HASH}` : null;
  const bypassCache = metadata.forceSync === true;

  // 1. Check memory cache (skipped on forceSync)
  const cachedHash = lastSyncedPersonalizationHashes.get(cacheKey);
  if (!bypassCache && syncHash && cachedHash === syncHash) {
    rememberActivePersonalization(cacheKey, instruction, metadata, "memory");
    // Personalization unchanged - no log needed
    return true;
  }

  // 2. Check DB cache (survives restarts) (skipped on forceSync)
  if (!bypassCache && syncHash && !cachedHash) {
    const dbHash = getPersonalizationHashFromDb(cacheKey);
    if (dbHash === syncHash) {
      lastSyncedPersonalizationHashes.set(cacheKey, syncHash);
      rememberActivePersonalization(cacheKey, instruction, metadata, "db");
      // Personalization unchanged (DB) - no log needed
      return true;
    }
  }

  let existing = { chars: null, bytes: null, hash: null } as ReturnType<
    typeof textSize
  >;
  // Verifica GET apenas se temos um hash válido (skipped on forceSync)
  if (!bypassCache && syncHash && !cachedHash && config.qwen.personalizationVerifyGet) {
    try {
      const existingResponse = await fetch(
        `${config.qwen.baseUrl}/api/v2/users/user/settings`,
        {
          method: "GET",
          headers: requestHeaders,
        },
      );
      const { json: existingJson } =
        await readJsonTextResponse(existingResponse);
      currentSettings = existingJson?.data ?? null;
      payload = buildQwenSettingsUpdatePayload(currentSettings, instruction);
      existing = textSize(existingJson?.data?.personalization?.instruction);
      const existingSafeSettingsApplied =
        existingJson?.data?.ui?.largeTextAsFile === false &&
        existingJson?.data?.ui?.splitLargeChunks === false &&
        existingJson?.data?.ui?.autoTags === false &&
        existingJson?.data?.mcp_remind === false &&
        existingJson?.data?.memory?.enable_memory === false &&
        existingJson?.data?.memory?.enable_history_memory === false &&
        existingJson?.data?.tools_enabled?.web_search === false &&
        existingJson?.data?.tools_enabled?.code_interpreter === false;
      if (existing.hash === sent.hash && existingSafeSettingsApplied) {
        lastSyncedPersonalizationHashes.set(cacheKey, syncHash);
        setPersonalizationHashInDb(cacheKey, syncHash);
        rememberActivePersonalization(
          cacheKey,
          instruction,
          metadata,
          "verified",
        );
        // Personalization unchanged (verified) - no log needed
        logger.debug("[Qwen] personalization sync skipped after GET", {
          accountId: cacheKey,
          model: metadata.model || null,
          tools: metadata.toolsCount ?? 0,
          promptChars: metadata.promptChars ?? null,
          sessionId: metadata.sessionId ?? null,
          sent,
          existing,
        });
        return true;
      }
    } catch (err) {
      logger.debug("[Qwen] personalization pre-check failed; updating anyway", {
        accountId: cacheKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Helper: attempt the POST, returns { raw, json } or throws on non-retriable errors
  async function attemptPost(
    headers: Record<string, string>,
  ): Promise<{ raw: string; json: any }> {
    if (!currentSettings) {
      try {
        const settingsResponse = await fetch(
          `${config.qwen.baseUrl}/api/v2/users/user/settings`,
          {
            method: "GET",
            headers: buildCapturedQwenHeaders(headers, {
              referer: `${config.qwen.baseUrl}/settings/personalization`,
            }),
          },
        );
        const { json: settingsJson } =
          await readJsonTextResponse(settingsResponse);
        currentSettings = settingsJson?.data ?? null;
        payload = buildQwenSettingsUpdatePayload(currentSettings, instruction);
      } catch (err) {
        logger.debug(
          "[Qwen] settings GET before update failed; using safe partial payload",
          {
            accountId: cacheKey,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    const reqHeaders = buildCapturedQwenHeaders(headers, {
      referer: `${config.qwen.baseUrl}/settings/personalization`,
    });
    const resp = await fetch(
      `${config.qwen.baseUrl}/api/v2/users/user/settings/update`,
      {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify(payload),
      },
    );
    return readJsonTextResponse(resp);
  }

  let raw: string;
  let json: any;

  // Layer 1: First attempt
  ({ raw, json } = await attemptPost(headers));

  // Layer 2: On 401/Unauthorized → refresh session and retry once
  const isUnauthorized =
    json?.success === false &&
    (json?.data?.code === "Unauthorized" ||
      json?.data?.code === "unauthorized" ||
      (typeof json?.data?.details === "string" &&
        json.data.details.includes("401")));

  if (isUnauthorized) {
    console.warn(
      `[Qwen] Personalization 401 — refreshing session and retrying | account=${cacheKey}`,
    );
    try {
      const { headers: freshHeaders } = await getQwenHeaders(true, accountId);
      ({ raw, json } = await attemptPost(freshHeaders));
    } catch (retryErr) {
      // Layer 3: Retry failed → non-fatal, continue without personalization
      console.warn(
        `[Qwen] Personalization retry failed, continuing without it | account=${cacheKey} | error=${(retryErr as Error).message?.substring(0, 150)}`,
      );
      return false;
    }
  }

  // Layer 3: Check final result — non-fatal on failure
  if (json?.success === false) {
    console.warn(
      `[Qwen] Personalization sync failed (non-fatal) | account=${cacheKey} | response=${raw.slice(0, 200)}`,
    );
    return false;
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
    const { json: verifyJson } = await readJsonTextResponse(verifyResponse);
    stored = textSize(verifyJson?.data?.personalization?.instruction);
  }

  const matchReturned = returned.hash !== null && returned.hash === sent.hash;
  const matchStored = stored.hash === null ? null : stored.hash === sent.hash;
  const applied = matchReturned || matchStored === true;
  if (syncHash && applied) {
    lastSyncedPersonalizationHashes.set(cacheKey, syncHash);
    setPersonalizationHashInDb(cacheKey, syncHash);
    rememberActivePersonalization(cacheKey, instruction, metadata, "synced");
  }

  if (!applied) {
    logger.warn("[Qwen] personalization response did not confirm the requested instructions", {
      accountId: cacheKey,
      model: metadata.model || null,
      tools: metadata.toolsCount ?? 0,
      sent,
      returned,
      stored,
    });
    return false;
  }

  console.log(
    `✅ [Qwen] Personalization synced | ${metadata.model || "?"} | ${metadata.toolsCount ?? 0} tool(s) | ${sent.chars} chars${metadata.sessionId ? ` | chat=${metadata.sessionId.substring(0, 12)}` : ""}${matchStored === null ? "" : ` | verified=${matchStored}`}`,
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
  return true;
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

    const requestHeaders = buildCapturedQwenHeaders(headers);

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
            `⚠️  [Qwen] Failed to disable native tools for ${cacheKey} (attempt ${attempt}/${DISABLE_TOOLS_MAX_RETRIES}): ${lastError}`,
          );
        } else {
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
        console.log(
          `🔄 [Qwen] Retrying disable native tools in ${backoff}ms...`,
        );
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
    headers: buildCapturedQwenHeaders(headers, {
      referer: `${config.qwen.baseUrl}/settings/chats`,
    }),
  });

  const { raw, json: parsed } = await readJsonTextResponse(response, {
    strict: true,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to delete chats from Qwen: ${response.status} ${raw.substring(0, 200)}`,
    );
  }

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
      headers: buildCapturedQwenHeaders(headers, {
        referer: `${config.qwen.baseUrl}/settings/chats`,
      }),
    },
  );

  const { raw, json: parsed } = await readJsonTextResponse(response, {
    strict: true,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to delete Qwen chat ${chatId}: ${response.status} ${raw.substring(0, 200)}`,
    );
  }

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
      headers: buildCapturedQwenHeaders(headers, {
        chatSessionId: chatId,
        referer: `${config.qwen.baseUrl}/c/${chatId}`,
      }),
    },
  );

  const { raw, json } = await readJsonTextResponse(response, { strict: true });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Qwen chat ${chatId}: ${response.status} ${raw.substring(0, 200)}`,
    );
  }
  return json;
}

export async function fetchQwenModels(
  accountId?: string,
): Promise<PublicQwenModel[]> {
  const cacheKey = accountId || "global";
  const now = Date.now();
  const cached = modelsCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    syncModelMetadata(
      cached.models as unknown as Array<Record<string, unknown> & { id: string }>,
    );
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

    syncModelMetadata(models as unknown as Array<Record<string, unknown> & { id: string }>);
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
      headers: buildCapturedQwenHeaders(headers, {
        referer: `${config.qwen.baseUrl}/c/new-chat`,
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
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch existing unused chats from the Qwen API.
 * Unused chats have title "Nova Conversa" and created_at === updated_at.
 */
async function fetchUnusedChats(
  headers: Record<string, string>,
): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      config.timeouts.http,
    );

    const response = await fetch(
      `${config.qwen.baseUrl}/api/v2/chats/?page=1&exclude_project=true`,
      {
        method: "GET",
        headers: buildCapturedQwenHeaders(headers, {
          extra: {
            accept: "application/json, text/plain, */*",
            "x-request-id": crypto.randomUUID(),
            source: "web",
          },
        }),
        signal: controller.signal,
      },
    );

    clearTimeout(timeoutId);

    if (!response.ok) return [];

    const json: any = await response.json().catch(() => null);
    if (!json?.success || !Array.isArray(json.data)) return [];

    const unused: string[] = [];
    for (const chat of json.data) {
      if (
        chat.title === "Nova Conversa" &&
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

function releaseWarmChat(
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

async function acquireNewQwenChatSession(
  headers: Record<string, string>,
  model: string,
  accountId?: string,
): Promise<{ chatId: string; leasedFromPool: boolean }> {
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

  const created = await createQwenChatSession(headers, model);
  logger.debug("[Qwen] created fresh chat", {
    accountId: accountId || "global",
    model,
    chatId: created,
  });
  if (isQwenChatPoolEnabled()) {
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
      const unusedChats = await fetchUnusedChats(headers);
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
      const chatId = await createQwenChatSession(headers, model);
      const current = precreatedChatSessions.get(key) ?? [];
      current.push(chatId);
      precreatedChatSessions.set(key, current);
    }
  } catch (err: any) {
    // Mark account as rate-limited if chat creation fails with RateLimited error
    if (err instanceof QwenUpstreamError) {
      if (err.upstreamCode === "RateLimited" || err.upstreamStatus === 429) {
        const hourHint = err.message?.match(/Wait about (\d+) hour/);
        const cooldownMs = hourHint
          ? parseInt(hourHint[1]) * 60 * 60 * 1000
          : undefined;
        markAccountRateLimited(
          accountId || "global",
          cooldownMs,
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
  let errorJson: any;
  try {
    errorJson = JSON.parse(raw);
  } catch {
    return null;
  }

  // Helper: exponential backoff with jitter, capped by config
  const antiBotDelay = (attempt: number) => {
    const base = config.antiBot.baseDelayMs;
    const max = config.antiBot.maxDelayMs;
    const exp = Math.min(base * Math.pow(2, attempt - 1), max);
    const jitter = exp * 0.3 * Math.random();
    return Math.floor(exp + jitter);
  };

  const retryDelay = (attempt: number) => {
    const base = config.retry.baseDelayMs;
    const max = config.retry.maxDelayMs;
    const exp = Math.min(base * Math.pow(2, attempt - 1), max);
    const jitter = exp * 0.3 * Math.random();
    return Math.floor(exp + jitter);
  };

  // Anti-bot detection: {ret: ["FAIL_SYS_USER_VALIDATE", ...]} format
  const retArray: string[] | undefined = errorJson?.ret;
  if (Array.isArray(retArray)) {
    const retStr = retArray.join(",");
    if (
      retStr.includes("FAIL_SYS_USER_VALIDATE") ||
      retStr.includes("RGV587_ERROR")
    ) {
      const attempt = errorJson?.data?.retryCount ?? 1;
      return new RetryableQwenStreamError(
        `Qwen anti-bot: ${retStr.substring(0, 200)}`,
        antiBotDelay(attempt),
      );
    }
  }

  const details =
    errorJson?.data?.details ||
    errorJson?.message ||
    errorJson?.error?.message ||
    "Qwen returned an error";

  if (typeof details === "string" && isQwenChatNotExistMessage(details)) {
    const attempt = errorJson?.data?.retryCount ?? 1;
    return new RetryableQwenStreamError(
      `Qwen: ${details}`,
      retryDelay(attempt),
    );
  }

  // Anti-bot detection: FAIL_SYS_USER_VALIDATE / RGV587_ERROR
  if (
    typeof details === "string" &&
    (details.includes("FAIL_SYS_USER_VALIDATE") ||
      details.includes("RGV587_ERROR") ||
      details.includes("user validate"))
  ) {
    const attempt = errorJson?.data?.retryCount ?? 1;
    return new RetryableQwenStreamError(
      `Qwen anti-bot: ${details}`,
      antiBotDelay(attempt),
    );
  }

  if (
    typeof details === "string" &&
    (details.includes("chat is in progress") ||
      details.includes("The chat is in progress"))
  ) {
    const attempt = errorJson?.data?.retryCount ?? 1;
    return new RetryableQwenStreamError(
      `Qwen: ${details}`,
      retryDelay(attempt),
    );
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

const UPSTREAM_RESPONSE_PREVIEW_BYTES = 8 * 1024;

function isHtmlResponseContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("text/html") ||
    normalized.includes("application/xhtml+xml")
  );
}

function isHtmlResponseBody(value: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html\b)/i.test(value);
}

function isWafChallengeResponse(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("aliyun_waf") ||
    normalized.includes("_____tmd_____") ||
    normalized.includes("fail_sys_user_validate") ||
    normalized.includes("rgv587_error") ||
    normalized.includes("denyfromx5") ||
    normalized.includes("captcha") ||
    normalized.includes("security verification")
  );
}

async function readResponsePreview(
  response: Response,
  maxBytes = UPSTREAM_RESPONSE_PREVIEW_BYTES,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytesRead = 0;

  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const chunk = Buffer.from(value);
      const remaining = maxBytes - bytesRead;
      if (chunk.byteLength > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytesRead += remaining;
        break;
      }
      chunks.push(chunk);
      bytesRead += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks).toString("utf8");
}

interface BrowserCompletionResponse {
  status: number;
  contentType: string;
  stream: ReadableStream<Uint8Array>;
}

type BrowserRelayEvent =
  | { type: "headers"; status: number; contentType: string }
  | { type: "chunk"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

interface BrowserResponseMetadata {
  status: number;
  contentType: string;
}

const MAX_BROWSER_STREAM_QUEUE_BYTES = 512 * 1024;
const BROWSER_STREAM_HEADER_TIMEOUT_MS = 60_000;

/**
 * Aliyun sometimes challenges the Node fetch while allowing the same request
 * from the already-authenticated Qwen page. Use that browser session as a
 * fallback instead of exposing the challenge HTML or immediately rotating an
 * otherwise healthy account.
 *
 * The browser request is relayed incrementally through an exposed Playwright
 * function. The previous implementation awaited response.text(), which held
 * the Playwright page operation until the whole generation completed and could
 * buffer a very large answer. This bridge keeps SSE streaming, applies a
 * bounded queue for backpressure, and connects request cancellation to the
 * browser-side AbortController.
 */
async function fetchCompletionInBrowser(
  accountId: string,
  url: string,
  payloadJson: string,
  headers: Record<string, string>,
  timeoutMs: number,
  requestController: AbortController,
): Promise<BrowserCompletionResponse> {
  const origin = new URL(config.qwen.baseUrl).origin;
  const relayName = `__qwenBridgeRelay_${uuidv4().replace(/-/g, "")}`;
  const controllerKey = `__qwenBridgeController_${uuidv4().replace(/-/g, "")}`;
  const encoder = new TextEncoder();

  let bindingRegistered = false;
  let relayBinding: { dispose: () => Promise<void> } | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let abortPromise: Promise<void> | null = null;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  let pendingPullResolve: (() => void) | null = null;
  let queuedChunks: Uint8Array[] = [];
  let queuedBytes = 0;
  let terminalKind: "done" | "error" | null = null;
  let terminalError: Error | null = null;
  const capacityWaiters: Array<() => void> = [];

  let headersReceived = false;
  let resolveHeaders!: (metadata: BrowserResponseMetadata) => void;
  let rejectHeaders!: (error: Error) => void;
  const headersPromise = new Promise<BrowserResponseMetadata>(
    (resolve, reject) => {
      resolveHeaders = resolve;
      rejectHeaders = reject;
    },
  );
  // The Playwright page may be unavailable before the callback starts waiting
  // for response headers. Keep that setup-failure rejection observed while the
  // real await below still receives the original rejection.
  void headersPromise.catch(() => {});

  const notifyCapacity = () => {
    if (
      terminalKind ||
      queuedBytes < MAX_BROWSER_STREAM_QUEUE_BYTES
    ) {
      while (capacityWaiters.length > 0) {
        capacityWaiters.shift()?.();
      }
    }
  };

  const closeStreamIfReady = () => {
    if (!streamController || queuedChunks.length > 0 || !terminalKind) {
      return;
    }

    try {
      // Before response headers arrive the stream is never returned to the
      // caller. Close it instead of rejecting an internal pending pull, which
      // would otherwise surface as an unhandled rejection in WAF fallback
      // paths where Playwright is unavailable.
      if (terminalKind === "error" && headersReceived) {
        streamController.error(
          terminalError ?? new Error("Browser completion stream failed"),
        );
      } else {
        streamController.close();
      }
    } catch {
      // The consumer may have cancelled the stream concurrently.
    }

    const resolvePull = pendingPullResolve;
    pendingPullResolve = null;
    resolvePull?.();
  };

  const finishStream = (kind: "done" | "error", error?: Error) => {
    if (terminalKind) return;
    terminalKind = kind;
    terminalError = error ?? null;
    if (kind === "error") {
      queuedChunks = [];
      queuedBytes = 0;
    }
    notifyCapacity();
    closeStreamIfReady();
  };

  const deliverChunk = async (text: string): Promise<void> => {
    if (terminalKind || !text) return;
    const chunk = encoder.encode(text);

    while (
      !terminalKind &&
      queuedBytes > 0 &&
      queuedBytes + chunk.byteLength > MAX_BROWSER_STREAM_QUEUE_BYTES
    ) {
      await new Promise<void>((resolve) => capacityWaiters.push(resolve));
    }
    if (terminalKind) return;

    if (pendingPullResolve && streamController) {
      streamController.enqueue(chunk);
      const resolvePull = pendingPullResolve;
      pendingPullResolve = null;
      resolvePull();
      return;
    }

    queuedChunks.push(chunk);
    queuedBytes += chunk.byteLength;
  };

  const relayEvent = async (event: BrowserRelayEvent): Promise<void> => {
    if (!event || typeof event.type !== "string") return;

    if (event.type === "headers") {
      if (
        !headersReceived &&
        Number.isFinite(event.status) &&
        typeof event.contentType === "string"
      ) {
        headersReceived = true;
        resolveHeaders({
          status: event.status,
          contentType: event.contentType,
        });
      }
      return;
    }

    if (event.type === "chunk") {
      await deliverChunk(typeof event.text === "string" ? event.text : "");
      return;
    }

    if (event.type === "error") {
      const error = new Error(
        typeof event.message === "string"
          ? event.message
          : "Browser completion request failed",
      );
      if (!headersReceived) rejectHeaders(error);
      finishStream("error", error);
      void cleanupRelay();
      return;
    }

    if (event.type === "done") {
      if (!headersReceived) {
        const error = new Error(
          "Browser completion ended before returning response headers",
        );
        rejectHeaders(error);
        finishStream("error", error);
        void cleanupRelay();
        return;
      }
      finishStream("done");
      void cleanupRelay();
    }
  };

  const abortBrowserRequest = (): Promise<void> => {
    if (abortPromise) return abortPromise;
    abortPromise = (async () => {
      try {
        await withAccountPage(
          accountId,
          (page) =>
            page.evaluate((key) => {
              const win = window as unknown as Record<string, unknown>;
              const controller = win[key] as AbortController | undefined;
              controller?.abort();
            }, controllerKey),
          5_000,
          5_000,
        );
      } catch {
        // The page may already have been reset or closed.
      }
    })();
    return abortPromise;
  };

  const cleanupRelay = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      requestController.signal.removeEventListener(
        "abort",
        onRequestAbort,
      );
      if (!bindingRegistered) return;

      try {
        await withAccountPage(
          accountId,
          async (page) => {
            await page
              .evaluate((key) => {
                const win = window as unknown as Record<string, unknown>;
                delete win[key];
              }, controllerKey)
              .catch(() => {});
            const binding = relayBinding;
            relayBinding = null;
            await binding?.dispose().catch(() => {});
          },
          5_000,
          5_000,
        );
      } catch {
        // Cleanup is best effort when the account context is being reset.
      }
    })();
    return cleanupPromise;
  };

  const onRequestAbort = () => {
    finishStream("error", new Error("Browser completion request aborted"));
    void abortBrowserRequest().finally(() => cleanupRelay());
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    pull(controller) {
      if (queuedChunks.length > 0) {
        const chunk = queuedChunks.shift();
        if (!chunk) return;
        queuedBytes -= chunk.byteLength;
        controller.enqueue(chunk);
        notifyCapacity();
        closeStreamIfReady();
        return;
      }

      if (terminalKind) {
        closeStreamIfReady();
        return;
      }

      return new Promise<void>((resolve) => {
        pendingPullResolve = resolve;
      });
    },
    cancel(reason) {
      if (!terminalKind) {
        finishStream(
          "error",
          new Error(
            reason ? `Browser completion cancelled: ${String(reason)}` : "Browser completion cancelled",
          ),
        );
      }
      queuedChunks = [];
      queuedBytes = 0;
      notifyCapacity();
      return abortBrowserRequest().finally(() => cleanupRelay());
    },
  });

  requestController.signal.addEventListener("abort", onRequestAbort, {
    once: true,
  });

  const setupTimeoutMs = Math.min(
    Math.max(5_000, timeoutMs),
    BROWSER_STREAM_HEADER_TIMEOUT_MS,
  );

  try {
    const metadata = await withAccountPage(
      accountId,
      async (page) => {
        let pageOrigin = "";
        let pageUrl = "";
        try {
          pageUrl = page.url();
          pageOrigin = new URL(pageUrl).origin;
        } catch {
          // Navigate below when the page has no usable origin.
        }

        const pageNeedsNavigation =
          pageOrigin !== origin ||
          /_____tmd_____|\/bx\/|punish|x5secdata/i.test(pageUrl);
        if (pageNeedsNavigation) {
          await page.goto(`${config.qwen.baseUrl}/`, {
            waitUntil: "domcontentloaded",
            timeout: Math.min(config.timeouts.navigation, 15_000),
          });
        }

        relayBinding = await page.exposeFunction(relayName, relayEvent);
        bindingRegistered = true;
        if (requestController.signal.aborted) {
          throw new Error("Browser completion request aborted");
        }

        const started = await page.evaluate(
          ({
            url,
            payload,
            bxUa,
            bxUmidtoken,
            bxV,
            requestId,
            controllerKey,
            relayName,
            version,
          }) => {
            const win = window as unknown as Record<string, unknown>;
            const relay = win[relayName] as
              | ((event: BrowserRelayEvent) => Promise<void>)
              | undefined;
            if (!relay) return false;

            const browserController = new AbortController();
            win[controllerKey] = browserController;

            void (async () => {
              try {
                const response = await fetch(url, {
                  method: "POST",
                  credentials: "include",
                  headers: {
                    Accept: "text/event-stream",
                    "Content-Type": "application/json",
                    "X-Request-Id": requestId,
                    "x-accel-buffering": "no",
                    "bx-v": bxV || "2.5.36",
                    ...(bxUa ? { "bx-ua": bxUa } : {}),
                    ...(bxUmidtoken ? { "bx-umidtoken": bxUmidtoken } : {}),
                    source: "web",
                    version,
                  },
                  body: payload,
                  signal: browserController.signal,
                });
                await relay({
                  type: "headers",
                  status: response.status,
                  contentType: response.headers.get("content-type") || "",
                });

                if (!response.body) {
                  throw new Error("Browser completion returned an empty body");
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const text = decoder.decode(value, { stream: true });
                  if (text) await relay({ type: "chunk", text });
                }
                const tail = decoder.decode();
                if (tail) await relay({ type: "chunk", text: tail });
                await relay({ type: "done" });
              } catch (error) {
                await relay({
                  type: "error",
                  message:
                    error instanceof Error
                      ? error.message
                      : String(error),
                }).catch(() => {});
              } finally {
                delete win[controllerKey];
              }
            })();

            return true;
          },
          {
            url,
            payload: payloadJson,
            bxUa: headers["bx-ua"] || "",
            bxUmidtoken: headers["bx-umidtoken"] || "",
            bxV: headers["bx-v"] || "2.5.36",
            requestId: uuidv4(),
            controllerKey,
            relayName,
            version: QWEN_WEB_VERSION,
          },
        );

        if (!started) {
          throw new Error("Browser completion relay failed to start");
        }

        return headersPromise;
      },
      setupTimeoutMs,
      setupTimeoutMs,
    );

    return {
      status: metadata.status,
      contentType: metadata.contentType,
      stream,
    };
  } catch (error) {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    if (!headersReceived) rejectHeaders(normalizedError);
    finishStream("error", normalizedError);
    await abortBrowserRequest();
    await cleanupRelay();
    throw normalizedError;
  }
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
  tokenEstimationContext: TokenEstimationContext;
}> {
  // A new logical chat session should reuse the warmed header cache when available.
  // Header recapture is much more expensive and should be reserved for real refresh/login cases,
  // not for ordinary first prompts that simply need parent_id reset.
  const captured = await getQwenHeaders(
    options?.forceNewChat === true,
    accountId,
  );
  const { headers, parentMessageId } = captured;
  let activeHeaders = headers;
  const model = modelId.replace("-no-thinking", "");
  let createdNewChat = false;
  let chatSessionId: string | null | undefined;
  let leasedWarmChat = false;
  if (options && "chatSessionId" in options) {
    if (options.chatSessionId === null || options.chatSessionId === "") {
      const acquired = await acquireNewQwenChatSession(
        headers,
        model,
        accountId,
      );
      chatSessionId = acquired.chatId;
      leasedWarmChat = acquired.leasedFromPool;
      createdNewChat = true;
    } else {
      chatSessionId = options.chatSessionId;
    }
  } else {
    chatSessionId = captured.chatSessionId;
    if (!chatSessionId) {
      const acquired = await acquireNewQwenChatSession(
        headers,
        model,
        accountId,
      );
      chatSessionId = acquired.chatId;
      leasedWarmChat = acquired.leasedFromPool;
      createdNewChat = true;
    }
  }

  let warmChatReleased = false;
  const releaseLeasedWarmChat = () => {
    if (!leasedWarmChat || warmChatReleased || !chatSessionId) return;
    warmChatReleased = true;
    releaseWarmChat(accountId, model, chatSessionId);
  };

  const wrapUpstreamStream = (
    stream: ReadableStream<Uint8Array>,
    controller: AbortController,
  ): ReadableStream<Uint8Array> => {
    if (config.timeouts.idleStreamTimeout <= 0) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      return new ReadableStream<Uint8Array>({
        start() {
          reader = stream.getReader();
        },
        async pull(streamController) {
          try {
            if (!reader) throw new Error("Stream reader was not initialized");
            const { done, value } = await reader.read();
            if (done) {
              releaseLeasedWarmChat();
              streamController.close();
              return;
            }
            streamController.enqueue(value);
          } catch (error) {
            releaseLeasedWarmChat();
            streamController.error(error);
          }
        },
        cancel(reason) {
          releaseLeasedWarmChat();
          return stream.cancel(reason);
        },
      });
    }

    // Dynamic idle timeout based on model type and payload size
    // Reasoning models (thinking enabled): use REASONING_MODEL_TIMEOUT as base (600s default)
    // Non-reasoning models: use IDLE_STREAM_TIMEOUT as base (60s default)
    // Both add 30s per MB of payload
    const baseTimeoutMs = enableThinking
      ? config.timeouts.reasoningModelTimeout
      : config.timeouts.idleStreamTimeout;
    const payloadMB = payloadSize / (1024 * 1024);
    const dynamicIdleTimeoutMs = baseTimeoutMs + Math.ceil(payloadMB * 30_000);

    logger.debug("[Qwen] dynamic idle timeout", {
      chatId: chatSessionId || "new",
      model: modelId,
      enableThinking,
      payloadMB: payloadMB.toFixed(2),
      baseTimeout: baseTimeoutMs,
      dynamicTimeout: dynamicIdleTimeoutMs,
    });

    return addIdleTimeoutToStream(
      stream,
      controller,
      dynamicIdleTimeoutMs,
      `Qwen stream ${chatSessionId || "unknown"}`,
      releaseLeasedWarmChat,
      releaseLeasedWarmChat,
    );
  };

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
  const childId = uuidv4();

  const payload: QwenPayload = {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chatId: chatSessionId || null,
    parentId: actualParentId ?? "",
    chat_id: chatSessionId || null,
    chat_mode: "normal",
    model: model,
    parent_id: actualParentId,
    messages: [
      {
        id: null,
        fid: fid,
        parentId: actualParentId,
        childrenIds: [childId],
        role: "user",
        content: prompt,
        user_action: "chat",
        files: files || [],
        timestamp: timestamp,
        models: [model],
        model: "",
        chat_type: "t2t",
        feature_config: {
          thinking_enabled: enableThinking,
          output_schema: "phase",
          research_mode: "normal",
          auto_thinking: false,
          thinking_mode: "Thinking",
          thinking_format: "summary",
          auto_search: true,
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

  // Dynamic timeout based on payload size
  const BASE_TIMEOUT_MS = 120000;
  const TIMEOUT_PER_MB = 30000;

  const payloadJson = JSON.stringify(payload);
  const payloadSize = Buffer.byteLength(payloadJson);
  const tokenEstimationContext: TokenEstimationContext = {
    activePersonalization: getActivePersonalizationInfo(accountId ?? "global"),
    qwenPayloadBytes: payloadSize,
    qwenPayloadPromptChars: prompt.length,
    qwenPayloadMessageCount: payload.messages.length,
  };

  if (payloadSize > MAX_PAYLOAD_SIZE) {
    throw new Error(
      `Payload too large: ${payloadSize} bytes exceeds limit of ${MAX_PAYLOAD_SIZE} bytes`,
    );
  }

  const payloadMB = payloadSize / (1024 * 1024);
  const dynamicTimeoutMs =
    enableThinking || modelId.includes("thinking")
      ? Math.max(
          config.timeouts.reasoningModelTimeout,
          BASE_TIMEOUT_MS + Math.ceil(payloadMB * TIMEOUT_PER_MB),
        )
      : BASE_TIMEOUT_MS + Math.ceil(payloadMB * TIMEOUT_PER_MB);

  const url = chatSessionId
    ? `${config.qwen.baseUrl}/api/v2/chat/completions?chat_id=${chatSessionId}`
    : `${config.qwen.baseUrl}/api/v2/chat/completions`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), dynamicTimeoutMs);

  try {
    const fetchCompletion = (requestHeaders: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: buildCapturedQwenHeaders(requestHeaders, {
          chatSessionId,
          extra: {
            "x-accel-buffering": "no",
          },
        }),
        body: payloadJson,
        signal: controller.signal,
      });

    let response: Response;
    try {
      response = await fetchCompletion(activeHeaders);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Treat network errors (fetch failed, timeout, DNS, etc.) as retryable
      if (
        errorMsg.includes("fetch failed") ||
        errorMsg.includes("ECONNREFUSED") ||
        errorMsg.includes("ETIMEDOUT") ||
        errorMsg.includes("ENOTFOUND") ||
        errorMsg.includes("network") ||
        error instanceof TypeError
      ) {
        throw withCreatedChatMetadata(new QwenNetworkError(errorMsg));
      }
      throw withCreatedChatMetadata(
        error instanceof Error ? error : new Error(errorMsg),
      );
    }

    let responseContentType = response.headers.get("content-type") || "";
    let retriedNonSseResponse = false;
    let browserFallbackAttempted = false;

    const tryBrowserFallback = async (reason: string): Promise<boolean> => {
      if (browserFallbackAttempted) return false;
      browserFallbackAttempted = true;

      try {
        const browserResponse = await fetchCompletionInBrowser(
          accountId ?? "global",
          url,
          payloadJson,
          activeHeaders,
          dynamicTimeoutMs,
          controller,
        );
        response = new Response(browserResponse.stream, {
          status: browserResponse.status,
          headers: {
            "content-type":
              browserResponse.contentType || "text/event-stream",
          },
        });
        responseContentType = browserResponse.contentType;
        logger.info("[Qwen] Browser completion fallback returned", {
          accountId: accountId ?? "global",
          chatId: chatSessionId ?? "new",
          status: browserResponse.status,
          contentType: browserResponse.contentType || null,
          reason,
        });
        return true;
      } catch (error) {
        logger.warn("[Qwen] Browser completion fallback failed", {
          accountId: accountId ?? "global",
          chatId: chatSessionId ?? "new",
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    };

    while (true) {
      responseContentType = response.headers.get("content-type") || "";

      const isNonSseSuccessResponse =
        response.ok &&
        responseContentType.trim().length > 0 &&
        !responseContentType.includes("text/event-stream") &&
        !responseContentType.includes("application/json") &&
        Boolean(response.body);

      if (
        isHtmlResponseContentType(responseContentType) ||
        isNonSseSuccessResponse
      ) {
        const preview = await readResponsePreview(response);
        const htmlBody = isHtmlResponseBody(preview);
        const antiBotChallenge = isWafChallengeResponse(preview);
        logger.warn(
          htmlBody || isHtmlResponseContentType(responseContentType)
            ? "[Qwen] Completion returned HTML instead of SSE"
            : "[Qwen] Completion returned a non-SSE body",
          {
            accountId: accountId ?? "global",
            chatId: chatSessionId ?? "new",
            status: response.status,
            contentType: responseContentType,
            antiBotChallenge,
            previewBytes: Buffer.byteLength(preview, "utf8"),
          },
        );

        if (
          antiBotChallenge &&
          (await tryBrowserFallback("html_waf_response"))
        ) {
          continue;
        }

        if (!retriedNonSseResponse) {
          retriedNonSseResponse = true;
          const refreshed = await getQwenHeaders(true, accountId);
          activeHeaders = refreshed.headers;
          response = await fetchCompletion(activeHeaders);
          continue;
        }

        throw withCreatedChatMetadata(
          new QwenUpstreamError(
            antiBotChallenge
              ? "Qwen returned an anti-bot challenge instead of an SSE response."
              : "Qwen returned an HTML response instead of an SSE response.",
            antiBotChallenge
              ? "waf_challenge"
              : htmlBody || isHtmlResponseContentType(responseContentType)
                ? "non_sse_html_response"
                : "non_sse_response",
            502,
          ),
        );
      }

      if (
        response.status === 200 &&
        !responseContentType.includes("text/event-stream") &&
        (!response.body || response.headers.get("content-length") === "0")
      ) {
        if (!retriedNonSseResponse) {
          logger.warn(
            "[Qwen] Completion returned an empty non-stream 200 response; retrying with fresh headers.",
            {
              accountId: accountId ?? "global",
              chatId: chatSessionId ?? "new",
              contentType: responseContentType || null,
            },
          );
          retriedNonSseResponse = true;
          const refreshed = await getQwenHeaders(true, accountId);
          activeHeaders = refreshed.headers;
          response = await fetchCompletion(activeHeaders);
          continue;
        }
        break;
      }

      if (response.ok && responseContentType.includes("application/json")) {
        const errText = await response.text().catch(() => "");

        const htmlResponse = isHtmlResponseBody(errText);
        const antiBotChallenge = isWafChallengeResponse(errText);
        if (antiBotChallenge || htmlResponse) {
          logger.warn(
            "[Qwen] Completion returned an HTML or anti-bot challenge body instead of SSE.",
            {
              accountId: accountId ?? "global",
              chatId: chatSessionId ?? "new",
              antiBotChallenge,
              previewBytes: Buffer.byteLength(errText, "utf8"),
            },
          );

          if (
            antiBotChallenge &&
            (await tryBrowserFallback("json_waf_body"))
          ) {
            continue;
          }

          if (!retriedNonSseResponse) {
            retriedNonSseResponse = true;
            const refreshed = await getQwenHeaders(true, accountId);
            activeHeaders = refreshed.headers;
            response = await fetchCompletion(activeHeaders);
            continue;
          }

          throw withCreatedChatMetadata(
            new QwenUpstreamError(
              antiBotChallenge
                ? "Qwen returned an anti-bot challenge instead of an SSE response."
                : "Qwen returned an HTML response instead of an SSE response.",
              antiBotChallenge ? "waf_challenge" : "non_sse_html_response",
              502,
            ),
          );
        }

        throw withCreatedChatMetadata(
          parseQwenJsonError(errText, response.status, accountId) ??
            new QwenUpstreamError(
              `Qwen returned non-stream JSON response: ${errText.substring(0, 300)}`,
              "NonStreamJsonResponse",
              502,
            ),
        );
      }

      break;
    }

    if (!response.ok || !response.body) {
      const contentType = response.headers.get("content-type") || "";
      const errText = contentType.includes("application/json")
        ? await response.text().catch(() => "")
        : await readResponsePreview(response);

      // Handle 502/503/504 as retryable upstream unavailability
      if (
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504
      ) {
        throw withCreatedChatMetadata(
          new QwenUpstreamUnavailableError(
            `Qwen upstream unavailable: ${response.status} ${response.statusText}`,
            response.status,
          ),
        );
      }

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
          logger.warn("Unexpected error during stream error parsing", {
            error: parseOrRetryError,
          });
        }
      }
      throw withCreatedChatMetadata(
        new QwenUpstreamError(
          `Qwen completion request failed: ${response.status} ${response.statusText}`,
          isWafChallengeResponse(errText)
            ? "waf_challenge"
            : "completion_http_error",
          502,
        ),
      );
    }

    return {
      stream: wrapUpstreamStream(response.body, controller),
      headers: activeHeaders,
      uiSessionId: chatSessionId || "",
      controller,
      accountId: accountId ?? "global",
      createdNewChat,
      tokenEstimationContext,
    };
  } catch (error) {
    releaseLeasedWarmChat();
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
