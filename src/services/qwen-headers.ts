import { v4 as uuidv4 } from "uuid";
import { qwenUrl, qwenOrigin } from "./qwen-url.ts";
import { config } from "../core/config.js";
import { getChromeMajor, getSystemLocale } from "./fingerprint.ts";
import { formatAsciiTimezone } from "../utils/timezone.ts";

export function getSystemAcceptLanguage(customLocale?: string): string {
  const locale = customLocale || getSystemLocale();
  const primary = locale.split("-")[0];
  if (locale.toLowerCase() === "en-us" || locale.toLowerCase() === "en") {
    return "en-US,en;q=0.9";
  }
  if (locale.toLowerCase().startsWith("pt")) {
    return "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7";
  }
  return `${locale},${primary};q=0.9,en-US;q=0.8,en;q=0.7`;
}

export function getDefaultQwenUserAgent(major = getChromeMajor()): string {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

let dynamicWebVersion: string | null = null;
let dynamicBxVersion: string | null = null;

export function updateQwenWebVersion(version?: string | null): void {
  if (version && typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) {
    dynamicWebVersion = version.trim();
  }
}

export function getQwenWebVersion(): string {
  return dynamicWebVersion || config.qwen.webVersion;
}

/**
 * Aliyun Baxia publishes its SDK version at `window.baxiaCommon.version` and
 * also sends it as the `bx-v` header. Detecting it at runtime keeps the
 * anti-bot fingerprint aligned when Alibaba ships a new SDK; the static
 * QWEN_BX_V value remains as a last-resort fallback.
 */
export function updateQwenBxVersion(version?: string | null): void {
  if (version && typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) {
    dynamicBxVersion = version.trim();
  }
}

export function getQwenBxVersion(): string {
  return dynamicBxVersion || config.auth.bxV;
}

export const QWEN_WEB_VERSION = config.qwen.webVersion;
export const DEFAULT_QWEN_USER_AGENT = getDefaultQwenUserAgent(151);
const QWEN_TIMEZONE_HEADER = new Date().toString().split(" (")[0];
export interface BuildQwenHeadersOptions {
  cookie: string;
  userAgent?: string;
  acceptLanguage?: string;
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
    "Accept-Language":
      opts.extra?.["Accept-Language"] ||
      opts.acceptLanguage ||
      getSystemAcceptLanguage(),
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
    "User-Agent": opts.userAgent || getDefaultQwenUserAgent(),
    "X-Request-Id": uuidv4(),
    "bx-v": opts.bxV || getQwenBxVersion(),
    source: "web",
    version: opts.version || getQwenWebVersion(),
    timezone: opts.extra?.timezone || opts.extra?.Timezone || formatAsciiTimezone(),
    Timezone: opts.extra?.Timezone || opts.extra?.timezone || formatAsciiTimezone(),
    // Use the real browser client-hints when captured (anti-hardcoded); fall
    // back to the static fingerprint otherwise.
    "sec-ch-ua":
      opts.secChUa ||
      `"Google Chrome";v="${getChromeMajor()}", "Chromium";v="${getChromeMajor()}", "Not.A/Brand";v="99"`,
    "sec-ch-ua-mobile": opts.secChUaMobile || "?0",
    "sec-ch-ua-platform": opts.secChUaPlatform || '"Windows"',
  };

  const tokenMatch = opts.cookie?.match(/(?:^|;\s*)token=([^;]+)/);
  if (tokenMatch && !headers["Authorization"] && !headers["authorization"]) {
    const bearer = decodeURIComponent(tokenMatch[1].trim());
    if (bearer && bearer !== '""' && bearer !== "null") {
      headers["Authorization"] = `Bearer ${bearer}`;
    }
  }

  // The real chat.qwen.ai client sends ONLY bx-v on API requests — the WAF
  // carries bx-ua/bx-umidtoken as browser cookies, not headers. Match that
  // unless QWEN_SEND_BX_UA=true restores the legacy injection.
  if (config.qwen.sendBxUa) {
    if (opts.bxUa) headers["bx-ua"] = opts.bxUa;
    if (opts.bxUmidtoken) headers["bx-umidtoken"] = opts.bxUmidtoken;
  }

  return headers;
}
