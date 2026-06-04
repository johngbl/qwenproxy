/*
 * File: errors.ts
 * Project: QwenBridge
 * Description: Error handling utilities for chat completions
 */

import { Context } from "hono";
import { sendOpenAIError, createError } from "../../api/error-helpers.js";
import type { QwenBridgeStatusCode } from "../../core/errors.js";

export function parseQwenErrorPayload(
  raw: string,
): { message: string; status: number } | null {
  const text = raw.trim();
  if (!text || text.startsWith("data: ")) return null;

  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || "UpstreamError";
      const details =
        payload.data?.details || payload.message || "Qwen returned an error";
      const wait =
        payload.data?.num !== undefined
          ? ` Wait about ${payload.data.num} hour(s) before trying again.`
          : "";
      const status =
        code === "RateLimited" ? 429 : code === "Not_Found" ? 404 : 502;
      return {
        message: `Qwen upstream error: ${code}: ${details}.${wait}`,
        status,
      };
    }
    if (payload && payload.error) {
      const msg =
        typeof payload.error === "string"
          ? payload.error
          : payload.error.message || JSON.stringify(payload.error);
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    // Non-SSE, non-JSON upstream body
    return {
      message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`,
      status: 502,
    };
  }

  return null;
}

export function sendUpstreamError(c: Context, status: number, message: string) {
  return sendOpenAIError(
    c,
    createError(status as QwenBridgeStatusCode, message),
  );
}

export function sendValidationError(
  c: Context,
  message: string,
  field?: string,
) {
  return sendOpenAIError(c, createError(400, message, field));
}

export function sendNotFoundError(c: Context, message: string) {
  return sendOpenAIError(c, createError(404, message));
}
