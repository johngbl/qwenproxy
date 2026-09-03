import crypto from "crypto";
import type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicResponseContentBlock,
  OpenAIRequest,
  OpenAIMessage,
  OpenAITool,
  OpenAIResponse,
} from "./types.ts";
import { stripThinkingSuffix } from "../../core/model-alias.ts";

/**
 * Resolves Anthropic model requests dynamically to internal Qwen models.
 * Zero hardcoded versions — matches by model family/tier so ANY future Claude version
 * (Claude 3.8, 4, 4.5, 5, etc.) works out of the box:
 *  - opus / sonnet / generic claude -> qwen3.8-max
 *  - haiku -> qwen3.7-plus
 *  - direct qwen* models pass through as-is
 * Preserves -fast and -thinking reasoning suffixes.
 */
export function mapAnthropicModel(model: string): string {
  if (!model) return "qwen3.8-max";

  const { baseModel, reasoningMode } = stripThinkingSuffix(model.trim());
  const normalized = baseModel.toLowerCase();

  let targetBase = baseModel;

  // Direct Qwen models pass through untouched (e.g. qwen3.8-max, qwen3.7-plus)
  if (!normalized.startsWith("qwen")) {
    if (normalized.includes("haiku")) {
      targetBase = "qwen3.7-plus";
    } else if (
      normalized.includes("opus") ||
      normalized.includes("sonnet") ||
      normalized.startsWith("claude")
    ) {
      targetBase = "qwen3.8-max";
    }
  }

  if (reasoningMode === "fast") return `${targetBase}-fast`;
  if (reasoningMode === "thinking") return `${targetBase}-thinking`;
  return targetBase;
}

export function generateMessageId(): string {
  return `msg_${crypto.randomBytes(12).toString("hex")}`;
}

export function generateToolId(): string {
  return `toolu_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Translate Anthropic request to OpenAI chat completions format.
 */
export function translateAnthropicToOpenAI(
  body: AnthropicRequest,
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // 1. System prompt → message role=system
  if (body.system) {
    if (typeof body.system === "string") {
      messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      const text = body.system
        .filter((b) => b && (b.type === "text" || !b.type))
        .map((b) => b.text || "")
        .join("\n");
      if (text) {
        messages.push({ role: "system", content: text });
      }
    }
  }

  // 2. Messages
  for (const msg of body.messages) {
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter(
          (b) => b && typeof b === "object" && b.type === "tool_result",
        );
        const textBlocks = msg.content.filter(
          (b) => b && typeof b === "object" && b.type === "text",
        );
        const imageBlocks = msg.content.filter(
          (b) => b && typeof b === "object" && b.type === "image",
        );

        // Tool results become individual role="tool" messages
        for (const tr of toolResults) {
          let contentStr = "";
          if (typeof tr.content === "string") {
            contentStr = tr.content;
          } else if (Array.isArray(tr.content)) {
            contentStr = tr.content
              .filter((b) => b && typeof b === "object" && b.type === "text")
              .map((b) => b.text || "")
              .join("\n");
          } else if (tr.content && typeof tr.content === "object") {
            contentStr = JSON.stringify(tr.content);
          }

          if (tr.is_error) {
            contentStr = `[Tool Error] ${contentStr}`;
          }

          messages.push({
            role: "tool",
            tool_call_id: tr.tool_use_id || "",
            content: contentStr,
          });
        }

        // Remaining user content (text and images)
        if (imageBlocks.length > 0) {
          const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
          for (const tb of textBlocks) {
            if (tb.text) parts.push({ type: "text", text: tb.text });
          }
          for (const ib of imageBlocks) {
            if (ib.source) {
              if (ib.source.type === "base64" && ib.source.data && ib.source.media_type) {
                parts.push({
                  type: "image_url",
                  image_url: {
                    url: `data:${ib.source.media_type};base64,${ib.source.data}`,
                  },
                });
              } else if (ib.source.type === "url" && ib.source.url) {
                parts.push({
                  type: "image_url",
                  image_url: { url: ib.source.url },
                });
              }
            }
          }
          if (parts.length > 0) {
            messages.push({ role: "user", content: parts });
          }
        } else if (textBlocks.length > 0) {
          const joinedText = textBlocks.map((b) => b.text || "").join("\n");
          messages.push({ role: "user", content: joinedText });
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        messages.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(
          (b) => b && typeof b === "object" && b.type === "text",
        );
        const toolUses = msg.content.filter(
          (b) => b && typeof b === "object" && b.type === "tool_use",
        );

        const textContent = textBlocks.map((b) => b.text || "").join("\n") || null;
        const assistantMsg: OpenAIMessage = {
          role: "assistant",
          content: textContent,
        };

        if (toolUses.length > 0) {
          assistantMsg.tool_calls = toolUses.map((tu) => ({
            id: tu.id || generateToolId(),
            type: "function" as const,
            function: {
              name: tu.name || "",
              arguments:
                typeof tu.input === "string"
                  ? tu.input
                  : JSON.stringify(tu.input || {}),
            },
          }));
        }

        messages.push(assistantMsg);
      }
    }
  }

  // 3. Tools
  let tools: OpenAITool[] | undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    tools = body.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema || {},
      },
    }));
  }

  // 4. Tool choice
  let toolChoice: string | object | undefined;
  if (body.tool_choice && typeof body.tool_choice === "object") {
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
          function: { name: body.tool_choice.name || "" },
        };
        break;
      case "none":
        toolChoice = "none";
        break;
    }
  }

  // 5. Reasoning / Thinking mapping
  let reasoningEffort: string | undefined;
  if (body.thinking?.type === "disabled") {
    reasoningEffort = "none";
  } else if (body.thinking?.type === "enabled") {
    reasoningEffort = "high";
  }

  const model = mapAnthropicModel(body.model);

  return {
    model,
    messages,
    max_tokens: body.max_tokens,
    max_completion_tokens: body.max_tokens,
    tools,
    tool_choice: toolChoice,
    reasoning_effort: reasoningEffort,
    stream: body.stream ?? false,
    temperature: body.temperature,
    top_p: body.top_p,
  };
}

/**
 * Translate OpenAI chat completion response to Anthropic format.
 */
export function translateOpenAIToAnthropic(
  openaiResponse: OpenAIResponse,
  requestModel: string,
): AnthropicResponse {
  const choice = openaiResponse.choices[0];
  const content: AnthropicResponseContentBlock[] = [];

  // 1. Thinking block
  if (choice.message.reasoning_content) {
    content.push({
      type: "thinking",
      thinking: choice.message.reasoning_content,
    });
  }

  // 2. Text block
  if (choice.message.content) {
    let text =
      typeof choice.message.content === "string"
        ? choice.message.content
        : JSON.stringify(choice.message.content);
    // Strip raw tool call tags if tool calls exist so they don't leak into assistant text
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      text = text
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
        .replace(/<tool_call>[\s\S]*$/gi, "")
        .replace(/<qpx_call>[\s\S]*?<\/qpx_call>/gi, "")
        .replace(/<qpx_call>[\s\S]*$/gi, "")
        .trim();
    }
    if (text) {
      content.push({
        type: "text",
        text,
      });
    }
  }

  // 3. Tool use blocks
  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input =
          typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments || {};
      } catch {
        input = { raw: tc.function.arguments };
      }

      content.push({
        type: "tool_use",
        id: tc.id || generateToolId(),
        name: tc.function.name,
        input,
      });
    }
  }

  const stopReasonMap: Record<string, AnthropicResponse["stop_reason"]> = {
    stop: "end_turn",
    tool_calls: "tool_use",
    length: "max_tokens",
    content_filter: "end_turn",
  };

  const hasToolUse = content.some((b) => b.type === "tool_use");
  const stopReason = hasToolUse
    ? "tool_use"
    : stopReasonMap[choice.finish_reason || "stop"] || "end_turn";

  return {
    id: generateMessageId(),
    type: "message",
    role: "assistant",
    content,
    model: requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens ?? 0,
      output_tokens: openaiResponse.usage?.completion_tokens ?? 0,
    },
  };
}

export interface AnthropicStreamState {
  contentBlockIndex: number;
  currentBlockType: "thinking" | "text" | "tool_use" | null;
  currentToolId: string | null;
  currentToolIndex: number | null;
  requestModel: string;
  inputTokens: number;
  outputTokens: number;
  hasEmittedToolUse: boolean;
}

/**
 * Translate an OpenAI streaming SSE chunk into an array of Anthropic SSE data strings.
 */
export function translateStreamChunk(
  chunk: any,
  state: AnthropicStreamState,
): string[] {
  const events: string[] = [];

  const usage = chunk.usage;
  if (usage?.prompt_tokens !== undefined) {
    state.inputTokens = usage.prompt_tokens;
  }
  if (usage?.completion_tokens !== undefined) {
    state.outputTokens = usage.completion_tokens;
  }

  const choice = chunk.choices?.[0];
  const delta = choice?.delta ?? {};

  // 1. Thinking delta
  if (delta.reasoning_content) {
    if (state.currentBlockType !== "thinking") {
      if (state.currentBlockType !== null) {
        events.push(
          JSON.stringify({
            type: "content_block_stop",
            index: state.contentBlockIndex,
          }),
        );
        state.contentBlockIndex++;
      }
      events.push(
        JSON.stringify({
          type: "content_block_start",
          index: state.contentBlockIndex,
          content_block: { type: "thinking", thinking: "" },
        }),
      );
      state.currentBlockType = "thinking";
    }

    events.push(
      JSON.stringify({
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: { type: "thinking_delta", thinking: delta.reasoning_content },
      }),
    );
  }

  // 2. Text delta
  if (delta.content) {
    if (state.currentBlockType !== "text") {
      if (state.currentBlockType !== null) {
        events.push(
          JSON.stringify({
            type: "content_block_stop",
            index: state.contentBlockIndex,
          }),
        );
        state.contentBlockIndex++;
      }
      events.push(
        JSON.stringify({
          type: "content_block_start",
          index: state.contentBlockIndex,
          content_block: { type: "text", text: "" },
        }),
      );
      state.currentBlockType = "text";
    }

    events.push(
      JSON.stringify({
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: { type: "text_delta", text: delta.content },
      }),
    );
  }

  // 3. Tool calls delta
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    for (const tc of delta.tool_calls) {
      const tcIndex = tc.index ?? 0;

      // Start new tool_use block when name appears or index changes
      if (
        tc.function?.name ||
        tc.id ||
        state.currentBlockType !== "tool_use" ||
        state.currentToolIndex !== tcIndex
      ) {
        if (state.currentBlockType !== null) {
          events.push(
            JSON.stringify({
              type: "content_block_stop",
              index: state.contentBlockIndex,
            }),
          );
          state.contentBlockIndex++;
        }

        const toolId = tc.id || generateToolId();
        state.currentToolId = toolId;
        state.currentToolIndex = tcIndex;
        state.hasEmittedToolUse = true;

        events.push(
          JSON.stringify({
            type: "content_block_start",
            index: state.contentBlockIndex,
            content_block: {
              type: "tool_use",
              id: toolId,
              name: tc.function?.name || "",
              input: {},
            },
          }),
        );
        state.currentBlockType = "tool_use";
      }

      if (tc.function?.arguments) {
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

  // 4. Finish reason (message end)
  if (choice?.finish_reason) {
    if (state.currentBlockType !== null) {
      events.push(
        JSON.stringify({
          type: "content_block_stop",
          index: state.contentBlockIndex,
        }),
      );
      state.contentBlockIndex++;
      state.currentBlockType = null;
    }

    const stopReason = state.hasEmittedToolUse
      ? "tool_use"
      : choice.finish_reason === "length"
        ? "max_tokens"
        : "end_turn";

    events.push(
      JSON.stringify({
        type: "message_delta",
        delta: {
          stop_reason: stopReason,
          stop_sequence: null,
        },
        usage: {
          output_tokens: state.outputTokens || 0,
        },
      }),
    );
  }

  return events;
}
