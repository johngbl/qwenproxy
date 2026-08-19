/*
 * File: errors.ts
 * Project: QwenProxy
 * Description: Error handling utilities for chat completions
 */

/**
 * Parse a non-SSE upstream body that may contain a Qwen error payload.
 * Returns null when the body is not a recognized error document.
 */
export interface ParsedQwenErrorPayload {
  code: string;
  details: string;
  message: string;
  status: number;
}

function isWafChallenge(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("aliyun_waf") ||
    normalized.includes("_____tmd_____") ||
    normalized.includes("fail_sys_user_validate") ||
    normalized.includes("rgv587_error") ||
    normalized.includes("denyfromx5") ||
    normalized.includes("captcha") ||
    normalized.includes("security verification")
  );
}

/**
 * Parse an upstream response that arrived before any SSE event. The returned
 * details are sanitized so an HTML WAF page is never sent back to API clients.
 */
export function parseQwenErrorPayload(
  raw: string,
): ParsedQwenErrorPayload | null {
  const text = raw.trim();
  if (!text || text.startsWith("data:")) return null;

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
        code,
        details,
        message: `Qwen upstream error: ${code}: ${details}.${wait}`,
        status,
      };
    }
    if (payload && payload.error) {
      const error = payload.error;
      const code =
        typeof error === "object" && error?.code
          ? error.code
          : payload.code || "UpstreamError";
      const details =
        typeof error === "string"
          ? error
          : error.details || error.message || JSON.stringify(error);
      return {
        code,
        details,
        message: `Qwen upstream error: ${code}: ${details}`,
        status: 502,
      };
    }
  } catch {
    const waf = isWafChallenge(text);
    const details = waf
      ? "Qwen returned an anti-bot challenge instead of an SSE response."
      : "Qwen returned a non-SSE response before generation started.";
    return {
      code: waf ? "waf_challenge" : "non_sse_response",
      details,
      message: `Qwen upstream error: ${details}`,
      status: 502,
    };
  }

  return null;
}
