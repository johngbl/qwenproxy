import test from "node:test";
import assert from "node:assert";

import { StreamingToolParser } from "../tools/parser.ts";
import {
  classifyRetryAction,
  shouldRetryChatInProgressOnSameAccount,
} from "../routes/chat/retry-policy.ts";
import { buildFinalContext } from "../routes/chat/context.ts";
import { setToolCapNotice, consumeToolCapNotice } from "../services/qwen.ts";
import type { Message } from "../utils/types.ts";

/**
 * Interaction tests: these cover the COMPOSED behavior of multiple components
 * (parser + streaming decision + retry policy + thread state) that unit tests
 * cannot reach. They exist because the production bugs this project has fixed
 * almost always lived in the seams between components, not inside one.
 */

const READ_FILE_TOOLS: any[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

function callBlock(path: string): string {
  return `<tool_call>{"name": "read_file", "arguments": {"path": "${path}"}}</tool_call>`;
}

function feedChunked(parser: StreamingToolParser, text: string, chunk: number) {
  let calls = 0;
  let deltas = 0;
  for (let i = 0; i < text.length; i += chunk) {
    const r = parser.feed(text.slice(i, i + chunk));
    calls += r.toolCalls.length;
    deltas += r.toolCallDeltas.length;
  }
  const flushed = parser.flush();
  calls += flushed.toolCalls.length;
  deltas += flushed.toolCallDeltas.length;
  return { calls, deltas };
}

// ── Cap + streaming finish_reason + no spurious malformed retry ─────────────
// The streaming layer decides finish_reason via getEmittedToolCallCount() > 0
// and fires the malformed auto-retry only when emitted === 0 AND malformed > 0.
// A cap-reached turn must therefore: have emitted calls (finish_reason
// "tool_calls"), be flagged as cap reached, and carry NO malformed records
// (cap-drops are valid calls that must never trigger a retry).
test("interaction: cap-reached turn emits calls, reaches cap, and is NOT malformed", () => {
  const parser = new StreamingToolParser(READ_FILE_TOOLS, {
    maxToolCallsPerTurn: 2,
    incrementalToolCalls: true,
  });
  const full = callBlock("a") + callBlock("b") + callBlock("c") + callBlock("d");
  feedChunked(parser, full, 6);

  // finish_reason decision input
  assert.ok(
    parser.getEmittedToolCallCount() > 0,
    "streaming must pick finish_reason 'tool_calls'",
  );
  assert.ok(parser.isToolCapReached(), "cap must be flagged reached");
  // The two over-cap calls are dropped as CAPPED, never MALFORMED.
  assert.strictEqual(
    parser.getMalformedToolCalls().length,
    0,
    "cap-drops must not be malformed (no spurious [SYSTEM CORRECTION] retry)",
  );
  assert.strictEqual(parser.getCappedToolCalls().length, 2, "calls 3 and 4 capped");
});

// ── Cap + incremental delta integrity ───────────────────────────────────────
// In incremental mode the client assembles calls from deltas by index. The cap
// must not leak any delta for an over-cap call, or the client would see a
// partial tool call that is never completed.
test("interaction: incremental deltas never leak beyond the cap", () => {
  const parser = new StreamingToolParser(READ_FILE_TOOLS, {
    maxToolCallsPerTurn: 1,
    incrementalToolCalls: true,
  });
  const full = callBlock("a") + callBlock("b") + callBlock("c");

  const seenIndices = new Set<number>();
  for (let i = 0; i < full.length; i += 3) {
    const r = parser.feed(full.slice(i, i + 3));
    for (const d of r.toolCallDeltas) seenIndices.add(d.index);
  }
  parser.flush();

  assert.ok(seenIndices.size > 0, "allowed call must emit deltas");
  for (const idx of seenIndices) {
    assert.ok(idx < 1, `delta index ${idx} leaked beyond the cap`);
  }
  assert.strictEqual(parser.getCappedToolCalls().length, 2, "calls 2 and 3 capped");
  assert.strictEqual(parser.getMalformedToolCalls().length, 0);
});

// ── Cap + malformed coexistence ─────────────────────────────────────────────
// A turn can emit calls up to the cap AND still end with a genuinely malformed
// (truncated) call. The malformed auto-retry must stay dormant because calls
// were emitted (the allToolsFailed gate is malformed>0 && emitted===0).
// NOTE: the malformed call is placed LAST on purpose — a truncated call defers
// its close tag (T3) and would otherwise absorb any calls that follow it.
test("interaction: malformed + cap together do not trigger the allToolsFailed retry", () => {
  const parser = new StreamingToolParser(READ_FILE_TOOLS, {
    maxToolCallsPerTurn: 2,
    incrementalToolCalls: false,
  });
  // ok1, ok2 emitted (cap reached at ok2); ok3 capped; the trailing broken
  // (truncated) call defers its close tag and is recorded malformed at flush.
  const broken = `<tool_call>{"name": "read_file", "arguments": {"path": "x"</tool_call>`;
  const full = callBlock("ok1") + callBlock("ok2") + callBlock("ok3") + broken;
  parser.feed(full);
  parser.flush();

  const emitted = parser.getEmittedToolCallCount();
  const malformed = parser.getMalformedToolCalls().length;
  assert.strictEqual(malformed, 1, "the truncated trailing call is malformed");
  assert.ok(emitted > 0, "valid calls were emitted");
  // The streaming allToolsFailed gate: malformed>0 && emitted===0. With at
  // least one emitted call this must be false even though malformed>0.
  const allToolsFailed = malformed > 0 && emitted === 0;
  assert.strictEqual(
    allToolsFailed,
    false,
    "the allToolsFailed retry gate must stay closed when calls were emitted",
  );
  assert.ok(parser.isToolCapReached(), "cap reached via the valid calls");
});

// ── Notice + personalization active ────────────────────────────────────────
// Agent instructions ride ONLY the personalization channel; the tool-cap notice
// is a transient system notice that rides the PROMPT. Both must coexist: the
// notice prefixes the prompt, the personalization carries the instructions and
// must NOT contain the notice.
test("interaction: cap notice rides the prompt while personalization carries instructions", async () => {
  const messages: Message[] = [
    { role: "user", content: "Refatore o módulo de autenticação" },
    { role: "assistant", content: "Vou refatorar o módulo." },
    { role: "user", content: "Continue com os testes" },
  ];
  const params = {
    messages,
    systemPrompt: "Você é um assistente de engenharia de software.",
    toolInstructions: "Use as ferramentas disponíveis com cuidado.",
    prompt: "Continue com os testes",
    currentPrompt: "Continue com os testes",
    modelId: "qwen3.8-max",
    enableThinking: false,
    conversationKey: "sess_interaction_notice_personalization",
    hasExplicitConversationKey: true,
  };

  // Turn N: establish the session, drain any stale notice.
  const first = await buildFinalContext(params);
  assert.ok(first.sessionId, "thread mode derives a session id");
  consumeToolCapNotice(first.sessionId); // start clean

  // The stream layer records the cap hit; the instructions go to personalization.
  setToolCapNotice(first.sessionId);

  // Turn N+1: notice in the prompt, instructions in the personalization channel.
  const second = await buildFinalContext(params);
  assert.strictEqual(second.sessionId, first.sessionId);
  assert.ok(
    second.finalPrompt.startsWith("[SYSTEM NOTICE]"),
    "the cap notice must prefix the prompt",
  );
  assert.ok(
    second.finalPrompt.includes("Continue com os testes"),
    "the original prompt is preserved after the notice",
  );
  // Personalization carries the instructions, not the notice.
  assert.ok(second.requestPersonalizationInstruction, "personalization is active");
  assert.ok(
    second.requestPersonalizationInstruction!.includes("assistente de engenharia"),
    "personalization carries the system instructions",
  );
  assert.ok(
    !second.requestPersonalizationInstruction!.includes("[SYSTEM NOTICE]"),
    "the cap notice must NOT leak into the personalization instruction",
  );

  // Turn N+2: the notice is consumed exactly once.
  const third = await buildFinalContext(params);
  assert.ok(
    !third.finalPrompt.includes("[SYSTEM NOTICE]"),
    "the notice must not repeat",
  );
});

// ── Quota: temporary vs real drive different account behavior ───────────────
test("interaction: temporary load-shed retries same account, real quota switches", () => {
  const temporary = Object.assign(
    new Error("quota_limit: O serviço está com alta demanda no momento."),
    { upstreamCode: "quota_limit", upstreamStatus: 502 },
  );
  const tempAction = classifyRetryAction(temporary);
  assert.strictEqual(tempAction.reason, "quota_or_rate_limit");
  assert.strictEqual(tempAction.switchAccount, false, "temporary: retry same account");
  assert.strictEqual(tempAction.accountCooldownReason, "RateLimitTemporary");

  const real = Object.assign(
    new Error("RateLimited: You've reached the upper limit for today's usage."),
    { upstreamCode: "RateLimited", upstreamStatus: 429 },
  );
  const realAction = classifyRetryAction(real);
  assert.strictEqual(realAction.reason, "quota_or_rate_limit");
  assert.strictEqual(realAction.switchAccount, true, "real quota: switch account");
  assert.strictEqual(realAction.accountCooldownReason, "RateLimited");
  assert.ok(realAction.accountCooldownMs! > 0, "real quota sets a finite cooldown");
});

// ── chat_in_progress same-account retry cap (mid-stream recovery) ───────────
// The settle design (2026-08-22/23) retries the SAME chat with jittered
// busyMs-based waits up to CHAT_IN_PROGRESS_MAX_RETRIES (create path), then
// fires ONE bounded escalation (fresh chat + full replay); only if that also
// fails does the request fail with the origin binding cleared. On the MID-
// STREAM path a chat that reports in-progress mid-generation gets a few
// same-account recovery attempts and then gives up — never an account switch
// with a full-context replay.
test("interaction: chat_in_progress same-account retries are capped at 3 for mid-stream recovery", () => {
  assert.strictEqual(shouldRetryChatInProgressOnSameAccount("chat_in_progress", 0), true);
  assert.strictEqual(shouldRetryChatInProgressOnSameAccount("chat_in_progress", 1), true);
  assert.strictEqual(shouldRetryChatInProgressOnSameAccount("chat_in_progress", 2), true);
  assert.strictEqual(
    shouldRetryChatInProgressOnSameAccount("chat_in_progress", 3),
    false,
    "4th same-account recovery gives up (no escalation)",
  );
  assert.strictEqual(
    shouldRetryChatInProgressOnSameAccount("some_other_reason", 0),
    false,
    "only chat_in_progress uses the same-account budget",
  );
});
