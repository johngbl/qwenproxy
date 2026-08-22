import test from "node:test";
import assert from "node:assert/strict";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import {
  getNextAccount,
  getNextAvailableAccount,
  isAccountHeadersReady,
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";

const TEST_ACCOUNTS = ["ready-a", "ready-b", "ready-c"];

function seedAccounts(ids: string[]): void {
  const db = getDatabase();
  db.prepare("DELETE FROM accounts").run();
  const insert = db.prepare(
    "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
  );
  for (const id of ids) insert.run(id, `${id}@example.com`, "pw");
  invalidateAccountsCache();
}

// syncEnvAccounts upserts QWEN_ACCOUNTS (from the real .env) into the test DB
// on the first loadAccounts() call, silently restoring real accounts the test
// just deleted. Neutralize it like rotation.test.ts does.
const originalQwenAccounts = process.env.QWEN_ACCOUNTS;

test.beforeEach(() => {
  delete process.env.QWEN_ACCOUNTS;
});

test.afterEach(() => {
  for (const id of [...TEST_ACCOUNTS, "ready-solo"]) {
    unmarkAccountHeadersReady(id);
  }
  if (originalQwenAccounts !== undefined) {
    process.env.QWEN_ACCOUNTS = originalQwenAccounts;
  }
  seedAccounts([]);
  invalidateAccountsCache();
});

test("account-ready-gate: all accounts rotate while none has captured headers (cold startup)", () => {
  seedAccounts(TEST_ACCOUNTS);
  for (const id of TEST_ACCOUNTS) {
    assert.equal(isAccountHeadersReady(id), false);
  }
  // No account ready → every account is a valid candidate (the gate must
  // never deadlock a cold pool). Round-robin still cycles through them.
  const picked = new Set<string>();
  for (let i = 0; i < TEST_ACCOUNTS.length * 2; i++) {
    const account = getNextAccount();
    assert.ok(account && TEST_ACCOUNTS.includes(account.id));
    picked.add(account.id);
  }
  assert.equal(picked.size, TEST_ACCOUNTS.length, "all accounts must rotate");
});

test("account-ready-gate: once one account is ready, rotation only picks it", () => {
  seedAccounts(TEST_ACCOUNTS);
  markAccountHeadersReady("ready-b");

  const first = getNextAccount();
  assert.equal(first?.id, "ready-b", "the only ready account must be picked");

  // Even when asked to avoid a specific not-ready account, the picker must
  // skip the OTHER not-ready accounts and land on the ready one.
  const next = getNextAvailableAccount("ready-a");
  assert.equal(next?.id, "ready-b", "ready account must be preferred over cold ones");
});

test("account-ready-gate: unmark removes the account from the rotation pool", () => {
  seedAccounts(TEST_ACCOUNTS);
  markAccountHeadersReady("ready-b");
  unmarkAccountHeadersReady("ready-b");

  // No ready account remains → cold-start degradation takes over again.
  const first = getNextAccount();
  assert.ok(first && TEST_ACCOUNTS.includes(first.id));
});

test("account-ready-gate: single-account pools stay lossless even when headers are not captured yet", () => {
  seedAccounts(["ready-solo"]);
  const first = getNextAccount();
  assert.equal(first?.id, "ready-solo");
  const next = getNextAvailableAccount("some-other-id");
  assert.equal(next?.id, "ready-solo");
});