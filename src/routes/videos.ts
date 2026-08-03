import type { Context } from "hono";
import { generateVideo, pollVideoTask } from "../services/media-generation.ts";
import { logger } from "../core/logger.ts";
import { sendOpenAIError } from "../api/error-helpers.ts";
import { NotFoundError, ValidationError } from "../core/errors.ts";

const DEFAULT_SIZE = "16:9";

const VALID_SIZES = new Set([
  "1024x1024",
  "1792x1024",
  "1024x1792",
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "auto",
]);

const TASK_TTL_MS = 60 * 60_000;

type MediaTaskStatus = "pending" | "running" | "completed" | "failed";

interface VideoTaskEntry {
  accountId: string;
  chatId: string;
  createdAt: number;
  status: MediaTaskStatus;
  videoUrl?: string;
}

interface VideosGenerationsRequest {
  model?: unknown;
  prompt?: unknown;
  size?: unknown;
  wait?: unknown;
}

const videoTasks = new Map<string, VideoTaskEntry>();

function cleanupExpiredTasks(): void {
  const cutoff = Date.now() - TASK_TTL_MS;
  for (const [taskId, entry] of videoTasks) {
    if (entry.createdAt < cutoff) {
      videoTasks.delete(taskId);
    }
  }
}

function validationError(message: string, param: string): ValidationError {
  const err = new ValidationError(message);
  err.param = param;
  return err;
}

export async function videosGenerations(c: Context): Promise<Response> {
  cleanupExpiredTasks();

  let body: VideosGenerationsRequest;
  try {
    body = await c.req.json();
  } catch {
    return sendOpenAIError(c, new ValidationError("Request body must be valid JSON"));
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return sendOpenAIError(
      c,
      validationError("`prompt` must be a non-empty string", "prompt"),
    );
  }

  const size = body.size === undefined ? DEFAULT_SIZE : body.size;
  if (typeof size !== "string" || !VALID_SIZES.has(size)) {
    return sendOpenAIError(
      c,
      validationError(`\`size\` must be one of: ${[...VALID_SIZES].join(", ")}`, "size"),
    );
  }

  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : "";
  if (!model) {
    return sendOpenAIError(
      c,
      validationError("`model` must be the model selected by the client", "model"),
    );
  }
  const wait = body.wait !== false;

  logger.info("Video generation request", {
    model,
    size,
    wait,
  });

  try {
    const result = await generateVideo({
      model,
      prompt,
      size,
      waitForCompletion: wait,
    });

    const created = Math.floor(Date.now() / 1000);

    // The upstream can return the video URL inline, without a task id.
    if (!result.task_id) {
      if (result.status === "completed" && result.video_url) {
        return c.json({
          created,
          task_id: "",
          status: "completed",
          data: [{ url: result.video_url }],
        });
      }
      return sendOpenAIError(
        c,
        new Error("Video generation returned no task or video URL"),
        500,
      );
    }

    videoTasks.set(result.task_id, {
      accountId: result.accountId,
      chatId: result.chatId,
      createdAt: Date.now(),
      status: result.status,
      videoUrl: result.video_url,
    });

    if (result.status === "failed") {
      logger.error("Video generation task failed", { taskId: result.task_id });
      return sendOpenAIError(c, new Error("Video generation failed"), 500);
    }

    if (result.status === "completed") {
      return c.json({
        created,
        task_id: result.task_id,
        status: "completed",
        data: [{ url: result.video_url }],
      });
    }

    // wait=false, or the upstream poll window elapsed before completion.
    return c.json({
      created,
      task_id: result.task_id,
      status: result.status,
    });
  } catch (error) {
    logger.error("Video generation failed", {
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    return sendOpenAIError(c, error, 500);
  }
}

export async function videoTaskStatus(c: Context): Promise<Response> {
  cleanupExpiredTasks();

  const taskId = c.req.param("taskId");
  if (!taskId) {
    return sendOpenAIError(c, new NotFoundError("Video task not found"));
  }

  const entry = videoTasks.get(taskId);
  if (!entry) {
    return sendOpenAIError(c, new NotFoundError(`Video task not found: ${taskId}`));
  }

  const wait = c.req.query("wait") === "true";

  try {
    const isTerminal = entry.status === "completed" || entry.status === "failed";
    if (wait && !isTerminal) {
      // pollVideoTask blocks until a terminal status or its internal timeout.
      const result = await pollVideoTask({ taskId, accountId: entry.accountId });
      entry.status = result.status;
      entry.videoUrl = result.video_url ?? entry.videoUrl;
      if (result.status === "failed") {
        logger.error("Video task failed", {
          taskId,
          error: result.error ?? "unknown",
        });
      }
    }

    return c.json({
      task_id: taskId,
      status: entry.status,
      video_url: entry.videoUrl ?? null,
      created: Math.floor(entry.createdAt / 1000),
    });
  } catch (error) {
    logger.error("Video task status check failed", {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return sendOpenAIError(c, error, 500);
  }
}
