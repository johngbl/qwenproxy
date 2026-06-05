import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_PLAYWRIGHT = "true";

delete process.env.API_KEY;

import { config } from "../core/config.ts";
import {
  deleteThreadContextSession,
  getLatestThreadContextSummary,
  getRecentThreadContextTurns,
  getThreadContextSession,
  saveThreadContextCompletion,
  upsertThreadContextSession,
} from "../services/thread-context-store.ts";
import { runThreadContextSummary } from "../services/thread-context-summarizer.ts";
import {
  finalizeThreadContextRolloverSuccess,
  markThreadContextRolloverStarted,
  prepareThreadContextRollover,
} from "../services/thread-context-rollover.ts";

const savedFetch = globalThis.fetch;
const savedDeleteOldChats = config.context.threadNative.deleteOldQwenChats;
const savedOldRetention = config.context.threadNative.oldChatRetentionHours;
const savedRolloverEnabled = config.context.threadNative.rolloverEnabled;
const savedPersistenceEnabled = config.context.threadNative.persistenceEnabled;
const savedSummarizationEnabled = config.context.summarization.enabled;

const sessionsToDelete = new Set<string>();

function uniqueSession(prefix: string): string {
  const id = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessionsToDelete.add(id);
  return id;
}

function mockSummaryResponse(summary: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: summary } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => {
  globalThis.fetch = savedFetch;
  config.context.threadNative.deleteOldQwenChats = savedDeleteOldChats;
  config.context.threadNative.oldChatRetentionHours = savedOldRetention;
  config.context.threadNative.rolloverEnabled = savedRolloverEnabled;
  config.context.threadNative.persistenceEnabled = savedPersistenceEnabled;
  config.context.summarization.enabled = savedSummarizationEnabled;

  for (const sessionId of sessionsToDelete) {
    deleteThreadContextSession(sessionId);
  }
  sessionsToDelete.clear();
});

test("thread context store saves isolated user and assistant turns", () => {
  const sessionA = uniqueSession("thread-store-a");
  const sessionB = uniqueSession("thread-store-b");

  upsertThreadContextSession({
    sessionId: sessionA,
    model: "qwen3.6-plus",
    modelContextWindow: 100_000,
    systemPrompt: "System A",
  });
  upsertThreadContextSession({
    sessionId: sessionB,
    model: "qwen3.6-plus",
    modelContextWindow: 100_000,
    systemPrompt: "System B",
  });

  saveThreadContextCompletion({
    sessionId: sessionA,
    model: "qwen3.6-plus",
    modelContextWindow: 100_000,
    accountId: "acc-a",
    chatSessionId: "chat-a",
    responseId: "resp-a",
    userPrompt: "User: Alpha task\n\n",
    finalPrompt: "System A\nUser: Alpha task\n\n",
    assistantContent: "Alpha answer",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    finishReason: "stop",
  });
  saveThreadContextCompletion({
    sessionId: sessionB,
    model: "qwen3.6-plus",
    modelContextWindow: 100_000,
    accountId: "acc-b",
    chatSessionId: "chat-b",
    responseId: "resp-b",
    userPrompt: "User: Beta task\n\n",
    finalPrompt: "System B\nUser: Beta task\n\n",
    assistantContent: "Beta answer",
    usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 },
    finishReason: "stop",
  });

  const turnsA = getRecentThreadContextTurns(sessionA, 10);
  const turnsB = getRecentThreadContextTurns(sessionB, 10);
  assert.equal(turnsA.length, 2);
  assert.equal(turnsB.length, 2);
  assert.ok(turnsA.some((turn) => turn.content.includes("Alpha")));
  assert.ok(!turnsA.some((turn) => turn.content.includes("Beta")));
  assert.ok(turnsB.some((turn) => turn.content.includes("Beta")));
});

test("thread context summarizer creates cumulative summary and updates session", async () => {
  const sessionId = uniqueSession("thread-summary");
  config.context.summarization.enabled = true;

  upsertThreadContextSession({
    sessionId,
    model: "qwen3.6-plus",
    modelContextWindow: 100_000,
    systemPrompt: "You are coding.",
  });
  saveThreadContextCompletion({
    sessionId,
    model: "qwen3.6-plus",
    modelContextWindow: 100_000,
    accountId: "acc-main",
    chatSessionId: "chat-main",
    responseId: "resp-1",
    userPrompt: "User: Implement feature X\n\n",
    finalPrompt: "You are coding.\nUser: Implement feature X\n\n",
    assistantContent: "Implemented feature X in src/example.ts",
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    finishReason: "stop",
  });

  let capturedBody: any = null;
  globalThis.fetch = (async (_input: any, init: any = {}) => {
    capturedBody = JSON.parse(init.body as string);
    return mockSummaryResponse("Cumulative summary for feature X");
  }) as typeof fetch;

  const summary = await runThreadContextSummary(sessionId);
  assert.ok(summary);
  assert.equal(summary!.summary, "Cumulative summary for feature X");
  assert.ok(capturedBody.messages[0].content.includes("continuation summary"));

  const latest = getLatestThreadContextSummary(sessionId);
  const session = getThreadContextSession(sessionId);
  assert.equal(latest?.id, summary!.id);
  assert.equal(session?.latestSummaryId, summary!.id);
  assert.ok((session?.estimatedSummaryTokens ?? 0) > 0);
});

test("thread context rollover recovers Qwen history when summary is missing at hard limit", async () => {
  const sessionId = uniqueSession("thread-recovery");
  config.context.threadNative.persistenceEnabled = true;
  config.context.threadNative.rolloverEnabled = true;

  upsertThreadContextSession({
    sessionId,
    model: "qwen3.6-plus",
    modelContextWindow: 1_000,
    accountId: "acc-recover",
    activeChatSessionId: "recover-chat",
    activeParentId: "recover-parent",
    estimatedThreadTokens: 950,
    systemPrompt: "System recovery instructions",
  });

  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/v2/chats/recover-chat")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            messages: [
              { role: "user", content: "Recovered user request", id: "u1" },
              {
                role: "assistant",
                content: "Recovered assistant answer",
                response_id: "a1",
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return mockSummaryResponse("Recovered continuation summary");
  }) as typeof fetch;

  const prepared = await prepareThreadContextRollover({
    sessionId,
    finalPrompt: "User: after recovery\n\n",
    currentPrompt: "User: after recovery\n\n",
    systemPrompt: "System recovery instructions",
    skipRollover: false,
  });

  assert.ok(prepared.rollover);
  assert.ok(prepared.finalPrompt.includes("Recovered continuation summary"));

  const turns = getRecentThreadContextTurns(sessionId, 10);
  assert.ok(
    turns.some((turn) => turn.content.includes("Recovered user request")),
  );
  assert.ok(
    turns.some((turn) => turn.content.includes("Recovered assistant answer")),
  );
});

test("thread context rollover prepares fresh prompt and deletes old chat after success", async () => {
  const sessionId = uniqueSession("thread-rollover");
  config.context.threadNative.persistenceEnabled = true;
  config.context.threadNative.rolloverEnabled = true;
  config.context.threadNative.deleteOldQwenChats = true;
  config.context.threadNative.oldChatRetentionHours = 0;

  upsertThreadContextSession({
    sessionId,
    model: "qwen3.6-plus",
    modelContextWindow: 1_000,
    accountId: "acc-old",
    activeChatSessionId: "old-chat",
    activeParentId: "old-parent",
    estimatedThreadTokens: 850,
    systemPrompt: "System instructions",
  });
  saveThreadContextCompletion({
    sessionId,
    model: "qwen3.6-plus",
    modelContextWindow: 1_000,
    accountId: "acc-old",
    chatSessionId: "old-chat",
    responseId: "old-response",
    userPrompt: "User: previous work\n\n",
    finalPrompt: "User: previous work\n\n",
    assistantContent: "Assistant previous answer",
    usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
    finishReason: "stop",
  });

  globalThis.fetch = (async (_input: any) =>
    mockSummaryResponse("Summary for rollover")) as typeof fetch;
  const summary = await runThreadContextSummary(sessionId);
  assert.ok(summary);

  const prepared = await prepareThreadContextRollover({
    sessionId,
    finalPrompt: "User: continue now\n\n",
    currentPrompt: "User: continue now\n\n",
    systemPrompt: "System instructions",
    skipRollover: false,
  });

  assert.ok(prepared.rollover);
  assert.ok(prepared.finalPrompt.includes("Summary for rollover"));
  assert.ok(prepared.finalPrompt.includes("User: continue now"));

  const plan = markThreadContextRolloverStarted({
    plan: prepared.rollover!,
    toAccountId: "acc-new",
    toChatId: "new-chat",
  });

  const deletedUrls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    deletedUrls.push(url);
    return new Response(
      JSON.stringify({ success: true, data: { status: true } }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  await finalizeThreadContextRolloverSuccess(plan);

  const session = getThreadContextSession(sessionId);
  assert.equal(session?.activeChatSessionId, "new-chat");
  assert.equal(session?.previousChatSessionId, "old-chat");
  assert.equal(session?.rolloverCount, 1);
  assert.equal(deletedUrls.length, 1);
  assert.ok(deletedUrls[0].endsWith("/api/v2/chats/old-chat"));
});
