import { config } from "../core/config.ts";
import {
  getModelCapabilities,
  getModelContextWindow,
  getModelContextWindowSource,
} from "../core/model-registry.ts";
import { estimateTokenCount } from "../utils/context-truncation.ts";
import type { PersonalizationEstimationInfo } from "./token-estimation-metrics.ts";
import type { Usage } from "../utils/types.ts";

export type ContextMeterMode = "full" | "delta" | "replay";

export interface ContextMeterOptions {
  enabled: boolean;
  windowTokens: number;
  reportUsage: boolean;
}

export interface ContextMeterSnapshot {
  enabled: true;
  estimate: "heuristic";
  model: string;
  contextWindowTokens: number;
  contextWindowSource: "configured" | "upstream" | "registry" | "default";
  reservedOutputTokens: number;
  usableInputTokens: number;
  estimatedContextTokens: number;
  estimatedRequestTokens: number;
  estimatedContextPercent: number;
  estimatedUsablePercent: number;
  remainingContextTokens: number;
  remainingUsableTokens: number;
  fullPromptChars: number;
  fullPromptBytes: number;
  requestPromptChars: number;
  requestPromptBytes: number;
  qwenPayloadBytes: number | null;
  qwenPayloadPromptChars: number | null;
  qwenPayloadMessageCount: number | null;
  messageCount: number | null;
  fullMessageCount: number | null;
  toolsCount: number;
  filesCount: number;
  personalizationBytes: number;
  personalizationTokens: number;
  mode: ContextMeterMode;
  upstreamPromptTokens: number | null;
  upstreamContextPercent: number | null;
  upstreamRemainingContextTokens: number | null;
  reportedPromptTokens: number | null;
  measurementSource: "qwen" | "local_estimate" | "unavailable";
}

export interface BuildContextMeterInput {
  modelId: string;
  accountId?: string;
  requestPrompt: string;
  fullPrompt: string;
  mode: ContextMeterMode;
  qwenPayloadBytes?: number;
  qwenPayloadPromptChars?: number;
  qwenPayloadMessageCount?: number;
  messageCount?: number;
  fullMessageCount?: number;
  toolsCount?: number;
  filesCount?: number;
  activePersonalization?: PersonalizationEstimationInfo | null;
}

export interface MeteredUsage extends Usage {
  context_meter: ContextMeterSnapshot;
}

function roundPercent(value: number): number {
  return Number(value.toFixed(2));
}

function getReservedOutputTokens(
  modelId: string,
  accountId?: string,
): number {
  const capabilities = getModelCapabilities(modelId, accountId);
  return Math.max(
    4_096,
    capabilities.maxOutputTokens,
    capabilities.maxThinkingTokens,
  );
}

export function getContextMeterOptions(): ContextMeterOptions {
  return {
    enabled: config.contextMeter.enabled,
    windowTokens: config.contextMeter.windowTokens,
    reportUsage: config.contextMeter.reportUsage,
  };
}

/**
 * Build a request-time context estimate without serializing or retaining the
 * prompt. `fullPrompt` is the complete history reconstructed from the client;
 * `requestPrompt` is the delta or replay actually sent to Qwen.
 */
export function buildContextMeterSnapshot(
  input: BuildContextMeterInput,
  options: ContextMeterOptions = getContextMeterOptions(),
): ContextMeterSnapshot | null {
  if (!options.enabled) return null;

  const contextWindowTokens =
    options.windowTokens > 0
      ? options.windowTokens
      : getModelContextWindow(input.modelId, input.accountId);
  const contextWindowSource =
    options.windowTokens > 0
      ? "configured"
      : getModelContextWindowSource(input.modelId, input.accountId);
  const reservedOutputTokens = getReservedOutputTokens(
    input.modelId,
    input.accountId,
  );
  const usableInputTokens = Math.max(
    1,
    contextWindowTokens - reservedOutputTokens,
  );
  const estimatedContextTokens = estimateTokenCount(input.fullPrompt);
  const estimatedRequestTokens = estimateTokenCount(input.requestPrompt);
  const personalization = input.activePersonalization ?? null;

  return {
    enabled: true,
    estimate: "heuristic",
    model: input.modelId,
    contextWindowTokens,
    contextWindowSource,
    reservedOutputTokens,
    usableInputTokens,
    estimatedContextTokens,
    estimatedRequestTokens,
    estimatedContextPercent: roundPercent(
      (estimatedContextTokens / contextWindowTokens) * 100,
    ),
    estimatedUsablePercent: roundPercent(
      (estimatedContextTokens / usableInputTokens) * 100,
    ),
    remainingContextTokens: Math.max(
      0,
      contextWindowTokens - estimatedContextTokens,
    ),
    remainingUsableTokens: Math.max(
      0,
      usableInputTokens - estimatedContextTokens,
    ),
    fullPromptChars: input.fullPrompt.length,
    fullPromptBytes: Buffer.byteLength(input.fullPrompt, "utf8"),
    requestPromptChars: input.requestPrompt.length,
    requestPromptBytes: Buffer.byteLength(input.requestPrompt, "utf8"),
    qwenPayloadBytes: input.qwenPayloadBytes ?? null,
    qwenPayloadPromptChars: input.qwenPayloadPromptChars ?? null,
    qwenPayloadMessageCount: input.qwenPayloadMessageCount ?? null,
    messageCount: input.messageCount ?? null,
    fullMessageCount: input.fullMessageCount ?? null,
    toolsCount: input.toolsCount ?? 0,
    filesCount: input.filesCount ?? 0,
    personalizationBytes: personalization?.bytes ?? 0,
    personalizationTokens: personalization?.estimatedTokens ?? 0,
    mode: input.mode,
    upstreamPromptTokens: null,
    upstreamContextPercent: null,
    upstreamRemainingContextTokens: null,
    reportedPromptTokens: null,
    measurementSource: "local_estimate",
  };
}

/**
 * Add the diagnostic extension without changing standard OpenAI usage by
 * default. If reportUsage is enabled, prompt_tokens uses Qwen's measured
 * input_tokens when available and falls back to the local estimate otherwise.
 */
export function enrichUsageWithContextMeter(
  usage: Usage,
  snapshot: ContextMeterSnapshot | null | undefined,
  options: ContextMeterOptions = getContextMeterOptions(),
): Usage | MeteredUsage {
  if (!snapshot || !options.enabled) return usage;

  const upstreamPromptTokens =
    Number.isFinite(usage.prompt_tokens) && usage.prompt_tokens > 0
      ? usage.prompt_tokens
      : null;
  const reportedPromptTokens = options.reportUsage
    ? (upstreamPromptTokens ?? snapshot.estimatedContextTokens)
    : usage.prompt_tokens;
  const contextMeter: ContextMeterSnapshot = {
    ...snapshot,
    upstreamPromptTokens,
    upstreamContextPercent:
      upstreamPromptTokens !== null
        ? roundPercent((upstreamPromptTokens / snapshot.contextWindowTokens) * 100)
        : null,
    upstreamRemainingContextTokens:
      upstreamPromptTokens !== null
        ? Math.max(0, snapshot.contextWindowTokens - upstreamPromptTokens)
        : null,
    reportedPromptTokens,
    measurementSource: upstreamPromptTokens !== null ? "qwen" : "local_estimate",
  };

  if (!options.reportUsage) {
    return {
      ...usage,
      context_meter: contextMeter,
    };
  }

  const completionTokens = Math.max(0, usage.completion_tokens || 0);
  return {
    ...usage,
    prompt_tokens: reportedPromptTokens,
    total_tokens: reportedPromptTokens + completionTokens,
    prompt_tokens_details: {
      ...(usage.prompt_tokens_details ?? { cached_tokens: 0 }),
      text_tokens: reportedPromptTokens,
    },
    context_meter: contextMeter,
  };
}

export function contextMeterLogData(
  snapshot: ContextMeterSnapshot,
): Record<string, unknown> {
  return {
    model: snapshot.model,
    mode: snapshot.mode,
    estimate: snapshot.estimate,
    estimatedContextTokens: snapshot.estimatedContextTokens,
    estimatedRequestTokens: snapshot.estimatedRequestTokens,
    contextWindowTokens: snapshot.contextWindowTokens,
    contextWindowSource: snapshot.contextWindowSource,
    measurementSource: snapshot.measurementSource,
    estimatedContextPercent: snapshot.estimatedContextPercent,
    estimatedUsablePercent: snapshot.estimatedUsablePercent,
    remainingContextTokens: snapshot.remainingContextTokens,
    remainingUsableTokens: snapshot.remainingUsableTokens,
    fullPromptChars: snapshot.fullPromptChars,
    fullPromptBytes: snapshot.fullPromptBytes,
    requestPromptChars: snapshot.requestPromptChars,
    requestPromptBytes: snapshot.requestPromptBytes,
    qwenPayloadBytes: snapshot.qwenPayloadBytes,
    qwenPayloadPromptChars: snapshot.qwenPayloadPromptChars,
    qwenPayloadMessageCount: snapshot.qwenPayloadMessageCount,
    messageCount: snapshot.messageCount,
    fullMessageCount: snapshot.fullMessageCount,
    toolsCount: snapshot.toolsCount,
    filesCount: snapshot.filesCount,
    personalizationBytes: snapshot.personalizationBytes,
    personalizationTokens: snapshot.personalizationTokens,
    upstreamPromptTokens: snapshot.upstreamPromptTokens,
    upstreamContextPercent: snapshot.upstreamContextPercent,
    upstreamRemainingContextTokens: snapshot.upstreamRemainingContextTokens,
    reportedPromptTokens: snapshot.reportedPromptTokens,
  };
}

export function getContextMeterHeaders(
  snapshot: ContextMeterSnapshot | null | undefined,
): Record<string, string> {
  if (!snapshot) return {};

  const headers: Record<string, string> = {
    "X-QwenBridge-Context-Meter": "enabled",
    "X-QwenBridge-Context-Model": snapshot.model,
    "X-QwenBridge-Context-Mode": snapshot.mode,
    "X-QwenBridge-Context-Window-Tokens": String(snapshot.contextWindowTokens),
    "X-QwenBridge-Context-Window-Source": snapshot.contextWindowSource,
    "X-QwenBridge-Context-Measurement": snapshot.measurementSource,
    "X-QwenBridge-Context-Estimated-Tokens": String(
      snapshot.estimatedContextTokens,
    ),
    "X-QwenBridge-Context-Percent": String(snapshot.estimatedContextPercent),
    "X-QwenBridge-Context-Remaining-Tokens": String(
      snapshot.remainingContextTokens,
    ),
    "X-QwenBridge-Context-Full-Prompt-Bytes": String(
      snapshot.fullPromptBytes,
    ),
    "X-QwenBridge-Context-Request-Prompt-Bytes": String(
      snapshot.requestPromptBytes,
    ),
    "X-QwenBridge-Context-Qwen-Payload-Bytes": String(
      snapshot.qwenPayloadBytes ?? 0,
    ),
  };

  if (snapshot.upstreamPromptTokens !== null) {
    headers["X-QwenBridge-Context-Upstream-Tokens"] = String(
      snapshot.upstreamPromptTokens,
    );
  }
  if (snapshot.upstreamContextPercent !== null) {
    headers["X-QwenBridge-Context-Upstream-Percent"] = String(
      snapshot.upstreamContextPercent,
    );
  }
  if (snapshot.upstreamRemainingContextTokens !== null) {
    headers["X-QwenBridge-Context-Upstream-Remaining-Tokens"] = String(
      snapshot.upstreamRemainingContextTokens,
    );
  }
  if (snapshot.reportedPromptTokens !== null) {
    headers["X-QwenBridge-Context-Reported-Tokens"] = String(
      snapshot.reportedPromptTokens,
    );
  }

  return headers;
}
