import { v4 as uuidv4 } from "uuid";
import { getQwenHeaders } from "./auth-playwright.ts";
import { buildQwenRequestHeaders } from "./qwen-headers.ts";
import { qwenUrl } from "./qwen-url.ts";

import { config } from "../core/config.ts";
import {
  getNextAvailableAccount,
  markAccountRateLimited,
  clearAccountCooldown,
} from "../core/account-manager.ts";
import { UpstreamError, AuthError, UpstreamRateLimit } from "../core/errors.ts";
import { isAntiBotError } from "../routes/chat/retry-policy.ts";
import { recoverBaxiaCaptcha } from "./captcha-coordinator.ts";
import { startBaxiaCaptchaWatcher } from "./captcha-solver.ts";
import { withAccountPage } from "./playwright.ts";

/**
 * Heuristic for a WAF/captcha challenge page body returned by Qwen instead of JSON.
 * Kept local so media generation does not depend on a solver-specific helper.
 */
export function looksLikeAntiBotChallengeText(text: string): boolean {
  const lower = String(text || "").toLowerCase();
  return (
    lower.includes("fail_sys_user_validate") ||
    lower.includes("rgv587_error") ||
    lower.includes("_____tmd_____") ||
    lower.includes("x5secdata") ||
    lower.includes("punish") ||
    lower.includes("nocaptcha") ||
    lower.includes("captcha") ||
    lower.includes("aliyuncaptcha") ||
    lower.includes("baxia") ||
    lower.includes("access verification") ||
    lower.includes("security verification") ||
    lower.includes("verify you are human") ||
    lower.includes("human verification") ||
    lower.includes("denyfromx5")
  );
}

export interface ImageGenerationResult {
  url: string;
  revised_prompt?: string;
  width?: number;
  height?: number;
  accountId: string;
  chatId: string;
}

export interface VideoGenerationResult {
  task_id: string;
  status: "pending" | "running" | "completed" | "failed";
  video_url?: string;
  accountId: string;
  chatId: string;
}

export interface VideoTaskStatus {
  status: "pending" | "running" | "completed" | "failed";
  video_url?: string;
  error?: string;
}

const IMAGE_TIMEOUT_MS = 120_000;
const VIDEO_TIMEOUT_MS = 300_000;
const MAX_ACCOUNT_ATTEMPTS = 3;
const ACCOUNT_COOLDOWN_MS = 60_000;
const VIDEO_POLL_INTERVAL_MS = 5_000;

/**
 * Node attempts for the completions request: 1 initial + 2 retries. Aliyun WAF
 * is intermittent — FreeQwenApi's transport.js retries with a short delay
 * before falling back to the browser session, and a retry often passes clean.
 */
const NODE_COMPLETION_ATTEMPTS = 3;
const NODE_COMPLETION_RETRY_DELAY_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type MediaKind = "image" | "video";

/** Keep media logs compact and prevent signed CDN URLs from leaking into logs. */
function sanitizeMediaLogValue(value: unknown): string {
  const text = String(value)
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/[\r\n]+/g, " ");
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export function shortMediaId(value: string, length = 12): string {
  return value.length > length ? value.slice(0, length) : value;
}

export function mediaLog(
  kind: MediaKind,
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): string {
  const icon = kind === "image" ? "🎨" : "🎬";
  const details = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${sanitizeMediaLogValue(value)}`)
    .join(" | ");
  return `${icon} [Media] ${event}${details ? ` | ${details}` : ""}`;
}

export function logMediaInfo(message: string): void {
  console.log(message);
}

export function logMediaDebug(message: string): void {
  if (process.env.LOG_LEVEL === "debug") {
    console.log(`🔍 ${message}`);
  }
}

export function logMediaWarn(message: string): void {
  console.warn(`⚠️  ${message}`);
}

export function logMediaError(message: string): void {
  console.error(`❌ ${message}`);
}

/**
 * Chat model used for image/video generation via Qwen Chat.
 * Based on real Qwen traffic: qwen3.8-max is used as the chat model, and
 * the generation-specific models (qwen-image-*, wan2.*) are passed separately
 * in the payload, never as the chat model itself.
 */
export const CHAT_MEDIA_MODEL = "qwen3.8-max";

/** Models that are generation-specific (not chat models). */
export type MediaGenerationMode = "t2i" | "i2i" | "t2v" | "i2v";

type MediaModelDefinition = {
  id: string;
  kind: "image" | "video";
  modes: readonly MediaGenerationMode[];
};

const MEDIA_MODEL_DEFINITIONS: readonly MediaModelDefinition[] = [
  // Text-to-image & image-editing models (current 3.0, 2.7 and turbo generation).
  { id: "qwen-image-3.0-pro", kind: "image", modes: ["t2i", "i2i"] },
  { id: "qwen-image-3.0", kind: "image", modes: ["t2i", "i2i"] },
  { id: "wan2.7-image-pro", kind: "image", modes: ["t2i", "i2i"] },
  { id: "wan2.7-image", kind: "image", modes: ["t2i", "i2i"] },
  { id: "z-image-turbo", kind: "image", modes: ["t2i"] },

  // Video generation models (current 3.0 and 2.7 generation).
  { id: "wan3.0-video", kind: "video", modes: ["t2v", "i2v"] },
  { id: "wan2.7-t2v", kind: "video", modes: ["t2v"] },
  { id: "wan2.7-i2v", kind: "video", modes: ["i2v"] },
];
const MEDIA_IMAGE_MODELS = MEDIA_MODEL_DEFINITIONS.filter(
  ({ kind }) => kind === "image",
).map(({ id }) => id);
const MEDIA_VIDEO_MODELS = MEDIA_MODEL_DEFINITIONS.filter(
  ({ kind }) => kind === "video",
).map(({ id }) => id);
const MEDIA_GENERATION_MODELS = new Set(
  MEDIA_MODEL_DEFINITIONS.map(({ id }) => id),
);

/** Shared media sizes accepted by image/video endpoints and chat completions. */
export const MEDIA_SIZE_OPTIONS = [
  "auto",
  "1:1",
  "3:4",
  "4:3",
  "16:9",
  "9:16",
  "1024x1024",
  "1792x1024",
  "1024x1792",
] as const;

export function isSupportedMediaSize(
  value: unknown,
): value is (typeof MEDIA_SIZE_OPTIONS)[number] {
  return (
    typeof value === "string" &&
    (MEDIA_SIZE_OPTIONS as readonly string[]).includes(value)
  );
}

/**
 * Public media model catalog so `/v1/models` can advertise image/video
 * generation models alongside the live Qwen chat catalog.
 */
export function listMediaGenerationModels(): Array<{
  id: string;
  kind: "image" | "video";
  modes: readonly MediaGenerationMode[];
}> {
  return MEDIA_MODEL_DEFINITIONS.map((definition) => ({
    id: definition.id,
    kind: definition.kind,
    modes: definition.modes,
  }));
}

export function getMediaModelModes(
  model?: string | null,
): readonly MediaGenerationMode[] | null {
  const id = model?.trim();
  if (!id) return null;
  return (
    MEDIA_MODEL_DEFINITIONS.find((definition) => definition.id === id)?.modes ??
    null
  );
}

export function supportsPromptMediaGeneration(
  model: string,
  kind: "image" | "video",
): boolean {
  const modes = getMediaModelModes(model);
  if (!modes) return true;
  return modes.includes(kind === "image" ? "t2i" : "t2v");
}

/**
 * Resolves the generation model. When the client requests a generation-specific
 * model (qwen-image-*, wan2.*), the chat model stays CHAT_MEDIA_MODEL and the
 * requested model is passed separately. Any other model (e.g. qwen3-vl-plus,
 * qwen-max-latest) is used directly as the chat model.
 */
export function resolveMediaModel(
  requestedModel?: string,
): { chatModel: string; generationModel?: string } {
  const explicitModel = requestedModel?.trim();
  if (!explicitModel) {
    throw new UpstreamError(
      "A model selected by the client is required for image/video generation",
    );
  }
  if (MEDIA_GENERATION_MODELS.has(explicitModel)) {
    return { chatModel: CHAT_MEDIA_MODEL, generationModel: explicitModel };
  }
  return { chatModel: explicitModel, generationModel: undefined };
}

/**
 * Classifies a client-selected model as a media generation model. Returns
 * "image"/"video" for generation-specific models, or null for regular chat
 * models. Chat completions uses this to route image/video requests to the
 * native generation pipeline instead of the text flow.
 */
export function classifyMediaModel(
  model?: string | null,
): "image" | "video" | null {
  const m = model?.trim();
  if (!m) return null;
  if ((MEDIA_IMAGE_MODELS as readonly string[]).includes(m)) return "image";
  if ((MEDIA_VIDEO_MODELS as readonly string[]).includes(m)) return "video";
  return null;
}

function normalizeSize(size?: string): string | undefined {
  if (!size) return undefined;
  // "auto" lets Qwen pick the aspect ratio (seen in real t2i traffic).
  if (size === "auto") return "auto";
  if (/^\d+:\d+$/.test(size)) return size;
  const match = size.match(/^(\d+)x(\d+)$/);
  if (match) {
    const w = parseInt(match[1]);
    const h = parseInt(match[2]);
    if (w === h) return "1:1";
    if (w > h) return "16:9";
    return "9:16";
  }
  return size;
}

/**
 * The Qwen webapp authenticates API calls with `Authorization: Bearer <token>`
 * — the JWT that is also present in the session cookie / localStorage. Both the
 * Node and the browser paths in FreeQwenApi's working transport always send
 * it; requests without it are far more likely to be challenged by the WAF.
 */
function extractBearerToken(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const match = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function buildHeadersFromCaptured(
  headers: Record<string, string>,
  chatSessionId?: string,
): Record<string, string> {
  const bearerToken = extractBearerToken(headers["cookie"] ?? headers["Cookie"]);
  return buildQwenRequestHeaders({
    cookie: headers["cookie"],
    userAgent: headers["user-agent"],
    bxUa: headers["bx-ua"],
    bxUmidtoken: headers["bx-umidtoken"],
    bxV: headers["bx-v"],
    chatSessionId,
    extra: {
      Referer: chatSessionId
        ? qwenUrl(`/c/${encodeURIComponent(chatSessionId)}`)
        : qwenUrl("/"),
      "x-accel-buffering": "no",
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
  });
}

/** Headers a browser fetch() is not allowed to set (mirrors qwen.ts). */
const BROWSER_FORBIDDEN_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "cookie",
  "host",
  "origin",
  "referer",
  "user-agent",
]);

function filterHeadersForBrowserFetch(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const normalized = name.toLowerCase();
      return (
        !BROWSER_FORBIDDEN_HEADERS.has(normalized) &&
        !normalized.startsWith("sec-")
      );
    }),
  );
}

interface BrowserCompletionResponse {
  status: number;
  contentType: string;
  rawBody: string;
  /** Present when the in-page fetch itself failed (network/abort/timeout). */
  error?: string;
}

/**
 * Runs the completions request inside the account's live Playwright page.
 * Adapted from FreeQwenApi's transport.js inPageRequest:
 *  - fetch with credentials so the signed session travels with the request;
 *  - SSE bodies are read with early-break on stream-finish signals because
 *    Qwen keeps the connection open after [DONE] / finish_reason — a plain
 *    response.text() would hang until the outer timeout;
 *  - a captcha watcher solves Baxia challenges that appear mid-request, the
 *    same mechanism the working chat flow uses.
 */
async function requestCompletionsInBrowser(params: {
  accountId: string;
  url: string;
  payloadJson: string;
  headers: Record<string, string>;
  referrer: string;
  streaming: boolean;
  timeoutMs: number;
}): Promise<BrowserCompletionResponse> {
  const {
    accountId,
    url,
    payloadJson,
    headers,
    referrer,
    streaming,
    timeoutMs,
  } = params;

  const browserHeaders = filterHeadersForBrowserFetch(headers);
  if (
    !Object.keys(browserHeaders).some(
      (name) => name.toLowerCase() === "content-type",
    )
  ) {
    browserHeaders["Content-Type"] = "application/json";
  }

  // The in-page deadline must fire before the page-operation timeout so a
  // stuck fetch resolves gracefully instead of resetting the account context.
  const fetchTimeoutMs = Math.max(10_000, timeoutMs - 8_000);

  return withAccountPage(
    accountId,
    async (page) => {
      // Keep the page on the chat UI so the same-origin fetch carries the
      // live session (mirrors withQwenBrowserPage in qwen.ts).
      const targetUrl = qwenUrl("/c/new-chat");
      let needsNavigation = true;
      try {
        const current = new URL(page.url());
        const target = new URL(targetUrl);
        needsNavigation =
          current.origin !== target.origin ||
          current.pathname.replace(/\/+$/, "") !== "/c/new-chat";
      } catch {
        needsNavigation = true;
      }
      if (needsNavigation) {
        await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(config.timeouts.navigation, timeoutMs),
        });
      }

      let captchaWatcher:
        | ReturnType<typeof startBaxiaCaptchaWatcher>
        | undefined;
      if (config.captcha.enabled) {
        captchaWatcher = startBaxiaCaptchaWatcher(page, timeoutMs, {
          maxAttempts: config.captcha.maxAttempts,
          retryDelayMs: config.captcha.retryDelayMs,
          settleMs: config.captcha.settleMs,
        });
      }

      try {
        return await page.evaluate(
          async ({
            url,
            headers,
            body,
            referrer,
            streaming,
            fetchTimeoutMs,
          }: {
            url: string;
            headers: Record<string, string>;
            body: string;
            referrer: string;
            streaming: boolean;
            fetchTimeoutMs: number;
          }): Promise<{
            status: number;
            contentType: string;
            rawBody: string;
            error?: string;
          }> => {
            const controller = new AbortController();
            const timeoutId = setTimeout(
              () => controller.abort(),
              fetchTimeoutMs,
            );
            try {
              const response = await fetch(url, {
                method: "POST",
                credentials: "include",
                headers,
                body,
                signal: controller.signal,
                referrer,
              });
              clearTimeout(timeoutId);

              const contentType = response.headers.get("content-type") || "";

              if (!response.ok) {
                return {
                  status: response.status,
                  contentType,
                  rawBody: await response.text().catch(() => ""),
                };
              }

              if (
                !streaming ||
                !contentType.includes("text/event-stream") ||
                !response.body
              ) {
                return {
                  status: response.status,
                  contentType,
                  rawBody: await response.text(),
                };
              }

              // Qwen keeps the SSE connection open after [DONE] /
              // finish_reason, so break on stream-finish signals — otherwise
              // this loop never ends (FreeQwenApi transport.js).
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = "";
              let full = "";
              let finished = false;

              while (!finished) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                full += text;
                buffer += text;

                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed === "data: [DONE]") {
                    finished = true;
                    break;
                  }
                  if (!trimmed.startsWith("data:")) continue;
                  try {
                    const chunk = JSON.parse(trimmed.slice(5).trim());
                    const choice = chunk?.choices?.[0];
                    const delta = choice?.delta;
                    const phase = delta?.phase;
                    const isAnswerPhase = !phase || phase === "answer";
                    // status:"finished" ends a phase, not the stream — the
                    // thinking phase finishes before the answer phase starts.
                    if (
                      choice?.finish_reason ||
                      (delta?.status === "finished" && isAnswerPhase)
                    ) {
                      finished = true;
                      break;
                    }
                  } catch {
                    // Not JSON — keep reading.
                  }
                }
              }

              await reader.cancel().catch(() => undefined);
              return { status: response.status, contentType, rawBody: full };
            } catch (error) {
              clearTimeout(timeoutId);
              return {
                status: 0,
                contentType: "",
                rawBody: "",
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
          {
            url,
            headers: browserHeaders,
            body: payloadJson,
            referrer,
            streaming,
            fetchTimeoutMs,
          },
        );
      } finally {
        captchaWatcher?.stop();
      }
    },
    timeoutMs,
  );
}

/**
 * Runs the completions request Node-first, like FreeQwenApi's transport.js:
 * Node fetch is fast but Aliyun WAF intermittently answers with a captcha
 * (hence the short retries), while the fetch executed inside the live
 * Playwright page carries the signed session. When both paths fail the error
 * is classified: anti-bot failures carry an upstream code the media loops
 * recognize so captcha recovery can run (the chat flow behaves the same way).
 */
async function requestCompletionsWithBrowserFallback(params: {
  kind: MediaKind;
  accountId: string;
  url: string;
  payloadJson: string;
  headers: Record<string, string>;
  chatId: string;
  streaming: boolean;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<{ status: number; rawBody: string }> {
  const {
    kind,
    accountId,
    url,
    payloadJson,
    headers,
    chatId,
    streaming,
    signal,
    timeoutMs,
  } = params;

  let sawAntiBotChallenge = false;
  let lastFailureDetail = "";

  for (let attempt = 1; attempt <= NODE_COMPLETION_ATTEMPTS; attempt++) {
    if (signal.aborted) break;
    if (attempt > 1) {
      await sleep(NODE_COMPLETION_RETRY_DELAY_MS);
    }

    try {
      const nodeResponse = await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          Accept: "text/event-stream",
        },
        body: payloadJson,
        signal,
      });

      const rawBody = await nodeResponse.text().catch(() => "");

      if (nodeResponse.ok && !looksLikeAntiBotChallengeText(rawBody)) {
        return { status: nodeResponse.status, rawBody };
      }

      if (looksLikeAntiBotChallengeText(rawBody)) {
        sawAntiBotChallenge = true;
        logMediaDebug(
          mediaLog(kind, "transport_waf_blocked", {
            account: shortMediaId(accountId),
            attempt,
            attempts: NODE_COMPLETION_ATTEMPTS,
          }),
        );
        // WAF is intermittent — retry Node before the browser fallback.
        continue;
      }

      // Conclusive upstream error — let the browser session try.
      lastFailureDetail = `Node HTTP ${nodeResponse.status}: ${rawBody.substring(0, 200)}`;
      break;
    } catch (error) {
      if (signal.aborted) break;
      // Network failure — let the browser session try.
      lastFailureDetail =
        error instanceof Error ? error.message : String(error);
      break;
    }
  }

  if (!signal.aborted) {
    logMediaInfo(
      mediaLog(kind, "transport_fallback_started", {
        account: shortMediaId(accountId),
        transport: "browser",
      }),
    );

    try {
      const browserResult = await requestCompletionsInBrowser({
        accountId,
        url,
        payloadJson,
        headers,
        referrer: qwenUrl(`/c/${encodeURIComponent(chatId)}`),
        streaming,
        timeoutMs: Math.min(timeoutMs, IMAGE_TIMEOUT_MS),
      });

      if (browserResult.error) {
        lastFailureDetail = `Browser fetch: ${browserResult.error}`;
        logMediaWarn(
          mediaLog(kind, "transport_fallback_failed", {
            account: shortMediaId(accountId),
            transport: "browser",
            error: browserResult.error,
          }),
        );
      } else if (looksLikeAntiBotChallengeText(browserResult.rawBody)) {
        sawAntiBotChallenge = true;
        logMediaWarn(
          mediaLog(kind, "transport_waf_blocked", {
            account: shortMediaId(accountId),
            transport: "browser",
          }),
        );
      } else {
        return { status: browserResult.status, rawBody: browserResult.rawBody };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (looksLikeAntiBotChallengeText(message)) {
        sawAntiBotChallenge = true;
      }
      lastFailureDetail = `Browser fallback: ${message}`;
      logMediaWarn(
        mediaLog(kind, "transport_fallback_failed", {
          account: shortMediaId(accountId),
          transport: "browser",
          error: message,
        }),
      );
    }
  }

  if (signal.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }

  // Classify anti-bot failures so the media loops trigger captcha recovery
  // (isAntiBotError matches upstreamCode FAIL_SYS_USER_VALIDATE/RGV587_ERROR).
  if (sawAntiBotChallenge) {
    const error = new UpstreamError(
      "Qwen anti-bot validation required: completions blocked by WAF (FAIL_SYS_USER_VALIDATE)",
    ) as UpstreamError & { upstreamCode: string };
    error.upstreamCode = "FAIL_SYS_USER_VALIDATE";
    throw error;
  }

  throw new UpstreamError(
    `Media generation completions failed in both Node and browser paths${
      lastFailureDetail ? ` | ${lastFailureDetail}` : ""
    }`,
  );
}


async function createMediaChatSession(
  headers: Record<string, string>,
  chatModel: string,
  chatType: "t2i" | "t2v",
  signal: AbortSignal,
): Promise<string> {
  const title = chatType === "t2i" ? "Image Generation" : "Video Generation";

  const response = await fetch(qwenUrl("/api/v2/chats/new"), {
    method: "POST",
    headers: buildHeadersFromCaptured(headers),
    body: JSON.stringify({
      title,
      models: [chatModel],
      chat_mode: "normal",
      chat_type: chatType,
      timestamp: Date.now(),
      project_id: "",
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new UpstreamError(
      `Failed to create ${chatType} chat session: ${response.status} ${text.substring(0, 200)}`,
    );
  }

  const json = await response.json();
  const chatId =
    json?.chat_id ||
    json?.id ||
    json?.data?.chat_id ||
    json?.data?.id ||
    json?.data?.chat?.id;

  if (!chatId || typeof chatId !== "string") {
    throw new UpstreamError(
      `Unexpected response when creating ${chatType} chat session`,
    );
  }

  return chatId;
}

function buildCompletionsPayload(
  chatId: string,
  prompt: string,
  chatModel: string,
  chatType: "t2i" | "t2v",
  size?: string,
  generationModel?: string,
): Record<string, unknown> {
  const fid = uuidv4();
  const childId = uuidv4();
  const nowSec = Math.floor(Date.now() / 1000);

  // Based on real Qwen traffic: media generation uses Fast thinking mode
  // and does not need extended thinking
  const userMessage: Record<string, unknown> = {
    id: null,
    fid,
    parentId: null,
    childrenIds: [childId],
    role: "user",
    content: prompt,
    user_action: "chat",
    files: [],
    timestamp: nowSec,
    models: [chatModel],
    model: "",
    chat_type: chatType,
    feature_config: {
      thinking_enabled: false,
      output_schema: "phase",
      research_mode: "normal",
      auto_thinking: false,
      thinking_mode: "Fast",
      auto_search: true,
    },
    extra: {
      meta: {
        subChatType: chatType,
        ...(size ? { size } : {}),
        ...(generationModel ? { model: generationModel } : {}),
      },
    },
    sub_chat_type: chatType,
    parent_id: null,
  };

  const payload: Record<string, unknown> = {
    stream: chatType !== "t2v",
    version: "2.1",
    incremental_output: true,
    chatId,
    parentId: "",
    chat_id: chatId,
    chat_mode: "normal",
    messages: [userMessage],
    model: chatModel,
    parent_id: null,
    timestamp: nowSec + 1,
  };

  if (size && (chatType === "t2i" || chatType === "t2v")) {
    payload.size = size;
  }

  return payload;
}

interface SseParseResult {
  content: string;
  task_id?: string;
  width?: number;
  height?: number;
  image_count?: number;
  raw: string;
}

function parseSseResponse(raw: string): SseParseResult {
  const result: SseParseResult = { content: "", raw };

  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) continue;

    const dataStr = trimmed.slice(6);
    if (dataStr === "[DONE]") continue;

    try {
      const parsed = JSON.parse(dataStr);

      if (parsed?.choices?.[0]?.delta?.content) {
        result.content = parsed.choices[0].delta.content;
      } else if (parsed?.choices?.[0]?.message?.content) {
        result.content = parsed.choices[0].message.content;
      }

      if (parsed?.task_id) {
        result.task_id = parsed.task_id;
      }

      if (parsed?.usage) {
        if (parsed.usage.width) result.width = parsed.usage.width;
        if (parsed.usage.height) result.height = parsed.usage.height;
        if (parsed.usage.image_count) result.image_count = parsed.usage.image_count;
      }
    } catch {
      // Skip malformed SSE lines
    }
  }

  return result;
}

function extractUrlFromContent(content: string): string | null {
  const urlMatch = content.match(/https:\/\/[^\s"'<>]+/);
  return urlMatch ? urlMatch[0] : null;
}

/** Safely parses a JSON body; returns null when it is not JSON. */
function parseJsonIfPossible(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Cooldown for a RateLimited error. Uses the hours the upstream reports in its
 * error message (e.g. "Please wait 4 hours...") when present; otherwise falls
 * back to the account manager's default cooldown.
 */
function rateLimitCooldownMs(err: UpstreamRateLimit): number | undefined {
  const hourMatch = err.message?.match(/(\d+)\s*hours?/i);
  if (hourMatch) {
    const hours = Math.max(1, parseInt(hourMatch[1], 10));
    return hours * 60 * 60 * 1000;
  }
  return undefined;
}

/**
 * Detects a Qwen daily usage limit response. The upstream answers HTTP 200
 * with `{"success":false,"data":{"code":"RateLimited","num":4}}` where `num` is
 * the hours to wait. Mirrors the chat path's handling of `RateLimited` errors.
 * Throws UpstreamRateLimit when detected; returns nothing otherwise.
 */
function assertNotRateLimited(rawBody: string): void {
  const json = parseJsonIfPossible(rawBody);
  if (!json || typeof json !== "object") return;
  const record = json as Record<string, unknown>;
  const data = record.data as Record<string, unknown> | undefined;
  const code = record.code ?? data?.code;
  if (code !== "RateLimited") return;
  const num = typeof data?.num === "number" ? data.num : 0;
  const detail =
    (num > 0 && typeof data?.template === "string"
      ? data.template.replace(/\{\{\s*num\s*\}\}/g, String(num))
      : "") ||
    (typeof data?.details === "string" ? data.details : "") ||
    "";
  throw new UpstreamRateLimit(
    detail ||
      `Qwen daily usage limit reached${num > 0 ? `; retry in ~${num}h` : ""}`,
  );
}

/**
 * Task identifier from a video (t2v) response. Video uses stream:false, so the
 * response is JSON rather than SSE. Mirrors FreeQwenApi's extractTaskId:
 * prefers the wanx task id embedded in the first message, then falls back to
 * top-level response identifiers.
 */
function extractTaskIdFromJson(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const dataRecord = data.data as Record<string, unknown> | undefined;
  const messages = Array.isArray(dataRecord?.messages)
    ? (dataRecord.messages as unknown[])
    : [];
  const firstMessage = (messages[0] ?? null) as Record<string, unknown> | null;
  const wanxTaskId =
    (firstMessage?.extra as Record<string, unknown> | undefined)
      ?.wanx as Record<string, unknown> | undefined;
  if (wanxTaskId?.task_id && typeof wanxTaskId.task_id === "string") {
    return wanxTaskId.task_id;
  }
  const candidates = [
    data.id,
    data.task_id,
    data.response_id,
    dataRecord?.message_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

// Media URL extraction copied from FreeQwenApi's core/qwen/media.js.
// Qwen response structure is unstable, so the URL is searched recursively
// through the entire response object, preferring real media file extensions
// over generic service links.
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

const PREFERRED_KEYS = [
  "video_url",
  "image_url",
  "url",
  "content",
  "result",
  "output",
  "data",
  "message",
];

function findMediaUrl(
  value: unknown,
  extensions: string[],
  seen: Set<unknown>,
): string | null {
  if (!value) return null;

  if (typeof value === "string") {
    const urls = value.match(/https?:\/\/[^\s"'<>]+/g);
    if (!urls) return null;
    return (
      urls.find((url) =>
        extensions.some((ext) => url.toLowerCase().includes(ext)),
      ) || null
    );
  }

  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMediaUrl(item, extensions, seen);
      if (found) return found;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of PREFERRED_KEYS) {
    if (key in record) {
      const found = findMediaUrl(record[key], extensions, seen);
      if (found) return found;
    }
  }
  for (const item of Object.values(record)) {
    const found = findMediaUrl(item, extensions, seen);
    if (found) return found;
  }
  return null;
}

function extractMediaUrl(
  value: unknown,
  type: "image" | "video" | "any" = "any",
): string | null {
  const extensions =
    type === "video"
      ? VIDEO_EXTENSIONS
      : type === "image"
        ? IMAGE_EXTENSIONS
        : [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS];
  return findMediaUrl(value, extensions, new Set());
}

export async function generateImage(params: {
  prompt: string;
  model?: string;
  size?: string;
  accountId?: string;
  signal?: AbortSignal;
}): Promise<ImageGenerationResult> {
  const {
    prompt,
    model: requestedModel,
    size,
    accountId: requestedAccountId,
    signal: externalSignal,
  } = params;

  const normalizedSize = normalizeSize(size);
  const generationStartedAt = Date.now();
  const triedAccounts = new Set<string>();
  /** Accounts whose Baxia challenge was already solved in this call. */
  const captchaRecoveredAccounts = new Set<string>();
  /** Force header recapture on the next attempt (bx-* may rotate after a solved challenge). */
  let forceHeaderRefresh = false;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
    const account = requestedAccountId
      ? { id: requestedAccountId, email: requestedAccountId }
      : getNextAvailableAccount(triedAccounts);

    if (!account) {
      // A previous attempt already failed and no other account is available —
      // surface the aggregated error below instead of hiding it.
      if (lastError) break;
      throw new AuthError(
        "No available accounts for image generation",
      );
    }

    triedAccounts.add(account.id);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;

    try {
      const { chatModel, generationModel } = resolveMediaModel(requestedModel);
      logMediaInfo(
        mediaLog("image", "generation_started", {
          operation: "generate",
          account: shortMediaId(account.id),
          model: requestedModel,
          chat_model: chatModel,
          attempt: attempt + 1,
          size: normalizedSize ?? "auto",
          prompt_chars: prompt.length,
        }),
      );

      const { headers } = await getQwenHeaders(forceHeaderRefresh, account.id);
      forceHeaderRefresh = false;
      const chatId = await createMediaChatSession(headers, chatModel, "t2i", signal);

      logMediaDebug(
        mediaLog("image", "chat_created", {
          account: shortMediaId(account.id),
          chat: shortMediaId(chatId),
        }),
      );

      const payload = buildCompletionsPayload(chatId, prompt, chatModel, "t2i", normalizedSize, generationModel);
      const requestHeaders = buildHeadersFromCaptured(headers, chatId);

      const completionsResult = await requestCompletionsWithBrowserFallback({
        kind: "image",
        accountId: account.id,
        url: qwenUrl(`/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`),
        payloadJson: JSON.stringify(payload),
        headers: requestHeaders,
        chatId,
        streaming: true,
        signal,
        timeoutMs: IMAGE_TIMEOUT_MS,
      });

      const { status: completionsStatus, rawBody } = completionsResult;
      if (completionsStatus !== 200) {
        throw new UpstreamError(
          `Image generation request failed: ${completionsStatus} ${rawBody.substring(0, 200)}`,
        );
      }

      assertNotRateLimited(rawBody);

      const sseResult = parseSseResponse(rawBody);

      const imageUrl =
        extractUrlFromContent(sseResult.content) ||
        extractMediaUrl(sseResult.raw, "image");
      if (!imageUrl) {
        if (looksLikeAntiBotChallengeText(rawBody)) {
          const match = rawBody.match(/FAIL_SYS_USER_VALIDATE|RGV587_ERROR/i);
          const code = match ? match[0].toUpperCase() : "FAIL_SYS_USER_VALIDATE";
          logMediaWarn(
            mediaLog("image", "captcha_required", {
              account: shortMediaId(account.id),
              code,
            }),
          );
          const err = new UpstreamError(
            `Qwen anti-bot validation required: ${code}`,
          ) as UpstreamError & { upstreamCode: string };
          err.upstreamCode = code;
          throw err;
        }
        throw new UpstreamError(
          "No image URL found in generation response",
        );
      }

      logMediaInfo(
        mediaLog("image", "generation_completed", {
          account: shortMediaId(account.id),
          chat: shortMediaId(chatId),
          duration_ms: Date.now() - generationStartedAt,
          output: "url",
        }),
      );

      return {
        url: imageUrl,
        width: sseResult.width,
        height: sseResult.height,
        accountId: account.id,
        chatId,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (externalSignal?.aborted) {
        throw lastError;
      }

      logMediaWarn(
        mediaLog("image", "attempt_failed", {
          account: shortMediaId(account.id),
          attempt: attempt + 1,
          elapsed_ms: Date.now() - generationStartedAt,
          error: lastError.message,
        }),
      );

      if (
        isAntiBotError(lastError) &&
        !captchaRecoveredAccounts.has(account.id)
      ) {
        logMediaInfo(
          mediaLog("image", "captcha_recovery_started", {
            account: shortMediaId(account.id),
          }),
        );
        const recovered = await recoverBaxiaCaptcha(account.id, "media-generation");
        if (recovered) {
          captchaRecoveredAccounts.add(account.id);
          clearAccountCooldown(account.id);
          // Allow the same account to be picked again on the next attempt —
          // without this a single-account setup dies with "No available accounts".
          triedAccounts.delete(account.id);
          // bx-* tokens may rotate after a solved challenge — recapture headers.
          forceHeaderRefresh = true;
          logMediaInfo(
            mediaLog("image", "captcha_recovery_succeeded", {
              account: shortMediaId(account.id),
            }),
          );
          continue;
        }
        logMediaWarn(
          mediaLog("image", "captcha_recovery_failed", {
            account: shortMediaId(account.id),
          }),
        );
      }

      if (lastError instanceof UpstreamRateLimit) {
        markAccountRateLimited(
          account.id,
          rateLimitCooldownMs(lastError),
          "RateLimited",
        );
      } else {
        markAccountRateLimited(account.id, ACCOUNT_COOLDOWN_MS, "MediaGenFailed");
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (lastError instanceof UpstreamRateLimit) {
    throw lastError;
  }
  throw new UpstreamError(
    `Image generation failed after ${MAX_ACCOUNT_ATTEMPTS} attempts: ${lastError?.message}`,
  );
}

export async function generateVideo(params: {
  prompt: string;
  model?: string;
  size?: string;
  accountId?: string;
  waitForCompletion?: boolean;
  signal?: AbortSignal;
}): Promise<VideoGenerationResult> {
  const {
    prompt,
    model: requestedModel,
    size,
    accountId: requestedAccountId,
    waitForCompletion = false,
    signal: externalSignal,
  } = params;

  const normalizedSize = normalizeSize(size);
  const generationStartedAt = Date.now();
  const triedAccounts = new Set<string>();
  /** Accounts whose Baxia challenge was already solved in this call. */
  const captchaRecoveredAccounts = new Set<string>();
  /** Force header recapture on the next attempt (bx-* may rotate after a solved challenge). */
  let forceHeaderRefresh = false;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
    const account = requestedAccountId
      ? { id: requestedAccountId, email: requestedAccountId }
      : getNextAvailableAccount(triedAccounts);

    if (!account) {
      // A previous attempt already failed and no other account is available —
      // surface the aggregated error below instead of hiding it.
      if (lastError) break;
      throw new AuthError(
        "No available accounts for video generation",
      );
    }

    triedAccounts.add(account.id);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VIDEO_TIMEOUT_MS);

    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;

    try {
      const { chatModel, generationModel } = resolveMediaModel(requestedModel);
      logMediaInfo(
        mediaLog("video", "generation_started", {
          operation: "generate",
          account: shortMediaId(account.id),
          model: requestedModel,
          chat_model: chatModel,
          attempt: attempt + 1,
          size: normalizedSize ?? "16:9",
          prompt_chars: prompt.length,
          wait: waitForCompletion,
        }),
      );

      const { headers } = await getQwenHeaders(forceHeaderRefresh, account.id);
      forceHeaderRefresh = false;
      const chatId = await createMediaChatSession(headers, chatModel, "t2v", signal);

      logMediaDebug(
        mediaLog("video", "chat_created", {
          account: shortMediaId(account.id),
          chat: shortMediaId(chatId),
        }),
      );

      const payload = buildCompletionsPayload(chatId, prompt, chatModel, "t2v", normalizedSize, generationModel);
      const requestHeaders = buildHeadersFromCaptured(headers, chatId);

      const completionsResult = await requestCompletionsWithBrowserFallback({
        kind: "video",
        accountId: account.id,
        url: qwenUrl(`/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`),
        payloadJson: JSON.stringify(payload),
        headers: requestHeaders,
        chatId,
        streaming: true,
        signal,
        timeoutMs: VIDEO_TIMEOUT_MS,
      });

      const { status: completionsStatus, rawBody } = completionsResult;
      if (completionsStatus !== 200) {
        throw new UpstreamError(
          `Video generation request failed: ${completionsStatus} ${rawBody.substring(0, 200)}`,
        );
      }

      assertNotRateLimited(rawBody);

      const sseResult = parseSseResponse(rawBody);
      const taskId =
        sseResult.task_id ?? extractTaskIdFromJson(parseJsonIfPossible(rawBody));

      if (!taskId) {
        const videoUrl =
          extractUrlFromContent(sseResult.content) ||
          extractMediaUrl(sseResult.raw, "video") ||
          extractMediaUrl(parseJsonIfPossible(rawBody), "video");
        if (videoUrl) {
          logMediaInfo(
            mediaLog("video", "generation_completed", {
              account: shortMediaId(account.id),
              chat: shortMediaId(chatId),
              duration_ms: Date.now() - generationStartedAt,
              output: "url",
              source: "direct",
            }),
          );
          return {
            task_id: "",
            status: "completed",
            video_url: videoUrl,
            accountId: account.id,
            chatId,
          };
        }
        logMediaWarn(
          mediaLog("video", "response_invalid", {
            account: shortMediaId(account.id),
            chat: shortMediaId(chatId),
            http_status: completionsStatus,
            response_chars: rawBody.length,
          }),
        );
        throw new UpstreamError(
          "No task_id or video URL found in video generation response",
        );
      }

      logMediaInfo(
        mediaLog("video", "task_submitted", {
          account: shortMediaId(account.id),
          chat: shortMediaId(chatId),
          task: shortMediaId(taskId),
          wait: waitForCompletion,
        }),
      );

      if (!waitForCompletion) {
        return {
          task_id: taskId,
          status: "pending",
          accountId: account.id,
          chatId,
        };
      }

      const status = await pollVideoTask({
        taskId,
        accountId: account.id,
        signal,
      });

      return {
        task_id: taskId,
        status: status.status,
        video_url: status.video_url,
        accountId: account.id,
        chatId,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (externalSignal?.aborted) {
        throw lastError;
      }

      logMediaWarn(
        mediaLog("video", "attempt_failed", {
          account: shortMediaId(account.id),
          attempt: attempt + 1,
          elapsed_ms: Date.now() - generationStartedAt,
          error: lastError.message,
        }),
      );

      if (
        isAntiBotError(lastError) &&
        !captchaRecoveredAccounts.has(account.id)
      ) {
        logMediaInfo(
          mediaLog("video", "captcha_recovery_started", {
            account: shortMediaId(account.id),
          }),
        );
        const recovered = await recoverBaxiaCaptcha(
          account.id,
          "media-generation",
        );
        if (recovered) {
          captchaRecoveredAccounts.add(account.id);
          clearAccountCooldown(account.id);
          // Allow the same account to be picked again on the next attempt —
          // without this a single-account setup dies with "No available accounts".
          triedAccounts.delete(account.id);
          // bx-* tokens may rotate after a solved challenge — recapture headers.
          forceHeaderRefresh = true;
          logMediaInfo(
            mediaLog("video", "captcha_recovery_succeeded", {
              account: shortMediaId(account.id),
            }),
          );
          continue;
        }
        logMediaWarn(
          mediaLog("video", "captcha_recovery_failed", {
            account: shortMediaId(account.id),
          }),
        );
      }

      if (lastError instanceof UpstreamRateLimit) {
        markAccountRateLimited(
          account.id,
          rateLimitCooldownMs(lastError),
          "RateLimited",
        );
      } else {
        markAccountRateLimited(account.id, ACCOUNT_COOLDOWN_MS, "MediaGenFailed");
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (lastError instanceof UpstreamRateLimit) {
    throw lastError;
  }
  throw new UpstreamError(
    `Video generation failed after ${MAX_ACCOUNT_ATTEMPTS} attempts: ${lastError?.message}`,
  );
}

export async function pollVideoTask(params: {
  taskId: string;
  accountId: string;
  signal?: AbortSignal;
  /** Single upstream poll without looping; used for non-blocking status checks. */
  once?: boolean;
}): Promise<VideoTaskStatus> {
  const { taskId, accountId, signal, once } = params;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VIDEO_TIMEOUT_MS);

  const effectiveSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;
  const pollStartedAt = Date.now();
  let pollCount = 0;
  let lastProgressLogAt = 0;
  let lastLoggedStatus = "";

  try {
    const { headers } = await getQwenHeaders(false, accountId);
    const requestHeaders = buildHeadersFromCaptured(headers);
    const pollUrl = qwenUrl(`/api/v1/tasks/status/${encodeURIComponent(taskId)}`);

    logMediaDebug(
      mediaLog("video", "task_polling_started", {
        account: shortMediaId(accountId),
        task: shortMediaId(taskId),
        mode: once ? "once" : "wait",
      }),
    );

    while (!effectiveSignal.aborted) {
      pollCount += 1;
      let json: Record<string, unknown> | null = null;

      const nodeResponse = await fetch(pollUrl, {
        method: "GET",
        headers: requestHeaders,
        signal: effectiveSignal,
      });

      if (nodeResponse.ok) {
        const rawBody = await nodeResponse.text().catch(() => "");
        if (!looksLikeAntiBotChallengeText(rawBody)) {
          json = parseJsonIfPossible(rawBody) as Record<string, unknown> | null;
        }
      }

      if (!json) {
        try {
          const browserJson = await fetchJsonInBrowser(accountId, pollUrl);
          json = browserJson as Record<string, unknown> | null;
        } catch (error) {
          logMediaWarn(
            mediaLog("video", "task_poll_fallback_failed", {
              account: shortMediaId(accountId),
              task: shortMediaId(taskId),
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }

      if (!json) {
        throw new UpstreamError(
          `Failed to poll video task: no response from Node or browser paths`,
        );
      }

      const status =
        (json.task_status as string) ||
        (json.status as string) ||
        "running";
      const videoUrl =
        (json.video_url as string) ||
        ((json.data as Record<string, unknown> | undefined)
          ?.video_url as string | undefined) ||
        ((json.output as Record<string, unknown> | undefined)
          ?.video_url as string | undefined) ||
        extractMediaUrl(json, "video") ||
        undefined;
      const error =
        (json.error as string) ||
        ((json.data as Record<string, unknown> | undefined)
          ?.error as string | undefined) ||
        undefined;

      if (
        status === "completed" ||
        status === "success" ||
        status === "failed" ||
        status === "error"
      ) {
        const finished = status === "completed" || status === "success";
        logMediaInfo(
          mediaLog("video", "task_finished", {
            account: shortMediaId(accountId),
            task: shortMediaId(taskId),
            status,
            result: finished ? "completed" : "failed",
            polls: pollCount,
            elapsed_ms: Date.now() - pollStartedAt,
            error: finished ? undefined : error,
          }),
        );
        return {
          status: finished ? "completed" : "failed",
          video_url: videoUrl,
          error: finished ? undefined : error || `Task ended with status: ${status}`,
        };
      }

      const now = Date.now();
      if (
        once ||
        pollCount === 1 ||
        status !== lastLoggedStatus ||
        now - lastProgressLogAt >= 30_000
      ) {
        logMediaDebug(
          mediaLog("video", "task_polling", {
            account: shortMediaId(accountId),
            task: shortMediaId(taskId),
            status,
            poll: pollCount,
            elapsed_ms: now - pollStartedAt,
            mode: once ? "once" : undefined,
          }),
        );
        lastProgressLogAt = now;
        lastLoggedStatus = status;
      }

      if (once) {
        return {
          status: "pending",
          video_url: videoUrl,
          error: undefined,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
    }

    logMediaWarn(
      mediaLog("video", "task_polling_aborted", {
        account: shortMediaId(accountId),
        task: shortMediaId(taskId),
        polls: pollCount,
        elapsed_ms: Date.now() - pollStartedAt,
      }),
    );
    return { status: "pending", error: "Polling aborted" };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** GET a URL inside the account's Playwright page (live session, no WAF). */
async function fetchJsonInBrowser(
  accountId: string,
  url: string,
): Promise<unknown> {
  return withAccountPage(
    accountId,
    (page) =>
      page.evaluate(
        async (req) => {
          try {
            const response = await fetch(req.url, {
              method: "GET",
              credentials: "include",
              headers: {
                Accept: "application/json",
                source: "web",
              },
            });
            if (!response.ok) return null;
            return await response.json();
          } catch {
            return null;
          }
        },
        { url },
      ),
    30_000,
    30_000,
  );
}

