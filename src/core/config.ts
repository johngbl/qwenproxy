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
    METRICS_INTERVAL: z.string().default("10000"),
    WATCHDOG_INTERVAL: z.string().default("5000"),
    WATCHDOG_FAILURES: z.string().default("3"),
    RAM_WARNING: z.string().default("80"),
    RAM_CRITICAL: z.string().default("95"),
    WS_WARNING: z.string().default("50"),
    WS_CRITICAL: z.string().default("100"),
    RETRY_BASE_DELAY_MS: z.string().default("1000"),
    RETRY_MAX_DELAY_MS: z.string().default("10000"),
    RETRY_MAX_ATTEMPTS: z.string().default("3"),
    RETRY_MAX_ACCOUNT_SWITCHES: z.string().default("2"),
    RETRY_ON_UNKNOWN_UPSTREAM: z.string().default("true"),
    ANTI_BOT_BASE_DELAY_MS: z.string().default("5000"),
    ANTI_BOT_MAX_DELAY_MS: z.string().default("30000"),
    CAPTCHA_SOLVER_ENABLED: z.string().default("true"),
    CAPTCHA_SOLVER_TIMEOUT_MS: z.string().default("25000"),
    CAPTCHA_SOLVER_MAX_SLIDER_ATTEMPTS: z.string().default("2"),
    CAPTCHA_SOLVER_MIN_INTERVAL_MS: z.string().default("20000"),
    CAPTCHA_SOLVER_FAIL_COOLDOWN_MS: z.string().default("600000"),
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
;

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
    maxAttempts: Math.max(1, parseInt(env.RETRY_MAX_ATTEMPTS)),
    maxAccountSwitches: Math.max(0, parseInt(env.RETRY_MAX_ACCOUNT_SWITCHES)),
    onUnknownUpstream: env.RETRY_ON_UNKNOWN_UPSTREAM !== "false",
  },
  antiBot: {
    baseDelayMs: parseInt(env.ANTI_BOT_BASE_DELAY_MS),
    maxDelayMs: parseInt(env.ANTI_BOT_MAX_DELAY_MS),
  },
  captchaSolver: {
    enabled: env.CAPTCHA_SOLVER_ENABLED !== "false",
    timeoutMs: Math.max(5_000, parseInt(env.CAPTCHA_SOLVER_TIMEOUT_MS)),
    maxSliderAttempts: Math.max(
      1,
      parseInt(env.CAPTCHA_SOLVER_MAX_SLIDER_ATTEMPTS),
    ),
    minIntervalMs: Math.max(0, parseInt(env.CAPTCHA_SOLVER_MIN_INTERVAL_MS)),
    failCooldownMs: Math.max(
      60_000,
      parseInt(env.CAPTCHA_SOLVER_FAIL_COOLDOWN_MS),
    ),
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
