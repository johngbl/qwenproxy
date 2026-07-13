import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  translateAnthropicToOpenAI,
  translateOpenAIToAnthropic,
  mapAnthropicModel,
  translateStreamChunk,
} from "../routes/anthropic/translate.ts";
import { validateAnthropicRequest } from "../routes/anthropic/validation.ts";

test("Anthropic: mapAnthropicModel maps correctly", () => {
  // Qwen models pass through
  assert.equal(mapAnthropicModel("qwen3.7-plus"), "qwen3.7-plus");
  assert.equal(mapAnthropicModel("qwen3.7-max"), "qwen3.7-max");
  assert.equal(mapAnthropicModel("qwen3.5-flash"), "qwen3.5-flash");

  // Claude models map to Qwen
  assert.equal(mapAnthropicModel("claude-sonnet-4-6"), "qwen3.7-plus");
  assert.equal(mapAnthropicModel("claude-opus-4-6"), "qwen3.7-max");
  assert.equal(mapAnthropicModel("claude-haiku-4-5"), "qwen3.5-flash");
  assert.equal(mapAnthropicModel("claude-haiku-4-5-20251001"), "qwen3.5-flash");
  assert.equal(mapAnthropicModel("claude-3-5-sonnet"), "qwen3.7-plus");

  // GPT aliases map to Qwen
  assert.equal(mapAnthropicModel("gpt-4"), "qwen3.6-plus");
  assert.equal(mapAnthropicModel("gpt-5-mini"), "qwen3.5-flash");
  // Unknown models pass through
  assert.equal(mapAnthropicModel("custom-model"), "custom-model");
});

test("Anthropic: translateAnthropicToOpenAI converts messages", () => {
  const anthropicReq = {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: "You are helpful",
    messages: [{ role: "user" as const, content: "Hello" }],
  };

  const result = translateAnthropicToOpenAI(anthropicReq);

  // Claude model maps to Qwen
  assert.equal(result.model, "qwen3.7-plus");
  assert.equal(result.max_tokens, 1024);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages[0].content, "You are helpful");
  assert.equal(result.messages[1].role, "user");
  assert.equal(result.messages[1].content, "Hello");
});

test("Anthropic: translateAnthropicToOpenAI converts tools", () => {
  const anthropicReq = {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user" as const, content: "Hello" }],
    tools: [
      {
        name: "get_weather",
        description: "Get weather info",
        input_schema: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      },
    ],
  };

  const result = translateAnthropicToOpenAI(anthropicReq);

  assert.equal(result.tools?.length, 1);
  assert.equal(result.tools?.[0].type, "function");
  assert.equal(result.tools?.[0].function.name, "get_weather");
});

test("Anthropic: translateOpenAIToAnthropic converts response", () => {
  const openaiResponse = {
    id: "chatcmpl-123",
    object: "chat.completion" as const,
    created: Date.now(),
    model: "qwen3.7-plus",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: "Hello! How can I help?",
        },
        finish_reason: "stop" as const,
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    },
  };

  const result = translateOpenAIToAnthropic(
    openaiResponse,
    "claude-sonnet-4-6",
  );

  assert.equal(result.type, "message");
  assert.equal(result.role, "assistant");
  assert.equal(result.model, "claude-sonnet-4-6");
  assert.equal(result.stop_reason, "end_turn");
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[0].text, "Hello! How can I help?");
  assert.equal(result.usage.input_tokens, 100);
  assert.equal(result.usage.output_tokens, 50);
});

test("Anthropic: translateOpenAIToAnthropic converts tool calls", () => {
  const openaiResponse = {
    id: "chatcmpl-123",
    object: "chat.completion" as const,
    created: Date.now(),
    model: "qwen3.7-plus",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function" as const,
              function: {
                name: "get_weather",
                arguments: '{"location":"NYC"}',
              },
            },
          ],
        },
        finish_reason: "tool_calls" as const,
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    },
  };

  const result = translateOpenAIToAnthropic(
    openaiResponse,
    "claude-sonnet-4-6",
  );

  assert.equal(result.stop_reason, "tool_use");
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "tool_use");
  assert.equal(result.content[0].name, "get_weather");
  assert.deepEqual(result.content[0].input, { location: "NYC" });
});

test("Anthropic: validateAnthropicRequest accepts valid request", () => {
  const validReq = {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
  };

  const result = validateAnthropicRequest(validReq);
  assert.equal(result.valid, true);
});

test("Anthropic: validateAnthropicRequest rejects missing model", () => {
  const invalidReq = {
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
  };

  const result = validateAnthropicRequest(invalidReq);
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes("model"));
});

test("Anthropic: validateAnthropicRequest rejects missing max_tokens", () => {
  const invalidReq = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "Hello" }],
  };

  const result = validateAnthropicRequest(invalidReq);
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes("max_tokens"));
});

test("Anthropic: validateAnthropicRequest rejects empty messages", () => {
  const invalidReq = {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [],
  };

  const result = validateAnthropicRequest(invalidReq);
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes("empty"));
});

test("Anthropic: validateAnthropicRequest validates tool_choice", () => {
  const invalidReq = {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
    tool_choice: { type: "invalid" },
  };

  const result = validateAnthropicRequest(invalidReq);
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes("tool_choice.type"));
});

test("Anthropic: translateStreamChunk emits message_delta with top-level usage", () => {
  const state = {
    contentBlockIndex: 0,
    currentBlockType: null as string | null,
    requestModel: "claude-sonnet-4-6",
    inputTokens: 0,
  };

  const events = translateStreamChunk(
    {
      choices: [
        {
          delta: {},
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 123,
        completion_tokens: 456,
        total_tokens: 579,
      },
    },
    state,
  );

  const parsed = events.map((event) => JSON.parse(event));
  const messageDelta = parsed.find((event) => event.type === "message_delta");

  assert.ok(messageDelta, "expected message_delta event");
  assert.equal(messageDelta.delta.stop_reason, "end_turn");
  assert.equal(messageDelta.usage.input_tokens, 123);
  assert.equal(messageDelta.usage.output_tokens, 456);
});

test("Anthropic: translateStreamChunk falls back to zero usage when missing", () => {
  const state = {
    contentBlockIndex: 0,
    currentBlockType: null as string | null,
    requestModel: "claude-sonnet-4-6",
    inputTokens: 0,
  };

  const events = translateStreamChunk(
    {
      choices: [
        {
          delta: {},
          finish_reason: "stop",
        },
      ],
    },
    state,
  );

  const parsed = events.map((event) => JSON.parse(event));
  const messageDelta = parsed.find((event) => event.type === "message_delta");

  assert.ok(messageDelta, "expected message_delta event");
  assert.equal(messageDelta.usage.input_tokens, 0);
  assert.equal(messageDelta.usage.output_tokens, 0);
});
