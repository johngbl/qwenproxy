import { createHash } from "crypto";
import { Hono } from "hono";
import { fetchQwenModels } from "../services/qwen.js";
import { loadAccounts } from "../core/accounts.ts";
import { getAccountCooldownInfo } from "../core/account-manager.ts";
import { NotFoundError } from "../core/errors.js";
import { sendOpenAIError } from "./error-helpers.js";
import {
  syncModelContextWindows,
  getModelCapabilities,
} from "../core/model-registry.ts";

const app = new Hono();

function getPreferredModelsAccountId(): string | undefined {
  try {
    const accounts = loadAccounts();
    const available = accounts.find(
      (account) => !getAccountCooldownInfo(account.id),
    );
    return (available || accounts[0])?.id;
  } catch {
    return undefined;
  }
}

type PublicModel = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  context_window?: number;
  [key: string]: unknown;
};

/** Expand base models with synthetic -thinking / -no-thinking variants. */
export function expandModelVariants(models: PublicModel[]): PublicModel[] {
  return [
    ...models,
    ...models.map((m) => ({
      ...m,
      id: `${m.id}-no-thinking`,
      object: "model",
    })),
    ...models.map((m) => ({
      ...m,
      id: `${m.id}-thinking`,
      object: "model",
    })),
  ];
}

function toAnthropicModel(model: PublicModel) {
  const capabilities = getModelCapabilities(model.id);
  const hasVision = capabilities.supportsVision;
  const hasThinking = capabilities.supportsThinking;
  const canSkipThinking = capabilities.canSkipThinking;

  return {
    id: model.id,
    display_name: model.id,
    created_at: new Date(
      typeof model.created === "number" ? model.created * 1000 : Date.now(),
    ).toISOString(),
    max_input_tokens: model.context_window ?? 200000,
    max_tokens: capabilities.maxOutputTokens,
    type: "model" as const,
    capabilities: {
      batch: { supported: false },
      citations: { supported: false },
      code_execution: { supported: false },
      image_input: { supported: hasVision },
      pdf_input: { supported: false },
      structured_outputs: { supported: true },
      thinking: {
        supported: hasThinking,
        types: { enabled: { supported: canSkipThinking } },
      },
    },
  };
}

function wantsAnthropicModelsFormat(
  anthropicVersion: string | undefined | null,
): boolean {
  return !!anthropicVersion;
}

async function loadModelsWithVariants(): Promise<PublicModel[]> {
  const models = (await fetchQwenModels(
    getPreferredModelsAccountId(),
  )) as unknown as PublicModel[];
  syncModelContextWindows(models);
  return expandModelVariants(models);
}

function findModel(
  models: PublicModel[],
  modelId: string,
): PublicModel | undefined {
  let model = models.find((entry) => entry.id === modelId);
  if (model) return model;

  const isNoThinkingVariant = modelId.endsWith("-no-thinking");
  const isThinkingVariant = modelId.endsWith("-thinking");
  if (!isNoThinkingVariant && !isThinkingVariant) return undefined;

  const baseId = isNoThinkingVariant
    ? modelId.slice(0, -"-no-thinking".length)
    : modelId.slice(0, -"-thinking".length);
  const baseModel = models.find((entry) => entry.id === baseId);
  if (!baseModel) return undefined;

  return {
    ...baseModel,
    id: modelId,
    object: "model",
  };
}

app.get("/v1/models", async (c) => {
  try {
    const allModels = await loadModelsWithVariants();
    const anthropic = wantsAnthropicModelsFormat(c.req.header("anthropic-version"));

    if (anthropic) {
      return c.json({
        data: allModels.map(toAnthropicModel),
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
    const allModels = await loadModelsWithVariants();
    const model = findModel(allModels, modelId);

    const anthropic = wantsAnthropicModelsFormat(
      c.req.header("anthropic-version"),
    );

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
      return c.json(toAnthropicModel(model));
    }

    return c.json(model);
  } catch (error) {
    console.error("❌ [Models] Error fetching model:", error);
    return sendOpenAIError(c, error);
  }
});

export { app };
