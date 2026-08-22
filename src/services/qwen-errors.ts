import {
  QwenProxyError,
  UpstreamRateLimit,
  UpstreamError,
  AuthError,
} from "../core/errors.ts";

/**
 * Messages from the completion fetch that indicate a transient network or
 * first-byte stall. These must be treated as retryable so tryCreateStreamWithRetry
 * rotates to another account instead of failing with a terminal 500 that the
 * client has to retry manually (which looks like an infinite hang).
 */
export function isRetryableFetchErrorMessage(message: string): boolean {
  return (
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ETIMEDOUT") ||
    message.includes("etimedout") ||
    message.includes("ENOTFOUND") ||
    message.includes("network") ||
    message.includes("timed out waiting for response headers")
  );
}

export class RetryableQwenStreamError extends UpstreamRateLimit {
  readonly retryAfterMs: number;
  /** Original upstream category; avoids exposing the inherited rate-limit code. */
  upstreamCode?: string;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RetryableQwenStreamError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The account-level personalization sync could not be confirmed. Agent
 * instructions ride ONLY the personalization channel (never inline in the
 * prompt), so an unconfirmed sync must fail the attempt — the retry policy
 * rotates to another account — instead of sending a request the model would
 * answer without any instructions or tools. Surfaces as 503 (service
 * degraded) if every account fails to sync.
 */
export class PersonalizationSyncError extends QwenProxyError {
  readonly statusCode = 503;
  readonly type = "service_unavailable";
  readonly code = "personalization_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "PersonalizationSyncError";
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
    this.upstreamCode = "upstream_unavailable";
    this.httpStatusCode = httpStatusCode;
  }
}

export class QwenNetworkError extends RetryableQwenStreamError {
  constructor(message: string) {
    super(message, 3000);
    this.name = "QwenNetworkError";
    this.upstreamCode = "network_error";
  }
}

/**
 * Return the meaningful upstream category for logs and OpenAI error payloads.
 * RetryableQwenStreamError inherits the rate-limit base class for legacy retry
 * handling, so its inherited `code` must not be used as the actual category.
 */
export function getQwenErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;

  const typed = error as {
    upstreamCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (typeof typed.upstreamCode === "string" && typed.upstreamCode) {
    return typed.upstreamCode;
  }

  if (error instanceof QwenNetworkError) return "network_error";
  if (error instanceof QwenUpstreamUnavailableError) {
    return "upstream_unavailable";
  }

  if (error instanceof RetryableQwenStreamError) {
    const message = typeof typed.message === "string" ? typed.message.toLowerCase() : "";
    if (message.includes("chat is in progress")) return "chat_in_progress";
    if (message.includes("not exist") || message.includes("does not exist")) {
      return "chat_not_exist";
    }
    if (message.includes("anti-bot") || message.includes("captcha")) {
      return "waf_challenge";
    }
    return "upstream_retryable";
  }

  return typeof typed.code === "string" && typed.code ? typed.code : undefined;
}
