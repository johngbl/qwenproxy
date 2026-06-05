import { config } from "../core/config.ts";
import { logger } from "../core/logger.ts";
import { summarizeMessages } from "../utils/context-summarizer.ts";
import type { Message } from "../utils/types.ts";
import {
  getLatestThreadContextSummary,
  getRecentThreadContextTurns,
  getThreadContextSession,
  getUnsummarizedThreadContextTurns,
  insertThreadContextSummary,
  setThreadContextStatus,
  type ThreadContextSummary,
  type ThreadContextTurn,
} from "./thread-context-store.ts";

const CONTINUATION_SUMMARY_PROMPT = `You are creating a continuation summary for a long-running coding assistant conversation.

The summary will be injected into a fresh Qwen chat so the assistant can continue without access to the previous Qwen thread.

Preserve all information needed to continue accurately. Be structured, technical, and detailed. Do not omit important details just to be brief.

Include:

1. User goals and preferences
2. Current project/repository context
3. Work completed so far
4. Important files, APIs, endpoints, payloads, data models, state machines
5. Decisions made and why
6. Bugs/errors encountered and fixes attempted
7. Tool calls/results that matter
8. Open risks, assumptions, and uncertainties
9. Recent conversation state
10. Exact next best step
11. Continuation instructions

Return only the continuation summary.`;

function roleLabel(role: string): string {
  return role === "assistant" ? "Assistant" : role === "user" ? "User" : role;
}

function turnToConversationLine(turn: ThreadContextTurn): string {
  return `${roleLabel(turn.role)}: ${turn.content}`;
}

function compactTurnToConversationLine(
  turn: ThreadContextTurn,
  maxContentCharacters: number,
): string {
  const content = turn.content || "";
  if (content.length <= maxContentCharacters) {
    return `${roleLabel(turn.role)}: ${content}`;
  }

  const omittedCharacters = content.length - maxContentCharacters;
  return `${roleLabel(turn.role)}: ${content.slice(0, maxContentCharacters)}\n\n[QwenBridge summary input compacted this turn; omitted ${omittedCharacters} character(s).]`;
}

function dedupeTurns(turns: ThreadContextTurn[]): ThreadContextTurn[] {
  const seen = new Set<number>();
  const result: ThreadContextTurn[] = [];
  for (const turn of turns) {
    if (seen.has(turn.id)) continue;
    seen.add(turn.id);
    result.push(turn);
  }
  result.sort((a, b) => a.id - b.id);
  return result;
}

function buildSummaryInputMessages(params: {
  previousSummary: ThreadContextSummary | null;
  newTurns: ThreadContextTurn[];
  anchorTurns: ThreadContextTurn[];
  maxInputTokens: number;
}): Message[] {
  const parts: string[] = [];

  if (params.previousSummary) {
    parts.push(
      `<previous_cumulative_summary>\n${params.previousSummary.summary}\n</previous_cumulative_summary>`,
    );
  } else {
    parts.push(
      "<previous_cumulative_summary>\nNone yet.\n</previous_cumulative_summary>",
    );
  }

  const turns = dedupeTurns([...params.newTurns, ...params.anchorTurns]);
  const previousSummaryTokens = params.previousSummary?.summaryTokens ?? 0;
  const availableTurnTokens = Math.max(
    800,
    params.maxInputTokens - previousSummaryTokens - 1200,
  );
  const perTurnTokenBudget = Math.max(
    200,
    Math.floor(availableTurnTokens / Math.max(turns.length, 1)),
  );
  const maxContentCharacters = Math.max(800, perTurnTokenBudget * 3);

  parts.push(
    `<conversation_turns_to_fold>\n${turns
      .map((turn) => compactTurnToConversationLine(turn, maxContentCharacters))
      .join("\n\n")}\n</conversation_turns_to_fold>`,
  );

  parts.push(
    "Create a new cumulative continuation summary that contains everything important from the previous summary plus the new turns. The result must be self-contained. If any turn was compacted, preserve the visible important facts and explicitly mention that raw detail was compacted.",
  );

  return [
    {
      role: "user",
      content: parts.join("\n\n"),
    },
  ];
}

function isUsableSummary(summary: string): boolean {
  const trimmed = summary.trim();
  return !!trimmed && !trimmed.startsWith("[Summary unavailable");
}

export async function runThreadContextSummary(
  sessionId: string,
): Promise<ThreadContextSummary | null> {
  if (!config.context.threadNative.persistenceEnabled) return null;
  if (!config.context.summarization.enabled) return null;

  const session = getThreadContextSession(sessionId);
  if (!session) return null;

  const latestSummary = getLatestThreadContextSummary(sessionId);
  const unsummarizedTurns = getUnsummarizedThreadContextTurns(sessionId);
  if (unsummarizedTurns.length === 0) {
    return latestSummary;
  }

  setThreadContextStatus(sessionId, "summary_pending");

  const sourceTurnStart = unsummarizedTurns[0]?.id ?? null;
  const sourceTurnEnd =
    unsummarizedTurns[unsummarizedTurns.length - 1]?.id ?? null;
  const anchorTurns = getRecentThreadContextTurns(
    sessionId,
    config.context.threadNative.recentTurnsToKeep,
  );
  const maxInputTokens = Math.max(
    4000,
    Math.min(60000, Math.floor(session.modelContextWindow * 0.45)),
  );
  const messages = buildSummaryInputMessages({
    previousSummary: latestSummary,
    newTurns: unsummarizedTurns,
    anchorTurns,
    maxInputTokens,
  });

  try {
    const summarizeWithModel = (model: string) =>
      summarizeMessages(messages, {
        model,
        maxSummaryTokens: config.context.threadNative.summaryMaxTokens,
        timeout: config.context.threadNative.summaryTimeout,
        systemPromptOverride: CONTINUATION_SUMMARY_PROMPT,
        purpose: "rollover",
      });

    const primaryModel = config.context.summarization.model;
    let result = await summarizeWithModel(primaryModel);

    if (!isUsableSummary(result.summary) && primaryModel !== session.model) {
      logger.warn(
        "[thread-context] summary unusable, retrying with session model",
        {
          sessionId,
          primaryModel,
          fallbackModel: session.model,
          originalTokens: result.originalTokens,
          latencyMs: result.latencyMs,
          error: result.error ?? null,
        },
      );
      result = await summarizeWithModel(session.model);
    }

    if (!isUsableSummary(result.summary)) {
      const errorMessage =
        result.error ?? "Summary API returned an unusable summary";
      setThreadContextStatus(
        sessionId,
        session.status === "rollover_required" ||
          session.status === "hard_limit"
          ? session.status
          : "summary_stale",
        errorMessage,
      );
      logger.warn("[thread-context] summary unavailable", {
        sessionId,
        model: primaryModel,
        fallbackModelTried: primaryModel !== session.model,
        originalTokens: result.originalTokens,
        summaryTokens: result.summaryTokens,
        latencyMs: result.latencyMs,
        maxInputTokens,
        error: errorMessage,
      });
      return null;
    }

    const summary = insertThreadContextSummary({
      sessionId,
      summary: result.summary.trim(),
      summaryTokens: result.summaryTokens,
      sourceTurnStart,
      sourceTurnEnd,
      model: config.context.summarization.model,
      compressionRatio: result.compressionRatio,
    });

    logger.info("[thread-context] summary completed", {
      sessionId,
      summaryId: summary.id,
      sequence: summary.sequence,
      summaryTokens: summary.summaryTokens,
    });

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setThreadContextStatus(sessionId, "summary_stale", message);
    logger.warn("[thread-context] summary failed", {
      sessionId,
      error: message,
    });
    return null;
  }
}

export async function ensureThreadContextSummary(
  sessionId: string,
): Promise<ThreadContextSummary | null> {
  const existing = getLatestThreadContextSummary(sessionId);
  const unsummarizedTurns = getUnsummarizedThreadContextTurns(sessionId);
  if (existing && unsummarizedTurns.length === 0) return existing;
  return runThreadContextSummary(sessionId);
}

export function formatThreadContextRecentTurns(
  turns: ThreadContextTurn[],
): string {
  return turns.map(turnToConversationLine).join("\n\n");
}
