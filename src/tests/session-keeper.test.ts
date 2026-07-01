import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../core/config.ts";
import {
  isSessionKeeperRunning,
  runSessionKeeperOnceForTesting,
  startSessionKeeper,
  stopSessionKeeper,
} from "../services/session-keeper.ts";

test("session keeper starts and stops safely", () => {
  stopSessionKeeper();
  assert.equal(isSessionKeeperRunning(), false);

  startSessionKeeper();
  assert.equal(
    isSessionKeeperRunning(),
    config.sessionKeeper.enabled || config.playwright.idleContextTtlMs > 0,
  );

  stopSessionKeeper();
  assert.equal(isSessionKeeperRunning(), false);
});

test("session keeper one-shot cycle is safe without initialized accounts", async () => {
  stopSessionKeeper();
  await runSessionKeeperOnceForTesting();
  assert.equal(isSessionKeeperRunning(), false);
});
