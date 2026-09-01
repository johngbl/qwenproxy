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
        await keepAlivePlaywrightAccount(accountId).catch((error) => {
          // Shutdown/eviction closes contexts while a cycle is in flight; the
          // resulting "already closed" rejection is benign. The old substring
          // filter ("Target closed"/"Page is closed") missed Playwright's real
          // message ("Target page, context or browser has been closed") and
          // leaked a warning on every Ctrl+C.
          if (isPlaywrightAlreadyClosedError(error)) return;
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(
            `[SessionKeeper] Keep-alive failed for ${accountId}: ${message}`,
          );
        });
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
}

export async function runSessionKeeperOnceForTesting(): Promise<void> {
  await runKeepAliveCycle();
}
