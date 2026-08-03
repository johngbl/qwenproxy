const modelContextWindows: Record<string, number> = {
  "qwen3.8-max-preview": 1000000,
  "qwen3.7-plus": 1000000,
  "qwen3.7-max": 1000000,
  "qwen3.6-plus": 1000000,
  "qwen3.6-max-preview": 262144,
  "qwen3.6-27b": 262144,
  "qwen3.6-35b-a3b": 262144,
  "qwen3.5-plus": 1000000,
  "qwen3.5-flash": 1000000,
  "qwen3.5-omni-plus": 262144,
  "qwen3.5-omni-flash": 262144,
  "qwen3.5-397b-a17b": 262144,
  "qwen3-max-2026-01-23": 262144,
  "qwen3-coder-plus": 1048576,
  "qwen3-vl-plus": 262144,
  "qwen3-omni-flash-2025-12-01": 65536,
  "qwen-plus-2025-07-28": 131072,
};

const defaultContextWindow = 131072;
const modelContextWindowSources = new Map<string, "upstream">();
const defaultMaxOutputTokens = 8192;
const defaultMaxThinkingTokens = 16384;
export const MAX_PAYLOAD_SIZE = 50 * 1024 * 1024;

/**
 * Model capabilities sourced from https://chat.qwen.ai/api/v2/models/
 * - maxOutputTokens: max_generation_length or max_summary_generation_length
 * - maxThinkingTokens: max_thinking_generation_length (only when separate from output)
 * - supportsThinking: capabilities.thinking === true
 * - supportsVision: capabilities.vision === true
 * - canSkipThinking: think_skip.enable === true (allows -no-thinking suffix)
 * - modalities: input/output modalities supported
 */
export interface ModelCapabilities {
  maxOutputTokens: number;
  maxThinkingTokens: number;
  supportsThinking: boolean;
  supportsVision: boolean;
  canSkipThinking: boolean;
  modalities: string[];
}

const modelCapabilities: Record<string, ModelCapabilities> = {
  "qwen3.8-max-preview": {
    maxOutputTokens: 65536,
    maxThinkingTokens: 81920,
    supportsThinking: true,
    supportsVision: true,
    canSkipThinking: false,
    modalities: ["text", "image", "video"],
  },
  "qwen3.7-max": {
    maxOutputTokens: 65536,
    maxThinkingTokens: 81920,
    supportsThinking: true,
    supportsVision: false,
    canSkipThinking: false,
    modalities: ["text"],
  },
  "qwen3.7-plus": {
    maxOutputTokens: 65536,
    maxThinkingTokens: 81920,
    supportsThinking: true,
    supportsVision: true,
    canSkipThinking: true,
    modalities: ["text", "image", "video"],
  },
  "qwen3.6-plus": {
    maxOutputTokens: 65536,
    maxThinkingTokens: 81920,
    supportsThinking: true,
    supportsVision: true,
    canSkipThinking: true,
    modalities: ["text", "image", "video"],
  },
  "qwen3.6-max-preview": {
    maxOutputTokens: 65536,
    maxThinkingTokens: 81920,
    supportsThinking: true,
    supportsVision: false,
    canSkipThinking: false,
    modalities: ["text"],
  },
  "qwen3.6-27b": {
    maxOutputTokens: 65536,
    maxThinkingTokens: 81920,
    supportsThinking: true,
    supportsVision: true,
    canSkipThinking: false,
    modalities: ["text", "image", "video"],
  },
  "qwen3.6-35b-a3b": {
    maxOutputTokens: 65536,
    maxThinkingTokens: 81920,
    supportsThinking: true,
    supportsVision: true,
    canSkipThinking: true,
    modalities: ["text", "image", "video"],
  },
  "qwen3.5-plus": {
    maxOutputTokens: 65536,
    maxThinkingTokens: 81920,
    supportsThinking: true,
    supportsVision: true,
    canSkipThinking: true,
    modalities: ["text", "image", "video"],
  },
  "qwen3.5-flash": {
    maxOutputTokens: 65536,
    maxThinkingTokens: 81920,
    supportsThinking: true,
    supportsVision: true,
    canSkipThinking: true,
    modalities: ["text", "image", "video"],
  },
  "qwen3.5-397b-a17b": {
    maxOutputTokens: 65536,
    maxThinkingTokens: 81920,
    supportsThinking: true,
    supportsVision: true,
    canSkipThinking: true,
    modalities: ["text", "image", "video"],
  },
  "qwen3.5-omni-plus": {
    maxOutputTokens: 65536,
    maxThinkingTokens: 0,
    supportsThinking: false,
    supportsVision: true,
    canSkipThinking: false,
    modalities: ["text", "image", "video", "audio"],
  },
  "qwen3.5-omni-flash": {
    maxOutputTokens: 65536,
    maxThinkingTokens: 0,
    supportsThinking: false,
    supportsVision: true,
    canSkipThinking: false,
    modalities: ["text", "image", "video", "audio"],
  },
  "qwen3-max-2026-01-23": {
    maxOutputTokens: 32768,
    maxThinkingTokens: 81920,
    supportsThinking: true,
    supportsVision: true,
    canSkipThinking: true,
    modalities: ["text"],
  },
  "qwen3-coder-plus": {
    maxOutputTokens: 65536,
    maxThinkingTokens: 0,
    supportsThinking: false,
    supportsVision: true,
    canSkipThinking: false,
    modalities: ["text"],
  },
  "qwen3-vl-plus": {
    maxOutputTokens: 32768,
    maxThinkingTokens: 81920,
    supportsThinking: true,
    supportsVision: true,
    canSkipThinking: false,
    modalities: ["text", "image", "video"],
  },
  "qwen3-omni-flash-2025-12-01": {
    maxOutputTokens: 13684,
    maxThinkingTokens: 24576,
    supportsThinking: true,
    supportsVision: true,
    canSkipThinking: false,
    modalities: ["text", "image", "video", "audio"],
  },
  "qwen-plus-2025-07-28": {
    maxOutputTokens: 8192,
    maxThinkingTokens: 81920,
    supportsThinking: true,
    supportsVision: true,
    canSkipThinking: false,
    modalities: ["text"],
  },
};

const defaultCapabilities: ModelCapabilities = {
  maxOutputTokens: defaultMaxOutputTokens,
  maxThinkingTokens: defaultMaxThinkingTokens,
  supportsThinking: true,
  supportsVision: false,
  canSkipThinking: true,
  modalities: ["text"],
};

function getBaseModelId(modelId: string): string {
  return modelId.replace(/-(?:no-thinking|thinking)$/, "");
}

export function setModelContextWindow(
  modelId: string,
  contextWindow: number,
): void {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
  const baseId = getBaseModelId(modelId);
  modelContextWindows[modelId] = contextWindow;
  modelContextWindows[baseId] = contextWindow;
  modelContextWindowSources.set(modelId, "upstream");
  modelContextWindowSources.set(baseId, "upstream");
}

export function getModelContextWindow(modelId: string): number {
  const baseId = getBaseModelId(modelId);
  return modelContextWindows[baseId] ?? defaultContextWindow;
}

export function getModelContextWindowSource(
  modelId: string,
): "upstream" | "registry" | "default" {
  const baseId = getBaseModelId(modelId);
  if (modelContextWindowSources.has(modelId) || modelContextWindowSources.has(baseId)) {
    return "upstream";
  }
  if (modelContextWindows[baseId] !== undefined) return "registry";
  return "default";
}

export function getModelCapabilities(modelId: string): ModelCapabilities {
  return modelCapabilities[getBaseModelId(modelId)] ?? defaultCapabilities;
}

/**
 * Update capabilities for a model (e.g. after syncing from upstream API).
 */
export function setModelCapabilities(
  modelId: string,
  capabilities: Partial<ModelCapabilities>,
): void {
  const baseId = getBaseModelId(modelId);
  const existing = modelCapabilities[baseId] ?? { ...defaultCapabilities };
  modelCapabilities[baseId] = { ...existing, ...capabilities };
}

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = finitePositiveNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function syncModelContextWindows(
  models: Array<{ id: string; context_window?: number }>,
): void {
  for (const model of models) {
    const contextWindow = finitePositiveNumber(model.context_window);
    if (contextWindow !== undefined) {
      setModelContextWindow(model.id, contextWindow);
    }
  }
}

/**
 * Sync the model metadata returned by Qwen's `/api/models` endpoint. The API
 * shape has changed between web versions, so accept the known aliases while
 * retaining the registry fallback when a field is absent.
 */
export function syncModelMetadata(
  models: Array<Record<string, unknown> & { id: string }>,
): void {
  syncModelContextWindows(models);

  for (const model of models) {
    const info = asRecord(model.info);
    const meta = asRecord(info.meta ?? model.meta);
    const capabilities = asRecord(
      model.capabilities ?? meta.capabilities ?? info.capabilities,
    );
    const contextWindow = firstPositiveNumber(
      model.context_window,
      model.contextWindow,
      model.max_context_length,
      meta.max_context_length,
      meta.context_window,
      capabilities.max_context_length,
      capabilities.context_window,
    );
    if (contextWindow !== undefined) {
      setModelContextWindow(model.id, contextWindow);
    }

    const maxOutputTokens = firstPositiveNumber(
      model.max_output_tokens,
      model.max_tokens,
      capabilities.max_output_tokens,
      capabilities.maxOutputTokens,
      capabilities.max_generation_length,
      capabilities.maxGenerationLength,
      meta.max_output_tokens,
      meta.max_generation_length,
    );
    const maxThinkingTokens = firstPositiveNumber(
      capabilities.max_thinking_tokens,
      capabilities.maxThinkingTokens,
      capabilities.max_thinking_generation_length,
      capabilities.maxThinkingGenerationLength,
      meta.max_thinking_tokens,
      meta.max_thinking_generation_length,
    );
    const supportsThinking =
      typeof capabilities.thinking === "boolean"
        ? capabilities.thinking
        : typeof capabilities.supports_thinking === "boolean"
          ? capabilities.supports_thinking
          : undefined;
    const supportsVision =
      typeof capabilities.vision === "boolean"
        ? capabilities.vision
        : typeof capabilities.supports_vision === "boolean"
          ? capabilities.supports_vision
          : undefined;
    const modalities = Array.isArray(capabilities.modalities)
      ? capabilities.modalities.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined;

    if (
      maxOutputTokens !== undefined ||
      maxThinkingTokens !== undefined ||
      supportsThinking !== undefined ||
      supportsVision !== undefined ||
      modalities !== undefined
    ) {
      setModelCapabilities(model.id, {
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(maxThinkingTokens !== undefined ? { maxThinkingTokens } : {}),
        ...(supportsThinking !== undefined ? { supportsThinking } : {}),
        ...(supportsVision !== undefined ? { supportsVision } : {}),
        ...(modalities !== undefined ? { modalities } : {}),
      });
    }
  }
}

/**
 * Strip -no-thinking suffix from a model ID.
 */
export function stripNoThinkingSuffix(modelId: string): string {
  return modelId.replace(/-no-thinking$/, "");
}

/**
 * Whether a model always has thinking enabled (cannot be disabled via effort).
 * e.g. qwen3.8-max-preview has canSkipThinking: false.
 */
export function isAlwaysThinkingModel(modelId: string): boolean {
  const base = modelId.replace(/-no-thinking$/, "").replace(/-thinking$/, "");
  const caps = modelCapabilities[base];
  return caps ? caps.canSkipThinking === false : false;
}
