/**
 * Tests for the repeated-tool-call guard.
 * Reproduces the qwenlog.txt loop: the model re-invokes read_file with the
 * same path every turn instead of using the already-returned result.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRepeatedToolCallReminder } from "../utils/tool-call-guard.ts";
import type { Message } from "../utils/types.ts";

function assistantWithCall(
  name: string,
  args: string,
  id = "call_1",
): Message {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
  };
}

function toolResult(id = "call_1"): Message {
  return { role: "tool", content: '{"ok":true}', tool_call_id: id };
}

test("guard: identical read_file call across turns triggers reminder", () => {
  const messages: Message[] = [
    { role: "user", content: "corrija o site" },
    assistantWithCall("read_file", '{"path":"C:\\\\Users\\\\John\\\\Desktop\\\\site de futebol\\\\index.html"}', "call_1"),
    toolResult("call_1"),
    assistantWithCall("read_file", '{"path":"C:\\\\Users\\\\John\\\\Desktop\\\\site de futebol\\\\index.html"}', "call_2"),
    toolResult("call_2"),
    { role: "user", content: "continue" },
    assistantWithCall("read_file", '{"path":"C:\\\\Users\\\\John\\\\Desktop\\\\site de futebol\\\\index.html"}', "call_3"),
    toolResult("call_3"),
    { role: "user", content: "continue de novo" },
  ];

  const reminder = buildRepeatedToolCallReminder(messages);

  assert.ok(reminder, "reminder should be produced for repeated calls");
  assert.match(reminder, /read_file/);
  assert.match(reminder, /3 time\(s\)/);
  assert.match(reminder, /Do NOT call it again/i);
});

test("guard: first occurrence (below threshold) is not flagged", () => {
  const messages: Message[] = [
    { role: "user", content: "leia o arquivo" },
    assistantWithCall("read_file", '{"path":"a.txt"}', "call_1"),
    toolResult("call_1"),
    { role: "user", content: "continue" },
  ];

  assert.strictEqual(
    buildRepeatedToolCallReminder(messages),
    null,
    "single execution must not trigger the reminder",
  );
});

test("guard: same tool with different arguments is not a repeat", () => {
  const messages: Message[] = [
    { role: "user", content: "leia a.txt e b.txt" },
    assistantWithCall("read_file", '{"path":"a.txt"}', "call_1"),
    toolResult("call_1"),
    assistantWithCall("read_file", '{"path":"b.txt"}', "call_2"),
    toolResult("call_2"),
    { role: "user", content: "continue" },
  ];

  assert.strictEqual(buildRepeatedToolCallReminder(messages), null);
});

test("guard: JSON whitespace and key order are normalized", () => {
  const messages: Message[] = [
    { role: "user", content: "leia" },
    assistantWithCall("read_file", '{"path":"x.txt","start_line":1}', "call_1"),
    toolResult("call_1"),
    assistantWithCall("read_file", '{\n  "start_line": 1,\n  "path": "x.txt"\n}', "call_2"),
    toolResult("call_2"),
    { role: "user", content: "continue" },
  ];

  const reminder = buildRepeatedToolCallReminder(messages);
  assert.ok(reminder, "semantically identical args must be treated as a repeat");
  assert.match(reminder, /2 time\(s\)/);
});

test("guard: custom threshold is honored", () => {
  const messages: Message[] = [
    { role: "user", content: "leia" },
    assistantWithCall("read_file", '{"path":"x.txt"}', "call_1"),
    toolResult("call_1"),
    assistantWithCall("read_file", '{"path":"x.txt"}', "call_2"),
    toolResult("call_2"),
    { role: "user", content: "continue" },
  ];

  assert.strictEqual(buildRepeatedToolCallReminder(messages, 3), null);
  assert.ok(buildRepeatedToolCallReminder(messages, 2));
});

test("guard: unparseable arguments still detect exact string repeats", () => {
  const messages: Message[] = [
    { role: "user", content: "execute" },
    assistantWithCall("run", '{broken json', "call_1"),
    toolResult("call_1"),
    assistantWithCall("run", '{broken json', "call_2"),
    toolResult("call_2"),
    { role: "user", content: "continue" },
  ];

  assert.ok(buildRepeatedToolCallReminder(messages));
});

test("guard: empty or tool-less history returns null", () => {
  assert.strictEqual(buildRepeatedToolCallReminder([]), null);
  assert.strictEqual(buildRepeatedToolCallReminder(null), null);
  assert.strictEqual(
    buildRepeatedToolCallReminder([{ role: "user", content: "oi" }]),
    null,
  );
});
