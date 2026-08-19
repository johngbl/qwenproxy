/*
 * File: stop.ts
 * Project: QwenProxy
 *
 * Handler for aborting an in-flight chat completion via the upstream
 * Qwen stop endpoint. Looks up the active stream in the registry,
 * forwards the stop request, then aborts the local AbortController.
 */

import type { Context } from "hono";
import { buildQwenRequestHeaders } from "../../services/qwen-headers.ts";
import { qwenUrl } from "../../services/qwen-url.ts";
import {
  getStream,
  getStreamKeyBySessionAndResponse,
  getStreamKeysBySessionId,
  removeStream,
} from "../../core/stream-registry.ts";
import { requestQwenTextInBrowser } from "../../services/qwen.ts";
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

    // Resolve the stream key with the minimum number of registry scans:
    // exact (session, response) match first, then a single session scan.
    const exactStreamKey = getStreamKeyBySessionAndResponse(
      chat_id,
      response_id,
    );
    let streamKey = exactStreamKey ?? chat_id;
    if (!exactStreamKey) {
      const matchingSessionStreamKeys = getStreamKeysBySessionId(chat_id);
      if (matchingSessionStreamKeys.length > 1) {
        return sendOpenAIError(
          c,
          createError(
            400,
            "Multiple active streams for this chat_id; wait for response_id registration and retry",
            "chat_id",
          ),
        );
      }
      streamKey = matchingSessionStreamKeys[0] ?? chat_id;
    }
    const stream = getStream(streamKey);
    if (!stream) {
      return sendOpenAIError(c, createError(404, "Stream not found"));
    }

    if (stream.targetResponseId && stream.targetResponseId !== response_id) {
      return sendOpenAIError(
        c,
        createError(400, "response_id mismatch", "response_id"),
      );
    }

    const stopResponse = await requestQwenTextInBrowser(
      stream.accountId,
      "POST",
      `/api/v2/chat/completions/stop?chat_id=${encodeURIComponent(chat_id)}`,
      buildQwenRequestHeaders({
        cookie: stream.headers.cookie,
        userAgent: stream.headers["user-agent"],
        bxUa: stream.headers["bx-ua"],
        bxUmidtoken: stream.headers["bx-umidtoken"],
        bxV: stream.headers["bx-v"],
        chatSessionId: chat_id,
      }),
      JSON.stringify({ chat_id, response_id }),
      { referrer: qwenUrl(`/c/${encodeURIComponent(chat_id)}`) },
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

    console.log(`🛑 [Stop] Generation stopped for chat_id=${chat_id}`);
    return c.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ [Stop] Error | ${message}`);
    return sendOpenAIError(c, err, 500);
  }
}
