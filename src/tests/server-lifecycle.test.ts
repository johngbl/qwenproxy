import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import { startServer, stopServer } from "../api/server.ts";
import { config } from "../core/config.ts";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

function snapshotAccounts(): any[] {
  return getDatabase()
    .prepare(
      "SELECT id, email, password, cooldown_until, cooldown_reason FROM accounts",
    )
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

test("server startup fails without configured accounts outside mock mode", async () => {
  const originalMockAuth = process.env.TEST_MOCK_QWEN_AUTH;
  const originalQwenAccounts = process.env.QWEN_ACCOUNTS;
  const existing = snapshotAccounts();

  delete process.env.TEST_MOCK_QWEN_AUTH;
  delete process.env.QWEN_ACCOUNTS;

  try {
    getDatabase().prepare("DELETE FROM accounts").run();
    invalidateAccountsCache();

    await assert.rejects(
      () => startServer({ installSignalHandlers: false }),
      /No Qwen accounts configured/,
    );
  } finally {
    await stopServer();
    restoreAccounts(existing);

    if (originalMockAuth === undefined) {
      delete process.env.TEST_MOCK_QWEN_AUTH;
    } else {
      process.env.TEST_MOCK_QWEN_AUTH = originalMockAuth;
    }

    if (originalQwenAccounts === undefined) {
      delete process.env.QWEN_ACCOUNTS;
    } else {
      process.env.QWEN_ACCOUNTS = originalQwenAccounts;
    }
  }
});

test("server lifecycle starts and stops in mock mode without real accounts", async (t) => {
  const port = config.server.port;
  if (!(await isPortAvailable(port))) {
    t.skip(`port ${port} is not available`);
    return;
  }

  const originalMockAuth = process.env.TEST_MOCK_QWEN_AUTH;
  const originalQwenAccounts = process.env.QWEN_ACCOUNTS;
  const existing = snapshotAccounts();

  process.env.TEST_MOCK_QWEN_AUTH = "true";
  delete process.env.QWEN_ACCOUNTS;

  try {
    getDatabase().prepare("DELETE FROM accounts").run();
    invalidateAccountsCache();

    const started = await startServer({ installSignalHandlers: false });
    assert.equal(started.port, port);
    assert.ok(started.url.includes(String(port)));

    await stopServer();
    await stopServer();
  } finally {
    await stopServer();
    restoreAccounts(existing);

    if (originalMockAuth === undefined) {
      delete process.env.TEST_MOCK_QWEN_AUTH;
    } else {
      process.env.TEST_MOCK_QWEN_AUTH = originalMockAuth;
    }

    if (originalQwenAccounts === undefined) {
      delete process.env.QWEN_ACCOUNTS;
    } else {
      process.env.QWEN_ACCOUNTS = originalQwenAccounts;
    }
  }
});

test("server startup fails fast with an explanatory message when the port is already in use", async () => {
  // Find a free port, occupy it, and point the server config at it so the test
  // runs regardless of what is listening on the default port.
  let port = 3210;
  while (!(await isPortAvailable(port))) port++;

  const blocker = net.createServer();
  await new Promise<void>((resolve) => {
    blocker.once("listening", () => resolve());
    blocker.listen(port, config.server.host);
  });

  const originalPort = config.server.port;
  const originalMockAuth = process.env.TEST_MOCK_QWEN_AUTH;
  const originalQwenAccounts = process.env.QWEN_ACCOUNTS;
  const existing = snapshotAccounts();

  process.env.TEST_MOCK_QWEN_AUTH = "true";
  delete process.env.QWEN_ACCOUNTS;
  config.server.port = port;

  try {
    getDatabase().prepare("DELETE FROM accounts").run();
    invalidateAccountsCache();

    await assert.rejects(
      () => startServer({ installSignalHandlers: false }),
      (err: Error) => {
        assert.match(err.message, /already in use/);
        assert.match(err.message, /PORT=3001 npm start/);
        return true;
      },
    );
  } finally {
    config.server.port = originalPort;
    await stopServer();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    restoreAccounts(existing);

    if (originalMockAuth === undefined) {
      delete process.env.TEST_MOCK_QWEN_AUTH;
    } else {
      process.env.TEST_MOCK_QWEN_AUTH = originalMockAuth;
    }

    if (originalQwenAccounts === undefined) {
      delete process.env.QWEN_ACCOUNTS;
    } else {
      process.env.QWEN_ACCOUNTS = originalQwenAccounts;
    }
  }
});
