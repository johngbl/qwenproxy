import crypto from "crypto";
import type {
  ResponsesRequest,
  ResponsesResponse,
  ResponsesContentPart,
  ResponsesOutputMessage,
  ResponsesOutputFunctionCall,
  ResponsesUsage,
  ResponsesFunctionTool,
} from "./types.ts";

// OpenAI Chat Completions types (internal)
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
      strict?: boolean;
    };
  }>;
  tool_choice?: string | object;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  parallel_tool_calls?: boolean;
}

interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
}

interface ChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ============ ID generators ============

export function generateResponseId(): string {
  return `resp_${crypto.randomBytes(16).toString("hex")}`;
}

export function generateMessageId(): string {
  return `msg_${crypto.randomBytes(16).toString("hex")}`;
}

export function generateCallId(): string {
  return `call_${crypto.randomBytes(12).toString("hex")}`;
}

// ============ Model mapping ============

/**
 * Map GPT/OpenAI model names to Qwen equivalents.
 * Qwen models pass through as-is.
 */
export function mapResponsesModel(model: string): string {
  if (model.startsWith("qwen")) return model;

  const gptToQwen: Record<string, string> = {
    // GPT-5.x
    "gpt-5.5": "qwen3.7-max",
    "gpt-5.5-turbo": "qwen3.7-max",
    "gpt-5": "qwen3.7-max",
    "gpt-5-turbo": "qwen3.7-plus",
    // GPT-4.1
    "gpt-4.1": "qwen3.7-plus",
    "gpt-4.1-mini": "qwen3.5-flash",
    "gpt-4.1-nano": "qwen3.5-flash",
    // GPT-4o
    "gpt-4o": "qwen3.7-plus",
    "gpt-4o-mini": "qwen3.5-flash",
    "gpt-4o-2024-11-20": "qwen3.7-plus",
    "gpt-4o-2024-08-06": "qwen3.7-plus",
    // GPT-4
    "gpt-4": "qwen3.6-plus",
    "gpt-4-turbo": "qwen3.6-plus",
    "gpt-4-turbo-preview": "qwen3.6-plus",
    // GPT-3.5
    "gpt-3.5-turbo": "qwen3.5-flash",
    // o-series
    o3: "qwen3.7-max",
    "o3-mini": "qwen3.7-plus",
    "o4-mini": "qwen3.7-plus",
    o1: "qwen3.7-max",
    "o1-mini": "qwen3.7-plus",
  };

  return gptToQwen[model] || model;
}

// ============ Request conversion ============

/**
 * Extract text from a content field that can be string or array of parts.
 */
function extractText(content?: string | ResponsesContentPart[]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter(
      (p) =>
        p.type === "input_text" ||
        p.type === "output_text" ||
        p.type === "text",
    )
    .map((p) => p.text || "")
    .join("\n");
}

/**
 * Convert Responses API request to OpenAI Chat Completions format.
 */
export function responsesToChatCompletions(
  req: ResponsesRequest,
  historyMessages: ChatMessage[] = [],
): ChatRequest {
  const messages: ChatMessage[] = [...historyMessages];

  // Instructions → system message (prepended)
  if (req.instructions) {
    messages.unshift({ role: "system", content: req.instructions });
  }

  // Convert input to messages
  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else if (Array.isArray(req.input)) {
    for (const msg of req.input) {
      // Handle function_call_output (tool results)
      if (msg.type === "function_call_output") {
        messages.push({
          role: "tool",
          content: msg.output ?? extractText(msg.content),
          tool_call_id: msg.call_id,
        });
        continue;
      }

      // Handle function_call (assistant tool calls from history)
      if (msg.type === "function_call") {
        const callId = msg.call_id || generateCallId();
        const name = msg.name || "unknown";
        const args = msg.arguments || "{}";

        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: { name, arguments: args },
            },
          ],
        });
        continue;
      }

      if (!("role" in msg)) continue;

      const msgRole = msg.role;
      const content = extractText(msg.content);

      if (msgRole === "system" || msgRole === "developer") {
        messages.push({ role: "system", content });
      } else {
        messages.push({ role: msgRole, content });
      }
    }
  }

  // Convert tools — only function tools are sent to Qwen
  // Built-in tools (web_search, shell, etc.) are silently dropped
  let tools: ChatRequest["tools"];
  if (req.tools && req.tools.length > 0) {
    const functionTools = req.tools.filter(
      (t): t is ResponsesFunctionTool => t.type === "function",
    );
    if (functionTools.length > 0) {
      tools = functionTools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          strict: t.strict,
        },
      }));
    }
  }

  // Convert tool_choice
  let toolChoice: ChatRequest["tool_choice"];
  if (req.tool_choice != null) {
    if (typeof req.tool_choice === "string") {
      toolChoice = req.tool_choice;
    } else {
      const name = req.tool_choice.name ?? req.tool_choice.function?.name;
      if (name) {
        toolChoice = {
          type: "function",
          function: { name },
        };
      }
    }
  }

  const chatReq: ChatRequest = {
    model: mapResponsesModel(req.model),
    messages,
    stream: req.stream ?? false,
  };

  if (tools) chatReq.tools = tools;
  if (toolChoice !== undefined) chatReq.tool_choice = toolChoice;
  if (req.temperature !== undefined) chatReq.temperature = req.temperature;
  if (req.top_p !== undefined) chatReq.top_p = req.top_p;
  if (req.max_output_tokens !== undefined)
    chatReq.max_completion_tokens = req.max_output_tokens;
  if (req.parallel_tool_calls !== undefined)
    chatReq.parallel_tool_calls = req.parallel_tool_calls;

  return chatReq;
}

// ============ Response conversion ============

/**
 * Convert OpenAI Chat Completions response to Responses API format.
 */
export function chatCompletionsToResponses(
  chatRes: ChatResponse,
  requestModel: string,
  originalRequest: ResponsesRequest,
): ResponsesResponse {
  const choice = chatRes.choices[0];
  const output: (ResponsesOutputMessage | ResponsesOutputFunctionCall)[] = [];

  // Text content → message output item
  if (choice.message.content) {
    const msgId = generateMessageId();
    output.push({
      type: "message",
      id: msgId,
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: choice.message.content,
          annotations: [],
        },
      ],
    });
  }

  // Tool calls → function_call output items
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        type: "function_call",
        id: `fc_${crypto.randomBytes(12).toString("hex")}`,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      });
    }
  }

  // Build usage
  const usage: ResponsesUsage = {
    input_tokens: chatRes.usage.prompt_tokens,
    output_tokens: chatRes.usage.completion_tokens,
    total_tokens: chatRes.usage.total_tokens,
  };

  return {
    id: generateResponseId(),
    object: "response",
    created_at: chatRes.created,
    model: requestModel,
    status: "completed",
    output,
    usage,
    parallel_tool_calls: originalRequest.parallel_tool_calls,
    tool_choice: originalRequest.tool_choice ?? undefined,
    tools: originalRequest.tools ?? undefined,
    temperature: originalRequest.temperature,
    top_p: originalRequest.top_p,
    max_output_tokens: originalRequest.max_output_tokens,
    previous_response_id: originalRequest.previous_response_id || null,
    metadata: originalRequest.metadata,
    user: originalRequest.user,
    error: null,
    incomplete_details: null,
  };
}

/**
 * Build a minimal "in-progress" response for streaming initial event.
 */
export function buildInProgressResponse(
  responseId: string,
  requestModel: string,
  originalRequest: ResponsesRequest,
): ResponsesResponse {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: requestModel,
    status: "in_progress",
    output: [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
    parallel_tool_calls: originalRequest.parallel_tool_calls,
    tool_choice: originalRequest.tool_choice ?? undefined,
    tools: originalRequest.tools ?? undefined,
    temperature: originalRequest.temperature,
    top_p: originalRequest.top_p,
    max_output_tokens: originalRequest.max_output_tokens,
    previous_response_id: originalRequest.previous_response_id || null,
    metadata: originalRequest.metadata,
    user: originalRequest.user,
    error: null,
    incomplete_details: null,
  };
}

/**
 * Finalize an in-progress response for the completed event.
 */
export function finalizeResponse(
  inProgress: ResponsesResponse,
  output: (ResponsesOutputMessage | ResponsesOutputFunctionCall)[],
  usage: ResponsesUsage,
): ResponsesResponse {
  return {
    ...inProgress,
    status: "completed",
    output,
    usage,
  };
}

export type ChatHistoryMessage = ChatMessage;

/**
 * Convert a Responses API output array into Chat Completions history messages.
 */
export function responsesOutputToChatMessages(
  output: (ResponsesOutputMessage | ResponsesOutputFunctionCall)[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const toolCalls: ChatToolCall[] = [];
  const textParts: string[] = [];

  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text" && part.text) {
          textParts.push(part.text);
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "{}" },
      });
    }
  }

  if (textParts.length > 0 || toolCalls.length > 0) {
    messages.push({
      role: "assistant",
      content: textParts.length > 0 ? textParts.join("\n") : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  return messages;
}
