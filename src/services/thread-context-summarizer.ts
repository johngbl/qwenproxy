/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

import { config } from "../core/config.ts";
import { logger } from "../core/logger.ts";
import {
  summarizeMessages,
  type SummarizationResult,
} from "../utils/context-summarizer.ts";
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

const MAX_CHUNK_CHARS = 80_000; // 80KB max per chunk (matches payload-summarizer)
const MIN_TIMEOUT_PER_CHUNK_MS = 30_000; // 30s minimum per chunk
const TIMEOUT_PER_100KB_MS = 15_000; // +15s per 100KB of content

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

function compactTurnToConversationLine(turn: ThreadContextTurn): string {
  const content = turn.content || "";
  return `${roleLabel(turn.role)}: ${content}`;
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

  parts.push(
    `<conversation_turns_to_fold>\n${turns
      .map((turn) => compactTurnToConversationLine(turn))
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
  const maxInputTokens = Math.floor(session.modelContextWindow * 0.45);
  const messages = buildSummaryInputMessages({
    previousSummary: latestSummary,
    newTurns: unsummarizedTurns,
    anchorTurns,
  });

  // Estimate total content size for chunking decision
  const totalChars = messages.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
  const needsChunking = totalChars > MAX_CHUNK_CHARS;

  // Dynamic timeout: base + proportional to content size
  const dynamicTimeout = needsChunking
    ? Math.max(
        config.context.threadNative.summaryTimeout,
        MIN_TIMEOUT_PER_CHUNK_MS * Math.ceil(totalChars / MAX_CHUNK_CHARS) +
          Math.floor((totalChars / 100_000) * TIMEOUT_PER_100KB_MS),
      )
    : config.context.threadNative.summaryTimeout;

  try {
    // Chunked summarization for very large contexts
    if (needsChunking) {
      console.log(
        `[ThreadContext] Chunked summary | ${totalChars} chars -> ${Math.ceil(totalChars / MAX_CHUNK_CHARS)} chunks | timeout ${dynamicTimeout}ms`,
      );
      const result = await summarizeChunked(messages, {
        model: config.context.summarization.model,
        timeout: dynamicTimeout,
        systemPromptOverride: CONTINUATION_SUMMARY_PROMPT,
      });

      if (!isUsableSummary(result.summary)) {
        const errorMessage = result.error ?? "Chunked summary unusable";
        setThreadContextStatus(
          sessionId,
          session.status === "rollover_required" ||
            session.status === "hard_limit"
            ? session.status
            : "summary_stale",
          errorMessage,
        );
        console.warn(`[ThreadContext] Summary unavailable | ${errorMessage}`);
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

      console.log(
        `[ThreadContext] Summary completed (chunked) | ${summary.summaryTokens} tokens`,
      );
      return summary;
    }

    const summarizeWithModel = (model: string) =>
      summarizeMessages(messages, {
        model,
        maxSummaryTokens: 0, // no limit - let model generate as much as needed
        timeout: dynamicTimeout,
        systemPromptOverride: CONTINUATION_SUMMARY_PROMPT,
        purpose: "rollover",
      });

    const primaryModel = config.context.summarization.model;
    let result = await summarizeWithModel(primaryModel);

    if (!isUsableSummary(result.summary) && primaryModel !== session.model) {
      console.warn(
        `[ThreadContext] Summary retry | ${primaryModel} -> ${session.model}`,
      );
      logger.debug("[thread-context] summary unusable, retrying", {
        sessionId,
        primaryModel,
        fallbackModel: session.model,
        originalTokens: result.originalTokens,
        latencyMs: result.latencyMs,
        error: result.error ?? null,
      });
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
      console.warn(`[ThreadContext] Summary unavailable | ${errorMessage}`);
      logger.debug("[thread-context] summary unavailable", {
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

    console.log(
      `[ThreadContext] Summary completed | ${summary.summaryTokens} tokens`,
    );
    logger.debug("[thread-context] summary completed", {
      sessionId,
      summaryId: summary.id,
      sequence: summary.sequence,
      sourceTurnStart,
      sourceTurnEnd,
      summaryTokens: summary.summaryTokens,
      originalTokens: result.originalTokens,
      compressionRatio: result.compressionRatio,
    });

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setThreadContextStatus(sessionId, "summary_stale", message);
    console.warn(`[ThreadContext] Summary failed | ${message}`);
    logger.debug("[thread-context] summary failed", {
      sessionId,
      error: message,
    });
    return null;
  }
}

/**
 * Chunked summarization for very large contexts.
 * Truncates old turns to fit within MAX_CHUNK_CHARS, keeping recent turns and previous summary.
 */
async function summarizeChunked(
  messages: Message[],
  options: {
    model: string;
    timeout: number;
    systemPromptOverride: string;
  },
): Promise<SummarizationResult> {
  // Extract the conversation content from the user message
  const userMessage = messages.find((m) => m.role === "user");
  if (!userMessage || typeof userMessage.content !== "string") {
    return {
      summary: "",
      originalTokens: 0,
      summaryTokens: 0,
      compressionRatio: 0,
      latencyMs: 0,
      error: "No user message found",
    };
  }

  const fullContent = userMessage.content;
  const truncatedContent = truncateForSummarization(fullContent);

  logger.debug("[thread-context] chunked summarization", {
    originalChars: fullContent.length,
    truncatedChars: truncatedContent.length,
    reductionPercent: Math.round(
      ((fullContent.length - truncatedContent.length) / fullContent.length) *
        100,
    ),
  });

  // Build truncated messages
  const truncatedMessages: Message[] = [
    {
      role: "user",
      content: truncatedContent,
    },
  ];

  // Use the provided model with dynamic timeout
  return summarizeMessages(truncatedMessages, {
    model: options.model,
    maxSummaryTokens: 0,
    timeout: options.timeout,
    systemPromptOverride: options.systemPromptOverride,
    purpose: "rollover",
  });
}

/**
 * Truncate conversation content to fit within MAX_CHUNK_CHARS.
 * Preserves previous summary and recent turns, drops older turns.
 */
function truncateForSummarization(content: string): string {
  if (content.length <= MAX_CHUNK_CHARS) {
    return content;
  }

  // Parse the structured content
  const previousSummaryMatch = content.match(
    /<previous_cumulative_summary>\n([\s\S]*?)\n<\/previous_cumulative_summary>/,
  );
  const turnsMatch = content.match(
    /<conversation_turns_to_fold>\n([\s\S]*?)\n<\/conversation_turns_to_fold>/,
  );
  const instructionMatch = content.match(
    /Create a new cumulative continuation summary[\s\S]*$/,
  );

  const previousSummary = previousSummaryMatch?.[1] || "None yet.";
  const turnsText = turnsMatch?.[1] || "";
  const instruction =
    instructionMatch?.[0] ||
    "Create a new cumulative continuation summary that contains everything important from the previous summary plus the new turns. The result must be self-contained. If any turn was compacted, preserve the visible important facts and explicitly mention that raw detail was compacted.";

  // Split turns by double newline
  const turns = turnsText.split("\n\n").filter((t) => t.trim().length > 0);

  // Calculate available space for turns
  const summarySection = `<previous_cumulative_summary>\n${previousSummary}\n</previous_cumulative_summary>`;
  const instructionSection = instruction;
  const overhead = summarySection.length + instructionSection.length + 100; // +100 for structure
  const availableForTurns = MAX_CHUNK_CHARS - overhead;

  // Keep recent turns, drop old ones
  const keptTurns: string[] = [];
  let currentSize = 0;

  // Iterate from newest to oldest
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const turnSize = turn.length + 2; // +2 for \n\n

    if (currentSize + turnSize > availableForTurns) {
      break;
    }

    keptTurns.unshift(turn);
    currentSize += turnSize;
  }

  const droppedCount = turns.length - keptTurns.length;
  const truncationNote =
    droppedCount > 0
      ? `\n\n[Note: ${droppedCount} older turn(s) were truncated to fit context limits. Focus on the most recent conversation state and any critical information from the previous summary.]`
      : "";

  // Rebuild content
  const truncatedTurnsText = keptTurns.join("\n\n");
  return `${summarySection}\n\n<conversation_turns_to_fold>\n${truncatedTurnsText}${truncationNote}\n</conversation_turns_to_fold>\n\n${instructionSection}`;
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
