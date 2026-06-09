import crypto from "crypto";
import type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicResponseContentBlock,
  AnthropicMessage,
  AnthropicContentBlock,
  OpenAIRequest,
  OpenAIMessage,
  OpenAITool,
  OpenAIResponse,
} from "./types.ts";

/**
 * Map model names for Qwen compatibility
 * - Qwen models pass through as-is
 * - Claude models are mapped to equivalent Qwen models
 * - Unknown models pass through (Qwen will handle the error)
 */
export function mapAnthropicModel(model: string): string {
  // If it's already a Qwen model, use it directly
  if (model.startsWith("qwen")) {
    return model;
  }

  // Map Claude models to Qwen equivalents
  const claudeToQwen: Record<string, string> = {
    // Claude 4.x
    "claude-opus-4-8": "qwen3.7-max",
    "claude-opus-4-7": "qwen3.7-max",
    "claude-opus-4-6": "qwen3.7-max",
    "claude-opus-4-5": "qwen3.7-max",
    "claude-sonnet-4-6": "qwen3.7-plus",
    "claude-sonnet-4-5": "qwen3.7-plus",
    "claude-haiku-4-5": "qwen3.5-flash",
    // Claude 4.x with dates
    "claude-opus-4-8-20250918": "qwen3.7-max",
    "claude-sonnet-4-6-20250514": "qwen3.7-plus",
    "claude-haiku-4-5-20251001": "qwen3.5-flash",
    // Claude 3.5
    "claude-3-5-sonnet-20241022": "qwen3.7-plus",
    "claude-3-5-sonnet": "qwen3.7-plus",
    "claude-3-5-haiku-20241022": "qwen3.5-flash",
    "claude-3-5-haiku": "qwen3.5-flash",
    // Claude 3
    "claude-3-opus-20240229": "qwen3.7-max",
    "claude-3-opus": "qwen3.7-max",
    "claude-3-sonnet-20240229": "qwen3.6-plus",
    "claude-3-sonnet": "qwen3.6-plus",
    "claude-3-haiku-20240307": "qwen3.5-flash",
    "claude-3-haiku": "qwen3.5-flash",
  };

  return claudeToQwen[model] || model;
}

/**
 * Pass through model name as-is
 */
export function mapQwenToAnthropicModel(model: string): string {
  return model;
}

/**
 * Generate Anthropic-style message ID
 */
function generateMessageId(): string {
  return `msg_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Translate Anthropic request to OpenAI format
 */
export function translateAnthropicToOpenAI(
  body: AnthropicRequest,
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // System prompt → message role=system
  if (body.system) {
    if (typeof body.system === "string") {
      messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      // Anthropic supports array of content blocks for system
      const text = body.system
        .filter((b) => b.type === "text")
        .map((b) => b.text || "")
        .join("\n");
      if (text) {
        messages.push({ role: "system", content: text });
      }
    }
  }

  // Messages
  for (const msg of body.messages) {
    if (msg.role === "user") {
      // Check if it has tool_result
      if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        const textParts = msg.content.filter((b) => b.type === "text");
        const imageParts = msg.content.filter((b) => b.type === "image");

        // Tool results → messages role=tool
        for (const tr of toolResults) {
          let content = "";
          if (typeof tr.content === "string") {
            content = tr.content;
          } else if (Array.isArray(tr.content)) {
            content = tr.content
              .filter((b) => b.type === "text")
              .map((b) => b.text || "")
              .join("\n");
          }
          messages.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content,
          });
        }

        // Text parts → message role=user
        if (textParts.length > 0) {
          const text = textParts.map((b) => b.text || "").join("\n");
          messages.push({ role: "user", content: text });
        }

        // Image parts → convert to multimodal content (not fully supported, skip for now)
        if (imageParts.length > 0 && textParts.length === 0) {
          messages.push({ role: "user", content: "[Image content]" });
        }
      } else {
        messages.push({ role: "user", content: msg.content });
      }
    } else if (msg.role === "assistant") {
      // Check if it has tool_use
      if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((b) => b.type === "text");
        const toolUses = msg.content.filter((b) => b.type === "tool_use");

        const assistantMsg: OpenAIMessage = {
          role: "assistant",
          content: textParts.map((b) => b.text || "").join("\n") || null,
        };

        // Tool calls
        if (toolUses.length > 0) {
          assistantMsg.tool_calls = toolUses.map((tu) => ({
            id: tu.id || `call_${crypto.randomBytes(12).toString("hex")}`,
            type: "function" as const,
            function: {
              name: tu.name || "",
              arguments: JSON.stringify(tu.input || {}),
            },
          }));
        }

        messages.push(assistantMsg);
      } else {
        messages.push({ role: "assistant", content: msg.content });
      }
    }
  }

  // Tools
  let tools: OpenAITool[] | undefined;
  if (body.tools && body.tools.length > 0) {
    tools = body.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  // Tool choice
  let toolChoice: string | object | undefined;
  if (body.tool_choice) {
    switch (body.tool_choice.type) {
      case "auto":
        toolChoice = "auto";
        break;
      case "any":
        toolChoice = "required";
        break;
      case "tool":
        toolChoice = {
          type: "function",
          function: { name: body.tool_choice.name },
        };
        break;
      case "none":
        toolChoice = "none";
        break;
    }
  }

  // Model mapping
  const model = mapAnthropicModel(body.model);

  return {
    model,
    messages,
    max_tokens: body.max_tokens,
    tools,
    tool_choice: toolChoice,
    stream: body.stream ?? false,
    temperature: body.temperature,
    top_p: body.top_p,
  };
}

/**
 * Translate OpenAI response to Anthropic format
 */
export function translateOpenAIToAnthropic(
  openaiResponse: OpenAIResponse,
  requestModel: string,
): AnthropicResponse {
  const choice = openaiResponse.choices[0];
  const content: AnthropicResponseContentBlock[] = [];

  // Text content
  if (choice.message.content) {
    content.push({
      type: "text",
      text: choice.message.content,
    });
  }

  // Tool calls → tool_use blocks
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = { raw: tc.function.arguments };
      }

      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  // Stop reason mapping
  const stopReasonMap: Record<string, AnthropicResponse["stop_reason"]> = {
    stop: "end_turn",
    tool_calls: "tool_use",
    length: "max_tokens",
    content_filter: "end_turn",
  };

  return {
    id: generateMessageId(),
    type: "message",
    role: "assistant",
    content,
    model: requestModel,
    stop_reason: stopReasonMap[choice.finish_reason || "stop"] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage.prompt_tokens,
      output_tokens: openaiResponse.usage.completion_tokens,
    },
  };
}

/**
 * Translate OpenAI streaming chunk to Anthropic format
 */
export function translateStreamChunk(
  chunk: any,
  state: {
    contentBlockIndex: number;
    currentBlockType: string | null;
    requestModel: string;
    inputTokens: number;
  },
): string[] {
  const events: string[] = [];
  const delta = chunk.choices?.[0]?.delta;

  if (!delta) return events;

  // Text content
  if (delta.content) {
    if (state.currentBlockType !== "text") {
      // content_block_start for text
      events.push(
        JSON.stringify({
          type: "content_block_start",
          index: state.contentBlockIndex,
          content_block: { type: "text", text: "" },
        }),
      );
      state.currentBlockType = "text";
    }

    // content_block_delta
    events.push(
      JSON.stringify({
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: { type: "text_delta", text: delta.content },
      }),
    );
  }

  // Tool calls
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.function?.name) {
        // Close previous block if exists
        if (state.currentBlockType) {
          events.push(
            JSON.stringify({
              type: "content_block_stop",
              index: state.contentBlockIndex,
            }),
          );
          state.contentBlockIndex++;
        }

        // content_block_start for tool_use
        events.push(
          JSON.stringify({
            type: "content_block_start",
            index: state.contentBlockIndex,
            content_block: {
              type: "tool_use",
              id: tc.id || `call_${crypto.randomBytes(12).toString("hex")}`,
              name: tc.function.name,
              input: {},
            },
          }),
        );
        state.currentBlockType = "tool_use";
      }

      if (tc.function?.arguments) {
        // content_block_delta for input_json
        events.push(
          JSON.stringify({
            type: "content_block_delta",
            index: state.contentBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: tc.function.arguments,
            },
          }),
        );
      }
    }
  }

  // Finish reason
  if (chunk.choices?.[0]?.finish_reason) {
    // Close current block
    if (state.currentBlockType) {
      events.push(
        JSON.stringify({
          type: "content_block_stop",
          index: state.contentBlockIndex,
        }),
      );
      state.contentBlockIndex++;
      state.currentBlockType = null;
    }

    // message_delta
    const stopReasonMap: Record<string, string> = {
      stop: "end_turn",
      tool_calls: "tool_use",
      length: "max_tokens",
    };

    events.push(
      JSON.stringify({
        type: "message_delta",
        delta: {
          stop_reason:
            stopReasonMap[chunk.choices[0].finish_reason] || "end_turn",
          usage: { output_tokens: chunk.usage?.completion_tokens || 0 },
        },
      }),
    );
  }

  return events;
}
