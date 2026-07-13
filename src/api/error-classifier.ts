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
  RetryableQwenStreamError,
  QwenUpstreamError,
  QwenSessionExpiredError,
} from "../services/qwen.js";

/**
 * Classifies unknown errors into standard QwenBridgeError hierarchy.
 * Preserves specific error metadata when possible.
 */
export function classifyError(err: unknown): QwenBridgeError {
  if (err instanceof RetryableQwenStreamError) {
    if (err.retryAfterMs > 0 && err.retryAfterMs < 60000) {
      return new UpstreamRateLimit(err.message);
    }
    return new UpstreamError(err.message);
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
