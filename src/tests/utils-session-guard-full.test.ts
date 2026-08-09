/**
 * Coverage tests for src/utils/session-id.ts (multimodal array content) and
 * src/utils/tool-call-guard.ts (canonicalization + reminder building).
 * Pure logic, no env-dependent behavior, so static imports are fine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSessionId } from "../utils/session-id.ts";
import { buildRepeatedToolCallReminder } from "../utils/tool-call-guard.ts";
import type { Message } from "../utils/types.ts";

function msg(role: string, content: unknown): Message {
  return { role, content: content as any };
}

function assistantWithCall(name: string, args: string, id: string): Message {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
  };
}

function toolResult(id: string): Message {
  return { role: "tool", content: '{"ok":true}', tool_call_id: id };
}

// ---------------------------------------------------------------------------
// session-id: array (multimodal) content branches
// ---------------------------------------------------------------------------

test("deriveSessionId: text parts in array content are joined with spaces", () => {
  const withParts = deriveSessionId(
    [msg("user", [{ type: "text", text: "hello" }, { type: "text", text: "world" }])],
    "sys",
  );
  const withString = deriveSessionId([msg("user", "hello world")], "sys");
  assert.equal(withParts, withString);
});

test("deriveSessionId: non-text parts are ignored", () => {
  const content = [
    { type: "image_url", image_url: { url: "https://example.com/i.png" } },
    { type: "text", text: "describe this" },
  ];
  const fromArray = deriveSessionId([msg("user", content)], "sys");
  const fromString = deriveSessionId([msg("user", "describe this")], "sys");
  assert.equal(fromArray, fromString);
});

test("deriveSessionId: null parts and parts without text are tolerated", () => {
  const withNull = deriveSessionId(
    [msg("user", [null, { type: "text", text: "x" }])],
    "",
  );
  const plain = deriveSessionId([msg("user", "x")], "");
  assert.equal(withNull, plain);

  // A text part without text contributes an empty string, which is dropped
  // from the anchor entirely.
  const emptyText = deriveSessionId([msg("user", [{ type: "text" }])], "sys");
  const noUser = deriveSessionId([msg("assistant", "resp")], "sys");
  assert.equal(emptyText, noUser);
});

test("deriveSessionId: non-array object content falls back to empty anchor", () => {
  const fromObject = deriveSessionId([msg("user", { weird: true })], "sys");
  const fromNull = deriveSessionId([msg("user", null)], "sys");
  assert.match(fromObject, /^sess_[a-f0-9]{16}$/);
  assert.equal(fromObject, fromNull);
});

test("deriveSessionId: different array content produces different IDs", () => {
  const a = deriveSessionId([msg("user", [{ type: "text", text: "one" }])], "");
  const b = deriveSessionId([msg("user", [{ type: "text", text: "two" }])], "");
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// tool-call-guard: reminder building and argument canonicalization
// ---------------------------------------------------------------------------

test("guard: multiple repeated calls in the last turn produce joined reminders", () => {
  const messages: Message[] = [
    assistantWithCall("read_file", '{"path":"a.txt"}', "c1"),
    toolResult("c1"),
    assistantWithCall("search", '{"q":"foo"}', "c2"),
    toolResult("c2"),
    assistantWithCall("read_file", '{"path":"a.txt"}', "c3"),
    toolResult("c3"),
    assistantWithCall("search", '{"q":"foo"}', "c4"),
    toolResult("c4"),
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c5", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
        { id: "c6", type: "function", function: { name: "search", arguments: '{"q":"foo"}' } },
      ],
    },
  ];

  const reminder = buildRepeatedToolCallReminder(messages);
  assert.ok(reminder, "expected reminders for both repeated calls");
  assert.equal((reminder as string).split("\n\n").length, 2);
  assert.match(reminder as string, /read_file.*3 time\(s\)/s);
  assert.match(reminder as string, /search.*3 time\(s\)/s);
});

test("guard: array arguments are canonicalized across key order changes", () => {
  const messages: Message[] = [
    assistantWithCall("bulk_edit", '{"items":[1,2,3],"mode":"fast"}', "c1"),
    toolResult("c1"),
    assistantWithCall("bulk_edit", '{"mode":"fast","items":[1,2,3]}', "c2"),
    toolResult("c2"),
    assistantWithCall("bulk_edit", '{"items": [1, 2, 3], "mode": "fast"}', "c3"),
  ];

  const reminder = buildRepeatedToolCallReminder(messages);
  assert.ok(reminder, "array args with reordered keys must count as repeats");
  assert.match(reminder as string, /bulk_edit/);
  assert.match(reminder as string, /3 time\(s\)/);
});

test("guard: nested objects inside arrays are canonicalized recursively", () => {
  const messages: Message[] = [
    assistantWithCall("apply_patches", '{"changes":[{"path":"a.ts","edit":"x"}]}', "c1"),
    toolResult("c1"),
    assistantWithCall("apply_patches", '{"changes": [{"edit": "x", "path": "a.ts"}]}', "c2"),
    toolResult("c2"),
  ];

  const reminder = buildRepeatedToolCallReminder(messages);
  assert.ok(reminder, "nested object key order must not hide repeats");
  assert.match(reminder as string, /2 time\(s\)/);
});

test("guard: unparseable arguments fall back to raw string comparison", () => {
  const messages: Message[] = [
    assistantWithCall("run", "{{{not json", "c1"),
    toolResult("c1"),
    assistantWithCall("run", "{{{not json", "c2"),
    toolResult("c2"),
  ];

  const reminder = buildRepeatedToolCallReminder(messages);
  assert.ok(reminder);
  assert.match(reminder as string, /run/);
});

test("guard: calls with missing function name/arguments still dedupe", () => {
  const brokenCall = (id: string): Message => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: {} as any }],
  });
  const messages: Message[] = [
    brokenCall("c1"),
    toolResult("c1"),
    brokenCall("c2"),
    toolResult("c2"),
  ];

  assert.ok(buildRepeatedToolCallReminder(messages));
});

test("guard: degenerate inputs return null", () => {
  assert.equal(buildRepeatedToolCallReminder(undefined), null);
  assert.equal(buildRepeatedToolCallReminder(null), null);
  assert.equal(buildRepeatedToolCallReminder([]), null);
  assert.equal(
    buildRepeatedToolCallReminder(
      [
        assistantWithCall("read_file", '{"path":"a.txt"}', "c1"),
        toolResult("c1"),
        assistantWithCall("read_file", '{"path":"a.txt"}', "c2"),
      ],
      1,
    ),
    null,
    "threshold < 2 must be rejected up front",
  );
});
