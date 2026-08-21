import { ZodError } from "zod";
import { logger } from "../core/logger.js";
import {
  QwenProxyError,
  InternalError,
  ValidationError,
  UpstreamRateLimit,
  UpstreamError,
  UpstreamTimeout,
  ServiceUnavailable,
  ClientAbortedError,
} from "../core/errors.js";
import {
  QwenNetworkError,
  QwenUpstreamUnavailableError,
  RetryableQwenStreamError,
  QwenUpstreamError,
  QwenSessionExpiredError,
  getQwenErrorCode,
} from "../services/qwen.js";

/**
 * Classifies unknown errors into standard QwenProxyError hierarchy.
 * Preserves specific error metadata when possible.
 */
export function classifyError(err: unknown): QwenProxyError {
  // These errors are retryable upstream failures, not rate-limit responses.
  // RetryableQwenStreamError inherits UpstreamRateLimit for legacy behavior,
  // so classify the concrete network/upstream types before that base class.
  if (
    err instanceof QwenNetworkError ||
    err instanceof QwenUpstreamUnavailableError
  ) {
    return new UpstreamError(err.message);
  }

  if (err instanceof RetryableQwenStreamError) {
    const upstreamCode = getQwenErrorCode(err)?.toLowerCase() || "";
    const message = err.message.toLowerCase();

    // Content moderation rejections are client-side content policy violations,
    // not upstream failures. Return 400 so the client can adjust its input.
    if (
      upstreamCode === "data_inspection_failed" ||
      message.includes("content moderation") ||
      message.includes("data_inspection_failed")
    ) {
      const moderationError = new ValidationError(
        `Content rejected by Qwen safety filter: ${err.message.replace(/^Qwen content moderation: [^:]+: /, "")}`,
      );
      (moderationError as any).code = "content_policy_violation";
      return moderationError;
    }

    const isActualRateLimit =
      upstreamCode === "quota_limit" ||
      upstreamCode === "ratelimited" ||
      upstreamCode === "rate_limit" ||
      upstreamCode === "rate_limit_exceeded" ||
      message.includes("quota") ||
      message.includes("upper limit for today");

    return isActualRateLimit
      ? new UpstreamRateLimit(err.message)
      : new UpstreamError(err.message);
  }

  if (err instanceof QwenUpstreamError) {
    return err;
  }

  if (err instanceof QwenSessionExpiredError) {
    return err;
  }

  if (err instanceof QwenProxyError) {
    return err;
  }

  // Client disconnected before the stream could be created. This is not a
  // server fault: the request has no listener anymore. Classify it as a silent
  // abort (499) so callers neither emit a 500 nor count it as an error.
  if (err instanceof Error && err.message.includes("client aborted")) {
    return new ClientAbortedError(err.message);
  }

  // Capacity saturation on the bridge's own account pool: this is a "try again
  // later" condition, not a server fault. A hard 500 is misleading for the
  // client (and for the retry classifier it hides a recoverable slot wait).
  if (
    err instanceof Error &&
    (err as Error & { code?: string }).code === "account_busy"
  ) {
    return new UpstreamRateLimit(err.message);
  }

  // Some call sites attach an explicit hint on a plain Error (e.g.
  // acquireUpstreamStream sets upstreamStatus=429 when the whole pool is in
  // cooldown). Respect it instead of falling through to a misleading 500.
  const rawError = err as Error | null | undefined;
  const statusHint = (err as Error & { upstreamStatus?: number })
    ?.upstreamStatus;
  if (typeof statusHint === "number") {
    const message =
      rawError instanceof Error
        ? rawError.message
        : typeof err === "string"
          ? err
          : "Unknown upstream error";
    switch (statusHint) {
      case 429:
        return new UpstreamRateLimit(message);
      case 502:
        return new UpstreamError(message);
      case 503:
        return new ServiceUnavailable(message);
      case 504:
        return new UpstreamTimeout(message);
      default:
        break; // unknown hint: fall through to the normal mapping
    }
  }

  if (err instanceof ZodError) {
    return new ValidationError(err.message);
  }

  logger.warn("Unclassified error mapped to InternalError", {
    error: err instanceof Error ? err.message : String(err),
  });

  return new InternalError(err instanceof Error ? err.message : String(err));
}
