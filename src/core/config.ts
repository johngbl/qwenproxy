import { z } from "zod";

const envSchema = z
  .object({
    PORT: z
      .string()
      .regex(/^\d+$/, "PORT must be a number")
      .refine((value) => {
        const port = Number(value);
        return port >= 1 && port <= 65535;
      }, "PORT must be between 1 and 65535")
      .default("3000"),
    HOST: z.string().default("0.0.0.0"),
    INTERNAL_HOST: z.string().default("127.0.0.1"),
    USER_AGENT: z
      .string()
      .default(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      ),
    QWEN_BX_V: z.string().default("2.5.36"),
    PLAYWRIGHT_HEADLESS: z.string().default("true"),
    PLAYWRIGHT_BROWSER: z
      .enum(["chromium", "chrome", "edge"])
      .default("chromium"),
    PLAYWRIGHT_INIT_BATCH_SIZE: z.string().default("1"),
    PLAYWRIGHT_CONTEXT_CLOSE_TIMEOUT_MS: z.string().default("10000"),
    PLAYWRIGHT_IDLE_CONTEXT_TTL_MS: z.string().default("600000"),
    PLAYWRIGHT_JS_HEAP_MB: z.string().default("512"),
    PLAYWRIGHT_LOW_MEMORY_FLAGS: z.string().default("true"),
    OSS_MULTIPART_THRESHOLD_MB: z.string().default("5"),
    CHAT_REQUEST_LOG: z.string().default("false"),
    HTTP_TIMEOUT: z.string().default("10000"),
    CHAT_TIMEOUT: z.string().default("120000"),
    NAVIGATION_TIMEOUT: z.string().default("45000"),
    PAGE_TIMEOUT: z.string().default("30000"),
    HEADERS_TIMEOUT: z.string().default("60000"),
    TIME_TO_FIRST_BYTE: z.string().default("30000"),
    IDLE_STREAM_TIMEOUT: z.string().default("60000"),
    TOTAL_REQUEST_TIMEOUT: z.string().default("300000"),
    REASONING_MODEL_TIMEOUT: z.string().default("600000"),
    CACHE_TTL: z.string().default("3600"),
    RESPONSE_TTL: z.string().default("1800"),
    CACHE_COMPRESSION_ENABLED: z.string().default("true"),
    CACHE_COMPRESSION_THRESHOLD: z.string().default("1024"),
    CACHE_COMPRESSION_LEVEL: z.string().default("6"),
    CONTEXT_SUMMARIZATION_ENABLED: z.string().default("true"),
    CONTEXT_SUMMARIZATION_MODEL: z.string().default("qwen3.5-flash"),
    CONTEXT_SUMMARIZATION_TIMEOUT: z.string().default("15000"),
    CONTEXT_PERSISTENCE_ENABLED: z.string().default("true"),
    CONTEXT_ROLLOVER_ENABLED: z.string().default("true"),
    CONTEXT_INCREMENTAL_SUMMARY_TOKENS: z.string().default("30000"),
    CONTEXT_INCREMENTAL_SUMMARY_TURNS: z.string().default("30"),
    CONTEXT_RECENT_TURNS_TO_KEEP: z.string().default("12"),
    CONTEXT_SUMMARY_STALE_RATIO: z.string().default("0.70"),
    CONTEXT_ROLLOVER_READY_RATIO: z.string().default("0.80"),
    CONTEXT_ROLLOVER_REQUIRED_RATIO: z.string().default("0.90"),
    CONTEXT_HARD_LIMIT_RATIO: z.string().default("0.95"),
    CONTEXT_SUMMARY_MAX_TOKENS: z.string().default("4000"),
    CONTEXT_SUMMARY_TIMEOUT: z.string().default("60000"),
    CONTEXT_SUMMARY_BACKGROUND_CONCURRENCY: z.string().default("1"),
    CONTEXT_SUMMARY_MIN_INTERVAL_SECONDS: z.string().default("60"),
    CONTEXT_SESSION_TTL_HOURS: z.string().default("72"),
    CONTEXT_MAX_SUMMARIES_PER_SESSION: z.string().default("3"),
    CONTEXT_MAX_RAW_TURNS_PER_SESSION: z.string().default("100"),
    CONTEXT_MAX_RAW_TOKENS_PER_SESSION: z.string().default("200000"),
    CONTEXT_SUMMARY_ALLOW_CROSS_ACCOUNT: z.string().default("true"),
    CONTEXT_ROLLOVER_ALLOW_CROSS_ACCOUNT: z.string().default("true"),
    CONTEXT_DELETE_FAILED_NEW_CHATS: z.string().default("true"),
    CONTEXT_DELETE_OLD_QWEN_CHATS: z.string().default("true"),
    CONTEXT_OLD_CHAT_RETENTION_HOURS: z.string().default("0"),
    METRICS_INTERVAL: z.string().default("10000"),
    WATCHDOG_INTERVAL: z.string().default("5000"),
    WATCHDOG_FAILURES: z.string().default("3"),
    RAM_WARNING: z.string().default("80"),
    RAM_CRITICAL: z.string().default("95"),
    WS_WARNING: z.string().default("50"),
    WS_CRITICAL: z.string().default("100"),
    RETRY_BASE_DELAY_MS: z.string().default("1000"),
    RETRY_MAX_DELAY_MS: z.string().default("10000"),
    ANTI_BOT_BASE_DELAY_MS: z.string().default("5000"),
    ANTI_BOT_MAX_DELAY_MS: z.string().default("30000"),
    QWEN_BASE_URL: z.string().default("https://chat.qwen.ai"),
    QWEN_CHAT_POOL_SIZE: z.string().default("1"),
    QWEN_CHAT_POOL_MODELS: z.string().default("qwen3.7-plus"),
    QWEN_PERSONALIZATION_FROM_REQUEST: z.string().default("true"),
    QWEN_PERSONALIZATION_VERIFY_GET: z.string().default("true"),
    DELETE_ALL_CHATS_ON_SHUTDOWN: z.string().default("false"),
    SESSION_KEEP_ALIVE_ENABLED: z.string().default("false"),
    SESSION_KEEP_ALIVE_INTERVAL_MS: z.string().default("180000"),
    SESSION_KEEP_ALIVE_IDLE_MS: z.string().default("120000"),
    SESSION_KEEP_ALIVE_NAVIGATION_INTERVAL_MS: z.string().default("480000"),
    API_KEY: z.string().default(""),
  })
  .superRefine((env, ctx) => {
    const ratios = [
      ["CONTEXT_SUMMARY_STALE_RATIO", env.CONTEXT_SUMMARY_STALE_RATIO],
      ["CONTEXT_ROLLOVER_READY_RATIO", env.CONTEXT_ROLLOVER_READY_RATIO],
      ["CONTEXT_ROLLOVER_REQUIRED_RATIO", env.CONTEXT_ROLLOVER_REQUIRED_RATIO],
      ["CONTEXT_HARD_LIMIT_RATIO", env.CONTEXT_HARD_LIMIT_RATIO],
    ] as const;

    const parsed = ratios.map(([key, value]) => [key, Number(value)] as const);
    for (const [key, value] of parsed) {
      if (!Number.isFinite(value) || value <= 0 || value > 1) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must be a number greater than 0 and less than or equal to 1`,
        });
      }
    }

    const [, stale] = parsed[0];
    const [, ready] = parsed[1];
    const [, required] = parsed[2];
    const [, hard] = parsed[3];
    if (
      Number.isFinite(stale) &&
      Number.isFinite(ready) &&
      Number.isFinite(required) &&
      Number.isFinite(hard) &&
      !(stale < ready && ready < required && required < hard)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["CONTEXT_SUMMARY_STALE_RATIO"],
        message:
          "Context ratios must be in ascending order: stale < ready < required < hard",
      });
    }
  });

const env = envSchema.parse(process.env);

export const config = {
  server: {
    port: parseInt(env.PORT),
    host: env.HOST,
    internalHost: env.INTERNAL_HOST,
  },
  logging: {
    chatRequests: env.CHAT_REQUEST_LOG === "true",
  },
  auth: {
    userAgent: env.USER_AGENT,
    bxV: env.QWEN_BX_V,
  },
  playwright: {
    headless: env.PLAYWRIGHT_HEADLESS !== "false",
    browser: env.PLAYWRIGHT_BROWSER,
    initBatchSize: Math.max(1, parseInt(env.PLAYWRIGHT_INIT_BATCH_SIZE)),
    contextCloseTimeoutMs: Math.max(
      1_000,
      parseInt(env.PLAYWRIGHT_CONTEXT_CLOSE_TIMEOUT_MS),
    ),
    idleContextTtlMs: Math.max(0, parseInt(env.PLAYWRIGHT_IDLE_CONTEXT_TTL_MS)),
    jsHeapMb: Math.max(64, parseInt(env.PLAYWRIGHT_JS_HEAP_MB)),
    lowMemoryFlags: env.PLAYWRIGHT_LOW_MEMORY_FLAGS !== "false",
  },
  oss: {
    multipartThresholdBytes: Math.max(
      1 * 1024 * 1024,
      parseInt(env.OSS_MULTIPART_THRESHOLD_MB) * 1024 * 1024,
    ),
  },
  timeouts: {
    http: parseInt(env.HTTP_TIMEOUT),
    chat: parseInt(env.CHAT_TIMEOUT),
    navigation: parseInt(env.NAVIGATION_TIMEOUT),
    page: parseInt(env.PAGE_TIMEOUT),
    headers: parseInt(env.HEADERS_TIMEOUT),
    timeToFirstByte: parseInt(env.TIME_TO_FIRST_BYTE),
    idleStreamTimeout: parseInt(env.IDLE_STREAM_TIMEOUT),
    totalRequestTimeout: parseInt(env.TOTAL_REQUEST_TIMEOUT),
    reasoningModelTimeout: parseInt(env.REASONING_MODEL_TIMEOUT),
  },
  cache: {
    defaultTTL: parseInt(env.CACHE_TTL),
    responseTTL: parseInt(env.RESPONSE_TTL),
    compression: {
      enabled: env.CACHE_COMPRESSION_ENABLED !== "false",
      threshold: parseInt(env.CACHE_COMPRESSION_THRESHOLD),
      level: parseInt(env.CACHE_COMPRESSION_LEVEL),
    },
  },

  context: {
    summarization: {
      enabled: env.CONTEXT_SUMMARIZATION_ENABLED !== "false",
      model: env.CONTEXT_SUMMARIZATION_MODEL,
      timeout: parseInt(env.CONTEXT_SUMMARIZATION_TIMEOUT),
    },
    threadNative: {
      persistenceEnabled: env.CONTEXT_PERSISTENCE_ENABLED !== "false",
      rolloverEnabled: env.CONTEXT_ROLLOVER_ENABLED !== "false",
      incrementalSummaryTokens: parseInt(
        env.CONTEXT_INCREMENTAL_SUMMARY_TOKENS,
      ),
      incrementalSummaryTurns: parseInt(env.CONTEXT_INCREMENTAL_SUMMARY_TURNS),
      recentTurnsToKeep: parseInt(env.CONTEXT_RECENT_TURNS_TO_KEEP),
      summaryStaleRatio: parseFloat(env.CONTEXT_SUMMARY_STALE_RATIO),
      rolloverReadyRatio: parseFloat(env.CONTEXT_ROLLOVER_READY_RATIO),
      rolloverRequiredRatio: parseFloat(env.CONTEXT_ROLLOVER_REQUIRED_RATIO),
      hardLimitRatio: parseFloat(env.CONTEXT_HARD_LIMIT_RATIO),
      summaryMaxTokens: parseInt(env.CONTEXT_SUMMARY_MAX_TOKENS),
      summaryTimeout: parseInt(env.CONTEXT_SUMMARY_TIMEOUT),
      summaryBackgroundConcurrency: parseInt(
        env.CONTEXT_SUMMARY_BACKGROUND_CONCURRENCY,
      ),
      summaryMinIntervalSeconds: parseInt(
        env.CONTEXT_SUMMARY_MIN_INTERVAL_SECONDS,
      ),
      sessionTtlHours: parseInt(env.CONTEXT_SESSION_TTL_HOURS),
      maxSummariesPerSession: parseInt(env.CONTEXT_MAX_SUMMARIES_PER_SESSION),
      maxRawTurnsPerSession: parseInt(env.CONTEXT_MAX_RAW_TURNS_PER_SESSION),
      maxRawTokensPerSession: parseInt(env.CONTEXT_MAX_RAW_TOKENS_PER_SESSION),
      summaryAllowCrossAccount:
        env.CONTEXT_SUMMARY_ALLOW_CROSS_ACCOUNT !== "false",
      rolloverAllowCrossAccount:
        env.CONTEXT_ROLLOVER_ALLOW_CROSS_ACCOUNT !== "false",
      deleteFailedNewChats: env.CONTEXT_DELETE_FAILED_NEW_CHATS !== "false",
      deleteOldQwenChats: env.CONTEXT_DELETE_OLD_QWEN_CHATS !== "false",
      oldChatRetentionHours: parseFloat(env.CONTEXT_OLD_CHAT_RETENTION_HOURS),
    },
  },
  metrics: {
    interval: parseInt(env.METRICS_INTERVAL),
  },
  watchdog: {
    checkInterval: parseInt(env.WATCHDOG_INTERVAL),
    consecutiveFailuresThreshold: parseInt(env.WATCHDOG_FAILURES),
    ram: {
      warningThreshold: parseInt(env.RAM_WARNING),
      criticalThreshold: parseInt(env.RAM_CRITICAL),
    },
    streams: {
      warningThreshold: parseInt(env.WS_WARNING),
      criticalThreshold: parseInt(env.WS_CRITICAL),
    },
  },
  retry: {
    baseDelayMs: parseInt(env.RETRY_BASE_DELAY_MS),
    maxDelayMs: parseInt(env.RETRY_MAX_DELAY_MS),
  },
  antiBot: {
    baseDelayMs: parseInt(env.ANTI_BOT_BASE_DELAY_MS),
    maxDelayMs: parseInt(env.ANTI_BOT_MAX_DELAY_MS),
  },
  sessionKeeper: {
    enabled: env.SESSION_KEEP_ALIVE_ENABLED !== "false",
    intervalMs: parseInt(env.SESSION_KEEP_ALIVE_INTERVAL_MS),
    idleMs: parseInt(env.SESSION_KEEP_ALIVE_IDLE_MS),
    navigationIntervalMs: parseInt(
      env.SESSION_KEEP_ALIVE_NAVIGATION_INTERVAL_MS,
    ),
  },
  apiKey: env.API_KEY,
  qwen: {
    baseUrl: env.QWEN_BASE_URL,
    chatPoolSize: Math.max(0, parseInt(env.QWEN_CHAT_POOL_SIZE)),
    chatPoolModels: env.QWEN_CHAT_POOL_MODELS.split(",")
      .map((model) => model.trim())
      .filter(Boolean),
    personalizationFromRequest:
      env.QWEN_PERSONALIZATION_FROM_REQUEST === "true",
    personalizationVerifyGet: env.QWEN_PERSONALIZATION_VERIFY_GET !== "false",
    deleteAllChatsOnShutdown: env.DELETE_ALL_CHATS_ON_SHUTDOWN === "true",
  },
};

export type Config = typeof config;
