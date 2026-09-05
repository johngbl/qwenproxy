import { v4 as uuidv4 } from "uuid";
import { qwenUrl, qwenOrigin } from "./qwen-url.ts";
import { config } from "../core/config.js";
let dynamicWebVersion: string | null = null;

export function updateQwenWebVersion(version?: string | null): void {
  if (version && typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) {
    dynamicWebVersion = version.trim();
  }
}

export function getQwenWebVersion(): string {
  return dynamicWebVersion || config.qwen.webVersion;
}

export const QWEN_WEB_VERSION = config.qwen.webVersion;
export const DEFAULT_QWEN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const QWEN_TIMEZONE_HEADER = new Date().toString().split(" (")[0];

export interface BuildQwenHeadersOptions {
  cookie: string;
  userAgent?: string;
  bxUa?: string;
  bxUmidtoken?: string;
  bxV?: string;
  chatSessionId?: string | null;
  /** Real browser client-hints captured by getBasicHeaders (anti-hardcoded). */
  secChUa?: string;
  secChUaMobile?: string;
  secChUaPlatform?: string;
  /** Real web bundle version captured from the browser request (anti-hardcoded). */
  version?: string;
  extra?: Record<string, string>;
}

export function buildQwenRequestHeaders(
  opts: BuildQwenHeadersOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...(opts.extra ?? {}),
    Accept: "application/json",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Content-Type": "application/json",
    Cookie: opts.cookie,
    Origin: qwenOrigin(),
    Referer:
      opts.extra?.Referer ??
      (opts.chatSessionId
        ? qwenUrl(`/c/${encodeURIComponent(opts.chatSessionId)}`)
        : qwenUrl("/")),
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Connection: "keep-alive",
    "User-Agent": opts.userAgent || DEFAULT_QWEN_USER_AGENT,
    "X-Request-Id": uuidv4(),
    "bx-v": opts.bxV || "2.5.37",
    source: "web",
    version: opts.version || getQwenWebVersion(),
    timezone: QWEN_TIMEZONE_HEADER,
    // Use the real browser client-hints when captured (anti-hardcoded); fall
    // back to the static fingerprint otherwise.
    "sec-ch-ua": opts.secChUa || '"Google Chrome";v="150", "Chromium";v="150", "Not.A/Brand";v="99"',
    "sec-ch-ua-mobile": opts.secChUaMobile || "?0",
    "sec-ch-ua-platform": opts.secChUaPlatform || '"Windows"',
  };

  // The real chat.qwen.ai client sends ONLY bx-v on API requests — the WAF
  // carries bx-ua/bx-umidtoken as browser cookies, not headers. Match that
  // unless QWEN_SEND_BX_UA=true restores the legacy injection.
  if (config.qwen.sendBxUa) {
    if (opts.bxUa) headers["bx-ua"] = opts.bxUa;
    if (opts.bxUmidtoken) headers["bx-umidtoken"] = opts.bxUmidtoken;
  }

  return headers;
}
