/*
 * File: stop.ts
 * Project: QwenBridge
 *
 * Handler for aborting an in-flight chat completion via the upstream
 * Qwen stop endpoint. Looks up the active stream in the registry,
 * forwards the stop request, then aborts the local AbortController.
 */

import { Context } from "hono";
import { buildQwenRequestHeaders } from "../../services/qwen-headers.ts";
import {
  getStream,
  getStreamKeyBySessionAndResponse,
  getStreamKeyBySessionId,
  getStreamKeysBySessionId,
  removeStream,
} from "../../core/stream-registry.ts";
import { sendOpenAIError, createError } from "../../api/error-helpers.js";

export async function chatCompletionsStop(c: Context) {
  try {
    const body = await c.req.json();
    const { chat_id, response_id } = body;

    if (!chat_id || !response_id) {
      return sendOpenAIError(
        c,
        createError(400, "chat_id and response_id are required", "chat_id"),
      );
    }

    const exactStreamKey = getStreamKeyBySessionAndResponse(
      chat_id,
      response_id,
    );
    const matchingSessionStreamKeys = getStreamKeysBySessionId(chat_id);
    const streamKey =
      exactStreamKey ||
      (matchingSessionStreamKeys.length === 1
        ? matchingSessionStreamKeys[0]
        : getStreamKeyBySessionId(chat_id)) ||
      chat_id;
    const stream = getStream(streamKey);
    if (!stream) {
      return sendOpenAIError(c, createError(404, "Stream not found"));
    }

    if (!exactStreamKey && matchingSessionStreamKeys.length > 1) {
      return sendOpenAIError(
        c,
        createError(
          400,
          "Multiple active streams for this chat_id; wait for response_id registration and retry",
          "chat_id",
        ),
      );
    }

    if (stream.targetResponseId && stream.targetResponseId !== response_id) {
      return sendOpenAIError(
        c,
        createError(400, "response_id mismatch", "response_id"),
      );
    }

    const stopResponse = await fetch(
      `https://chat.qwen.ai/api/v2/chat/completions/stop?chat_id=${chat_id}`,
      {
        method: "POST",
        headers: buildQwenRequestHeaders({
          cookie: stream.headers.cookie,
          userAgent: stream.headers["user-agent"],
          bxUa: stream.headers["bx-ua"],
          bxUmidtoken: stream.headers["bx-umidtoken"],
          bxV: stream.headers["bx-v"],
          chatSessionId: chat_id,
        }),
        body: JSON.stringify({ chat_id, response_id }),
      },
    );

    if (!stopResponse.ok) {
      const errorText = await stopResponse.text();
      console.error(
        `[Stop] Failed to stop generation for chat_id=${chat_id}: ${stopResponse.status} ${errorText}`,
      );
      return sendOpenAIError(c, createError(502, "Failed to stop generation"));
    }

    stream.abortController.abort();
    removeStream(streamKey);

    console.log(`[Stop] Generation stopped for chat_id=${chat_id}`);
    return c.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Stop] Error | ${message}`);
    return sendOpenAIError(c, err, 500);
  }
}
