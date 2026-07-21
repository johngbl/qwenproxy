/*
 * File: helpers.ts
 * Project: QwenBridge
 * Description: Stable helper functions for chat completions processing
 */

import { Usage } from "../../utils/types.ts";

export interface DeltaResult {
  delta: string;
  matchedContent: string;
  contentLength: number;
  contentSuffix: string;
}

function buildDeltaResult(delta: string, matchedContent: string): DeltaResult {
  return {
    delta,
    matchedContent,
    contentLength: matchedContent.length,
    contentSuffix: matchedContent.slice(-32),
  };
}

export function getIncrementalDelta(
  oldStr: string,
  newStr: string,
  previousLength = oldStr.length,
  previousSuffix = oldStr.slice(-32),
): DeltaResult {
  if (!oldStr) {
    return buildDeltaResult(newStr, newStr);
  }
  if (newStr === oldStr) {
    return buildDeltaResult("", oldStr);
  }

  // Fast path for cumulative Qwen chunks: validate the old boundary using a
  // short suffix instead of scanning the whole previous content with startsWith.
  // Using 32-byte window (O(1)) since Qwen streams with incremental_output=true.
  if (newStr.length > previousLength && previousLength > 0) {
    const checkLen = Math.min(32, previousLength, previousSuffix.length);
    const expectedSuffix = previousSuffix.slice(-checkLen);
    const actualSuffix = newStr.slice(
      previousLength - checkLen,
      previousLength,
    );

    if (expectedSuffix === actualSuffix) {
      return buildDeltaResult(newStr.slice(previousLength), newStr);
    }
  }

  if (newStr.length >= oldStr.length && newStr.startsWith(oldStr)) {
    return buildDeltaResult(newStr.substring(oldStr.length), newStr);
  }

  // Heuristic to detect if newStr is cumulative or incremental. Compare in
  // small segments first to reduce per-character work on long responses.
  const scanWindow = Math.min(2000, oldStr.length);
  let commonPrefixLen = 0;
  const maxLen = Math.min(scanWindow, newStr.length);
  const segmentLen = 64;

  while (commonPrefixLen + segmentLen <= maxLen) {
    if (
      oldStr.slice(commonPrefixLen, commonPrefixLen + segmentLen) !==
      newStr.slice(commonPrefixLen, commonPrefixLen + segmentLen)
    ) {
      break;
    }
    commonPrefixLen += segmentLen;
  }

  while (
    commonPrefixLen < maxLen &&
    oldStr[commonPrefixLen] === newStr[commonPrefixLen]
  ) {
    commonPrefixLen++;
  }

  const threshold = Math.min(scanWindow, 4);
  if (commonPrefixLen >= threshold) {
    return buildDeltaResult(newStr.substring(commonPrefixLen), newStr);
  }

  // Treat as strictly incremental to avoid false-positive corruptions
  return buildDeltaResult(newStr, oldStr + newStr);
}

export function formatThinkingSummaryContent(delta: any): string {
  const titles = Array.isArray(delta?.extra?.summary_title?.content)
    ? delta.extra.summary_title.content.filter(
        (item: unknown): item is string => typeof item === "string",
      )
    : [];
  const thoughts = Array.isArray(delta?.extra?.summary_thought?.content)
    ? delta.extra.summary_thought.content.filter(
        (item: unknown): item is string => typeof item === "string",
      )
    : [];

  const sectionCount = Math.max(titles.length, thoughts.length);
  const sections: string[] = [];

  for (let i = 0; i < sectionCount; i++) {
    const title = titles[i]?.trim() || "";
    const thought = thoughts[i]?.trim() || "";

    if (title && thought) {
      sections.push(`**${title}**\n\n${thought}`);
    } else if (title) {
      sections.push(`**${title}**`);
    } else if (thought) {
      sections.push(thought);
    }
  }

  return sections.join("\n\n");
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === "AbortError";
  }

  if (!err || typeof err !== "object") return false;

  const maybeError = err as { name?: unknown; message?: unknown };
  const name = maybeError.name;
  const message = maybeError.message;

  return (
    name === "AbortError" ||
    (typeof message === "string" && /abort(ed)?/i.test(message))
  );
}

export function shouldSuppressStreamAbort(
  err: unknown,
  clientDisconnected: boolean,
  requestAborted: boolean,
  streamStillRegistered: boolean,
): boolean {
  return (
    isAbortError(err) &&
    (clientDisconnected || requestAborted || !streamStillRegistered)
  );
}

export interface UsageAccumulator {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  hasRealPromptTokens: boolean;
  hasRealCompletionTokens: boolean;
  hasRealTotalTokens: boolean;
  cachedPromptTokens: number;
  promptTextTokens?: number;
  reasoningTokens?: number;
  completionTextTokens?: number;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createUsageAccumulator(
  estimatedPromptTokens: number,
): UsageAccumulator {
  return {
    promptTokens: estimatedPromptTokens,
    completionTokens: 0,
    totalTokens: estimatedPromptTokens,
    hasRealPromptTokens: false,
    hasRealCompletionTokens: false,
    hasRealTotalTokens: false,
    cachedPromptTokens: 0,
  };
}

export function applyUpstreamUsage(
  accumulator: UsageAccumulator,
  candidate: unknown,
): void {
  if (!candidate || typeof candidate !== "object") return;

  const usage = candidate as Record<string, unknown>;
  const promptTokens = asFiniteNumber(usage.input_tokens);
  const completionTokens = asFiniteNumber(usage.output_tokens);
  const totalTokens = asFiniteNumber(usage.total_tokens);

  if (promptTokens !== null) {
    accumulator.promptTokens = promptTokens;
    accumulator.hasRealPromptTokens = true;
  }

  if (completionTokens !== null) {
    accumulator.completionTokens = completionTokens;
    accumulator.hasRealCompletionTokens = true;
  }

  if (totalTokens !== null) {
    accumulator.totalTokens = totalTokens;
    accumulator.hasRealTotalTokens = true;
  }

  const promptTokensDetails =
    usage.prompt_tokens_details &&
    typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : null;
  const inputTokensDetails =
    usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? (usage.input_tokens_details as Record<string, unknown>)
      : null;
  const outputTokensDetails =
    usage.output_tokens_details &&
    typeof usage.output_tokens_details === "object"
      ? (usage.output_tokens_details as Record<string, unknown>)
      : null;

  const cachedTokens = asFiniteNumber(promptTokensDetails?.cached_tokens);
  if (cachedTokens !== null) {
    accumulator.cachedPromptTokens = cachedTokens;
  }

  const promptTextTokens = asFiniteNumber(inputTokensDetails?.text_tokens);
  if (promptTextTokens !== null) {
    accumulator.promptTextTokens = promptTextTokens;
  }

  const reasoningTokens = asFiniteNumber(outputTokensDetails?.reasoning_tokens);
  if (reasoningTokens !== null) {
    accumulator.reasoningTokens = reasoningTokens;
  }

  const completionTextTokens = asFiniteNumber(outputTokensDetails?.text_tokens);
  if (completionTextTokens !== null) {
    accumulator.completionTextTokens = completionTextTokens;
  }
}

export function buildUsage(accumulator: UsageAccumulator): Usage {
  const usage: Usage = {
    prompt_tokens: accumulator.promptTokens,
    completion_tokens: accumulator.completionTokens,
    total_tokens: accumulator.hasRealTotalTokens
      ? accumulator.totalTokens
      : accumulator.promptTokens + accumulator.completionTokens,
    prompt_tokens_details: {
      cached_tokens: accumulator.cachedPromptTokens,
      ...(accumulator.promptTextTokens !== undefined
        ? { text_tokens: accumulator.promptTextTokens }
        : {}),
    },
  };

  if (
    accumulator.reasoningTokens !== undefined ||
    accumulator.completionTextTokens !== undefined
  ) {
    usage.completion_tokens_details = {
      ...(accumulator.reasoningTokens !== undefined
        ? { reasoning_tokens: accumulator.reasoningTokens }
        : {}),
      ...(accumulator.completionTextTokens !== undefined
        ? { text_tokens: accumulator.completionTextTokens }
        : {}),
    };
  }

  return usage;
}
