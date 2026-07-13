import { test } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeAntiBotChallengeText,
  isCaptchaSolverEnabled,
  resetCaptchaSolverStateForTests,
  recoverAntiBotChallenge,
} from "../services/captcha-solver.ts";
import { config } from "../core/config.ts";

test("looksLikeAntiBotChallengeText detects TMD / sufei markers from network captures", () => {
  assert.equal(
    looksLikeAntiBotChallengeText(
      'ret: ["FAIL_SYS_USER_VALIDATE"] _____tmd_____ punish',
    ),
    true,
  );
  assert.equal(
    looksLikeAntiBotChallengeText(
      'window._config_ = { "renderTo": "#nocaptcha", "action": "denyfromx5" }',
    ),
    true,
  );
  assert.equal(
    looksLikeAntiBotChallengeText("FORMACTIOIN: /bx/_____tmd_____/verify/"),
    true,
  );
  assert.equal(looksLikeAntiBotChallengeText("normal chat response"), false);
});

test("captcha solver is enabled by default", () => {
  assert.equal(config.captchaSolver.enabled, true);
  assert.equal(isCaptchaSolverEnabled(), true);
  assert.ok(config.captchaSolver.timeoutMs >= 5000);
  assert.ok(config.captchaSolver.maxSliderAttempts >= 1);
});

test("recoverAntiBotChallenge fails closed when playwright is not initialized", async () => {
  resetCaptchaSolverStateForTests();
  const result = await recoverAntiBotChallenge("missing-account-for-test");
  assert.equal(result.success, false);
  assert.equal(result.method, "failed");
  assert.match(String(result.detail), /playwright_not_initialized/);
});
