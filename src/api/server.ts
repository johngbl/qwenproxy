import crypto from "crypto";
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
import { anthropicApp } from "../routes/anthropic/index.js";
import { responsesApp } from "../routes/responses/index.js";
import { sendOpenAIError } from "./error-helpers.js";
import { AuthError, NotFoundError } from "../core/errors.js";
import type { QwenAccount } from "../core/accounts.js";

// Module-level state (initialized in startServer)
let cache: MemoryCache | undefined;
let watchdog: Watchdog | undefined;
let server: any;
let startPromise: Promise<StartedServerInfo> | null = null;
let stopPromise: Promise<void> | null = null;
let signalHandlersInstalled = false;

const app = new Hono();

// Module-level accessor for cross-module cache access
export function getCache(): MemoryCache | undefined {
  return cache;
}

export function setCacheForTesting(nextCache: MemoryCache | undefined): void {
  cache = nextCache;
}

// Middleware must be registered BEFORE routes
app.use("*", async (c, next) => {
  const requestId = c.req.header("X-Request-Id") || uuidv4();
  c.header("X-Request-Id", requestId);

  metrics.increment("requests.total");
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  metrics.histogram("latency.request", duration);
  c.header("X-Response-Time", `${duration}ms`);
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
 * Accept OpenAI-style Bearer and Anthropic-style x-api-key.
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
  if (candidates.length === 0) {
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
app.post("/v1/upload", uploadFile);

// Anthropic API compatible routes
app.route("", anthropicApp);

// OpenAI Responses API compatible routes
app.route("", responsesApp);

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
          `⚠️  [Server] Account not ready: cooldown ${Math.ceil(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`,
        );
        return false;
      }
    }
    return true;
  } catch (error) {
    console.warn(`❌ ${params.failureMessage}`, getErrorMessage(error));
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

  const { closeDatabase } = await import("../core/database.ts");
  closeDatabase();

  const activeServer = server;
  server = undefined;
  if (activeServer?.close) {
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
}

async function handleSignal(signal: string): Promise<never> {
  console.log(`🛑 [Server] Shutdown | ${signal}`);
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

    // Clear stale cooldowns from previous sessions on startup
    const { clearAccountCooldown } = await import("../core/account-manager.ts");
    for (const account of accounts) {
      clearAccountCooldown(account.id);
    }

    const { disableNativeTools, warmQwenChatPool } =
      await import("../services/qwen.ts");
    const { initPlaywrightForAccount } =
      await import("../services/playwright.ts");

    const BATCH_SIZE = config.playwright.initBatchSize;

    if (accounts.length > 0) {
      let readyAccountIndex = -1;
      const totalAccounts = accounts.length;
      for (let i = 0; i < accounts.length; i++) {
        const ok = await prepareAccountRuntime(
          accounts[i],
          getAccountCredentials,
          initPlaywrightForAccount,
          disableNativeTools,
          warmQwenChatPool,
        );
        if (ok) {
          console.log(`✅ [Server] Account ready (${i + 1}/${totalAccounts}): ${maskEmail(accounts[i].email)}`);
          readyAccountIndex = i;
          break;
        }
      }

      const remainingAccounts = accounts.filter(
        (_account, index) => index !== readyAccountIndex,
      );
      if (readyAccountIndex === -1) {
        console.warn(
          `⚠️  [Server] No account ready during startup; continuing in background`,
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
    } else {
      console.warn(
        `⚠️  [Server] No Qwen accounts configured. Add accounts with npm run login before sending requests.`,
      );
    }

    watchdog = new Watchdog();
    watchdog.start();

    metrics.startCollection();

    const { startSessionKeeper } =
      await import("../services/session-keeper.ts");
    startSessionKeeper();

    server = serve({
      fetch: app.fetch,
      port: config.server.port,
      hostname: config.server.host,
    });

    if (options?.installSignalHandlers !== false) {
      installSignalHandlers();
    }

    const started = buildStartedServerInfo();
    const accountCount = accounts.length;
    const readyCount = accounts.filter(acc => !getAccountCooldownInfo(acc.id)).length;

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
|${center("QwenBridge")}|
|${center("OpenAI-Compatible API")}|
|${blank()}|
+${"-".repeat(W)}+
|${blank()}|
|${row("Endpoint", endpoint)}|
|${row("Port", String(started.port))}|
|${row("Accounts", `${readyCount}/${accountCount}`)}|
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
