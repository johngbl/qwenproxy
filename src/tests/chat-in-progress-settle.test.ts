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
 * Seed two accounts so a hypothetical chat_in_progress escalation could switch
 * accounts (the old escalation bugs only manifested when the escalation moved
 * to a fresh account). The new settle design never escalates, so these seeded
 * accounts assert the NEGATIVE: even with an alternate account available, the
 * request stays on the original one. Snapshots and restores the accounts table
 * in a finally so sibling tests keep their single-account world.
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

    // account-priority.ts persists to the REAL data/ dir (not data-test); a
    // successful attempt calls markAccountSuccessful on a seeded account,
    // polluting the production priority file. Snapshot and restore it.
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
      // CI where the DB is empty, breaking the sibling tests).
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
 * stays "in progress" for a few seconds. The attempt loop must retry the SAME
 * chat with jittered busyMs-based waits (up to CHAT_IN_PROGRESS_MAX_RETRIES)
 * — and never escalate to a new chat with a full-context replay.
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

test("jitterChatInProgressDelay: stays inside the +/-25% window and grows from the 4th retry", async () => {
  const { jitterChatInProgressDelay } = await import("../routes/chat/account.ts");
  const mid = () => 0.5; // midpoint → exactly the base
  assert.strictEqual(jitterChatInProgressDelay(2, 4000, mid), 4000);
  assert.strictEqual(jitterChatInProgressDelay(3, 4000, mid), 4000);
  // From the 4th retry the base doubles (2× busyMs) so a slow settle keeps
  // getting absorbed without clamping the ladder to the shortest wait.
  assert.strictEqual(jitterChatInProgressDelay(4, 4000, mid), 8000);
  assert.strictEqual(jitterChatInProgressDelay(6, 4000, mid), 8000);
});

test("jitterChatInProgressDelay: bounded for cold rand and capped at 20s", async () => {
  const { jitterChatInProgressDelay } = await import("../routes/chat/account.ts");
  assert.strictEqual(jitterChatInProgressDelay(2, 4000, () => 0), 3000); // 0.75x
  assert.strictEqual(jitterChatInProgressDelay(2, 4000, () => 1), 5000); // 1.25x
  assert.strictEqual(jitterChatInProgressDelay(4, 4000, () => 1), 10000); // 2x * 1.25
  assert.strictEqual(jitterChatInProgressDelay(6, 60000, () => 1), 20000); // capped
});

test("chat_in_progress twice then success: same-chat retries before any escalation", async () => {
  const mock = installMockFetch();
  clearTemporaryBusy("mock-account");
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
  clearTemporaryBusy("mock-account");
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
    // observed after huge turns) + 1 success. The settle window has its own
    // budget inside tryCreateStreamWithRetry (independent of the global
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

test("chat_in_progress four times with an alternate account available: NO escalation, NO switch, success on the same account", withEscalationAccounts(async () => {
  const mock = installMockFetch(4);
  const capture = captureWarns();
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "chat-progress-no-escalation",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );

    assert.strictEqual(res.status, 200, "request must survive the settle window");
    const text = await res.text();
    assert.ok(text.includes("settled"), "final attempt should stream normally");

    assert.strictEqual(
      mock.completionCalls(),
      5,
      "expected 4 chat_in_progress failures + 1 success",
    );

    // The OLD design escalated on the 4th failure: it switched to a seeded
    // alt account (or forced a new chat) and re-sent the full context. The
    // new design never escalates — even with a free alternate account the
    // request stays on the original account with the delta intact.
    assert.ok(
      !capture.warns.some((w) => w.includes("chat_in_progress escalation")),
      "escalation must not fire, got: " +
        capture.warns.filter((w) => w.includes("chat_in_progress")).join("\n"),
    );
    assert.ok(
      !capture.warns.some((w) => w.includes("Switching account after")),
      "no account switch may happen for chat_in_progress",
    );
  } finally {
    capture.restore();
    mock.restore();
  }
}));

test("chat_in_progress budget exhaustion keeps the thread binding: no session clear, no replay, request fails", async () => {
  // CHAT_IN_PROGRESS_MAX_RETRIES default 6: the 7th consecutive failure
  // exhausts the same-chat budget. The OLD design cleared the origin account's
  // sessions on exhaustion (escalation-era semantics); the new design KEEPS
  // the binding so the client's own retry lands on the settled chat with its
  // delta — clearing would force a wasteful full-context replay.
  const mock = installMockFetch(7);
  const capture = captureWarns();
  clearTemporaryBusy("mock-account");
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "chat-progress-budget-keep-binding",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );
    await res.text();

    assert.ok(
      res.status >= 400,
      "budget exhaustion must fail the request, got " + res.status,
    );
    assert.strictEqual(
      mock.completionCalls(),
      7,
      "exactly the settle budget — no 8th escalation call",
    );
    assert.ok(
      !capture.warns.some((w) => w.includes("Clearing session state for")),
      "chat_in_progress exhaustion must keep the thread binding",
    );
    assert.ok(
      !capture.warns.some((w) => w.includes("chat_in_progress escalation")),
      "escalation must not exist",
    );
  } finally {
    capture.restore();
    mock.restore();
  }
});

test("chat_in_progress four times then success: the extended jittered settle window absorbs it", async () => {
  const mock = installMockFetch(4);
  const capture = captureWarns();
  clearTemporaryBusy("mock-account");
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
    assert.ok(text.includes("settled"), "final attempt should stream normally");
    assert.ok(text.includes("data: [DONE]"), "stream must terminate");

    // 5 completion calls: 4 chat_in_progress failures absorbed by the
    // same-chat jittered settle budget + the 5th success. The 4th failure no
    // longer triggers an escalation (the old design rebuilt a new chat with
    // the full context at exactly this point).
    assert.strictEqual(
      mock.completionCalls(),
      5,
      "expected 4 chat_in_progress failures + 1 success",
    );
    assert.ok(
      !capture.warns.some((w) => w.includes("chat_in_progress escalation")),
      "the 4th failure must not escalate",
    );
  } finally {
    capture.restore();
    mock.restore();
  }
});