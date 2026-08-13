import test from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.js";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import { clearAccountCooldown } from "../core/account-manager.ts";
import { clearTemporaryBusy } from "../core/account-concurrency.ts";
import { invalidatePriorityCache } from "../core/account-priority.ts";

/**
 * Seed a second account so the chat_in_progress escalation can actually
 * switch accounts (the log-label / session-clear bugs only manifest when the
 * escalation moves to a fresh account). Snapshots and restores the accounts
 * table in a finally so sibling tests keep their single-account world.
 */
function withEscalationAccounts(
  fn: () => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    // syncEnvAccounts upserts QWEN_ACCOUNTS (from the real .env) into the
    // test DB on the first loadAccounts() call, repopulating real accounts
    // the test just deleted. Neutralize it so the escalation pool is exactly
    // the two seeded accounts (deterministic switch target).
    const originalEnv = process.env.QWEN_ACCOUNTS;
    delete process.env.QWEN_ACCOUNTS;

    // account-priority.ts persists to the REAL data/ dir (not data-test); the
    // successful escalation attempt calls markAccountSuccessful on a seeded
    // account, polluting the production priority file. Snapshot and restore it.
    const priorityPath = "data/account-priority.json";
    const hadPriorityFile = existsSync(priorityPath);
    const prioritySnapshot = hadPriorityFile
      ? readFileSync(priorityPath, "utf-8")
      : null;

    const db = getDatabase();
    const existing = db
      .prepare("SELECT id, email, password FROM accounts")
      .all() as Array<{ id: string; email: string; password: string }>;
    db.prepare("DELETE FROM accounts").run();
    invalidateAccountsCache();

    const insert = db.prepare(
      "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
    );
    insert.run("escalation-alt-1", "escalation-alt-1@example.com", "pw");
    insert.run("escalation-alt-2", "escalation-alt-2@example.com", "pw");
    clearAccountCooldown("escalation-alt-1");
    clearAccountCooldown("escalation-alt-2");
    // A sibling test may leave mock-account temporarily busy (chat_in_progress
    // marks it for chatInProgressBusyMs). If the request starts while mock is
    // still flagged, acquireUpstreamStream SKIPS the original account and the
    // first chat_in_progress lands on a seeded alt account, breaking the
    // origin-account assertions. Reset the flag so the request really starts
    // on mock-account.
    clearTemporaryBusy("mock-account");
    invalidateAccountsCache();

    try {
      await fn();
    } finally {
      // Restore the priority file BEFORE restoring accounts (markAccountSuccessful
      // during the test wrote the seeded account into it). Also invalidate the
      // module-level priorityCache: it was mutated in memory by the same calls,
      // and a later save would re-persist the polluted order.
      invalidatePriorityCache();
      if (hadPriorityFile && prioritySnapshot !== null) {
        writeFileSync(priorityPath, prioritySnapshot, "utf-8");
      } else if (!hadPriorityFile && existsSync(priorityPath)) {
        unlinkSync(priorityPath);
      }

      db.prepare("DELETE FROM accounts").run();
      const restore = db.prepare(
        "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
      );
      for (const row of existing) restore.run(row.id, row.email, row.password);
      clearAccountCooldown("escalation-alt-1");
      clearAccountCooldown("escalation-alt-2");
      // The chat_in_progress failures marked mock-account temporarily busy
      // (chatInProgressBusyMs window). Clear it so the NEXT test in the file
      // starts on mock-account and not on a leftover busy-flag skip (which
      // silently falls through to the seeded alt accounts / real accounts in
      // CI where the DB is empty, breaking the sibling "four times" test).
      clearTemporaryBusy("mock-account");
      clearTemporaryBusy("escalation-alt-1");
      clearTemporaryBusy("escalation-alt-2");
      if (originalEnv !== undefined) process.env.QWEN_ACCOUNTS = originalEnv;
      invalidateAccountsCache();
    }
  };
}

/** Capture console.warn lines during a request (log-assertion tests). */
function captureWarns(): {
  warns: string[];
  restore: () => void;
} {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  return {
    warns,
    restore: () => {
      console.warn = original;
    },
  };
}

/**
 * End-to-end guard for the chat_in_progress settle path: the tool loop fires
 * the next turn the instant the previous one completes, and the upstream chat
 * stays "in progress" for a few seconds. The attempt loop must retry the same
 * chat (up to three retries) before any escalation, and a request that hits
 * the transient error repeatedly must still succeed on the next attempt.
 *
 * The mock upstream returns the upstream JSON error for the first N completion
 * calls and a normal stream afterwards.
 */
function installMockFetch(failures = 2) {
  const originalFetch = globalThis.fetch;
  let completionCalls = 0;
  const calls: string[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);

    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }

    if (url.includes("/api/v2/chat/completions")) {
      completionCalls++;
      calls.push(url);
      if (completionCalls <= failures) {
        // Upstream chat-state error (Qwen keeps the chat "in progress" for a
        // moment after a completed turn). parseQwenJsonError normalizes the
        // message to chat_in_progress.
        return new Response(
          JSON.stringify({
            error: { message: "Qwen: The chat is in progress!" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices": [{"delta": {"phase": "answer", "content": "settled"}}]}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              'data: {"choices": [{"delta": {"phase": "answer", "status": "finished"}}]}\n\n',
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }

    return originalFetch(input, init);
  };

  return {
    completionCalls: () => completionCalls,
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("chat_in_progress twice then success: same-chat retries before escalation", async () => {
  const mock = installMockFetch();
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "chat-progress-settle-test",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );

    assert.strictEqual(res.status, 200, "request must survive the settle race");
    const text = await res.text();
    assert.ok(text.includes("settled"), "final attempt should stream normally");
    assert.ok(text.includes("data: [DONE]"), "stream must terminate");

    // Exactly 3 completion calls: 2 transient chat_in_progress + 1 success.
    // More would mean the settle retries were skipped; fewer would mean the
    // transient errors were treated as terminal.
    assert.strictEqual(
      mock.completionCalls(),
      3,
      "expected 2 chat_in_progress failures + 1 success",
    );
  } finally {
    mock.restore();
  }
});

test("chat_in_progress three times then success: the 3rd same-chat retry also avoids escalation", async () => {
  const mock = installMockFetch(3);
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "chat-progress-settle-test-3",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );

    assert.strictEqual(res.status, 200, "request must survive a slow settle");
    const text = await res.text();
    assert.ok(text.includes("settled"), "final attempt should stream normally");
    assert.ok(text.includes("data: [DONE]"), "stream must terminate");

    // Exactly 4 completion calls: 3 transient chat_in_progress (settle >6s was
    // observed after huge turns) + 1 success. Escalating earlier would replay
    // the full context on another account instead. The settle window has its
    // own budget inside tryCreateStreamWithRetry (independent of the global
    // RETRY_MAX_ATTEMPTS=3), so all 4 calls happen in the same retry loop.
    assert.strictEqual(
      mock.completionCalls(),
      4,
      "expected 3 chat_in_progress failures + 1 success",
    );
  } finally {
    mock.restore();
  }
});

test("chat_in_progress escalation: the generic retry log names the account that ACTUALLY failed, not the freshly-selected one", withEscalationAccounts(async () => {
  const mock = installMockFetch(4);
  const capture = captureWarns();
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "chat-progress-escalation-label",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );

    assert.strictEqual(res.status, 200, "escalation attempt must succeed");
    const text = await res.text();
    assert.ok(text.includes("settled"), "final attempt should stream normally");

    // The escalation switched accounts (the second account now serves). The
    // generic retry log emitted AFTER the switch must still name the account
    // whose request failed — the ORIGINAL one — not the escalation target
    // that was never attempted. Regression: it logged the NEW account, e.g.
    // "Qwen request failed for chat.qwen.ai.280wu" when 280wu never failed.
    const escalation = capture.warns.find((w) =>
      w.includes("chat_in_progress escalation (4)"),
    );
    assert.ok(
      escalation,
      "escalation must fire: " + capture.warns.join("\n"),
    );
    assert.ok(
      escalation!.includes("mock"),
      "escalation switches away from the original account, got: " + escalation,
    );
    assert.ok(
      escalation!.includes("escalation-alt"),
      "escalation must target a seeded alt account, got: " + escalation,
    );

    const retryLog = capture.warns.find(
      (w) =>
        w.includes("Qwen request failed for") &&
        w.includes("retrying in 0ms"),
    );
    assert.ok(retryLog, "post-escalation retry log must exist");
    assert.ok(
      retryLog!.includes("Qwen request failed for mock"),
      "retry log must name the ORIGINAL account, got: " + retryLog,
    );
    assert.ok(
      !retryLog!.includes("escalation-alt-1"),
      "retry log must NOT name the escalation target, got: " + retryLog,
    );
  } finally {
    capture.restore();
    mock.restore();
  }
}));

test("chat_in_progress escalation: exhausted-retries session clear targets the ORIGIN account, never the escalation target", withEscalationAccounts(async () => {
  // 5 failures: 4 accumulate chat_in_progress on the original account, the
  // 5th is the escalation attempt on the fresh account — it ALSO fails, so
  // the settle budget is exhausted and the loop-exit clear must drop the
  // binding to the account whose chat is stuck (the origin), not the fresh
  // account that never served this session (cross-session damage).
  const mock = installMockFetch(5);
  const capture = captureWarns();
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "chat-progress-escalation-clear",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );
    // Drain the response so the underlying stream is consumed and the event
    // loop can shut down (an unread SSE stream keeps the process alive).
    await res.text();

    const clearLog = capture.warns.find((w) =>
      w.includes("Clearing session state for"),
    );
    assert.ok(clearLog, "exhausted retries must clear session state");
    assert.ok(
      clearLog!.includes("(mock-account)"),
      "clear must target the ORIGIN account (mock-account), got: " + clearLog,
    );
    assert.ok(
      !clearLog!.includes("escalation-alt-1"),
      "clear must NOT target the escalation account, got: " + clearLog,
    );
  } finally {
    capture.restore();
    mock.restore();
  }
}));

test("chat_in_progress four times: the settle window is exhausted and the escalation attempt succeeds", async () => {
  const mock = installMockFetch(4);
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "chat-progress-settle-test-4",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );

    assert.strictEqual(
      res.status,
      200,
      "request must survive an exhausted settle window",
    );
    const text = await res.text();
    assert.ok(text.includes("settled"), "escalation attempt should stream normally");
    assert.ok(text.includes("data: [DONE]"), "stream must terminate");

    // 5 completion calls: 4 chat_in_progress failures (3 same-chat retries +
    // the 4th triggers the escalation) and the escalation attempt itself
    // succeeds — it gets its own budget instead of dying with the exhausted
    // settle window.
    assert.strictEqual(
      mock.completionCalls(),
      5,
      "expected 4 chat_in_progress failures + 1 escalation success",
    );
  } finally {
    mock.restore();
  }
});
