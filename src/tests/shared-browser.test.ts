import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  getStorageStatePath,
  loadStorageState,
  isPlaywrightAlreadyClosedError,
  cleanupOrphanProfiles,
} from "../services/playwright.ts";
test("Playwright Storage State: getStorageStatePath returns storage_state.json inside profile path", () => {
  const accountId = "test-acc-123";
  const statePath = getStorageStatePath(accountId);
  assert.ok(statePath.endsWith("storage_state.json"));
  assert.ok(statePath.includes(accountId));
});

test("Playwright Storage State: loadStorageState returns undefined when file does not exist", () => {
  const nonExistent = loadStorageState("non-existent-account-999");
  assert.equal(nonExistent, undefined);
});

test("Playwright Storage State: loadStorageState validates JSON and cookies array", () => {
  const accountId = "storage-test-acc";
  const statePath = getStorageStatePath(accountId);
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });

  try {
    // 1. Invalid structure
    fs.writeFileSync(statePath, JSON.stringify({ invalid: true }));
    assert.equal(loadStorageState(accountId), undefined);

    // 2. Valid structure with cookies
    fs.writeFileSync(statePath, JSON.stringify({ cookies: [{ name: "token", value: "abc" }], origins: [] }));
    const loaded = loadStorageState(accountId);
    assert.ok(loaded);
    assert.equal(loaded, statePath);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("Playwright already-closed error detection", () => {
  assert.equal(isPlaywrightAlreadyClosedError(new Error("Target page, context or browser has been closed")), true);
  assert.equal(isPlaywrightAlreadyClosedError(new Error("Browser has been closed")), true);
  assert.equal(isPlaywrightAlreadyClosedError(new Error("Some random network failure")), false);
});
test("cleanupOrphanProfiles removes directories not belonging to active accounts and stale dirs", () => {
  const tempBase = path.join(process.cwd(), ".tmp", "test-profiles-" + Date.now());
  fs.mkdirSync(tempBase, { recursive: true });

  try {
    // 1. Create active account folder
    const activeDir = path.join(tempBase, "active-acc-1");
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, "storage_state.json"), "{}");

    // 2. Create orphan folder (not in accounts)
    const orphanDir = path.join(tempBase, "orphan-acc-99");
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, "junk.txt"), "hello orphan");

    // 3. Create stale folder
    const staleDir = path.join(tempBase, "active-acc-1.stale-12345");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, "old.txt"), "old data");

    const activeSet = new Set(["active-acc-1"]);
    const result = cleanupOrphanProfiles(tempBase, activeSet);
    // Active folder should still exist
    assert.equal(fs.existsSync(activeDir), true, "active account folder must be preserved");
    // Orphan and stale folders should be removed
    assert.equal(fs.existsSync(orphanDir), false, "orphan folder must be deleted");
    assert.equal(fs.existsSync(staleDir), false, "stale folder must be deleted");
    assert.equal(result.removedCount, 2, "must report 2 removed directories");
    assert.ok(result.freedBytes > 0, "must report freed bytes > 0");
  } finally {
    try { fs.rmSync(tempBase, { recursive: true, force: true }); } catch {}
  }
});
