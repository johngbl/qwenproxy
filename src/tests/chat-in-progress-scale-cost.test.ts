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

/**
 * CONFIRMS (opção A) why a large conversation feels like "40 minutes":
 * after the chat_in_progress settle window is exhausted (3 same-chat retries +
 * the 4th that triggers escalation), the ESCALATION re-sends the FULL prompt
 * (params.finalPrompt = params.fullPrompt) to a fresh upstream chat. With a
 * ~1MB conversation every escalation re-uploads the whole history — the
 * dominant cost, invisible in the existing settle tests because their prompt
 * is tiny ("hi").
 *
 * This test seeds the client with a LARGE message payload and asserts that:
 *   1. The same-chat settle attempts send only the small trailing delta.
 *   2. The ESCALATION call re-sends the FULL (large) prompt.
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

test("chat_in_progress escalation re-sends the FULL prompt (the ~1MB replay cost)", async () => {
  // A "large conversation": one long user message → the fullPrompt grows.
  const bigPrompt = "user: " + "lorem ipsum dolor sit amet. ".repeat(20000);
  const mock = installMockFetch(4);
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "chat-progress-scale-cost",
          messages: [{ role: "user", content: bigPrompt }],
          stream: true,
        }),
      }),
    );

    assert.strictEqual(res.status, 200, "request must survive the settle window");
    const text = await res.text();
    assert.ok(text.includes("settled"), "escalation attempt should stream");

    // 5 completion calls in total: 4 chat_in_progress + 1 successful escalation.
    assert.strictEqual(
      mock.completionCalls(),
      5,
      "expected 4 chat_in_progress failures + 1 escalation success",
    );

    // The FIRST same-chat attempts use the thread-native delta (small): the
    // client already threaded history, so the first upstream attempt is small.
    // But the ESCALATION (last call) re-sends the FULL prompt — it must be
    // substantially larger than the 1-MB-scale tiny "hi" settle tests, and it
    // must AT LEAST contain the bigPrompt bytes (the full replay).
    const escalationBody = mock.bodies[mock.bodies.length - 1].body;
    assert.ok(
      escalationBody.length > 1000,
      "escalation must re-send the full prompt (large), got size=" +
        escalationBody.length,
    );
    assert.ok(
      escalationBody.includes("lorem ipsum dolor sit amet"),
      "escalation body must carry the full conversation, not just a delta",
    );
  } finally {
    mock.restore();
  }
});

test("tool-loop continuation: same-chat settle sends the delta, escalation sends the full history", async () => {
  // A tool-loop client (Zed/Cline) sends a large accumulated history whose
  // prior assistant turn is represented by a tool response WITHOUT a plain
  // role:"assistant" message. Before the isNewSession fix this was treated as
  // a new chat each turn, so every same-chat settle retry re-uploaded the FULL
  // ~1MB history (the "~40 minute" cascade). The fix must make the thread
  // resolve and send only the trailing delta until the escalation rebuilds.
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
      "expected 4 chat_in_progress failures + 1 escalation success",
    );

    // The first four attempts are same-chat settle retries: they must carry
    // ONLY the small trailing delta, never the ~50KB full history.
    for (let i = 0; i < 4; i++) {
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

    // The escalation (5th attempt) rebuilds a fresh chat and re-sends the full
    // history — that is the expected, bounded cost (once, not 4-5x).
    const escalationBody = mock.bodies[4].body;
    assert.ok(
      escalationBody.includes("BIG_HISTORY_MARKER"),
      "escalation must re-send the full conversation",
    );
    assert.ok(
      escalationBody.length > mock.bodies[0].body.length,
      "escalation body must be substantially larger than the settle delta",
    );
  } finally {
    clearAllSessionsForAccount("mock-account");
    clearTemporaryBusy("mock-account");
    mock.restore();
  }
});
