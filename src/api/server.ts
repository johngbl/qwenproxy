import crypto from "crypto";
import net from "node:net";
import { v4 as uuidv4 } from "uuid";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { config } from "../core/config.js";
import { metrics } from "../core/metrics.js";
import { logger, maskEmail } from "../core/logger.js";
import { MemoryCache } from "../cache/memory-cache.js";
import { Watchdog } from "../core/watchdog.js";
import { getAccountCooldownInfo } from "../core/account-manager.js";
import { app as modelsApp } from "./models.js";
import { chatCompletions, chatCompletionsStop } from "../routes/chat.js";
import { uploadFile } from "../routes/upload.js";
import { imagesGenerations } from "../routes/images.js";
import { videosGenerations, videoTaskStatus } from "../routes/videos.js";
import { responsesApp } from "../routes/responses/index.js";
import { completionsLegacy } from "../routes/completions.js";
import { anthropicApp } from "../routes/anthropic/index.ts";
import { sendOpenAIError } from "./error-helpers.js";
import { AuthError, NotFoundError } from "../core/errors.js";
import type { QwenAccount } from "../core/accounts.js";
import { isAuthMockEnabled } from "../services/auth-playwright.js";

// Module-level state (initialized in startServer)
let cache: MemoryCache | undefined;
let watchdog: Watchdog | undefined;
let server: any;
let startPromise: Promise<StartedServerInfo> | null = null;
let stopPromise: Promise<void> | null = null;
let signalHandlersInstalled = false;

const app = new Hono();

function formatAccountId(accountId: string): string {
  const normalized = accountId.trim();
  return normalized.length > 12 ? `${normalized.slice(0, 12)}…` : normalized;
}

function buildPortInUseMessage(port: number, host: string): string {
  return (
    `❌ [Server] Port ${port} is already in use (${host}:${port}).` +
    `\n   Another QwenProxy instance (or another program) is listening on this port.` +
    `\n   Stop the other instance first, or start on another port: PORT=3001 npm start`
  );
}

/**
 * Pre-flight port check run BEFORE the slow account warmup so a conflicting
 * listener fails in <1s with an explanatory message instead of crashing the
 * process minutes later after the warmup completes.
 */
async function assertPortAvailable(): Promise<void> {
  const { port, host } = config.server;
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        reject(new Error(buildPortInUseMessage(port, host)));
      } else {
        reject(err);
      }
    });
    probe.once("listening", () => probe.close(() => resolve()));
    probe.listen(port, host);
  });
}

export function setCacheForTesting(nextCache: MemoryCache | undefined): void {
  cache = nextCache;
}

// Middleware must be registered BEFORE routes

// CORS: browser-based clients (OpenWebUI, web frontends on another origin)
// preflight before the Authorization header is sent, so OPTIONS short-circuits
// BEFORE the /v1/* auth middleware. Default is permissive (doc checklist item
// 2); set CORS_ORIGIN to lock it down.
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", corsOrigin);
  c.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  c.header(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Request-Id, x-api-key, OpenAI-Organization, OpenAI-Project, X-Client-Request-Id",
  );
  c.header(
    "Access-Control-Expose-Headers",
    "X-Request-Id, X-Response-Time, openai-version, openai-processing-ms, x-ratelimit-limit-requests, x-ratelimit-remaining-requests, x-ratelimit-reset-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-tokens, x-ratelimit-reset-tokens",
  );
  if (c.req.method === "OPTIONS") {
    // Hono does not merge c.header() values into a manually constructed
    // Response, so the preflight carries its CORS headers explicitly.
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, X-Request-Id, x-api-key, OpenAI-Organization, OpenAI-Project, X-Client-Request-Id",
        "Access-Control-Expose-Headers":
          "X-Request-Id, X-Response-Time, openai-version, openai-processing-ms, x-ratelimit-limit-requests, x-ratelimit-remaining-requests, x-ratelimit-reset-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-tokens, x-ratelimit-reset-tokens",
      },
    });
  }
  await next();
});

app.use("*", async (c, next) => {
  const requestId = c.req.header("X-Request-Id") || uuidv4();
  c.header("X-Request-Id", requestId);

  // OpenAI-shaped response headers (doc §5.2): API version, processing time,
  // and static rate-limit windows so tools that parse x-ratelimit-* don't choke.
  c.header("openai-version", "2020-10-01");
  const ratelimit = config.server.rateLimit;
  c.header("x-ratelimit-limit-requests", String(ratelimit.requests));
  c.header(
    "x-ratelimit-remaining-requests",
    String(Math.max(0, ratelimit.requests - 1)),
  );
  c.header("x-ratelimit-reset-requests", "0");
  c.header("x-ratelimit-limit-tokens", String(ratelimit.tokens));
  c.header(
    "x-ratelimit-remaining-tokens",
    String(Math.max(0, ratelimit.tokens - 1)),
  );
  c.header("x-ratelimit-reset-tokens", "0");

  metrics.increment("requests.total");
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  metrics.histogram("latency.request", duration);
  c.header("X-Response-Time", `${duration}ms`);
  c.header("openai-processing-ms", String(duration));
});

function constantTimeStringEqual(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  const providedHash = crypto.createHash("sha256").update(providedBuf).digest();
  const expectedHash = crypto.createHash("sha256").update(expectedBuf).digest();

  return (
    crypto.timingSafeEqual(providedHash, expectedHash) &&
    providedBuf.length === expectedBuf.length
  );
}

/**
 * Accept OpenAI-style Bearer and x-api-key.
 * Either may authenticate when API_KEY is configured.
 */
function extractProvidedApiKeys(c: Context): string[] {
  const keys: string[] = [];
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) keys.push(token);
  }
  const xApiKey = c.req.header("x-api-key")?.trim();
  if (xApiKey) keys.push(xApiKey);
  return keys;
}

function verifyApiKey(c: Context): Response | null {
  const apiKey = process.env.API_KEY || config.apiKey;
  if (!apiKey) return null;

  const candidates = extractProvidedApiKeys(c);
  const isAnthropic =
    c.req.path.startsWith("/v1/messages") ||
    !!c.req.header("anthropic-version");

  if (candidates.length === 0) {
    if (isAnthropic) {
      c.header("anthropic-version", c.req.header("anthropic-version") || "2023-06-01");
      return c.json(
        {
          type: "error",
          error: {
            type: "authentication_error",
            message: "Missing or invalid credentials (Authorization Bearer or x-api-key)",
          },
        },
        401,
      );
    }
    return sendOpenAIError(
      c,
      new AuthError(
        "Missing or invalid credentials (Authorization Bearer or x-api-key)",
      ),
    );
  }
  if (candidates.some((token) => constantTimeStringEqual(token, apiKey))) {
    return null;
  }
  if (isAnthropic) {
    c.header("anthropic-version", c.req.header("anthropic-version") || "2023-06-01");
    return c.json(
      {
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid API key",
        },
      },
      401,
    );
  }
  return sendOpenAIError(c, new AuthError("Invalid API key"));
}
app.use("/v1/*", async (c, next) => {
  const error = verifyApiKey(c);
  if (error) return error;
  await next();
});

// Routes
app.route("", modelsApp);
app.post("/v1/chat/completions", chatCompletions);
app.post("/v1/chat/completions/stop", chatCompletionsStop);
app.post("/v1/completions", completionsLegacy);
app.post("/v1/upload", uploadFile);
app.post("/v1/images/generations", imagesGenerations);
app.post("/v1/videos/generations", videosGenerations);
app.get("/v1/tasks/status/:taskId", videoTaskStatus);

// OpenAI Responses API compatible routes
app.route("", responsesApp);
app.route("", anthropicApp);

// Accept paths without the /v1 prefix via a 308 redirect (method + body are
// preserved on redirect). Most clients append /v1 themselves; the redirect
// covers the rest without duplicating handlers.
const LEGACY_REDIRECTS: Array<[string, string]> = [
  ["/chat/completions", "/v1/chat/completions"],
  ["/completions", "/v1/completions"],
  ["/responses", "/v1/responses"],
  ["/models", "/v1/models"],
  ["/messages", "/v1/messages"],
  ["/messages/count_tokens", "/v1/messages/count_tokens"],
];
for (const [from, to] of LEGACY_REDIRECTS) {
  app.all(from, (c) => c.redirect(to, 308));
}

app.get("/health", async (c) => {
  const status = await watchdog?.getStatus();
  return c.json({
    status: status?.overall || "unknown",
    ram: status?.ram || "unknown",
    streams: status?.streams || "unknown",
    heap: status?.heap
      ? {
          used: status.heap.heapUsed,
          total: status.heap.heapTotal,
          limit: status.heap.heapSizeLimit,
          rss: status.heap.rss,
          usagePercent: Number(status.heap.usagePercent.toFixed(2)),
        }
      : undefined,
    timestamp: Date.now(),
    metrics: {
      cache: await cache?.getStats(),
    },
  });
});

// Token TTL diagnostics: inspect real cookie/header lifetimes
app.get("/diagnostics/tokens", async (c) => {
  const error = verifyApiKey(c);
  if (error) return error;

  const { getTokenDiagnostics } = await import("../services/playwright.ts");
  const accountId = c.req.query("accountId");

  try {
    const diagnostics = await getTokenDiagnostics(accountId);
    return c.json(diagnostics);
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

app.get("/metrics", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  return c.text(metrics.formatPrometheus(), {
    headers: { "Content-Type": "text/plain; version=0.0.4" },
  });
});

app.onError((err, c) => {
  const requestId = c.req.header("X-Request-Id") || "unknown";
  metrics.increment("requests.errors");
  logger.error("API Error", {
    requestId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return sendOpenAIError(c, err);
});

app.notFound((c) => sendOpenAIError(c, new NotFoundError("Not found")));

export interface StartedServerInfo {
  host: string;
  port: number;
  url: string;
}

function buildStartedServerInfo(): StartedServerInfo {
  const host =
    config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  return {
    host,
    port: config.server.port,
    url: `http://${host}:${config.server.port}`,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function warmConfiguredChatPools(
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>,
  accountId?: string,
): Promise<void> {
  await Promise.all(
    config.qwen.chatPoolModels.map((model) =>
      warmQwenChatPool(accountId, model).catch(() => {}),
    ),
  );
}

async function prepareQwenRuntime(params: {
  accountId?: string;
  successMessage: string;
  failureMessage: string;
  initAuth: () => Promise<void>;
  disableNativeTools: (accountId?: string) => Promise<void>;
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>;
}): Promise<boolean> {
  if (params.accountId) {
    const { getAccountCooldownInfo } =
      await import("../core/account-manager.ts");
    const cooldownInfo = getAccountCooldownInfo(params.accountId);
    if (cooldownInfo) {
      console.warn(
        `⚠️ [Server] Account not ready | account=${formatAccountId(params.accountId)} | cooldown=${Math.ceil(cooldownInfo.remainingMs / 1000)}s | reason=${cooldownInfo.reason}`,
      );
      return false;
    }
  }

  try {
    await params.initAuth();
    await params.disableNativeTools(params.accountId).catch(() => {});
    await warmConfiguredChatPools(params.warmQwenChatPool, params.accountId);
    if (params.accountId) {
      const { getAccountCooldownInfo } =
        await import("../core/account-manager.ts");
      const cooldownInfo = getAccountCooldownInfo(params.accountId);
      if (cooldownInfo) {
        console.warn(
          `⚠️ [Server] Account not ready | account=${formatAccountId(params.accountId)} | cooldown=${Math.ceil(cooldownInfo.remainingMs / 1000)}s | reason=${cooldownInfo.reason}`,
        );
        return false;
      }
    }
    return true;
  } catch (error) {
    console.warn(`❌ ${params.failureMessage}`, getErrorMessage(error));
    if (params.accountId) {
      const { markAccountRateLimited } =
        await import("../core/account-manager.ts");
      markAccountRateLimited(
        params.accountId,
        config.concurrency.initFailureCooldownMs,
        "AuthInitFailed",
      );
    }
    return false;
  }
}

async function prepareAccountRuntime(
  account: QwenAccount,
  getAccountCredentials: (accountId: string) => QwenAccount | undefined,
  initPlaywrightForAccount: (
    account: QwenAccount,
    headless: boolean,
    browserType?: "chromium" | "chrome" | "edge",
  ) => Promise<void>,
  disableNativeTools: (accountId?: string) => Promise<void>,
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>,
): Promise<boolean> {
  return prepareQwenRuntime({
    accountId: account.id,
    successMessage: `[Server] Account ready: ${maskEmail(account.email)}`,
    failureMessage: `[Server] Account init failed ${maskEmail(account.email)}:`,
    initAuth: () => {
      const credentials = getAccountCredentials(account.id);
      if (!credentials) {
        throw new Error(`Account ${account.id} credentials not found`);
      }
      return initPlaywrightForAccount(
        credentials,
        config.playwright.headless,
        config.playwright.browser,
      );
    },
    disableNativeTools,
    warmQwenChatPool,
  });
}

async function prepareRemainingAccountsInBackground(params: {
  accounts: QwenAccount[];
  batchSize: number;
  totalAccounts: number;
  getAccountCredentials: (accountId: string) => QwenAccount | undefined;
  initPlaywrightForAccount: (
    account: QwenAccount,
    headless: boolean,
    browserType?: "chromium" | "chrome" | "edge",
  ) => Promise<void>;
  disableNativeTools: (accountId?: string) => Promise<void>;
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>;
}): Promise<void> {
  const remaining = params.accounts;
  if (remaining.length === 0) return;

  // First account was already prepared successfully (displayed as 1/N),
  // so remaining accounts start at display index 2.
  let nextDisplayIndex = 2;
  for (let i = 0; i < remaining.length; i += params.batchSize) {
    const batch = remaining.slice(i, i + params.batchSize);
    const batchDisplayStart = nextDisplayIndex;
    nextDisplayIndex += batch.length;

    await Promise.all(
      batch.map((account, batchIndex) =>
        prepareAccountRuntime(
          account,
          params.getAccountCredentials,
          params.initPlaywrightForAccount,
          params.disableNativeTools,
          params.warmQwenChatPool,
        ).then((ok) => {
          if (ok) {
            const displayIndex = batchDisplayStart + batchIndex;
            console.log(
              `✅ [Server] Account ready (${displayIndex}/${params.totalAccounts}): ${maskEmail(account.email)}`,
            );
          }
          return ok;
        }),
      ),
    );
  }
}

async function cleanupServerResources(): Promise<void> {
  watchdog?.stop();
  watchdog = undefined;
  metrics.stopCollection();

  try {
    await cache?.close();
  } finally {
    cache = undefined;
  }

  try {
    const { stopSessionKeeper } = await import("../services/session-keeper.ts");
    stopSessionKeeper();
  } catch {
    // Session keeper may not have been initialized.
  }

  if (config.qwen.deleteAllChatsOnShutdown) {
    try {
      const { deleteChatsForConfiguredAccounts } =
        await import("../services/chat-cleanup.ts");
      const result = await deleteChatsForConfiguredAccounts();
      console.log(
        `🗑️  [Server] Deleted Qwen chats on shutdown: ${result.succeeded}/${result.attempted} scope(s)`,
      );
    } catch (error) {
      console.error(
        `❌ [Server] Failed to delete Qwen chats on shutdown:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const { closeAllPlaywright } = await import("../services/playwright.ts");
  await closeAllPlaywright();

  const activeServer = server;
  server = undefined;
  if (activeServer?.close) {
    // Drain in-flight requests BEFORE flushing: a request finishing during the
    // drain can still call updateLogicalThreadState, and its debounced write
    // must land in SQLite while the DB is still open.
    await new Promise<void>((resolve) => {
      try {
        if (activeServer.close.length > 0) {
          activeServer.close(() => resolve());
        } else {
          activeServer.close();
          resolve();
        }
      } catch {
        resolve();
      }
    });
  }

  const { flushLogicalThreadState } = await import("../services/qwen.ts");
  try {
    // Debounced logical-thread upserts must land before the DB closes.
    flushLogicalThreadState();
  } catch {
    // Persistence is best-effort; the in-memory cache already served this run.
  }

  const { closeDatabase } = await import("../core/database.ts");
  closeDatabase();
}

async function handleSignal(signal: string): Promise<never> {
  console.log(
    `🛑 [Server] Shutdown | ${signal}`,
  );
  await stopServer();
  process.exit(0);
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  process.on("SIGINT", () => {
    void handleSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    void handleSignal("SIGTERM");
  });
  signalHandlersInstalled = true;
}

export async function stopServer(): Promise<void> {
  if (stopPromise) {
    await stopPromise;
    return;
  }

  stopPromise = (async () => {
    if (!server && !cache && !watchdog) return;
    await cleanupServerResources();
  })();

  try {
    await stopPromise;
  } finally {
    stopPromise = null;
  }
}

export async function startServer(options?: {
  installSignalHandlers?: boolean;
}): Promise<StartedServerInfo> {
  if (server) {
    if (options?.installSignalHandlers !== false) installSignalHandlers();
    return buildStartedServerInfo();
  }

  if (startPromise) {
    return startPromise;
  }

  startPromise = (async () => {
    cache = new MemoryCache();
    await cache.connect();

    if (!config.apiKey && config.server.host === "0.0.0.0") {
      // API key status will be shown in startup banner
    }

    const { loadAccounts, getAccountCredentials } =
      await import("../core/accounts.ts");
    const accounts = loadAccounts();

    if (accounts.length === 0 && !isAuthMockEnabled()) {
      throw new Error(
        "❌ [Server] No Qwen accounts configured. Configure an account with `npm run login`, the QWEN_ACCOUNTS environment variable, or the accounts database before starting the server.",
      );
    }

    // Fail fast on a taken port (the most common startup crash) BEFORE the
    // slow account warmup — the previous behavior bound only after warmup and
    // then crashed with a raw Node stack trace minutes into startup.
    await assertPortAvailable();

    // Restore persisted cooldowns (e.g. daily quota windows) from the database
    // instead of wiping them on restart — retrying a still-rate-limited account
    // wastes a request and immediately re-trips the same limit. Expired
    // entries are dropped lazily by the cooldown lookup.
    const { syncCooldownsFromDb } =
      await import("../core/account-manager.ts");
    syncCooldownsFromDb(accounts);

    const { getAccountsByPriority } =
      await import("../core/account-priority.ts");

    const { disableNativeTools, warmQwenChatPool } =
      await import("../services/qwen.ts");
    const { initPlaywrightForAccount, isPlaywrightInitialized } =
      await import("../services/playwright.ts");

    const BATCH_SIZE = config.playwright.initBatchSize;

    if (accounts.length > 0) {
      let readyAccountId: string | null = null;
      const totalAccounts = accounts.length;

      // Warm accounts in priority order (recently successful accounts first),
      // skipping accounts still on cooldown, so the startup account matches
      // the one request routing will pick first.
      const warmOrder = getAccountsByPriority(accounts).filter(
        (account) => !getAccountCooldownInfo(account.id),
      );

      for (let i = 0; i < warmOrder.length; i++) {
        const ok = await prepareAccountRuntime(
          warmOrder[i],
          getAccountCredentials,
          initPlaywrightForAccount,
          disableNativeTools,
          warmQwenChatPool,
        );
        if (ok) {
          console.log(
            `✅ [Server] Account ready (${i + 1}/${totalAccounts}): ${maskEmail(warmOrder[i].email)}`,
          );
          readyAccountId = warmOrder[i].id;
          break;
        }
      }

      const remainingAccounts = accounts.filter(
        (account) => account.id !== readyAccountId,
      );
      if (readyAccountId === null) {
        console.warn(
          `⚠️  [Server] No account ready during startup; continuing in background`,
        );
      }

      if (config.playwright.prepareAllOnStartup || readyAccountId === null) {
        if (config.playwright.prepareAllOnStartup && remainingAccounts.length > 0) {
          console.log(
            `🪶 [Server] Preparing ${remainingAccounts.length} standby account(s) in background`,
          );
        }
        void prepareRemainingAccountsInBackground({
          accounts: remainingAccounts,
          batchSize: BATCH_SIZE,
          totalAccounts,
          getAccountCredentials,
          initPlaywrightForAccount,
          disableNativeTools,
          warmQwenChatPool,
        }).catch((error) => {
          console.warn(
            `❌ [Server] Background account preparation failed: ${getErrorMessage(error)}`,
          );
        });
      } else if (remainingAccounts.length > 0) {
        console.log(
          `🪶 [Server] ${remainingAccounts.length} standby account(s) will initialize on demand`,
        );

        // Validate standby accounts in background: check login, add to priority,
        // but keep browser closed until actually needed
        void (async () => {
          const { validateAccountLogin } = await import("../services/playwright.ts");
          const { ensureAccountInPriority } = await import("../core/account-priority.ts");

          let validated = 0;
          let failed = 0;

          for (const account of remainingAccounts) {
            try {
              // Add to priority list first (initial priority based on config order)
              ensureAccountInPriority(account.id);

              // Validate login in background
              const ok = await validateAccountLogin(
                account,
                config.playwright.headless,
                config.playwright.browser,
              );

              if (ok) {
                validated++;
                console.log(
                  `✅ [Server] Standby account validated: ${maskEmail(account.email)}`,
                );
              } else {
                failed++;
                console.warn(
                  `⚠️  [Server] Standby account login failed: ${maskEmail(account.email)}`,
                );
              }
            } catch (error) {
              failed++;
              console.warn(
                `⚠️  [Server] Standby account validation error: ${maskEmail(account.email)}: ${getErrorMessage(error)}`,
              );
            }
          }

          if (validated > 0 || failed > 0) {
            console.log(
              `🪶 [Server] Standby validation complete: ${validated} ok, ${failed} failed`,
            );
          }
        })().catch((error) => {
          console.warn(
            `❌ [Server] Background standby validation failed: ${getErrorMessage(error)}`,
          );
        });
      }
    }

    watchdog = new Watchdog();
    watchdog.start();

    metrics.startCollection();

    const { startSessionKeeper } =
      await import("../services/session-keeper.ts");
    startSessionKeeper();

    const { startLeaseSweepTimer } =
      await import("../core/account-concurrency.ts");
    startLeaseSweepTimer();

    const serverInstance = serve({
      fetch: app.fetch,
      port: config.server.port,
      hostname: config.server.host,
    });
    // Node's http.Server emits 'error' (EADDRINUSE and friends) asynchronously,
    // AFTER serve() returns — with no listener the process crashes with a raw
    // stack trace. The pre-flight check above catches the common case before
    // warmup; this listener is the safety net for the rare race where the port
    // is taken between the check and the bind.
    serverInstance.on("error", (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        console.error(
          buildPortInUseMessage(config.server.port, config.server.host),
        );
      } else {
        console.error(`❌ [Server] Listen failed: ${err.message}`);
      }
      process.exit(1);
    });
    server = serverInstance;

    if (options?.installSignalHandlers !== false) {
      installSignalHandlers();
    }

    const started = buildStartedServerInfo();
    const accountCount = accounts.length;
    const warmCount = accounts.filter((account) =>
      isPlaywrightInitialized(account.id),
    ).length;

    // API key display: just show if it's set or not
    const apiKey = process.env.API_KEY || config.apiKey;
    const apiKeyDisplay = apiKey ? "Set" : "Not set";

    // Use only fixed-width chars (ASCII + ●) to guarantee perfect alignment
    // across all terminals (emojis vary between 1-2 cell widths unpredictably)
    const W = 58; // inner width (60 minus 2 border chars)
    const center = (text: string): string => {
      const padLeft = Math.floor((W - text.length) / 2);
      const padRight = W - text.length - padLeft;
      return " ".repeat(padLeft) + text + " ".repeat(padRight);
    };
    const blank = () => " ".repeat(W);
    const row = (label: string, value: string): string => {
      const labelCol = (label + " ".repeat(Math.max(0, 12 - label.length)));
      const valCol = value + " ".repeat(Math.max(0, W - 14 - value.length));
      return "  " + labelCol + valCol;
    };

    const endpoint = `${started.url}/v1`;

    console.log(`
+${"-".repeat(W)}+
|${blank()}|
|${center("QwenProxy")}|
|${center("OpenAI & Anthropic Compatible API")}|
|${blank()}|
+${"-".repeat(W)}+
|${blank()}|
|${row("Endpoint", endpoint)}|
|${row("Port", String(started.port))}|
|${row("Accounts", `${warmCount}/${accountCount} warm`)}|
|${row("API Key", apiKeyDisplay)}|
|${row("Status", "● Online")}|
|${blank()}|
+${"-".repeat(W)}+
`);
    return started;
  })();

  try {
    return await startPromise;
  } catch (error) {
    await cleanupServerResources().catch(() => {});
    throw error;
  } finally {
    startPromise = null;
  }
}

export { app };
