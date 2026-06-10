const modelContextWindows: Record<string, number> = {
  "qwen3.7-plus": 1000000,
  "qwen3.7-max": 1000000,
  "qwen3.6-plus": 1000000,
  "qwen3.6-plus-preview": 1000000,
  "qwen3.6-max-preview": 262144,
  "qwen3.6-27b": 262144,
  "qwen3.6-35b-a3b": 262144,
  "qwen3.5-plus": 1000000,
  "qwen3.5-flash": 1000000,
  "qwen3.5-omni-plus": 262144,
  "qwen3.5-omni-flash": 262144,
  "qwen3.5-max-2026-03-08": 262144,
  "qwen3.5-397b-a17b": 262144,
  "qwen3.5-122b-a10b": 262144,
  "qwen3.5-27b": 262144,
  "qwen3.5-35b-a3b": 262144,
  "qwen3-max-2026-01-23": 262144,
  "qwen3-coder-plus": 1048576,
  "qwen3-vl-plus": 262144,
  "qwen3-omni-flash-2025-12-01": 65536,
  "qwen-plus-2025-07-28": 131072,
  "qwen-latest-series-invite-beta-v24": 262144,
  "qwen-latest-series-invite-beta-v16": 1000000,
};

const modelTokenDivisors: Record<string, number> = {
  "qwen3.7-max": 2.2,
  "qwen3.6-max-preview": 2.2,
  "qwen3.5-max-2026-03-08": 2.2,
  "qwen3-max-2026-01-23": 2.2,
  "qwen-latest-series-invite-beta-v24": 2.2,
  "qwen3.7-plus": 2.0,
  "qwen3.6-plus": 2.0,
  "qwen3.6-plus-preview": 2.0,
  "qwen3.5-plus": 2.0,
  "qwen-plus-2025-07-28": 2.0,
  "qwen-latest-series-invite-beta-v16": 2.0,
  "qwen3.5-flash": 1.8,
  "qwen3.5-omni-plus": 1.8,
  "qwen3.5-omni-flash": 1.7,
  "qwen3-omni-flash-2025-12-01": 1.7,
  "qwen3.5-397b-a17b": 1.9,
  "qwen3.5-122b-a10b": 1.9,
  "qwen3.6-35b-a3b": 1.9,
  "qwen3.5-35b-a3b": 1.9,
  "qwen3.6-27b": 1.9,
  "qwen3.5-27b": 1.9,
  "qwen3-coder-plus": 2.3,
  "qwen3-vl-plus": 2.1,
};

const defaultContextWindow = 131072;
const defaultTokenDivisor = 2.0;
export const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024;

export function setModelContextWindow(
  modelId: string,
  contextWindow: number,
): void {
  modelContextWindows[modelId] = contextWindow;
}

export function getModelContextWindow(modelId: string): number {
  const baseId = modelId.replace("-no-thinking", "");
  return modelContextWindows[baseId] ?? defaultContextWindow;
}

export function getModelTokenDivisor(modelId: string): number {
  const baseId = modelId.replace("-no-thinking", "");
  return modelTokenDivisors[baseId] ?? defaultTokenDivisor;
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
