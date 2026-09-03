import crypto from "crypto";
import { Hono, type Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import { config } from "../../core/config.ts";
import { validateAnthropicRequest } from "./validation.ts";
import {
  translateAnthropicToOpenAI,
  translateOpenAIToAnthropic,
  translateStreamChunk,
  generateMessageId,
  type AnthropicStreamState,
} from "./translate.ts";
import type { AnthropicRequest, OpenAIResponse } from "./types.ts";
import { estimateTokenCount } from "../../utils/context-truncation.ts";

const app = new Hono();

function generateRequestId(): string {
  return `req_${crypto.randomBytes(12).toString("hex")}`;
}

export function anthropicError(
  c: Context,
  type: string,
  message: string,
  statusCode: number,
) {
  c.header("anthropic-version", c.req.header("anthropic-version") || "2023-06-01");
  return c.json(
    {
      type: "error",
      error: { type, message },
      request_id: generateRequestId(),
    },
    statusCode as any,
  );
}

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

export function verifyAnthropicApiKey(c: Context): boolean {
  const apiKey = process.env.API_KEY || config.apiKey;
  if (!apiKey) return true; // No key configured = open access

  const candidates: string[] = [];
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) candidates.push(token);
  }
  const xApiKey = c.req.header("x-api-key")?.trim();
  if (xApiKey) candidates.push(xApiKey);

  if (candidates.length === 0) return false;
  return candidates.some((key) => constantTimeStringEqual(key, apiKey));
}

/**
 * POST /v1/messages - Anthropic Messages API compatible endpoint.
 */
app.post("/v1/messages", async (c) => {
  const requestId = generateRequestId();
  const anthropicVersion = c.req.header("anthropic-version") || "2023-06-01";

  // 1. Verify API key
  if (!verifyAnthropicApiKey(c)) {
    return anthropicError(c, "authentication_error", "Invalid API key", 401);
  }

  // 2. Parse & Validate body
  let body: AnthropicRequest;
  try {
    body = await c.req.json();
  } catch {
    return anthropicError(c, "invalid_request_error", "Invalid JSON body", 400);
  }

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
    // 3. Translate Anthropic request to internal OpenAI format
    const openaiRequest = translateAnthropicToOpenAI(body);

    const dispatchToChat = (streamMode: boolean) =>
      fetch(`http://127.0.0.1:${config.server.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.API_KEY || config.apiKey || ""}`,
        },
        body: JSON.stringify({
          ...openaiRequest,
          stream: streamMode,
          ...(streamMode ? { stream_options: { include_usage: true } } : {}),
        }),
        signal: c.req.raw.signal,
      });

    if (isStream) {
      // ============ STREAMING MODE ============
      c.header("Content-Type", "text/event-stream; charset=utf-8");
      c.header("Cache-Control", "no-cache, no-transform");
      c.header("Connection", "keep-alive");
      c.header("anthropic-version", anthropicVersion);
      c.header("request-id", requestId);

      return honoStream(c, async (stream) => {
        const encoder = new TextEncoder();
        const write = async (data: string) => {
          await stream.write(encoder.encode(data));
        };

        const messageId = generateMessageId();
        const state: AnthropicStreamState = {
          contentBlockIndex: 0,
          currentBlockType: null,
          currentToolId: null,
          currentToolIndex: null,
          requestModel,
          inputTokens: 0,
          outputTokens: 0,
          hasEmittedToolUse: false,
        };

        // Emit initial message_start event
        const messageStart = {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            content: [],
            model: requestModel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 1 },
          },
        };
        await write(
          `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`,
        );

        // Keep-alive heartbeat
        const heartbeatInterval = setInterval(() => {
          write(": keep-alive\n\n").catch(() => clearInterval(heartbeatInterval));
        }, 15000);

        try {
          const response = await dispatchToChat(true);

          if (!response.ok) {
            clearInterval(heartbeatInterval);
            const errText = await response.text().catch(() => "");
            console.error(`[Anthropic] Upstream error: ${response.status} ${errText}`);
            await write(
              `event: error\ndata: ${JSON.stringify({
                type: "error",
                error: {
                  type: response.status === 429 ? "rate_limit_error" : "api_error",
                  message: `Upstream error: ${response.status}`,
                },
              })}\n\n`,
            );
            return;
          }

          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error("No response body from internal chat stream");
          }

          const decoder = new TextDecoder();
          let buffer = "";

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data: ")) continue;
                const dataStr = trimmed.slice(6);
                if (dataStr === "[DONE]") continue;

                try {
                  const chunk = JSON.parse(dataStr);
                  const events = translateStreamChunk(chunk, state);
                  for (const event of events) {
                    const parsed = JSON.parse(event);
                    await write(`event: ${parsed.type}\ndata: ${event}\n\n`);
                  }
                } catch {
                  // Skip invalid JSON lines
                }
              }
            }
          } finally {
            reader.releaseLock();
          }

          // Close any remaining open content block before ending message
          if (state.currentBlockType !== null) {
            await write(
              `event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: state.contentBlockIndex,
              })}\n\n`,
            );
            state.contentBlockIndex++;
            state.currentBlockType = null;
          }

          // Emit final message_stop
          await write(
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
          );
        } catch (error: any) {
          console.error("❌ [Anthropic] Stream error:", error?.message || error);
          try {
            await write(
              `event: error\ndata: ${JSON.stringify({
                type: "error",
                error: { type: "api_error", message: error?.message || "Stream error" },
              })}\n\n`,
            );
          } catch {
            // Client closed connection
          }
        } finally {
          clearInterval(heartbeatInterval);
        }
      });
    } else {
      // ============ NON-STREAMING MODE ============
      const response = await dispatchToChat(false);

      if (!response.ok) {
        const errorJson = await response.json().catch(() => null);
        const errorText = errorJson?.error?.message || `HTTP ${response.status}`;
        console.error(`[Anthropic] Upstream error: ${response.status} ${errorText}`);

        const errorType =
          response.status === 429
            ? "rate_limit_error"
            : response.status === 404
              ? "not_found_error"
              : response.status === 400
                ? "invalid_request_error"
                : "api_error";

        return anthropicError(c, errorType, errorText, response.status);
      }

      const openaiResponse: OpenAIResponse = await response.json();
      const anthropicResponse = translateOpenAIToAnthropic(
        openaiResponse,
        requestModel,
      );

      console.log(
        `[Anthropic] Response | ${anthropicResponse.usage.input_tokens} prompt / ${anthropicResponse.usage.output_tokens} completion | stop=${anthropicResponse.stop_reason}`,
      );

      c.header("anthropic-version", anthropicVersion);
      c.header("request-id", requestId);

      return c.json(anthropicResponse);
    }
  } catch (error: any) {
    console.error("❌ [Anthropic] Error:", error);
    return anthropicError(
      c,
      "api_error",
      error?.message || "Internal server error",
      500,
    );
  }
});

/**
 * POST /v1/messages/count_tokens - Anthropic Token Counting API.
 */
app.post("/v1/messages/count_tokens", async (c) => {
  if (!verifyAnthropicApiKey(c)) {
    return anthropicError(c, "authentication_error", "Invalid API key", 401);
  }

  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object") {
      return anthropicError(c, "invalid_request_error", "Request body must be a JSON object", 400);
    }

    let textToCount = "";
    if (typeof body.system === "string") {
      textToCount += body.system + " ";
    } else if (Array.isArray(body.system)) {
      textToCount += body.system.map((s: any) => s?.text || "").join(" ") + " ";
    }

    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (typeof m.content === "string") {
          textToCount += m.content + " ";
        } else if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.text) textToCount += b.text + " ";
            if (b?.content) textToCount += (typeof b.content === "string" ? b.content : JSON.stringify(b.content)) + " ";
          }
        }
      }
    }

    if (Array.isArray(body.tools)) {
      textToCount += JSON.stringify(body.tools);
    }

    const inputTokens = Math.max(1, estimateTokenCount(textToCount));

    c.header("anthropic-version", c.req.header("anthropic-version") || "2023-06-01");
    return c.json({
      input_tokens: inputTokens,
    });
  } catch {
    return anthropicError(c, "invalid_request_error", "Invalid request body", 400);
  }
});

export { app as anthropicApp };
