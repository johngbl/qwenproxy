import { Hono, type Context } from "hono";
import { config } from "../../core/config.ts";
import { validateResponsesRequest } from "./validation.ts";
import {
  responsesToChatCompletions,
  chatCompletionsToResponses,
  buildInProgressResponse,
  finalizeResponse,
  generateResponseId,
  responsesOutputToChatMessages,
} from "./adapter.ts";
import {
  createStreamState,
  processChatChunk,
  buildFinalOutput,
  buildFinalUsage,
} from "./streaming.ts";
import {
  storeResponse,
  getResponseHistory,
  getStoredResponse,
  deleteStoredResponse,
} from "./state.ts";

const app = new Hono();

/**
 * POST /v1/responses - Create a response (OpenAI Responses API format)
 */
app.post("/v1/responses", async (c) => {
  const requestStartedAt = Date.now();

  // Parse and validate request
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return responsesError(c, "invalid_request_error", "Invalid JSON body", 400);
  }

  const validation = validateResponsesRequest(body);
  if (!validation.valid) {
    return responsesError(c, "invalid_request_error", validation.error!, 400);
  }

  const req = validation.data!;
  const isStream = req.stream ?? false;
  const requestModel = req.model;

  console.log(
    `[Responses] Request | ${requestModel} | ${typeof req.input === "string" ? "string" : `${req.input.length} msg(s)`}${req.tools ? ` | ${req.tools.length} tool(s)` : ""}${isStream ? " | stream" : ""}${req.previous_response_id ? " | stateful" : ""}`,
  );

  try {
    // Retrieve history if previous_response_id is provided
    let historyMessages: any[] = [];
    if (req.previous_response_id) {
      const history = getResponseHistory(req.previous_response_id);
      if (!history) {
        return responsesError(
          c,
          "invalid_request_error",
          `Response '${req.previous_response_id}' not found or expired`,
          404,
        );
      }
      historyMessages = history;
    }

    // Convert to Chat Completions format
    const chatRequest = responsesToChatCompletions(req, historyMessages);

    if (isStream) {
      // ============ STREAMING MODE ============
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      const responseId = generateResponseId();
      const inProgressResponse = buildInProgressResponse(
        responseId,
        requestModel,
        req,
      );

      // Build a ReadableStream that emits SSE events
      const readable = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let streamClosed = false;
          let sequenceNumber = 0;

          // Proper SSE: event: <type>\ndata: {...}\n\n
          const enqueue = (_event: string, data: any) => {
            if (streamClosed) return;
            try {
              const payload = { ...data, sequence_number: sequenceNumber++ };
              controller.enqueue(
                encoder.encode(
                  `event: ${_event}\ndata: ${JSON.stringify(payload)}\n\n`,
                ),
              );
            } catch {
              streamClosed = true;
            }
          };

          const streamState = createStreamState(responseId, requestModel);
          let completionTokens = 0;
          let streamError: Error | null = null;

          try {
            // Emit response.created
            enqueue("response.created", {
              type: "response.created",
              response: inProgressResponse,
            });

            // Emit response.in_progress
            enqueue("response.in_progress", {
              type: "response.in_progress",
              response: inProgressResponse,
            });

            // Make request to internal Chat Completions endpoint
            // Always request usage in stream for real token counts
            const response = await fetch(
              `http://127.0.0.1:${config.server.port}/v1/chat/completions`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${process.env.API_KEY || config.apiKey || ""}`,
                },
                body: JSON.stringify({
                  ...chatRequest,
                  stream: true,
                  stream_options: { include_usage: true },
                }),
              },
            );

            if (!response.ok) {
              const errorText = await response.text();
              console.error(
                `[Responses] Upstream error: ${response.status} ${errorText}`,
              );
              throw new Error(`Upstream service error: ${response.status}`);
            }

            const reader = response.body?.getReader();
            if (!reader) {
              throw new Error("No response body");
            }

            const decoder = new TextDecoder();
            let responseBuffer = "";

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                responseBuffer += decoder.decode(value, { stream: true });
                const lines = responseBuffer.split("\n");
                responseBuffer = lines.pop() || "";

                for (const line of lines) {
                  if (!line.startsWith("data: ")) continue;
                  const data = line.slice(6);
                  if (data === "[DONE]") continue;

                  try {
                    const chunk = JSON.parse(data);

                    if (chunk.usage?.completion_tokens !== undefined) {
                      completionTokens = chunk.usage.completion_tokens;
                    }

                    const events = processChatChunk(
                      chunk,
                      streamState,
                      inProgressResponse,
                    );
                    for (const event of events) {
                      enqueue(event.type, event);
                    }
                  } catch {
                    // Ignore parse errors
                  }
                }
              }
            } finally {
              reader.releaseLock();
            }
          } catch (error) {
            streamError =
              error instanceof Error ? error : new Error(String(error));
            // Client disconnect is normal, not an error
            if (
              streamError.message?.includes("ERR_INVALID_STATE") ||
              streamError.message?.includes("aborted") ||
              streamError.message?.includes("cancelled")
            ) {
              streamClosed = true;
            } else {
              console.error(
                "❌ [Responses] Stream error:",
                streamError.message,
              );
            }
          } finally {
            // ALWAYS emit final event (if stream is still open)
            if (!streamClosed) {
              try {
                const finalOutput = buildFinalOutput(streamState);
                const finalUsage = buildFinalUsage(
                  streamState,
                  completionTokens,
                );
                const finalResponse = finalizeResponse(
                  inProgressResponse,
                  finalOutput,
                  finalUsage,
                );

                // Attach last_response_id for client memory
                finalResponse.last_response_id = responseId;

                if (streamError) {
                  enqueue("response.failed", {
                    type: "response.failed",
                    response: {
                      ...finalResponse,
                      status: "failed",
                      error: {
                        code: "api_error",
                        message: streamError.message,
                      },
                    },
                  });
                } else {
                  enqueue("response.completed", {
                    type: "response.completed",
                    response: finalResponse,
                  });

                  if (req.store !== false) {
                    storeResponse(responseId, finalResponse, [
                      ...chatRequest.messages,
                      ...responsesOutputToChatMessages(finalOutput),
                    ]);
                  }

                  console.log(
                    `[Responses] Response | ${responseId} | ${finalUsage.input_tokens} input / ${finalUsage.output_tokens} output`,
                  );
                }
              } catch (finalError) {
                console.error(
                  "[Responses] Failed to emit final event:",
                  finalError,
                );
              }

              // Close the stream
              try {
                controller.close();
              } catch {
                // Already closed
              }
            }
          }
        },
      });

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Transfer-Encoding": "chunked",
        },
      });
    } else {
      // ============ NON-STREAMING MODE ============
      const response = await fetch(
        `http://127.0.0.1:${config.server.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.API_KEY || config.apiKey || ""}`,
          },
          body: JSON.stringify(chatRequest),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[Responses] Upstream error: ${response.status} ${errorText}`,
        );
        return responsesError(c, "api_error", "Upstream service error", 502);
      }

      const chatResponse = await response.json();
      const responsesResponse = chatCompletionsToResponses(
        chatResponse,
        requestModel,
        req,
      );

      // Attach last_response_id for client memory
      responsesResponse.last_response_id = responsesResponse.id;

      // Store response for stateful conversations
      if (req.store !== false) {
        storeResponse(responsesResponse.id, responsesResponse, [
          ...chatRequest.messages,
          ...responsesOutputToChatMessages(responsesResponse.output),
        ]);
      }

      const duration = Date.now() - requestStartedAt;
      console.log(
        `[Responses] Response | ${responsesResponse.id} | ${responsesResponse.usage?.input_tokens || 0} input / ${responsesResponse.usage?.output_tokens || 0} output | ${duration}ms`,
      );

      return c.json(responsesResponse);
    }
  } catch (error) {
    console.error("❌ [Responses] Error:", error);
    return responsesError(c, "api_error", "Internal server error", 500);
  }
});

/**
 * GET /v1/responses/:response_id - Retrieve a stored response
 */
app.get("/v1/responses/:response_id", async (c) => {
  const responseId = c.req.param("response_id");

  const stored = getStoredResponse(responseId);
  if (!stored) {
    return responsesError(
      c,
      "invalid_request_error",
      `Response '${responseId}' not found`,
      404,
    );
  }

  return c.json(stored);
});

/**
 * DELETE /v1/responses/:response_id - Delete a stored response
 */
app.delete("/v1/responses/:response_id", async (c) => {
  const responseId = c.req.param("response_id");

  const existed = deleteStoredResponse(responseId);
  return c.json({
    id: responseId,
    object: "response.deleted",
    deleted: existed,
  });
});

/**
 * Responses API error response helper — OpenAI-shaped envelope.
 * Format: { error: { message, type, param, code } }
 */
function responsesError(
  c: Context,
  type: string,
  message: string,
  statusCode: number,
) {
  return c.json(
    {
      error: {
        message,
        type,
        param: null,
        code: type === "invalid_request_error" ? "invalid_request" : type,
      },
    },
    statusCode as any,
  );
}

export { app as responsesApp };
