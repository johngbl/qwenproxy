import crypto from "crypto";
import type {
  ResponsesResponse,
  ResponsesOutputMessage,
  ResponsesOutputFunctionCall,
  ResponsesOutputContentPart,
  ResponsesUsage,
  ResponsesStreamEvent,
} from "./types.ts";

/**
 * Convert OpenAI Chat Completions streaming chunks to Responses API streaming events.
 *
 * The Responses API has more granular streaming events than Chat Completions:
 * - response.created
 * - response.in_progress
 * - response.output_item.added
 * - response.content_part.added
 * - response.output_text.delta (multiple)
 * - response.output_text.done
 * - response.content_part.done
 * - response.output_item.done
 * - response.function_call_arguments.delta (for tool calls)
 * - response.function_call_arguments.done
 * - response.completed
 */

export interface ResponsesStreamState {
  responseId: string;
  messageId: string;
  requestModel: string;
  outputIndex: number;
  contentIndex: number;
  currentBlockType: "text" | "function_call" | null;
  accumulatedText: string;
  accumulatedToolCalls: Map<
    number,
    {
      id: string;
      callId: string;
      name: string;
      arguments: string;
    }
  >;
  completedOutput: (ResponsesOutputMessage | ResponsesOutputFunctionCall)[];
  inputTokens: number;
}

export function createStreamState(
  responseId: string,
  requestModel: string,
): ResponsesStreamState {
  return {
    responseId,
    messageId: `msg_${crypto.randomBytes(16).toString("hex")}`,
    requestModel,
    outputIndex: 0,
    contentIndex: 0,
    currentBlockType: null,
    accumulatedText: "",
    accumulatedToolCalls: new Map(),
    completedOutput: [],
    inputTokens: 0,
  };
}

/**
 * Process a Chat Completions streaming chunk and emit Responses API events.
 */
export function processChatChunk(
  chunk: any,
  state: ResponsesStreamState,
  response: ResponsesResponse,
): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [];

  // Update token count if available
  if (chunk.usage?.prompt_tokens !== undefined) {
    state.inputTokens = chunk.usage.prompt_tokens;
  }

  const choice = chunk.choices?.[0];
  if (!choice) return events;

  const delta = choice.delta ?? {};

  // Text content
  if (delta.content) {
    // Start text block if needed
    if (state.currentBlockType !== "text") {
      // Close previous block if exists
      if (state.currentBlockType === "function_call") {
        events.push(...closeCurrentFunctionCall(state));
      }

      // Emit output_item.added for message
      const messageItem: ResponsesOutputMessage = {
        type: "message",
        id: state.messageId,
        role: "assistant",
        status: "in_progress",
        content: [],
      };
      events.push({
        type: "response.output_item.added",
        output_index: state.outputIndex,
        item: messageItem,
      });

      // Emit content_part.added
      const contentPart: ResponsesOutputContentPart = {
        type: "output_text",
        text: "",
        annotations: [],
      };
      events.push({
        type: "response.content_part.added",
        item_id: state.messageId,
        output_index: state.outputIndex,
        content_index: state.contentIndex,
        part: contentPart,
      });

      state.currentBlockType = "text";
    }

    // Emit text delta
    state.accumulatedText += delta.content;
    events.push({
      type: "response.output_text.delta",
      item_id: state.messageId,
      output_index: state.outputIndex,
      content_index: state.contentIndex,
      delta: delta.content,
    });
  }

  // Tool calls
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const index = tc.index;

      // New tool call
      if (tc.function?.name) {
        // Close previous text block if exists
        if (state.currentBlockType === "text") {
          events.push(...closeCurrentText(state));
        }

        const callId =
          tc.id || `call_${crypto.randomBytes(12).toString("hex")}`;
        const fcId = `fc_${crypto.randomBytes(12).toString("hex")}`;

        state.accumulatedToolCalls.set(index, {
          id: fcId,
          callId,
          name: tc.function.name,
          arguments: "",
        });

        // Emit output_item.added for function_call
        const fcItem: ResponsesOutputFunctionCall = {
          type: "function_call",
          id: fcId,
          call_id: callId,
          name: tc.function.name,
          arguments: "",
          status: "in_progress",
        };
        events.push({
          type: "response.output_item.added",
          output_index: state.outputIndex,
          item: fcItem,
        });

        state.currentBlockType = "function_call";
      }

      // Tool call arguments
      if (tc.function?.arguments) {
        const stored = state.accumulatedToolCalls.get(index);
        if (stored) {
          stored.arguments += tc.function.arguments;
          events.push({
            type: "response.function_call_arguments.delta",
            item_id: stored.id,
            output_index: state.outputIndex,
            delta: tc.function.arguments,
          });
        }
      }
    }
  }

  // Finish reason
  if (choice.finish_reason) {
    // Close current block
    if (state.currentBlockType === "text") {
      events.push(...closeCurrentText(state));
    } else if (state.currentBlockType === "function_call") {
      events.push(...closeCurrentFunctionCall(state));
    }
  }

  return events;
}

/**
 * Close the current text content block.
 */
function closeCurrentText(state: ResponsesStreamState): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [];

  if (state.currentBlockType !== "text") return events;

  // Emit output_text.done
  events.push({
    type: "response.output_text.done",
    item_id: state.messageId,
    output_index: state.outputIndex,
    content_index: state.contentIndex,
    text: state.accumulatedText,
  });

  // Emit content_part.done
  const contentPart: ResponsesOutputContentPart = {
    type: "output_text",
    text: state.accumulatedText,
    annotations: [],
  };
  events.push({
    type: "response.content_part.done",
    item_id: state.messageId,
    output_index: state.outputIndex,
    content_index: state.contentIndex,
    part: contentPart,
  });

  // Emit output_item.done for message
  const messageItem: ResponsesOutputMessage = {
    type: "message",
    id: state.messageId,
    role: "assistant",
    status: "completed",
    content: [contentPart],
  };
  events.push({
    type: "response.output_item.done",
    output_index: state.outputIndex,
    item: messageItem,
  });
  state.completedOutput.push(messageItem);

  state.currentBlockType = null;
  state.contentIndex++;
  state.outputIndex++;

  return events;
}

/**
 * Close all current function call blocks.
 */
function closeCurrentFunctionCall(
  state: ResponsesStreamState,
): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [];

  if (state.currentBlockType !== "function_call") return events;

  // Close all accumulated tool calls
  for (const [index, fc] of state.accumulatedToolCalls) {
    // Emit function_call_arguments.done
    events.push({
      type: "response.function_call_arguments.done",
      item_id: fc.id,
      output_index: state.outputIndex,
      arguments: fc.arguments,
    });

    // Emit output_item.done for function_call
    const fcItem: ResponsesOutputFunctionCall = {
      type: "function_call",
      id: fc.id,
      call_id: fc.callId,
      name: fc.name,
      arguments: fc.arguments,
      status: "completed",
    };
    events.push({
      type: "response.output_item.done",
      output_index: state.outputIndex,
      item: fcItem,
    });
    state.completedOutput.push(fcItem);

    state.outputIndex++;
  }

  state.currentBlockType = null;
  state.accumulatedToolCalls.clear();

  return events;
}

/**
 * Build the final output items from accumulated stream state.
 */
export function buildFinalOutput(
  state: ResponsesStreamState,
): (ResponsesOutputMessage | ResponsesOutputFunctionCall)[] {
  const output: (ResponsesOutputMessage | ResponsesOutputFunctionCall)[] = [
    ...state.completedOutput,
  ];

  // Add an open text block if the stream ended without a finish_reason
  if (state.currentBlockType === "text" && state.accumulatedText) {
    output.push({
      type: "message",
      id: state.messageId,
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: state.accumulatedText,
          annotations: [],
        },
      ],
    });
  }

  // Add open function calls if the stream ended without a finish_reason
  if (state.currentBlockType === "function_call") {
    for (const [, fc] of state.accumulatedToolCalls) {
      output.push({
        type: "function_call",
        id: fc.id,
        call_id: fc.callId,
        name: fc.name,
        arguments: fc.arguments,
        status: "completed",
      });
    }
  }

  return output;
}

/**
 * Build final usage from stream state.
 */
export function buildFinalUsage(
  state: ResponsesStreamState,
  completionTokens: number,
): ResponsesUsage {
  return {
    input_tokens: state.inputTokens,
    output_tokens: completionTokens,
    total_tokens: state.inputTokens + completionTokens,
  };
}
