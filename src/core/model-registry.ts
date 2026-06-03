const modelContextWindows: Record<string, number> = {
  "qwen3.7-plus": 1000000,
  "qwen3.7-max": 1000000,
  "qwen3.6-plus": 1000000,
  "qwen3.5-flash": 1000000,
};

const defaultContextWindow = 262144;

export function getModelContextWindow(modelId: string): number {
  const baseId = modelId.replace("-no-thinking", "");
  return modelContextWindows[baseId] ?? defaultContextWindow;
}
