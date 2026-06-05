import { config } from "../core/config.ts";
import { estimateTokenCount } from "../utils/context-truncation.ts";

export type ThreadContextStatus =
  | "normal"
  | "summary_stale"
  | "summary_pending"
  | "summary_ready"
  | "rollover_ready"
  | "rollover_required"
  | "hard_limit"
  | "rollover_in_progress"
  | "error";

export interface ThreadContextThresholdInput {
  estimatedThreadTokens: number;
  estimatedRecentTokens: number;
  modelContextWindow: number;
  unsummarizedTurns: number;
  hasLatestSummary: boolean;
  lastSummaryAt?: string | null;
}

export interface ThreadContextThresholdDecision {
  usageRatio: number;
  shouldSummarize: boolean;
  summaryStale: boolean;
  rolloverReady: boolean;
  rolloverRequired: boolean;
  hardLimit: boolean;
  status: ThreadContextStatus;
}

export function estimateThreadTextTokens(text: string): number {
  return estimateTokenCount(text || "");
}

export function calculateContextSafetyMargin(modelContextWindow: number): number {
  if (!Number.isFinite(modelContextWindow) || modelContextWindow <= 0) {
    return 4096;
  }
  return Math.max(4096, Math.floor(modelContextWindow * 0.05));
}

export function calculateThreadUsageRatio(
  estimatedThreadTokens: number,
  modelContextWindow: number,
): number {
  if (!Number.isFinite(modelContextWindow) || modelContextWindow <= 0) {
    return 0;
  }
  return Math.max(0, estimatedThreadTokens) / modelContextWindow;
}

function isSummaryOld(lastSummaryAt?: string | null): boolean {
  if (!lastSummaryAt) return true;
  const timestamp = new Date(lastSummaryAt).getTime();
  if (!Number.isFinite(timestamp)) return true;

  const minIntervalMs =
    config.context.threadNative.summaryMinIntervalSeconds * 1000;
  return Date.now() - timestamp >= minIntervalMs;
}

export function decideThreadContextThresholds(
  input: ThreadContextThresholdInput,
): ThreadContextThresholdDecision {
  const cfg = config.context.threadNative;
  const usageRatio = calculateThreadUsageRatio(
    input.estimatedThreadTokens,
    input.modelContextWindow,
  );

  const hardLimit = usageRatio >= cfg.hardLimitRatio;
  const rolloverRequired = usageRatio >= cfg.rolloverRequiredRatio;
  const rolloverReady = usageRatio >= cfg.rolloverReadyRatio;

  const summaryByRecentTokens =
    input.estimatedRecentTokens >= cfg.incrementalSummaryTokens;
  const summaryByRecentTurns =
    input.unsummarizedTurns >= cfg.incrementalSummaryTurns;
  const summaryStale =
    usageRatio >= cfg.summaryStaleRatio &&
    (!input.hasLatestSummary ||
      input.estimatedRecentTokens >=
        Math.floor(cfg.incrementalSummaryTokens / 2) ||
      isSummaryOld(input.lastSummaryAt));

  const shouldSummarize =
    summaryByRecentTokens || summaryByRecentTurns || summaryStale;

  let status: ThreadContextStatus = "normal";
  if (hardLimit) status = "hard_limit";
  else if (rolloverRequired) status = "rollover_required";
  else if (rolloverReady) status = "rollover_ready";
  else if (summaryStale || shouldSummarize) status = "summary_stale";
  else if (input.hasLatestSummary) status = "summary_ready";

  return {
    usageRatio,
    shouldSummarize,
    summaryStale,
    rolloverReady,
    rolloverRequired,
    hardLimit,
    status,
  };
}
