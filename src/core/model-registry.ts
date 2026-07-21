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

export function setModelContextWindow(
  modelId: string,
  contextWindow: number,
): void {
  modelContextWindows[modelId] = contextWindow;
}

export function getModelContextWindow(modelId: string): number {
  // Remove both -thinking and -no-thinking suffixes to get base model ID
  const baseId = modelId.replace("-no-thinking", "").replace("-thinking", "");
  return modelContextWindows[baseId] ?? defaultContextWindow;
}

export function getModelCapabilities(modelId: string): ModelCapabilities {
  // Remove both -thinking and -no-thinking suffixes to get base model ID
  const baseId = modelId.replace("-no-thinking", "").replace("-thinking", "");
  return modelCapabilities[baseId] ?? defaultCapabilities;
}

/**
 * Update capabilities for a model (e.g. after syncing from upstream API).
 */
export function setModelCapabilities(
  modelId: string,
  capabilities: Partial<ModelCapabilities>,
): void {
  const existing = modelCapabilities[modelId] ?? { ...defaultCapabilities };
  modelCapabilities[modelId] = { ...existing, ...capabilities };
}

export function syncModelContextWindows(
  models: Array<{ id: string; context_window?: number }>,
): void {
  for (const m of models) {
    if (m.context_window) {
      modelContextWindows[m.id] = m.context_window;
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
