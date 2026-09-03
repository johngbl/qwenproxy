import { createHash } from "crypto";
import { Hono } from "hono";
import { fetchQwenModels } from "../services/qwen.js";
import { loadAccounts } from "../core/accounts.ts";
import { getAccountCooldownInfo } from "../core/account-manager.ts";
import { getAccountsByPriority } from "../core/account-priority.ts";
import { NotFoundError } from "../core/errors.js";
import { sendOpenAIError } from "./error-helpers.js";
import {
  getModelCapabilities,
  getModelContextWindow,
  syncModelMetadata,
} from "../core/model-registry.ts";
import { listMediaGenerationModels } from "../services/media-generation.ts";
import { isPlaywrightInitialized } from "../services/playwright.ts";

const app = new Hono();

/**
 * Stable creation timestamp for synthetic media models.
 * Uses a fixed value so the ETag remains stable across requests.
 * 2025-01-01T00:00:00Z
 */
const MEDIA_MODELS_CREATED_AT = 1735689600;

function getPreferredModelsAccountId(): string | undefined {
  try {
    const accounts = loadAccounts();
    if (accounts.length === 0) return undefined;

    // Prefer an account whose browser is already open so the models fetch
    // reuses the running session instead of launching a new browser for a
    // standby account. Among usable accounts, follow the same priority
    // order as request routing.
    const usable = getAccountsByPriority(accounts).filter(
      (account) => !getAccountCooldownInfo(account.id),
    );
    const initialized = usable.find((account) =>
      isPlaywrightInitialized(account.id),
    );
    return (initialized || usable[0] || accounts[0]).id;
  } catch {
    return undefined;
  }
}

export type PublicModel = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  context_window?: number;
  is_active?: boolean;
  capabilities?: Record<string, unknown>;
  [key: string]: unknown;
};

function baseModelId(modelId: string): string {
  // Only `-fast` is public. Strip legacy suffixes as well so a stale or
  // mixed upstream catalog cannot create duplicate public model entries.
  return modelId.replace(/-(?:fast|no-thinking|thinking)$/, "");
}

/**
 * Expand the public reasoning variants from the selected account's live
 * catalog. The upstream list is normalized first, so this function is the
 * sole owner of synthetic variants and cannot create nested/duplicate
 * suffixes.
 *
 * Qwen's web client always has a Thinking base and a Fast mode. Publish the
 * Fast alias for every catalog model, even when older metadata does not
 * include `think_skip`.
 */
export function expandModelVariants(
  models: PublicModel[],
  accountId?: string,
): PublicModel[] {
  syncModelMetadata(
    models as unknown as Array<Record<string, unknown> & { id: string }>,
    accountId,
  );
  const baseModels = new Map<string, PublicModel>();

  for (const model of models) {
    if (!model?.id) continue;
    const baseId = baseModelId(model.id);
    if (!baseModels.has(baseId)) {
      baseModels.set(baseId, {
        ...model,
        id: baseId,
        object: "model",
      });
    }
  }

  const variants = new Map<string, PublicModel>();
  for (const model of baseModels.values()) {
    const addVariant = (suffix: string, nameSuffix: string) => {
      const id = `${model.id}${suffix}`;
      if (variants.has(id)) return;
      variants.set(id, {
        ...model,
        id,
        name:
          typeof model.name === "string"
            ? `${model.name}${nameSuffix}`
            : `${model.id}${nameSuffix}`,
        object: "model",
      });
    };

    if (!variants.has(model.id)) variants.set(model.id, model);
    addVariant("-fast", " (Fast)");
    addVariant("-thinking", " (Thinking)");
  }

  return [...variants.values()];
}

function toAnthropicModel(model: PublicModel, accountId?: string) {
  const capabilities = getModelCapabilities(model.id, accountId);
  const isFastVariant = model.id.endsWith("-fast");
  const contextWindow =
    model.context_window ?? getModelContextWindow(model.id, accountId);

  return {
    id: model.id,
    display_name:
      typeof model.name === "string" && model.name ? model.name : model.id,
    created_at: new Date(
      typeof model.created === "number" ? model.created * 1000 : Date.now(),
    ).toISOString(),
    max_input_tokens: contextWindow,
    max_tokens: capabilities.maxOutputTokens,
    type: "model" as const,
    capabilities: {
      batch: { supported: false },
      citations: { supported: capabilities.supportsCitations },
      code_execution: { supported: capabilities.supportsCodeExecution },
      image_input: { supported: capabilities.supportsVision },
      pdf_input: { supported: capabilities.supportsDocument },
      structured_outputs: {
        supported: capabilities.supportsStructuredOutputs,
      },
      thinking: {
        supported: capabilities.supportsThinking,
        types: {
          enabled: { supported: capabilities.supportsThinking },
          disabled: {
            supported: isFastVariant || capabilities.canSkipThinking,
          },
        },
      },
      audio_input: { supported: capabilities.supportsAudio },
      video_input: { supported: capabilities.supportsVideo },
    },
  };
}

function wantsAnthropicModelsFormat(
  anthropicVersion: string | undefined | null,
): boolean {
  return !!anthropicVersion;
}

async function loadModelsWithVariants(): Promise<{
  models: PublicModel[];
  accountId?: string;
}> {
  const accountId = getPreferredModelsAccountId();
  const models = (await fetchQwenModels(accountId)) as unknown as PublicModel[];
  const expanded = expandModelVariants(models, accountId);

  // Advertise media generation models so clients can discover them via
  // /v1/models, including their supported generation modalities. Annotate a
  // live model in place when Qwen already returned the same ID.
  const mediaDefinitions = listMediaGenerationModels();
  const mediaById = new Map(mediaDefinitions.map((definition) => [definition.id, definition]));
  const expandedWithMedia = expanded.map((model) => {
    const definition = mediaById.get(model.id);
    if (!definition) return model;
    return {
      ...model,
      media_generation: definition.kind,
      media_modes: definition.modes,
      media_reference_required: definition.modes.every(
        (mode) => mode === "i2i" || mode === "i2v",
      ),
    };
  });
  const existing = new Set(expanded.map((model) => model.id));
  const mediaModels: PublicModel[] = mediaDefinitions
    .filter(({ id }) => !existing.has(id))
    .map(({ id, kind, modes }) => ({
      id,
      object: "model",
      created: MEDIA_MODELS_CREATED_AT,
      owned_by: "qwen",
      media_generation: kind,
      media_modes: modes,
      media_reference_required: modes.every(
        (mode) => mode === "i2i" || mode === "i2v",
      ),
    }));

  return {
    models: [...expandedWithMedia, ...mediaModels],
    accountId,
  };
}

function findModel(
  models: PublicModel[],
  modelId: string,
): PublicModel | undefined {
  // Variants are materialized by expandModelVariants only when the live
  // catalog says they are supported. Do not synthesize an invalid variant for
  // a direct lookup.
  return models.find((entry) => entry.id === modelId);
}

app.get("/v1/models", async (c) => {
  try {
    const { models: allModels, accountId } = await loadModelsWithVariants();
    const anthropic = wantsAnthropicModelsFormat(c.req.header("anthropic-version"));

    if (anthropic) {
      return c.json({
        data: allModels.map((model) => toAnthropicModel(model, accountId)),
        has_more: false,
      });
    }

    const etag = `"${createHash("md5").update(JSON.stringify(allModels)).digest("hex")}"`;

    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }

    c.header("Cache-Control", "public, max-age=3600");
    c.header("ETag", etag);

    return c.json({
      object: "list",
      data: allModels,
    });
  } catch (error) {
    console.error("❌ [Models] Error fetching models:", error);
    return sendOpenAIError(c, error);
  }
});

app.get("/v1/models/:model", async (c) => {
  try {
    const modelId = c.req.param("model");
    const { models: allModels, accountId } = await loadModelsWithVariants();
    const model = findModel(allModels, modelId);
    const anthropic = wantsAnthropicModelsFormat(c.req.header("anthropic-version"));

    if (!model) {
      if (anthropic) {
        return c.json(
          {
            type: "error",
            error: {
              type: "not_found_error",
              message: `Model '${modelId}' not found`,
            },
          },
          404,
        );
      }
      return sendOpenAIError(c, new NotFoundError("Model not found"));
    }

    if (anthropic) {
      return c.json(toAnthropicModel(model, accountId));
    }

    return c.json(model);
  } catch (error) {
    console.error("❌ [Models] Error fetching model:", error);
    return sendOpenAIError(c, error);
  }
});


export { app };
