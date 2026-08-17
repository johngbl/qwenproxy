/*
 * Generic upstream retry / account-switch policy.
 *
 * Default: retry + prefer another account for unknown/upstream failures.
 * Stop only for a small denylist of terminal local errors.
 */

import { config } from "../../core/config.ts";
import { logger } from "../../core/logger.ts";
import {
  PersonalizationSyncError,
  QwenNetworkError,
  QwenUpstreamError,
  QwenUpstreamUnavailableError,
  RetryableQwenStreamError,
} from "../../services/qwen.ts";
import {
  AuthError,
  ClientAbortedError,
  NotFoundError,
  ValidationError,
} from "../../core/errors.ts";
import { isAbortError } from "./helpers.ts";

export type RetryAction = {
  /** Outer/create-stream layer should retry this failure */
  retryable: boolean;
  /** Prefer switching to another account when available */
  switchAccount: boolean;
  /** Force a new Qwen chat on retry */
  forceNewChat: boolean;
  /** Resend full conversation context (not just delta) */
  retryWithFullPrompt: boolean;
  /** Drop attached files on retry (for invalid_input caused by bad attachments) */
  dropFiles?: boolean;
  /** Suggested delay before next attempt */
  retryAfterMs: number;
  /** Optional short cooldown for the failing account */
  accountCooldownMs?: number;
  /** Cooldown reason label */
  accountCooldownReason?: string;
  /** Why this action was chosen (logging/debug) */
  reason: string;
};

export type RetryableStreamError = RetryableQwenStreamError & {
  upstreamCode?: string;
  forceNewChat?: boolean;
  retryWithFullPrompt?: boolean;
  switchAccount?: boolean;
  dropFiles?: boolean;
};

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || "";
  return String(err ?? "");
}

function errCode(err: unknown): string {
  const anyErr = err as { upstreamCode?: unknown; code?: unknown };
  if (typeof anyErr?.upstreamCode === "string" && anyErr.upstreamCode) {
    return anyErr.upstreamCode;
  }
  if (typeof anyErr?.code === "string" && anyErr.code) {
    return anyErr.code;
  }
  return "";
}

function statusOf(err: unknown): number | undefined {
  const anyErr = err as { upstreamStatus?: unknown; statusCode?: unknown };
  if (typeof anyErr?.upstreamStatus === "number") return anyErr.upstreamStatus;
  if (typeof anyErr?.statusCode === "number") return anyErr.statusCode;
  return undefined;
}

/** Errors that belong to the proxy/client request itself — retrying is useless. */
export function isTerminalLocalError(err: unknown): boolean {
  if (!err) return false;

  if (
    err instanceof ValidationError ||
    err instanceof AuthError ||
    err instanceof NotFoundError
  ) {
    return true;
  }

  const status = statusOf(err);
  const code = errCode(err).toLowerCase();
  const message = errMessage(err).toLowerCase();

  // Local proxy auth / validation / not found
  if (status === 400 || status === 401 || status === 404) {
    // Exception: Qwen upstream can also return 404 for missing chat — that is retryable.
    if (
      message.includes("qwen") ||
      message.includes("upstream") ||
      code.includes("not_found") ||
      message.includes("is not exist") ||
      message.includes("does not exist")
    ) {
      return false;
    }
    return true;
  }

  if (
    code === "invalid_api_key" ||
    code === "authentication_error" ||
    message.includes("missing or invalid authorization") ||
    message.includes("invalid api key") ||
    message.includes("messages is required") ||
    message.includes("at least one user message") ||
    message.includes("no qwen accounts configured")
  ) {
    return true;
  }

  // bad_request from Qwen upstream is NOT terminal — it's a corrupted chat
  // or invalid payload that can be recovered with a new chat + full prompt.
  // Only treat as terminal when it's clearly a local proxy validation error.
  if (code === "bad_request") {
    const isQwenUpstream =
      message.includes("qwen") ||
      message.includes("upstream") ||
      message.includes("invalid input") ||
      message.includes("first message must not") ||
      message.includes("entrada ou anexo");
    if (!isQwenUpstream) {
      return true;
    }
  }

  return false;
}

export function isClientAbortError(
  err: unknown,
  clientDisconnected = false,
  requestAborted = false,
): boolean {
  if (clientDisconnected || requestAborted) return true;
  // Our own client-abort markers: the client disconnected OR a same-session
  // retry superseded this request's lease during stream creation. A superseded
  // request must die silently — the newer request owns the session, and
  // retrying the old one resends full context on another account for nothing
  // (and can queue indefinitely behind the new stream's lease).
  if (err instanceof ClientAbortedError) return true;
  if (err instanceof Error && err.message.includes("client aborted")) return true;
  // Bare AbortError mid-stream is usually idle/upstream timeout (retryable).
  return false;
}

export function isInvalidInputError(err: unknown): boolean {
  // "Invalid input the chat X is not exist" is a chat-missing error, not attachment invalid.
  if (isChatNotExistError(err)) return false;

  const code = errCode(err).toLowerCase();
  const message = errMessage(err).toLowerCase();
  return (
    code === "invalid_input" ||
    message.includes("invalid_input") ||
    message.includes("entrada ou anexo inválido") ||
    message.includes("invalid input") ||
    message.includes("invalid attachment")
  );
}

/**
 * Qwen content-safety moderation rejections (data_inspection_failed).
 * These are deterministic: the same content will be rejected on any account,
 * so retrying or switching accounts only wastes resources and time.
 */
export function isContentModerationError(err: unknown): boolean {
  const code = errCode(err).toLowerCase();
  const message = errMessage(err).toLowerCase();
  return (
    code === "data_inspection_failed" ||
    message.includes("data_inspection_failed") ||
    message.includes("conteúdo inadequado") ||
    message.includes("inappropriate content") ||
    message.includes("aviso de segurança do conteúdo") ||
    message.includes("content safety")
  );
}

/** Prefer a clean chat on the current account before paying the cost of replaying
 * the full context on another account. Callers keep their own per-request count. */
export function shouldRetryInvalidInputOnSameAccount(
  reason: string,
  alreadyRetried: boolean,
): boolean {
  return (
    (reason === "invalid_input" || reason === "corrupted_chat_history") &&
    !alreadyRetried
  );
}

/** Keep TWO retries on the current account while an upstream generation
 * settles. The tool loop fires the next turn the instant the previous one
 * completes, and the upstream chat stays "in progress" for 2-4s after the
 * terminal event — a single ~1.2s retry often loses that settle race, and
 * escalating replays the FULL context on a cold account (~12s context reopen
 * + captcha). Rotate only after the second failure. */
export function shouldRetryChatInProgressOnSameAccount(
  reason: string,
  alreadyRetriedCount: number,
): boolean {
  // Three same-chat retries: settle is usually 2-4s but was measured >6s after
  // huge turns, and the escalation alternative (full-context replay on a cold
  // account) is far more expensive than one more bounded wait.
  return reason === "chat_in_progress" && alreadyRetriedCount < 3;
}

export function isAccountInitializationError(err: unknown): boolean {
  const message = errMessage(err).toLowerCase();
  return (
    message.includes("header capture returned incomplete anti-fraud headers") ||
    message.includes("required qwen anti-fraud headers are unavailable") ||
    message.includes("playwright not initialized for account") ||
    message.includes("playwright page unavailable") ||
    message.includes("playwright page operation timed out") ||
    message.includes("playwright re-initialization timed out")
  );
}

export function isQuotaLikeError(err: unknown): boolean {
  // Chat-not-exist / invalid attachment must never look like quota.
  if (isChatNotExistError(err) || isInvalidInputError(err)) return false;

  const code = errCode(err).toLowerCase();
  const message = errMessage(err).toLowerCase();

  // Note: RetryableQwenStreamError inherits OpenAI-style code "rate_limit_exceeded".
  // Never treat that local code alone as quota — require message/upstream evidence.
  return (
    code === "quota_limit" ||
    code === "ratelimited" ||
    message.includes("quota_limit") ||
    message.includes("quota exceeded") ||
    message.includes("allocated quota") ||
    message.includes("token-limit") ||
    message.includes("insufficient quota") ||
    message.includes("alta demanda") ||
    message.includes("high demand") ||
    message.includes("request rate increased too quickly") ||
    message.includes("rate increased too quickly") ||
    message.includes("upper limit for today's usage") ||
    message.includes("you've reached the upper limit") ||
    // Accept local rate_limit code only when message also looks like quota/rate
    (code === "rate_limit_exceeded" &&
      (message.includes("quota") ||
        message.includes("rate") ||
        message.includes("limit") ||
        message.includes("demanda") ||
        message.includes("demand")))
  );
}

export function isAntiBotError(err: unknown): boolean {
  const code = errCode(err);
  const codeLower = code.toLowerCase();
  const message = errMessage(err).toLowerCase();
  if (err instanceof RetryableQwenStreamError) {
    return codeLower === "waf_challenge" || message.includes("anti-bot");
  }
  return (
    code === "FAIL_SYS_USER_VALIDATE" ||
    code === "RGV587_ERROR" ||
    codeLower === "waf_challenge" ||
    message.includes("fail_sys_user_validate") ||
    message.includes("rgv587_error") ||
    message.includes("_____tmd_____") ||
    message.includes("tmd anti-bot") ||
    message.includes("captcha") ||
    message.includes("security verification") ||
    message.includes("verify you are human") ||
    message.includes("human verification") ||
    message.includes("denyfromx5")
  );
}

function classifyQuotaCooldown(message: string): {
  accountCooldownMs?: number;
  accountCooldownReason: string;
} {
  const lower = message.toLowerCase();
  const hourHint = message.match(/Wait about (\d+) hour/i);
  const temporary =
    lower.includes("rate increased too quickly") ||
    lower.includes("request rate increased too quickly") ||
    lower.includes("alta demanda") ||
    lower.includes("high demand") ||
    lower.includes("tente novamente mais tarde") ||
    lower.includes("try again later");

  return {
    accountCooldownMs: hourHint
      ? parseInt(hourHint[1], 10) * 60 * 60 * 1000
      : temporary
        ? 2 * 60 * 1000
        : undefined,
    accountCooldownReason: temporary
      ? "RateLimitTemporary"
      : hourHint
        ? "RateLimited"
        : "QuotaExceeded",
  };
}

export function isChatNotExistError(err: unknown): boolean {
  const message = errMessage(err).toLowerCase();
  return (
    message.includes("is not exist") ||
    message.includes("not exist") ||
    message.includes("does not exist")
  );
}

export function isChatInProgressError(err: unknown): boolean {
  return errMessage(err).toLowerCase().includes("in progress");
}

/**
 * Qwen rejects a model the account cannot serve with Not_Found: Model not found.
 * This is deterministic per request — retrying on the same (or any) account
 * with the same model can never succeed, so it must terminate instead of
 * burning retry attempts / account cooldowns and ending in a misleading 502.
 */
export function isModelNotFoundError(err: unknown): boolean {
  const code = errCode(err).toLowerCase();
  const message = errMessage(err).toLowerCase();
  return (
    (code === "not_found" &&
      message.includes("model") &&
      message.includes("not found")) ||
    message.includes("model not found")
  );
}

/**
 * Browser fetch and ReadableStream failures often arrive as plain Error
 * instances, especially when the stream is consumed outside Playwright.
 * Keep this matcher narrow so local programming errors are not retried as
 * account/network failures.
 */
export function isNetworkLikeError(err: unknown): boolean {
  if (err instanceof QwenNetworkError) return true;
  const message = errMessage(err).toLowerCase();
  return (
    message === "network error" ||
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("network connection was lost") ||
    message.includes("connection reset") ||
    message.includes("connection closed") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout")
  );
}

/**
 * Corrupted chat history: Qwen rejects because the first message in the
 * upstream chat thread is an assistant message (broken parent_id chain).
 * Recovery: force new chat + resend full prompt + switch account.
 */
export function isCorruptedChatHistoryError(err: unknown): boolean {
  const message = errMessage(err).toLowerCase();
  return (
    message.includes("first message must not") ||
    message.includes("first message must be") ||
    message.includes("must not assistant message") ||
    message.includes("must not be assistant")
  );
}

/**
 * Generic recovery policy for create-stream + mid-stream failures.
 * Unknown upstream errors are retryable by default when enabled in config.
 */
export function classifyRetryAction(
  err: unknown,
  options?: {
    clientDisconnected?: boolean;
    requestAborted?: boolean;
    baseDelayMs?: number;
  },
): RetryAction {
  const baseDelayMs = options?.baseDelayMs ?? config.retry.baseDelayMs;
  const unknownEnabled = config.retry.onUnknownUpstream !== false;

  if (
    isClientAbortError(
      err,
      options?.clientDisconnected === true,
      options?.requestAborted === true,
    )
  ) {
    return {
      retryable: false,
      switchAccount: false,
      forceNewChat: false,
      retryWithFullPrompt: false,
      retryAfterMs: 0,
      reason: "client_abort",
    };
  }

  if (isTerminalLocalError(err)) {
    return {
      retryable: false,
      switchAccount: false,
      forceNewChat: false,
      retryWithFullPrompt: false,
      retryAfterMs: 0,
      reason: "terminal_local",
    };
  }

  const message = errMessage(err).toLowerCase();
  const code = errCode(err).toLowerCase();
  if (isAccountInitializationError(err)) {
    return {
      retryable: true,
      switchAccount: true,
      forceNewChat: false,
      retryWithFullPrompt: false,
      retryAfterMs: Math.min(baseDelayMs, 1_000),
      accountCooldownMs: config.concurrency.initFailureCooldownMs,
      accountCooldownReason: "AuthInitFailed",
      reason: "account_initialization_failed",
    };
  }

  if (
    code === "account_busy" ||
    message.includes("waiting for a free slot") ||
    message.includes("busy: timed out")
  ) {
    return {
      retryable: true,
      switchAccount: true,
      forceNewChat: false,
      retryWithFullPrompt: false,
      retryAfterMs: Math.min(baseDelayMs, 1_000),
      reason: "account_busy",
    };
  }

  // Agent instructions ride ONLY the account-level personalization. An
  // unconfirmed sync means this account cannot serve the request as-is —
  // rotate to another account (each attempt re-syncs on its own account).
  if (err instanceof PersonalizationSyncError) {
    return {
      retryable: true,
      switchAccount: true,
      forceNewChat: true,
      retryWithFullPrompt: false,
      retryAfterMs: baseDelayMs,
      reason: "personalization_sync_failed",
    };
  }

  // Specialized recoveries first (even if wrapped as RetryableQwenStreamError)
    // Corrupted chat history must win over broad "invalid input" matches.
    // Try a fresh chat on the SAME account first — the corruption is in the
    // upstream parent chain, not the account. Only rotate if the rebuild fails.
    if (isCorruptedChatHistoryError(err)) {
      return {
        retryable: true,
        switchAccount: false,
        forceNewChat: true,
        retryWithFullPrompt: true,
        retryAfterMs: 0,
        reason: "corrupted_chat_history",
      };
    }

    // Chat missing must win over broad "invalid input" substring matches.
    if (isChatNotExistError(err) || isChatInProgressError(err)) {
      const typed = err as RetryableStreamError;
      const inProgress = isChatInProgressError(err);
      return {
        retryable: true,
        // chat_in_progress: do NOT switch immediately — the account is just
        // temporarily busy. Escalation to switch happens in tryCreateStreamWithRetry
        // after repeated failures on the same account.
        switchAccount: inProgress ? false : false,
        forceNewChat: !inProgress, // chat_not_exist needs a new chat; in_progress retries same first
        retryWithFullPrompt: !inProgress,
        retryAfterMs: inProgress
          ? (typed.retryAfterMs ?? config.retry.chatInProgressDelayMs)
          : (typed.retryAfterMs ?? 0),
        reason: inProgress ? "chat_in_progress" : "chat_not_exist",
      };
    }

    if (isInvalidInputError(err)) {
      const typed = err as RetryableStreamError;
      return {
        retryable: true,
        switchAccount: typed.switchAccount !== false,
        forceNewChat: true,
        retryWithFullPrompt: true,
        retryAfterMs: typed.retryAfterMs ?? baseDelayMs,
        reason: "invalid_input",
        dropFiles: typed.dropFiles,
      };
    }

    // Content moderation rejections are deterministic — retrying on any
    // account with the same content produces the same rejection. Fail fast
    // instead of burning through accounts, personalization syncs and captchas.
    if (isContentModerationError(err)) {
      return {
        retryable: false,
        switchAccount: false,
        forceNewChat: false,
        retryWithFullPrompt: false,
        retryAfterMs: 0,
        reason: "content_moderation",
      };
    }

    // Model not found is equally deterministic (the account cannot serve the
    // requested model). Fail fast with a clear error instead of retrying the
    // same doomed request and cooldown-marking accounts for ~5 hours.
    if (isModelNotFoundError(err)) {
      return {
        retryable: false,
        switchAccount: false,
        forceNewChat: false,
        retryWithFullPrompt: false,
        retryAfterMs: 0,
        reason: "model_not_found",
      };
    }

    if (isAntiBotError(err)) {
      // WAF/captcha is only identified here. Retry the same request on the
      // same account immediately; recovery, cooldown and account rotation are
      // intentionally left out so the failure path stays observable.
      return {
        retryable: true,
        switchAccount: false,
        forceNewChat: false,
        retryWithFullPrompt: false,
        retryAfterMs: 0,
        reason: "anti_bot",
      };
    }

    if (isQuotaLikeError(err)) {
      const typed = err as RetryableStreamError;
      const quota = classifyQuotaCooldown(errMessage(err));
      const isTemporary = quota.accountCooldownReason === "RateLimitTemporary";
      return {
        retryable: true,
        // Temporary load shedding: retry same account first, only switch on
        // repeated failure. Real quota exhaustion: switch immediately.
        switchAccount: isTemporary ? false : typed.switchAccount !== false,
        forceNewChat: typed.forceNewChat === true,
        retryWithFullPrompt: typed.retryWithFullPrompt === true,
        retryAfterMs: typed.retryAfterMs ?? (isTemporary ? 3_000 : baseDelayMs),
        accountCooldownMs: quota.accountCooldownMs,
        accountCooldownReason: quota.accountCooldownReason,
        reason: "quota_or_rate_limit",
      };
    }

    if (
        isNetworkLikeError(err) ||
        err instanceof QwenUpstreamUnavailableError ||
        err instanceof QwenUpstreamError ||
        isAbortError(err)
      ) {
        const typed = err as RetryableStreamError;
        return {
          retryable: true,
          switchAccount: typed.switchAccount !== false,
          forceNewChat: true,
          retryWithFullPrompt: typed.retryWithFullPrompt === true,
          retryAfterMs:
            typed.retryAfterMs ??
            (isNetworkLikeError(err)
              ? 3000
              : err instanceof QwenUpstreamUnavailableError
                ? 2000
                : Math.min(baseDelayMs * 2, 3000)),
          reason:
            isNetworkLikeError(err)
              ? "network"
              : err instanceof QwenUpstreamUnavailableError
                ? "upstream_unavailable"
                : isAbortError(err)
                  ? "stream_aborted"
                  : "upstream_error",
        };
      }

    // Preserve explicit RetryableQwenStreamError flags for remaining cases
    if (err instanceof RetryableQwenStreamError) {
      const typed = err as RetryableStreamError;
      return {
        retryable: true,
        // Default switch unless caller explicitly set switchAccount=false
        switchAccount: typed.switchAccount !== false,
        forceNewChat: typed.forceNewChat === true,
        retryWithFullPrompt: typed.retryWithFullPrompt === true,
        retryAfterMs: typed.retryAfterMs ?? baseDelayMs,
        reason: "explicit_retryable",
      };
    }

  // Default for unknown failures: retry when policy enabled
  if (unknownEnabled) {
    return {
      retryable: true,
      switchAccount: true,
      forceNewChat: true,
      retryWithFullPrompt: false,
      retryAfterMs: baseDelayMs,
      reason: "unknown_upstream_default_retry",
    };
  }

  return {
    retryable: false,
    switchAccount: false,
    forceNewChat: false,
    retryWithFullPrompt: false,
    retryAfterMs: 0,
    reason: "unknown_not_retryable",
  };
}

/** Build a RetryableQwenStreamError for SSE/mid-stream failures with policy flags. */
export function toRetryableStreamError(
  errCode: string,
  errDetails: string,
  options?: Partial<RetryAction>,
): RetryableStreamError {
  const policy = classifyRetryAction(
    Object.assign(new Error(`${errCode}: ${errDetails}`), {
      upstreamCode: errCode,
    }),
  );
  const merged: RetryAction = {
    ...policy,
    ...options,
    retryable: true,
    reason: options?.reason || policy.reason,
  };

  const error = new RetryableQwenStreamError(
    `Qwen retryable upstream error: ${errCode}: ${errDetails.substring(0, 200)}`,
    merged.retryAfterMs || config.retry.baseDelayMs,
  ) as RetryableStreamError;

  error.upstreamCode = errCode;
  error.forceNewChat = merged.forceNewChat;
  error.retryWithFullPrompt = merged.retryWithFullPrompt;
  error.switchAccount = merged.switchAccount;
  error.dropFiles = merged.dropFiles;
  return error;
}

/** For SSE error chunks: map any upstream SSE error to throw path. */
export function throwFromSseUpstreamError(
  errCode: string,
  errDetails: string,
): never {
  const detailsLower = errDetails.toLowerCase();
  // Qwen sometimes labels the chat-state error as RateLimited. Normalize it
  // before retry/logging so it cannot be mistaken for account quota exhaustion.
  const normalizedErrCode =
    detailsLower.includes("chat is in progress") ||
    detailsLower.includes("the chat is in progress")
      ? "chat_in_progress"
      : errCode;

  // Log upstream errors. Expected retryable codes (quota, rate limit, chat
  // state) use warn level to avoid noisy stderr stack traces in production.
  const expectedCodes = new Set([
    "quota_limit",
    "rate_limit",
    "rate_limit_exceeded",
    "chat_in_progress",
    "invalid_input",
    "data_inspection_failed",
  ]);
  if (expectedCodes.has(normalizedErrCode.toLowerCase())) {
    logger.warn(
      `[Upstream] Error | ${normalizedErrCode} | ${errDetails.substring(0, 200)}`,
    );
  } else {
    console.error(
      `[Upstream] Error | ${normalizedErrCode} | ${errDetails.substring(0, 200)}`,
    );
  }

  // invalid_input keeps dedicated wording for logs/tests (not "chat is not exist")
  const isChatMissing =
    detailsLower.includes("is not exist") ||
    detailsLower.includes("does not exist") ||
    /\bnot exist\b/.test(detailsLower);
  if (
    !isChatMissing &&
    (errCode.toLowerCase() === "invalid_input" ||
      detailsLower.includes("entrada ou anexo inválido") ||
      detailsLower.includes("invalid input") ||
      detailsLower.includes("invalid attachment"))
  ) {
    logger.warn("[Upstream] invalid_input mid-stream detected", {
      code: errCode,
      detailsLength: errDetails.length,
      messageMentionsAttachment:
        detailsLower.includes("anexo") || detailsLower.includes("attachment"),
      messageMentionsFile:
        detailsLower.includes("file") || detailsLower.includes("arquivo"),
    });

    const error = new RetryableQwenStreamError(
      `Qwen retryable invalid input: ${errCode}: ${errDetails.substring(0, 200)}`,
      config.retry.baseDelayMs,
    ) as RetryableStreamError;
    error.upstreamCode = errCode;
    error.forceNewChat = true;
    error.retryWithFullPrompt = true;
    error.switchAccount = true;
    error.dropFiles = true; // Drop files on retry to isolate file-related errors
    throw error;
  }

  // Content moderation rejections are deterministic — the same content will
  // be rejected on every account. Throw as RetryableQwenStreamError so it
  // propagates through the streaming catch blocks, but classifyRetryAction
  // will mark it non-retryable.
  if (isContentModerationError({ upstreamCode: normalizedErrCode, message: errDetails })) {
    logger.warn(
      `[Upstream] Content moderation rejection (not retrying): ${normalizedErrCode}`,
    );
    const error = new RetryableQwenStreamError(
      `Qwen content moderation: ${normalizedErrCode}: ${errDetails.substring(0, 200)}`,
      0,
    ) as RetryableStreamError;
    error.upstreamCode = normalizedErrCode;
    error.switchAccount = false;
    throw error;
  }

  // A model the account cannot serve is a deterministic rejection too — never
  // transparently retrofit this doomed model request on the same/other account.
  if (isModelNotFoundError({ upstreamCode: normalizedErrCode, message: errDetails })) {
    logger.warn(
      `[Upstream] Model not available (not retrying): ${normalizedErrCode}`,
    );
    const error = new RetryableQwenStreamError(
      `Qwen model not found: ${normalizedErrCode}: ${errDetails.substring(0, 200)}`,
      0,
    ) as RetryableStreamError;
    error.upstreamCode = normalizedErrCode;
    error.switchAccount = false;
    throw error;
  }

  if (
    errDetails.includes("FAIL_SYS_USER_VALIDATE") ||
    errDetails.includes("RGV587_ERROR") ||
    errDetails.includes("user validate")
  ) {
    const error = new RetryableQwenStreamError(
      `Qwen anti-bot: ${errCode}: ${errDetails}`,
      0,
    ) as RetryableStreamError;
    error.upstreamCode = errCode;
    error.switchAccount = true;
    throw error;
  }

  throw toRetryableStreamError(normalizedErrCode, errDetails);
}

export function parseSseErrorFromBuffer(
  buffer: string,
): { code: string; details: string } | null {
  const lines = buffer.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trimStart();
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      const chunk = JSON.parse(dataStr);
      if (chunk?.error) {
        return {
          code: chunk.error.code || "upstream_error",
          details:
            chunk.error.details ||
            chunk.error.message ||
            JSON.stringify(chunk.error),
        };
      }
    } catch {
      // ignore non-JSON SSE lines
    }
  }
  return null;
}
