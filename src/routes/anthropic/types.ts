// Anthropic API Types

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | AnthropicContentBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: AnthropicThinking;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  metadata?: Record<string, unknown>;
}

export interface AnthropicThinking {
  type: "enabled" | "disabled";
  budget_tokens?: number;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image" | "document" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
  source?: AnthropicImageSource;
  thinking?: string;
}

export interface AnthropicImageSource {
  type: "base64" | "url";
  media_type: string;
  data?: string;
  url?: string;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicToolChoice {
  type: "auto" | "any" | "tool" | "none";
  name?: string;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicResponseContentBlock[];
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export interface AnthropicResponseContentBlock {
  type: "text" | "tool_use" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  thinking?: string;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicError {
  type: "error";
  error: {
    type: string;
    message: string;
  };
  request_id?: string;
}

// Internal OpenAI-compatible types for conversion
export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: OpenAITool[];
  tool_choice?: string | object;
  reasoning_effort?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
}

export interface OpenAIChoice {
  index: number;
  message: OpenAIMessage;
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
