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
    QWEN_BX_V: z.string().default("2.5.37"),
    // Version header on Qwen API requests = the deployed web bundle version
    // (snapshot network/chat.qwen.ai.v2.all.har: bundle qwen-chat-fe/0.2.89).
    // Override via env when Qwen ships a new bundle.
    QWEN_WEB_VERSION: z.string().default("0.2.89"),
    // Controls bx-ua/bx-umidtoken injection on the GENERAL API paths
    // (chats/new, settings): those work without them (live-probed). The
    // completions path is the exception — the 0.2.86 HAR shows the real
    // client POSTs completions WITH bx-ua, so it always includes the captured
    // tokens regardless of this flag (buildCompletionHeaders). Set true
    // to inject them everywhere (legacy behavior).
    QWEN_SEND_BX_UA: z.string().default("false"),
    // Conversation mode: "thread" (default) reuses the upstream Qwen chat via
    // parent_id and sends the thread-native delta; "temp" creates a NEW Qwen
    // temp chat (chat_mode:"local") for every request and sends the full
    // history inline (OpenAI standard). Temp chats are ephemeral and never
    // appear in the account's chat list (live-probed).
    QWEN_CHAT_MODE: z.enum(["thread", "temp"]).default("thread"),
    PLAYWRIGHT_HEADLESS: z.string().default("true"),
    PLAYWRIGHT_BROWSER: z
      .enum(["chromium", "chrome", "edge"])
      .default("chromium"),
    PLAYWRIGHT_INIT_BATCH_SIZE: z.string().default("1"),
    PLAYWRIGHT_CONTEXT_CLOSE_TIMEOUT_MS: z.string().default("10000"),
    PLAYWRIGHT_IDLE_CONTEXT_TTL_MS: z.string().default("60000"),
    PLAYWRIGHT_JS_HEAP_MB: z.string().default("256"),
    PLAYWRIGHT_LOW_MEMORY_FLAGS: z.string().default("true"),
    // Keep 2 warm contexts by default ({main + reserve} covers the common
    // failover hop without opening one browser per account): after warmup two
    // browsers stay open; any extra context (simultaneous use / failover) is
    // closed once idle. The cap only evicts IDLE contexts — busy mutexes and
    // active streams are never touched, so concurrent accounts each keep their
    // own context while serving. Accounts in cooldown (rate-limited) sit idle,
    // drop out of the warm set and get evicted.
    PLAYWRIGHT_MAX_ACTIVE_CONTEXTS: z.string().default("2"),
    PLAYWRIGHT_PREPARE_ALL_ON_STARTUP: z.string().default("true"),
    CAPTCHA_SOLVER_ENABLED: z.string().default("true"),
    CAPTCHA_SOLVER_MAX_ATTEMPTS: z.string().default("3"),
    CAPTCHA_SOLVER_TIMEOUT_MS: z.string().default("15000"),
    CAPTCHA_SOLVER_RETRY_DELAY_MS: z.string().default("1000"),
    CAPTCHA_SOLVER_SETTLE_MS: z.string().default("2000"),
    CAPTCHA_ACCOUNT_COOLDOWN_MS: z.string().default("120000"),
    // Cap for the escalating quarantine applied when a challenge could NOT be
    // solved (hard block). Each consecutive hard block doubles the window
    // (base = CAPTCHA_ACCOUNT_COOLDOWN_MS) up to this cap.
    CAPTCHA_HARD_BLOCK_MAX_COOLDOWN_MS: z.string().default("3600000"),
    OSS_MULTIPART_THRESHOLD_MB: z.string().default("5"),
    CHAT_REQUEST_LOG: z.string().default("false"),
    HTTP_TIMEOUT: z.string().default("15000"),
    CHAT_TIMEOUT: z.string().default("180000"),
    NAVIGATION_TIMEOUT: z.string().default("60000"),
    PAGE_TIMEOUT: z.string().default("60000"),
    HEADERS_TIMEOUT: z.string().default("60000"),
    TIME_TO_FIRST_BYTE: z.string().default("60000"),
    IDLE_STREAM_TIMEOUT: z.string().default("60000"),
    // Deadline for the FIRST upstream chunk on thinking models (the reasoning
    // idle of 600s is for gaps AFTER data flows; a stream that produced
    // nothing in this window is dead and should fail fast, retryable).
    QWEN_FIRST_CHUNK_TIMEOUT: z.string().default("180000"),
    TOTAL_REQUEST_TIMEOUT: z.string().default("600000"),
    // Mid-stream silence window for thinking models: 3 min with ZERO upstream
    // bytes is a dead stream (WAF swallow / dropped connection) — fail fast and
    // let the retry policy rotate accounts. Flowing reasoning chunks RESET this
    // timer, so legitimate slow thinking is never cut; only total silence is.
    REASONING_MODEL_TIMEOUT: z.string().default("180000"),
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
    RETRY_BASE_DELAY_MS: z.string().default(process.env.TEST_MOCK_QWEN_AUTH === "true" ? "50" : "1000"),
    RETRY_MAX_DELAY_MS: z.string().default(process.env.TEST_MOCK_QWEN_AUTH === "true" ? "200" : "10000"),
    RETRY_MAX_ATTEMPTS: z.string().default("3"),
    RETRY_MAX_ACCOUNT_SWITCHES: z.string().default("2"),
    RETRY_ON_UNKNOWN_UPSTREAM: z.string().default("true"),
    RETRY_AUTO_MALFORMED_TOOLS: z.string().default("true"),
    RETRY_AUTO_MALFORMED_TOOLS_MAX: z.string().default("2"),
    MAX_TOOL_CALLS_PER_TURN: z.string().default("24"),
    QWEN_REPEATED_TOOL_CALL_WARN: z.string().default("2"),
    ACCOUNT_MAX_CONCURRENT_STREAMS: z.string().default("2"),
    ACCOUNT_BUSY_WAIT_MS: z.string().default("30000"),
    // Cap for the "wait forever" account-lease queue (thread owner / last
    // usable account): the queue previously had NO deadline, so a stuck lease
    // holder made the next turn wait up to ~600s. A generous finite cap keeps
    // the wait far above the normal 30s but still bounded.
    ACCOUNT_QUEUE_WAIT_FOREVER_CAP_MS: z.string().default("120000"),
    // Hard deadline for one stream-acquire attempt. A dead account (upstream
    // swallows the completion fetch) otherwise chains metadata/header timeouts
    // for minutes; this fails the attempt visibly so the retry loop switches.
    ACQUIRE_DEADLINE_MS: z.string().default("120000"),
    ACCOUNT_LEASE_MAX_DURATION_MS: z.string().default("600000"),
    ACCOUNT_INIT_FAILURE_COOLDOWN_MS: z.string().default("300000"),
    // Timeout before a request waiting on the CHAT lock gives up. The chat lock
    // is held for the entire stream lifetime, so it must cover the longest
    // legitimate generation (reasoning models with huge contexts can spend
    // 2-3 min producing the first byte chain). A 60s hard cap turned a normal
    // long turn into a 500 for every concurrent request on the same chat
    // (2026-08-22 production log: lock held 130s -> acquire_deadline 120s).
    CHAT_LOCK_TIMEOUT_MS: z
      .string()
      .regex(/^\d+$/, "CHAT_LOCK_TIMEOUT_MS must be a number")
      .default("180000"),
    STREAM_DISCONNECT_GRACE_MS: z
      .string()
      .regex(/^\d+$/, "STREAM_DISCONNECT_GRACE_MS must be a number")
      .default("4000"),
    CHAT_IN_PROGRESS_RETRY_DELAY_MS: z.string().default("2000"),
    // Temporarily-busy window after a chat_in_progress: long enough to absorb
    // the upstream chat settle (measured ~1-2s), short enough that the next
    // turn of the sticky owner is not pushed to a cold account with a full
    // context replay (8s caused a needless 13.3s hop in the 20:04 session).
    CHAT_IN_PROGRESS_BUSY_MS: z.string().default("4000"),
    // Same-chat retry budget for chat_in_progress. The upstream chat stays "in
    // progress" for 2-16s after a completed turn (grows with turn size); each
    // retry waits a jittered window (busyMs-based) and NO retry re-sends the
    // full context — the escalation (new chat + full replay on a cold account)
    // was the ~1MB re-upload that made tool loops feel like ~40 minutes. After
    // this budget the request FAILS (thread binding kept) and the client's own
    // retry lands on the settled chat with the delta intact.
    CHAT_IN_PROGRESS_MAX_RETRIES: z.string().default("6"),
    MID_STREAM_FAILOVER_THRESHOLD: z.string().default("2"),
    MID_STREAM_FAILOVER_BUSY_MS: z.string().default("60000"),


    QWEN_BASE_URL: z.string().default("https://chat.qwen.ai"),
    QWEN_CHAT_POOL_SIZE: z.string().default("1"),
    QWEN_CHAT_POOL_MODELS: z.string().default("qwen3.7-plus"),
    QWEN_PERSONALIZATION_FROM_REQUEST: z.string().default("true"),
    QWEN_PERSONALIZATION_VERIFY_GET: z.string().default("true"),
    QWEN_MAX_PROMPT_BYTES: z.string().default("0"),
    QWEN_MAX_PERSONALIZATION_BYTES: z.string().default("200000"),
    CONTEXT_METER_ENABLED: z.string().default("true"),
    CONTEXT_METER_WINDOW_TOKENS: z.string().default("0"),
    CONTEXT_METER_REPORT_USAGE: z.string().default("true"),
    DELETE_ALL_CHATS_ON_SHUTDOWN: z.string().default("false"),
    // Keep idle account pages alive (subtlePageActivity + occasional reload).
    // The Baxia WAF scores live page behavior (pointer/scroll events, open
    // session) — an account whose page sits frozen for minutes returns a low
    // trust score and gets TMD-challenged on the next request. On by default;
    // the keeper skips accounts that are mid-stream or mutex-busy.
    SESSION_KEEP_ALIVE_ENABLED: z.string().default("true"),
    SESSION_KEEP_ALIVE_INTERVAL_MS: z.string().default("30000"),
    SESSION_KEEP_ALIVE_IDLE_MS: z.string().default("120000"),
    SESSION_KEEP_ALIVE_NAVIGATION_INTERVAL_MS: z.string().default("480000"),
    API_KEY: z.string().default(""),
    // Static x-ratelimit-* response headers (OpenAI-shaped, doc §5.2). The proxy
    // does not enforce a token/request quota; these exist for SDK/tool parsing.
    RATE_LIMIT_REQUESTS: z.string().default("5000"),
    RATE_LIMIT_TOKENS: z.string().default("200000"),
  })
;

const env = envSchema.parse(process.env);

export const config = {
  server: {
    port: parseInt(env.PORT),
    host: env.HOST,
    internalHost: env.INTERNAL_HOST,
    rateLimit: {
      requests: parseInt(env.RATE_LIMIT_REQUESTS),
      tokens: parseInt(env.RATE_LIMIT_TOKENS),
    },
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
    maxActiveContexts: Math.max(0, parseInt(env.PLAYWRIGHT_MAX_ACTIVE_CONTEXTS)),
    prepareAllOnStartup: env.PLAYWRIGHT_PREPARE_ALL_ON_STARTUP !== "false",
  },
  captcha: {
    enabled: env.CAPTCHA_SOLVER_ENABLED === "true",
    maxAttempts: Math.max(1, Math.min(5, parseInt(env.CAPTCHA_SOLVER_MAX_ATTEMPTS))),
    timeoutMs: Math.max(0, parseInt(env.CAPTCHA_SOLVER_TIMEOUT_MS)),
    retryDelayMs: Math.max(0, parseInt(env.CAPTCHA_SOLVER_RETRY_DELAY_MS)),
    settleMs: Math.max(0, parseInt(env.CAPTCHA_SOLVER_SETTLE_MS)),
    /** Rest an account whose challenge could not be cleared before reusing it. */
    accountCooldownMs: Math.max(0, parseInt(env.CAPTCHA_ACCOUNT_COOLDOWN_MS)),
    /** Cap for the escalating hard-block quarantine (×2 per consecutive block). */
    hardBlockMaxCooldownMs: Math.max(
      0,
      parseInt(env.CAPTCHA_HARD_BLOCK_MAX_COOLDOWN_MS),
    ),
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
    firstChunkTimeout: parseInt(env.QWEN_FIRST_CHUNK_TIMEOUT),
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
    chatInProgressDelayMs: Math.max(0, parseInt(env.CHAT_IN_PROGRESS_RETRY_DELAY_MS)),
    chatInProgressBusyMs: Math.max(0, parseInt(env.CHAT_IN_PROGRESS_BUSY_MS)),
    chatInProgressMaxAttempts: Math.max(1, parseInt(env.CHAT_IN_PROGRESS_MAX_RETRIES)),
    midStreamFailoverThreshold: Math.max(
      0,
      parseInt(env.MID_STREAM_FAILOVER_THRESHOLD),
    ),
    midStreamFailoverBusyMs: Math.max(
      0,
      parseInt(env.MID_STREAM_FAILOVER_BUSY_MS),
    ),
    autoRetryMalformedTools: env.RETRY_AUTO_MALFORMED_TOOLS !== "false",
    autoRetryMalformedToolsMax: Math.max(1, parseInt(env.RETRY_AUTO_MALFORMED_TOOLS_MAX)),
    maxToolCallsPerTurn: Math.max(0, parseInt(env.MAX_TOOL_CALLS_PER_TURN)),
    repeatedToolCallWarnThreshold: Math.max(
      1,
      parseInt(env.QWEN_REPEATED_TOOL_CALL_WARN),
    ),
  },
  concurrency: {
    maxStreamsPerAccount: Math.max(1, parseInt(env.ACCOUNT_MAX_CONCURRENT_STREAMS)),
    busyWaitMs: Math.max(
      0,
      Number.isFinite(parseInt(env.ACCOUNT_BUSY_WAIT_MS as string))
        ? parseInt(env.ACCOUNT_BUSY_WAIT_MS as string)
        : 30_000,
    ),
    /** Bound for the "wait forever" lease queue (default 2 min). */
    queueWaitForeverCapMs: Math.max(
      0,
      Number.isFinite(parseInt(env.ACCOUNT_QUEUE_WAIT_FOREVER_CAP_MS as string))
        ? parseInt(env.ACCOUNT_QUEUE_WAIT_FOREVER_CAP_MS as string)
        : 120_000,
    ),
    /** Hard deadline for one stream-acquire attempt (default 2 min). */
    acquireDeadlineMs: Math.max(
      0,
      Number.isFinite(parseInt(env.ACQUIRE_DEADLINE_MS as string))
        ? parseInt(env.ACQUIRE_DEADLINE_MS as string)
        : 120_000,
    ),
    /** Safety net: force-release leases held longer than this (default 10 min). */
    leaseMaxDurationMs: Math.max(
      0,
      parseInt(env.ACCOUNT_LEASE_MAX_DURATION_MS),
    ),
    initFailureCooldownMs: Math.max(
      30_000,
      parseInt(env.ACCOUNT_INIT_FAILURE_COOLDOWN_MS),
    ),
    /** Max time a request waits on the per-chat lock (default 3 min). */
    chatLockTimeoutMs: Math.max(
      0,
      parseInt(env.CHAT_LOCK_TIMEOUT_MS),
    ),
  },
  stream: {
    disconnectGraceMs: Math.max(
      0,
      parseInt(env.STREAM_DISCONNECT_GRACE_MS),
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
    /** "thread" (reuse upstream chat) or "temp" (new ephemeral chat per request). */
    chatMode: env.QWEN_CHAT_MODE,
    maxPromptBytes: Math.max(0, parseInt(env.QWEN_MAX_PROMPT_BYTES)),
    maxPersonalizationBytes: Math.max(
      0,
      parseInt(env.QWEN_MAX_PERSONALIZATION_BYTES),
    ),
    deleteAllChatsOnShutdown: env.DELETE_ALL_CHATS_ON_SHUTDOWN === "true",
    /** Send the captured bx-ua/bx-umidtoken headers (real client does NOT). */
    sendBxUa: env.QWEN_SEND_BX_UA === "true",
    /** Deployed web bundle version sent as the `version` API header. */
    webVersion: env.QWEN_WEB_VERSION,
  },
  contextMeter: {
    enabled: env.CONTEXT_METER_ENABLED === "true",
    windowTokens: Math.max(0, parseInt(env.CONTEXT_METER_WINDOW_TOKENS)),
    reportUsage: env.CONTEXT_METER_REPORT_USAGE === "true",
  },
};

export type Config = typeof config;

/** Conversation mode: thread-native reuse vs ephemeral temp chat per request. */
export type ChatMode = "thread" | "temp";
