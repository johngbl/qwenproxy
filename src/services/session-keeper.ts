import { config } from "../core/config.ts";

import {
  closeIdlePlaywrightAccounts,
  evictIdlePlaywrightContextsToLimit,
  getActivePlaywrightAccountIds,
  isPlaywrightAlreadyClosedError,
  keepAlivePlaywrightAccount,
} from "./playwright.ts";
import { humanDelay, sleep } from "./human-behavior.ts";

let running = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
let cycleInProgress = false;

/**
 * A keep-alive failure (navigation timeout, transient WAF, closed context
 * that is not yet reported as closed) must not retry on every cycle: it would
 * hammer the same broken page and bury the logs. Back off per account with the
 * usual exponential schedule, capped at five minutes.
 */
const KEEP_ALIVE_BACKOFF_BASE_MS = 2_000;
const KEEP_ALIVE_BACKOFF_MAX_MS = 5 * 60_000;

interface KeepAliveRetryState {
  failures: number;
  nextAttemptAt: number;
}

const keepAliveRetries = new Map<string, KeepAliveRetryState>();

export function computeSessionKeeperBackoffMs(failures: number): number {
  const exponent = Math.max(0, Math.min(failures - 1, 8));
  return Math.min(
    KEEP_ALIVE_BACKOFF_MAX_MS,
    KEEP_ALIVE_BACKOFF_BASE_MS * 2 ** exponent,
  );
}

function isKeepAliveBackedOff(accountId: string): boolean {
  const state = keepAliveRetries.get(accountId);
  return Boolean(state && Date.now() < state.nextAttemptAt);
}

function recordKeepAliveFailure(accountId: string): number {
  const state = keepAliveRetries.get(accountId) ?? {
    failures: 0,
    nextAttemptAt: 0,
  };
  state.failures += 1;
  const backoffMs = computeSessionKeeperBackoffMs(state.failures);
  state.nextAttemptAt = Date.now() + backoffMs;
  keepAliveRetries.set(accountId, state);
  return backoffMs;
}

export function resetSessionKeeperRetryStateForTests(): void {
  keepAliveRetries.clear();
}

export function isSessionKeeperAccountBackedOff(accountId: string): boolean {
  return isKeepAliveBackedOff(accountId);
}

export function isSessionKeeperRunning(): boolean {
  return running;
}

async function runKeepAliveCycle(): Promise<void> {
  if (cycleInProgress) return;
  cycleInProgress = true;
  try {
    if (config.sessionKeeper.enabled) {
      const accountIds = getActivePlaywrightAccountIds();
      for (const accountId of accountIds) {
        if (isKeepAliveBackedOff(accountId)) {
          continue;
        }
        try {
          const keptAlive = await keepAlivePlaywrightAccount(accountId);
          if (keptAlive) {
            keepAliveRetries.delete(accountId);
          }
        } catch (error) {
          // Shutdown/eviction closes contexts while a cycle is in flight; the
          // resulting "already closed" rejection is benign. The old substring
          // filter ("Target closed"/"Page is closed") missed Playwright's real
          // message ("Target page, context or browser has been closed") and
          // leaked a warning on every Ctrl+C.
          if (isPlaywrightAlreadyClosedError(error)) {
            keepAliveRetries.delete(accountId);
          } else {
            const message =
              error instanceof Error ? error.message : String(error);
            const backoffMs = recordKeepAliveFailure(accountId);
            console.warn(
              `[SessionKeeper] Keep-alive failed for ${accountId}: ${message} (retry in ${Math.round(backoffMs / 1000)}s)`,
            );
          }
        }
        await sleep(humanDelay(250, 900));
      }
    }

    const closed = await closeIdlePlaywrightAccounts(
      config.playwright.idleContextTtlMs,
    );
    const evicted = await evictIdlePlaywrightContextsToLimit();
    const totalClosed = closed + evicted;
    if (totalClosed > 0) {
      console.log(
        `🧹 [SessionKeeper] Closed ${totalClosed} idle Playwright context(s)`,
      );
    }
  } finally {
    cycleInProgress = false;
  }
}

export function startSessionKeeper(): void {
  const hasKeepAliveWork = config.sessionKeeper.enabled;
  const hasIdleCleanupWork = config.playwright.idleContextTtlMs > 0;
  if (running || (!hasKeepAliveWork && !hasIdleCleanupWork)) return;

  running = true;
  intervalId = setInterval(() => {
    if (running) void runKeepAliveCycle();
  }, config.sessionKeeper.intervalMs);
  intervalId.unref?.();

  if (config.sessionKeeper.enabled) {
    console.log(
      `💓 [SessionKeeper] Keep-alive enabled | interval=${config.sessionKeeper.intervalMs}ms idle=${config.sessionKeeper.idleMs}ms`,
    );
  }
}

export function stopSessionKeeper(): void {
  running = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  cycleInProgress = false;
  keepAliveRetries.clear();
}

export async function runSessionKeeperOnceForTesting(): Promise<void> {
  await runKeepAliveCycle();
}
