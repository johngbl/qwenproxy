/**
 * Modo de raciocínio para modelos Qwen:
 * - "auto": Qwen decide se usa thinking (padrão)
 * - "thinking": força thinking ON
 * - "fast": força thinking OFF
 */
export type ReasoningMode = "auto" | "thinking" | "fast";

/**
 * Resolução de variantes de raciocínio dos modelos Qwen públicos.
 *
 * Mapeamento padronizado de sufixos de esforço de raciocínio:
 * - `-low`: força thinking OFF (Fast)
 * - `-medium`: thinking AUTO (Qwen decide dinamicamente)
 * - `-high`: força thinking ON (Thinking profundo)
 *
 * Sufixos legados (`-fast`, `-thinking`, `-no-thinking`) são mantidos
 * para total compatibilidade regressiva. O modelo base limpo é sempre
 * retornado para o upstream e publicado sem duplicatas em `/v1/models`.
 */
export function stripThinkingSuffix(model: string): {
  baseModel: string;
  enableThinking: boolean;
  reasoningMode: ReasoningMode;
} {
  const normalizedModel = model.trim();

  // Fast / Low path (thinking off)
  if (
    normalizedModel.endsWith("-low") ||
    normalizedModel.endsWith("-fast") ||
    normalizedModel.endsWith("-no-thinking")
  ) {
    return {
      baseModel: normalizedModel.replace(/-(?:low|fast|no-thinking)$/, ""),
      enableThinking: false,
      reasoningMode: "fast",
    };
  }

  // Medium path (auto thinking - Qwen decides dynamically)
  if (normalizedModel.endsWith("-medium")) {
    return {
      baseModel: normalizedModel.slice(0, -"-medium".length),
      enableThinking: true,
      reasoningMode: "auto",
    };
  }

  // High / Thinking path (thinking on)
  if (
    normalizedModel.endsWith("-high") ||
    normalizedModel.endsWith("-thinking")
  ) {
    return {
      baseModel: normalizedModel.replace(/-(?:high|thinking)$/, ""),
      enableThinking: true,
      reasoningMode: "thinking",
    };
  }

  // Default: auto thinking (Qwen decides)
  return { baseModel: normalizedModel, enableThinking: true, reasoningMode: "auto" };
}

/**
 * Mapeia modelos populares de terceiros (OpenAI / Anthropic) para o tier Qwen equivalente:
 * - mini / haiku / 3.5 -> qwen3.7-plus
 * - gpt-4* / o1* / o3* / opus / sonnet / claude-* -> qwen3.8-max
 * Modelos que já começam com "qwen" passam intactos.
 */
export function mapKnownModelAlias(model: string): string {
  if (!model) return model;
  const lower = model.toLowerCase();
  if (lower.startsWith("qwen")) return model;

  // Lightweight / mini models
  if (
    lower.includes("mini") ||
    lower.includes("haiku") ||
    lower.includes("3.5-turbo")
  ) {
    return "qwen3.7-plus";
  }

  // Flagship reasoning / chat models
  if (
    lower.startsWith("gpt-") ||
    lower.startsWith("chatgpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.includes("sonnet") ||
    lower.includes("opus") ||
    lower.startsWith("claude")
  ) {
    return "qwen3.8-max";
  }

  return model;
}

/**
 * Mapeia o id de modelo para o Qwen upstream.
 * Quando enableAliases é verdadeiro (padrão via QWEN_MAP_OPENAI_MODELS),
 * converte gpt-* / o1* / claude-* para os tiers correspondentes do Qwen.
 */
export function mapClientModelToQwen(
  model: string,
  enableAliases = true,
): string {
  if (!model) return model;
  const base = stripThinkingSuffix(model.trim()).baseModel;
  if (enableAliases) {
    return mapKnownModelAlias(base);
  }
  return base;
}
