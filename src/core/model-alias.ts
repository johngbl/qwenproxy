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
 * Mapeia o id de modelo para o Qwen upstream.
 * Ids `qwen*` passam direto (após remover o sufixo de raciocínio); ids de
 * outros provedores (gpt-*, grok-*, etc.) também passam “as-is” — o Codex/Custom
 * provider envia o id Qwen correto, e qualquer id desconhecido deve chegar ao
 * upstream para que este responda um erro claro de modelo, em vez de ser
 * silenciosamente roteado para um tier qualquer.
 */
export function mapClientModelToQwen(model: string): string {
  if (!model) return model;
  return stripThinkingSuffix(model.trim()).baseModel;
}
