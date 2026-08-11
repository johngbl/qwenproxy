import test from "node:test";
import assert from "node:assert";

// Set env BEFORE the module graph loads (dynamic import pattern — see
// chat-validation-full.test.ts for the ESM hoisting rationale).
process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

const { parseRequestBody } = await import("../routes/chat/validation.ts");
const { responsesToChatCompletions } = await import(
  "../routes/responses/adapter.ts"
);

function mockContext(body: unknown): any {
  return {
    req: {
      json: async () => body,
      header: (name: string) =>
        name === "x-request-id" ? "req-rf-test" : "test-agent",
    },
  };
}

const baseMessages = [{ role: "user", content: "return json" }];

test("response_format json_object injects a JSON-only instruction", async () => {
  const parsed = await parseRequestBody(
    mockContext({
      model: "qwen3.6-plus",
      messages: baseMessages,
      response_format: { type: "json_object" },
    }),
  );

  assert.ok(
    parsed.systemPrompt.includes("[OUTPUT FORMAT]"),
    "system prompt should carry the output-format instruction",
  );
  assert.ok(
    /JSON object/i.test(parsed.systemPrompt),
    "instruction should demand a JSON object",
  );
  assert.ok(
    /code fences/.test(parsed.systemPrompt),
    "instruction should forbid markdown code fences",
  );
});

test("response_format json_schema embeds the schema + strict note", async () => {
  const schema = {
    type: "object",
    properties: { city: { type: "string" }, temp: { type: "number" } },
    required: ["city", "temp"],
  };
  const parsed = await parseRequestBody(
    mockContext({
      model: "qwen3.6-plus",
      messages: baseMessages,
      response_format: {
        type: "json_schema",
        json_schema: { name: "weather", description: "weather reply", schema, strict: true },
      },
    }),
  );

  assert.ok(parsed.systemPrompt.includes("weather"), "schema name present");
  assert.ok(
    parsed.systemPrompt.includes("weather reply"),
    "schema description present",
  );
  assert.ok(
    parsed.systemPrompt.includes(JSON.stringify(schema, null, 2)),
    "schema body present",
  );
  assert.ok(
    /strictly conform/i.test(parsed.systemPrompt),
    "strict mode should demand strict conformance",
  );
  assert.ok(
    /no extra properties/i.test(parsed.systemPrompt),
    "strict mode should forbid extra properties",
  );
});

test("no response_format leaves the system prompt untouched", async () => {
  const parsed = await parseRequestBody(
    mockContext({ model: "qwen3.6-plus", messages: baseMessages }),
  );
  assert.ok(
    !parsed.systemPrompt.includes("[OUTPUT FORMAT]"),
    "no instruction when response_format is absent",
  );
});

test("unknown response_format type is ignored safely", async () => {
  const parsed = await parseRequestBody(
    mockContext({
      model: "qwen3.6-plus",
      messages: baseMessages,
      response_format: { type: "bogus" },
    }),
  );
  assert.ok(!parsed.systemPrompt.includes("[OUTPUT FORMAT]"));
});

test("Responses text.format json_schema maps to chat response_format", () => {
  const chatReq = responsesToChatCompletions({
    model: "qwen3.6-plus",
    input: "hi",
    text: {
      format: {
        type: "json_schema",
        name: "weather",
        schema: { type: "object" },
        strict: true,
      },
    },
  } as any);

  assert.deepStrictEqual(chatReq.response_format, {
    type: "json_schema",
    json_schema: { name: "weather", schema: { type: "object" }, strict: true },
  });
});

test("Responses text.format json_object maps to chat response_format", () => {
  const chatReq = responsesToChatCompletions({
    model: "qwen3.6-plus",
    input: "hi",
    text: { format: { type: "json_object" } },
  } as any);

  assert.deepStrictEqual(chatReq.response_format, { type: "json_object" });
});

test("Responses text.format text (or absent) maps to nothing", () => {
  const withText = responsesToChatCompletions({
    model: "qwen3.6-plus",
    input: "hi",
    text: { format: { type: "text" } },
  } as any);
  assert.strictEqual(withText.response_format, undefined);

  const without = responsesToChatCompletions({
    model: "qwen3.6-plus",
    input: "hi",
  } as any);
  assert.strictEqual(without.response_format, undefined);
});
