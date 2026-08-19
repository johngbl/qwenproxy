const defaultContextWindow = 1_048_576;
const defaultMaxOutputTokens = 65536;
const defaultMaxThinkingTokens = 16384;
export const MAX_PAYLOAD_SIZE = 50 * 1024 * 1024;

/**
 * Model metadata exposed by Qwen's live `/api/models` catalog.
 *
 * The registry deliberately has no model-name table. Qwen can add, remove or
 * change models without requiring a QwenProxy release. The values below are
 * conservative fallbacks used only until the selected account's catalog has
 * been synchronized.
 */
export interface ModelCapabilities {
  maxOutputTokens: number;
  maxThinkingTokens: number;
  supportsThinking: boolean;
  supportsVision: boolean;
  canSkipThinking: boolean;
  supportsDocument: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsCitations: boolean;
  supportsCodeExecution: boolean;
  supportsStructuredOutputs: boolean;
  modalities: string[];
  chatTypes: string[];
  mcp: string[];
  isActive: boolean;
}

export interface RegisteredModelMetadata {
  id: string;
  contextWindow?: number;
  capabilities: ModelCapabilities;
  raw: Record<string, unknown>;
}

type JsonRecord = Record<string, unknown>;

const defaultCapabilities: ModelCapabilities = {
  maxOutputTokens: defaultMaxOutputTokens,
  maxThinkingTokens: defaultMaxThinkingTokens,
  supportsThinking: false,
  supportsVision: false,
  canSkipThinking: false,
  supportsDocument: false,
  supportsAudio: false,
  supportsVideo: false,
  supportsCitations: false,
  supportsCodeExecution: false,
  supportsStructuredOutputs: false,
  modalities: ["text"],
  chatTypes: [],
  mcp: [],
  isActive: true,
};

interface RegistryEntry {
  contextWindow?: number;
  capabilities: ModelCapabilities;
  raw: JsonRecord;
}

// The Qwen catalog is account-scoped. Never allow one account's metadata to
// overwrite another account's context window or capabilities.
const modelRegistryByAccount = new Map<string, Map<string, RegistryEntry>>();

function accountKey(accountId?: string): string {
  return accountId || "global";
}

export function getBaseModelId(modelId: string): string {
  // `-fast` is the only public variant. Keep legacy suffixes normalized for
  // account metadata lookups and old clients, without publishing them.
  // Check `-no-thinking` before `-thinking` (the former ends with the latter).
  if (modelId.endsWith("-no-thinking")) return modelId.slice(0, -12);
  if (modelId.endsWith("-thinking")) return modelId.slice(0, -9);
  if (modelId.endsWith("-fast")) return modelId.slice(0, -5);
  return modelId;
}

function getAccountRegistry(accountId?: string): Map<string, RegistryEntry> {
  const key = accountKey(accountId);
  let registry = modelRegistryByAccount.get(key);
  if (!registry) {
    registry = new Map<string, RegistryEntry>();
    modelRegistryByAccount.set(key, registry);
  }
  return registry;
}

function getEntry(modelId: string, accountId?: string): RegistryEntry | undefined {
  return modelRegistryByAccount.get(accountKey(accountId))?.get(
    getBaseModelId(modelId),
  );
}

function getOrCreateEntry(modelId: string, accountId?: string): RegistryEntry {
  const registry = getAccountRegistry(accountId);
  const baseId = getBaseModelId(modelId);
  const existing = registry.get(baseId);
  if (existing) return existing;

  const entry: RegistryEntry = {
    capabilities: cloneCapabilities(defaultCapabilities),
    raw: { id: baseId },
  };
  registry.set(baseId, entry);
  return entry;
}

function cloneCapabilities(capabilities: ModelCapabilities): ModelCapabilities {
  return {
    ...capabilities,
    modalities: [...capabilities.modalities],
    chatTypes: [...capabilities.chatTypes],
    mcp: [...capabilities.mcp],
  };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function finitePositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = finitePositiveNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function booleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function positiveFlag(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 0;
    }
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function normalizeStringList(...values: unknown[]): string[] | undefined {
  const result: string[] = [];
  let sawList = false;

  const append = (value: unknown) => {
    if (Array.isArray(value)) {
      sawList = true;
      for (const item of value) append(item);
      return;
    }
    if (typeof value === "string") {
      sawList = true;
      for (const item of value.split(",")) {
        const normalized = item.trim().toLowerCase();
        if (normalized && !result.includes(normalized)) result.push(normalized);
      }
    }
  };

  for (const value of values) append(value);
  return sawList ? result : undefined;
}

function metadataRecords(model: JsonRecord): {
  info: JsonRecord;
  metadata: JsonRecord;
  upstreamCapabilities: JsonRecord;
  abilities: JsonRecord;
  thinkSkip: JsonRecord;
} {
  const info = asRecord(model.info);
  const metadata = {
    ...asRecord(model.metadata),
    ...asRecord(model.meta),
    ...asRecord(info.meta),
  };
  const upstreamCapabilities = {
    ...asRecord(metadata.capabilities),
    ...asRecord(info.capabilities),
    ...asRecord(model.capabilities),
  };
  const abilities = {
    ...asRecord(metadata.abilities),
    ...asRecord(model.abilities),
  };
  const thinkSkip = {
    ...asRecord(metadata.think_skip),
    ...asRecord(model.think_skip),
  };

  return { info, metadata, upstreamCapabilities, abilities, thinkSkip };
}

function deriveCapabilities(
  model: JsonRecord,
  existing: ModelCapabilities | undefined,
): { capabilities: ModelCapabilities; contextWindow?: number } {
  const { info, metadata, upstreamCapabilities, abilities, thinkSkip } =
    metadataRecords(model);
  const fallback = existing ?? defaultCapabilities;

  const modalities =
    normalizeStringList(
      model.modalities,
      model.modality,
      metadata.modalities,
      metadata.modality,
      upstreamCapabilities.modalities,
    ) ?? [...fallback.modalities];
  const chatTypes =
    normalizeStringList(
      model.chat_types,
      model.chat_type,
      metadata.chat_types,
      metadata.chat_type,
    ) ?? [...fallback.chatTypes];
  const mcp =
    normalizeStringList(model.mcp, metadata.mcp) ?? [...fallback.mcp];

  const supportsThinking =
    booleanValue(
      model.supports_thinking,
      model.supportsThinking,
      upstreamCapabilities.thinking,
      upstreamCapabilities.supports_thinking,
      metadata.thinking,
    ) ??
    positiveFlag(abilities.thinking) ??
    fallback.supportsThinking;

  const supportsVision =
    booleanValue(
      model.supports_vision,
      model.supportsVision,
      upstreamCapabilities.vision,
      upstreamCapabilities.supports_vision,
    ) ??
    positiveFlag(abilities.vision) ??
    (modalities.includes("image") || fallback.supportsVision);

  const supportsDocument =
    booleanValue(
      model.supports_document,
      model.supportsDocument,
      upstreamCapabilities.document,
      upstreamCapabilities.pdf,
      upstreamCapabilities.pdf_input,
    ) ??
    positiveFlag(abilities.document) ??
    fallback.supportsDocument;

  const supportsAudio =
    booleanValue(
      model.supports_audio,
      model.supportsAudio,
      upstreamCapabilities.audio,
    ) ??
    (modalities.includes("audio") || fallback.supportsAudio);

  const supportsVideo =
    booleanValue(
      model.supports_video,
      model.supportsVideo,
      upstreamCapabilities.video,
    ) ??
    (modalities.includes("video") || fallback.supportsVideo);

  const supportsCitations =
    booleanValue(
      model.supports_citations,
      model.supportsCitations,
      model.citations,
      upstreamCapabilities.citations,
    ) ??
    positiveFlag(abilities.citations) ??
    fallback.supportsCitations;

  const supportsCodeExecution =
    booleanValue(
      model.supports_code_execution,
      model.supportsCodeExecution,
      upstreamCapabilities.code_execution,
      upstreamCapabilities.codeInterpreter,
      upstreamCapabilities.code_interpreter,
    ) ??
    positiveFlag(abilities.code_execution, abilities.code_interpreter) ??
    (mcp.some((item) =>
      ["code-interpreter", "code_interpreter", "code-execution"].includes(item),
    ) || fallback.supportsCodeExecution);

  const supportsStructuredOutputs =
    booleanValue(
      model.supports_structured_outputs,
      model.supportsStructuredOutputs,
      upstreamCapabilities.structured_outputs,
      upstreamCapabilities.structuredOutputs,
    ) ?? fallback.supportsStructuredOutputs;

  const maxOutputTokens =
    firstPositiveNumber(
      model.max_output_tokens,
      model.maxOutputTokens,
      model.max_tokens,
      metadata.max_output_tokens,
      metadata.maxOutputTokens,
      metadata.max_summary_generation_length,
      metadata.maxSummaryGenerationLength,
      metadata.max_generation_length,
      metadata.maxGenerationLength,
      upstreamCapabilities.max_output_tokens,
      upstreamCapabilities.maxOutputTokens,
      upstreamCapabilities.max_summary_generation_length,
      upstreamCapabilities.maxSummaryGenerationLength,
      upstreamCapabilities.max_generation_length,
      upstreamCapabilities.maxGenerationLength,
    ) ?? fallback.maxOutputTokens;

  const explicitThinkingTokens = firstPositiveNumber(
    model.max_thinking_tokens,
    model.maxThinkingTokens,
    metadata.max_thinking_tokens,
    metadata.maxThinkingTokens,
    metadata.max_thinking_generation_length,
    metadata.maxThinkingGenerationLength,
    upstreamCapabilities.max_thinking_tokens,
    upstreamCapabilities.maxThinkingTokens,
    upstreamCapabilities.max_thinking_generation_length,
    upstreamCapabilities.maxThinkingGenerationLength,
  );
  const maxThinkingTokens =
    explicitThinkingTokens ??
    (supportsThinking ? maxOutputTokens : 0) ??
    fallback.maxThinkingTokens;

  const canSkipThinking =
    supportsThinking &&
    (booleanValue(
      thinkSkip.enable,
      model.can_skip_thinking,
      model.canSkipThinking,
      upstreamCapabilities.can_skip_thinking,
      upstreamCapabilities.canSkipThinking,
    ) ??
      fallback.canSkipThinking);

  const isActive =
    booleanValue(model.is_active, model.isActive, info.is_active, metadata.is_active) ??
    fallback.isActive;

  const contextWindow = firstPositiveNumber(
    model.context_window,
    model.contextWindow,
    model.max_context_length,
    metadata.max_context_length,
    metadata.maxContextLength,
    metadata.context_window,
    metadata.contextWindow,
    upstreamCapabilities.max_context_length,
    upstreamCapabilities.context_window,
  );

  return {
    contextWindow,
    capabilities: {
      maxOutputTokens,
      maxThinkingTokens,
      supportsThinking,
      supportsVision,
      canSkipThinking,
      supportsDocument,
      supportsAudio,
      supportsVideo,
      supportsCitations,
      supportsCodeExecution,
      supportsStructuredOutputs,
      modalities,
      chatTypes,
      mcp,
      isActive,
    },
  };
}

export function setModelContextWindow(
  modelId: string,
  contextWindow: number,
  accountId?: string,
): void {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
  const entry = getOrCreateEntry(modelId, accountId);
  entry.contextWindow = contextWindow;
  entry.raw.id = getBaseModelId(modelId);
}

export function getModelContextWindow(
  modelId: string,
  accountId?: string,
): number {
  return getEntry(modelId, accountId)?.contextWindow ?? defaultContextWindow;
}

export function getModelContextWindowSource(
  modelId: string,
  accountId?: string,
): "upstream" | "registry" | "default" {
  return getEntry(modelId, accountId)?.contextWindow !== undefined
    ? "upstream"
    : "default";
}

export function getModelCapabilities(
  modelId: string,
  accountId?: string,
): ModelCapabilities {
  const capabilities = getEntry(modelId, accountId)?.capabilities;
  return cloneCapabilities(capabilities ?? defaultCapabilities);
}

export function getModelMetadata(
  modelId: string,
  accountId?: string,
): RegisteredModelMetadata | undefined {
  const entry = getEntry(modelId, accountId);
  if (!entry) return undefined;
  return {
    id: getBaseModelId(modelId),
    contextWindow: entry.contextWindow,
    capabilities: cloneCapabilities(entry.capabilities),
    raw: { ...entry.raw },
  };
}

/** Update one model's live metadata without changing other accounts. */
export function setModelCapabilities(
  modelId: string,
  capabilities: Partial<ModelCapabilities>,
  accountId?: string,
): void {
  const entry = getOrCreateEntry(modelId, accountId);
  const current = entry.capabilities;
  entry.capabilities = {
    ...current,
    ...capabilities,
    modalities: capabilities.modalities
      ? [...capabilities.modalities]
      : [...current.modalities],
    chatTypes: capabilities.chatTypes
      ? [...capabilities.chatTypes]
      : [...current.chatTypes],
    mcp: capabilities.mcp ? [...capabilities.mcp] : [...current.mcp],
  };
}

/**
 * Sync the context windows exposed directly by an upstream model list.
 * Prefer `syncModelMetadata` when the complete Qwen response is available.
 */
export function syncModelContextWindows(
  models: Array<Record<string, unknown> & { id: string }>,
  accountId?: string,
): void {
  for (const model of models) {
    const { contextWindow } = deriveCapabilities(model, undefined);
    if (contextWindow !== undefined) {
      setModelContextWindow(model.id, contextWindow, accountId);
    }
  }
}

/**
 * Normalize and store the complete metadata returned by Qwen's `/api/models`.
 * The raw object is retained in the account-scoped registry so new metadata
 * fields remain available to future adapters instead of being discarded here.
 */
export function syncModelMetadata(
  models: Array<Record<string, unknown> & { id: string }>,
  accountId?: string,
): void {
  const registry = getAccountRegistry(accountId);

  for (const model of models) {
    if (!model || typeof model.id !== "string" || !model.id.trim()) continue;

    const baseId = getBaseModelId(model.id);
    const existing = registry.get(baseId);
    const derived = deriveCapabilities(model, existing?.capabilities);
    const entry: RegistryEntry = {
      contextWindow: derived.contextWindow ?? existing?.contextWindow,
      capabilities: derived.capabilities,
      raw: { ...model },
    };
    registry.set(baseId, entry);
  }
}

/** Replace one account's complete live catalog after a successful upstream fetch. */
export function replaceModelMetadata(
  models: Array<Record<string, unknown> & { id: string }>,
  accountId?: string,
): void {
  modelRegistryByAccount.delete(accountKey(accountId));
  syncModelMetadata(models, accountId);
}

/** Strip the public Fast suffix from a model ID. */
export function stripFastSuffix(modelId: string): string {
  return modelId.replace(/-fast$/, "");
}

/**
 * Whether Qwen's metadata says a thinking-capable model cannot disable
 * thinking through its native `think_skip` flag. This is metadata only; the
 * public `-fast` variant is still exposed for every catalog model.
 */
export function isAlwaysThinkingModel(
  modelId: string,
  accountId?: string,
): boolean {
  const capabilities = getModelCapabilities(modelId, accountId);
  return capabilities.supportsThinking && !capabilities.canSkipThinking;
}
