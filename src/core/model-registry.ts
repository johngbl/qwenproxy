const modelContextWindows: Record<string, number> = {
  "qwen-max": 32768,
  "qwen-max-latest": 32768,
  "qwen-plus": 131072,
  "qwen-plus-latest": 131072,
  "qwen-turbo": 131072,
  "qwen-turbo-latest": 131072,
  "qwen-long": 1000000,
  "qwen-coder": 131072,
  "qwen-coder-plus": 131072,
};

const defaultContextWindow = 131072;

export function getModelContextWindow(modelId: string): number {
  const baseId = modelId.replace("-no-thinking", "");
  return modelContextWindows[baseId] ?? defaultContextWindow;
}
