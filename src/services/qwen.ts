import { getQwenHeaders, getBasicHeaders } from "./playwright.ts";
import { v4 as uuidv4 } from "uuid";
import { UpstreamRateLimit, UpstreamError, AuthError } from "../core/errors.js";
import { buildQwenRequestHeaders } from "./qwen-headers.ts";
import { config } from "../core/config.js";
import { logger } from "../core/logger.js";

export class RetryableQwenStreamError extends UpstreamRateLimit {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RetryableQwenStreamError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class QwenUpstreamError extends UpstreamError {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;

  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = "QwenUpstreamError";
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
  }
}

export class QwenSessionExpiredError extends AuthError {
  readonly accountId: string;

  constructor(message: string, accountId: string) {
    super(message);
    this.name = "QwenSessionExpiredError";
    this.accountId = accountId;
  }
}

interface SessionEntry {
  accountId: string;
  parentId: string | null;
  timestamp: number;
}

const sessionStates: Map<string, SessionEntry> =
  (globalThis as any)._sessionStates || new Map();
(globalThis as any)._sessionStates = sessionStates;

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function cleanupStaleSessions() {
  const now = Date.now();
  for (const [key, entry] of sessionStates.entries()) {
    if (now - entry.timestamp > SESSION_TTL_MS) {
      sessionStates.delete(key);
    }
  }
}

export function updateSessionParent(
  sessionId: string,
  parentId: string | null,
  accountId?: string,
) {
  if (!sessionId) return;

  if (sessionStates.size > 10000) {
    cleanupStaleSessions();
  }

  const existing = sessionStates.get(sessionId);
  sessionStates.set(sessionId, {
    accountId: accountId || existing?.accountId || "global",
    parentId,
    timestamp: Date.now(),
  });
}

export function clearAllSessionsForAccount(accountId: string): void {
  let removed = 0;

  for (const [key, entry] of sessionStates.entries()) {
    if (entry.accountId === accountId) {
      sessionStates.delete(key);
      removed++;
    }
  }

  console.log(`[Qwen] Cleared ${removed} session(s) for account ${accountId}`);
}

function getSessionParent(
  sessionId: string,
  accountId?: string,
): string | null | undefined {
  const entry = sessionStates.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > SESSION_TTL_MS) {
    sessionStates.delete(sessionId);
    return undefined;
  }
  if (accountId && entry.accountId !== accountId) {
    return undefined;
  }
  return entry.parentId;
}

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: "user" | "assistant";
  content: string;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: {
    thinking_enabled: boolean;
    output_schema: string;
    research_mode: string;
    auto_thinking: boolean;
    thinking_mode: string;
    thinking_format: string;
    auto_search: boolean;
  };
  extra: {
    meta: {
      subChatType: string;
    };
  };
  sub_chat_type: string;
  parent_id: string | null;
}

export interface QwenPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  chat_id: string | null;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
}

interface PublicQwenModel {
  id: string;
  name: string;
  object: "model";
  owned_by: string;
  created: number;
  context_window?: number;
  capabilities?: any;
}

let cachedModels: PublicQwenModel[] | null = null;
let lastModelsFetch = 0;

const nativeToolsDisabled = new Set<string>();
const disablingNativeToolsInProgress = new Set<string>();

export async function disableNativeTools(accountId?: string): Promise<void> {
  const cacheKey = accountId || "global";
  if (
    nativeToolsDisabled.has(cacheKey) ||
    disablingNativeToolsInProgress.has(cacheKey)
  ) {
    return;
  }
  disablingNativeToolsInProgress.add(cacheKey);

  try {
    const { headers } = await getQwenHeaders(false, accountId);

    const payload = {
      tools_enabled: {
        web_extractor: false,
        web_search_image: false,
        web_search: false,
        image_gen_tool: false,
        code_interpreter: false,
        history_retriever: false,
        image_edit_tool: false,
        bio: false,
        image_zoom_in_tool: false,
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeouts.http);
    const response = await fetch(
      "https://chat.qwen.ai/api/v2/users/user/settings/update",
      {
        method: "POST",
        headers: buildQwenRequestHeaders({
          cookie: headers["cookie"],
          userAgent: headers["user-agent"],
          bxUa: headers["bx-ua"],
          bxUmidtoken: headers["bx-umidtoken"],
          bxV: headers["bx-v"],
        }),
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      console.error(
        `[Qwen] Failed to disable native tools for ${cacheKey}: ${response.status} - ${text}`,
      );
    } else {
      console.log(`[Qwen] Native tools disabled successfully for ${cacheKey}.`);
      nativeToolsDisabled.add(cacheKey);
    }
  } catch (err: any) {
    console.error(
      `[Qwen] Error disabling native tools for ${cacheKey}: ${err.message}`,
    );
  } finally {
    disablingNativeToolsInProgress.delete(cacheKey);
  }
}

function formatPublicQwenModel(
  model: any,
  noThinking = false,
): PublicQwenModel {
  return {
    id: noThinking ? `${model.id}-no-thinking` : model.id,
    name: noThinking ? `${model.name} (No Thinking)` : model.name,
    object: "model",
    owned_by: model.owned_by || "qwen",
    created: model.info?.created_at || Date.now(),
    context_window: model.info?.meta?.max_context_length,
    capabilities: model.info?.meta?.capabilities,
  };
}

export async function fetchQwenModels(
  accountId?: string,
): Promise<PublicQwenModel[]> {
  const now = Date.now();
  if (cachedModels && now - lastModelsFetch < 3600000) {
    // 1 hour cache
    return cachedModels;
  }

  const { cookie, userAgent, bxV } = await getBasicHeaders(accountId);

  const response = await fetch("https://chat.qwen.ai/api/models", {
    headers: buildQwenRequestHeaders({
      cookie,
      userAgent,
      bxV,
      extra: {
        timezone: new Date().toString(),
        source: "web",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models from Qwen: ${response.status} ${response.statusText}`,
    );
  }

  const json = await response.json();
  if (json.data && Array.isArray(json.data)) {
    const models = json.data.flatMap((model: any) => [
      formatPublicQwenModel(model),
      formatPublicQwenModel(model, true),
    ]);

    cachedModels = models;
    lastModelsFetch = now;
    return models;
  }

  return [];
}

export interface QwenFileEntry {
  type: string;
  file: any;
  id: string;
  url: string;
  name: string;
  [key: string]: any;
}

export async function createQwenStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId?: string | null,
  accountId?: string,
  files?: QwenFileEntry[],
): Promise<{
  stream: ReadableStream;
  headers: Record<string, string>;
  uiSessionId: string;
  controller: AbortController;
  accountId: string;
}> {
  // A new logical chat session should reuse the warmed header cache when available.
  // Header recapture is much more expensive and should be reserved for real refresh/login cases,
  // not for ordinary first prompts that simply need parent_id reset.
  const { headers, chatSessionId, parentMessageId } = await getQwenHeaders(
    false,
    accountId,
  );

  let actualParentId: string | null = parentMessageId;

  if (forcedParentId !== undefined) {
    actualParentId = forcedParentId;
    if (chatSessionId && forcedParentId === null) {
      updateSessionParent(chatSessionId, null, accountId ?? "global");
    }
  } else if (chatSessionId) {
    const storedParent = getSessionParent(chatSessionId, accountId ?? "global");
    if (storedParent !== undefined) {
      actualParentId = storedParent;
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const fid = uuidv4();
  const model = modelId.replace("-no-thinking", "");

  const payload: QwenPayload = {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chat_id: chatSessionId || null,
    chat_mode: "normal",
    model: model,
    parent_id: actualParentId,
    messages: [
      {
        fid: fid,
        parentId: actualParentId,
        childrenIds: [],
        role: "user",
        content: prompt,
        user_action: "chat",
        files: files || [],
        timestamp: timestamp,
        models: [model],
        chat_type: "t2t",
        feature_config: {
          thinking_enabled: enableThinking,
          output_schema: "phase",
          research_mode: "normal",
          auto_thinking: false,
          thinking_mode: "Thinking",
          thinking_format: "summary",
          auto_search: false,
        },
        extra: {
          meta: {
            subChatType: "t2t",
          },
        },
        sub_chat_type: "t2t",
        parent_id: actualParentId,
      },
    ],
    timestamp: timestamp + 1,
  };

  const url = chatSessionId
    ? `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatSessionId}`
    : "https://chat.qwen.ai/api/v2/chat/completions";

  const controller = new AbortController();
  const timeoutMs = enableThinking || modelId.includes('thinking')
    ? config.timeouts.reasoningModelTimeout
    : config.timeouts.totalRequestTimeout;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildQwenRequestHeaders({
        cookie: headers["cookie"],
        userAgent: headers["user-agent"],
        bxUa: headers["bx-ua"],
        bxUmidtoken: headers["bx-umidtoken"],
        bxV: headers["bx-v"],
        chatSessionId,
        extra: {
          Accept: "application/json",
          timezone: new Date().toString().split(" (")[0],
          "x-accel-buffering": "no",
        },
      }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => "");
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      try {
        const errorJson = JSON.parse(errText);
        if (
          errorJson?.data?.details?.includes("chat is in progress") ||
          errorJson?.data?.details?.includes("The chat is in progress")
        ) {
          const attempt = errorJson.data?.retryCount ?? 1;
          const baseDelay = 2000;
          const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
          const cappedDelay = Math.min(exponentialDelay, 30000);
          const jitter = cappedDelay * 0.2 * Math.random();
          const retryAfterMs = Math.floor(cappedDelay + jitter);

          throw new RetryableQwenStreamError(
            `Qwen: ${errorJson.data.details}`,
            retryAfterMs,
          );
        }
        if (errorJson?.success === false) {
          const code =
            errorJson.data?.code || errorJson.code || "UpstreamError";
          const details =
            errorJson.data?.details ||
            errorJson.message ||
            "Qwen returned an error";

          if (
            response.status === 401 ||
            code === "Unauthorized" ||
            details.includes("login") ||
            details.includes("session")
          ) {
            throw new QwenSessionExpiredError(
              `Session expired: ${details}`,
              accountId || "global",
            );
          }

          const wait =
            errorJson.data?.num !== undefined
              ? ` Wait about ${errorJson.data.num} hour(s) before trying again.`
              : "";
          let status: number;
          if (code === "RateLimited") status = 429;
          else if (code === "Not_Found") status = 404;
          else if (code === "UpstreamError") status = 502;
          else status = 502;
          throw new QwenUpstreamError(
            `Qwen upstream error: ${code}: ${details}.${wait}`,
            code,
            status,
          );
        }
        if (
          errorJson?.data?.details?.includes("is not exist") ||
          errorJson?.data?.details?.includes("not exist") ||
          errorJson?.data?.details?.includes("does not exist")
        ) {
          const attempt = errorJson.data?.retryCount ?? 1;
          const retryAfterMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);

          throw new RetryableQwenStreamError(
            `Qwen: ${errorJson.data.details}`,
            retryAfterMs,
          );
        }
      } catch (parseOrRetryError) {
        if (
          parseOrRetryError instanceof RetryableQwenStreamError ||
          parseOrRetryError instanceof QwenUpstreamError ||
          parseOrRetryError instanceof QwenSessionExpiredError
        ) {
          throw parseOrRetryError;
        }
        // Log unexpected parsing or retry errors to prevent silent failures
        logger.warn("Unexpected error during stream error parsing", { error: parseOrRetryError });
      }
    }
    throw new Error(
      `Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${errText}`,
    );
  }

  return {
    stream: response.body,
    headers,
    uiSessionId: chatSessionId,
    controller,
    accountId: accountId ?? "global",
  };
}
