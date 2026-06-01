import { Hono } from "hono";
import { config } from "../core/config.js";
import { getBasicHeaders } from "../services/playwright.js";

const app = new Hono();

function buildModelsHeaders(cookie: string, userAgent: string, bxV: string) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "pt-BR,pt;q=0.9",
    Connection: "keep-alive",
    Referer: `${config.qwen.baseUrl}/c/demo`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": userAgent,
    "X-Request-Id": crypto.randomUUID(),
    source: "web",
    "bx-v": bxV,
    "sec-ch-ua":
      '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    Timezone: new Date().toString(),
    Cookie: cookie,
  };
}

app.get("/v1/models", async (c) => {
  try {
    const { cookie, userAgent, bxV } = await getBasicHeaders();
    const response = await fetch(`${config.qwen.baseUrl}/api/models`, {
      headers: buildModelsHeaders(cookie, userAgent, bxV),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const data = await response.json();

    const models = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data)
        ? data
        : [];

    const formatted = {
      object: "list",
      data: [
        ...models.map((model: any) => ({
          id: model.id,
          name: model.name,
          object: "model",
          owned_by: model.owned_by,
          created: model.info?.created_at || Date.now(),
          context_window: model.info?.meta?.max_context_length,
          capabilities: model.info?.meta?.capabilities,
        })),
        ...models.map((model: any) => ({
          id: `${model.id}-no-thinking`,
          name: `${model.name} (No Thinking)`,
          object: "model",
          owned_by: model.owned_by,
          created: model.info?.created_at || Date.now(),
          context_window: model.info?.meta?.max_context_length,
          capabilities: model.info?.meta?.capabilities,
        })),
      ],
    };

    return c.json(formatted);
  } catch (error: any) {
    console.error("Error fetching models:", error);
    return c.json({ error: error.message }, 500);
  }
});

app.get("/v1/models/:model", async (c) => {
  try {
    const modelId = c.req.param("model");
    const baseModelId = modelId.replace("-no-thinking", "");
    const { cookie, userAgent, bxV } = await getBasicHeaders();
    const response = await fetch(`${config.qwen.baseUrl}/api/models`, {
      headers: buildModelsHeaders(cookie, userAgent, bxV),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const data = await response.json();
    const models = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data)
        ? data
        : [];
    const model = models.find((m: any) => m.id === baseModelId);

    if (!model) {
      return c.json({ error: "Model not found" }, 404);
    }

    const isNoThinking = modelId.endsWith("-no-thinking");
    return c.json({
      id: modelId,
      name: isNoThinking ? `${model.name} (No Thinking)` : model.name,
      object: "model",
      owned_by: model.owned_by,
      created: model.info?.created_at || Date.now(),
      context_window: model.info?.meta?.max_context_length,
      capabilities: model.info?.meta?.capabilities,
    });
  } catch (error: any) {
    console.error("Error fetching model:", error);
    return c.json({ error: error.message }, 500);
  }
});

export { app };
