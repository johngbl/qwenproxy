import type { Context } from "hono";
import { generateImage } from "../services/media-generation.ts";
import { logger } from "../core/logger.ts";
import { sendOpenAIError } from "../api/error-helpers.ts";
import { ValidationError } from "../core/errors.ts";

const DEFAULT_MODEL = "qwen3-vl-plus";
const DEFAULT_SIZE = "1024x1024";

const VALID_SIZES = new Set([
  "1024x1024",
  "1792x1024",
  "1024x1792",
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "auto",
]);

interface ImageDataItem {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

interface ImagesGenerationsRequest {
  model?: unknown;
  prompt?: unknown;
  n?: unknown;
  size?: unknown;
  /** Accepted for OpenAI compatibility but ignored — Qwen has no quality parameter. */
  quality?: unknown;
  response_format?: unknown;
}

function validationError(message: string, param: string): ValidationError {
  const err = new ValidationError(message);
  err.param = param;
  return err;
}

async function urlToBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download generated image: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("base64");
}

export async function imagesGenerations(c: Context): Promise<Response> {
  let body: ImagesGenerationsRequest;
  try {
    body = await c.req.json();
  } catch {
    return sendOpenAIError(c, new ValidationError("Request body must be valid JSON"));
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return sendOpenAIError(
      c,
      validationError("`prompt` must be a non-empty string", "prompt"),
    );
  }

  const n = body.n === undefined ? 1 : body.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    return sendOpenAIError(c, validationError("`n` must be a positive integer", "n"));
  }

  const size = body.size === undefined ? DEFAULT_SIZE : body.size;
  if (typeof size !== "string" || !VALID_SIZES.has(size)) {
    return sendOpenAIError(
      c,
      validationError(`\`size\` must be one of: ${[...VALID_SIZES].join(", ")}`, "size"),
    );
  }

  const responseFormat = body.response_format ?? "url";
  if (responseFormat !== "url" && responseFormat !== "b64_json") {
    return sendOpenAIError(
      c,
      validationError('`response_format` must be "url" or "b64_json"', "response_format"),
    );
  }

  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : DEFAULT_MODEL;

  logger.info("Image generation request", {
    model,
    n,
    size,
    response_format: responseFormat,
  });

  try {
    const results = await Promise.all(
      Array.from({ length: n }, () => generateImage({ model, prompt, size })),
    );

    const data: ImageDataItem[] = await Promise.all(
      results.map(async (result): Promise<ImageDataItem> => {
        const item: ImageDataItem =
          responseFormat === "b64_json"
            ? { b64_json: await urlToBase64(result.url) }
            : { url: result.url };
        if (result.revised_prompt) {
          item.revised_prompt = result.revised_prompt;
        }
        return item;
      }),
    );

    logger.info("Image generation completed", { model, n });
    return c.json({ created: Math.floor(Date.now() / 1000), data });
  } catch (error) {
    logger.error("Image generation failed", {
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    return sendOpenAIError(c, error, 500);
  }
}
