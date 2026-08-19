import { config } from "./config.ts";
import { ContextLengthExceededError } from "./errors.ts";
import {
  getModelCapabilities,
  getModelContextWindow,
} from "./model-registry.ts";
import { estimateTokenCount } from "../utils/context-truncation.ts";

const INPUT_TOKEN_SAFETY_MARGIN = 4_096;

/**
 * Maximum number of recent messages to keep when truncating.
 * Older messages are dropped with a truncation notice.
 */
const TRUNCATION_KEEP_RECENT_MESSAGES = 20;

/**
 * Notice added when history is truncated.
 */
const TRUNCATION_NOTICE =
  "\n\n[Context truncated: older messages were removed to fit within model limits. Recent messages preserved.]\n\n";

export interface PromptLimitStats {
  bytes: number;
  estimatedTokens: number;
  modelContextWindow: number;
  usableInputTokens: number;
}

export interface PromptLimitOptions {
  /** Skip the model-token check until live model metadata has been synced. */
  checkModelContext?: boolean;
  /** Use metadata synchronized from this account, never another account. */
  accountId?: string;
}

export function getUtf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function getPromptLimitStats(
  prompt: string,
  modelId: string,
  accountId?: string,
): PromptLimitStats {
  const modelContextWindow = getModelContextWindow(modelId, accountId);
  const capabilities = getModelCapabilities(modelId, accountId);
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
  const maxPromptBytes = config.qwen.maxPromptBytes;
  const checkModelContext = options.checkModelContext !== false;

  // Nothing to enforce: skip the byte scan and the O(n) token estimation
  // entirely (the default QWEN_MAX_PROMPT_BYTES=0 makes the byte check a
  // no-op, and callers pass checkModelContext:false before the live model
  // context window is known).
  if (maxPromptBytes <= 0 && !checkModelContext) {
    return {
      bytes: 0,
      estimatedTokens: 0,
      modelContextWindow: getModelContextWindow(modelId, options.accountId),
      usableInputTokens: 1,
    };
  }

  const stats = getPromptLimitStats(prompt, modelId, options.accountId);

  if (maxPromptBytes > 0 && stats.bytes > maxPromptBytes) {
    throw new ContextLengthExceededError(
      `Input is too large for QwenProxy (${stats.bytes} UTF-8 bytes; limit ${maxPromptBytes}). Reduce or summarize the conversation before retrying.`,
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

export interface TruncationResult {
  prompt: string;
  wasTruncated: boolean;
  originalTokens: number;
  truncatedTokens: number;
  messagesKept: number;
  messagesDropped: number;
}

/**
 * Intelligently truncate a prompt to fit within model context limits.
 * 
 * Strategy:
 * 1. Keep system prompt + tools (instructions) intact
 * 2. Keep recent messages (up to TRUNCATION_KEEP_RECENT_MESSAGES)
 * 3. Drop older messages with a truncation notice
 * 4. If still too large, progressively drop more messages
 */
export function truncatePromptToIntelligentLimit(
  prompt: string,
  modelId: string,
  accountId?: string,
  messages?: Array<{ role: string; content: string | null }>,
): TruncationResult {
  const stats = getPromptLimitStats(prompt, modelId, accountId);
  const originalTokens = stats.estimatedTokens;

  // Within limits, no truncation needed
  if (stats.estimatedTokens <= stats.usableInputTokens) {
    return {
      prompt,
      wasTruncated: false,
      originalTokens,
      truncatedTokens: originalTokens,
      messagesKept: messages?.length ?? 0,
      messagesDropped: 0,
    };
  }

  // If no messages provided, do simple character-based truncation
  if (!messages || messages.length === 0) {
    const maxChars = Math.floor(stats.usableInputTokens * 4); // ~4 chars per token
    const truncated = prompt.slice(0, maxChars);
    return {
      prompt: truncated + TRUNCATION_NOTICE,
      wasTruncated: true,
      originalTokens,
      truncatedTokens: estimateTokenCount(truncated),
      messagesKept: 0,
      messagesDropped: 0,
    };
  }

  // Intelligent truncation: keep recent messages, drop older ones
  const totalMessages = messages.length;
  let keepCount = Math.min(TRUNCATION_KEEP_RECENT_MESSAGES, totalMessages);
  let droppedCount = totalMessages - keepCount;

  // Build truncated prompt from recent messages
  const buildTruncatedPrompt = (keep: number): string => {
    const recentMessages = messages.slice(-keep);
    const messageText = recentMessages
      .map((m) => `${m.role}: ${m.content ?? ""}`)
      .join("\n\n");
    return messageText + TRUNCATION_NOTICE;
  };

  let truncatedPrompt = buildTruncatedPrompt(keepCount);
  let truncatedTokens = estimateTokenCount(truncatedPrompt);

  // Progressively drop more messages if still too large
  while (truncatedTokens > stats.usableInputTokens && keepCount > 1) {
    keepCount = Math.max(1, Math.floor(keepCount / 2));
    droppedCount = totalMessages - keepCount;
    truncatedPrompt = buildTruncatedPrompt(keepCount);
    truncatedTokens = estimateTokenCount(truncatedPrompt);
  }

  // Final fallback: hard character limit
  if (truncatedTokens > stats.usableInputTokens) {
    const maxChars = Math.floor(stats.usableInputTokens * 4);
    truncatedPrompt = truncatedPrompt.slice(0, maxChars) + TRUNCATION_NOTICE;
    truncatedTokens = estimateTokenCount(truncatedPrompt);
  }

  return {
    prompt: truncatedPrompt,
    wasTruncated: true,
    originalTokens,
    truncatedTokens,
    messagesKept: keepCount,
    messagesDropped: droppedCount,
  };
}
