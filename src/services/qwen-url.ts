import { config } from "../core/config.ts";

/**
 * Build a URL against the configured Qwen web origin.
 *
 * Keeping path joining here prevents one endpoint from silently ignoring
 * QWEN_BASE_URL (which is especially important for local test proxies).
 */
export function qwenUrl(path = ""): string {
  const baseUrl = config.qwen.baseUrl.trim().replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");
  return normalizedPath ? `${baseUrl}/${normalizedPath}` : baseUrl;
}

export function qwenOrigin(): string {
  return new URL(qwenUrl()).origin;
}
