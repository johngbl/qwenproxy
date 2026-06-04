import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { config } from "../core/config.js";
import { metrics } from "../core/metrics.js";
import { logger } from "../core/logger.js";
import { MemoryCache } from "../cache/memory-cache.js";
import { Watchdog } from "../core/watchdog.js";
import { app as modelsApp } from "./models.js";
import { chatCompletions, chatCompletionsStop } from "../routes/chat.js";
import { uploadFile } from "../routes/upload.js";
import { sendOpenAIError } from "./error-helpers.js";
import { AuthError, NotFoundError, UpstreamRateLimit } from "../core/errors.js";
import type { CacheKey } from "../cache/memory-cache.js";

// Module-level state (initialized in startServer)
let cache: MemoryCache | undefined;
let watchdog: Watchdog;
let server: any;

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

app.use("/v1/*", async (c, next) => {
  const apiKey = process.env.API_KEY || config.apiKey;
  if (apiKey) {
    const auth = c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return sendOpenAIError(c, new AuthError("Missing or invalid Authorization header"));
    }
    const token = auth.slice(7);
    const tokenBuf = Buffer.from(token);
    const keyBuf = Buffer.from(apiKey);
    if (
      tokenBuf.length !== keyBuf.length ||
      !crypto.timingSafeEqual(tokenBuf, keyBuf)
    ) {
      return sendOpenAIError(c, new AuthError("Invalid API key"));
    }
  }
  await next();
});

app.use("/v1/*", async (c, next) => {
  if (!cache) {
    await next();
    return;
  }

  const auth = c.req.header("Authorization");
  const apiKey = auth?.startsWith("Bearer ") ? auth.slice(7) : "anonymous";
  const clientIp = c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.req.header("x-real-ip") || "unknown";
  
  const identifier = apiKey !== "anonymous" ? `key:${apiKey}` : `ip:${clientIp}`;

  const concurrencyKey = `rate:concurrency:${identifier}` as CacheKey;
  const currentConcurrency = await cache.increment(concurrencyKey, 1, 60);
  
  if (currentConcurrency > config.rateLimit.concurrency) {
    await cache.increment(concurrencyKey, -1);
    return sendOpenAIError(c, new UpstreamRateLimit("Too many concurrent requests"));
  }

  try {
    const rpmKey = `rate:rpm:${identifier}` as CacheKey;
    const currentRpm = await cache.increment(rpmKey, 1, 60);
    
    if (currentRpm > config.rateLimit.rpm) {
      return sendOpenAIError(c, new UpstreamRateLimit("Rate limit exceeded (RPM)"));
    }

    await next();
  } finally {
    await cache.increment(concurrencyKey, -1);
  }
});

// Routes
app.route("", modelsApp);
app.post("/v1/chat/completions", chatCompletions);
app.post("/v1/chat/completions/stop", chatCompletionsStop);
app.post("/v1/upload", uploadFile);

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
    stack: err instanceof Error ? err.stack : undefined
  });
  return sendOpenAIError(c, err);
});

app.notFound((c) => sendOpenAIError(c, new NotFoundError("Not found")));

export async function startServer(): Promise<void> {
  cache = new MemoryCache();
  await cache.connect();

  const { loadAccounts } = await import("../core/accounts.ts");
  const accounts = loadAccounts();

  if (accounts.length > 0) {
    const { initPlaywrightForAccount, getQwenHeaders } =
      await import("../services/playwright.ts");
    const { disableNativeTools } = await import("../services/qwen.ts");

    console.log(
      `[Server] Preparing ${accounts.length} configured account(s) in parallel...`,
    );

    await Promise.all(
      accounts.map(async (account) => {
        try {
          await initPlaywrightForAccount(account, config.browser.headless);
          await getQwenHeaders(false, account.id);
          await disableNativeTools(account.id).catch(() => {});
          console.log(`[Server] Account ready: ${account.email}`);
        } catch (err: any) {
          console.error(
            `[Server] Failed to initialize account ${account.email}:`,
            err.message,
          );
        }
      }),
    );
  } else {
    const { initPlaywright } = await import("../services/playwright.ts");
    await initPlaywright(config.browser.headless);
  }

  watchdog = new Watchdog();
  watchdog.start();

  metrics.startCollection();

  server = serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host,
  });

  console.log(
    `[Server] Listening on http://localhost:${config.server.port}/v1`,
  );

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    watchdog.stop();
    metrics.stopCollection();
    await cache?.close();
    const { closePlaywright } = await import("../services/playwright.ts");
    await closePlaywright();
    const { closeDatabase } = await import("../core/database.ts");
    closeDatabase();
    server?.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

export { app };
