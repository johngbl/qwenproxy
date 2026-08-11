import "dotenv/config";

/**
 * Mask an email address for safe logging.
 * "user@example.com" → "user@***"
 */
export function maskEmail(email: string | undefined | null): string {
  if (!email) return "<unknown>";
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return "<invalid>";
  return email.substring(0, atIndex);
}

// ─── Log sanitization ───────────────────────────────────────────────────────────
// Log entries carry raw upstream payloads (headers, cookies, JWT-backed
// sessions, malformed tool-call dumps). Redact known credential keys and any
// loose JWT/API-key shaped string before the entry hits the console, even when
// the value appears nested inside a bigger object or a quoted JSON dump.

const SENSITIVE_KEY_PATTERN =
  /^(authorization|auth|cookie|cookies|set-cookie|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|x5sec|x5secdata|bx-ua|bx-v|bx-umidtoken)$/i;

/** WAF cookie names come in many variants: x5sec, x5sec_v3, x5sec-cn, bx-temp... */
const WAF_KEY_PREFIX_PATTERN = /^(x5sec|bx[-_])/i;

/** JWT (3 base64url segments) or OpenAI-style `sk-` API key. */
const LOOSE_SECRET_PATTERN =
  /(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,})/g;

/** Credentials embedded in free-form strings: header lines, cookie jars, URLs. */
const EMBEDDED_SECRET_PATTERN =
  /((?:x5sec(?:data|_[a-z0-9]+|-[a-z0-9]+)?|bx[-_][a-z0-9_-]+)\s*=\s*[^;\s"']+)|(\bBearer\s+[A-Za-z0-9._~+\/=-]+)/gi;

function isPassthroughObject(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function redactLogValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(LOOSE_SECRET_PATTERN, "[REDACTED]")
      .replace(EMBEDDED_SECRET_PATTERN, "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item));
  }
  if (value !== null && typeof value === "object" && !isPassthroughObject(value)) {
    // Recurse into own enumerable props of BOTH plain objects and class
    // instances (sessions, response wrappers) — JSON.stringify serializes
    // those the same way, so redacting them loses nothing.
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] =
        SENSITIVE_KEY_PATTERN.test(key) || WAF_KEY_PREFIX_PATTERN.test(key)
          ? "[REDACTED]"
          : redactLogValue(val);
    }
    return out;
  }
  return value;
}

function redactLogMessage(message: string): string {
  return message
    .replace(LOOSE_SECRET_PATTERN, "[REDACTED]")
    .replace(EMBEDDED_SECRET_PATTERN, "[REDACTED]");
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * TOOLCALL_DEBUG levels:
 *   "0" or undefined = disabled
 *   "1" = full debug (all toolcall logs)
 *   "errors" = only on errors (log toolcall details when parser/execution fails)
 *
 * UPSTREAM_DEBUG:
 *   "true" = log raw SSE chunks received from Qwen
 */
export type ToolcallDebugLevel = "0" | "1" | "errors";

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context?: string;
  data?: Record<string, unknown>;
}

export class Logger {
  private minLevel: LogLevel;
  private context?: string;

  constructor(level: LogLevel = "warn", context?: string) {
    this.minLevel = level;
    this.context = context;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.minLevel];
  }

  /** Cheap level check so callers can skip building expensive log payloads. */
  isLevelEnabled(level: LogLevel): boolean {
    return this.shouldLog(level);
  }

  private formatEntry(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const pad = (str: string): string => str.padStart(5, " ");
    const colorCode =
      entry.level === "error"
        ? "\x1b[31m"
        : entry.level === "warn"
          ? "\x1b[33m"
          : entry.level === "debug"
            ? "\x1b[36m"
            : "";
    const reset = "\x1b[0m";

    const coloredLevel = colorCode + pad(entry.level.toUpperCase()) + reset;
    const contextPart = entry.context ? ` [${entry.context}]` : "";

    // Redact credentials from BOTH the message (payload previews often embed
    // cookies/JWTs) and the structured data.
    const safeMessage = redactLogMessage(entry.message);
    const safeData = entry.data ? redactLogValue(entry.data) : undefined;

    let output = `${timestamp} ${coloredLevel}${contextPart} ${safeMessage}`;

    if (safeData !== undefined) {
      output += "\n" + JSON.stringify(safeData, null, 2);
    }

    return output;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("debug")) {
      console.log(
        this.formatEntry({
          timestamp: new Date(),
          level: "debug",
          message: this.context ? `[${this.context}] ${message}` : message,
          data,
        }),
      );
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("info")) {
      console.log(
        this.formatEntry({
          timestamp: new Date(),
          level: "info",
          message: this.context ? `[${this.context}] ${message}` : message,
          data,
        }),
      );
    }
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("warn")) {
      console.warn(
        this.formatEntry({
          timestamp: new Date(),
          level: "warn",
          message: this.context ? `[${this.context}] ${message}` : message,
          data,
        }),
      );
    }
  }

  error(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("error")) {
      console.error(
        this.formatEntry({
          timestamp: new Date(),
          level: "error",
          message: this.context ? `[${this.context}] ${message}` : message,
          data,
        }),
      );
    }
  }
}

// Determine initial log level from environment
const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
const toolcallDebugEnv = process.env.TOOLCALL_DEBUG || "errors";

export const toolcallDebugLevel: ToolcallDebugLevel =
  toolcallDebugEnv === "1"
    ? "1"
    : toolcallDebugEnv === "errors"
      ? "errors"
      : "0";

const initialLevel: LogLevel =
  toolcallDebugLevel === "1"
    ? "debug"
    : envLevel && ["debug", "info", "warn", "error"].includes(envLevel)
      ? envLevel
      // Default for general users: quiet terminal with only warnings/errors
      // (+ the always-on request/account console lines). Debugging opt-in via
      // LOG_LEVEL=debug / TOOLCALL_DEBUG=1.
      : "warn";

export const logger = new Logger(initialLevel);

export function isDebugEnabled(): boolean {
  return logger.isLevelEnabled("debug");
}

// Helper to check if toolcall debug is enabled
export function isToolcallDebugEnabled(): boolean {
  return toolcallDebugLevel === "1";
}

export function isToolcallErrorDebugEnabled(): boolean {
  return toolcallDebugLevel === "1" || toolcallDebugLevel === "errors";
}

export const upstreamDebugEnabled = process.env.UPSTREAM_DEBUG === "true";

// Confirm debug mode on startup (only log if explicitly set)
if (process.env.TOOLCALL_DEBUG) {
  if (toolcallDebugLevel === "1") {
    console.log("🔍 [Logger] TOOLCALL_DEBUG=1 - full debug logs active");
  } else if (toolcallDebugLevel === "errors") {
    console.log(
      "[Logger] TOOLCALL_DEBUG=errors - toolcall logs on errors only",
    );
  } else {
    console.log("🔇 [Logger] TOOLCALL_DEBUG=0 - toolcall logs disabled");
  }
}

if (upstreamDebugEnabled) {
  console.log(
    "[Logger] UPSTREAM_DEBUG=true - raw upstream chunks logging active",
  );
}
