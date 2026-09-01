import crypto from "crypto";
import {
  getQwenHeaders,
  getBasicHeaders,
  isAuthMockEnabled,
  isTokenExpiringSoon,
} from "./auth-playwright.ts";
import { v4 as uuidv4 } from "uuid";
import {
  UpstreamRateLimit,
  ClientAbortedError,
} from "../core/errors.ts";
import { buildQwenRequestHeaders } from "./qwen-headers.ts";
import { qwenOrigin, qwenUrl } from "./qwen-url.ts";
import { config, type ChatMode } from "../core/config.ts";
import { logger } from "../core/logger.ts";
import { estimateTokenCount } from "../utils/context-truncation.ts";
import type {
  PersonalizationEstimationInfo,
  TokenEstimationContext,
} from "./token-estimation-metrics.ts";
import { getDatabase } from "../core/database.ts";
import { mapClientModelToQwen } from "../core/model-alias.ts";
import {
  MAX_PAYLOAD_SIZE,
  replaceModelMetadata,
  syncModelMetadata,
} from "../core/model-registry.ts";
import { type Page } from "playwright";
import { withAccountPage } from "./playwright.ts";
import { assertAntiBotHeaders } from "./playwright.ts";
import { recoverBaxiaCaptcha } from "./captcha-coordinator.ts";
import { startBaxiaCaptchaWatcher } from "./captcha-solver.ts";
import { isAccountBusy } from "../core/account-concurrency.ts";

// Re-exported from extracted modules for backward compatibility
export {
  isRetryableFetchErrorMessage,
  RetryableQwenStreamError,
  PersonalizationSyncError,
  QwenUpstreamError,
  QwenSessionExpiredError,
  QwenUpstreamUnavailableError,
  QwenNetworkError,
  getQwenErrorCode,
} from "./qwen-errors.ts";
export {
  setToolCapNotice,
  consumeToolCapNotice,
  flushLogicalThreadState,
  getLogicalThreadState,
  updateLogicalThreadState,
  updateLogicalThreadParent,
  updateSessionParent,
  invalidateLogicalThreadParent,
  clearAllSessionsForAccount,
  getSessionParent,
} from "./qwen-thread-state.ts";
export type { LogicalThreadEntry } from "./qwen-thread-state.ts";
export {
  buildChatNewBody,
  isReusableUnusedChatTitle,
  releaseWarmChat,
  acquireNewQwenChatSession,
  warmQwenChatPool,
} from "./qwen-chat-pool.ts";

import {
  isRetryableFetchErrorMessage,
  RetryableQwenStreamError,
  QwenUpstreamError,
  QwenSessionExpiredError,
  QwenUpstreamUnavailableError,
  QwenNetworkError,
} from "./qwen-errors.ts";
import {
  clearAllSessionsForAccount,
  getSessionParent,
  updateSessionParent,
} from "./qwen-thread-state.ts";
import {
  acquireNewQwenChatSession,
  releaseWarmChat,
} from "./qwen-chat-pool.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BROWSER_STREAM_BINDING = "__qwenProxyStreamEvent";
const BROWSER_ABORTERS_KEY = "__qwenProxyAborters";
// Steady-state bridge batching. The first chunk always flushes immediately
// (see the !firstChunkSent bypass in the in-page reader), so these only govern
// mid-stream latency: 4KB/25ms held tokens behind a buffer the client writer
// (8KB/3ms) would have flushed anyway. 512B/8ms matches ~2-3 SSE events per CDP
// hop — invisible to the WAF (bytes-per-hop is not a signal) and strictly
// faster for the client.
const BROWSER_STREAM_FLUSH_BYTES = 512;
const BROWSER_STREAM_FLUSH_MS = 8;
const METADATA_TIMEOUT_PER_PAYLOAD_MB_MS = 10_000;
const POST_CAPTCHA_METADATA_GRACE_MS = 20_000;

type BrowserStreamEvent = {
  type: "headers" | "chunk" | "done" | "error";
  status?: number;
  contentType?: string;
  data?: string;
  message?: string;
  errorName?: string;
};

interface BrowserStreamMetadata {
  status: number;
  contentType: string;
}

interface BrowserStreamState {
  chunks: Uint8Array[];
  done: boolean;
  error: Error | null;
  metadata: BrowserStreamMetadata | null;
  waiters: Set<() => void>;
}

const browserStreamStates = new Map<string, BrowserStreamState>();
const browserStreamBindingPages = new WeakSet<object>();

function wakeBrowserStreamState(state: BrowserStreamState): void {
  const waiters = Array.from(state.waiters);
  state.waiters.clear();
  for (const wake of waiters) wake();
}

function handleBrowserStreamEvent(
  requestId: string,
  event: BrowserStreamEvent,
): void {
  const state = browserStreamStates.get(requestId);
  if (!state) return;

  if (event.type === "headers") {
    state.metadata = {
      status: event.status ?? 0,
      contentType: event.contentType ?? "",
    };
  } else if (event.type === "chunk" && typeof event.data === "string") {
    if (event.data.length > 0) {
      state.chunks.push(Buffer.from(event.data, "utf8"));
    }
  } else if (event.type === "done") {
    state.done = true;
  } else if (event.type === "error") {
    state.error = browserStreamError(
      event.message || "Browser Qwen stream failed",
      event.errorName,
    );
    state.done = true;
  }

  wakeBrowserStreamState(state);
}

async function ensureBrowserStreamBinding(page: Page): Promise<void> {
  if (browserStreamBindingPages.has(page)) return;

  await page.exposeFunction(
    BROWSER_STREAM_BINDING,
    (requestId: string, event: BrowserStreamEvent) => {
      handleBrowserStreamEvent(requestId, event);
    },
  );
  browserStreamBindingPages.add(page);
}

function browserStreamError(message: string, errorName?: string): Error {
  const normalizedMessage = message || "Browser Qwen stream failed";
  if (errorName === "AbortError") {
    const abortError = new DOMException(normalizedMessage, "AbortError");
    return abortError;
  }
  return new QwenNetworkError(normalizedMessage);
}

async function waitForBrowserStreamMetadata(
  requestId: string,
  timeoutMs: number,
): Promise<BrowserStreamMetadata> {
  const state = browserStreamStates.get(requestId);
  if (!state) {
    throw new Error("Browser Qwen stream state was lost before response headers");
  }

  const waitForStateChange = new Promise<void>((resolve) => {
    state.waiters.add(resolve);
    if (state.metadata || state.error || state.done) {
      state.waiters.delete(resolve);
      resolve();
    }
  });

  while (!state.metadata && !state.error && !state.done) {
    await waitForStateChange;
    if (!state.metadata && !state.error && !state.done) {
      return waitForBrowserStreamMetadata(requestId, timeoutMs);
    }
  }

  if (state.metadata) return state.metadata;
  throw state.error ?? new Error(
    `Browser Qwen stream ended before response headers after ${timeoutMs}ms`,
  );
}

/**
 * Idle timeout for an upstream stream, derived from model type, payload size
 * and whether the stream is an auxiliary parallel-escape request.
 *
 * Base: REASONING_MODEL_TIMEOUT when thinking, IDLE_STREAM_TIMEOUT otherwise;
 * +30s per MB of payload.
 *
 * Auxiliary (parallel-escape) streams serve a small request (e.g. a chat
 * title) that generates in seconds; a SHORT cap frees the account slot fast
 * when the upstream never sends the SSE terminal. The tight cap must ONLY
 * apply to NON-thinking models: thinking streams legitimately pause >15s
 * between reasoning chunks, and a 15s cap killed a 564KB full-replay in
 * production (log 2026-08-21, etimedout idle after 15000ms on qwen3.8-max).
 */
export function computeDynamicIdleTimeout(opts: {
  enableThinking: boolean;
  parallelEscape?: boolean;
  baseTimeoutMs: number;
  payloadSize: number;
}): number {
  const payloadMB = opts.payloadSize / (1024 * 1024);
  const dynamic = opts.baseTimeoutMs + Math.ceil(payloadMB * 30_000);
  if (opts.parallelEscape && !opts.enableThinking) {
    return Math.min(15_000, dynamic);
  }
  return dynamic;
}

function addIdleTimeoutToStream(
  stream: ReadableStream<Uint8Array>,
  controller: AbortController,
  idleTimeoutMs: number,
  label: string,
  onTimeout?: () => void,
  onDone?: () => void,
  /**
   * Stricter deadline for the FIRST chunk only (thinking models idle at
   * REASONING_MODEL_TIMEOUT = 600s by default; a stream that produced NOTHING
   * in that window is almost certainly dead, and holding the account slot for
   * 10 minutes stalls the whole session). After the first chunk the normal
   * idleTimeoutMs governs gaps. Aborts here are retryable (etimedout marker).
   */
  firstChunkDeadlineMs?: number,
): ReadableStream<Uint8Array> {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let wrapperController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let firstChunkSeen = false;

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const currentIdleMs = () =>
    firstChunkSeen || firstChunkDeadlineMs === undefined
      ? idleTimeoutMs
      : firstChunkDeadlineMs;

  const resetIdleTimer = () => {
    clearIdleTimer();
    const timeoutMs = currentIdleMs();
    idleTimer = setTimeout(() => {
      // The `etimedout` marker lets retry-policy (isNetworkLikeError) treat a
      // stalled upstream as a retryable network failure instead of a terminal
      // 500, so the bridge auto-rotates to another account mid-stream.
      const message = `${label} etimedout (${firstChunkSeen ? "idle" : "first-chunk"} timeout after ${timeoutMs}ms without upstream data)`;
      clearIdleTimer();
      controller.abort();
      onTimeout?.();
      // Best-effort cleanup of the upstream source.
      try {
        void stream.cancel(message).catch(() => {});
      } catch {}
      // Error the WRAPPED stream so the bridge's pending read() rejects
      // immediately. Without this, a page/fetch that ignores abort keeps the
      // read pending forever: the stream slot stays held, later requests queue
      // with timeout=unbounded, and no further timeout can ever fire (the
      // timer is one-shot per pull).
      try {
        wrapperController?.error(new Error(message));
      } catch {}
      // Belt-and-braces: settle a pending read on the wrapper's own reader.
      try {
        void reader?.cancel(message).catch(() => {});
      } catch {}
    }, timeoutMs);
  };

  return new ReadableStream<Uint8Array>({
    start() {
      reader = stream.getReader();
      resetIdleTimer();
    },
    async pull(streamController) {
      wrapperController = streamController;
      try {
        if (!reader) throw new Error("Stream reader was not initialized");
        const { done, value } = await reader.read();
        if (done) {
          clearIdleTimer();
          onDone?.();
          streamController.close();
          return;
        }
        firstChunkSeen = true;
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
    thinking_format?: string;
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

export interface PublicQwenModel {
  id: string;
  name: string;
  object: "model";
  owned_by: string;
  created: number;
  context_window?: number;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  info?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  modality?: string[];
  chat_type?: string[];
  think_skip?: Record<string, unknown>;
  is_active?: boolean;
  [key: string]: unknown;
}

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const modelsCache = new Map<
  string,
  { models: PublicQwenModel[]; fetchedAt: number }
>();

const nativeToolsDisabled = new Set<string>();
const disablingNativeToolsInProgress = new Set<string>();
const lastSyncedPersonalizationHashes = new Map<string, string>();

// Direct-fetch circuit breaker for the personalization settings API. A raw
// Node fetch to chat.qwen.ai can be WAF-blocked (baxia/captcha challenge) in
// some environments; after N consecutive block-like responses we open the
// breaker for that account and route personalization through the browser (the
// guaranteed WAF-safe transport) until the app restarts. This keeps the fast
// direct path primary while never letting a WAF block cost a round-trip on
// every sync.
const directSettingsFetchConsecutiveFailures = new Map<string, number>();
const DIRECT_SETTINGS_FETCH_BLOCK_THRESHOLD = 2;
const directSettingsFetchBlocked = new Set<string>();
const DIRECT_SETTINGS_FETCH_TIMEOUT_MS = 10_000;

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

function shortAccountId(accountId: string): string {
  const normalized = accountId.trim();
  return normalized.length > 12 ? normalized.slice(0, 12) : normalized;
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

export function buildCapturedQwenHeaders(
  headers: Record<string, string>,
  options: {
    chatSessionId?: string | null;
    referer?: string;
    extra?: Record<string, string>;
  } = {},
): Record<string, string> {
  assertAntiBotHeaders(headers, "Qwen request");
  return buildQwenRequestHeaders({
    cookie: headers["cookie"],
    userAgent: headers["user-agent"],
    bxUa: headers["bx-ua"],
    bxUmidtoken: headers["bx-umidtoken"],
    bxV: headers["bx-v"],
    secChUa: headers["sec-ch-ua"] || undefined,
    secChUaMobile: headers["sec-ch-ua-mobile"] || undefined,
    secChUaPlatform: headers["sec-ch-ua-platform"] || undefined,
    version: headers["version"] || undefined,
    chatSessionId: options.chatSessionId,
    extra: {
      ...(options.referer ? { Referer: options.referer } : {}),
      ...(options.extra || {}),
    },
  });
}

/**
 * Open an isolated page in the same browser context for short-lived operations
 * (settings, models, etc.). The main chat page is never navigated away.
 */
async function withIsolatedQwenPage<T>(
  accountId: string,
  fn: (page: Page) => Promise<T>,
  targetUrl?: string,
): Promise<T> {
  return withAccountPage(
    accountId,
    async (mainPage) => {
      const context = mainPage.context();
      const page = await context.newPage();
      try {
        if (targetUrl) {
          await page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: config.timeouts.navigation,
          });
        }
        return await fn(page);
      } finally {
        await page.close().catch(() => {});
      }
    },
    config.timeouts.page,
  );
}

// Per-account stream slots: a counting semaphore capped by
// config.concurrency.maxStreamsPerAccount (NOT a capacity-1 mutex). The browser
// relay multiplexes concurrent streams on one page via reqId (browserStreamStates),
// so serializing to 1 here silently overrode the lease cap and made
// ACCOUNT_MAX_CONCURRENT_STREAMS>1 unreachable (the second stream queued behind
// the first's whole generation). FIFO handoff on release keeps the old
// leak-recovery semantics (release is idempotent; a dropped stream still blocks
// its slot until cancel/idle-timeout frees it — same as before).
interface AccountStreamSlots {
  active: number;
  queue: Array<() => void>;
}
const accountStreamMutexes = new Map<string, AccountStreamSlots>();

function getAccountStreamMutex(
  accountId: string,
): AccountStreamSlots {
  let slots = accountStreamMutexes.get(accountId);
  if (!slots) {
    slots = { active: 0, queue: [] };
    accountStreamMutexes.set(accountId, slots);
  }
  return slots;
}

function streamSlotCapacity(): number {
  return Math.max(1, config.concurrency.maxStreamsPerAccount);
}

function createStreamSlotRelease(slots: AccountStreamSlots): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slots.active -= 1;
    const next = slots.queue.shift();
    if (next) {
      // Hand the slot directly to the waiter (FIFO), same as the old mutex.
      slots.active += 1;
      next();
    }
  };
}

async function acquireAccountStreamLock(accountId: string): Promise<() => void> {
  const slots = getAccountStreamMutex(accountId);
  if (slots.active < streamSlotCapacity()) {
    slots.active += 1;
    return Promise.resolve(createStreamSlotRelease(slots));
  }
  return new Promise<() => void>((resolve) => {
    slots.queue.push(() => resolve(createStreamSlotRelease(slots)));
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

export function buildQwenSettingsUpdatePayload(
  currentSettings: any,
  instruction: string,
): Record<string, unknown> {
  // The real client (HAR networkv2) POSTs ONLY `{personalization: {...}}` to
  // /api/v2/users/user/settings/update. Live probes confirmed the personalization
  // object accepts the GET-personalization spread + enable_for_new_chat, but the
  // FULL-settings spread this used to send (ui/memory/tools_enabled + every GET
  // field like tts_speaker_v2, code_settings, manage_cookies) is rejected with
  // RequestValidationError. Safe-settings are applied by disableNativeTools as
  // their own combined partial POST (probe-accepted). NOTE: the persistent
  // RequestValidationError that haunted the sync was NOT the payload — it was a
  // missing Content-Type header (attemptPost received the raw getQwenHeaders
  // map); the body was not parsed as a JSON object ("Field '': Input should be
  // a valid dictionary...").
  const currentPersonalization =
    currentSettings?.personalization &&
    typeof currentSettings.personalization === "object"
      ? currentSettings.personalization
      : {};

  return {
    personalization: {
      ...currentPersonalization,
      name: "",
      description:
        currentPersonalization.description === undefined
          ? null
          : currentPersonalization.description,
      style: null,
      instruction,
      enable_for_new_chat: true,
    },
  };
}

export async function readJsonTextResponse(
  response: Response,
  options: { strict?: boolean } = {},
): Promise<{ raw: string; json: any }> {
  const raw = await response.text();
  if (!raw) {
    return { raw, json: null };
  }

  // Pre-check HTTP status: upstream gateways (like Alibaba GA) returning 502/503/504
  // with an HTML body (e.g. <html><head><title>502 Bad Gateway</title>...) will fail JSON.parse.
  // In strict mode on a non-ok response with non-JSON/HTML, throw an upfront descriptive upstream error
  // rather than a cryptic SyntaxError ("Unexpected token '<'").
  if (!response.ok && (raw.trimStart().startsWith("<") || response.status >= 500)) {
    if (options.strict) {
      const { QwenUpstreamError } = await import("./qwen-errors.ts");
      throw new QwenUpstreamError(
        `Upstream gateway error ${response.status} ${response.statusText}: ${raw.substring(0, 200)}`,
        "UpstreamGatewayError",
        response.status >= 500 ? 502 : response.status,
      );
    }
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

async function withQwenBrowserPage<T>(
  accountId: string,
  fn: (page: Page) => Promise<T>,
  targetPath?: string,
  operationTimeoutMs = config.timeouts.page,
  recoverOnTimeout = true,
): Promise<T> {
  // Keep the account page on the chat UI for normal browser operations. The
  // personalization helper passes /settings/personalization explicitly; an
  // omitted target must not leave a same-origin settings page in place.
  const effectiveTargetPath = targetPath || "/";
  const targetUrl = qwenUrl(effectiveTargetPath);
  const targetOrigin = new URL(targetUrl).origin;
  const normalizedTargetPath =
    new URL(targetUrl).pathname.replace(/\/+$/, "") || "/";

  return withAccountPage(
    accountId,
    async (page) => {
      let currentOrigin = "";
      let currentPath = "";
      try {
        const currentUrl = new URL(page.url());
        currentOrigin = currentUrl.origin;
        currentPath = currentUrl.pathname.replace(/\/+$/, "") || "/";
      } catch {
        // Navigate below when the current page has no usable URL.
      }

      if (
        currentOrigin !== targetOrigin ||
        (normalizedTargetPath && currentPath !== normalizedTargetPath)
      ) {
        await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(config.timeouts.navigation, operationTimeoutMs),
        });
      }

      return fn(page);
    },
    operationTimeoutMs,
    Math.min(config.timeouts.page, 5_000),
    recoverOnTimeout,
  );
}

async function withQwenPersonalizationPage<T>(
  accountId: string,
  fn: (page: Page) => Promise<T>,
  operationTimeoutMs = config.timeouts.page,
  recoverOnTimeout = true,
): Promise<T> {
  return withQwenBrowserPage(
    accountId,
    async (page) => {
      try {
        return await fn(page);
      } finally {
        if (!page.isClosed()) {
          try {
            const currentUrl = new URL(page.url());
            const currentPath = currentUrl.pathname.replace(/\/+$/, "") || "/";
            if (currentUrl.origin !== qwenOrigin() || currentPath !== "/") {
              await page.goto(qwenUrl("/"), {
                waitUntil: "domcontentloaded",
                timeout: Math.min(config.timeouts.navigation, operationTimeoutMs),
              });
            }
          } catch (error) {
            // Do not mask the personalization request result if restoring the
            // normal chat page fails; the next normal operation will retry it.
            logger.warn("[Qwen] Could not restore chat page after personalization", {
              accountId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    },
    "/settings/personalization",
    operationTimeoutMs,
    recoverOnTimeout,
  );
}

/**
 * Build minimal headers for browser-side fetch. The browser automatically
 * adds Cookie, User-Agent, Origin, Referer, and sec-* headers, so we only
 * pass the anti-bot tokens and metadata that the browser cannot infer.
 */
function getBrowserFetchHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const browserAllowedHeaders = new Set([
    "accept",
    "content-type",
    "bx-ua",
    "bx-umidtoken",
    "bx-v",
    "source",
    "version",
    "timezone",
    "x-request-id",
    "x-accel-buffering",
  ]);

  return Object.fromEntries(
    Object.entries(headers).filter(([name]) =>
      browserAllowedHeaders.has(name.toLowerCase()),
    ),
  );
}

interface BrowserTextResponse {
  status: number;
  contentType: string;
  raw: string;
}

export async function requestQwenTextInBrowser(
  accountId: string | undefined,
  method: "GET" | "POST" | "DELETE",
  path: string,
  headers: Record<string, string>,
  body?: string,
  options: {
    settingsPage?: boolean;
    referrer?: string;
    timeoutMs?: number;
    /**
     * Best-effort operations (e.g. the post-disconnect stop) must not trigger
     * the aggressive stuck-mutex recovery: the mutex is legitimately held by the
     * NEW request that superseded this one, and closing the context / resetting
     * the profile would kill the account for a healthy in-flight generation.
     */
    noMutexRecovery?: boolean;
  } = {},
): Promise<Response> {
  const url = qwenUrl(path);

  // Mock tests intentionally use Node fetch and do not initialize a browser.
  if (isAuthMockEnabled()) {
    return fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  }

  if (!accountId) {
    throw new Error("A Qwen account is required for browser request");
  }

  const browserHeaders = getBrowserFetchHeaders(headers);
  if (
    body !== undefined &&
    !Object.keys(browserHeaders).some(
      (name) => name.toLowerCase() === "content-type",
    )
  ) {
    browserHeaders["Content-Type"] = "application/json";
  }

  const evaluateRequest = (page: Page) =>
    page.evaluate(
      async ({ url, method, headers, body, referrer }: {
        url: string;
        method: "GET" | "POST" | "DELETE";
        headers: Record<string, string>;
        body?: string;
        referrer?: string;
      }): Promise<BrowserTextResponse> => {
        const response = await fetch(url, {
          method,
          credentials: "include",
          headers,
          body,
          ...(referrer ? { referrer } : {}),
        });
        return {
          status: response.status,
          contentType: response.headers.get("content-type") || "",
          raw: await response.text(),
        };
      },
      {
        url,
        method,
        headers: browserHeaders,
        body,
        referrer: options.referrer,
      },
    );
  const recoverOnTimeout = !options.noMutexRecovery;
  const response = options.settingsPage
    ? await withQwenPersonalizationPage<BrowserTextResponse>(
        accountId,
        evaluateRequest,
        options.timeoutMs,
        recoverOnTimeout,
      )
    : await withQwenBrowserPage<BrowserTextResponse>(
        accountId,
        evaluateRequest,
        undefined,
        options.timeoutMs,
        recoverOnTimeout,
      );

  return new Response(response.raw, {
    status: response.status,
    headers: response.contentType
      ? { "content-type": response.contentType }
      : undefined,
  });
}

/**
 * Direct Node fetch of Qwen settings/user APIs using the captured (now
 * anti-hardcoded) headers. This is exactly what the real web client does — a
 * plain fetch against `/api/v2/users/user/settings` on the same origin — and
 * it avoids the flaky `page.evaluate` + settings-page navigation that hung
 * the personalization sync (the 30s sync timeout / "stuck page operation").
 *
 * Returns null (instead of throwing) when the direct path should not be used:
 * the account's circuit breaker is open, a WAF block is detected, or the
 * request errors — in all cases the caller falls back to the browser path.
 */
export async function requestQwenSettingsDirectFetch(
  accountId: string | undefined,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  payload?: Record<string, unknown>,
): Promise<{ status: number; raw: string; json: any } | null> {
  const cacheKey = accountId || "global";
  if (directSettingsFetchBlocked.has(cacheKey)) {
    return null;
  }

  const url = qwenUrl(path);
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    DIRECT_SETTINGS_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: controller.signal,
    });
    const raw = await response.text();
    const contentType =
      response.headers.get("content-type") || "application/json";

    // A WAF/baxia challenge (or proxy error page) is HTML, not the JSON the
    // settings API always returns. If we see one, treat it as a block and let
    // the browser path take over — the browser has the real fingerprint that
    // passes the WAF.
    let json: any = null;
    let okShape = false;
    if (contentType.includes("html")) {
      okShape = false;
    } else {
      try {
        json = JSON.parse(raw);
        okShape = json && typeof json === "object" && "success" in json;
      } catch {
        okShape = false;
      }
    }

    if (!okShape) {
      const failures = (directSettingsFetchConsecutiveFailures.get(cacheKey) ??
        0) + 1;
      if (failures >= DIRECT_SETTINGS_FETCH_BLOCK_THRESHOLD) {
        directSettingsFetchBlocked.add(cacheKey);
        logger.debug(
          "[Qwen] Direct settings fetch WAF-blocked; routing personalization through the browser",
          {
            accountId: cacheKey,
            path,
            consecutiveFailures: failures,
            contentType,
            status: response.status,
          },
        );
      } else {
        directSettingsFetchConsecutiveFailures.set(cacheKey, failures);
      }
      return null;
    }

    directSettingsFetchConsecutiveFailures.delete(cacheKey);
    logger.debug("[Qwen] Direct settings fetch succeeded", {
      accountId: cacheKey,
      path,
      status: response.status,
    });
    return { status: response.status, raw, json };
  } catch (err) {
    // Network error or the bounded timeout — fall back to the browser path.
    logger.debug("[Qwen] Direct settings fetch failed; using browser path", {
      accountId: cacheKey,
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestQwenPersonalizationInBrowser(
  accountId: string | undefined,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  payload?: Record<string, unknown>,
): Promise<{ status: number; raw: string; json: any }> {
  // Fast, stable primary path: direct Node fetch with the captured headers
  // (cookie, bx-v, version, sec-ch-ua, source, referer). Falls back to the
  // browser only when unavailable (circuit breaker / WAF block / network err).
  if (!isAuthMockEnabled()) {
    const direct = await requestQwenSettingsDirectFetch(
      accountId,
      method,
      path,
      headers,
      payload,
    );
    if (direct) {
      return direct;
    }
  }

  const response = await requestQwenTextInBrowser(
    accountId,
    method,
    path,
    headers,
    payload === undefined ? undefined : JSON.stringify(payload),
    {
      settingsPage: true,
      referrer: qwenUrl("/settings/personalization"),
    },
  );
  const { raw, json } = await readJsonTextResponse(response);
  return { status: response.status, raw, json };
}

async function cancelQwenBrowserStream(
  accountId: string,
  requestId: string,
): Promise<void> {
  const state = browserStreamStates.get(requestId);
  if (state) {
    state.done = true;
    wakeBrowserStreamState(state);
  }

  try {
    await withQwenBrowserPage(accountId, async (page) => {
      await page.evaluate(
        ({ abortersKey, requestId }: {
          abortersKey: string;
          requestId: string;
        }) => {
          const aborters = (globalThis as unknown as Record<string, unknown>)[
            abortersKey
          ] as Map<string, AbortController> | undefined;
          aborters?.get(requestId)?.abort();
        },
        { abortersKey: BROWSER_ABORTERS_KEY, requestId },
      );
    });
  } catch {
    // The page may already be closing after an abort or timeout.
  } finally {
    browserStreamStates.delete(requestId);
  }
}

async function createQwenBrowserResponse(
  accountId: string | undefined,
  url: string,
  method: "POST",
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
  referrer?: string,
  pageOperationTimeoutMs = config.timeouts.page,
): Promise<Response> {
  if (isAuthMockEnabled()) {
    return fetch(url, {
      method,
      headers,
      body,
      signal,
    });
  }

  if (!accountId) {
    throw new Error("A Qwen account is required for browser streaming");
  }
  if (signal.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }

  const requestId = uuidv4();
  const state: BrowserStreamState = {
    chunks: [],
    done: false,
    error: null,
    metadata: null,
    waiters: new Set(),
  };
  browserStreamStates.set(requestId, state);

  const browserHeaders = getBrowserFetchHeaders(headers);
  if (
    !Object.keys(browserHeaders).some(
      (name) => name.toLowerCase() === "content-type",
    )
  ) {
    browserHeaders["Content-Type"] = "application/json";
  }

  let settled = false;
  let abortListener: (() => void) | undefined;
  let cancelPromise: Promise<void> | undefined;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    if (abortListener) signal.removeEventListener("abort", abortListener);
    browserStreamStates.delete(requestId);
  };
  const cancel = () => {
    if (!cancelPromise) {
      cancelPromise = cancelQwenBrowserStream(accountId, requestId);
    }
    cleanup();
    return cancelPromise;
  };

  abortListener = () => {
    void cancel();
  };
  signal.addEventListener("abort", abortListener, { once: true });

  const payloadMbForMetadata = Math.ceil(
    Buffer.byteLength(body, "utf8") / (1024 * 1024),
  );
  // First-byte deadline for the completion fetch: honor TIME_TO_FIRST_BYTE
  // (default 60s) with a 15s floor. A stall past this window is a dead
  // connection / WAF swallow — classified retryable by the caller.
  const metadataTimeoutMs = Math.max(
    5_000,
    Math.min(
      pageOperationTimeoutMs,
      Math.max(15_000, config.timeouts.timeToFirstByte) +
        payloadMbForMetadata * METADATA_TIMEOUT_PER_PAYLOAD_MB_MS,
    ),
  );
  let captchaWatcher: ReturnType<typeof startBaxiaCaptchaWatcher> | undefined;

  try {
    const startOperationTimeoutMs = Math.max(
      5_000,
      Math.min(config.timeouts.navigation, pageOperationTimeoutMs),
    );
    const started = await withQwenBrowserPage(
      accountId,
      async (page) => {
        await ensureBrowserStreamBinding(page);
        if (config.captcha.enabled) {
          captchaWatcher = startBaxiaCaptchaWatcher(
            page,
            metadataTimeoutMs,
            {
              maxAttempts: config.captcha.maxAttempts,
              retryDelayMs: config.captcha.retryDelayMs,
              settleMs: config.captcha.settleMs,
            },
          );
        }
        return page.evaluate(
          ({
            url,
            method,
            headers,
            body,
            referrer,
            requestId,
            bindingName,
            abortersKey,
            flushBytes,
            flushMs,
            timeoutMs,
          }: {
            url: string;
            method: "POST";
            headers: Record<string, string>;
            body: string;
            referrer?: string;
            requestId: string;
            bindingName: string;
            abortersKey: string;
            flushBytes: number;
            flushMs: number;
            timeoutMs: number;
          }) => {
            const globalObject = globalThis as unknown as Record<string, unknown>;
            const notify = globalObject[bindingName] as (
              (id: string, event: BrowserStreamEvent) => Promise<void>
            );
            if (typeof notify !== "function") {
              throw new Error("Qwen browser stream binding is unavailable");
            }

            let aborters = globalObject[abortersKey] as
              | Map<string, AbortController>
              | undefined;
            if (!aborters) {
              aborters = new Map<string, AbortController>();
              globalObject[abortersKey] = aborters;
            }
            const abortController = new AbortController();
            aborters.set(requestId, abortController);
            const timeoutId = setTimeout(
              () => abortController.abort(),
              timeoutMs,
            );

            void (async () => {
              try {
                const response = await fetch(url, {
                  method,
                  credentials: "include",
                  headers,
                  body,
                  signal: abortController.signal,
                  ...(referrer ? { referrer } : {}),
                });
                clearTimeout(timeoutId);

                await notify(requestId, {
                  type: "headers",
                  status: response.status,
                  contentType: response.headers.get("content-type") || "",
                });

                if (!response.body) {
                  await notify(requestId, { type: "done" });
                  return;
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffered = "";
                let lastFlushAt = Date.now();
                let firstChunkSent = false;

                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (!value) continue;

                  buffered += decoder.decode(value, { stream: true });
                  if (
                    !firstChunkSent ||
                    buffered.length >= flushBytes ||
                    Date.now() - lastFlushAt >= flushMs
                  ) {
                    const data = buffered;
                    buffered = "";
                    firstChunkSent = true;
                    lastFlushAt = Date.now();
                    await notify(requestId, { type: "chunk", data });
                  }
                }

                buffered += decoder.decode();
                if (buffered) {
                  const data = buffered;
                  buffered = "";
                  await notify(requestId, { type: "chunk", data });
                }
                await notify(requestId, { type: "done" });
              } catch (error) {
                clearTimeout(timeoutId);
                try {
                  await notify(requestId, {
                    type: "error",
                    message:
                      error instanceof Error ? error.message : String(error),
                    errorName: error instanceof Error ? error.name : undefined,
                  });
                } catch {
                  // Node may have cancelled the stream already.
                }
              } finally {
                aborters?.delete(requestId);
              }
            })();

            // Do not await the upstream fetch here. Returning immediately
            // releases the per-account Playwright mutex while metadata/chunks
            // continue through the exposed binding.
            return true;
          },
          {
            url,
            method,
            headers: browserHeaders,
            body,
            referrer,
            requestId,
            bindingName: BROWSER_STREAM_BINDING,
            abortersKey: BROWSER_ABORTERS_KEY,
            flushBytes: BROWSER_STREAM_FLUSH_BYTES,
            flushMs: BROWSER_STREAM_FLUSH_MS,
            timeoutMs: metadataTimeoutMs,
          },
        );
      },
      undefined,
      startOperationTimeoutMs,
    );

    if (!started) {
      throw new Error("Qwen browser stream failed to start");
    }

    let captchaSolvedDuringMetadata = false;
    let metadataTimer: ReturnType<typeof setTimeout> | undefined;
    const metadataTimeoutPromise = new Promise<never>((_, reject) => {
      const fail = () =>
        reject(
          new Error(
            `Qwen browser stream timed out waiting for response headers after ${metadataTimeoutMs}ms${
              captchaSolvedDuringMetadata
                ? " (captcha solved; original request did not resume)"
                : ""
            }`,
          ),
        );
      metadataTimer = setTimeout(fail, metadataTimeoutMs);
      metadataTimer.unref?.();

      // When the watcher solves a challenge while headers have not arrived, the
      // original background fetch often remains stalled. Give it a short grace
      // window; if nothing arrives, the caller retries with fresh headers.
      if (captchaWatcher) {
        void captchaWatcher.promise
          .then((solved) => {
            if (!solved) return;
            captchaSolvedDuringMetadata = true;
            if (metadataTimer) {
              clearTimeout(metadataTimer);
              metadataTimer = setTimeout(fail, POST_CAPTCHA_METADATA_GRACE_MS);
              metadataTimer.unref?.();
            }
          })
          .catch(() => undefined);
      }
    });

    let metadata: BrowserStreamMetadata;
    try {
      metadata = await Promise.race([
        waitForBrowserStreamMetadata(
          requestId,
          metadataTimeoutMs + POST_CAPTCHA_METADATA_GRACE_MS,
        ),
        metadataTimeoutPromise,
      ]);
    } catch (error) {
      if (
        captchaSolvedDuringMetadata &&
        error instanceof Error &&
        error.message.includes("timed out waiting for response headers")
      ) {
        const retryableError = new Error(error.message);
        (retryableError as any).captchaSolvedDuringMetadata = true;
        throw retryableError;
      }
      throw error;
    } finally {
      if (metadataTimer) clearTimeout(metadataTimer);
    }

    if (signal.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const current = browserStreamStates.get(requestId);
        if (!current) {
          controller.close();
          return;
        }

        while (current.chunks.length === 0 && !current.done) {
          await new Promise<void>((resolve) => {
            current.waiters.add(resolve);
            if (current.chunks.length > 0 || current.done) {
              current.waiters.delete(resolve);
              resolve();
            }
          });
        }

        if (current.chunks.length > 0) {
          controller.enqueue(current.chunks.shift()!);
          return;
        }

        cleanup();
        if (current.error) {
          controller.error(current.error);
        } else {
          controller.close();
        }
      },
      cancel() {
        return cancel();
      },
    });

    return new Response(stream, {
      status: metadata.status,
      headers: metadata.contentType
        ? { "content-type": metadata.contentType }
        : undefined,
    });
  } catch (error) {
    captchaWatcher?.stop();
    await cancel().catch(() => {});
    throw error;
  } finally {
    captchaWatcher?.stop();
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
  if (isAuthMockEnabled()) {
    // Test hook: force the sync to report "not applied" so the fail-fast
    // contract (personalization-required suite) is exercisable in mock mode.
    if (process.env.TEST_PERSONALIZATION_SYNC_FAIL === "true") return false;
    return true;
  }
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
  let requestHeaders = buildCapturedQwenHeaders(headers, {
    referer: qwenUrl("/settings/personalization"),
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

  // Diagnostic: log when the in-memory hash exists but differs, so we can
  // trace what is destabilising the personalization hash between requests.
  if (!bypassCache && syncHash && cachedHash && cachedHash !== syncHash) {
    logger.debug("[Qwen] personalization cache miss (hash changed)", {
      accountId: cacheKey,
      cachedHash,
      newHash: syncHash,
      model: metadata.model || null,
      tools: metadata.toolsCount ?? 0,
    });
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
      const { json: existingJson } =
        await requestQwenPersonalizationInBrowser(
          accountId,
          "GET",
          "/api/v2/users/user/settings",
          requestHeaders,
        );
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
        const { json: settingsJson } =
          await requestQwenPersonalizationInBrowser(
            accountId,
            "GET",
            "/api/v2/users/user/settings",
            headers,
          );
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

    return requestQwenPersonalizationInBrowser(
      accountId,
      "POST",
      "/api/v2/users/user/settings/update",
      headers,
      payload,
    );
  }

  let raw: string;
  let json: any;

  // Layer 1: First attempt. attemptPost MUST receive the fully-built request
  // headers (Content-Type: application/json, Origin, Referer, source, ...) —
  // the raw getQwenHeaders map lacks Content-Type, and the Qwen API rejects a
  // body POSTed without it with RequestValidationError ("Field '': Input
  // should be a valid dictionary..." — the body is not parsed as a JSON object).
  ({ raw, json } = await attemptPost(requestHeaders));

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
      requestHeaders = buildCapturedQwenHeaders(freshHeaders, {
        referer: qwenUrl("/settings/personalization"),
      });
      ({ raw, json } = await attemptPost(requestHeaders));
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
    const { json: verifyJson } =
      await requestQwenPersonalizationInBrowser(
        accountId,
        "GET",
        "/api/v2/users/user/settings",
        requestHeaders,
      );
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
    `✅ [Qwen] Personalization synced | account=${shortAccountId(cacheKey)} | model=${metadata.model || "?"} | tools=${metadata.toolsCount ?? 0} | prompt_chars=${sent.chars ?? 0}${metadata.sessionId ? ` | chat=${metadata.sessionId.substring(0, 12)}` : ""}${matchStored === null ? "" : ` | verified=${matchStored}`}`,
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
    // Apply the FULL safe-settings patch (tools_enabled + ui + memory +
    // mcp_remind), not just tools_enabled: since the personalization POST
    // became personalization-only, nothing else applies ui/memory/mcp_remind,
    // and the sync's verified-cache check (existingSafeSettingsApplied)
    // requires ALL of them false. A live probe confirmed the combined
    // no-personalization payload is accepted by settings/update.
    const payload = QWEN_SAFE_SETTINGS_PATCH;

    // Use an isolated page only when the main page is actively serving a stream.
    // Startup/idle operations should not open a visible extra tab.
    if (accountId && !isAuthMockEnabled() && isAccountBusy(accountId)) {
      try {
        const result = await withIsolatedQwenPage(
          accountId,
          async (page) => {
            const response = await page.evaluate(
              async ({ payload, timeoutMs }: { payload: any; timeoutMs: number }) => {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                try {
                  const resp = await fetch(
                    "https://chat.qwen.ai/api/v2/users/user/settings/update",
                    {
                      method: "POST",
                      headers: {
                        accept: "application/json, text/plain, */*",
                        "content-type": "application/json",
                        "x-request-id": crypto.randomUUID(),
                        timezone: new Date().toString().split(" (")[0],
                        source: "web",
                      },
                      body: JSON.stringify(payload),
                      signal: controller.signal,
                    },
                  );
                  return { status: resp.status, body: await resp.text() };
                } finally {
                  clearTimeout(timeoutId);
                }
              },
              { payload, timeoutMs: config.timeouts.http },
            );
            return response;
          },
          qwenUrl("/"),
        );

        if (result.status < 400) {
          nativeToolsDisabled.add(cacheKey);
          return;
        }
        console.warn(
          `⚠️  [Qwen] Isolated disableNativeTools returned ${result.status} for ${cacheKey}`,
        );
      } catch (error) {
        // Fall through to standard request path
        logger.debug("[Qwen] Isolated disableNativeTools failed, using standard path", {
          accountId: cacheKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fallback: standard request path
    const { headers } = await getQwenHeaders(false, accountId);
    const requestHeaders = buildCapturedQwenHeaders(headers, {
      referer: qwenUrl("/settings/personalization"),
    });

    let lastError: string | null = null;
    for (let attempt = 1; attempt <= DISABLE_TOOLS_MAX_RETRIES; attempt++) {
      try {
        const response = await requestQwenTextInBrowser(
          accountId,
          "POST",
          "/api/v2/users/user/settings/update",
          requestHeaders,
          JSON.stringify(payload),
          {
            settingsPage: true,
            referrer: qwenUrl("/settings/personalization"),
          },
        );

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

function asModelRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Keep the upstream model object intact while adding stable normalized aliases.
 * The registry consumes `info.meta`, and adapters can still inspect fields Qwen
 * adds in the future without another parser change.
 */
function formatPublicQwenModel(model: Record<string, unknown>): PublicQwenModel {
  const info = asModelRecord(model.info);
  const metadata = {
    ...asModelRecord(model.metadata),
    ...asModelRecord(model.meta),
    ...asModelRecord(info.meta),
  };
  const capabilities = {
    ...asModelRecord(metadata.capabilities),
    ...asModelRecord(info.capabilities),
    ...asModelRecord(model.capabilities),
  };
  const id = typeof model.id === "string" ? model.id : "";
  const name =
    (typeof model.name === "string" && model.name) ||
    (typeof info.name === "string" && info.name) ||
    id;
  const createdValue = info.created_at ?? model.created;
  const created =
    typeof createdValue === "number" && Number.isFinite(createdValue)
      ? createdValue
      : Date.now();
  const contextWindow =
    typeof metadata.max_context_length === "number"
      ? metadata.max_context_length
      : undefined;
  const modality = Array.isArray(metadata.modality)
    ? metadata.modality.filter((value): value is string => typeof value === "string")
    : undefined;
  const chatType = Array.isArray(metadata.chat_type)
    ? metadata.chat_type.filter((value): value is string => typeof value === "string")
    : undefined;
  const isActive =
    typeof info.is_active === "boolean"
      ? info.is_active
      : typeof model.is_active === "boolean"
        ? model.is_active
        : undefined;

  return {
    ...model,
    id,
    name,
    object: "model",
    owned_by:
      (typeof model.owned_by === "string" && model.owned_by) || "qwen",
    created,
    ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
    capabilities,
    metadata,
    info,
    meta: metadata,
    ...(modality ? { modality } : {}),
    ...(chatType ? { chat_type: chatType } : {}),
    ...(metadata.think_skip && typeof metadata.think_skip === "object"
      ? { think_skip: metadata.think_skip as Record<string, unknown> }
      : {}),
    ...(isActive !== undefined ? { is_active: isActive } : {}),
    ...(metadata.max_summary_generation_length !== undefined
      ? { max_summary_generation_length: metadata.max_summary_generation_length }
      : {}),
    ...(metadata.max_thinking_generation_length !== undefined
      ? {
          max_thinking_generation_length:
            metadata.max_thinking_generation_length,
        }
      : {}),
  };
}

export async function deleteAllQwenChats(accountId?: string): Promise<boolean> {
  const { headers } = await getQwenHeaders(false, accountId);
  const response = await requestQwenTextInBrowser(
    accountId,
    "DELETE",
    "/api/v2/chats/",
    buildCapturedQwenHeaders(headers, {
      referer: qwenUrl("/settings/chats"),
    }),
    undefined,
    { referrer: qwenUrl("/settings/chats") },
  );

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

export async function fetchQwenModels(
  accountId?: string,
): Promise<PublicQwenModel[]> {
  const cacheKey = accountId || "global";
  const now = Date.now();
  const cached = modelsCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    syncModelMetadata(
      cached.models as unknown as Array<Record<string, unknown> & { id: string }>,
      accountId,
    );
    return cached.models;
  }

  // Use an isolated page only when the main page is actively serving a stream.
  // Startup/idle operations should not open a visible extra tab.
  if (accountId && !isAuthMockEnabled() && isAccountBusy(accountId)) {
    try {
      const result = await withIsolatedQwenPage(
        accountId,
        async (page) => {
          const response = await page.evaluate(async (timeoutMs: number) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
              const resp = await fetch("https://chat.qwen.ai/api/models", {
                method: "GET",
                headers: {
                  accept: "application/json, text/plain, */*",
                  "x-request-id": crypto.randomUUID(),
                  timezone: new Date().toString().split(" (")[0],
                  source: "web",
                },
                signal: controller.signal,
              });
              return { status: resp.status, body: await resp.text() };
            } finally {
              clearTimeout(timeoutId);
            }
          }, config.timeouts.http);
          return response;
        },
        qwenUrl("/"),
      );

      if (result.status < 400) {
        const json = JSON.parse(result.body);
        if (json.data && Array.isArray(json.data)) {
          const models = json.data
            .filter((model: unknown) => {
              const record = asModelRecord(model);
              return typeof record.id === "string" && record.id.trim().length > 0;
            })
            .map((model: unknown) => formatPublicQwenModel(asModelRecord(model)));

          replaceModelMetadata(
            models as unknown as Array<Record<string, unknown> & { id: string }>,
            accountId,
          );
          modelsCache.set(cacheKey, { models, fetchedAt: now });
          return models;
        }
      }
    } catch (error) {
      // Fall through to standard request path
      logger.debug("[Qwen] Isolated model fetch failed, using standard path", {
        accountId: cacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const { cookie, userAgent, bxV, bxUa, bxUmidtoken } =
    await getBasicHeaders(accountId);

  const response = await requestQwenTextInBrowser(
    accountId,
    "GET",
    "/api/models",
    buildQwenRequestHeaders({
      cookie,
      userAgent,
      bxV,
      bxUa,
      bxUmidtoken,
      extra: {
        timezone: new Date().toString(),
      },
    }),
    undefined,
    { referrer: qwenUrl("/") },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models from Qwen: ${response.status} ${response.statusText}`,
    );
  }

  const json = await response.json();
  if (json.data && Array.isArray(json.data)) {
    // Keep only upstream/base entries here. The public `-fast` variant is
    // generated exactly once by the public models endpoint after metadata has
    // been synchronized.
    const models = json.data
      .filter((model: unknown) => {
        const record = asModelRecord(model);
        return typeof record.id === "string" && record.id.trim().length > 0;
      })
      .map((model: unknown) => formatPublicQwenModel(asModelRecord(model)));

    replaceModelMetadata(
      models as unknown as Array<Record<string, unknown> & { id: string }>,
      accountId,
    );
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
      const error = new RetryableQwenStreamError(
        `Qwen anti-bot: ${retStr.substring(0, 200)}`,
        0,
      );
      error.upstreamCode = "waf_challenge";
      return error;
    }
  }

  const details =
    errorJson?.data?.details ||
    errorJson?.message ||
    errorJson?.error?.message ||
    "Qwen returned an error";

  if (typeof details === "string" && isQwenChatNotExistMessage(details)) {
    const attempt = errorJson?.data?.retryCount ?? 1;
    const error = new RetryableQwenStreamError(
      `Qwen: ${details}`,
      retryDelay(attempt),
    );
    error.upstreamCode = "chat_not_exist";
    return error;
  }

  // Anti-bot detection: FAIL_SYS_USER_VALIDATE / RGV587_ERROR
  if (
    typeof details === "string" &&
    (details.includes("FAIL_SYS_USER_VALIDATE") ||
      details.includes("RGV587_ERROR") ||
      details.includes("user validate"))
  ) {
    const error = new RetryableQwenStreamError(
      `Qwen anti-bot: ${details}`,
      0,
    );
    error.upstreamCode = "waf_challenge";
    return error;
  }

  if (
    typeof details === "string" &&
    (details.toLowerCase().includes("chat is in progress") ||
      details.toLowerCase().includes("the chat is in progress"))
  ) {
    const attempt = errorJson?.data?.retryCount ?? 1;
    const error = new RetryableQwenStreamError(
      `Qwen: ${details}`,
      retryDelay(attempt),
    );
    error.upstreamCode = "chat_in_progress";
    return error;
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

/**
 * Headers for the completions POST (browser relay). Reuses
 * buildCapturedQwenHeaders (cookie, origin, referer with the chat id,
 * sec-ch-ua, version, bx-v, source) and additionally injects
 * bx-ua/bx-umidtoken when captured — the real client POSTs completions WITH
 * them (0.2.86 HAR, network/), so the relay matches the browser client.
 *
 * NOTE: a direct Node-side fetch was tried and removed — the Qwen WAF
 * fingerprints the HTTP stack beyond headers and JA3 (live probes: blocked
 * with no headers at all AND with a chrome_136 TLS profile), so completions
 * must go through the browser. The settings endpoints have no such WAF and
 * use direct Node fetch (requestQwenSettingsDirectFetch).
 */
export function buildCompletionHeaders(
  headers: Record<string, string>,
  chatSessionId: string | null | undefined,
): Record<string, string> {
  const base = buildCapturedQwenHeaders(headers, {
    chatSessionId: chatSessionId || null,
    extra: {
      "x-accel-buffering": "no",
    },
  });
  if (headers["bx-ua"]) base["bx-ua"] = headers["bx-ua"];
  if (headers["bx-umidtoken"]) base["bx-umidtoken"] = headers["bx-umidtoken"];
  return base;
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
    reasoningMode?: "auto" | "thinking" | "fast";
    /** Auxiliary stream (title on its own chat): short idle cap. */
    parallelEscape?: boolean;
    /** "thread" (chat_mode:"normal") or "temp" (chat_mode:"local"). */
    chatMode?: ChatMode;
  },
  signal?: AbortSignal,
): Promise<{
  stream: ReadableStream;
  headers: Record<string, string>;
  uiSessionId: string;
  controller: AbortController;
  accountId: string;
  createdNewChat: boolean;
  tokenEstimationContext: TokenEstimationContext;
}> {
  if (signal?.aborted) {
    throw new Error("client aborted before stream creation");
  }
  // Take a stream slot for the account (up to maxStreamsPerAccount concurrent;
  // the relay multiplexes them on the page via reqId).
  const streamLockKey = accountId || "global";
  const startedAt = Date.now();
  const releaseStreamLock = await acquireAccountStreamLock(streamLockKey);
  if (logger.isLevelEnabled("info")) {
    console.log(
      `⏱️ [Qwen] Create: stream-lock | account=${accountId ?? "global"} | +${Date.now() - startedAt}ms`,
    );
  }
  let streamLockReleased = false;
  const releaseStreamLockOnce = () => {
    if (streamLockReleased) return;
    streamLockReleased = true;
    releaseStreamLock();
  };

  // A signal can fire while this attempt waited in the stream-lock queue
  // (client disconnect, same-session supersede, or the acquire deadline
  // aborting the race loser). Re-check AFTER the lock: a race-lost orphan must
  // not proceed to make a full upstream request while unobserved (it would hold
  // the lock for minutes and burn a Qwen request).
  if (signal?.aborted) {
    releaseStreamLockOnce();
    throw new Error("client aborted before stream creation");
  }

  try {
    return await createQwenStreamInternal(
      prompt,
      enableThinking,
      modelId,
      forcedParentId,
      accountId,
      files,
      options,
      signal,
      releaseStreamLockOnce,
      startedAt,
    );
  } catch (error) {
    releaseStreamLockOnce();
    throw error;
  }
}

async function createQwenStreamInternal(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId: string | null | undefined,
  accountId: string | undefined,
  files: QwenFileEntry[] | undefined,
  options: {
    chatSessionId?: string | null;
    forceNewChat?: boolean;
    reasoningMode?: "auto" | "thinking" | "fast";
    /** Auxiliary stream (title on its own chat): short idle cap. */
    parallelEscape?: boolean;
    /** "thread" (chat_mode:"normal") or "temp" (chat_mode:"local"). */
    chatMode?: ChatMode;
  } | undefined,
  signal: AbortSignal | undefined,
  releaseStreamLock: () => void,
  /** Wall-clock start of the acquire (used for per-phase +Xms telemetry). */
  startedAt: number,
): Promise<{
  stream: ReadableStream;
  headers: Record<string, string>;
  uiSessionId: string;
  controller: AbortController;
  accountId: string;
  createdNewChat: boolean;
  tokenEstimationContext: TokenEstimationContext;
}> {
  const ensureNotAborted = () => {
    if (signal?.aborted) {
      // Aborted by the client OR by a same-session supersede (latest-wins).
      // Typed as ClientAbortedError so the retry policy treats it as a silent
      // client abort instead of a retryable stream_aborted — a superseded
      // request must not resend full context on another account.
      throw new ClientAbortedError("client aborted before completion request");
    }
  };

  const phase = (name: string) => {
    if (logger.isLevelEnabled("info")) {
      console.log(
        `⏱️ [Qwen] Create: ${name} | account=${accountId ?? "global"} | +${Date.now() - startedAt}ms`,
      );
    }
  };

  // A new logical chat session should reuse the warmed header cache when available.
  // Header recapture is much more expensive and should be reserved for real refresh/login cases,
  // not for ordinary first prompts that simply need parent_id reset.
  const captured = await getQwenHeaders(
    options?.forceNewChat === true,
    accountId,
  );
  ensureNotAborted();
  phase("headers");
  const { headers, parentMessageId } = captured;
  let activeHeaders = headers;
  // The upstream always receives the real base model ID. Reasoning mode is
  // selected exclusively by feature_config, not by a synthetic model suffix.
  const model = mapClientModelToQwen(modelId);
  let createdNewChat = false;
  let chatSessionId: string | null | undefined;
  let leasedWarmChat = false;
  if (options && "chatSessionId" in options) {
    if (options.chatSessionId === null || options.chatSessionId === "") {
      const acquired = await acquireNewQwenChatSession(
        headers,
        model,
        accountId,
        options?.chatMode ?? "thread",
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
        options?.chatMode ?? "thread",
      );
      chatSessionId = acquired.chatId;
      leasedWarmChat = acquired.leasedFromPool;
      createdNewChat = true;
    }
  }

  ensureNotAborted();
  phase("chat");

  let warmChatReleased = false;
  const releaseLeasedWarmChat = () => {
    if (!leasedWarmChat || warmChatReleased || !chatSessionId) return;
    warmChatReleased = true;
    releaseWarmChat(accountId, model, chatSessionId);
  };

  // Combined cleanup: release warm chat AND stream lock
  const releaseStreamResources = () => {
    releaseLeasedWarmChat();
    releaseStreamLock();
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
              releaseStreamResources();
              streamController.close();
              return;
            }
            streamController.enqueue(value);
          } catch (error) {
            releaseStreamResources();
            streamController.error(error);
          }
        },
        cancel(reason) {
          releaseStreamResources();
          return stream.cancel(reason);
        },
      });
    }

    // Dynamic idle timeout based on model type and payload size
    // Reasoning models (thinking enabled): use REASONING_MODEL_TIMEOUT as base
    // Non-reasoning models: use IDLE_STREAM_TIMEOUT as base
    // Both add 30s per MB of payload. Parallel-escape streams get a tight cap
    // ONLY when non-thinking (see computeDynamicIdleTimeout).
    const baseTimeoutMs = enableThinking
      ? config.timeouts.reasoningModelTimeout
      : config.timeouts.idleStreamTimeout;
    const dynamicIdleTimeoutMs = computeDynamicIdleTimeout({
      enableThinking,
      parallelEscape: options?.parallelEscape,
      baseTimeoutMs,
      payloadSize,
    });

    logger.debug("[Qwen] dynamic idle timeout", {
      chatId: chatSessionId || "new",
      model: modelId,
      enableThinking,
      payloadMB: payloadMB.toFixed(2),
      baseTimeout: baseTimeoutMs,
      dynamicTimeout: dynamicIdleTimeoutMs,
    });

    // Thinking models idle at 600s — fine for gaps AFTER data flows, but a
    // stream that produced NOTHING in the first-chunk window is dead. Fail
    // fast (retryable) so the account slot is not held for 10 minutes.
    const firstChunkDeadlineMs = enableThinking
      ? Math.max(
          config.timeouts.firstChunkTimeout,
          config.timeouts.timeToFirstByte,
        )
      : undefined;

    return addIdleTimeoutToStream(
      stream,
      controller,
      dynamicIdleTimeoutMs,
      `Qwen stream ${chatSessionId || "unknown"}`,
      releaseStreamResources,
      releaseStreamResources,
      firstChunkDeadlineMs,
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
    chat_mode: options?.chatMode === "temp" ? "local" : "normal",
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
        feature_config: (() => {
          // Determine reasoning mode: explicit option takes precedence, otherwise derive from enableThinking
          // - reasoningMode="auto": Qwen decides (auto_thinking=true, thinking_mode="Auto")
          // - reasoningMode="thinking": force thinking ON (thinking_mode="Thinking")
          // - reasoningMode="fast": force thinking OFF (thinking_mode="Fast")
          // - No reasoningMode + enableThinking=false: legacy "fast" mode
          // - No reasoningMode + enableThinking=true: legacy "thinking" mode
          const mode = options?.reasoningMode ?? (enableThinking ? "thinking" : "fast");
          const thinkingMode = mode === "thinking" ? "Thinking" : mode === "fast" ? "Fast" : "Auto";
          const thinkingEnabled = mode !== "fast";
          return {
            thinking_enabled: thinkingEnabled,
            output_schema: "phase",
            research_mode: "normal",
            auto_thinking: mode === "auto",
            thinking_mode: thinkingMode,
            ...(thinkingEnabled ? { thinking_format: "summary" } : {}),
            auto_search: true,
          };
        })(),
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

  // Debug-only: textSize hashes/scans the whole prompt and the preview runs a
  // full-string regex, so build the payload only when it will actually log.
  if (logger.isLevelEnabled("debug")) {
    logger.debug("[Qwen] chat payload", {
      accountId: accountId ?? "global",
      model,
      chatId: chatSessionId || "new",
      parentId: actualParentId || null,
      content: textSize(prompt),
      preview: prompt.replace(/\s+/g, " ").trim().slice(0, 160),
    });
  }

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
  const dynamicTimeoutMs = enableThinking
    ? Math.max(
        config.timeouts.reasoningModelTimeout,
        BASE_TIMEOUT_MS + Math.ceil(payloadMB * TIMEOUT_PER_MB),
      )
    : BASE_TIMEOUT_MS + Math.ceil(payloadMB * TIMEOUT_PER_MB);
  // Keep the total generation budget separate from the browser bridge startup
  // and first-response-header deadlines. The bridge releases the account page
  // mutex immediately; this budget only bounds the request lifecycle.
  const browserStreamBudgetMs = Math.max(
    config.timeouts.page,
    Math.min(
      dynamicTimeoutMs,
      config.timeouts.totalRequestTimeout > 0
        ? config.timeouts.totalRequestTimeout
        : dynamicTimeoutMs,
    ),
  );

  const url = chatSessionId
    ? qwenUrl(`/api/v2/chat/completions?chat_id=${encodeURIComponent(chatSessionId)}`)
    : qwenUrl("/api/v2/chat/completions");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), dynamicTimeoutMs);
  // Propagate client/supersede aborts to the upstream fetch IMMEDIATELY: the
  // internal controller is otherwise only aborted by the dynamic timeout, so a
  // superseded generation would keep running — and keep holding the chat lock
  // — until the idle timeout (180s+) instead of dying instantly.
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const fetchCompletion = async (requestHeaders: Record<string, string>): Promise<Response> => {
      return createQwenBrowserResponse(
        accountId,
        url,
        "POST",
        // The 0.2.86 HAR shows the real client POSTs completions with
        // bx-ua/bx-umidtoken + x-accel-buffering, so the relay matches it
        // instead of relying on sendBxUa.
        buildCompletionHeaders(requestHeaders, chatSessionId),
        payloadJson,
        controller.signal,
        qwenUrl(
          chatSessionId
            ? `/c/${encodeURIComponent(chatSessionId)}`
            : "/",
        ),
        browserStreamBudgetMs,
      );
    };

    let response!: Response;
    let captchaRecoveryAttempted = false;
    const retryAfterCaptchaRecovery = async (
      label: string,
      challengeBody: string,
    ): Promise<boolean> => {
      if (captchaRecoveryAttempted || !accountId) return false;
      captchaRecoveryAttempted = true;

      const solved = await recoverBaxiaCaptcha(accountId, label, {
        challengeBody,
      });
      if (!solved) return false;

      // The challenge may have rotated bx-* values or session cookies. Refresh
      // them only after the visible challenge was solved, then replay the same
      // payload on the same account.
      const refreshed = await getQwenHeaders(true, accountId);
      activeHeaders = refreshed.headers;
      if (config.captcha.retryDelayMs > 0) {
        await sleep(config.captcha.retryDelayMs);
      }
      ensureNotAborted();
      response = await fetchCompletion(activeHeaders);
      return true;
    };

    let captchaMetadataRetryAttempted = false;
    const throwFetchCompletionError = (error: unknown): never => {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Treat network errors (fetch failed, timeout, DNS, first-byte stall,
      // etc.) as retryable so account rotation kicks in instead of a terminal
      // 500 that forces the client to retry in a loop ("request hangs").
      if (isRetryableFetchErrorMessage(errorMsg) || error instanceof TypeError) {
        throw withCreatedChatMetadata(new QwenNetworkError(errorMsg));
      }
      throw withCreatedChatMetadata(
        error instanceof Error ? error : new Error(errorMsg),
      );
    };

    try {
      ensureNotAborted();
      phase("fetch");
      response = await fetchCompletion(activeHeaders);
    } catch (error) {
      // The challenge was solved while waiting for headers, but the original
      // background fetch did not resume. Replay the same payload on the same
      // account with fresh headers instead of failing as an unknown error.
      if (
        (error as any)?.captchaSolvedDuringMetadata &&
        accountId &&
        !captchaMetadataRetryAttempted
      ) {
        captchaMetadataRetryAttempted = true;
        logger.warn(
          "[Qwen] Completion headers timed out after captcha recovery; retrying with fresh headers",
          {
            accountId,
            chatId: chatSessionId ?? "new",
          },
        );
        const refreshed = await getQwenHeaders(true, accountId);
        activeHeaders = refreshed.headers;
        if (config.captcha.retryDelayMs > 0) {
          await sleep(config.captcha.retryDelayMs);
        }
        try {
          ensureNotAborted();
          response = await fetchCompletion(activeHeaders);
        } catch (retryError) {
          throwFetchCompletionError(retryError);
        }
      } else {
        throwFetchCompletionError(error);
      }
    }

    let responseContentType = response.headers.get("content-type") || "";
    let retriedNonSseResponse = false;

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
          (await retryAfterCaptchaRecovery(
            `chat ${chatSessionId ?? "new"}`,
            preview,
          ))
        ) {
          retriedNonSseResponse = true;
          continue;
        }

        if (!antiBotChallenge && !retriedNonSseResponse) {
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
            (await retryAfterCaptchaRecovery(
              `chat ${chatSessionId ?? "new"}`,
              errText,
            ))
          ) {
            retriedNonSseResponse = true;
            continue;
          }

          if (!antiBotChallenge && !retriedNonSseResponse) {
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

    phase("metadata");

    if (logger.isLevelEnabled("info")) {
      // What the upstream actually received: new vs reused chat, warm-pool
      // lease, payload weight, parent chain. The 📤 line shows the client view;
      // this is the upstream-facing counterpart.
      console.log(
        `⏱️ [Qwen] Create: ready | account=${accountId ?? "global"} | chat=${(chatSessionId ?? "new").substring(0, 12)} | ${createdNewChat ? "new-chat" : "reuse"}${leasedWarmChat ? " | warm-pool" : ""} | payload=${payloadSize}B | parent=${actualParentId ? actualParentId.substring(0, 8) : "none"} | +${Date.now() - startedAt}ms`,
      );
    }

    if (!response.ok || !response.body) {
      const contentType = response.headers.get("content-type") || "";
      const errText = contentType.includes("application/json")
        ? await response.text().catch(() => "")
        : await readResponsePreview(response);
      const antiBotChallenge = isWafChallengeResponse(errText);

      if (
        antiBotChallenge &&
        (await retryAfterCaptchaRecovery(
          `chat ${chatSessionId ?? "new"}`,
          errText,
        ))
      ) {
        const recoveredContentType = response.headers.get("content-type") || "";
        if (
          response.ok &&
          response.body &&
          recoveredContentType.includes("text/event-stream")
        ) {
          return {
            stream: wrapUpstreamStream(response.body, controller),
            headers: activeHeaders,
            uiSessionId: chatSessionId || "",
            controller,
            accountId: accountId ?? "global",
            createdNewChat,
            tokenEstimationContext,
          };
        }
      }

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
    releaseStreamResources();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onExternalAbort);
    clearTimeout(timeoutId);
  }
}
