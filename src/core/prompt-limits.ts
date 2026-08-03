import { config } from "./config.ts";
import { ContextLengthExceededError } from "./errors.ts";
import {
  getModelCapabilities,
  getModelContextWindow,
} from "./model-registry.ts";
import { estimateTokenCount } from "../utils/context-truncation.ts";

const INPUT_TOKEN_SAFETY_MARGIN = 4_096;

export interface PromptLimitStats {
  bytes: number;
  estimatedTokens: number;
  modelContextWindow: number;
  usableInputTokens: number;
}

export interface PromptLimitOptions {
  /** Skip the model-token check until live model metadata has been synced. */
  checkModelContext?: boolean;
}

export function getUtf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function getPromptLimitStats(
  prompt: string,
  modelId: string,
): PromptLimitStats {
  const modelContextWindow = getModelContextWindow(modelId);
  const capabilities = getModelCapabilities(modelId);
  const reservedOutputTokens = Math.max(
    INPUT_TOKEN_SAFETY_MARGIN,
    capabilities.maxOutputTokens,
    capabilities.maxThinkingTokens,
  );

  return {
    bytes: getUtf8ByteLength(prompt),
    estimatedTokens: estimateTokenCount(prompt),
    modelContextWindow,
    usableInputTokens: Math.max(1, modelContextWindow - reservedOutputTokens),
  };
}

/**
 * Reject input that Qwen's web endpoint is unlikely to accept before allocating
 * an upstream chat or retrying it on other accounts.
 */
export function assertPromptWithinLimits(
  prompt: string,
  modelId: string,
  options: PromptLimitOptions = {},
): PromptLimitStats {
  const stats = getPromptLimitStats(prompt, modelId);
  const maxPromptBytes = config.qwen.maxPromptBytes;

  if (maxPromptBytes > 0 && stats.bytes > maxPromptBytes) {
    throw new ContextLengthExceededError(
      `Input is too large for QwenBridge (${stats.bytes} UTF-8 bytes; limit ${maxPromptBytes}). Reduce or summarize the conversation before retrying.`,
    );
  }

  if (
    options.checkModelContext !== false &&
    stats.estimatedTokens > stats.usableInputTokens
  ) {
    throw new ContextLengthExceededError(
      `Input exceeds the usable context for ${modelId} (${stats.estimatedTokens} estimated tokens; limit ${stats.usableInputTokens}). Reduce or summarize the conversation before retrying.`,
    );
  }

  return stats;
}

/**
 * Personalization is account-global Qwen state. Keep its settings payload below
 * a separate cap so a large tool schema cannot trigger a WAF challenge there.
 */
export function isRequestPersonalizationWithinLimit(
  instruction: string,
): boolean {
  const maxPersonalizationBytes = config.qwen.maxPersonalizationBytes;
  return (
    maxPersonalizationBytes <= 0 ||
    getUtf8ByteLength(instruction) <= maxPersonalizationBytes
  );
}
