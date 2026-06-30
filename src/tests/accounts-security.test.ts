import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || "qwenbridge-test-key";
const originalQwenAccounts = process.env.QWEN_ACCOUNTS;
delete process.env.QWEN_ACCOUNTS;

import {
  addAccount,
  getAccountCredentials,
  invalidateAccountsCache,
  loadAccounts,
} from "../core/accounts.ts";
import { closeDatabase, getDatabase } from "../core/database.ts";

interface AccountRow {
  id: string;
  email: string;
  password: string;
  cooldown_until?: number;
  cooldown_reason?: string | null;
}

function snapshotAccounts(): AccountRow[] {
  return getDatabase()
    .prepare(
      "SELECT id, email, password, cooldown_until, cooldown_reason FROM accounts ORDER BY created_at ASC",
    )
    .all() as AccountRow[];
}

function restoreAccounts(rows: AccountRow[]): void {
  closeDatabase();
  const db = getDatabase();
  db.prepare("DELETE FROM accounts").run();
  const insert = db.prepare(
    "INSERT INTO accounts (id, email, password, cooldown_until, cooldown_reason) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.email,
      row.password,
      row.cooldown_until ?? 0,
      row.cooldown_reason ?? null,
    );
  }
  invalidateAccountsCache();
}

let restoreRows: AccountRow[] | null = null;

afterEach(() => {
  if (restoreRows) {
    restoreAccounts(restoreRows);
    restoreRows = null;
  }

  if (originalQwenAccounts === undefined) {
    delete process.env.QWEN_ACCOUNTS;
  } else {
    process.env.QWEN_ACCOUNTS = originalQwenAccounts;
  }
});

test("accounts: stores encrypted password while exposing masked list entries", () => {
  delete process.env.QWEN_ACCOUNTS;
  const db = getDatabase();
  restoreRows = snapshotAccounts();
  db.prepare("DELETE FROM accounts").run();
  invalidateAccountsCache();

  const account = addAccount("secure@example.com", "super-secret", "acc-sec");
  assert.equal(account.password, "super-secret");

  const stored = db
    .prepare("SELECT password FROM accounts WHERE id = ?")
    .get(account.id) as { password: string };

  assert.notEqual(stored.password, "super-secret");
  assert.match(stored.password, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i);

  const listed = loadAccounts();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].password, "***");

  const credentials = getAccountCredentials(account.id);
  assert.equal(credentials?.password, "super-secret");
});

test("accounts: accepts semicolon-delimited QWEN_ACCOUNTS entries", () => {
  process.env.QWEN_ACCOUNTS =
    "semi1@example.com:alpha,one;semi2@example.com:beta:two";
  const db = getDatabase();
  restoreRows = snapshotAccounts();
  db.prepare("DELETE FROM accounts").run();
  invalidateAccountsCache();

  const accounts = loadAccounts();
  assert.equal(accounts.length, 2);
  assert.deepEqual(
    accounts.map((account) => account.email),
    ["semi1@example.com", "semi2@example.com"],
  );

  const credentials1 = getAccountCredentials(accounts[0].id);
  const credentials2 = getAccountCredentials(accounts[1].id);
  assert.equal(credentials1?.password, "alpha,one");
  assert.equal(credentials2?.password, "beta:two");
});

test("database: migrates legacy plaintext passwords to encrypted storage", () => {
  delete process.env.QWEN_ACCOUNTS;
  const db = getDatabase();
  restoreRows = snapshotAccounts();
  db.prepare("DELETE FROM accounts").run();
  invalidateAccountsCache();

  db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)").run(
    "legacy-acc",
    "legacy@example.com",
    "legacy-password",
  );

  closeDatabase();
  invalidateAccountsCache();

  const reopened = getDatabase();
  const stored = reopened
    .prepare("SELECT password FROM accounts WHERE id = ?")
    .get("legacy-acc") as { password: string };

  assert.notEqual(stored.password, "legacy-password");
  assert.match(stored.password, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i);

  const credentials = getAccountCredentials("legacy-acc");
  assert.equal(credentials?.password, "legacy-password");
});
