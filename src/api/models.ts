import { Hono } from "hono";
import { fetchQwenModels } from "../services/qwen.js";

const app = new Hono();
app.get("/v1/models", async (c) => {
  try {
    const models = await fetchQwenModels();

    return c.json({
      object: "list",
      data: models,
    });
  } catch (error: any) {
    console.error("Error fetching models:", error);
    return c.json({ error: error.message }, 500);
  }
});

app.get("/v1/models/:model", async (c) => {
  try {
    const modelId = c.req.param("model");
    const models = await fetchQwenModels();
    const model = models.find((entry) => entry.id === modelId);

    if (!model) {
      return c.json({ error: "Model not found" }, 404);
    }

    return c.json(model);
  } catch (error: any) {
    console.error("Error fetching model:", error);
    return c.json({ error: error.message }, 500);
  }
});

export { app };
