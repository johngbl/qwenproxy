import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  getStorageStatePath,
  loadStorageState,
  isPlaywrightAlreadyClosedError,
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
