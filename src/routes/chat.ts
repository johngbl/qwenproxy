/*
 * File: chat.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import { v4 as uuidv4 } from "uuid";
import {
  createQwenStream,
  updateSessionParent,
  QwenSessionExpiredError,
  clearAllSessionsForAccount,
  RetryableQwenStreamError,
} from "../services/qwen.ts";
import { OpenAIRequest, Usage } from "../utils/types.ts";
import { StreamingToolParser } from "../tools/parser.ts";
import { Mutex } from "../services/playwright.ts";
import { getModelContextWindow } from "../core/model-registry.js";
import { processImagesForQwen, QwenFileEntry } from "./upload.ts";
import {
  truncateMessages,
  estimateTokenCount,
  PrioritizedMessage,
} from "../utils/context-truncation.ts";
import { StreamingReasoningTagSanitizer } from "../utils/reasoning-tags.ts";
import { config } from "../core/config.ts";
import {
  getNextAccount,
  getNextAvailableAccount,
  markAccountRateLimited,
  getAccountCooldownInfo,
} from "../core/account-manager.ts";
import { loadAccounts } from "../core/accounts.ts";
import {
  registerStream,
  removeStream,
  getStream,
  getStreamKeyBySessionAndResponse,
  getStreamKeyBySessionId,
  getStreamKeysBySessionId,
  updateStreamTargetResponseId,
} from "../core/stream-registry.ts";
import { metrics } from "../core/metrics.js";
import { logger, isToolcallDebugEnabled } from "../core/logger.js";
import { getCache } from "../api/server.ts";
import { deriveSessionId, detectTopicChange } from "../utils/topic-detector.ts";

const accountMutexes = new Map<string, Mutex>();
function getAccountMutex(accountId: string): Mutex {
  let mutex = accountMutexes.get(accountId);
  if (!mutex) {
    mutex = new Mutex();
    accountMutexes.set(accountId, mutex);
  }
  return mutex;
}

export interface DeltaResult {
  delta: string;
  matchedContent: string;
}

export function getIncrementalDelta(
  oldStr: string,
  newStr: string,
): DeltaResult {
  if (!oldStr) {
    return { delta: newStr, matchedContent: newStr };
  }
  if (newStr === oldStr) {
    return { delta: "", matchedContent: oldStr };
  }

  if (newStr.length >= oldStr.length && newStr.startsWith(oldStr)) {
    return {
      delta: newStr.substring(oldStr.length),
      matchedContent: newStr,
    };
  }

  // Heuristic to detect if newStr is cumulative or incremental:
  // If newStr is cumulative, it should share a common prefix with oldStr.
  // Limit scan window to avoid O(n) overlap scanning on ambiguous content.
  const scanWindow = Math.min(2000, oldStr.length);
  let commonPrefixLen = 0;
  const maxLen = Math.min(scanWindow, newStr.length);
  while (
    commonPrefixLen < maxLen &&
    oldStr[commonPrefixLen] === newStr[commonPrefixLen]
  ) {
    commonPrefixLen++;
  }

  const threshold = Math.min(scanWindow, 4);
  if (commonPrefixLen >= threshold) {
    return {
      delta: newStr.substring(commonPrefixLen),
      matchedContent: newStr,
    };
  }

  // If the prefix check fails, we treat it as strictly incremental (or pure delta).
  // We avoid fallback search/sliding overlap checks which cause disastrous false-positive
  // corruptions on incremental streams with repetitive code/words (like "import {", "const", etc.).
  return {
    delta: newStr,
    matchedContent: oldStr + newStr,
  };
}

export function formatThinkingSummaryContent(delta: any): string {
  const titles = Array.isArray(delta?.extra?.summary_title?.content)
    ? delta.extra.summary_title.content.filter(
        (item: unknown): item is string => typeof item === "string",
      )
    : [];
  const thoughts = Array.isArray(delta?.extra?.summary_thought?.content)
    ? delta.extra.summary_thought.content.filter(
        (item: unknown): item is string => typeof item === "string",
      )
    : [];

  const sectionCount = Math.max(titles.length, thoughts.length);
  const sections: string[] = [];

  for (let i = 0; i < sectionCount; i++) {
    const title = titles[i]?.trim() || "";
    const thought = thoughts[i]?.trim() || "";

    if (title && thought) {
      sections.push(`**${title}**\n\n${thought}`);
    } else if (title) {
      sections.push(`**${title}**`);
    } else if (thought) {
      sections.push(thought);
    }
  }

  return sections.join("\n\n");
}

function parseQwenErrorPayload(
  raw: string,
): { message: string; status: number } | null {
  const text = raw.trim();
  if (!text || text.startsWith("data: ")) return null;

  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || "UpstreamError";
      const details =
        payload.data?.details || payload.message || "Qwen returned an error";
      const wait =
        payload.data?.num !== undefined
          ? ` Wait about ${payload.data.num} hour(s) before trying again.`
          : "";
      const status =
        code === "RateLimited" ? 429 : code === "Not_Found" ? 404 : 502;
      return {
        message: `Qwen upstream error: ${code}: ${details}.${wait}`,
        status,
      };
    }
    if (payload && payload.error) {
      const msg =
        typeof payload.error === "string"
          ? payload.error
          : payload.error.message || JSON.stringify(payload.error);
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    // Non-SSE, non-JSON upstream body. Keep this as an explicit bad gateway
    // instead of silently returning an empty assistant message.
    return {
      message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`,
      status: 502,
    };
  }

  return null;
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === "AbortError";
  }

  if (!err || typeof err !== "object") return false;

  const maybeError = err as { name?: unknown; message?: unknown };
  const name = maybeError.name;
  const message = maybeError.message;

  return (
    name === "AbortError" ||
    (typeof message === "string" && /abort(ed)?/i.test(message))
  );
}

export function shouldSuppressStreamAbort(
  err: unknown,
  clientDisconnected: boolean,
  requestAborted: boolean,
  streamStillRegistered: boolean,
): boolean {
  return (
    isAbortError(err) &&
    (clientDisconnected || requestAborted || !streamStillRegistered)
  );
}

interface UsageAccumulator {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  hasRealPromptTokens: boolean;
  hasRealCompletionTokens: boolean;
  hasRealTotalTokens: boolean;
  cachedPromptTokens: number;
  promptTextTokens?: number;
  reasoningTokens?: number;
  completionTextTokens?: number;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function createUsageAccumulator(
  estimatedPromptTokens: number,
): UsageAccumulator {
  return {
    promptTokens: estimatedPromptTokens,
    completionTokens: 0,
    totalTokens: estimatedPromptTokens,
    hasRealPromptTokens: false,
    hasRealCompletionTokens: false,
    hasRealTotalTokens: false,
    cachedPromptTokens: 0,
  };
}

function applyUpstreamUsage(
  accumulator: UsageAccumulator,
  candidate: unknown,
): void {
  if (!candidate || typeof candidate !== "object") return;

  const usage = candidate as Record<string, unknown>;
  const promptTokens = asFiniteNumber(usage.input_tokens);
  const completionTokens = asFiniteNumber(usage.output_tokens);
  const totalTokens = asFiniteNumber(usage.total_tokens);

  if (promptTokens !== null) {
    accumulator.promptTokens = promptTokens;
    accumulator.hasRealPromptTokens = true;
  }

  if (completionTokens !== null) {
    accumulator.completionTokens = completionTokens;
    accumulator.hasRealCompletionTokens = true;
  }

  if (totalTokens !== null) {
    accumulator.totalTokens = totalTokens;
    accumulator.hasRealTotalTokens = true;
  }

  const promptTokensDetails =
    usage.prompt_tokens_details &&
    typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : null;
  const inputTokensDetails =
    usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? (usage.input_tokens_details as Record<string, unknown>)
      : null;
  const outputTokensDetails =
    usage.output_tokens_details &&
    typeof usage.output_tokens_details === "object"
      ? (usage.output_tokens_details as Record<string, unknown>)
      : null;

  const cachedTokens = asFiniteNumber(promptTokensDetails?.cached_tokens);
  if (cachedTokens !== null) {
    accumulator.cachedPromptTokens = cachedTokens;
  }

  const promptTextTokens = asFiniteNumber(inputTokensDetails?.text_tokens);
  if (promptTextTokens !== null) {
    accumulator.promptTextTokens = promptTextTokens;
  }

  const reasoningTokens = asFiniteNumber(outputTokensDetails?.reasoning_tokens);
  if (reasoningTokens !== null) {
    accumulator.reasoningTokens = reasoningTokens;
  }

  const completionTextTokens = asFiniteNumber(outputTokensDetails?.text_tokens);
  if (completionTextTokens !== null) {
    accumulator.completionTextTokens = completionTextTokens;
  }
}

function buildUsage(accumulator: UsageAccumulator): Usage {
  const usage: Usage = {
    prompt_tokens: accumulator.promptTokens,
    completion_tokens: accumulator.completionTokens,
    total_tokens: accumulator.hasRealTotalTokens
      ? accumulator.totalTokens
      : accumulator.promptTokens + accumulator.completionTokens,
    prompt_tokens_details: {
      cached_tokens: accumulator.cachedPromptTokens,
      ...(accumulator.promptTextTokens !== undefined
        ? { text_tokens: accumulator.promptTextTokens }
        : {}),
    },
  };

  if (
    accumulator.reasoningTokens !== undefined ||
    accumulator.completionTextTokens !== undefined
  ) {
    usage.completion_tokens_details = {
      ...(accumulator.reasoningTokens !== undefined
        ? { reasoning_tokens: accumulator.reasoningTokens }
        : {}),
      ...(accumulator.completionTextTokens !== undefined
        ? { text_tokens: accumulator.completionTextTokens }
        : {}),
    };
  }

  return usage;
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    const isInternalSummarizationRequest =
      c.req.header("X-Internal-Summarization") === "true";
    const conversationKey =
      typeof body.session_id === "string" && body.session_id.trim().length > 0
        ? body.session_id.trim()
        : typeof body.conversation_id === "string" &&
            body.conversation_id.trim().length > 0
          ? body.conversation_id.trim()
          : null;

    // Extract the prompt
    const promptParts: string[] = [];
    const messages = body.messages || [];
    const systemPromptParts: string[] = [];
    const toolCallNamesById = new Map<string, string>();
    const allFiles: QwenFileEntry[] = [];

    // Get headers for image upload
    let uploadHeaders: Record<string, string> | null = null;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      let contentStr = "";
      if (Array.isArray(msg.content)) {
        // Handle multimodal content (text + images + videos + audio + files)
        const imageParts = msg.content.filter(
          (p: any) =>
            (p.type === "image_url" && p.image_url?.url) ||
            (p.type === "video_url" && p.video_url?.url) ||
            (p.type === "audio_url" && p.audio_url?.url) ||
            (p.type === "file_url" && p.file_url?.url),
        );

        if (imageParts.length > 0) {
          // Process images for Qwen format
          try {
            if (!uploadHeaders) {
              const { getBasicHeaders } =
                await import("../services/playwright.ts");
              const { cookie, userAgent, bxV, bxUa, bxUmidtoken } =
                await getBasicHeaders();
              uploadHeaders = {
                cookie,
                "user-agent": userAgent,
                "bx-ua": bxUa,
                "bx-umidtoken": bxUmidtoken,
                "bx-v": bxV,
              };
            }
            const { text, files } = await processImagesForQwen(
              msg.content,
              uploadHeaders,
            );
            contentStr = text;
            allFiles.push(...files);
          } catch (err: any) {
            console.error("[Chat] Failed to process images:", err.message);
            // Fallback to text-only
            contentStr = msg.content
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join("\n");
          }
        } else {
          // No images, just extract text
          contentStr = msg.content
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n");
        }
      } else if (typeof msg.content === "object" && msg.content !== null) {
        contentStr = JSON.stringify(msg.content);
      } else {
        contentStr = msg.content || "";
      }

      if (msg.role === "system") {
        systemPromptParts.push((contentStr || "") + "\n\n");
      } else if (msg.role === "user") {
        promptParts.push(`User: ${contentStr || ""}\n\n`);
      } else if (msg.role === "assistant") {
        const assistantContentParts: string[] = [];
        const reasoning = (msg as any).reasoning_content;
        if (reasoning) {
          assistantContentParts.push(`<think>\n${reasoning}\n</think>\n`);
        }
        if (contentStr) {
          assistantContentParts.push(contentStr);
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] processing assistant tool_calls in history", {
              messageIndex: i,
              toolCallsCount: msg.tool_calls.length,
              toolCallNames: msg.tool_calls.map((tc: any) => tc.function?.name),
            });
          }
          for (const tc of msg.tool_calls) {
            const args = tc.function?.arguments;
            let parsedArgs: any = {};
            if (typeof args === "string") {
              try {
                parsedArgs = JSON.parse(args);
              } catch {
                parsedArgs = {};
              }
            } else if (args && typeof args === "object") {
              parsedArgs = args;
            }
            const payload = {
              name: tc.function?.name,
              arguments: parsedArgs,
            };
            const toolCallStr = `\n<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`;
            assistantContentParts.push(
              assistantContentParts.length > 0
                ? toolCallStr
                : toolCallStr.trim(),
            );

            if (tc.id && tc.function?.name) {
              toolCallNamesById.set(tc.id, tc.function.name);
            }

            if (isToolcallDebugEnabled()) {
              logger.debug("[chat] tool_call serialized to prompt", {
                toolName: tc.function?.name,
                toolCallId: tc.id,
                argsKeys: Object.keys(parsedArgs),
              });
            }
          }
        }
        const assistantContent = assistantContentParts.join("");
        promptParts.push(`Assistant: ${assistantContent.trim()}\n\n`);
      } else if (msg.role === "tool" || msg.role === "function") {
        let toolName =
          msg.name ||
          (msg.tool_call_id
            ? toolCallNamesById.get(msg.tool_call_id)
            : undefined);
        if (!toolName && msg.tool_call_id) {
          // Fallback: look up tool name in history by tool_call_id
          for (let j = i - 1; j >= 0; j--) {
            const prevMsg = messages[j];
            if (prevMsg.role === "assistant" && prevMsg.tool_calls) {
              const call = prevMsg.tool_calls.find(
                (tc) => tc.id === msg.tool_call_id,
              );
              if (call) {
                toolName = call.function?.name;
                if (toolName) {
                  toolCallNamesById.set(msg.tool_call_id, toolName);
                }
                break;
              }
            }
          }
        }
        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] processing tool response in history", {
            messageIndex: i,
            toolName,
            toolCallId: msg.tool_call_id,
            contentLength: contentStr.length,
            contentPreview: contentStr.substring(0, 200),
          });
        }
        promptParts.push(
          `Tool Response (${toolName || "tool"}): ${contentStr || ""}\n\n`,
        );
      }
    }

    // Inject tools instructions
    const bodyAny = body as any;
    const declaredTools = Array.isArray(bodyAny.tools) ? bodyAny.tools : [];
    const shouldParseToolCalls = declaredTools.length > 0;
    if (shouldParseToolCalls) {
      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] tools provided in request", {
          toolsCount: declaredTools.length,
          toolNames: declaredTools.map((t: any) =>
            t.type === "function" ? t.function?.name : t.name,
          ),
          toolChoice: bodyAny.tool_choice || "none",
        });
      }

      // Better formatting for tools
      const formattedTools = declaredTools.map((t: any) => {
        if (t.type === "function") {
          return {
            name: t.function.name,
            description: t.function.description || "",
            parameters: t.function.parameters,
          };
        }
        return t;
      });
      const toolsJson = JSON.stringify(formattedTools, null, 2);

      systemPromptParts.push(
        `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nEXAMPLE OF MULTIPLE TOOL CALLS:\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file1.txt"}}\n</tool_call>\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file2.txt"}}\n</tool_call>\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n2. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n3. Do NOT output any other text (explanations, chat, etc.) after your <tool_call> blocks. Wait for the user to provide the tool response.\n4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.\n5. If you need to use a tool, do it IMMEDIATELY without preamble.\n\n`,
      );

      if (
        bodyAny.tool_choice &&
        typeof bodyAny.tool_choice === "object" &&
        bodyAny.tool_choice.function
      ) {
        const forcedTool = bodyAny.tool_choice.function.name;
        systemPromptParts.push(
          `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`,
        );

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] forced tool_choice", { forcedTool });
        }
      }
    }

    const systemPrompt = systemPromptParts.join("");
    const prompt = promptParts.join("");

    const modelId = body.model.replace("-no-thinking", "");
    const modelContextWindow = getModelContextWindow(modelId);
    const estimatedTokens = estimateTokenCount(systemPrompt + prompt);

    // Topic detection is only enabled when the caller provides an explicit
    // conversation/session identifier. This avoids cross-conversation state
    // pollution from heuristic-only IDs.
    const sessionId =
      !isInternalSummarizationRequest && conversationKey
        ? deriveSessionId(messages, systemPrompt, conversationKey)
        : null;
    const cache = getCache();
    const topicAnalysis =
      cache && sessionId
        ? await detectTopicChange(messages, sessionId, cache).catch(() => null)
        : null;

    const summarizationTriggerTokens = Math.floor(modelContextWindow * 0.9);

    let finalPrompt: string;
    if (estimatedTokens > summarizationTriggerTokens) {
      const truncated = await truncateMessages(messages, {
        maxContextLength: modelContextWindow,
        systemPrompt,
        enableSummarization:
          !isInternalSummarizationRequest &&
          config.context.summarization.enabled,
        summarizationModel: config.context.summarization.model,
        minMessagesToKeep: config.context.minMessagesToKeep,
      });
      finalPrompt = truncated
        .map(
          (m: PrioritizedMessage) =>
            `${m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role}: ${m.content}`,
        )
        .join("\n\n");
    } else {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
    }

    const isThinkingModel = !body.model.includes("no-thinking");

    // A session is new if it doesn't have any assistant messages yet.
    // This handles cases where the first request has [System, User] messages.
    const isNewSession = !messages.some((m) => m.role === "assistant");
    const shouldResetUpstreamThread =
      isNewSession || topicAnalysis?.hasChanged === true;

    const configuredAccounts = process.env.TEST_MOCK_PLAYWRIGHT
      ? []
      : loadAccounts();

    // Account selection with fallback on rate-limit/failure.
    // If no explicit accounts are configured, fall back to the global Playwright session.
    let account = process.env.TEST_MOCK_PLAYWRIGHT
      ? { id: "mock-account", email: "mock@test.com", password: "" }
      : configuredAccounts.length > 0
        ? getNextAccount()
        : {
            id: "global",
            email: process.env.QWEN_EMAIL || "global-session",
            password: process.env.QWEN_PASSWORD || "",
          };

    let triedAccountIds = new Set<string>();
    let lastError: any = null;

    let stream: ReadableStream | undefined;
    let uiSessionId = "";
    let activeAccountId = "";
    const completionId = "chatcmpl-" + uuidv4();

    while (account) {
      const accountId = account.id;
      const accountEmail = account.email;

      if (triedAccountIds.has(accountId)) {
        account = getNextAvailableAccount(accountId);
        continue;
      }
      triedAccountIds.add(accountId);

      const cooldownInfo = getAccountCooldownInfo(accountId);
      if (cooldownInfo && accountId !== "global") {
        console.log(
          `[Chat] Skipping account ${accountEmail} (${accountId}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`,
        );
        account = getNextAvailableAccount(accountId);
        continue;
      }

      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] account selected", {
          accountId,
          accountEmail,
          isNewSession,
          isThinkingModel,
          promptLength: finalPrompt.length,
        });
      }

      try {
        let retries = 3;
        let retryDelay = 500;
        let success = false;

        while (retries > 0) {
          let attemptError: any = null;
          const accountMutex = getAccountMutex(accountId);
          const releaseAccountStartupLock = await accountMutex.acquire();

          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] account startup lock acquired", {
              accountId,
              accountEmail,
            });
          }

          try {
            const result = await createQwenStream(
              finalPrompt,
              isThinkingModel,
              body.model,
              shouldResetUpstreamThread ? null : undefined,
              accountId === "global" ? undefined : accountId,
              allFiles.length > 0 ? allFiles : undefined,
            );
            stream = result.stream;
            uiSessionId = result.uiSessionId;
            activeAccountId = result.accountId;
            registerStream(completionId, {
              abortController: result.controller,
              accountId: result.accountId,
              uiSessionId: result.uiSessionId,
              targetResponseId: "",
              headers: result.headers,
            });
            success = true;

            if (isToolcallDebugEnabled()) {
              logger.debug("[chat] stream created successfully", {
                accountId,
                accountEmail,
                uiSessionId,
                completionId,
              });
            }
          } catch (err: any) {
            attemptError = err;
          } finally {
            releaseAccountStartupLock();
          }

          if (success) {
            break;
          }

          retries--;
          const err = attemptError;

          if (!err) {
            lastError = new Error("Failed to create Qwen stream");
            break;
          }

          if (err.name === "QwenSessionExpiredError") {
            console.warn(
              `[Chat] Session expired for ${accountEmail} (${accountId}). Attempting re-login...`,
            );
            try {
              const { initPlaywrightForAccount } =
                await import("../services/playwright.ts");
              const { getAccountCredentials } =
                await import("../core/accounts.ts");
              const creds = getAccountCredentials(accountId);
              if (creds) {
                await initPlaywrightForAccount(creds, true);
                console.log(
                  `[Chat] Re-login successful for ${accountEmail}. Retrying...`,
                );
                continue;
              }
            } catch (reLoginErr: any) {
              console.error(
                `[Chat] Re-login failed for ${accountEmail}: ${reLoginErr.message}`,
              );
            }
            lastError = err;
            break;
          }

          if (
            err.upstreamCode === "RateLimited" ||
            err.upstreamStatus === 429
          ) {
            const hourHint = err.message?.match(/Wait about (\d+) hour/);
            const cooldownMs = hourHint
              ? parseInt(hourHint[1]) * 60 * 60 * 1000
              : undefined;
            markAccountRateLimited(accountId, cooldownMs, "RateLimited");
            console.warn(
              `[Chat] Account ${accountEmail} (${accountId}) rate-limited. Marked for cooldown.`,
            );
            lastError = err;
            break;
          }

          if (retries === 0) {
            if (err.upstreamStatus && err.upstreamStatus >= 500) {
              markAccountRateLimited(accountId, undefined, "ServerError");
              console.warn(
                `[Chat] Account ${accountEmail} (${accountId}) returned server error. Marked for cooldown.`,
              );
            }

            // Clear session state when "chat is in progress" persists
            if (
              err instanceof RetryableQwenStreamError ||
              err.message?.includes("in progress")
            ) {
              console.warn(
                `[Chat] Clearing session state for ${accountEmail} (${accountId}) due to persistent 'chat in progress'`,
              );
              clearAllSessionsForAccount(accountId);
            }

            lastError = err;
            break;
          }

          let useDelay = retryDelay;
          if (
            err instanceof RetryableQwenStreamError &&
            err.retryAfterMs !== undefined
          ) {
            useDelay = err.retryAfterMs;
          }
          const isRetryable =
            err instanceof RetryableQwenStreamError ||
            err.message?.includes("in progress") ||
            err.message?.includes("Bad_Request");
          if (!isRetryable) {
            lastError = err;
            break;
          }
          console.warn(
            `[Chat] Qwen request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left)`,
          );
          await new Promise((r) => setTimeout(r, useDelay));
          retryDelay = Math.min(retryDelay * 2, 5000);
        }

        if (success) {
          break;
        }

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] account failed, rotating", {
            accountId,
            accountEmail,
            triedAccounts: Array.from(triedAccountIds),
          });
        }

        account = getNextAvailableAccount(accountId);
        continue;
      } catch (err: any) {
        lastError = err;
        account = getNextAvailableAccount(accountId);
      }
    }

    if (!stream) {
      removeStream(completionId);

      if (!lastError && configuredAccounts.length > 0) {
        const cooldownInfos = configuredAccounts
          .map((configuredAccount) =>
            getAccountCooldownInfo(configuredAccount.id),
          )
          .filter(
            (
              info,
            ): info is NonNullable<ReturnType<typeof getAccountCooldownInfo>> =>
              info !== null,
          );

        if (cooldownInfos.length === configuredAccounts.length) {
          const retryAfterMs = Math.min(
            ...cooldownInfos.map((info) => info.remainingMs),
          );
          const cooldownError: any = new Error(
            `All configured accounts are on cooldown. Retry in about ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`,
          );
          cooldownError.upstreamStatus = 429;
          throw cooldownError;
        }
      }

      throw lastError || new Error("All accounts failed");
    }

    if (!isStream) {
      try {
        const reader = stream!.getReader();
        const decoder = new TextDecoder();

        let lastThinkingSummary = "";
        let reasoningBuffer = "";
        let lastRawContent = "";
        let finalContent = "";
        let targetResponseId: string | null = null;
        const toolParser = shouldParseToolCalls
          ? new StreamingToolParser(declaredTools)
          : null;
        const reasoningTagSanitizer = new StreamingReasoningTagSanitizer();
        const toolCallsOut: any[] = [];
        let loggedThinkTagLeak = false;
        let buffer = "";
        const usageAccumulator = createUsageAccumulator(
          Math.ceil(finalPrompt.length / 3.5),
        );

        const consumeAnswerText = (textChunk: string) => {
          if (!toolParser) {
            finalContent += textChunk;
            return;
          }

          const { text, toolCalls } = toolParser.feed(textChunk);
          if (text) {
            finalContent += text;
          }
          if (isToolcallDebugEnabled() && (text || toolCalls.length > 0)) {
            logger.debug("[chat] non-stream: parser feed result", {
              textLength: text.length,
              textPreview: text.substring(0, 100),
              toolCallsCount: toolCalls.length,
              toolCallNames: toolCalls.map((tc) => tc.name),
            });
          }
          for (const tc of toolCalls) {
            toolCallsOut.push({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            });

            if (isToolcallDebugEnabled()) {
              logger.debug("[chat] non-stream: tool_call collected", {
                id: tc.id,
                name: tc.name,
                argsKeys: Object.keys(tc.arguments),
                totalCollected: toolCallsOut.length,
              });
            }
          }
        };

        const consumeSanitizedAnswerChunk = (textChunk: string) => {
          const sanitized = reasoningTagSanitizer.feed(textChunk);
          if (sanitized.detectedThinkTag && !loggedThinkTagLeak) {
            logger.warn(
              "[chat] Detected <think> tags in answer content; sanitizing output",
              {
                completionId,
                mode: "non-stream",
                model: body.model,
                hadMalformedTag: sanitized.hadMalformedTag,
                hadUnclosedTag: sanitized.hadUnclosedTag,
              },
            );
            loggedThinkTagLeak = true;
          }
          if (sanitized.reasoning) {
            reasoningBuffer += sanitized.reasoning;
          }
          if (sanitized.text) {
            consumeAnswerText(sanitized.text);
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") continue;

            try {
              const chunk = JSON.parse(dataStr);

              if (
                chunk["response.created"] &&
                chunk["response.created"].response_id
              ) {
                if (!targetResponseId) {
                  targetResponseId = chunk["response.created"].response_id;
                }
                updateSessionParent(
                  uiSessionId,
                  chunk["response.created"].response_id,
                  activeAccountId,
                );
              } else if (chunk.response_id && !targetResponseId) {
                targetResponseId = chunk.response_id;
                updateSessionParent(
                  uiSessionId,
                  chunk.response_id,
                  activeAccountId,
                );
              }

              applyUpstreamUsage(usageAccumulator, chunk.usage);

              let vStr = "";
              let foundStr = false;
              let isThinkingChunk = false;

              if (
                chunk.choices &&
                chunk.choices[0] &&
                chunk.choices[0].delta &&
                (targetResponseId === null ||
                  chunk.response_id === targetResponseId)
              ) {
                const delta = chunk.choices[0].delta;

                if (delta.phase === "thinking_summary") {
                  isThinkingChunk = true;
                  const formattedSummary = formatThinkingSummaryContent(delta);
                  if (formattedSummary) {
                    const result = getIncrementalDelta(
                      lastThinkingSummary,
                      formattedSummary,
                    );
                    vStr = result.delta;
                    lastThinkingSummary = result.matchedContent;
                    if (vStr) {
                      foundStr = true;
                    }
                  }
                } else if (delta.phase === "answer") {
                  isThinkingChunk = false;
                  if (delta.content !== undefined) {
                    const newContent = delta.content || "";
                    const result = getIncrementalDelta(
                      lastRawContent,
                      newContent,
                    );
                    vStr = result.delta;
                    if (vStr) {
                      lastRawContent = result.matchedContent;
                      foundStr = true;
                    }
                  }
                }
              }

              if (foundStr && vStr !== "") {
                if (vStr === "FINISHED") continue;
                if (isThinkingChunk) {
                  reasoningBuffer += vStr;
                } else {
                  consumeSanitizedAnswerChunk(vStr);
                }
              }
            } catch (e) {
              // parse error, ignore partial chunk
            }
          }
        }

        const upstreamError = parseQwenErrorPayload(buffer);
        if (upstreamError) {
          removeStream(completionId);
          return c.json(
            { error: { message: upstreamError.message } },
            upstreamError.status as any,
          );
        }

        const remainingSanitized = reasoningTagSanitizer.flush();
        if (remainingSanitized.detectedThinkTag && !loggedThinkTagLeak) {
          logger.warn(
            "[chat] Detected <think> tags in answer content; sanitizing output",
            {
              completionId,
              mode: "non-stream",
              model: body.model,
              hadMalformedTag: remainingSanitized.hadMalformedTag,
              hadUnclosedTag: remainingSanitized.hadUnclosedTag,
            },
          );
          loggedThinkTagLeak = true;
        }
        if (remainingSanitized.reasoning) {
          reasoningBuffer += remainingSanitized.reasoning;
        }
        if (remainingSanitized.text) {
          consumeAnswerText(remainingSanitized.text);
        }

        const remainingParsed = toolParser
          ? toolParser.flush()
          : { text: "", toolCalls: [] };
        const { text: remainingText, toolCalls: remainingToolCalls } =
          remainingParsed;

        if (toolParser && isToolcallDebugEnabled()) {
          logger.debug("[chat] non-stream: parser flush result", {
            remainingTextLength: remainingText?.length || 0,
            remainingToolCallsCount: remainingToolCalls.length,
            remainingToolCallNames: remainingToolCalls.map((tc) => tc.name),
          });
        }

        if (remainingText) {
          finalContent += remainingText;
        }
        for (const tc of remainingToolCalls) {
          toolCallsOut.push({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          });
        }

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] non-stream: final toolcall summary", {
            totalToolCalls: toolCallsOut.length,
            toolCallNames: toolCallsOut.map((tc: any) => tc.function?.name),
            contentLength: finalContent.length,
            hasReasoning: !!reasoningBuffer,
          });
        }

        const usage = buildUsage(usageAccumulator);
        const message: any = {
          role: "assistant",
          content: toolCallsOut.length ? null : finalContent,
        };
        if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
        if (toolCallsOut.length) {
          toolCallsOut.forEach((tc, idx) => {
            tc.index = idx;
          });
          message.tool_calls = toolCallsOut;
        }

        const finishReason = toolCallsOut.length ? "tool_calls" : "stop";

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] non-stream: sending response", {
            completionId,
            finishReason,
            totalToolCalls: toolCallsOut.length,
            contentLength: message.content?.length || 0,
            hasReasoning: !!message.reasoning_content,
            usage,
          });
        }

        return c.json({
          id: completionId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message,
              logprobs: null,
              finish_reason: finishReason,
            },
          ],
          usage,
        });
      } finally {
        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] non-stream: cleanup", { completionId });
        }
        removeStream(completionId);
      }
    }

    const streamReader = stream.getReader();
    const streamDecoder = new TextDecoder();
    let initialStreamBuffer = "";

    while (true) {
      const { done, value } = await streamReader.read();
      if (done) {
        initialStreamBuffer += streamDecoder.decode();
        break;
      }

      initialStreamBuffer += streamDecoder.decode(value, { stream: true });
      const trimmedInitialBuffer = initialStreamBuffer.trimStart();
      if (
        trimmedInitialBuffer.startsWith("data: ") ||
        trimmedInitialBuffer.startsWith(":")
      ) {
        break;
      }
    }

    const upstreamError = parseQwenErrorPayload(initialStreamBuffer);
    if (upstreamError) {
      removeStream(completionId);
      return c.json(
        { error: { message: upstreamError.message } },
        upstreamError.status as any,
      );
    }

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return honoStream(c, async (streamWriter: any) => {
      let heartbeatInterval: any;
      let clientDisconnected = false;

      // Detect client disconnection
      const abortHandler = async () => {
        if (clientDisconnected) return;
        clientDisconnected = true;

        console.log(
          `[Chat] Client disconnected for ${completionId}, stopping Qwen generation...`,
        );

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: client disconnected", {
            completionId,
            uiSessionId,
          });
        }

        // Stop generation on Qwen side
        try {
          const streamData = getStream(completionId);
          if (streamData && uiSessionId) {
            const targetResponseId = streamData.targetResponseId;
            if (targetResponseId) {
              console.log(
                `[Chat] Calling Qwen stop for session=${uiSessionId}, response=${targetResponseId}`,
              );
              await fetch(
                `https://chat.qwen.ai/api/v2/chat/completions/stop?chat_id=${uiSessionId}`,
                {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Cookie: streamData.headers.cookie,
                    Origin: "https://chat.qwen.ai",
                    Referer: `https://chat.qwen.ai/c/${uiSessionId}`,
                    "User-Agent": streamData.headers["user-agent"],
                    "X-Request-Id": uuidv4(),
                    "bx-ua": streamData.headers["bx-ua"],
                    "bx-umidtoken": streamData.headers["bx-umidtoken"],
                    "bx-v": streamData.headers["bx-v"],
                  },
                  body: JSON.stringify({
                    chat_id: uiSessionId,
                    response_id: targetResponseId,
                  }),
                },
              ).catch((err) => {
                console.error(`[Chat] Error calling Qwen stop: ${err.message}`);
              });
            } else {
              console.log(
                `[Chat] No targetResponseId yet for ${completionId}, skipping Qwen stop`,
              );
            }
          }

          // Abort the local stream (catch AbortError gracefully)
          try {
            streamData?.abortController.abort();
          } catch (abortErr: any) {
            // Ignore AbortError - this is expected when aborting
            if (abortErr.name !== "AbortError") {
              console.error(
                `[Chat] Error aborting stream: ${abortErr.message}`,
              );
            }
          }
        } catch (err: any) {
          console.error(
            `[Chat] Error during disconnect cleanup: ${err.message}`,
          );
        }

        // Clean up
        clearInterval(heartbeatInterval);
        removeStream(completionId);
      };

      // Listen for client disconnect via the request's close event
      c.req.raw.signal.addEventListener("abort", abortHandler);

      try {
        // Send heartbeat to prevent Cloudflare 524 timeout
        await streamWriter.write(": heartbeat\n\n");

        // Set up a periodic heartbeat to keep the connection alive during long thinking phases
        heartbeatInterval = setInterval(async () => {
          try {
            if (!clientDisconnected) {
              await streamWriter.write(": keep-alive\n\n");
            }
          } catch (e) {
            clearInterval(heartbeatInterval);
          }
        }, 15000); // Every 15 seconds

        const writeEvent = async (data: any) => {
          await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const makeChoice = (
          delta: any,
          finishReason: string | null = null,
        ) => ({
          index: 0,
          delta,
          logprobs: null,
          finish_reason: finishReason,
        });

        // Send initial chunk
        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ role: "assistant", content: "" })],
        });

        const reader = streamReader;
        const decoder = new TextDecoder();

        let lastThinkingSummary = "";
        let lastRawContent = "";
        let targetResponseId: string | null = null;
        const toolParser = shouldParseToolCalls
          ? new StreamingToolParser(declaredTools, {
              incrementalToolCalls: true,
            })
          : null;
        const reasoningTagSanitizer = new StreamingReasoningTagSanitizer();
        let loggedThinkTagLeak = false;

        let buffer = initialStreamBuffer;
        const usageAccumulator = createUsageAccumulator(
          Math.ceil(finalPrompt.length / 3.5),
        );

        const emitAnswerText = async (textChunk: string) => {
          if (!toolParser) {
            await writeEvent({
              id: completionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [makeChoice({ content: textChunk })],
            });
            return;
          }

          const { text, toolCalls, toolCallDeltas } =
            toolParser.feed(textChunk);

          if (
            isToolcallDebugEnabled() &&
            (text || toolCalls.length > 0 || toolCallDeltas.length > 0)
          ) {
            logger.debug("[chat] stream: parser feed result", {
              textLength: text.length,
              textPreview: text.substring(0, 100),
              toolCallsCount: toolCalls.length,
              toolCallNames: toolCalls.map((tc) => tc.name),
              toolCallDeltaCount: toolCallDeltas.length,
            });
          }

          if (text) {
            await writeEvent({
              id: completionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [makeChoice({ content: text })],
            });
          }

          for (const delta of toolCallDeltas) {
            if (isToolcallDebugEnabled()) {
              logger.debug(
                "[chat] stream: emitting incremental tool_call delta",
                {
                  index: delta.index,
                  id: delta.id,
                  name: delta.function.name,
                  argumentsChunkLength: delta.function.arguments?.length || 0,
                },
              );
            }

            await writeEvent({
              id: completionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [
                makeChoice({
                  tool_calls: [
                    {
                      index: delta.index,
                      ...(delta.id ? { id: delta.id } : {}),
                      ...(delta.type ? { type: delta.type } : {}),
                      function: {
                        ...(delta.function.name
                          ? { name: delta.function.name }
                          : {}),
                        ...(delta.function.arguments !== undefined
                          ? { arguments: delta.function.arguments }
                          : {}),
                      },
                    },
                  ],
                }),
              ],
            });
          }

          for (const tc of toolCalls) {
            if (isToolcallDebugEnabled()) {
              logger.debug("[chat] stream: emitting tool_call chunk", {
                id: tc.id,
                name: tc.name,
                argsKeys: Object.keys(tc.arguments),
                index:
                  toolParser.getEmittedToolCallCount() -
                  toolCalls.length +
                  toolCalls.indexOf(tc),
              });
            }

            await writeEvent({
              id: completionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [
                makeChoice({
                  tool_calls: [
                    {
                      index:
                        toolParser.getEmittedToolCallCount() -
                        toolCalls.length +
                        toolCalls.indexOf(tc),
                      id: tc.id,
                      type: "function",
                      function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.arguments),
                      },
                    },
                  ],
                }),
              ],
            });
          }
        };

        const emitSanitizedAnswerChunk = async (textChunk: string) => {
          const sanitized = reasoningTagSanitizer.feed(textChunk);
          if (sanitized.detectedThinkTag && !loggedThinkTagLeak) {
            logger.warn(
              "[chat] Detected <think> tags in answer content; sanitizing output",
              {
                completionId,
                mode: "stream",
                model: body.model,
                hadMalformedTag: sanitized.hadMalformedTag,
                hadUnclosedTag: sanitized.hadUnclosedTag,
              },
            );
            loggedThinkTagLeak = true;
          }

          if (sanitized.reasoning) {
            await writeEvent({
              id: completionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [makeChoice({ reasoning_content: sanitized.reasoning })],
            });
          }

          if (sanitized.text) {
            await emitAnswerText(sanitized.text);
          }
        };

        while (true) {
          // Check if client disconnected
          if (clientDisconnected) {
            if (isToolcallDebugEnabled()) {
              logger.debug(
                "[chat] stream: breaking loop - client disconnected",
              );
            }
            break;
          }

          if (!buffer.includes("\n")) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
          }
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") {
              if (!clientDisconnected) {
                await streamWriter.write("data: [DONE]\n\n");
              }
              continue;
            }

            try {
              const chunk = JSON.parse(dataStr);

              // Extract response_id for session tracking and target filtering
              if (
                chunk["response.created"] &&
                chunk["response.created"].response_id
              ) {
                if (!targetResponseId) {
                  targetResponseId = chunk["response.created"].response_id;
                  // Update stream registry with target response ID
                  if (targetResponseId) {
                    updateStreamTargetResponseId(
                      completionId,
                      targetResponseId,
                    );
                  }
                }
                updateSessionParent(
                  uiSessionId,
                  chunk["response.created"].response_id,
                  activeAccountId,
                );
              } else if (chunk.response_id && !targetResponseId) {
                targetResponseId = chunk.response_id;
                // Update stream registry with target response ID
                if (targetResponseId) {
                  updateStreamTargetResponseId(completionId, targetResponseId);
                }
                updateSessionParent(
                  uiSessionId,
                  chunk.response_id,
                  activeAccountId,
                );
              }

              applyUpstreamUsage(usageAccumulator, chunk.usage);

              let vStr = "";
              let foundStr = false;
              let isThinkingChunk = false;

              if (
                chunk.choices &&
                chunk.choices[0] &&
                chunk.choices[0].delta &&
                (targetResponseId === null ||
                  chunk.response_id === targetResponseId)
              ) {
                const delta = chunk.choices[0].delta;

                if (delta.phase === "thinking_summary") {
                  isThinkingChunk = true;
                  const formattedSummary = formatThinkingSummaryContent(delta);
                  if (formattedSummary) {
                    const result = getIncrementalDelta(
                      lastThinkingSummary,
                      formattedSummary,
                    );
                    vStr = result.delta;
                    lastThinkingSummary = result.matchedContent;
                    if (vStr) {
                      foundStr = true;
                    }
                  }
                } else if (delta.phase === "answer") {
                  isThinkingChunk = false;
                  if (delta.content !== undefined) {
                    const newContent = delta.content || "";
                    const result = getIncrementalDelta(
                      lastRawContent,
                      newContent,
                    );
                    vStr = result.delta;
                    if (vStr) {
                      lastRawContent = result.matchedContent;
                      foundStr = true;
                    }
                  }
                }
              }

              if (foundStr && vStr !== "") {
                if (vStr === "FINISHED") continue;

                if (isThinkingChunk) {
                  await writeEvent({
                    id: completionId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({ reasoning_content: vStr })],
                  });
                } else {
                  await emitSanitizedAnswerChunk(vStr);
                }
              }
            } catch (e) {
              // parse error, ignore partial chunk
            }
          }
        }

        const upstreamError = parseQwenErrorPayload(buffer);
        if (upstreamError) {
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({ content: upstreamError.message })],
          });
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({}, "stop")],
          });
          await streamWriter.write("data: [DONE]\n\n");
          return;
        }

        const remainingSanitized = reasoningTagSanitizer.flush();
        if (remainingSanitized.detectedThinkTag && !loggedThinkTagLeak) {
          logger.warn(
            "[chat] Detected <think> tags in answer content; sanitizing output",
            {
              completionId,
              mode: "stream",
              model: body.model,
              hadMalformedTag: remainingSanitized.hadMalformedTag,
              hadUnclosedTag: remainingSanitized.hadUnclosedTag,
            },
          );
          loggedThinkTagLeak = true;
        }
        if (remainingSanitized.reasoning) {
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              makeChoice({ reasoning_content: remainingSanitized.reasoning }),
            ],
          });
        }
        if (remainingSanitized.text) {
          await emitAnswerText(remainingSanitized.text);
        }

        // Flush tool parser
        const remainingParsed = toolParser
          ? toolParser.flush()
          : { text: "", toolCalls: [], toolCallDeltas: [] };
        const {
          text: remainingText,
          toolCalls: remainingToolCalls,
          toolCallDeltas: remainingToolCallDeltas,
        } = remainingParsed;

        if (toolParser && isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: parser flush result", {
            remainingTextLength: remainingText?.length || 0,
            remainingToolCallsCount: remainingToolCalls.length,
            remainingToolCallNames: remainingToolCalls.map((tc) => tc.name),
            remainingToolCallDeltaCount: remainingToolCallDeltas.length,
            totalEmittedToolCalls: toolParser.getEmittedToolCallCount(),
          });
        }

        if (remainingText) {
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({ content: remainingText })],
          });
        }
        for (const delta of remainingToolCallDeltas) {
          if (toolParser && isToolcallDebugEnabled()) {
            logger.debug(
              "[chat] stream: emitting flushed incremental tool_call delta",
              {
                index: delta.index,
                id: delta.id,
                name: delta.function.name,
                argumentsChunkLength: delta.function.arguments?.length || 0,
              },
            );
          }

          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              makeChoice({
                tool_calls: [
                  {
                    index: delta.index,
                    ...(delta.id ? { id: delta.id } : {}),
                    ...(delta.type ? { type: delta.type } : {}),
                    function: {
                      ...(delta.function.name
                        ? { name: delta.function.name }
                        : {}),
                      ...(delta.function.arguments !== undefined
                        ? { arguments: delta.function.arguments }
                        : {}),
                    },
                  },
                ],
              }),
            ],
          });
        }
        for (const tc of remainingToolCalls) {
          if (toolParser && isToolcallDebugEnabled()) {
            logger.debug("[chat] stream: emitting flushed tool_call chunk", {
              id: tc.id,
              name: tc.name,
              argsKeys: Object.keys(tc.arguments),
              index:
                toolParser.getEmittedToolCallCount() -
                remainingToolCalls.length +
                remainingToolCalls.indexOf(tc),
            });
          }

          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              makeChoice({
                tool_calls: [
                  {
                    index: toolParser
                      ? toolParser.getEmittedToolCallCount() -
                        remainingToolCalls.length +
                        remainingToolCalls.indexOf(tc)
                      : remainingToolCalls.indexOf(tc),
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments),
                    },
                  },
                ],
              }),
            ],
          });
        }

        // Send finish reason
        const usage = buildUsage(usageAccumulator);

        const finalFinishReason =
          toolParser && toolParser.getEmittedToolCallCount() > 0
            ? "tool_calls"
            : "stop";

        if (toolParser && isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: sending finish reason", {
            finishReason: finalFinishReason,
            totalEmittedToolCalls: toolParser.getEmittedToolCallCount(),
            usage,
            includeUsage: body.stream_options?.include_usage,
          });
        }

        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({}, finalFinishReason)],
          ...(body.stream_options?.include_usage ? {} : { usage }),
        });

        if (body.stream_options?.include_usage) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] stream: sending usage event", { usage });
          }
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [],
            usage,
          });
        }

        // Only send [DONE] if client is still connected
        if (!clientDisconnected) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] stream: sending [DONE]");
          }
          await streamWriter.write("data: [DONE]\n\n");

          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] stream: completed successfully", {
              completionId,
              totalEmittedToolCalls: toolParser
                ? toolParser.getEmittedToolCallCount()
                : 0,
              finishReason: finalFinishReason,
            });
          }
        } else {
          if (isToolcallDebugEnabled()) {
            logger.debug(
              "[chat] stream: skipped [DONE] - client already disconnected",
            );
          }
        }
      } catch (err: any) {
        const streamStillRegistered = Boolean(getStream(completionId));
        if (
          shouldSuppressStreamAbort(
            err,
            clientDisconnected,
            c.req.raw.signal.aborted,
            streamStillRegistered,
          )
        ) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] stream: suppressed expected abort", {
              completionId,
              clientDisconnected,
              requestAborted: c.req.raw.signal.aborted,
              streamStillRegistered,
              errorName: err?.name,
              errorMessage: err?.message,
            });
          }
          return;
        }
        throw err;
      } finally {
        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: cleanup started", {
            completionId,
            clientDisconnected,
          });
        }

        // Remove the abort listener
        c.req.raw.signal.removeEventListener("abort", abortHandler);

        clearInterval(heartbeatInterval);
        removeStream(completionId);

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: cleanup completed", {
            completionId,
          });
        }
      }
    });
  } catch (err: any) {
    console.error("Error in chatCompletions:", err);
    const status = err.upstreamStatus || 500;
    if (status >= 500) {
      metrics.increment("requests.errors");
    }
    return c.json({ error: { message: err.message } }, status);
  }
}

export async function chatCompletionsStop(c: Context) {
  try {
    const body = await c.req.json();
    const { chat_id, response_id } = body;

    if (!chat_id || !response_id) {
      return c.json({ error: "chat_id and response_id are required" }, 400);
    }

    const exactStreamKey = getStreamKeyBySessionAndResponse(
      chat_id,
      response_id,
    );
    const matchingSessionStreamKeys = getStreamKeysBySessionId(chat_id);
    const streamKey =
      exactStreamKey ||
      (matchingSessionStreamKeys.length === 1
        ? matchingSessionStreamKeys[0]
        : getStreamKeyBySessionId(chat_id)) ||
      chat_id;
    const stream = getStream(streamKey);
    if (!stream) {
      return c.json({ error: "Stream not found" }, 404);
    }

    if (!exactStreamKey && matchingSessionStreamKeys.length > 1) {
      return c.json(
        {
          error:
            "Multiple active streams for this chat_id; wait for response_id registration and retry",
        },
        409,
      );
    }

    if (stream.targetResponseId && stream.targetResponseId !== response_id) {
      return c.json({ error: "response_id mismatch" }, 400);
    }

    const stopResponse = await fetch(
      `https://chat.qwen.ai/api/v2/chat/completions/stop?chat_id=${chat_id}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "pt-BR,pt;q=0.9",
          "Content-Type": "application/json",
          Cookie: stream.headers.cookie,
          Origin: "https://chat.qwen.ai",
          Referer: `https://chat.qwen.ai/c/${chat_id}`,
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "User-Agent": stream.headers["user-agent"],
          "X-Request-Id": uuidv4(),
          "bx-ua": stream.headers["bx-ua"],
          "bx-umidtoken": stream.headers["bx-umidtoken"],
          "bx-v": stream.headers["bx-v"],
        },
        body: JSON.stringify({ chat_id, response_id }),
      },
    );

    if (!stopResponse.ok) {
      const errorText = await stopResponse.text();
      console.error(
        `[Stop] Failed to stop generation for chat_id=${chat_id}: ${stopResponse.status} ${errorText}`,
      );
      return c.json(
        { error: "Failed to stop generation" },
        stopResponse.status as any,
      );
    }

    stream.abortController.abort();
    removeStream(streamKey);

    console.log(`[Stop] Generation stopped for chat_id=${chat_id}`);
    return c.json({ success: true });
  } catch (err: any) {
    console.error("Error in chatCompletionsStop:", err);
    return c.json({ error: err.message }, 500);
  }
}
