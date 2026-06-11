import crypto from "crypto";
import { Hono, type Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import { config } from "../../core/config.js";
import { validateAnthropicRequest } from "./validation.js";
import {
  translateAnthropicToOpenAI,
  translateOpenAIToAnthropic,
  translateStreamChunk,
} from "./translate.js";
import type { AnthropicRequest, OpenAIResponse } from "./types.js";

const app = new Hono();

/**
 * Generate Anthropic-style request ID
 */
function generateRequestId(): string {
  return `req_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Generate Anthropic-style message ID
 */
function generateMessageId(): string {
  return `msg_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Anthropic error response helper
 */
function anthropicError(
  c: Context,
  type: string,
  message: string,
  statusCode: number,
) {
  return c.json(
    {
      type: "error",
      error: { type, message },
      request_id: generateRequestId(),
    },
    statusCode as any,
  );
}

/**
 * Verify Anthropic API key
 */
function constantTimeStringEqual(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  const providedHash = crypto.createHash("sha256").update(providedBuf).digest();
  const expectedHash = crypto.createHash("sha256").update(expectedBuf).digest();

  return (
    crypto.timingSafeEqual(providedHash, expectedHash) &&
    providedBuf.length === expectedBuf.length
  );
}

function verifyAnthropicApiKey(c: Context): boolean {
  const apiKey = process.env.API_KEY || config.apiKey;
  if (!apiKey) return true; // No key configured = open access

  const providedKey = c.req.header("x-api-key");
  if (!providedKey) return false;

  return constantTimeStringEqual(providedKey, apiKey);
}

/**
 * GET /v1/models - List available models (Anthropic format)
 */
app.get("/v1/models", async (c) => {
  try {
    const { fetchQwenModels } = await import("../../services/qwen.js");

    // Check if we should return Anthropic format
    const anthropicVersion = c.req.header("anthropic-version");
    const isAnthropicFormat = !!anthropicVersion;

    const models = await fetchQwenModels();

    if (isAnthropicFormat) {
      // Return Anthropic format
      return c.json({
        data: models.map((m: any) => ({
          id: m.id,
          display_name: m.id,
          created_at: new Date().toISOString(),
          max_input_tokens: 200000,
          max_tokens: 8192,
          type: "model" as const,
          capabilities: {
            batch: { supported: false },
            citations: { supported: false },
            code_execution: { supported: false },
            image_input: { supported: true },
            pdf_input: { supported: false },
            structured_outputs: { supported: true },
            thinking: {
              supported: true,
              types: { enabled: { supported: true } },
            },
          },
        })),
        has_more: false,
      });
    } else {
      // Return OpenAI format (existing behavior)
      return c.json({
        object: "list",
        data: models,
      });
    }
  } catch (error) {
    console.error("[Anthropic] Error fetching models:", error);
    return anthropicError(c, "api_error", "Failed to fetch models", 500);
  }
});

/**
 * GET /v1/models/:model_id - Get specific model
 */
app.get("/v1/models/:model_id", async (c) => {
  const modelId = c.req.param("model_id");

  try {
    const { fetchQwenModels } = await import("../../services/qwen.js");
    const models = await fetchQwenModels();
    const model = models.find((m: any) => m.id === modelId);

    if (!model) {
      return anthropicError(
        c,
        "not_found_error",
        `Model '${modelId}' not found`,
        404,
      );
    }

    return c.json({
      id: model.id,
      display_name: model.id,
      created_at: new Date().toISOString(),
      max_input_tokens: 200000,
      max_tokens: 8192,
      type: "model" as const,
    });
  } catch (error) {
    console.error("[Anthropic] Error fetching model:", error);
    return anthropicError(c, "api_error", "Failed to fetch model", 500);
  }
});

/**
 * POST /v1/messages - Create a message (Anthropic format)
 */
app.post("/v1/messages", async (c) => {
  const requestId = generateRequestId();

  // Verify API key
  if (!verifyAnthropicApiKey(c)) {
    return anthropicError(c, "authentication_error", "Invalid API key", 401);
  }

  // Verify anthropic-version header
  const anthropicVersion = c.req.header("anthropic-version");
  if (!anthropicVersion) {
    return anthropicError(
      c,
      "invalid_request_error",
      "Missing 'anthropic-version' header",
      400,
    );
  }

  let body: AnthropicRequest;
  try {
    body = await c.req.json();
  } catch {
    return anthropicError(c, "invalid_request_error", "Invalid JSON body", 400);
  }

  // Validate request
  const validation = validateAnthropicRequest(body);
  if (!validation.valid) {
    return anthropicError(c, "invalid_request_error", validation.error!, 400);
  }

  const isStream = body.stream ?? false;
  const requestModel = body.model;

  console.log(
    `[Anthropic] Request | ${requestModel} | ${body.messages.length} msg(s)${body.tools ? ` | ${body.tools.length} tool(s)` : ""}${isStream ? " | stream" : ""}`,
  );

  try {
    // Translate Anthropic request to OpenAI format
    const openaiRequest = translateAnthropicToOpenAI(body);
    openaiRequest.stream = false; // We handle streaming ourselves

    // Import and use the existing chat completion logic
    const { chatCompletions: processChatCompletion } =
      await import("../../routes/chat.js");

    if (isStream) {
      // Streaming mode
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      c.header("anthropic-version", anthropicVersion);
      c.header("request-id", requestId);

      return honoStream(c, async (stream) => {
        const encoder = new TextEncoder();
        const write = async (data: string) => {
          await stream.write(encoder.encode(data));
        };

        // Send message_start event
        const messageStart = {
          type: "message_start",
          message: {
            id: generateMessageId(),
            type: "message",
            role: "assistant",
            content: [],
            model: requestModel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        };
        await write(
          `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`,
        );

        const state = {
          contentBlockIndex: 0,
          currentBlockType: null as string | null,
          requestModel,
          inputTokens: 0,
        };

        // Timeout handler
        const timeoutMs = 300000; // 5 minutes
        let timeoutId: NodeJS.Timeout | null = null;
        let isDone = false;

        const resetTimeout = () => {
          if (timeoutId) clearTimeout(timeoutId);
          timeoutId = setTimeout(() => {
            if (!isDone) {
              console.error("[Anthropic] Stream timeout");
              stream.close().catch(() => {});
            }
          }, timeoutMs);
        };

        try {
          // Make the actual request to Qwen
          const controller = new AbortController();
          const response = await fetch(
            `http://127.0.0.1:${config.server.port}/v1/chat/completions`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.API_KEY || config.apiKey || ""}`,
              },
              body: JSON.stringify({ ...openaiRequest, stream: true }),
              signal: controller.signal,
            },
          );

          if (!response.ok) {
            const errorText = await response.text();
            console.error(
              `[Anthropic] Upstream error: ${response.status} ${errorText}`,
            );
            await write(
              `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream service error" } })}\n\n`,
            );
            return;
          }

          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error("No response body");
          }

          const decoder = new TextDecoder();
          let responseBuffer = "";
          resetTimeout();

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              resetTimeout();
              responseBuffer += decoder.decode(value, { stream: true });
              const lines = responseBuffer.split("\n");
              responseBuffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6);
                if (data === "[DONE]") continue;

                try {
                  const chunk = JSON.parse(data);
                  const events = translateStreamChunk(chunk, state);

                  for (const event of events) {
                    await write(
                      `event: ${JSON.parse(event).type}\ndata: ${event}\n\n`,
                    );
                  }
                } catch {
                  // Ignore parse errors
                }
              }
            }
          } finally {
            reader.releaseLock();
          }

          isDone = true;
          if (timeoutId) clearTimeout(timeoutId);

          // Send message_stop event
          await write(
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
          );
        } catch (error) {
          isDone = true;
          if (timeoutId) clearTimeout(timeoutId);
          console.error("[Anthropic] Stream error:", error);
          try {
            await write(
              `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "Stream error" } })}\n\n`,
            );
          } catch {
            // Client disconnected
          }
        }
      });
    } else {
      // Non-streaming mode
      const response = await fetch(
        `http://127.0.0.1:${config.server.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.API_KEY || config.apiKey || ""}`,
          },
          body: JSON.stringify(openaiRequest),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[Anthropic] Upstream error: ${response.status} ${errorText}`,
        );
        return anthropicError(c, "api_error", "Upstream service error", 502);
      }

      const openaiResponse: OpenAIResponse = await response.json();
      const anthropicResponse = translateOpenAIToAnthropic(
        openaiResponse,
        requestModel,
      );

      console.log(
        `[Anthropic] Response | ${anthropicResponse.usage.input_tokens} prompt / ${anthropicResponse.usage.output_tokens} completion`,
      );

      c.header("anthropic-version", anthropicVersion);
      c.header("request-id", requestId);

      return c.json(anthropicResponse);
    }
  } catch (error) {
    console.error("[Anthropic] Error:", error);
    return anthropicError(c, "api_error", "Internal server error", 500);
  }
});

/**
 * POST /v1/messages/count_tokens - Count tokens
 */
app.post("/v1/messages/count_tokens", async (c) => {
  // Verify API key
  if (!verifyAnthropicApiKey(c)) {
    return anthropicError(c, "authentication_error", "Invalid API key", 401);
  }

  try {
    const body = await c.req.json();

    // Simple estimation: ~4 chars per token
    const text = JSON.stringify(body.messages || []);
    const estimatedTokens = Math.ceil(text.length / 4);

    return c.json({
      input_tokens: estimatedTokens,
    });
  } catch {
    return anthropicError(c, "invalid_request_error", "Invalid request", 400);
  }
});

export { app as anthropicApp };
