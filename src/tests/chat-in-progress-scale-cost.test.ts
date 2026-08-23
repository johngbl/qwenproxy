import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.js";
import { clearTemporaryBusy } from "../core/account-concurrency.ts";
import {
  clearAllSessionsForAccount,
  updateLogicalThreadState,
} from "../services/qwen.ts";
import { deriveSessionId } from "../utils/session-id.ts";

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
 * CONFIRMS the settle design (opção A, 2026-08-22): chat_in_progress is
 * transient upstream settle lag, so the same-chat retry budget (jittered
 * busyMs-based waits, up to CHAT_IN_PROGRESS_MAX_RETRIES) NEVER re-sends the
 * full prompt. The OLD behavior escalated on the 4th failure: it reset
 * existingThread and re-sent params.fullPrompt (~1MB) to a fresh chat — the
 * dominant cost that made large tool loops feel like "~40 minutes".
 *
 * This test seeds the client with a LARGE message payload and asserts that:
 *   1. Every same-chat settle attempt sends only the small trailing delta.
 *   2. After 4 failures the 5th attempt STILL sends the delta — no escalation
 *      full-replay appears anywhere in the payloads.
 */
function installMockFetch(failures = 4) {
  const originalFetch = globalThis.fetch;
  let completionCalls = 0;
  const bodies: Array<{ url: string; body: string; size: number }> = [];

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
      const body = init?.body != null ? String(init.body) : "";
      bodies.push({ url, body, size: Buffer.byteLength(body, "utf-8") });
      if (completionCalls <= failures) {
        return new Response(
          JSON.stringify({
            error: { message: "Qwen: The chat is in progress!" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
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
    bodies,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("chat_in_progress budget exhaustion escalates ONCE with a full replay, then succeeds", async () => {
  // CHAT_IN_PROGRESS_MAX_RETRIES default 6: failures 1-6 are the same-chat
  // settle budget; the 7th failure triggers exactly ONE escalation (fresh chat
  // + full prompt) and the 8th attempt succeeds. The ~1MB replay that used to
  // happen on EVERY stuck turn is now bounded: once, and only after ~35s of
  // same-chat settle retries (observed: a 2.1MB turn held a chat busy ~9min).
  const bigPrompt = "user: " + "lorem ipsum dolor sit amet. ".repeat(20000);
  const mock = installMockFetch(7);
  const capture = captureWarns();
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "chat-progress-budget-escalate-ok",
          messages: [{ role: "user", content: bigPrompt }],
          stream: true,
        }),
      }),
    );
    await res.text();

    assert.strictEqual(res.status, 200, "the escalated attempt must succeed");
    assert.strictEqual(
      mock.completionCalls(),
      8,
      "6 settle retries + 1 escalation + 1 success",
    );
    const escalations = capture.warns.filter((w) =>
      w.includes("chat_in_progress escalation"),
    );
    assert.strictEqual(
      escalations.length,
      1,
      "exactly ONE bounded escalation, got: " + escalations.join("\n"),
    );
    assert.ok(
      !capture.warns.some((w) => w.includes("Switching account after")),
      "the escalation stays on the same account (fresh chat, no cold reopen)",
    );
  } finally {
    capture.restore();
    mock.restore();
  }
});

test("tool-loop continuation: settle retries send ONLY the delta; the single escalation replays the full history exactly once", async () => {
  // A tool-loop client (Zed/Cline) sends a large accumulated history whose
  // prior assistant turn is represented by a tool response WITHOUT a plain
  // role:"assistant" message. The isNewSession fix makes the thread resolve
  // and send only the trailing delta. Within the settle budget (failures 1-6)
  // EVERY attempt must be delta-only; after the budget the ONE escalation
  // replays the full ~50KB history exactly once — never per-retry.
  const bigHistory = "BIG_HISTORY_MARKER_" + "x".repeat(50000);
  const smallDelta = "SMALL_DELTA_MARKER";
  const messages = [
    { role: "user", content: bigHistory },
    { role: "tool", tool_call_id: "call_1", name: "shell", content: "tool result" },
    { role: "user", content: smallDelta },
  ];

  // conversationKey is null → buildFinalContext derives the implicit-thread id.
  const sessionId = deriveSessionId(messages, "", "implicit-thread");
  updateLogicalThreadState(sessionId, {
    accountId: "mock-account",
    chatSessionId: "chat-tool-loop",
    parentId: "parent-1",
    instructionsSent: true,
  });

  // The preceding test in this file leaves mock-account temporarily busy
  // (chat_in_progress settle marks it for the busy window); start clean.
  clearTemporaryBusy("mock-account");

  const mock = installMockFetch(7);
  const capture = captureWarns();
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          messages,
          stream: true,
        }),
      }),
    );
    assert.strictEqual(res.status, 200, "request must survive the settle window");
    await res.text();

    assert.strictEqual(
      mock.completionCalls(),
      8,
      "6 settle retries + 1 escalation + 1 success",
    );

    // Settle attempts 1-7 (the 7th is the failure that triggers the escalation)
    // carry ONLY the small trailing delta — never the ~50KB full history (this
    // is what killed the ~40-minute cascade: every escalation re-uploaded the
    // full conversation).
    for (let i = 0; i < 7; i++) {
      const body = mock.bodies[i].body;
      assert.ok(
        body.includes(smallDelta),
        `settle attempt ${i + 1} must carry the delta`,
      );
      assert.ok(
        !body.includes("BIG_HISTORY_MARKER"),
        `settle attempt ${i + 1} must NOT re-upload the full history (size=${mock.bodies[i].size})`,
      );
    }

    // The 8th call is the single bounded escalation: it rebuilds a fresh chat
    // and re-sends the full history — exactly once, the bounded price of a
    // genuinely-busy chat (a superseded 2.1MB generation held a chat busy
    // ~9 minutes in production).
    const escalationBodies = capture.warns.filter((w) =>
      w.includes("chat_in_progress escalation"),
    );
    assert.strictEqual(
      escalationBodies.length,
      1,
      "exactly ONE escalation",
    );
    const escalationBody = mock.bodies[7].body;
    assert.ok(
      escalationBody.includes("BIG_HISTORY_MARKER"),
      "the single escalation must re-send the full conversation",
    );
    assert.ok(
      escalationBody.length > mock.bodies[0].body.length,
      "escalation body must be substantially larger than the settle delta",
    );
  } finally {
    clearAllSessionsForAccount("mock-account");
    clearTemporaryBusy("mock-account");
    capture.restore();
    mock.restore();
  }
});