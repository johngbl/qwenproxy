import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  translateAnthropicToOpenAI,
  translateOpenAIToAnthropic,
  mapAnthropicModel,
  translateStreamChunk,
  type AnthropicStreamState,
} from "../routes/anthropic/translate.ts";
import { validateAnthropicRequest } from "../routes/anthropic/validation.ts";
import type { AnthropicRequest } from "../routes/anthropic/types.ts";

test("Anthropic: mapAnthropicModel maps Claude and Qwen models accurately", () => {
  // Direct Qwen models pass through
  assert.equal(mapAnthropicModel("qwen3.8-max"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("qwen3.7-plus"), "qwen3.7-plus");
  assert.equal(mapAnthropicModel("qwen3.7-max"), "qwen3.7-max");

  // Claude 3.7 Sonnet
  assert.equal(mapAnthropicModel("claude-3-7-sonnet-20250219"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("claude-3-7-sonnet"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("claude-3-7-sonnet-latest"), "qwen3.8-max");

  // Claude 3.5 Sonnet
  assert.equal(mapAnthropicModel("claude-3-5-sonnet-20241022"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("claude-3-5-sonnet"), "qwen3.8-max");

  // Claude 3.5 Haiku
  assert.equal(mapAnthropicModel("claude-3-5-haiku-20241022"), "qwen3.7-plus");
  assert.equal(mapAnthropicModel("claude-3-5-haiku"), "qwen3.7-plus");

  // Claude 3 Opus & Sonnet & Haiku
  assert.equal(mapAnthropicModel("claude-3-opus-20240229"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("claude-3-sonnet-20240229"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("claude-3-haiku-20240307"), "qwen3.7-plus");
  // Suffix preservation (-fast and -thinking)
  assert.equal(mapAnthropicModel("claude-3-7-sonnet-fast"), "qwen3.8-max-fast");
  assert.equal(mapAnthropicModel("claude-3-7-sonnet-thinking"), "qwen3.8-max-thinking");

  // Shorthands
  assert.equal(mapAnthropicModel("sonnet"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("opus"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("haiku"), "qwen3.7-plus");
  // Future versions automatic compatibility (any version / date / format)
  assert.equal(mapAnthropicModel("claude-3-8-sonnet"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("claude-4-sonnet"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("claude-4-opus-20261010"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("claude-4-haiku"), "qwen3.7-plus");
  assert.equal(mapAnthropicModel("claude-5-sonnet-2027"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("claude-future-haiku"), "qwen3.7-plus");
  assert.equal(mapAnthropicModel("claude-next-gen"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("claude-4-sonnet-fast"), "qwen3.8-max-fast");
  assert.equal(mapAnthropicModel("claude-5-sonnet-thinking"), "qwen3.8-max-thinking");
});
test("Anthropic: validateAnthropicRequest validates required fields", () => {
  // Valid request
  const valid = validateAnthropicRequest({
    model: "claude-3-7-sonnet-20250219",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
  });
  assert.equal(valid.valid, true);

  // Missing model
  assert.equal(
    validateAnthropicRequest({
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    }).valid,
    false,
  );

  // Missing max_tokens
  assert.equal(
    validateAnthropicRequest({
      model: "claude-3-7-sonnet",
      messages: [{ role: "user", content: "Hello" }],
    }).valid,
    false,
  );

  // Negative or zero max_tokens
  assert.equal(
    validateAnthropicRequest({
      model: "claude-3-7-sonnet",
      max_tokens: 0,
      messages: [{ role: "user", content: "Hello" }],
    }).valid,
    false,
  );

  // Empty messages
  assert.equal(
    validateAnthropicRequest({
      model: "claude-3-7-sonnet",
      max_tokens: 1024,
      messages: [],
    }).valid,
    false,
  );

  // Invalid tool_choice
  assert.equal(
    validateAnthropicRequest({
      model: "claude-3-7-sonnet",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      tool_choice: { type: "unknown_choice" },
    }).valid,
    false,
  );
});

test("Anthropic: translateAnthropicToOpenAI converts system prompt and messages", () => {
  const req: AnthropicRequest = {
    model: "claude-3-7-sonnet-20250219",
    max_tokens: 2048,
    system: "You are an expert software engineer.",
    messages: [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "It is 4." },
      { role: "user", content: "Thanks!" },
    ],
  };

  const converted = translateAnthropicToOpenAI(req);

  assert.equal(converted.model, "qwen3.8-max");
  assert.equal(converted.max_tokens, 2048);
  assert.equal(converted.messages.length, 4);
  assert.deepEqual(converted.messages[0], {
    role: "system",
    content: "You are an expert software engineer.",
  });
  assert.deepEqual(converted.messages[1], {
    role: "user",
    content: "What is 2+2?",
  });
  assert.deepEqual(converted.messages[2], {
    role: "assistant",
    content: "It is 4.",
  });
  assert.deepEqual(converted.messages[3], {
    role: "user",
    content: "Thanks!",
  });
});

test("Anthropic: translateAnthropicToOpenAI supports system prompt array", () => {
  const req: AnthropicRequest = {
    model: "claude-3-5-sonnet",
    max_tokens: 1000,
    system: [
      { type: "text", text: "Instruction Part 1." },
      { type: "text", text: "Instruction Part 2." },
    ],
    messages: [{ role: "user", content: "Hi" }],
  };

  const converted = translateAnthropicToOpenAI(req);
  assert.equal(converted.messages[0].role, "system");
  assert.equal(
    converted.messages[0].content,
    "Instruction Part 1.\nInstruction Part 2.",
  );
});

test("Anthropic: translateAnthropicToOpenAI converts tool definitions and tool_choice", () => {
  const req: AnthropicRequest = {
    model: "claude-3-7-sonnet-20250219",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Run bash command" }],
    tools: [
      {
        name: "Bash",
        description: "Run a shell command",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "Bash" },
    thinking: { type: "enabled", budget_tokens: 1024 },
  };

  const converted = translateAnthropicToOpenAI(req);

  assert.equal(converted.tools?.length, 1);
  assert.equal(converted.tools![0].type, "function");
  assert.equal(converted.tools![0].function.name, "Bash");
  assert.equal(converted.tools![0].function.description, "Run a shell command");
  assert.deepEqual(converted.tools![0].function.parameters, {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  });

  assert.deepEqual(converted.tool_choice, {
    type: "function",
    function: { name: "Bash" },
  });
  assert.equal(converted.reasoning_effort, "high");
});

test("Anthropic: translateAnthropicToOpenAI converts tool_use and tool_result for Claude Code", () => {
  const req: AnthropicRequest = {
    model: "claude-3-7-sonnet",
    max_tokens: 4096,
    messages: [
      { role: "user", content: "Check git status" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will check git status now." },
          {
            type: "tool_use",
            id: "toolu_01ABC",
            name: "Bash",
            input: { command: "git status" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01ABC",
            content: "On branch main\nworking tree clean",
            is_error: false,
          },
          {
            type: "text",
            text: "Now what?",
          },
        ],
      },
    ],
  };

  const converted = translateAnthropicToOpenAI(req);

  // Message 0: user "Check git status"
  assert.equal(converted.messages[0].role, "user");
  assert.equal(converted.messages[0].content, "Check git status");

  // Message 1: assistant with tool_calls
  assert.equal(converted.messages[1].role, "assistant");
  assert.equal(converted.messages[1].content, "I will check git status now.");
  assert.equal(converted.messages[1].tool_calls?.length, 1);
  assert.equal(converted.messages[1].tool_calls![0].id, "toolu_01ABC");
  assert.equal(converted.messages[1].tool_calls![0].function.name, "Bash");
  assert.equal(
    converted.messages[1].tool_calls![0].function.arguments,
    '{"command":"git status"}',
  );

  // Message 2: tool result
  assert.equal(converted.messages[2].role, "tool");
  assert.equal(converted.messages[2].tool_call_id, "toolu_01ABC");
  assert.equal(
    converted.messages[2].content,
    "On branch main\nworking tree clean",
  );

  // Message 3: subsequent user text from the same turn
  assert.equal(converted.messages[3].role, "user");
  assert.equal(converted.messages[3].content, "Now what?");
});

test("Anthropic: translateAnthropicToOpenAI handles tool_result with is_error", () => {
  const req: AnthropicRequest = {
    model: "claude-3-7-sonnet",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_err_1",
            content: "Command failed: exit code 1",
            is_error: true,
          },
        ],
      },
    ],
  };

  const converted = translateAnthropicToOpenAI(req);
  assert.equal(converted.messages[0].role, "tool");
  assert.equal(
    converted.messages[0].content,
    "[Tool Error] Command failed: exit code 1",
  );
});

test("Anthropic: translateOpenAIToAnthropic converts assistant message with tool calls", () => {
  const openaiRes = {
    id: "chatcmpl-test-1",
    object: "chat.completion" as const,
    created: Date.now(),
    model: "qwen3.8-max",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: "Let me list files",
          tool_calls: [
            {
              id: "call_abc123",
              type: "function" as const,
              function: {
                name: "Glob",
                arguments: '{"pattern":"*.ts"}',
              },
            },
          ],
        },
        finish_reason: "tool_calls" as const,
      },
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 45,
      total_tokens: 165,
    },
  };

  const res = translateOpenAIToAnthropic(openaiRes, "claude-3-7-sonnet-20250219");

  assert.equal(res.type, "message");
  assert.equal(res.role, "assistant");
  assert.equal(res.model, "claude-3-7-sonnet-20250219");
  assert.equal(res.stop_reason, "tool_use");
  assert.equal(res.content.length, 2);

  assert.equal(res.content[0].type, "text");
  assert.equal(res.content[0].text, "Let me list files");

  assert.equal(res.content[1].type, "tool_use");
  assert.equal(res.content[1].id, "call_abc123");
  assert.equal(res.content[1].name, "Glob");
  assert.deepEqual(res.content[1].input, { pattern: "*.ts" });

  assert.equal(res.usage.input_tokens, 120);
  assert.equal(res.usage.output_tokens, 45);
});

test("Anthropic: translateOpenAIToAnthropic includes thinking block when present", () => {
  const openaiRes = {
    id: "chatcmpl-test-think",
    object: "chat.completion" as const,
    created: Date.now(),
    model: "qwen3.8-max",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: "The answer is 42.",
          reasoning_content: "Thinking step 1... step 2...",
        },
        finish_reason: "stop" as const,
      },
    ],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 25,
      total_tokens: 75,
    },
  };

  const res = translateOpenAIToAnthropic(openaiRes, "claude-3-7-sonnet");

  assert.equal(res.content.length, 2);
  assert.equal(res.content[0].type, "thinking");
  assert.equal(res.content[0].thinking, "Thinking step 1... step 2...");
  assert.equal(res.content[1].type, "text");
  assert.equal(res.content[1].text, "The answer is 42.");
  assert.equal(res.stop_reason, "end_turn");
});

test("Anthropic: translateOpenAIToAnthropic strips raw tool call tags from assistant text", () => {
  const openaiRes = {
    id: "chatcmpl-test-strip",
    object: "chat.completion" as const,
    created: Date.now(),
    model: "qwen3.8-max",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: "I will read the file <tool_call>{\"name\":\"Read\",\"arguments\":{\"path\":\"a.txt\"}}</tool_call>",
          tool_calls: [
            {
              id: "call_read_1",
              type: "function" as const,
              function: {
                name: "Read",
                arguments: '{"path":"a.txt"}',
              },
            },
          ],
        },
        finish_reason: "tool_calls" as const,
      },
    ],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 20,
      total_tokens: 70,
    },
  };

  const res = translateOpenAIToAnthropic(openaiRes, "claude-3-7-sonnet");
  assert.equal(res.content.length, 2);
  assert.equal(res.content[0].type, "text");
  assert.equal(res.content[0].text, "I will read the file");
  assert.equal(res.content[1].type, "tool_use");
  assert.equal(res.content[1].name, "Read");
});

test("Anthropic: translateStreamChunk handles thinking, text, and tool calls in order", () => {
  const state: AnthropicStreamState = {
    contentBlockIndex: 0,
    currentBlockType: null,
    currentToolId: null,
    currentToolIndex: null,
    requestModel: "claude-3-7-sonnet",
    inputTokens: 0,
    outputTokens: 0,
    hasEmittedToolUse: false,
  };

  // 1. Thinking delta
  const chunk1 = {
    choices: [{ delta: { reasoning_content: "Analyzing task..." } }],
  };
  const events1 = translateStreamChunk(chunk1, state).map((e) => JSON.parse(e));
  assert.equal(events1.length, 2);
  assert.equal(events1[0].type, "content_block_start");
  assert.equal(events1[0].content_block.type, "thinking");
  assert.equal(events1[1].type, "content_block_delta");
  assert.equal(events1[1].delta.type, "thinking_delta");
  assert.equal(events1[1].delta.thinking, "Analyzing task...");

  // 2. Text delta (must close thinking block, open text block at index 1)
  const chunk2 = {
    choices: [{ delta: { content: "I will check files." } }],
  };
  const events2 = translateStreamChunk(chunk2, state).map((e) => JSON.parse(e));
  assert.equal(events2.length, 3);
  assert.equal(events2[0].type, "content_block_stop");
  assert.equal(events2[0].index, 0);
  assert.equal(events2[1].type, "content_block_start");
  assert.equal(events2[1].index, 1);
  assert.equal(events2[1].content_block.type, "text");
  assert.equal(events2[2].type, "content_block_delta");
  assert.equal(events2[2].delta.type, "text_delta");
  assert.equal(events2[2].delta.text, "I will check files.");
  // 3. Tool call start (must close text block at index 1, open tool_use at index 2)
  const chunk3 = {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "toolu_abc_1",
              function: { name: "Bash", arguments: '{"command":' },
            },
          ],
        },
      },
    ],
  };
  const events3 = translateStreamChunk(chunk3, state).map((e) => JSON.parse(e));
  assert.equal(events3.length, 3);
  assert.equal(events3[0].type, "content_block_stop");
  assert.equal(events3[0].index, 1);
  assert.equal(events3[1].type, "content_block_start");
  assert.equal(events3[1].index, 2);
  assert.equal(events3[1].content_block.type, "tool_use");
  assert.equal(events3[1].content_block.name, "Bash");
  assert.equal(events3[2].type, "content_block_delta");
  assert.equal(events3[2].delta.type, "input_json_delta");
  assert.equal(events3[2].delta.partial_json, '{"command":');

  // 4. Finish reason tool_calls
  const chunk4 = {
    choices: [{ finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 80, completion_tokens: 30 },
  };
  const events4 = translateStreamChunk(chunk4, state).map((e) => JSON.parse(e));
  assert.equal(events4.length, 2);
  assert.equal(events4[0].type, "content_block_stop");
  assert.equal(events4[0].index, 2);
  assert.equal(events4[1].type, "message_delta");
  assert.equal(events4[1].delta.stop_reason, "tool_use");
  assert.equal(events4[1].usage.output_tokens, 30);
});
