import test from "node:test";
import assert from "node:assert";

import {
  setToolCapNotice,
  consumeToolCapNotice,
} from "../services/qwen.ts";
import { buildFinalContext } from "../routes/chat/context.ts";
import type { Message } from "../utils/types.ts";

/**
 * Option A (tool-call cap): when a turn is closed early at the per-turn
 * tool-call cap, the NEXT turn of the same session must carry a transient
 * system notice telling the model that calls beyond the cap were not executed.
 * The notice is consumed exactly once.
 */

test("tool-cap notice is consumed once per session", () => {
  const session = "sess_cap_notice_unit";
  assert.equal(consumeToolCapNotice(session), false, "no notice initially");

  setToolCapNotice(session);
  assert.equal(consumeToolCapNotice(session), true, "notice is present");
  assert.equal(consumeToolCapNotice(session), false, "notice is consumed");
});

test("tool-cap notice with empty session is ignored", () => {
  setToolCapNotice(null);
  setToolCapNotice(undefined);
  assert.equal(consumeToolCapNotice(null), false);
  assert.equal(consumeToolCapNotice(undefined), false);
});

test("buildFinalContext injects the tool-cap notice into the next turn only", async () => {
  const messages: Message[] = [
    { role: "user", content: "Please do the work" },
    { role: "assistant", content: "I did the work" },
    { role: "user", content: "Continue" },
  ];

  const params = {
    messages,
    systemPrompt: "",
    toolInstructions: "",
    prompt: "Continue",
    currentPrompt: "Continue",
    modelId: "qwen3.8-max",
    enableThinking: false,
    conversationKey: "sess_cap_context_test",
    hasExplicitConversationKey: true,
  };

  // Turn N: no cap notice yet.
  const first = await buildFinalContext(params);
  assert.ok(first.sessionId, "thread mode must derive a session id");
  assert.ok(
    !first.finalPrompt.includes("[SYSTEM NOTICE]"),
    "no notice before the cap is reached",
  );

  // The stream layer records that this turn hit the cap.
  setToolCapNotice(first.sessionId);

  // Turn N+1: the notice rides the prompt exactly once.
  const second = await buildFinalContext(params);
  assert.equal(second.sessionId, first.sessionId, "same logical session");
  assert.ok(
    second.finalPrompt.startsWith("[SYSTEM NOTICE]"),
    "the cap notice must prefix the next turn's prompt",
  );
  assert.ok(
    second.finalPrompt.includes("Continue"),
    "the original prompt must be preserved after the notice",
  );

  // Turn N+2: the notice is gone.
  const third = await buildFinalContext(params);
  assert.ok(
    !third.finalPrompt.includes("[SYSTEM NOTICE]"),
    "the notice must not repeat",
  );
});

test("temp mode never injects the tool-cap notice (no session state)", async () => {
  const messages: Message[] = [
    { role: "user", content: "Please do the work" },
    { role: "assistant", content: "I did the work" },
    { role: "user", content: "Continue" },
  ];

  const params = {
    messages,
    systemPrompt: "",
    toolInstructions: "",
    prompt: "Continue",
    currentPrompt: "Continue",
    modelId: "qwen3.8-max",
    enableThinking: false,
    conversationKey: "sess_cap_temp_test",
    hasExplicitConversationKey: true,
    chatMode: "temp" as const,
  };

  const first = await buildFinalContext(params);
  assert.equal(first.sessionId, null, "temp mode has no logical session");

  // Even if something set a notice under the conversation key, temp mode has no
  // session id to consume it.
  setToolCapNotice("sess_cap_temp_test");
  const second = await buildFinalContext(params);
  assert.ok(
    !second.finalPrompt.includes("[SYSTEM NOTICE]"),
    "temp mode must not carry cap notices",
  );
});
