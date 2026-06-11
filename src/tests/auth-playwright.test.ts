import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";

const originalMockAuth = process.env.TEST_MOCK_QWEN_AUTH;
const originalQwenAccounts = process.env.QWEN_ACCOUNTS;

function snapshotAccounts(): any[] {
  return getDatabase()
    .prepare("SELECT id, email, password, cooldown_until, cooldown_reason FROM accounts")
    .all() as any[];
}

function restoreAccounts(rows: any[]): void {
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

afterEach(() => {
  if (originalMockAuth === undefined) delete process.env.TEST_MOCK_QWEN_AUTH;
  else process.env.TEST_MOCK_QWEN_AUTH = originalMockAuth;

  if (originalQwenAccounts === undefined) delete process.env.QWEN_ACCOUNTS;
  else process.env.QWEN_ACCOUNTS = originalQwenAccounts;

  invalidateAccountsCache();
});

test("auth-playwright: mock mode returns complete headers", async () => {
  process.env.TEST_MOCK_QWEN_AUTH = "true";
  const { getBasicHeaders, getQwenHeaders, isAuthMockEnabled } = await import(
    "../services/auth-playwright.ts"
  );

  assert.equal(isAuthMockEnabled(), true);

  const basic = await getBasicHeaders();
  assert.equal(basic.cookie, "token=mock");
  assert.equal(basic.userAgent, "mock");
  assert.equal(basic.bxV, "2.5.36");
  assert.equal(basic.bxUa, "mock-bx-ua");
  assert.equal(basic.bxUmidtoken, "mock-bx-umidtoken");

  const full = await getQwenHeaders(true);
  assert.equal(full.headers.cookie, "token=mock");
  assert.equal(full.headers["bx-ua"], "mock-bx-ua");
  assert.equal(full.parentMessageId, null);
});

test("auth-playwright: requires configured account outside mock mode", async () => {
  const existing = snapshotAccounts();
  delete process.env.TEST_MOCK_QWEN_AUTH;
  delete process.env.QWEN_ACCOUNTS;

  try {
    restoreAccounts([]);
    const { getBasicHeaders } = await import("../services/auth-playwright.ts");
    await assert.rejects(
      () => getBasicHeaders(),
      /No Qwen accounts configured/,
    );
  } finally {
    restoreAccounts(existing);
  }
});

test("auth-playwright: falls back to first configured account when no account id is provided", async () => {
  const existing = snapshotAccounts();
  delete process.env.TEST_MOCK_QWEN_AUTH;
  delete process.env.QWEN_ACCOUNTS;

  try {
    restoreAccounts([
      {
        id: "auth-pw-account",
        email: "auth-pw@example.com",
        password: "secret",
        cooldown_until: 0,
        cooldown_reason: null,
      },
    ]);

    const { getBasicHeaders } = await import("../services/auth-playwright.ts");
    await assert.rejects(
      () => getBasicHeaders(),
      /Playwright not initialized for account: auth-pw-account/,
    );
  } finally {
    restoreAccounts(existing);
  }
});
