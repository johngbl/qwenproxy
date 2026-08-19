/**
 * Coverage tests for account-manager cooldown/selection logic.
 *
 * Runs in a temp cwd so the SQLite database (data-test/) is created in
 * isolation. The final group of tests intentionally breaks the database file
 * (replaces it with a directory after closing it) to exercise the persistence
 * catch branches in markAccountRateLimited / clearAccountCooldown /
 * getAccountCooldownInfo without monkey-patching anything.
 */
import test, { after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-acct-mgr-"));

delete process.env.QWEN_ACCOUNTS; // keep the test DB free of env accounts
delete process.env.ENCRYPTION_KEY;

process.chdir(tmpDir);

const {
  markAccountRateLimited,
  clearAccountCooldown,
  getAccountCooldownInfo,
  syncCooldownsFromDb,
  getNextAccount,
  getNextAvailableAccount,
  getCooldownStatus,
} = await import("../core/account-manager.ts");
const { formatCooldownUntil } = await import("../core/logger.ts");
const { closeDatabase } = await import("../core/database.ts");

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("account-manager: cooldown until uses BR format without ms", () => {
  // The "Cooldown set" line shows a plain BR timestamp (no ms, no log stamp).
  const stamp = new Date(2026, 0, 5, 7, 8, 9, 123);
  assert.strictEqual(formatCooldownUntil(stamp), "05/01/2026 07:08:09");
});

test("account-manager: empty database yields no next account", () => {
  // Fresh data-test DB with no accounts rows.
  assert.strictEqual(getNextAccount(), null);
  assert.strictEqual(getNextAvailableAccount(), null);
  assert.strictEqual(getNextAvailableAccount("some-tried-id"), null);
  assert.strictEqual(getNextAvailableAccount(new Set(["a"])), null);
});

test("account-manager: cooldown set/info/clear lifecycle", () => {
  // "global" never touches the database.
  markAccountRateLimited("global", 60_000, "GlobalReason", { silent: true });
  const globalInfo = getAccountCooldownInfo("global");
  assert.ok(globalInfo);
  assert.strictEqual(globalInfo.onCooldown, true);
  assert.strictEqual(globalInfo.reason, "GlobalReason");
  assert.ok(globalInfo.remainingMs > 0);

  // Regular account: persists via UPDATE (0 rows in empty DB is fine).
  markAccountRateLimited("am-a1", 60_000, undefined, { silent: true });
  const a1 = getAccountCooldownInfo("am-a1");
  assert.ok(a1);
  assert.strictEqual(a1.reason, "RateLimited"); // default reason

  // Unknown accounts have no cooldown entry.
  assert.strictEqual(getAccountCooldownInfo("am-unknown"), null);

  clearAccountCooldown("am-a1");
  assert.strictEqual(getAccountCooldownInfo("am-a1"), null);
  clearAccountCooldown("global");
});

test("account-manager: getCooldownStatus reports only active cooldowns", () => {
  markAccountRateLimited("am-live", 60_000, "Live", { silent: true });
  markAccountRateLimited("am-already-expired", -1_000, undefined, {
    silent: true,
  });

  const status = getCooldownStatus();
  assert.ok(status["am-live"]);
  assert.ok(status["am-live"].remainingMs > 0);
  assert.strictEqual(status["am-live"].reason, "Live");
  assert.strictEqual(status["am-already-expired"], undefined);

  clearAccountCooldown("am-live");
});

test("account-manager: expired cooldown is cleaned up on read", () => {
  markAccountRateLimited("am-exp0", -1_000, "Expired", { silent: true });
  // Reading an expired entry deletes it (and clears it in the DB).
  assert.strictEqual(getAccountCooldownInfo("am-exp0"), null);
});

test("account-manager: syncCooldownsFromDb adds, keeps and removes entries", () => {
  markAccountRateLimited("am-del", 60_000, "ToRemove", { silent: true });

  const now = Date.now();
  syncCooldownsFromDb([
    {
      id: "am-s1",
      email: "s1@test.com",
      password: "***",
      cooldown_until: now + 60_000,
      cooldown_reason: "FromDB",
    },
    {
      id: "am-s2",
      email: "s2@test.com",
      password: "***",
      cooldown_until: now + 60_000,
      cooldown_reason: "", // falsy → falls back to "RateLimited"
    },
    {
      id: "am-del",
      email: "del@test.com",
      password: "***",
      cooldown_until: 0, // expired in DB → removed from memory
    },
    { id: "am-s3", email: "s3@test.com", password: "***" },
  ]);

  const s1 = getAccountCooldownInfo("am-s1");
  assert.ok(s1);
  assert.strictEqual(s1.reason, "FromDB");

  const s2 = getAccountCooldownInfo("am-s2");
  assert.ok(s2);
  assert.strictEqual(s2.reason, "RateLimited");

  assert.strictEqual(getAccountCooldownInfo("am-del"), null);

  // Re-sync does not duplicate or overwrite existing in-memory entries.
  syncCooldownsFromDb([
    {
      id: "am-s1",
      email: "s1@test.com",
      password: "***",
      cooldown_until: now + 120_000,
      cooldown_reason: "Other",
    },
  ]);
  const s1Again = getAccountCooldownInfo("am-s1");
  assert.ok(s1Again);
  assert.strictEqual(s1Again.reason, "FromDB"); // kept original entry

  clearAccountCooldown("am-s1");
  clearAccountCooldown("am-s2");
});

test("account-manager: database failures are swallowed by cooldown writers", () => {
  // Break the database: close it, then replace the file with a directory so
  // every reopen attempt throws.
  closeDatabase();
  const dbPath = path.join(tmpDir, "data-test", "db", "qwenproxy.db");
  fs.renameSync(dbPath, `${dbPath}.bak`);
  fs.mkdirSync(dbPath);

  // markAccountRateLimited: DB persist fails, in-memory cooldown still set.
  assert.doesNotThrow(() =>
    markAccountRateLimited("am-dbf", 60_000, "DbFail", { silent: true }),
  );
  const info = getAccountCooldownInfo("am-dbf");
  assert.ok(info);
  assert.strictEqual(info.reason, "DbFail");

  // clearAccountCooldown: DB clear fails, in-memory entry still removed.
  assert.doesNotThrow(() => clearAccountCooldown("am-dbf"));
  assert.strictEqual(getAccountCooldownInfo("am-dbf"), null);

  // Expired-entry cleanup with a broken DB also must not throw.
  markAccountRateLimited("am-exp2", -5, undefined, { silent: true });
  assert.strictEqual(getAccountCooldownInfo("am-exp2"), null);

  // getCooldownStatus is memory-only and keeps working.
  markAccountRateLimited("am-live2", 60_000, "Live2", { silent: true });
  const status = getCooldownStatus();
  assert.ok(status["am-live2"]);
});
