import { ZodError } from "zod";
import { logger } from "../core/logger.js";
import {
  QwenBridgeError,
  InternalError,
  ValidationError,
  AuthError,
  UpstreamRateLimit,
  UpstreamError,
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
 * Classifies unknown errors into standard QwenBridgeError hierarchy.
 * Preserves specific error metadata when possible.
 */
export function classifyError(err: unknown): QwenBridgeError {
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

  if (err instanceof QwenBridgeError) {
    return err;
  }

  if (err instanceof ZodError) {
    return new ValidationError(err.message);
  }

  logger.warn("Unclassified error mapped to InternalError", {
    error: err instanceof Error ? err.message : String(err),
  });

  return new InternalError(err instanceof Error ? err.message : String(err));
}
