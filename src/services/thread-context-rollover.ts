import { config } from "../core/config.ts";
import { logger } from "../core/logger.ts";
import { deleteQwenChat } from "./qwen.ts";
import {
  decideThreadContextThresholds,
  estimateThreadTextTokens,
} from "./thread-context-estimator.ts";
import { enqueueThreadContextSummary } from "./thread-context-jobs.ts";
import { recoverThreadContextFromQwenHistory } from "./thread-context-recovery.ts";
import {
  ensureThreadContextSummary,
  formatThreadContextRecentTurns,
} from "./thread-context-summarizer.ts";
import {
  getLatestThreadContextSummary,
  getRecentThreadContextTurns,
  getThreadContextSession,
  getUnsummarizedThreadContextTurns,
  markThreadContextRolloverChatDeleted,
  recordThreadContextRollover,
  setThreadContextStatus,
  updateThreadContextActiveChat,
  type ThreadContextSummary,
} from "./thread-context-store.ts";

export interface ThreadContextRolloverPlan {
  sessionId: string;
  reason: string;
  previousAccountId: string | null;
  previousChatSessionId: string | null;
  summaryId: number;
  oldEstimatedTokens: number;
  newInitialTokens: number;
  preferredAccountId: string | null;
  startedAt: number;
  rolloverId?: number;
}

export interface PreparedThreadContextPrompt {
  finalPrompt: string;
  rollover: ThreadContextRolloverPlan | null;
}

export interface PrepareThreadContextRolloverInput {
  sessionId: string | null;
  finalPrompt: string;
  currentPrompt: string;
  systemPrompt: string;
  skipRollover: boolean;
}

function buildContinuationPrompt(params: {
  systemPrompt: string;
  summary: ThreadContextSummary;
  recentTurns: string;
  currentPrompt: string;
}): string {
  const parts: string[] = [];
  const systemPrompt = params.systemPrompt.trim();
  if (systemPrompt) parts.push(systemPrompt);

  parts.push(`You are continuing a previous conversation from another Qwen chat.

The previous chat was compacted because it was approaching the context limit.

Use this continuation summary as authoritative context:

<continuation_summary>
${params.summary.summary}
</continuation_summary>`);

  if (params.recentTurns.trim()) {
    parts.push(`Recent unsummarized turns preserved verbatim:

<recent_turns>
${params.recentTurns}
</recent_turns>`);
  }

  parts.push(`Continue naturally from this state.

The user's new message is:

${params.currentPrompt.trim()}`);

  return parts.join("\n\n");
}

function rolloverReason(
  decision: ReturnType<typeof decideThreadContextThresholds>,
): string {
  if (decision.hardLimit) return "hard_limit";
  if (decision.rolloverRequired) return "rollover_required";
  return "rollover_ready";
}

export async function prepareThreadContextRollover(
  input: PrepareThreadContextRolloverInput,
): Promise<PreparedThreadContextPrompt> {
  if (
    input.skipRollover ||
    !input.sessionId ||
    !config.context.threadNative.persistenceEnabled ||
    !config.context.threadNative.rolloverEnabled
  ) {
    return { finalPrompt: input.finalPrompt, rollover: null };
  }

  const session = getThreadContextSession(input.sessionId);
  if (!session?.activeChatSessionId) {
    return { finalPrompt: input.finalPrompt, rollover: null };
  }

  const latestSummary = getLatestThreadContextSummary(input.sessionId);
  const unsummarizedTurns = getUnsummarizedThreadContextTurns(input.sessionId);
  const decision = decideThreadContextThresholds({
    estimatedThreadTokens: session.estimatedThreadTokens,
    estimatedRecentTokens: session.estimatedRecentTokens,
    modelContextWindow: session.modelContextWindow,
    unsummarizedTurns: unsummarizedTurns.length,
    hasLatestSummary: latestSummary !== null,
    lastSummaryAt: session.lastSummaryAt,
  });

  if (!decision.rolloverReady && session.status !== "rollover_ready") {
    if (decision.shouldSummarize) {
      enqueueThreadContextSummary(
        input.sessionId,
        "pre_rollover_stale_summary",
      );
    }
    return { finalPrompt: input.finalPrompt, rollover: null };
  }

  let summary = latestSummary;
  if (decision.rolloverRequired || decision.hardLimit || !summary) {
    summary = await ensureThreadContextSummary(input.sessionId);
  }

  if (!summary && (decision.rolloverRequired || decision.hardLimit)) {
    await recoverThreadContextFromQwenHistory({
      sessionId: input.sessionId,
      accountId: session.accountId,
      chatId: session.activeChatSessionId,
    });
    summary = await ensureThreadContextSummary(input.sessionId);
  }

  if (!summary) {
    if (decision.hardLimit) {
      setThreadContextStatus(
        input.sessionId,
        "hard_limit",
        "Cannot rollover safely because no continuation summary is available",
      );
      throw new Error(
        "QwenBridge context hard limit reached and no continuation summary is available yet. Retry after summary generation completes.",
      );
    }

    enqueueThreadContextSummary(input.sessionId, "rollover_summary_missing", {
      priority: decision.rolloverRequired,
      force: decision.rolloverRequired,
    });
    return { finalPrompt: input.finalPrompt, rollover: null };
  }

  const recentTurns = formatThreadContextRecentTurns(
    getRecentThreadContextTurns(
      input.sessionId,
      config.context.threadNative.recentTurnsToKeep,
    ),
  );
  const rolloverPrompt = buildContinuationPrompt({
    systemPrompt: input.systemPrompt,
    summary,
    recentTurns,
    currentPrompt: input.currentPrompt || input.finalPrompt,
  });
  const newInitialTokens = estimateThreadTextTokens(rolloverPrompt);

  if (
    session.modelContextWindow > 0 &&
    newInitialTokens / session.modelContextWindow >=
      config.context.threadNative.hardLimitRatio
  ) {
    setThreadContextStatus(
      input.sessionId,
      "hard_limit",
      "Continuation prompt would still exceed the hard-limit threshold",
    );
    throw new Error(
      "QwenBridge rollover prompt is still too large after summarization. Reduce recent-turn retention or summary size.",
    );
  }

  setThreadContextStatus(input.sessionId, "rollover_in_progress");

  const plan: ThreadContextRolloverPlan = {
    sessionId: input.sessionId,
    reason: rolloverReason(decision),
    previousAccountId: session.accountId,
    previousChatSessionId: session.activeChatSessionId,
    summaryId: summary.id,
    oldEstimatedTokens: session.estimatedThreadTokens,
    newInitialTokens,
    preferredAccountId: config.context.threadNative.rolloverAllowCrossAccount
      ? null
      : session.accountId,
    startedAt: Date.now(),
  };

  logger.info("[thread-context] rollover prepared", {
    event: "thread_context_rollover_prepared",
    sessionId: input.sessionId,
    fromAccount: plan.previousAccountId,
    fromChat: plan.previousChatSessionId,
    summaryId: plan.summaryId,
    reason: plan.reason,
    oldEstimatedTokens: plan.oldEstimatedTokens,
    newInitialTokens: plan.newInitialTokens,
  });

  return { finalPrompt: rolloverPrompt, rollover: plan };
}

export function markThreadContextRolloverStarted(input: {
  plan: ThreadContextRolloverPlan;
  toAccountId: string;
  toChatId: string;
}): ThreadContextRolloverPlan {
  const plan = { ...input.plan };
  plan.rolloverId = recordThreadContextRollover({
    sessionId: plan.sessionId,
    fromAccountId: plan.previousAccountId,
    fromChatId: plan.previousChatSessionId,
    toAccountId: input.toAccountId,
    toChatId: input.toChatId,
    summaryId: plan.summaryId,
    reason: plan.reason,
    oldEstimatedTokens: plan.oldEstimatedTokens,
    newInitialTokens: plan.newInitialTokens,
  });

  updateThreadContextActiveChat({
    sessionId: plan.sessionId,
    accountId: input.toAccountId,
    activeChatSessionId: input.toChatId,
    activeParentId: null,
    previousChatSessionId: plan.previousChatSessionId,
    incrementRolloverCount: true,
    status: "rollover_in_progress",
  });

  logger.info("[thread-context] rollover started", {
    event: "thread_context_rollover_started",
    sessionId: plan.sessionId,
    fromAccount: plan.previousAccountId,
    toAccount: input.toAccountId,
    fromChat: plan.previousChatSessionId,
    toChat: input.toChatId,
    summaryId: plan.summaryId,
    rolloverId: plan.rolloverId,
  });

  return plan;
}

async function deletePreviousChat(
  plan: ThreadContextRolloverPlan,
): Promise<void> {
  if (!plan.previousChatSessionId) return;
  const session = getThreadContextSession(plan.sessionId);
  if (!session || session.latestSummaryId !== plan.summaryId) return;
  if (session.activeChatSessionId === plan.previousChatSessionId) return;

  const accountId =
    plan.previousAccountId && plan.previousAccountId !== "global"
      ? plan.previousAccountId
      : undefined;

  const deleted = await deleteQwenChat(plan.previousChatSessionId, accountId);
  if (deleted) {
    markThreadContextRolloverChatDeleted(
      plan.sessionId,
      plan.previousChatSessionId,
    );
    logger.info("[thread-context] old Qwen chat deleted after rollover", {
      event: "thread_context_old_chat_deleted",
      sessionId: plan.sessionId,
      fromAccount: plan.previousAccountId,
      fromChat: plan.previousChatSessionId,
      summaryId: plan.summaryId,
      rolloverId: plan.rolloverId ?? null,
    });
  }
}

export async function finalizeThreadContextRolloverSuccess(
  plan: ThreadContextRolloverPlan | null | undefined,
): Promise<void> {
  if (!plan || !config.context.threadNative.deleteOldQwenChats) return;
  if (!plan.previousChatSessionId) return;

  const delayMs = Math.max(
    0,
    config.context.threadNative.oldChatRetentionHours * 60 * 60 * 1000,
  );

  if (delayMs > 0) {
    const timeout = setTimeout(() => {
      void deletePreviousChat(plan).catch((error) => {
        logger.warn("[thread-context] scheduled old chat delete failed", {
          sessionId: plan.sessionId,
          fromChat: plan.previousChatSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
    timeout.unref?.();
    return;
  }

  try {
    await deletePreviousChat(plan);
  } catch (error) {
    logger.warn("[thread-context] old chat delete failed", {
      sessionId: plan.sessionId,
      fromChat: plan.previousChatSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
