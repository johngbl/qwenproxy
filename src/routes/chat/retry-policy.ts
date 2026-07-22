/*
 * Generic upstream retry / account-switch policy.
 *
 * Default: retry + prefer another account for unknown/upstream failures.
 * Stop only for a small denylist of terminal local errors.
 */

import { config } from "../../core/config.ts";
import {
  QwenNetworkError,
  QwenUpstreamError,
  QwenUpstreamUnavailableError,
  RetryableQwenStreamError,
} from "../../services/qwen.ts";
import {
  AuthError,
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
  // Only treat as client abort when explicitly flagged as such by caller.
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
  if (err instanceof RetryableQwenStreamError) {
    return errMessage(err).toLowerCase().includes("anti-bot");
  }
  const code = errCode(err);
  const message = errMessage(err).toLowerCase();
  return (
    code === "FAIL_SYS_USER_VALIDATE" ||
    code === "RGV587_ERROR" ||
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
  const hourHint = message.match(/Wait about (\d+) hour/i);
  const temporary =
    message.toLowerCase().includes("rate increased too quickly") ||
    message.toLowerCase().includes("request rate increased too quickly");

  return {
    accountCooldownMs: hourHint
      ? parseInt(hourHint[1], 10) * 60 * 60 * 1000
      : temporary
        ? 5 * 60 * 1000
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

  // Specialized recoveries first (even if wrapped as RetryableQwenStreamError)
    // Corrupted chat history must win over broad "invalid input" matches.
    if (isCorruptedChatHistoryError(err)) {
      return {
        retryable: true,
        switchAccount: true,
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
        switchAccount: inProgress ? typed.switchAccount !== false : false,
        forceNewChat: true,
        retryWithFullPrompt: true,
        retryAfterMs: inProgress
          ? Math.min(typed.retryAfterMs ?? baseDelayMs, 1500)
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
      };
    }

    if (isAntiBotError(err)) {
      const typed = err as RetryableStreamError;
      return {
        retryable: true,
        switchAccount: typed.switchAccount !== false,
        forceNewChat: typed.forceNewChat === true,
        retryWithFullPrompt: typed.retryWithFullPrompt === true,
        retryAfterMs: typed.retryAfterMs ?? config.antiBot.baseDelayMs,
        accountCooldownMs: config.captchaSolver.failCooldownMs,
        accountCooldownReason: "AntiBot",
        reason: "anti_bot",
      };
    }

    if (isQuotaLikeError(err)) {
      const typed = err as RetryableStreamError;
      const quota = classifyQuotaCooldown(errMessage(err));
      return {
        retryable: true,
        switchAccount: typed.switchAccount !== false,
        forceNewChat: typed.forceNewChat === true,
        retryWithFullPrompt: typed.retryWithFullPrompt === true,
        retryAfterMs: typed.retryAfterMs ?? baseDelayMs,
        accountCooldownMs: quota.accountCooldownMs,
        accountCooldownReason: quota.accountCooldownReason,
        reason: "quota_or_rate_limit",
      };
    }

    if (
        err instanceof QwenNetworkError ||
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
            (err instanceof QwenNetworkError
              ? 3000
              : err instanceof QwenUpstreamUnavailableError
                ? 2000
                : Math.min(baseDelayMs * 2, 3000)),
          reason:
            err instanceof QwenNetworkError
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
  return error;
}

/** For SSE error chunks: map any upstream SSE error to throw path. */
export function throwFromSseUpstreamError(
  errCode: string,
  errDetails: string,
): never {
  console.error(
    `[Upstream] Error | ${errCode} | ${errDetails.substring(0, 200)}`,
  );

  // invalid_input keeps dedicated wording for logs/tests (not "chat is not exist")
    const detailsLower = errDetails.toLowerCase();
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
      const error = new RetryableQwenStreamError(
        `Qwen retryable invalid input: ${errCode}: ${errDetails.substring(0, 200)}`,
        config.retry.baseDelayMs,
      ) as RetryableStreamError;
      error.upstreamCode = errCode;
      error.forceNewChat = true;
      error.retryWithFullPrompt = true;
      error.switchAccount = true;
      throw error;
    }

  if (
    errDetails.includes("FAIL_SYS_USER_VALIDATE") ||
    errDetails.includes("RGV587_ERROR") ||
    errDetails.includes("user validate")
  ) {
    const error = new RetryableQwenStreamError(
      `Qwen anti-bot: ${errCode}: ${errDetails}`,
      config.antiBot.baseDelayMs,
    ) as RetryableStreamError;
    error.upstreamCode = errCode;
    error.switchAccount = true;
    throw error;
  }

  throw toRetryableStreamError(errCode, errDetails);
}

export function parseSseErrorFromBuffer(
  buffer: string,
): { code: string; details: string } | null {
  const lines = buffer.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) continue;
    const dataStr = trimmed.slice(6);
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
