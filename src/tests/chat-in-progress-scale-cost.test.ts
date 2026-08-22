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

test("chat_in_progress budget exhaustion: 7 failures fail the request WITHOUT new chat, account switch or full replay (the ~1MB escalation is gone)", async () => {
  // CHAT_IN_PROGRESS_MAX_RETRIES default 6: retries 1-6 are the same-chat
  // settle budget; the 7th consecutive failure exhausts it. The OLD behavior
  // escalated at 4 (new chat + full replay); the new behavior fails the
  // request with the thread intact.
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
          session_id: "chat-progress-budget-exhausted",
          messages: [{ role: "user", content: bigPrompt }],
          stream: true,
        }),
      }),
    );
    // Drain the response so the underlying stream is consumed and the event
    // loop can shut down (an unread SSE stream keeps the process alive).
    await res.text();

    assert.ok(
      res.status >= 400,
      "budget exhaustion must fail the request, got " + res.status,
    );
    assert.strictEqual(
      mock.completionCalls(),
      7,
      "exactly the settle budget — no 8th \"escalation\" call",
    );
    assert.ok(
      !capture.warns.some((w) => w.includes("chat_in_progress escalation")),
      "escalation must not exist",
    );
    assert.ok(
      !capture.warns.some((w) =>
        w.includes("Retry will force a new upstream chat"),
      ),
      "no new-chat full-context replay",
    );
  } finally {
    capture.restore();
    mock.restore();
  }
});

test("tool-loop continuation: ALL chat_in_progress retries (incl. after 4 failures) send ONLY the delta — the full-history replay is gone", async () => {
  // A tool-loop client (Zed/Cline) sends a large accumulated history whose
  // prior assistant turn is represented by a tool response WITHOUT a plain
  // role:"assistant" message. The isNewSession fix makes the thread resolve
  // and send only the trailing delta; the OLD escalation rebuilt on the 5th
  // attempt and re-sent the FULL ~50KB history. That must never happen now.
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

  const mock = installMockFetch(4);
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
      5,
      "expected 4 chat_in_progress failures + 1 success",
    );

    // EVERY attempt — including the 5th that the old design escalated on —
    // carries ONLY the small trailing delta, never the ~50KB full history.
    for (let i = 0; i < 5; i++) {
      const body = mock.bodies[i].body;
      assert.ok(
        body.includes(smallDelta),
        `attempt ${i + 1} must carry the delta`,
      );
      assert.ok(
        !body.includes("BIG_HISTORY_MARKER"),
        `attempt ${i + 1} must NOT re-upload the full history (size=${mock.bodies[i].size})`,
      );
    }
  } finally {
    clearAllSessionsForAccount("mock-account");
    clearTemporaryBusy("mock-account");
    mock.restore();
  }
});