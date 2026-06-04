import { v4 as uuidv4 } from "uuid";

export interface BuildQwenHeadersOptions {
    cookie: string;
    userAgent: string;
    bxUa?: string;
    bxUmidtoken?: string;
    bxV?: string;
    chatSessionId?: string | null;
    extra?: Record<string, string>;
}

/**
 * Centralized builder for Qwen API request headers.
 * Prevents configuration drift and ensures consistent header propagation.
 */
export function buildQwenRequestHeaders(opts: BuildQwenHeadersOptions): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "pt-BR,pt;q=0.9",
        "Content-Type": "application/json",
        Cookie: opts.cookie,
        Origin: "https://chat.qwen.ai",
        Referer: opts.chatSessionId
            ? `https://chat.qwen.ai/c/${opts.chatSessionId}`
            : "https://chat.qwen.ai/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": opts.userAgent,
        "X-Request-Id": uuidv4(),
        "bx-ua": opts.bxUa || "",
        "bx-umidtoken": opts.bxUmidtoken || "",
        "bx-v": opts.bxV || "",
    };

    if (opts.extra) {
        Object.assign(headers, opts.extra);
    }

    return headers;
}
