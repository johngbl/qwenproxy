import type { AnthropicRequest } from "./types.ts";

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate Anthropic request format
 */
export function validateAnthropicRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body must be a JSON object" };
  }

  const req = body as Record<string, unknown>;

  // Model is required
  if (!req.model || typeof req.model !== "string") {
    return { valid: false, error: "Missing or invalid 'model' field" };
  }

  // max_tokens is required
  if (req.max_tokens === undefined || req.max_tokens === null) {
    return { valid: false, error: "Missing required field: max_tokens" };
  }

  if (typeof req.max_tokens !== "number" || req.max_tokens < 1) {
    return { valid: false, error: "max_tokens must be a positive number" };
  }

  // messages is required
  if (!req.messages || !Array.isArray(req.messages)) {
    return { valid: false, error: "Missing or invalid 'messages' field" };
  }

  if (req.messages.length === 0) {
    return { valid: false, error: "messages array cannot be empty" };
  }

  // Validate each message
  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (!msg || typeof msg !== "object") {
      return { valid: false, error: `messages[${i}] must be an object` };
    }

    if (
      msg.role !== "user" &&
      msg.role !== "assistant" &&
      msg.role !== "system"
    ) {
      return {
        valid: false,
        error: `messages[${i}].role must be 'user', 'assistant' or 'system'`,
      };
    }

    if (msg.content === undefined || msg.content === null) {
      return { valid: false, error: `messages[${i}].content is required` };
    }

    // Content can be string or array of content blocks
    if (typeof msg.content !== "string" && !Array.isArray(msg.content)) {
      return {
        valid: false,
        error: `messages[${i}].content must be a string or array of content blocks`,
      };
    }
  }

  // Validate tools if present
  if (req.tools !== undefined) {
    if (!Array.isArray(req.tools)) {
      return { valid: false, error: "'tools' must be an array" };
    }

    for (let i = 0; i < req.tools.length; i++) {
      const tool = req.tools[i];
      if (!tool || typeof tool !== "object") {
        return { valid: false, error: `tools[${i}] must be an object` };
      }

      if (!tool.name || typeof tool.name !== "string") {
        return {
          valid: false,
          error: `tools[${i}].name is required and must be a string`,
        };
      }

      if (tool.input_schema && typeof tool.input_schema !== "object") {
        return {
          valid: false,
          error: `tools[${i}].input_schema must be an object`,
        };
      }
    }
  }

  // Validate tool_choice if present
  if (req.tool_choice !== undefined && req.tool_choice !== null) {
    const toolChoice = req.tool_choice as Record<string, unknown>;
    if (typeof toolChoice !== "object" || !toolChoice.type) {
      return {
        valid: false,
        error: "'tool_choice' must be an object with a 'type' field",
      };
    }

    const validTypes = ["auto", "any", "tool", "none"];
    if (!validTypes.includes(toolChoice.type as string)) {
      return {
        valid: false,
        error: `tool_choice.type must be one of: ${validTypes.join(", ")}`,
      };
    }

    if (toolChoice.type === "tool" && !toolChoice.name) {
      return {
        valid: false,
        error: "tool_choice.name is required when type is 'tool'",
      };
    }
  }

  // Validate stream if present
  if (req.stream !== undefined && typeof req.stream !== "boolean") {
    return { valid: false, error: "'stream' must be a boolean" };
  }

  // Validate temperature if present
  if (req.temperature !== undefined) {
    if (
      typeof req.temperature !== "number" ||
      req.temperature < 0 ||
      req.temperature > 1
    ) {
      return {
        valid: false,
        error: "'temperature' must be a number between 0 and 1",
      };
    }
  }

  return { valid: true };
}
