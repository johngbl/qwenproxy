/**
 * Personalization-required contract (2026-08-17 round).
 *
 * Agent instructions and tools ride ONLY the account-level personalization:
 *  1. buildFinalContext never puts instructions in the prompt (not even on a
 *     brand-new chat) and fails loud when the personalization channel cannot
 *     carry them (disabled by config / payload over the byte limit).
 *  2. An unconfirmed personalization sync fails the acquire attempt with a
 *     retryable PersonalizationSyncError (rotates accounts) instead of
 *     degrading to inline instructions.
 *
 * The e2e forces the sync failure via the TEST_PERSONALIZATION_SYNC_FAIL hook
 * in qwen.ts's mock-mode short-circuit (the real browser path is unreachable
 * in the mock suite).
 */
import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.js";

const { config } = await import("../core/config.ts");
const { buildFinalContext } = await import("../routes/chat/context.ts");
const { classifyRetryAction } = await import("../routes/chat/retry-policy.ts");
const { PersonalizationSyncError } = await import("../services/qwen.ts");
const { ValidationError } = await import("../core/errors.ts");

// ---------------------------------------------------------------------------
// context.ts — the instruction channel is personalization-only
// ---------------------------------------------------------------------------

test("new chat: instructions ride only the personalization, never the prompt", async () => {
  const ctx = await buildFinalContext({
    messages: [{ role: "user", content: "hello" }],
    systemPrompt: "SYSTEM RULES",
    toolInstructions: "TOOLS BLOCK",
    prompt: "User: hello\n\n",
    currentPrompt: "User: hello\n\n",
    modelId: "qwen3.7-plus",
    enableThinking: false,
    conversationKey: null,
    hasExplicitConversationKey: false,
  });

  assert.match(ctx.requestPersonalizationInstruction ?? "", /SYSTEM RULES/);
  assert.match(ctx.requestPersonalizationInstruction ?? "", /TOOLS BLOCK/);
  // Not even on a brand-new chat: the sync is confirmed BEFORE the completion
  // request is sent, so the prompt carries only the conversation.
  assert.ok(!ctx.finalPrompt.includes("SYSTEM RULES"));
  assert.ok(!ctx.finalPrompt.includes("TOOLS BLOCK"));
  assert.ok(ctx.finalPrompt.includes("hello"));
});

test("personalization disabled: instruction-bearing request fails loud", async () => {
  const original = config.qwen.personalizationFromRequest;
  config.qwen.personalizationFromRequest = false;
  try {
    await assert.rejects(
      buildFinalContext({
        messages: [{ role: "user", content: "hello" }],
        systemPrompt: "SYSTEM RULES",
        toolInstructions: "",
        prompt: "User: hello\n\n",
        currentPrompt: "User: hello\n\n",
        modelId: "qwen3.7-plus",
        enableThinking: false,
        conversationKey: null,
        hasExplicitConversationKey: false,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /QWEN_PERSONALIZATION_FROM_REQUEST/);
        return true;
      },
    );
  } finally {
    config.qwen.personalizationFromRequest = original;
  }
});

test("personalization disabled: instruction-less request still works", async () => {
  const original = config.qwen.personalizationFromRequest;
  config.qwen.personalizationFromRequest = false;
  try {
    const ctx = await buildFinalContext({
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "",
      toolInstructions: "",
      prompt: "User: hello\n\n",
      currentPrompt: "User: hello\n\n",
      modelId: "qwen3.7-plus",
      enableThinking: false,
      conversationKey: null,
      hasExplicitConversationKey: false,
    });
    assert.strictEqual(ctx.requestPersonalizationInstruction, null);
    assert.ok(ctx.finalPrompt.includes("hello"));
  } finally {
    config.qwen.personalizationFromRequest = original;
  }
});

test("title generation: keeps its instructions inline (no personalization channel)", async () => {
  const ctx = await buildFinalContext({
    messages: [
      { role: "user", content: "first question" },
      { role: "user", content: "Please generate a title for this conversation" },
    ],
    systemPrompt: "TITLE RULES",
    toolInstructions: "",
    prompt: "User: first question",
    currentPrompt: "User: Please generate a title",
    modelId: "qwen3.7-plus",
    enableThinking: false,
    conversationKey: "key-1",
    hasExplicitConversationKey: true,
  });

  assert.strictEqual(ctx.isTitleGenerationRequest, true);
  assert.strictEqual(ctx.requestPersonalizationInstruction, null);
  assert.ok(ctx.finalPrompt.includes("TITLE RULES"));
});

// ---------------------------------------------------------------------------
// retry-policy — unconfirmed sync rotates accounts
// ---------------------------------------------------------------------------

test("retry policy: unconfirmed personalization rotates accounts", () => {
  const policy = classifyRetryAction(
    new PersonalizationSyncError(
      "personalization sync not confirmed for mock: sync timed out after 30000ms",
    ),
  );
  assert.strictEqual(policy.retryable, true);
  assert.strictEqual(policy.switchAccount, true);
  assert.strictEqual(policy.forceNewChat, true);
  assert.strictEqual(policy.retryWithFullPrompt, false);
  assert.strictEqual(policy.reason, "personalization_sync_failed");
});

// ---------------------------------------------------------------------------
// e2e — the request fails instead of degrading to inline
// ---------------------------------------------------------------------------

test("e2e: unconfirmed personalization fails the request (no inline fallback, no completion sent)", async () => {
  // Force every personalization sync to report "not applied" (mock-mode hook
  // in qwen.ts). With a non-empty system instruction the request MUST fail
  // with 503 personalization_unavailable instead of sending the instructions
  // inline, and it must never reach the upstream completions endpoint.
  process.env.TEST_PERSONALIZATION_SYNC_FAIL = "true";

  const originalFetch = globalThis.fetch;
  let completionCalls = 0;
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
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
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices": [{"delta": {"phase": "answer", "content": "ok"}}]}\n\n',
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return originalFetch(input, init);
  };

  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "personalization-required-test",
          messages: [
            { role: "system", content: "Agent instructions: be brief." },
            { role: "user", content: "hi" },
          ],
          stream: true,
        }),
      }),
    );

    assert.strictEqual(
      res.status,
      503,
      "unconfirmed personalization must fail the request",
    );
    const text = await res.text();
    assert.ok(
      text.includes("personalization"),
      `error must name the personalization failure, got: ${text.substring(0, 200)}`,
    );
    assert.strictEqual(
      completionCalls,
      0,
      "no completion may be sent without confirmed personalization",
    );
  } finally {
    delete process.env.TEST_PERSONALIZATION_SYNC_FAIL;
    globalThis.fetch = originalFetch;
  }
});
