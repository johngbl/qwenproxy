import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearFingerprintCache,
  getFingerprintProfile,
} from "../services/fingerprint.ts";

test("fingerprint profile is deterministic per account", () => {
  clearFingerprintCache();
  const first = getFingerprintProfile("account-a");
  const second = getFingerprintProfile("account-a");

  assert.deepEqual(second, first);
  assert.equal(first.accountId, "account-a");
  assert.match(first.userAgent, /Chrome\/149\.0\.\d+\.\d+/);
  assert.equal(first.platform, "Win32");
  assert.equal(first.locale, first.languages[0]);
  assert.equal(first.colorDepth, 24);
  assert.equal(first.pixelDepth, 24);
});

test("fingerprint profile varies across accounts without changing invariants", () => {
  clearFingerprintCache();
  const first = getFingerprintProfile("account-a");
  const second = getFingerprintProfile("account-b");

  assert.notEqual(second.seed, first.seed);
  assert.notEqual(second.accountId, first.accountId);
  assert.match(second.secChUa, /Google Chrome/);
  assert.equal(second.fullVersionList.length, second.brands.length);
  assert.ok(second.viewport.width >= 1366);
  assert.ok(second.viewport.height >= 768);
  assert.ok(second.hardwareConcurrency >= 4);
  assert.ok(second.deviceMemory >= 4);
});
