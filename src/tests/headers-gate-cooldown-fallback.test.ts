import test from "node:test";
import assert from "node:assert/strict";
import {
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
  markAccountRateLimited,
  clearAccountCooldown,
  clearAllAccountCooldowns,
  getNextAvailableAccount,
  getAccountCooldownInfo,
} from "../core/account-manager.ts";
import { addAccount, removeAccount } from "../core/accounts.ts";

test("HeadersReadyGate gracefully degrades to non-ready accounts when all ready accounts are on cooldown", async (t) => {
  const id1 = "test-ready-acct-1";
  const email1 = "ready1@example.com";
  const id2 = "test-unready-acct-2";
  const email2 = "unready2@example.com";

  addAccount(email1, "dummy-pass-1", id1);
  addAccount(email2, "dummy-pass-2", id2);

  t.after(() => {
    clearAccountCooldown(id1);
    clearAccountCooldown(id2);
    unmarkAccountHeadersReady(id1);
    unmarkAccountHeadersReady(id2);
    removeAccount(id1);
    removeAccount(id2);
  });

  // Initially: account1 is marked ready, account2 is unready
  markAccountHeadersReady(id1);
  unmarkAccountHeadersReady(id2);

  // When account1 is NOT on cooldown, rotation prefers the ready account (account1)
  const candidate1 = getNextAvailableAccount();
  assert.equal(candidate1?.id, id1, "Should pick ready account when it is available");

  // Put account1 on cooldown
  markAccountRateLimited(id1, 60000, "RateLimited", { silent: true });
  assert.ok(getAccountCooldownInfo(id1)?.onCooldown);

  // Now, since the ONLY ready account is on cooldown, getNextAvailableAccount should
  // fall back to account2 (the unready one) instead of declaring that all accounts are on cooldown!
  const candidate2 = getNextAvailableAccount();
  assert.equal(
    candidate2?.id,
    id2,
    "Should fall back to non-ready account when all ready accounts are on cooldown",
  );

  // Clear all cooldowns using clearAllAccountCooldowns
  const clearedCount = clearAllAccountCooldowns();
  assert.ok(clearedCount >= 1, "Should have cleared at least 1 account cooldown");
  assert.equal(getAccountCooldownInfo(id1), null, "Account 1 cooldown should be cleared");

  // Now account1 is free again and ready, so it should be picked
  const candidate3 = getNextAvailableAccount();
  assert.equal(candidate3?.id, id1, "Should pick ready account1 after cooldown reset");
});
