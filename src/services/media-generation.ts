import { v4 as uuidv4 } from "uuid";
import { getQwenHeaders } from "./auth-playwright.ts";
import { buildQwenRequestHeaders } from "./qwen-headers.ts";
import { config } from "../core/config.ts";
import { logger } from "../core/logger.ts";
import {
  getNextAvailableAccount,
  markAccountRateLimited,
} from "../core/account-manager.ts";
import { UpstreamError, AuthError } from "../core/errors.ts";

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
const DEFAULT_IMAGE_MODEL = "qwen3-vl-plus";
const DEFAULT_VIDEO_MODEL = "qwen3-vl-plus";
const VIDEO_POLL_INTERVAL_MS = 5_000;

function normalizeSize(size?: string): string | undefined {
  if (!size) return undefined;
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

function buildHeadersFromCaptured(
  headers: Record<string, string>,
  chatSessionId?: string,
): Record<string, string> {
  return buildQwenRequestHeaders({
    cookie: headers["cookie"],
    userAgent: headers["user-agent"],
    bxUa: headers["bx-ua"],
    bxUmidtoken: headers["bx-umidtoken"],
    bxV: headers["bx-v"],
    chatSessionId,
    extra: {
      Referer: chatSessionId
        ? `${config.qwen.baseUrl}/c/${chatSessionId}`
        : `${config.qwen.baseUrl}/c/new-chat`,
    },
  });
}

async function createMediaChatSession(
  headers: Record<string, string>,
  model: string,
  chatType: "t2i" | "t2v",
  signal: AbortSignal,
): Promise<string> {
  const title = chatType === "t2i" ? "Image Generation" : "Video Generation";

  const response = await fetch(`${config.qwen.baseUrl}/api/v2/chats/new`, {
    method: "POST",
    headers: buildHeadersFromCaptured(headers),
    body: JSON.stringify({
      title,
      models: [model],
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
  model: string,
  chatType: "t2i" | "t2v",
  size?: string,
): Record<string, unknown> {
  const fid = uuidv4();
  const childId = uuidv4();
  const nowSec = Math.floor(Date.now() / 1000);

  const content = size ? `${prompt}\nAspect ratio: ${size}` : prompt;

  return {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chatId,
    parentId: "",
    chat_id: chatId,
    chat_mode: "normal",
    model,
    parent_id: null,
    messages: [
      {
        id: null,
        fid,
        parentId: null,
        childrenIds: [childId],
        role: "user",
        content,
        user_action: "chat",
        files: [],
        timestamp: nowSec,
        models: [model],
        model: "",
        chat_type: chatType,
        feature_config: {
          thinking_enabled: false,
          output_schema: "phase",
          research_mode: "normal",
          auto_thinking: false,
          thinking_mode: "Fast",
          thinking_format: "summary",
          auto_search: false,
        },
        extra: { meta: { subChatType: chatType } },
        sub_chat_type: chatType,
        parent_id: null,
      },
    ],
    timestamp: nowSec + 1,
  };
}

interface SseParseResult {
  content: string;
  task_id?: string;
  width?: number;
  height?: number;
  image_count?: number;
}

function parseSseResponse(raw: string): SseParseResult {
  const result: SseParseResult = { content: "" };

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

export async function generateImage(params: {
  prompt: string;
  model?: string;
  size?: string;
  accountId?: string;
  signal?: AbortSignal;
}): Promise<ImageGenerationResult> {
  const {
    prompt,
    model = DEFAULT_IMAGE_MODEL,
    size,
    accountId: requestedAccountId,
    signal: externalSignal,
  } = params;

  const normalizedSize = normalizeSize(size);
  const triedAccounts = new Set<string>();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
    const account = requestedAccountId
      ? { id: requestedAccountId, email: requestedAccountId }
      : getNextAvailableAccount(triedAccounts);

    if (!account) {
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
      logger.info(
        `🎨 [MediaGen] Starting image generation | account=${account.id} | model=${model} | attempt=${attempt + 1}`,
      );

      const { headers } = await getQwenHeaders(false, account.id);
      const chatId = await createMediaChatSession(headers, model, "t2i", signal);

      logger.info(
        `🎨 [MediaGen] Chat session created | chatId=${chatId}`,
      );

      const payload = buildCompletionsPayload(chatId, prompt, model, "t2i", normalizedSize);
      const requestHeaders = buildHeadersFromCaptured(headers, chatId);

      const response = await fetch(
        `${config.qwen.baseUrl}/api/v2/chat/completions?chat_id=${chatId}`,
        {
          method: "POST",
          headers: {
            ...requestHeaders,
            Accept: "text/event-stream",
          },
          body: JSON.stringify(payload),
          signal,
        },
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new UpstreamError(
          `Image generation request failed: ${response.status} ${errText.substring(0, 200)}`,
        );
      }

      const rawBody = await response.text();
      const sseResult = parseSseResponse(rawBody);

      const imageUrl = extractUrlFromContent(sseResult.content);
      if (!imageUrl) {
        throw new UpstreamError(
          "No image URL found in generation response",
        );
      }

      logger.info(
        `🎨 [MediaGen] Image generated successfully | url=${imageUrl.substring(0, 80)}...`,
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

      logger.info(
        `🎨 [MediaGen] Attempt failed | account=${account.id} | error=${lastError.message}`,
      );

      markAccountRateLimited(account.id, ACCOUNT_COOLDOWN_MS, "MediaGenFailed");
    } finally {
      clearTimeout(timeoutId);
    }
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
    model = DEFAULT_VIDEO_MODEL,
    size,
    accountId: requestedAccountId,
    waitForCompletion = false,
    signal: externalSignal,
  } = params;

  const normalizedSize = normalizeSize(size);
  const triedAccounts = new Set<string>();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
    const account = requestedAccountId
      ? { id: requestedAccountId, email: requestedAccountId }
      : getNextAvailableAccount(triedAccounts);

    if (!account) {
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
      logger.info(
        `🎬 [MediaGen] Starting video generation | account=${account.id} | model=${model} | attempt=${attempt + 1}`,
      );

      const { headers } = await getQwenHeaders(false, account.id);
      const chatId = await createMediaChatSession(headers, model, "t2v", signal);

      logger.info(
        `🎬 [MediaGen] Chat session created | chatId=${chatId}`,
      );

      const payload = buildCompletionsPayload(chatId, prompt, model, "t2v", normalizedSize);
      const requestHeaders = buildHeadersFromCaptured(headers, chatId);

      const response = await fetch(
        `${config.qwen.baseUrl}/api/v2/chat/completions?chat_id=${chatId}`,
        {
          method: "POST",
          headers: {
            ...requestHeaders,
            Accept: "text/event-stream",
          },
          body: JSON.stringify(payload),
          signal,
        },
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new UpstreamError(
          `Video generation request failed: ${response.status} ${errText.substring(0, 200)}`,
        );
      }

      const rawBody = await response.text();
      const sseResult = parseSseResponse(rawBody);

      if (!sseResult.task_id) {
        const videoUrl = extractUrlFromContent(sseResult.content);
        if (videoUrl) {
          logger.info(
            `🎬 [MediaGen] Video URL received directly | url=${videoUrl.substring(0, 80)}...`,
          );
          return {
            task_id: "",
            status: "completed",
            video_url: videoUrl,
            accountId: account.id,
            chatId,
          };
        }
        throw new UpstreamError(
          "No task_id or video URL found in video generation response",
        );
      }

      logger.info(
        `🎬 [MediaGen] Video task submitted | task_id=${sseResult.task_id}`,
      );

      if (!waitForCompletion) {
        return {
          task_id: sseResult.task_id,
          status: "pending",
          accountId: account.id,
          chatId,
        };
      }

      const status = await pollVideoTask({
        taskId: sseResult.task_id,
        accountId: account.id,
        signal,
      });

      return {
        task_id: sseResult.task_id,
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

      logger.info(
        `🎬 [MediaGen] Attempt failed | account=${account.id} | error=${lastError.message}`,
      );

      markAccountRateLimited(account.id, ACCOUNT_COOLDOWN_MS, "MediaGenFailed");
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new UpstreamError(
    `Video generation failed after ${MAX_ACCOUNT_ATTEMPTS} attempts: ${lastError?.message}`,
  );
}

export async function pollVideoTask(params: {
  taskId: string;
  accountId: string;
  signal?: AbortSignal;
}): Promise<VideoTaskStatus> {
  const { taskId, accountId, signal } = params;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VIDEO_TIMEOUT_MS);

  const effectiveSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;

  try {
    const { headers } = await getQwenHeaders(false, accountId);
    const requestHeaders = buildHeadersFromCaptured(headers);

    while (!effectiveSignal.aborted) {
      const response = await fetch(
        `${config.qwen.baseUrl}/api/v2/tasks/${taskId}`,
        {
          method: "GET",
          headers: requestHeaders,
          signal: effectiveSignal,
        },
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new UpstreamError(
          `Failed to poll video task: ${response.status} ${errText.substring(0, 200)}`,
        );
      }

      const json = await response.json();
      const status = json?.status || json?.data?.status || "running";
      const videoUrl =
        json?.video_url ||
        json?.data?.video_url ||
        json?.output?.video_url ||
        undefined;
      const error = json?.error || json?.data?.error || undefined;

      if (status === "completed" || status === "failed") {
        logger.info(
          `🎬 [MediaGen] Video task finished | task_id=${taskId} | status=${status}`,
        );
        return { status, video_url: videoUrl, error };
      }

      logger.info(
        `🎬 [MediaGen] Polling video task | task_id=${taskId} | status=${status}`,
      );

      await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
    }

    return { status: "pending", error: "Polling aborted" };
  } finally {
    clearTimeout(timeoutId);
  }
}
