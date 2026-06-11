import { logger } from "../core/logger.ts";
import { estimateTokenCount } from "../utils/context-truncation.ts";
import type { Usage } from "../utils/types.ts";

export interface PersonalizationEstimationInfo {
  accountId: string;
  model: string | null;
  toolCount: number;
  chars: number;
  bytes: number;
  hash: string;
  estimatedTokens: number;
  source: "memory" | "db" | "verified" | "synced";
  updatedAt: number;
}

export interface TokenEstimationContext {
  requestDeclaredToolCount?: number;
  activePersonalization?: PersonalizationEstimationInfo | null;
  qwenPayloadBytes?: number;
  qwenPayloadPromptChars?: number;
  qwenPayloadMessageCount?: number;
}

function isEnabled(): boolean {
  return process.env.TOKEN_ESTIMATION_LOG === "true";
}

function ratio(estimated: number, actual: number): number | null {
  if (!Number.isFinite(actual) || actual <= 0) return null;
  return Number((estimated / actual).toFixed(4));
}

export function logTokenEstimationSample(input: {
  model: string;
  finalPrompt: string;
  userPrompt?: string;
  assistantContent?: string;
  reasoningContent?: string;
  usage?: Usage | null;
  mode: "stream" | "non-stream";
  context?: TokenEstimationContext;
}): void {
  if (!isEnabled()) return;

  const actualPromptTokens = input.usage?.prompt_tokens;
  if (
    typeof actualPromptTokens !== "number" ||
    !Number.isFinite(actualPromptTokens) ||
    actualPromptTokens <= 0
  ) {
    return;
  }

  const assistantContent = input.assistantContent ?? "";
  const reasoningContent = input.reasoningContent ?? "";
  const completionText = `${reasoningContent}${assistantContent}`;
  const estimatedPromptTokens = estimateTokenCount(
    input.finalPrompt,
    input.model,
  );
  const estimatedUserPromptTokens = input.userPrompt
    ? estimateTokenCount(input.userPrompt, input.model)
    : null;
  const estimatedCompletionTokens = completionText
    ? estimateTokenCount(completionText, input.model)
    : 0;
  const personalization = input.context?.activePersonalization ?? null;
  const estimatedPersonalizationTokens = personalization?.estimatedTokens ?? 0;
  const estimatedEffectivePromptTokens =
    estimatedPromptTokens + estimatedPersonalizationTokens;

  logger.info("token_estimation_sample", {
    model: input.model,
    mode: input.mode,
    localFinalPromptChars: input.finalPrompt.length,
    userPromptChars: input.userPrompt?.length ?? 0,
    completionChars: assistantContent.length,
    reasoningChars: reasoningContent.length,
    requestDeclaredToolCount: input.context?.requestDeclaredToolCount ?? 0,
    activePersonalizationToolCount: personalization?.toolCount ?? 0,
    personalizationChars: personalization?.chars ?? 0,
    personalizationBytes: personalization?.bytes ?? 0,
    personalizationHash: personalization?.hash ?? null,
    personalizationSource: personalization?.source ?? "none",
    personalizationModel: personalization?.model ?? null,
    qwenPayloadBytes: input.context?.qwenPayloadBytes ?? null,
    qwenPayloadPromptChars: input.context?.qwenPayloadPromptChars ?? null,
    qwenPayloadMessageCount: input.context?.qwenPayloadMessageCount ?? null,
    estimatedLocalPromptTokens: estimatedPromptTokens,
    estimatedUserPromptTokens,
    estimatedPersonalizationTokens,
    estimatedEffectivePromptTokens,
    estimatedCompletionTokens,
    actualPromptTokens,
    actualCompletionTokens: input.usage?.completion_tokens ?? null,
    actualTotalTokens: input.usage?.total_tokens ?? null,
    localPromptEstimateRatio: ratio(estimatedPromptTokens, actualPromptTokens),
    effectivePromptEstimateRatio: ratio(
      estimatedEffectivePromptTokens,
      actualPromptTokens,
    ),
    completionEstimateRatio: ratio(
      estimatedCompletionTokens,
      input.usage?.completion_tokens ?? 0,
    ),
  });
}
