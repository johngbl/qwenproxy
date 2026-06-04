import { createHash } from "crypto";
import { Hono } from "hono";
import { fetchQwenModels } from "../services/qwen.js";
import { NotFoundError } from "../core/errors.js";
import { sendOpenAIError } from "./error-helpers.js";

const app = new Hono();

app.get("/v1/models", async (c) => {
  try {
    const models = await fetchQwenModels();
    const etag = `"${createHash("md5").update(JSON.stringify(models)).digest("hex")}"`;

    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }

    c.header("Cache-Control", "public, max-age=3600");
    c.header("ETag", etag);

    return c.json({
      object: "list",
      data: models,
    });
  } catch (error) {
    console.error("Error fetching models:", error);
    return sendOpenAIError(c, error);
  }
});

app.get("/v1/models/:model", async (c) => {
  try {
    const modelId = c.req.param("model");
    const models = await fetchQwenModels();
    const model = models.find((entry) => entry.id === modelId);

    if (!model) {
      return sendOpenAIError(c, new NotFoundError("Model not found"));
    }

    return c.json(model);
  } catch (error) {
    console.error("Error fetching model:", error);
    return sendOpenAIError(c, error);
  }
});

export { app };
