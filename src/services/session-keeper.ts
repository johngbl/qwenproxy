import { config } from "../core/config.ts";
import {
  getActivePlaywrightAccountIds,
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
    const accountIds = getActivePlaywrightAccountIds();
    for (const accountId of accountIds) {
      await keepAlivePlaywrightAccount(accountId).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Target closed") && !message.includes("Page is closed")) {
          console.warn(`[SessionKeeper] Keep-alive failed for ${accountId}: ${message}`);
        }
      });
      await sleep(humanDelay(250, 900));
    }
  } finally {
    cycleInProgress = false;
  }
}

export function startSessionKeeper(): void {
  if (running || !config.sessionKeeper.enabled) return;

  running = true;
  intervalId = setInterval(() => {
    if (running) void runKeepAliveCycle();
  }, config.sessionKeeper.intervalMs);
  intervalId.unref?.();

  console.log(
    `[SessionKeeper] Started | interval=${config.sessionKeeper.intervalMs}ms idle=${config.sessionKeeper.idleMs}ms`,
  );
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
