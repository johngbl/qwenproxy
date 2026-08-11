import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.TEST_MOCK_QWEN_AUTH;

const {
  buildChatNewBody,
  isReusableUnusedChatTitle,
} = await import("../services/qwen.ts");

test("buildChatNewBody matches the captured real client payload (chatId, no title)", () => {
  const body = buildChatNewBody("qwen3.8-max") as Record<string, unknown>;
  // The real client sends chatId:"" INSTEAD of a title (verified in HAR).
  assert.equal(body.chatId, "");
  assert.ok(!("title" in body), "chats/new must not send the legacy title");
  // Everything else stays identical to the captured payload.
  assert.deepEqual(body.models, ["qwen3.8-max"]);
  assert.equal(body.chat_type, "t2t");
  assert.equal(body.chat_mode, "normal");
  assert.equal(body.project_id, "");
  assert.equal(typeof body.timestamp, "number");
});

test("isReusableUnusedChatTitle accepts both API default titles", () => {
  // "New chat" — chats created without a title (chatId:""), the current style.
  assert.equal(isReusableUnusedChatTitle("New chat"), true);
  // "Nova Conversa" — leftover chats created by the legacy style; still
  // recyclable so they do not accumulate forever.
  assert.equal(isReusableUnusedChatTitle("Nova Conversa"), true);
  // Messaged/auto-titled chats must never be recycled.
  assert.equal(isReusableUnusedChatTitle("Análise de Erros do QwenProxy"), false);
  assert.equal(isReusableUnusedChatTitle("Casual Greeting Exchange"), false);
  assert.equal(isReusableUnusedChatTitle(""), false);
  assert.equal(isReusableUnusedChatTitle(null), false);
  assert.equal(isReusableUnusedChatTitle(undefined), false);
});
