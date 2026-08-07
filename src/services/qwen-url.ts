import { config } from "../core/config.ts";

/**
 * Build a URL against the configured Qwen web origin.
 *
 * Keeping path joining here prevents one endpoint from silently ignoring
 * QWEN_BASE_URL (which is especially important for local test proxies).
 */
const QWEN_BASE_URL = config.qwen.baseUrl.trim().replace(/\/+$/, "");
const QWEN_ORIGIN = new URL(QWEN_BASE_URL).origin;

export function qwenUrl(path = ""): string {
  const normalizedPath = path.replace(/^\/+/, "");
  return normalizedPath ? `${QWEN_BASE_URL}/${normalizedPath}` : QWEN_BASE_URL;
}

export function qwenOrigin(): string {
  return QWEN_ORIGIN;
}
