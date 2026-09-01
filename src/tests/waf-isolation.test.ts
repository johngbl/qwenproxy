import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { config } from "../core/config.ts";
import {
  getFingerprintProfile,
  rotateFingerprintSeed,
  clearFingerprintCache,
} from "../services/fingerprint.ts";
import {
  recordWafHardBlock,
  noteWafRecovery,
  getWafHardBlockCount,
} from "../core/waf-isolation.ts";
import {
  getAccountCooldownInfo,
  clearAccountCooldown,
} from "../core/account-manager.ts";

test("rotateFingerprintSeed changes the device identity deterministically", () => {
  clearFingerprintCache();
  const before = getFingerprintProfile("rot-acc");
  rotateFingerprintSeed("rot-acc");
  const after = getFingerprintProfile("rot-acc");

  assert.notEqual(after.seed, before.seed, "seed must change after rotation");
  // Deterministic again after the rotation (stable until the next one).
  assert.deepEqual(
    getFingerprintProfile("rot-acc"),
    after,
    "profile must be stable after rotation",
  );
  clearFingerprintCache();
});

test("hard WAF block rotates the fingerprint and quarantines the account", () => {
  clearFingerprintCache();
  const acc = "waf-hard-1";
  clearAccountCooldown(acc);
  const before = getFingerprintProfile(acc);

  const result = recordWafHardBlock(acc);

  assert.equal(result.fingerprintRotated, true);
  assert.notEqual(
    getFingerprintProfile(acc).seed,
    before.seed,
    "recovery must NOT return on the fingerprint the WAF already flagged",
  );
  const cd = getAccountCooldownInfo(acc);
  assert.ok(cd, "account must be quarantined after a hard block");
  assert.equal(cd!.reason, "WafChallenge");
  clearAccountCooldown(acc);
  clearFingerprintCache();
});

test("consecutive hard blocks escalate the quarantine, capped, and reset on recovery", () => {
  const acc = "waf-hard-2";
  clearAccountCooldown(acc);
  const base = config.captcha.accountCooldownMs;
  const cap = config.captcha.hardBlockMaxCooldownMs;

  const first = recordWafHardBlock(acc);
  assert.equal(first.cooldownMs, base);
  const second = recordWafHardBlock(acc);
  assert.equal(second.cooldownMs, Math.min(cap, base * 2));
  const third = recordWafHardBlock(acc);
  assert.equal(third.cooldownMs, Math.min(cap, base * 4));
  assert.equal(getWafHardBlockCount(acc), 3);

  noteWafRecovery(acc);
  assert.equal(getWafHardBlockCount(acc), 0);
  const afterRecovery = recordWafHardBlock(acc);
  assert.equal(
    afterRecovery.cooldownMs,
    base,
    "counter must reset after a successful stream",
  );

  clearAccountCooldown(acc);
});

test("escalation never exceeds the configured cap", () => {
  const acc = "waf-hard-3";
  clearAccountCooldown(acc);
  let last = 0;
  for (let i = 0; i < 10; i++) {
    last = recordWafHardBlock(acc).cooldownMs;
  }
  assert.ok(
    last <= config.captcha.hardBlockMaxCooldownMs,
    `cooldown ${last} must stay capped`,
  );
  clearAccountCooldown(acc);
});
