import { createHash } from "crypto";
import { Hono } from "hono";
import { fetchQwenModels } from "../services/qwen.js";
import { loadAccounts } from "../core/accounts.ts";
import { getAccountCooldownInfo } from "../core/account-manager.ts";
import { NotFoundError } from "../core/errors.js";
import { sendOpenAIError } from "./error-helpers.js";
import { syncModelContextWindows } from "../core/model-registry.ts";

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

app.get("/v1/models", async (c) => {
  try {
    const models = await fetchQwenModels(getPreferredModelsAccountId());
    const etag = `"${createHash("md5").update(JSON.stringify(models)).digest("hex")}"`;

    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }

    c.header("Cache-Control", "public, max-age=3600");
    c.header("ETag", etag);

    syncModelContextWindows(models);

    // Generate variants with -no-thinking and -thinking suffixes (upstream: a63f054)
    const allModels = [
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
    const models = await fetchQwenModels(getPreferredModelsAccountId());
    syncModelContextWindows(models);

    // Check for exact match first
    let model = models.find((entry) => entry.id === modelId);

    // If not found, check if it's a -no-thinking or -thinking variant (upstream: a63f054)
    if (!model) {
      const isNoThinkingVariant = modelId.endsWith("-no-thinking");
      const isThinkingVariant = modelId.endsWith("-thinking");

      if (isNoThinkingVariant || isThinkingVariant) {
        const baseId = isNoThinkingVariant
          ? modelId.replace("-no-thinking", "")
          : modelId.replace("-thinking", "");
        const baseModel = models.find((entry) => entry.id === baseId);

        if (baseModel) {
          model = {
            ...baseModel,
            id: modelId,
            object: "model",
          };
        }
      }
    }

    if (!model) {
      return sendOpenAIError(c, new NotFoundError("Model not found"));
    }

    return c.json(model);
  } catch (error) {
    console.error("❌ [Models] Error fetching model:", error);
    return sendOpenAIError(c, error);
  }
});

export { app };
