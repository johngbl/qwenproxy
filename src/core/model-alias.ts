/**
 * Client model aliases (OpenAI GPT / Claude / o-series) → Qwen IDs.
 * Used by Chat Completions, Responses API and Anthropic adapter paths.
 */

const CLIENT_MODEL_ALIASES: Record<string, string> = {
  // GPT-5.x
  "gpt-5.5": "qwen3.7-max",
  "gpt-5.5-turbo": "qwen3.7-max",
  "gpt-5": "qwen3.7-max",
  "gpt-5-pro": "qwen3.7-max",
  "gpt-5-turbo": "qwen3.7-plus",
  "gpt-5-mini": "qwen3.5-flash",
  "gpt-5-nano": "qwen3.5-flash",
  "gpt-5-codex": "qwen3-coder-plus",
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
  // Claude (also used by Anthropic adapter)
  "claude-opus-4-8": "qwen3.7-max",
  "claude-opus-4-7": "qwen3.7-max",
  "claude-opus-4-6": "qwen3.7-max",
  "claude-opus-4-5": "qwen3.7-max",
  "claude-sonnet-4-6": "qwen3.7-plus",
  "claude-sonnet-4-5": "qwen3.7-plus",
  "claude-haiku-4-5": "qwen3.5-flash",
  "claude-opus-4-8-20250918": "qwen3.7-max",
  "claude-sonnet-4-6-20250514": "qwen3.7-plus",
  "claude-haiku-4-5-20251001": "qwen3.5-flash",
  "claude-3-5-sonnet-20241022": "qwen3.7-plus",
  "claude-3-5-sonnet": "qwen3.7-plus",
  "claude-3-5-haiku-20241022": "qwen3.5-flash",
  "claude-3-5-haiku": "qwen3.5-flash",
  "claude-3-opus-20240229": "qwen3.7-max",
  "claude-3-opus": "qwen3.7-max",
  "claude-3-sonnet-20240229": "qwen3.6-plus",
  "claude-3-sonnet": "qwen3.6-plus",
  "claude-3-haiku-20240307": "qwen3.5-flash",
  "claude-3-haiku": "qwen3.5-flash",
};

/**
 * Strip Qwen thinking suffixes while preserving the intent flag for callers.
 */
export function stripThinkingSuffix(model: string): {
  baseModel: string;
  enableThinking: boolean;
} {
  if (model.endsWith("-no-thinking")) {
    return {
      baseModel: model.slice(0, -"-no-thinking".length),
      enableThinking: false,
    };
  }
  if (model.endsWith("-thinking")) {
    return {
      baseModel: model.slice(0, -"-thinking".length),
      enableThinking: true,
    };
  }
  return { baseModel: model, enableThinking: true };
}

/**
 * Map a client-facing model id to the Qwen model used upstream.
 * Qwen ids pass through; known GPT/Claude aliases are rewritten.
 * Unknown models pass through (upstream/not-found handles the rest).
 */
export function mapClientModelToQwen(model: string): string {
  if (!model) return model;

  const { baseModel } = stripThinkingSuffix(model.trim());
  if (baseModel.startsWith("qwen")) {
    return baseModel;
  }

  return CLIENT_MODEL_ALIASES[baseModel] || baseModel;
}

/** @deprecated Prefer mapClientModelToQwen — kept for Responses adapter callers */
export function mapResponsesModel(model: string): string {
  return mapClientModelToQwen(model);
}
