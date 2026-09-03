import test from "node:test";
import assert from "node:assert";

import {
  classifyRetryAction,
} from "../routes/chat/retry-policy.ts";
import { computeQuotaCooldownMs } from "../routes/chat/retry-policy.ts";
import { markAccountRateLimited, getAccountCooldownInfo } from "../core/account-manager.ts";

/**
 * Quota-cooldown correctness (from the 2026-08-21 production log, timestamps UTC):
 *
 * The Qwen daily quota resets at the NEXT MIDNIGHT UTC, not "now + N hours".
 * The upstream "Wait about N hour(s)" message is the Qwen counting toward that
 * midnight — accurate when the error arrives mid-day, but when it arrives near
 * 00:00 (mzgns at 23:37) the hint rounds UP to "23h" while the real reset was
 * 23 minutes away. The proxy blocked mzgns for 22 extra hours while the account
 * was already usable (proven by the redeploy accepting it at 20:50 d+1).
 *
 * Fix: quota cooldown = time until the next 00:00 UTC (+ a small safety margin),
 * never the literal "now + N hours" hint, never the 24h fallback.
 */

test("quota: error near midnight (23:37) cools only until the next 00:00 UTC (~23min), not 23h", () => {
  const errMs = Date.parse("2026-08-20T23:37:27.000Z");
  const ms = computeQuotaCooldownMs(errMs);
  // 00:00 UTC of 2026-08-21 minus 23:37:27 = ~22.5 minutes (+ margin).
  assert.ok(ms < 60 * 60 * 1000, `must revalidate within ~1h, got ${Math.round(ms / 1000)}s`);
  assert.ok(ms > 20 * 60 * 1000, `must wait until the real midnight, got ${Math.round(ms / 1000)}s`);
});

test("quota: mid-day error (02:01) cools until the next midnight (~22h), respecting the daily cap", () => {
  const errMs = Date.parse("2026-08-21T02:01:09.000Z");
  const ms = computeQuotaCooldownMs(errMs);
  // next 00:00 UTC = 2026-08-22T00:00Z → ~21h58m.
  assert.ok(ms > 21 * 60 * 60 * 1000, `expected ~22h, got ${Math.round(ms / 3600_000)}h`);
  assert.ok(ms < 24 * 60 * 60 * 1000, "never exceed 24h");
});

test("quota: late-day error (18:07) cools until the next midnight (~6h), not the hint literal", () => {
  const errMs = Date.parse("2026-08-21T18:07:32.000Z");
  const ms = computeQuotaCooldownMs(errMs);
  assert.ok(ms > 5 * 60 * 60 * 1000 && ms < 8 * 60 * 60 * 1000,
    `expected ~6h, got ${Math.round(ms / 3600_000)}h`);
});
test("quota: error just after midnight (00:01 / 00:04) is capped and never exceeds 24h", () => {
  const errMs = Date.parse("2026-08-21T00:04:54.000Z");
  const ms = computeQuotaCooldownMs(errMs);
  assert.ok(ms < 24 * 60 * 60 * 1000, `never exceed 24h, got ${ms}`);
  assert.ok(ms > 23 * 60 * 60 * 1000, `must be ~24h, got ${Math.round(ms / 3600_000)}h`);
});

test("quota: without a wait hint it still uses the midnight-based cooldown (never the 24h fallback)", () => {
  const err = Object.assign(
    new Error("RateLimited: You've reached the upper limit for today's usage."),
    { upstreamCode: "RateLimited", upstreamStatus: 429 },
  );
  const action = classifyRetryAction(err);
  assert.ok(action.accountCooldownMs !== undefined, "must set a finite cooldown");
  assert.ok(
    action.accountCooldownMs! <= 24 * 60 * 60 * 1000 &&
      action.accountCooldownMs! > 0,
    `finite cooldown expected, got ${action.accountCooldownMs}`,
  );
  assert.equal(action.switchAccount, true);
  assert.equal(action.reason, "quota_or_rate_limit");
});

test("quota: temporary ('alta demanda') keeps the short same-account retry", () => {
  const err = Object.assign(
    new Error("quota_limit: O serviço está com alta demanda no momento."),
    { upstreamCode: "quota_limit", upstreamStatus: 502 },
  );
  const action = classifyRetryAction(err);
  assert.equal(action.switchAccount, false);
  assert.equal(action.accountCooldownReason, "RateLimitTemporary");
  assert.ok(action.accountCooldownMs! <= 2 * 60 * 1000 + 1);
});

test("quota: markAccountRateLimited with no explicit duration falls back to the midnight-based default, not 24h", () => {
  const before = Date.now();
  markAccountRateLimited("qtest-nohint", undefined, "QuotaExceeded", {
    silent: true,
  });
  const info = getAccountCooldownInfo("qtest-nohint");
  assert.ok(info, "cooldown must be set");
  assert.ok(
    info.remainingMs < 24 * 60 * 60 * 1000,
    `fallback must not be a blind 24h, got ${Math.round(info.remainingMs / 3600_000)}h`,
  );
  assert.ok(info.remainingMs > 0);
  assert.ok(before <= Date.now());
});