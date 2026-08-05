/*
 * File: media.ts
 * Project: QwenBridge
 *
 * Native image/video generation over /v1/chat/completions. When the client
 * selects a generation-specific model (qwen-image-*, wan2.*), the request is
 * routed here instead of the text chat flow, mirroring how the Qwen web app
 * switches chat_type to t2i/t2v. The media URL is returned as the assistant
 * message content in a standard chat.completion / chat.completion.chunk.
 */

import type { Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import type { OpenAIRequest } from "../../utils/types.ts";
import {
  generateImage,
  generateVideo,
  isSupportedMediaSize,
  MEDIA_SIZE_OPTIONS,
  logMediaError,
  logMediaInfo,
  mediaLog,
  supportsPromptMediaGeneration,
} from "../../services/media-generation.ts";
import { sendOpenAIError } from "../../api/error-helpers.ts";
import { ValidationError } from "../../core/errors.ts";


const IMAGE_DEFAULT_SIZE = "auto";
const VIDEO_DEFAULT_SIZE = "16:9";
const STREAM_HEARTBEAT_MS = 15_000;

interface MediaChatParams {
  c: Context;
  body: OpenAIRequest;
  model: string;
  kind: "image" | "video";
  isStream: boolean;
}

/**
 * Chatbox renders Markdown images but not HTML/video nodes. Keep the video
 * response portable as a clickable Markdown link; the browser can play the
 * MP4 when the link is opened.
 */
export function formatGeneratedVideoContent(videoUrl: string): string {
  return `[🎬 Generated video](${videoUrl})`;
}

/**
 * Extracts the generation prompt from the last user message. Accepts both
 * plain-string content and multimodal arrays (using the text parts).
 */
function extractPrompt(body: OpenAIRequest): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (Array.isArray(content)) {
      const text = (content as Array<{ type?: string; text?: unknown }>)
        .filter((part) => part?.type === "text")
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

function estimatePromptTokens(prompt: string): number {
  return Math.max(1, Math.ceil(prompt.length / 4));
}

function makeCompletionId(): string {
  return `chatcmpl-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export async function handleMediaChatCompletion(
  params: MediaChatParams,
): Promise<Response> {
  const { c, body, model, kind, isStream } = params;

  const prompt = extractPrompt(body);
  if (!prompt) {
    const err = new ValidationError(
      "The last user message must contain a non-empty prompt for media generation",
    );
    err.param = "messages";
    return sendOpenAIError(c, err);
  }

  if (!supportsPromptMediaGeneration(model, kind)) {
    const err = new ValidationError(
      `Model \`${model}\` requires a reference image and is not available through prompt-only chat generation yet`,
    );
    err.param = "model";
    return sendOpenAIError(c, err);
  }

  const requestedSize = body.size;
  if (
    requestedSize !== undefined &&
    !isSupportedMediaSize(requestedSize)
  ) {
    const err = new ValidationError(
      `\`size\` must be one of: ${MEDIA_SIZE_OPTIONS.join(", ")}`,
    );
    err.param = "size";
    return sendOpenAIError(c, err);
  }

  const size =
    requestedSize ?? (kind === "image" ? IMAGE_DEFAULT_SIZE : VIDEO_DEFAULT_SIZE);
  const created = Math.floor(Date.now() / 1000);
  const completionId = makeCompletionId();
  const requestSignal = c.req.raw?.signal;
  const startedAt = Date.now();

  logMediaInfo(
    mediaLog(kind, "request_started", {
      operation: "chat.completions",
      model,
      prompt_chars: prompt.length,
      size,
      stream: isStream,
    }),
  );

  const generate = async (): Promise<string> => {
    if (kind === "image") {
      const result = await generateImage({
        prompt,
        model,
        size,
        signal: requestSignal,
      });
      return `![Generated image](${result.url})`;
    }
    const result = await generateVideo({
      prompt,
      model,
      size,
      waitForCompletion: true,
      signal: requestSignal,
    });
    if (result.status === "completed" && result.video_url) {
      return formatGeneratedVideoContent(result.video_url);
    }
    throw new Error(
      result.status === "failed"
        ? "Video generation failed"
        : "Video generation did not complete in time",
    );
  };

  const promptTokens = estimatePromptTokens(prompt);
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: 0,
    total_tokens: promptTokens,
  };
  const includeUsage = body.stream_options?.include_usage === true;

  // ---- Non-streaming: return a complete chat.completion object ----
  if (!isStream) {
    try {
      const content = await generate();
      return c.json({
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage,
      });
    } catch (error) {
      logMediaError(
        mediaLog(kind, "request_failed", {
          operation: "chat.completions",
          model,
          stream: false,
          duration_ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return sendOpenAIError(c, error, 500);
    }
  }

  // ---- Streaming: role chunk, heartbeats while generating, then content ----
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  return honoStream(c, async (stream) => {
    const encoder = new TextEncoder();
    const writeChunk = async (payload: Record<string, unknown>) => {
      await stream.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    };

    const baseChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
    };

    let heartbeat: ReturnType<typeof setInterval> | undefined;

    try {
      await writeChunk({
        ...baseChunk,
        choices: [
          { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
        ],
      });

      // Generation can take up to ~120s (image) / ~300s (video). Keep the
      // connection alive so clients do not time out while Qwen renders.
      heartbeat = setInterval(() => {
        stream.write(encoder.encode(": keep-alive\n\n")).catch(() => {});
      }, STREAM_HEARTBEAT_MS);

      let content: string;
      try {
        content = await generate();
      } finally {
        clearInterval(heartbeat);
      }

      await writeChunk({
        ...baseChunk,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      });
      await writeChunk({
        ...baseChunk,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        ...(includeUsage ? { usage } : {}),
      });
      await stream.write(encoder.encode("data: [DONE]\n\n"));
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      const message = error instanceof Error ? error.message : String(error);
      logMediaError(
        mediaLog(kind, "request_failed", {
          operation: "chat.completions",
          model,
          stream: true,
          duration_ms: Date.now() - startedAt,
          error: message,
        }),
      );
      try {
        await writeChunk({
          ...baseChunk,
          choices: [
            {
              index: 0,
              delta: { content: `⚠️ Media generation failed: ${message}` },
              finish_reason: null,
            },
          ],
        });
        await writeChunk({
          ...baseChunk,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        await stream.write(encoder.encode("data: [DONE]\n\n"));
      } catch {
        // Client already disconnected; nothing else to do.
      }
    }
  });
}
