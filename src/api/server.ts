import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { config } from "../core/config.js";
import { metrics } from "../core/metrics.js";
import { logger, maskEmail } from "../core/logger.js";
import { MemoryCache } from "../cache/memory-cache.js";
import { Watchdog } from "../core/watchdog.js";
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

function verifyApiKey(c: Context): Response | null {
  const apiKey = process.env.API_KEY || config.apiKey;
  if (!apiKey) return null;

  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return sendOpenAIError(
      c,
      new AuthError("Missing or invalid Authorization header"),
    );
  }
  const token = auth.slice(7);
  if (!constantTimeStringEqual(token, apiKey)) {
    return sendOpenAIError(c, new AuthError("Invalid API key"));
  }
  return null;
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
}): Promise<void> {
  try {
    await params.initAuth();
    await params.disableNativeTools(params.accountId).catch(() => {});
    await warmConfiguredChatPools(params.warmQwenChatPool, params.accountId);
    console.log(params.successMessage);
  } catch (error) {
    console.error(params.failureMessage, getErrorMessage(error));
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

  if (config.qwen.deleteAllChatsOnShutdown) {
    try {
      const { deleteChatsForConfiguredAccounts } =
        await import("../services/chat-cleanup.ts");
      const result = await deleteChatsForConfiguredAccounts();
      console.log(
        `[Server] Deleted Qwen chats on shutdown: ${result.succeeded}/${result.attempted} scope(s).`,
      );
    } catch (error) {
      console.error(
        "[Server] Failed to delete Qwen chats on shutdown:",
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
  console.log(`[Server] Shutdown | ${signal}`);
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
      logger.warn(
        "API_KEY is empty and HOST is 0.0.0.0; the API is reachable without authentication.",
      );
    }

    const { loadAccounts } = await import("../core/accounts.ts");
    const accounts = loadAccounts();

    // Clear stale cooldowns from previous sessions on startup
    const { clearAccountCooldown } = await import("../core/account-manager.ts");
    for (const account of accounts) {
      clearAccountCooldown(account.id);
    }
    if (accounts.length > 0) {
      console.log(
        `[Server] Cleared stale cooldowns for ${accounts.length} account(s).`,
      );
    }

    const { disableNativeTools, warmQwenChatPool } =
      await import("../services/qwen.ts");
    const { initPlaywrightForAccount } =
      await import("../services/playwright.ts");

    const BATCH_SIZE = 5;

    if (accounts.length > 0) {
      console.log(
        `[Server] Preparing ${accounts.length} account(s) with Playwright (batch size: ${BATCH_SIZE})...`,
      );

      for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
        const batch = accounts.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(accounts.length / BATCH_SIZE);
        console.log(
          `[Server] Batch ${batchNum}/${totalBatches}: initializing ${batch.length} account(s)...`,
        );

        await Promise.all(
          batch.map((account: QwenAccount) =>
            prepareQwenRuntime({
              accountId: account.id,
              successMessage: `[Server] Account ready (Playwright): ${maskEmail(account.email)}`,
              failureMessage: `[Server] Failed to initialize account ${maskEmail(account.email)}:`,
              initAuth: () =>
                initPlaywrightForAccount(
                  account,
                  config.playwright.headless,
                  config.playwright.browser,
                ),
              disableNativeTools,
              warmQwenChatPool,
            }),
          ),
        );
      }
    } else {
      console.warn(
        "[Server] No Qwen accounts configured. Add accounts with npm run login before sending requests.",
      );
    }

    watchdog = new Watchdog();
    watchdog.start();

    metrics.startCollection();

    server = serve({
      fetch: app.fetch,
      port: config.server.port,
      hostname: config.server.host,
    });

    if (options?.installSignalHandlers !== false) {
      installSignalHandlers();
    }

    const started = buildStartedServerInfo();
    console.log(`[Server] Listening on ${started.url}/v1`);
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
