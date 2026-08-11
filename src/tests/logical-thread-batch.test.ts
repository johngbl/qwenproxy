import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";

// IMPORTANT: this suite exercises the REAL SQLite persistence path, so the
// auth mock MUST be off. The node test runner spawns one process per file,
// so the env set by other suites cannot leak in here.
delete process.env.TEST_MOCK_QWEN_AUTH;

const {
  updateLogicalThreadState,
  getLogicalThreadState,
  flushLogicalThreadState,
  clearAllSessionsForAccount,
} = await import("../services/qwen.ts");
const { getDatabase, closeDatabase } = await import("../core/database.ts");

const ACCOUNT = "batch-test-account";
const UNIQ = `${Date.now()}`;

function countRows(sessionId: string): number {
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM logical_thread_states WHERE session_id = ?",
    )
    .get(sessionId) as { c: number };
  return row.c;
}

function getRow(sessionId: string):
  | {
      session_id: string;
      account_id: string;
      chat_session_id: string;
      parent_id: string | null;
      instructions_sent: number;
    }
  | undefined {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT session_id, account_id, chat_session_id, parent_id, instructions_sent FROM logical_thread_states WHERE session_id = ?",
    )
    .get(sessionId) as
    | {
        session_id: string;
        account_id: string;
        chat_session_id: string;
        parent_id: string | null;
        instructions_sent: number;
      }
    | undefined;
}

afterEach(() => {
  // No pending timers or rows may leak into the next test.
  flushLogicalThreadState();
  clearAllSessionsForAccount(ACCOUNT);
});

after(() => {
  flushLogicalThreadState();
  closeDatabase();
});

test("updateLogicalThreadState defers the SQLite write until flush", () => {
  const sessionId = `batch-defer-${UNIQ}`;
  updateLogicalThreadState(sessionId, {
    accountId: ACCOUNT,
    chatSessionId: `chat-defer-${UNIQ}`,
    parentId: "p-1",
    instructionsSent: true,
  });

  // Cache is authoritative immediately…
  const state = getLogicalThreadState(sessionId);
  assert.ok(state);
  assert.equal(state!.chatSessionId, `chat-defer-${UNIQ}`);
  // …but the row only lands in SQLite after an explicit flush.
  assert.equal(countRows(sessionId), 0);

  flushLogicalThreadState();
  const row = getRow(sessionId);
  assert.ok(row);
  assert.equal(row!.account_id, ACCOUNT);
  assert.equal(row!.chat_session_id, `chat-defer-${UNIQ}`);
  assert.equal(row!.parent_id, "p-1");
  assert.equal(row!.instructions_sent, 1);
});

test("updates within the debounce window coalesce into one row (last wins)", () => {
  const sessionId = `batch-coalesce-${UNIQ}`;
  updateLogicalThreadState(sessionId, {
    accountId: ACCOUNT,
    chatSessionId: `chat-c-${UNIQ}`,
    parentId: "p-old",
    instructionsSent: true,
  });
  updateLogicalThreadState(sessionId, {
    accountId: ACCOUNT,
    chatSessionId: `chat-c-${UNIQ}`,
    parentId: "p-new",
    instructionsSent: true,
  });
  flushLogicalThreadState();

  const row = getRow(sessionId);
  assert.ok(row);
  assert.equal(row!.parent_id, "p-new");
  assert.equal(row!.instructions_sent, 1);
});

test("flush is a no-op when nothing is dirty", () => {
  assert.doesNotThrow(() => flushLogicalThreadState());
});

test("the debounce timer auto-flushes without an explicit call", async () => {
  const sessionId = `batch-timer-${UNIQ}`;
  updateLogicalThreadState(sessionId, {
    accountId: ACCOUNT,
    chatSessionId: `chat-t-${UNIQ}`,
    parentId: "p-auto",
    instructionsSent: true,
  });
  // Nothing written yet…
  assert.equal(countRows(sessionId), 0);
  // …but the 300ms debounce fires on its own.
  await new Promise((resolve) => setTimeout(resolve, 450));
  const row = getRow(sessionId);
  assert.ok(row);
  assert.equal(row!.parent_id, "p-auto");
  assert.equal(row!.instructions_sent, 1);
});

test("a pending flush does not resurrect rows cleared for the account", () => {
  const sessionId = `batch-clear-${UNIQ}`;
  updateLogicalThreadState(sessionId, {
    accountId: ACCOUNT,
    chatSessionId: `chat-x-${UNIQ}`,
    parentId: null,
    instructionsSent: false,
  });
  // Account rotation drops everything for the account…
  clearAllSessionsForAccount(ACCOUNT);
  // …then the debounce fires — the cache entry is gone, so nothing is written.
  flushLogicalThreadState();
  assert.equal(countRows(sessionId), 0);
  assert.equal(getLogicalThreadState(sessionId), null);
});
