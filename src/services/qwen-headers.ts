import { v4 as uuidv4 } from "uuid";

export const QWEN_WEB_VERSION = "0.2.7";
export const DEFAULT_QWEN_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

export interface BuildQwenHeadersOptions {
  cookie: string;
  userAgent?: string;
  bxUa?: string;
  bxUmidtoken?: string;
  bxV?: string;
  chatSessionId?: string | null;
  extra?: Record<string, string>;
}

export function buildQwenRequestHeaders(
  opts: BuildQwenHeadersOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Content-Type": "application/json",
    Cookie: opts.cookie,
    Origin: "https://chat.qwen.ai",
    Referer: opts.chatSessionId
      ? `https://chat.qwen.ai/c/${opts.chatSessionId}`
      : "https://chat.qwen.ai/c/new-chat",
    "sec-ch-ua":
      '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Connection: "keep-alive",
    "User-Agent": opts.userAgent || DEFAULT_QWEN_USER_AGENT,
    "X-Request-Id": uuidv4(),
    "bx-v": opts.bxV || "2.5.36",
    source: "web",
    version: QWEN_WEB_VERSION,
    timezone: new Date().toString().split(" (")[0],
  };

  if (opts.bxUa) headers["bx-ua"] = opts.bxUa;
  if (opts.bxUmidtoken) headers["bx-umidtoken"] = opts.bxUmidtoken;
  if (opts.extra) Object.assign(headers, opts.extra);

  return headers;
}
