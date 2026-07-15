/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

import { config } from "../core/config.ts";
import { logger } from "../core/logger.ts";
import { decideThreadContextThresholds } from "./thread-context-estimator.ts";
import { runThreadContextSummary } from "./thread-context-summarizer.ts";
import {
  getLatestThreadContextSummary,
  getThreadContextSession,
  getUnsummarizedThreadContextTurns,
  setThreadContextStatus,
} from "./thread-context-store.ts";

interface SummaryJob {
  sessionId: string;
  reason: string;
  priority: boolean;
  queuedAt: number;
  attempt: number;
  maxAttempts: number;
}

const queue: SummaryJob[] = [];
const queuedSessions = new Set<string>();
const runningSessions = new Set<string>();
const lastStartedAt = new Map<string, number>();
const failedSessions = new Map<string, number>(); // Track failure counts
let activeWorkers = 0;

const MAX_JOB_ATTEMPTS = 3;
const JOB_RETRY_BACKOFF_MS = 5000;

function shouldRunSummary(sessionId: string, force: boolean): boolean {
  const session = getThreadContextSession(sessionId);
  if (!session) return false;
  if (!force) {
    const latestSummary = getLatestThreadContextSummary(sessionId);
    const unsummarizedTurns = getUnsummarizedThreadContextTurns(sessionId);
    const decision = decideThreadContextThresholds({
      estimatedThreadTokens: session.estimatedThreadTokens,
      estimatedRecentTokens: session.estimatedRecentTokens,
      modelContextWindow: session.modelContextWindow,
      unsummarizedTurns: unsummarizedTurns.length,
      hasLatestSummary: latestSummary !== null,
      lastSummaryAt: session.lastSummaryAt,
    });
    if (!decision.shouldSummarize) return false;
  }

  const lastStarted = lastStartedAt.get(sessionId) ?? 0;
  const cooldownMs =
    config.context.threadNative.summaryMinIntervalSeconds * 1000;
  return force || Date.now() - lastStarted >= cooldownMs;
}

export function enqueueThreadContextSummary(
  sessionId: string | null | undefined,
  reason = "threshold",
  options?: { priority?: boolean; force?: boolean },
): boolean {
  if (!sessionId) return false;
  if (!config.context.threadNative.persistenceEnabled) return false;
  if (!config.context.summarization.enabled) return false;

  const priority = options?.priority === true;
  const force = options?.force === true || priority;

  if (queuedSessions.has(sessionId) || runningSessions.has(sessionId)) {
    return false;
  }
  if (!shouldRunSummary(sessionId, force)) {
    return false;
  }

  const job: SummaryJob = {
    sessionId,
    reason,
    priority,
    queuedAt: Date.now(),
    attempt: 1,
    maxAttempts: MAX_JOB_ATTEMPTS,
  };

  if (priority) queue.unshift(job);
  else queue.push(job);
  queuedSessions.add(sessionId);
  setThreadContextStatus(sessionId, "summary_pending");

  console.log(
    `[ThreadContext] Summary queued | ${reason} | queue ${queue.length}`,
  );
  logger.debug("[thread-context] summary queued", {
    sessionId,
    reason,
    priority,
    queueDepth: queue.length,
  });

  void processSummaryQueue();
  return true;
}

async function processSummaryQueue(): Promise<void> {
  const concurrency = Math.max(
    1,
    config.context.threadNative.summaryBackgroundConcurrency,
  );

  while (activeWorkers < concurrency && queue.length > 0) {
    const job = queue.shift();
    if (!job) return;

    queuedSessions.delete(job.sessionId);
    if (runningSessions.has(job.sessionId)) continue;

    activeWorkers++;
    runningSessions.add(job.sessionId);
    lastStartedAt.set(job.sessionId, Date.now());

    void (async () => {
      try {
        console.log(
          `🔄 [ThreadContext] Summary started | ${job.reason} | attempt ${job.attempt}/${job.maxAttempts}`,
        );
        logger.debug("[thread-context] summary job started", {
          sessionId: job.sessionId,
          reason: job.reason,
          waitMs: Date.now() - job.queuedAt,
          attempt: job.attempt,
        });
        
        const result = await runThreadContextSummary(job.sessionId);
        
        if (result) {
          // Success - clear failure tracking
          failedSessions.delete(job.sessionId);
          console.log(`✅ [ThreadContext] Summary completed | ${job.reason}`);
        } else {
          // Summary returned null - might be a soft failure
          console.warn(
            `[ThreadContext] Summary returned null | ${job.reason} | attempt ${job.attempt}/${job.maxAttempts}`,
          );
          
          // Retry if we have attempts left
          if (job.attempt < job.maxAttempts) {
            const backoffMs = JOB_RETRY_BACKOFF_MS * Math.pow(2, job.attempt - 1);
            console.log(
              `[ThreadContext] Scheduling retry | ${job.reason} | waiting ${backoffMs}ms`,
            );
            
            // Re-queue with incremented attempt
            const retryJob: SummaryJob = {
              ...job,
              attempt: job.attempt + 1,
              queuedAt: Date.now(),
            };
            
            setTimeout(() => {
              queue.push(retryJob);
              queuedSessions.add(retryJob.sessionId);
              void processSummaryQueue();
            }, backoffMs);
          } else {
            // Max attempts reached - track failure
            const failureCount = (failedSessions.get(job.sessionId) ?? 0) + 1;
            failedSessions.set(job.sessionId, failureCount);
            console.warn(
              `[ThreadContext] Summary failed after ${job.maxAttempts} attempts | ${job.reason} | total failures: ${failureCount}`,
            );
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[ThreadContext] Summary failed | ${job.reason} | attempt ${job.attempt}/${job.maxAttempts} | ${errMsg}`,
        );
        logger.debug("[thread-context] summary job failed", {
          sessionId: job.sessionId,
          reason: job.reason,
          attempt: job.attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        
        // Retry if we have attempts left
        if (job.attempt < job.maxAttempts) {
          const backoffMs = JOB_RETRY_BACKOFF_MS * Math.pow(2, job.attempt - 1);
          console.log(
            `[ThreadContext] Scheduling retry after error | ${job.reason} | waiting ${backoffMs}ms`,
          );
          
          // Re-queue with incremented attempt
          const retryJob: SummaryJob = {
            ...job,
            attempt: job.attempt + 1,
            queuedAt: Date.now(),
          };
          
          setTimeout(() => {
            queue.push(retryJob);
            queuedSessions.add(retryJob.sessionId);
            void processSummaryQueue();
          }, backoffMs);
        } else {
          // Max attempts reached - track failure
          const failureCount = (failedSessions.get(job.sessionId) ?? 0) + 1;
          failedSessions.set(job.sessionId, failureCount);
          console.warn(
            `[ThreadContext] Summary failed after ${job.maxAttempts} attempts | ${job.reason} | total failures: ${failureCount}`,
          );
        }
      } finally {
        runningSessions.delete(job.sessionId);
        activeWorkers--;
        void processSummaryQueue();
      }
    })();
  }
}

export function getThreadContextJobStats(): {
  queued: number;
  running: number;
  activeWorkers: number;
  failedSessions: number;
  totalFailures: number;
} {
  let totalFailures = 0;
  for (const count of failedSessions.values()) {
    totalFailures += count;
  }
  
  return {
    queued: queue.length,
    running: runningSessions.size,
    activeWorkers,
    failedSessions: failedSessions.size,
    totalFailures,
  };
}
