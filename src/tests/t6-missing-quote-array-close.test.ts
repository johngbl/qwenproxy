import test from "node:test";
import assert from "node:assert";
import { StreamingToolParser } from "../tools/parser.ts";

const EDIT_FILE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description: "Edit a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                old_text: { type: "string" },
                new_text: { type: "string" },
              },
              required: ["old_text", "new_text"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
  },
];

// Reproduces the 2026-08-09T23:03:48 drop: the model emitted an edit_file
// whose `old_text` VALUE lost its OPENING quote AND the `edits` ARRAY lost its
// closing `]` (the `"path"` key became a sibling of the last array element).
// The Rust code inside the strings uses `\"` escapes and `\n` sequences.
const oldTextValue =
  'match line.trim() {\\n            \\"clip\\" => h.trigger(),\\n            \\"q\\" | \\"quit\\" | \\"exit\\" => break,\\n            _ => {}\\n        }\\n    }\\n    h.stop();';
const newTextValue =
  'match line.trim() {\\n            \\"clip\\" => h.trigger(),\\n            \\"q\\" | \\"quit\\" | \\"exit\\" => break,\\n            _ => {}\\n        }\\n    }\\n    // Aguarda clipes pendentes terminarem antes de derrubar a captura.\\n    let deadline = Instant::now() + Duration::from_secs(60);\\n    while h.snapshot().busy_clip && Instant::now() < deadline {\\n        std::thread::sleep(Duration::from_millis(200));\\n    }\\n    h.stop();';

// Deliberately malformed payload (matches the log): old_text value unquoted
// (missing opening quote), and no `]` after the edit object.
const malformedBody =
  '{"name":"edit_file","arguments":{"edits":[{"new_text":"' +
  newTextValue +
  '", "old_text":' +
  oldTextValue +
  '"}, "path": "ModelClip/src/main.rs"}}';

test("T6: edit_file with missing value quote + missing array close is recovered", () => {
  const parser = new StreamingToolParser(EDIT_FILE_TOOLS);
  const result = parser.feed(`<tool_call>${malformedBody}</tool_call>`);
  const flushed = parser.flush();

  const allCalls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(allCalls.length, 1, "malformed-but-repairable payload must recover");
  assert.strictEqual(allCalls[0].name, "edit_file");
  assert.strictEqual(allCalls[0].arguments.path, "ModelClip/src/main.rs");
  const edits = allCalls[0].arguments.edits as Array<{
    old_text: string;
    new_text: string;
  }>;
  assert.strictEqual(edits.length, 1);
  assert.ok(
    edits[0].old_text.includes('"clip" => h.trigger()'),
    "old_text must decode the escaped Rust quotes",
  );
  assert.ok(
    edits[0].new_text.includes("busy_clip"),
    "new_text must survive with full content",
  );
  assert.strictEqual(parser.getMalformedToolCalls().length, 0);
});

test("T6: valid payloads are never altered by the repairs", () => {
  const validBody =
    '{"name":"edit_file","arguments":{"path":"src/a.ts","edits":[{"old_text":"a","new_text":"b"}]}}';
  const parser = new StreamingToolParser(EDIT_FILE_TOOLS);
  const result = parser.feed(`<tool_call>${validBody}</tool_call>`);
  const flushed = parser.flush();

  const allCalls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(allCalls.length, 1);
  assert.strictEqual(allCalls[0].name, "edit_file");
  assert.deepStrictEqual(allCalls[0].arguments.edits, [
    { old_text: "a", new_text: "b" },
  ]);
  assert.strictEqual(allCalls[0].arguments.path, "src/a.ts");
});

test("T6: strings containing braces/quotes (Rust/code) are not mis-repaired", () => {
  const codeBody =
    '{"name":"edit_file","arguments":{"path":"f.rs","edits":[{"old_text":"fn main() {\\n    let x = \\"a\\";\\n}","new_text":"fn main() {\\n    println!(\\"hi\\");\\n}"}]}}';
  const parser = new StreamingToolParser(EDIT_FILE_TOOLS);
  const result = parser.feed(`<tool_call>${codeBody}</tool_call>`);
  const flushed = parser.flush();

  const allCalls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(allCalls.length, 1);
  assert.strictEqual(allCalls[0].name, "edit_file");
  const edits = allCalls[0].arguments.edits as Array<{ old_text: string }>;
  assert.ok(edits[0].old_text.includes('let x = "a";'), "escaped quotes must round-trip");
});
