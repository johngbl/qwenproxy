const modelContextWindows: Record<string, number> = {
  'qwen-max': 32768,
  'qwen-max-latest': 32768,
  'qwen-plus': 131072,
  'qwen-plus-latest': 131072,
  'qwen-turbo': 131072,
  'qwen-turbo-latest': 131072,
  'qwen-long': 1000000,
  'qwen-coder': 131072,
  'qwen-coder-plus': 131072,
}

const defaultContextWindow = 131072

export function setModelContextWindow(modelId: string, contextWindow: number): void {
  modelContextWindows[modelId] = contextWindow
}

export function getModelContextWindow(modelId: string): number {
  const baseId = modelId.replace('-no-thinking', '')
  return modelContextWindows[baseId] ?? defaultContextWindow
}

export function syncModelContextWindows(models: Array<{ id: string; context_window?: number }>): void {
  for (const m of models) {
    if (m.context_window) {
      modelContextWindows[m.id] = m.context_window
    }
  }
}
