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
}

const queue: SummaryJob[] = [];
const queuedSessions = new Set<string>();
const runningSessions = new Set<string>();
const lastStartedAt = new Map<string, number>();
let activeWorkers = 0;

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
  };

  if (priority) queue.unshift(job);
  else queue.push(job);
  queuedSessions.add(sessionId);
  setThreadContextStatus(sessionId, "summary_pending");

  logger.info("[thread-context] summary queued", {
    sessionId,
    reason,
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
        logger.info("[thread-context] summary started", {
          sessionId: job.sessionId,
          reason: job.reason,
        });
        await runThreadContextSummary(job.sessionId);
      } catch (error) {
        logger.warn("[thread-context] summary job failed", {
          sessionId: job.sessionId,
          reason: job.reason,
          error: error instanceof Error ? error.message : String(error),
        });
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
} {
  return {
    queued: queue.length,
    running: runningSessions.size,
    activeWorkers,
  };
}
