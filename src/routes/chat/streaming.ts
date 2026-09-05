/*
 * File: streaming.ts
 * Project: QwenProxy
 *
 * Upstream stream consumption: both non-streaming (JSON) and streaming (SSE)
 * response modes. Encapsulates heartbeat, abort handling, reasoning tag
 * sanitization, and incremental tool-call parsing.
 */

import type { Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import { buildQwenRequestHeaders } from "../../services/qwen-headers.ts";
import { qwenUrl } from "../../services/qwen-url.ts";
import {
  requestQwenTextInBrowser,
  updateLogicalThreadParent,
  updateSessionParent,
  invalidateLogicalThreadParent,
  getQwenErrorCode,
  RetryableQwenStreamError,
  setToolCapNotice,
} from "../../services/qwen.ts";
import { acquireUpstreamStream } from "./account.ts";
import { markAccountRateLimited } from "../../core/account-manager.ts";
import {
  clearTemporaryBusy,
  markAccountTemporarilyBusy,
} from "../../core/account-concurrency.ts";

import {
  classifyRetryAction,
  shouldRetryChatInProgressOnSameAccount,
  shouldRetryInvalidInputOnSameAccount,
} from "./retry-policy.ts";
import type { Message, OpenAIRequest, Usage } from "../../utils/types.ts";
import { StreamingToolParser } from "../../tools/parser.ts";
import {
  getStream,
  markStreamEmitted,
  registerStream,
  removeStream,
  updateStreamSessionId,
  updateStreamTargetResponseId,
} from "../../core/stream-registry.ts";
import { metrics } from "../../core/metrics.js";
import {
  logger,
  isToolcallDebugEnabled,
  upstreamDebugEnabled,
} from "../../core/logger.js";
import { sendOpenAIError } from "../../api/error-helpers.js";
import { classifyError } from "../../api/error-classifier.js";
import { ClientAbortedError } from "../../core/errors.js";
import { config, type ChatMode } from "../../core/config.js";
import { parseQwenErrorPayload } from "./errors.ts";
import {
  isNetworkLikeError,
  throwFromSseUpstreamError,
  toRetryableStreamError,
} from "./retry-policy.ts";
import {
  logTokenEstimationSample,
  type TokenEstimationContext,
} from "../../services/token-estimation-metrics.ts";
import {
  enrichUsageWithContextMeter,
  getContextMeterHeaders,
  type ContextMeterMode,
} from "../../services/context-meter.ts";
import {
  getIncrementalDelta,
  formatThinkingSummaryContent,
  shouldSuppressStreamAbort,
  isAbortError,
  createUsageAccumulator,
  applyUpstreamUsage,
  buildUsage,
} from "./helpers.ts";

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function extractChatSessionId(chunk: any): string | null {
  const created = chunk?.["response.created"];
  return firstString(
    chunk?.chat_id,
    chunk?.chatId,
    chunk?.session_id,
    chunk?.conversation_id,
    chunk?.conversationId,
    created?.chat_id,
    created?.chatId,
    created?.session_id,
    created?.conversation_id,
    created?.conversationId,
    created?.chat?.id,
    created?.response?.chat_id,
    created?.response?.chat?.id,
  );
}

// Retry/switch policy lives in ./retry-policy.ts (generic by default).

const MAX_INITIAL_PROTOCOL_BYTES = 64 * 1024;

// Mid-stream network failures (stream died after the response was committed)
// cannot rotate accounts in-flight. If one account suffers several of these in a
// short window, mark it temporarily busy so the *next* request fails over to a
// healthier account instead of sticking to a flaky one.
const MID_STREAM_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const midStreamNetworkFailures = new Map<string, number[]>();

function noteMidStreamNetworkFailure(accountId: string): void {
  const threshold = config.retry.midStreamFailoverThreshold;
  if (threshold <= 0) return;

  const now = Date.now();
  const recent = (midStreamNetworkFailures.get(accountId) ?? []).filter(
    (t) => now - t < MID_STREAM_FAILURE_WINDOW_MS,
  );
  recent.push(now);

  if (recent.length >= threshold) {
    midStreamNetworkFailures.delete(accountId);
    markAccountTemporarilyBusy(accountId, config.retry.midStreamFailoverBusyMs);
    logger.warn(
      "[Chat] Account marked temporarily busy after repeated mid-stream network failures; next request will rotate",
      {
        accountId,
        failures: recent.length,
        busyMs: config.retry.midStreamFailoverBusyMs,
      },
    );
  } else {
    midStreamNetworkFailures.set(accountId, recent);
  }
}

function hasSseProtocolStart(buffer: string): boolean {
  // Skip leading whitespace without allocating a trimmed copy, then test the
  // first significant char: ":" (SSE comment) or "data:" prefix.
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer.charCodeAt(i);
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) continue;
    return ch === 58 || buffer.startsWith("data:", i);
  }
  return false;
}

function throwParsedUpstreamError(
  error: NonNullable<ReturnType<typeof parseQwenErrorPayload>>,
): never {
  throwFromSseUpstreamError(error.code, error.details);
}

export interface AssistantCompleteEvent {
  sessionId: string | null;
  accountId: string;
  chatSessionId: string;
  parentId: string | null;
  responseId: string | null;
  userPrompt: string;
  finalPrompt: string;
  assistantContent: string;
  reasoningContent?: string;
  usage: Usage;
  finishReason: string;
}

export type AssistantCompleteHandler = (
  event: AssistantCompleteEvent,
) => Promise<void> | void;



export interface StreamProcessingParams {
  c: Context;
  /** Short request id for log correlation (from the 📥 Incoming line). */
  reqId?: string;
  completionId: string;
  stream: ReadableStream;
  uiSessionId: string;
  activeAccountId: string;
  activeAccountLabel?: string;
  logicalSessionId: string | null;
  body: OpenAIRequest & { stream_options?: { include_usage?: boolean } };
  finalPrompt: string;
  userPrompt: string;
  shouldParseToolCalls: boolean;
  declaredTools: any[];
  tokenEstimationContext?: TokenEstimationContext;
  midStreamRetry?: {
    fullPrompt: string;
    isThinkingModel: boolean;
    contextModelId?: string;
    reasoningMode?: "auto" | "thinking" | "fast";
    activeAccountId?: string;
    allFiles: any[];
    isNewSession: boolean;
    sessionId: string | null;
    useThreadNative: boolean;
    updateLogicalThread: boolean;
    /** Parallel request (own chat): recovery must not kill or rebind. */
    parallelEscape?: boolean;
    /** "thread" (reuse upstream chat) or "temp" (new ephemeral chat per request). */
    chatMode: ChatMode;
    allowThreadReuse: boolean;
    messageCount: number;
    fullMessageCount: number;
    toolsCount?: number;
    requestPersonalizationInstruction?: string | null;
    contextMode?: ContextMeterMode;
    releaseAccountLease: () => void;
    messages?: Message[];
    /** How many malformed-tool-call auto-retries have already run (0-based). */
    malformedRetryCount?: number;
  };
  onAssistantComplete?: AssistantCompleteHandler;
  onStreamComplete?: () => void;
}

function scheduleAssistantComplete(
  handler: AssistantCompleteHandler | undefined,
  event: AssistantCompleteEvent,
): void {
  if (!handler) return;
  void Promise.resolve()
    .then(() => handler(event))
    .catch((error) => {
      logger.warn("[chat] assistant completion callback failed", {
        sessionId: event.sessionId,
        chatSessionId: event.chatSessionId,
        responseId: event.responseId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

// ─── Non-streaming (JSON response) ─────────────────────────────────────────────

export async function processNonStreamingResponse(
  params: StreamProcessingParams,
): Promise<Response> {
  const {
    c,
    completionId,
    stream,
    uiSessionId,
    activeAccountId,
    logicalSessionId,
    body,
    finalPrompt,
    userPrompt,
    shouldParseToolCalls,
    declaredTools,
    tokenEstimationContext,
    midStreamRetry,
    onAssistantComplete,
    onStreamComplete,
  } = params;
  const reqId = params.reqId ?? completionId.substring(0, 8);
  const streamStartedAt = Date.now();
  let currentTokenEstimationContext = tokenEstimationContext;

  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    let lastThinkingSummary = "";
    let lastThinkingSummaryLength = 0;
    let lastThinkingSummarySuffix = "";
    let reasoningBuffer = "";
    let lastRawContent = "";
    let lastRawContentLength = 0;
    let lastRawContentSuffix = "";
    let finalContent = "";
    let targetResponseId: string | null = null;
    let pendingParentId: string | null = null;
    let currentUiSessionId = uiSessionId;
    const toolParser = shouldParseToolCalls
      ? new StreamingToolParser(declaredTools, {
          maxToolCallsPerTurn: config.retry.maxToolCallsPerTurn,
        })
      : null;
    const toolCallsOut: any[] = [];
    let buffer = "";
    let protocolBuffer = "";
    let protocolProbeBytes = 0;
    let sawSseProtocol = false;
    const usageAccumulator = createUsageAccumulator(0);

    const rememberSession = (sessionId: string | null) => {
      if (!sessionId || sessionId === currentUiSessionId) return;
      currentUiSessionId = sessionId;
      updateStreamSessionId(completionId, sessionId);
    };

    const rememberParent = (parentId: string) => {
      if (!currentUiSessionId) return;
      updateSessionParent(currentUiSessionId, parentId, activeAccountId);
      updateLogicalThreadParent(
        logicalSessionId,
        parentId,
        activeAccountId,
        currentUiSessionId,
      );
    };

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



    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const decoded = decoder.decode(value, { stream: true });
      if (!sawSseProtocol) {
        protocolBuffer += decoded;
        sawSseProtocol = hasSseProtocolStart(protocolBuffer);
        // Count bytes incrementally instead of re-scanning the growing buffer.
        protocolProbeBytes += value.byteLength;
        if (!sawSseProtocol && protocolProbeBytes > MAX_INITIAL_PROTOCOL_BYTES) {
          throw toRetryableStreamError(
            "non_sse_response",
            "Qwen did not start an SSE response before the protocol probe limit.",
          );
        }
      }

      buffer += decoded;
      let lineStart = 0;
      let lineEnd = buffer.indexOf("\n", lineStart);

      for (; lineEnd !== -1; lineEnd = buffer.indexOf("\n", lineStart)) {
        let dataStr = "";
        if (buffer.startsWith("data:", lineStart)) {
          let s = lineStart + 5;
          if (buffer.charCodeAt(s) === 32) s++;
          let e = lineEnd;
          if (e > s && buffer.charCodeAt(e - 1) === 13) e--;
          dataStr = buffer.substring(s, e);
        }
        lineStart = lineEnd + 1;
        if (!dataStr) continue;
        if (dataStr === "[DONE]") continue;

        if (upstreamDebugEnabled) {
          console.log(`📤 [Upstream] Chunk | ${dataStr.substring(0, 500)}`);
        }

        try {
                  const chunk = JSON.parse(dataStr);
                  rememberSession(extractChatSessionId(chunk));

                  // Generic upstream SSE error handling (retry/switch via policy)
                  if (chunk.error) {
                    const errDetails =
                      chunk.error.details ||
                      chunk.error.message ||
                      JSON.stringify(chunk.error);
                    const errCode = chunk.error.code || "upstream_error";
                    throwFromSseUpstreamError(errCode, errDetails);
                  }

                  if (
                    chunk["response.created"] &&
                    chunk["response.created"].response_id
                  ) {
                    if (chunk["response.created"].chat_id) {
                      rememberSession(chunk["response.created"].chat_id);
                    }
                    if (!targetResponseId) {
                      targetResponseId = chunk["response.created"].response_id;
                    }
                    // Commit the parent only after the whole response succeeds.
                    pendingParentId = chunk["response.created"].response_id;
                    // Qwen-internal metadata event — never forward to the client.
                    continue;
                  } else if (chunk.response_id && !targetResponseId) {
                    targetResponseId = chunk.response_id;
                    pendingParentId = chunk.response_id;
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
                  lastThinkingSummaryLength,
                  lastThinkingSummarySuffix,
                );
                vStr = result.delta;
                lastThinkingSummary = result.matchedContent;
                lastThinkingSummaryLength = result.contentLength;
                lastThinkingSummarySuffix = result.contentSuffix;
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
                  lastRawContentLength,
                  lastRawContentSuffix,
                );
                vStr = result.delta;
                if (vStr) {
                  lastRawContent = result.matchedContent;
                  lastRawContentLength = result.contentLength;
                  lastRawContentSuffix = result.contentSuffix;
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
              consumeAnswerText(vStr);
            }
          }
        } catch (_e) {
                  // Re-throw policy-driven retry errors for outer retry loop
                  if (_e instanceof RetryableQwenStreamError) {
                    throw _e;
                  }
                  // Log warning for large chunks that fail to parse
                  if (dataStr.length > 10) {
                    console.warn(
                      `[Chat] SSE parse error for chunk (${dataStr.length} chars):`,
                      (_e as Error).message,
                    );
                  }
                }
      }

      buffer = lineStart > 0 ? buffer.slice(lineStart) : buffer;
    }

    if (!sawSseProtocol) {
      const upstreamError = parseQwenErrorPayload(protocolBuffer);
      if (upstreamError) {
        throwParsedUpstreamError(upstreamError);
      }
      throw toRetryableStreamError(
        "non_sse_response",
        "Qwen ended the response before emitting an SSE event.",
      );
    }

    const upstreamError = parseQwenErrorPayload(buffer);
    if (upstreamError) {
      throwParsedUpstreamError(upstreamError);
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

    const usage = enrichUsageWithContextMeter(
      buildUsage(usageAccumulator),
      currentTokenEstimationContext?.contextMeter,
    );
    for (const [name, value] of Object.entries(
      getContextMeterHeaders((usage as any).context_meter),
    )) {
      c.header(name, value);
    }
    const message: any = {
      role: "assistant",
      content: toolCallsOut.length ? null : finalContent,
    };
    if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
    if (toolCallsOut.length) {
      message.tool_calls = toolCallsOut;
    }

    const finishReason = toolCallsOut.length ? "tool_calls" : "stop";

    // Auto-retry if all tool calls were malformed (no successful tool calls)
    const allToolsFailed = toolParser && toolParser.getMalformedToolCalls().length > 0 && toolCallsOut.length === 0;
    const malformedRetryCount = midStreamRetry?.malformedRetryCount ?? 0;
    if (
      allToolsFailed &&
      config.retry.autoRetryMalformedTools !== false &&
      midStreamRetry &&
      malformedRetryCount < config.retry.autoRetryMalformedToolsMax
    ) {
      const malformedCalls = toolParser.getMalformedToolCalls();
      const malformedCount = malformedCalls.length;

      // Build detailed error message with available tools list
      const undeclaredNames = malformedCalls
        .flatMap((mc) => mc.undeclaredNames || [])
        .filter((name, index, self) => self.indexOf(name) === index);

      const availableToolNames = declaredTools
        .map((t: any) => t.type === "function" ? t.function?.name : t.name)
        .filter((n: string | undefined): n is string => !!n);
      const toolsHint = availableToolNames.length > 0
        ? `\n\nAvailable tools: ${availableToolNames.join(", ")}`
        : "";

      let errorMessage: string;
      if (undeclaredNames.length > 0) {
        errorMessage = `Your previous ${malformedCount} tool call(s) used undeclared tool names: ${undeclaredNames.join(", ")}. Only declared tools can be executed. Please retry with valid tool names.${toolsHint}`;
      } else {
        const previews = malformedCalls
          .slice(0, 3)
          .map((mc) => mc.contentPreview?.substring(0, 100) || "(empty)")
          .join("\n  - ");
        errorMessage = `Your previous ${malformedCount} tool call(s) were malformed and could not be executed. The JSON was invalid or truncated. Please retry with valid JSON.\n\nFailed attempt(s):\n  - ${previews}${toolsHint}`;
      }

      logger.warn("[chat] non-stream: auto-retrying malformed tool calls", {
        malformedCount,
        undeclaredNames,
        completionId,
      });

      // Build retry prompt with error context
      const retryPrompt = `${midStreamRetry.fullPrompt}\n\n[SYSTEM CORRECTION]\n${errorMessage}\n\nPlease retry your tool call(s) with correct JSON and valid tool names from the available tools list above.`;

      // Release current stream and lease
      try {
        await stream.cancel();
      } catch (cancelErr) {
        // Ignore cancel errors
      }
      midStreamRetry.releaseAccountLease();

      // Acquire new stream for retry - keep same account, force new chat
      const newStreamResult = await acquireUpstreamStream({
        finalPrompt: retryPrompt,
        fullPrompt: retryPrompt,
        isThinkingModel: midStreamRetry.isThinkingModel,
        model: body.model,
        reasoningMode: midStreamRetry.reasoningMode,
        shouldResetUpstreamThread: true,
        allFiles: midStreamRetry.allFiles,
        isNewSession: midStreamRetry.isNewSession,
        sessionId: midStreamRetry.sessionId,
        useThreadNative: midStreamRetry.useThreadNative,
        updateLogicalThread: midStreamRetry.updateLogicalThread,
        parallelEscape: midStreamRetry.parallelEscape,
        allowThreadReuse: midStreamRetry.allowThreadReuse,
        chatMode: midStreamRetry.chatMode,
        forceNewChat: true,
        preferredAccountId: midStreamRetry.activeAccountId,
        excludeAccountIds: undefined,
        messageCount: midStreamRetry.messageCount,
        fullMessageCount: midStreamRetry.fullMessageCount,
        toolsCount: midStreamRetry.toolsCount,
        requestPersonalizationInstruction: midStreamRetry.requestPersonalizationInstruction,
        contextMode: "replay",
        requestSignal: c.req.raw.signal,
        messages: midStreamRetry.messages,
      });

      if ("error" in newStreamResult) {
        // Client abort during retry acquisition is expected, not an error.
        if (newStreamResult.error instanceof ClientAbortedError) {
          logger.debug(
            "[chat] non-stream: auto-retry aborted by client (silent)",
            {
              completionId,
            },
          );
          return sendOpenAIError(c, newStreamResult.error);
        }
        // Retry failed, return original error
        logger.error("[chat] non-stream: auto-retry failed to acquire stream", {
          error: newStreamResult.error?.message,
          completionId,
        });
        return sendOpenAIError(c, newStreamResult.error);
      }

      // Critical detail 3: non-streaming has no clientDisconnected flag; the
      // guard is the request signal. If the client aborted while acquiring the
      // retry stream, release the fresh lease (idempotent) and bail so the
      // lease is not orphaned.
      if (c.req.raw.signal.aborted) {
        newStreamResult.releaseAccountLease();
        return sendOpenAIError(
          c,
          new Error("client aborted during malformed-tool retry"),
        );
      }

      console.log(`🔄 [Chat] Auto-retry (${malformedRetryCount + 1}/${config.retry.autoRetryMalformedToolsMax}) | ${newStreamResult.activeAccountLabel} | ${body.model} | chat=${newStreamResult.uiSessionId.substring(0, 12)} | reason=malformed_tool_calls`);

      // Process the new stream. Propagate the retry context with an incremented
      // counter so a subsequent malformed response can retry again up to
      // autoRetryMalformedToolsMax, and hand over the fresh lease/account.
      return processNonStreamingResponse({
        ...params,
        stream: newStreamResult.stream,
        uiSessionId: newStreamResult.uiSessionId,
        activeAccountId: newStreamResult.activeAccountId,
        activeAccountLabel: newStreamResult.activeAccountLabel,
        finalPrompt: retryPrompt,
        tokenEstimationContext: newStreamResult.tokenEstimationContext,
        midStreamRetry: {
          ...midStreamRetry,
          malformedRetryCount: malformedRetryCount + 1,
          activeAccountId: newStreamResult.activeAccountId,
          releaseAccountLease: newStreamResult.releaseAccountLease,
        },
        onStreamComplete: () => {
          newStreamResult.releaseAccountLease();
          onStreamComplete?.();
        },
      });
    }

    // Tool calls dropped and NOT recovered by the auto-retry. Keep this out of
    // the user-visible response entirely: the retry path already told Qwen what
    // went wrong in the upstream prompt, and an echoed [WARNING] text block
    // would leak bridge editorializing into the client's UI.
    if (
      toolParser &&
      (toolParser.getMalformedToolCalls().length > 0 ||
        toolParser.getCappedToolCalls().length > 0)
    ) {
      const malformedCalls = toolParser.getMalformedToolCalls();
      const undeclaredNames = malformedCalls
        .map((mc) => mc.undeclaredNames)
        .flat()
        .filter((n): n is string => !!n);
      const cappedToolNames = toolParser
        .getCappedToolCalls()
        .map((c) => c.toolName);

      logger.warn(
        "[chat] non-stream: tool calls not retried (malformed or over per-turn cap)",
        {
          malformedCount: malformedCalls.length,
          cappedCount: cappedToolNames.length,
          cappedToolNames,
          undeclaredNames,
          completionId,
        },
      );
    }

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

    logTokenEstimationSample({
      model: body.model,
      finalPrompt,
      userPrompt,
      assistantContent: finalContent,
      reasoningContent: reasoningBuffer || undefined,
      usage,
      mode: "non-stream",
      context: currentTokenEstimationContext,
    });

    // The response was fully processed: persist the next-turn parent.
    if (pendingParentId) {
      rememberParent(pendingParentId);
    }

    scheduleAssistantComplete(onAssistantComplete, {
      sessionId: logicalSessionId,
      accountId: activeAccountId,
      chatSessionId: currentUiSessionId,
      parentId: pendingParentId,
      responseId: targetResponseId,
      userPrompt,
      finalPrompt,
      assistantContent: finalContent,
      reasoningContent: reasoningBuffer || undefined,
      usage,
      finishReason,
    });

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
    if (logger.isLevelEnabled("info")) {
      console.log(
        `⏱️ [Chat] Done (non-stream) | req=${reqId} | ${Date.now() - streamStartedAt}ms`,
      );
    }
    removeStream(completionId);
    if (onStreamComplete) onStreamComplete();
  }
}

// ─── Streaming (SSE) ───────────────────────────────────────────────────────────

export async function processStreamingResponse(
  params: StreamProcessingParams,
): Promise<Response> {
  const {
    c,
    completionId,
    stream,
    uiSessionId,
    activeAccountId,
    activeAccountLabel = activeAccountId,
    logicalSessionId,
    body,
    finalPrompt,
    userPrompt,
    shouldParseToolCalls,
    declaredTools,
    tokenEstimationContext,
    midStreamRetry,
    onAssistantComplete,
    onStreamComplete,
  } = params;
  const reqId = params.reqId ?? completionId.substring(0, 8);
  const streamStartedAt = Date.now();
  let firstChunkAt: number | null = null;
  // Last model delta handed to the client. Stream done reports the gap between
  // this and the teardown (tail): a large tail means the visible response had
  // finished long before the upstream terminal event arrived (thinking-model
  // terminal lag), which reads as "loading after the answer" on the client.
  let lastDeltaAt: number | null = null;
  let currentTokenEstimationContext = tokenEstimationContext;

  // Disable Nagle's algorithm on the underlying TCP socket to eliminate 40ms delayed
  // ACK latency on incremental SSE packet delivery.
  const socket =
    (c.env as any)?.incoming?.socket || (c.req.raw as any)?.socket;
  if (socket && typeof socket.setNoDelay === "function") {
    socket.setNoDelay(true);
  }

  // Send the SSE response headers IMMEDIATELY (before the protocol probe): the
  // probe below can block for the upstream's first byte (slow thinking), and
  // without an early response the client sees nothing and times out on its own,
  // retrying the same session. The honoStream callback emits keep-alive
  // comments while the first byte is pending.
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");
  // Store retry context for transparent mid-stream recovery
  const retryContext = {
    activeAccountId,
    activeAccountLabel: activeAccountLabel || activeAccountId,
    uiSessionId,
    retriesLeft: Math.max(0, config.retry.maxAttempts - 1),
    releaseAccountLease: midStreamRetry?.releaseAccountLease ?? null,
  };

  return honoStream(c, async (streamWriter: any) => {
    let heartbeatTimeout: NodeJS.Timeout | undefined;
    let clientDisconnected = false;
    let gracePending = false;
    let graceTimer: NodeJS.Timeout | null = null;
    let teardownDone = false;
    let recoverySeedPending = false;
    let currentUiSessionId = retryContext.uiSessionId;
    let currentAccountId = retryContext.activeAccountId;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let invalidInputSameAccountRetries = 0;
    let chatInProgressSameAccountRetries = 0;
    // Set when the terminal [DONE] reached the client. The `| recovered`
    // suffix on Stream done must only appear for attempts that COMPLETED after
    // a mid-stream retry, not for failed attempts that consumed retries.
    let streamCompletedOk = false;
    // Set when the turn is closed early because the per-turn tool-call cap was
    // reached. The turn ends CLEANLY (finish_reason "tool_calls" + [DONE]) and
    // the upstream generation is stopped — this is a success path, never a
    // mid-stream retry. The next turn carries a notice so the model knows calls
    // beyond the cap were not executed.
    let stoppedByToolCap = false;

    // The client socket went away. When config.stream.disconnectGraceMs > 0 we
    // do NOT tear down Qwen/stop/release the lease immediately: a transient
    // network blip (2-4s) would otherwise kill the in-flight generation, mark
    // the account temporarily busy and splinter the thread. Within the window
    // the upstream keeps generating; if it finishes naturally, the parent is
    // still committed and the reconnecting client continues the thread
    // cleanly. A still-running generation gets the teardown after the window.
    const runDisconnectTeardown = () => {
      if (teardownDone) return;
      teardownDone = true;

      if (logger.isLevelEnabled("info")) {
        console.log(
          `🔌 [Chat] Client disconnected | ${completionId} | stopping Qwen generation`,
        );
      }

      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] stream: client disconnected", {
          completionId,
          uiSessionId: currentUiSessionId,
        });
      }

      const streamData = getStream(completionId);
      const targetResponseId = streamData?.targetResponseId || "";
      const stopSessionId = currentUiSessionId;
      const stopAccountId = currentAccountId;
      const stopHeaders = streamData?.headers;

      // Qwen may keep the generation alive briefly after the browser stream is
      // aborted. Mark the account busy during that settlement window so the next
      // request does not race the stop endpoint and receive chat_in_progress.
      const stopSettlementMs = Math.max(
        config.retry.chatInProgressBusyMs,
        1_000,
      );
      const stopBusyUntil = markAccountTemporarilyBusy(
        stopAccountId,
        stopSettlementMs,
      );

      // Abort the browser stream first. This wakes the reader immediately and
      // lets the normal finally block release the account/stream locks without
      // waiting for Qwen's stop endpoint.
      try {
        streamData?.abortController.abort();
      } catch (abortErr: any) {
        if (abortErr.name !== "AbortError") {
          console.error(`❌ [Chat] Abort stream failed | ${abortErr.message}`);
        }
      }
      void activeReader?.cancel().catch(() => undefined);

      // Release the lease immediately. The stop request below is best-effort
      // and must never hold the account slot or block the next tool turn.
      retryContext.releaseAccountLease?.();
      retryContext.releaseAccountLease = null;
      removeStream(completionId);

      if (stopHeaders && stopSessionId && targetResponseId) {
        if (logger.isLevelEnabled("info")) {
          console.log(
            `🛑 [Chat] Stopping Qwen generation | session=${stopSessionId} | response=${targetResponseId}`,
          );
        }
        void requestQwenTextInBrowser(
          stopAccountId,
          "POST",
          `/api/v2/chat/completions/stop?chat_id=${encodeURIComponent(stopSessionId)}`,
          buildQwenRequestHeaders({
            cookie: stopHeaders.cookie,
            userAgent: stopHeaders["user-agent"],
            bxUa: stopHeaders["bx-ua"],
            bxUmidtoken: stopHeaders["bx-umidtoken"],
            bxV: stopHeaders["bx-v"],
            chatSessionId: stopSessionId,
          }),
          JSON.stringify({
            chat_id: stopSessionId,
            response_id: targetResponseId,
          }),
          {
            referrer: qwenUrl(`/c/${encodeURIComponent(stopSessionId)}`),
            // The client is already gone and a retry may own the page mutex.
            // A mutex timeout here must NOT trigger the stuck-mutex recovery
            // (close context + reset profile) or a best-effort stop cools the
            // account for 300s.
            noMutexRecovery: true,
          },
        )
          .then(() => {
            // A successful stop response means the account no longer needs the
            // protective busy window.
            clearTemporaryBusy(stopAccountId, stopBusyUntil);
          })
          .catch((err) => {
            console.error(`❌ [Chat] Stop failed | ${err.message}`);
          });
      } else {
        if (logger.isLevelEnabled("info")) {
          console.log(
            `⏭️  [Chat] Skip Qwen stop | ${completionId} | no response_id yet`,
          );
        }
      }

      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
      }
    };

    const abortHandler = () => {
      if (clientDisconnected) return;
      clientDisconnected = true;

      const graceMs = config.stream.disconnectGraceMs;
      if (graceMs > 0) {
        gracePending = true;
        if (logger.isLevelEnabled("info")) {
          console.log(
            `🔌 [Chat] Client disconnected | ${completionId} | grace ${graceMs}ms - keeping Qwen generation alive`,
          );
        }
        graceTimer = setTimeout(() => {
          gracePending = false;
          graceTimer = null;
          runDisconnectTeardown();
        }, graceMs);
        return;
      }

      runDisconnectTeardown();
    };

    c.req.raw.signal.addEventListener("abort", abortHandler);

    // Micro-buffer: coalesce many tiny SSE writes into fewer socket writes to cut
    // syscall overhead on long responses. Ordering is preserved because EVERY write
    // (content, reasoning, events, [DONE]) goes through this single buffer.
    let writeBuffer = '';
    let writeTimer: ReturnType<typeof setTimeout> | null = null;
    const WRITE_FLUSH_BYTES = 8192;
    const WRITE_FLUSH_MS = 3;

    const flushWrites = () => {
      if (clientDisconnected) {
        writeBuffer = '';
        writeTimer = null;
        return;
      }
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
      if (writeBuffer) {
        const data = writeBuffer;
        writeBuffer = '';
        streamWriter.write(data);
      }
    };

    try {
      await streamWriter.write(": heartbeat\n\n");

      // Protocol probe state. The probe itself runs LATER (after the recovery
      // machinery is defined) so probe failures route through
      // recoverFromStreamError (mid-stream retry) — the outer retry loop can no
      // longer run once the response has started. The response is already open
      // here, so heartbeats cover the wait for the upstream's first byte.
      const streamReader = stream.getReader();
      const streamDecoder = new TextDecoder();
      let initialStreamBuffer = "";
      let initialProbeBytes = 0;

      const scheduleHeartbeat = () => {
        heartbeatTimeout = setTimeout(async () => {
          if (clientDisconnected) return;
          try {
            await streamWriter.write(": keep-alive\n\n");
            scheduleHeartbeat();
          } catch (err) {
            logger.debug("[streaming] Heartbeat error", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }, 15000);
      };

      scheduleHeartbeat();

      const createdTimestamp = Math.floor(Date.now() / 1000);

      const bufferedWrite = (data: string) => {
        if (clientDisconnected) return;
        writeBuffer += data;
        if (writeBuffer.length >= WRITE_FLUSH_BYTES) {
          flushWrites();
        } else if (!writeTimer) {
          writeTimer = setTimeout(flushWrites, WRITE_FLUSH_MS);
        }
      };

      // Batch buffer: when non-null, writeEvent accumulates instead of flushing
      let flushBuffer: string[] | null = null;

      // Synchronous: avoids per-call Promise allocation on the hot path.
      const writeEvent = (data: any) => {
        const serialized = `data: ${JSON.stringify(data)}\n\n`;
        if (Array.isArray(flushBuffer)) {
          flushBuffer.push(serialized);
          return;
        }
        bufferedWrite(serialized);
      };

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason,
      });

      // Pre-computed SSE event head for the hot-path text/reasoning deltas.
      // Byte-identical to JSON.stringify of the equivalent object (verified).
      const eventHead =
        `"id":${JSON.stringify(completionId)},"object":"chat.completion.chunk"` +
        `,"created":${createdTimestamp},"model":${JSON.stringify(body.model)}` +
        `,"choices":[{"index":0,"delta":`;
      const eventTail = `,"logprobs":null,"finish_reason":null}]}`;

      const writeDeltaEvent = (delta: Record<string, unknown>) => {
        // First model output to reach the client: the emit-aware supersede uses
        // this to allow latest-wins only AFTER the client consumed something.
        markStreamEmitted(completionId);
        const now = Date.now();
        if (firstChunkAt === null) {
          firstChunkAt = now;
          if (logger.isLevelEnabled("info")) {
            console.log(
              `⏱️ [Chat] First chunk | req=${reqId} | +${firstChunkAt - streamStartedAt}ms`,
            );
          }
        }
        lastDeltaAt = now;
        const serialized =
          `data: {${eventHead}${JSON.stringify(delta)}${eventTail}\n\n`;
        if (Array.isArray(flushBuffer)) {
          flushBuffer.push(serialized);
          return;
        }
        bufferedWrite(serialized);
      };

      // Initial role chunk. Flush immediately so the first data event is not
      // held back by the 3 ms coalescing timer (time-to-first-data).
      writeEvent({
        id: completionId,
        object: "chat.completion.chunk",
        created: createdTimestamp,
        model: body.model,
        choices: [makeChoice({ role: "assistant", content: "" })],
      });
      flushWrites();

      let reader: ReadableStreamDefaultReader<Uint8Array> = streamReader;
      activeReader = reader;
      const decoder = new TextDecoder();

      let lastThinkingSummary = "";
      let lastThinkingSummaryLength = 0;
      let lastThinkingSummarySuffix = "";
      let lastRawContent = "";
      let lastRawContentLength = 0;
      let lastRawContentSuffix = "";
      let finalContent = "";
      let reasoningBuffer = "";
      let emittedModelOutput = false;
      let targetResponseId: string | null = null;
      let toolParser = shouldParseToolCalls
        ? new StreamingToolParser(declaredTools, {
            incrementalToolCalls: true,
            maxToolCallsPerTurn: config.retry.maxToolCallsPerTurn,
          })
        : null;

      let buffer = initialStreamBuffer;
      const usageAccumulator = createUsageAccumulator(0);
      let pendingParentId: string | null = null;
      let upstreamDone = false;
      const rememberSession = (sessionId: string | null) => {
        if (!sessionId || sessionId === currentUiSessionId) return;
        currentUiSessionId = sessionId;
        updateStreamSessionId(completionId, sessionId);
      };

      const rememberParent = (parentId: string) => {
        if (!currentUiSessionId) return;
        updateSessionParent(currentUiSessionId, parentId, currentAccountId);
        updateLogicalThreadParent(
          logicalSessionId,
          parentId,
          currentAccountId,
          currentUiSessionId,
        );
      };

      const emitAnswerText = async (textChunk: string) => {
        if (textChunk) emittedModelOutput = true;
        if (!toolParser) {
          finalContent += textChunk;
          writeDeltaEvent({ content: textChunk });
          return;
        }

        const { text, toolCalls, toolCallDeltas } = toolParser.feed(textChunk);
        if (text || toolCalls.length > 0 || toolCallDeltas.length > 0) {
          emittedModelOutput = true;
        }

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
          finalContent += text;
          writeDeltaEvent({ content: text });
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
            created: createdTimestamp,
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
            created: createdTimestamp,
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

      // After a failover/retry the tool-call parser is fresh but the text
      // dedup (against the previous attempt's content) may strip the shared
      // prefix from the first chunk, cutting a tool block mid-way (e.g. the
      // `<tool_call>{"name":...` header). Feed that deduped-away prefix into
      // the parser as non-emitted context so the reassembled block completes.
      const seedParserWithDedupedPrefix = (
        cumulativeContent: string,
        emittedDelta: string,
      ): void => {
        if (!toolParser || !cumulativeContent) return;
        const newLen = cumulativeContent.length;
        const emittedLen = emittedDelta.length;
        if (newLen <= emittedLen) return;
        const prefix = cumulativeContent.slice(0, newLen - emittedLen);
        if (!prefix) return;
        toolParser.feed(prefix);
      };



      const recoverFromStreamError = async (rawError: unknown): Promise<boolean> => {
        const normalizedError =
          rawError instanceof RetryableQwenStreamError
            ? rawError
            : isNetworkLikeError(rawError)
              ? toRetryableStreamError(
                  "network_error",
                  rawError instanceof Error ? rawError.message : String(rawError),
                  {
                    switchAccount: true,
                    forceNewChat: true,
                    retryAfterMs: 3000,
                    reason: "network",
                  },
                )
              : null;

        if (
          !normalizedError ||
          (clientDisconnected && !gracePending) ||
          c.req.raw.signal.aborted ||
          retryContext.retriesLeft <= 0 ||
          !midStreamRetry ||
          emittedModelOutput
        ) {
          return false;
        }

        const policy = classifyRetryAction(normalizedError, {
          requestAborted: c.req.raw.signal.aborted,
        });
        if (!policy.retryable) return false;

        // Full recovery decision — same rationale as the create-path policy
        // log: the failure line shows the error, this line shows WHY the
        // chosen action (retry same / switch / new chat / cooldown) was taken.
        if (logger.isLevelEnabled("info")) {
          console.log(
            `🧭 [Chat] Stream recovery policy | account=${currentAccountId} | reason=${policy.reason} | retryable=${policy.retryable} | switch=${policy.switchAccount} | newChat=${policy.forceNewChat} | fullPrompt=${policy.retryWithFullPrompt} | retryAfter=${policy.retryAfterMs}ms`,
          );
        }

        if (policy.reason === "corrupted_chat_history") {
          invalidateLogicalThreadParent(midStreamRetry.sessionId);
        }

        retryContext.retriesLeft--;
        console.warn(
          `🔄 [Chat] Stream recovery | account=${currentAccountId} | reason=${policy.reason} | error=${normalizedError.message.substring(0, 150)} | retries_left=${retryContext.retriesLeft}`,
        );

        const retryInvalidInputOnSameAccount =
          shouldRetryInvalidInputOnSameAccount(
            policy.reason,
            invalidInputSameAccountRetries > 0,
          );
        if (retryInvalidInputOnSameAccount) {
          invalidInputSameAccountRetries++;
        }
        const retryChatInProgressOnSameAccount =
          shouldRetryChatInProgressOnSameAccount(
            policy.reason,
            chatInProgressSameAccountRetries,
          );
        if (retryChatInProgressOnSameAccount) {
          chatInProgressSameAccountRetries++;
        }
        // chat_in_progress never escalates to an account switch with a
        // full-context replay (the ~1MB re-upload cost the settle design
        // removes). After the same-chat settle budget, fail the stream and let
        // the request-level policy surface the error — the client's own retry
        // lands on the settled chat, thread intact.
        if (
          policy.reason === "chat_in_progress" &&
          !retryChatInProgressOnSameAccount
        ) {
          console.warn(
            `🛑 [Chat] Stream recovery: chat_in_progress budget exhausted | account=${currentAccountId} | failing without full-context replay`,
          );
          return false;
        }
        const switchAccount =
          policy.switchAccount && !retryInvalidInputOnSameAccount;

        if (
          switchAccount &&
          (policy.accountCooldownMs || policy.accountCooldownReason)
        ) {
          markAccountRateLimited(
            currentAccountId,
            policy.accountCooldownMs,
            policy.accountCooldownReason || "StreamRetry",
          );
        }

        retryContext.releaseAccountLease?.();
        retryContext.releaseAccountLease = null;
        await reader.cancel().catch(() => undefined);
        removeStream(completionId);

        if (policy.retryAfterMs > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(policy.retryAfterMs, 3000)),
          );
        }

        const forceRetryNewChat = policy.forceNewChat;
        const needsFullPrompt =
          policy.retryWithFullPrompt || switchAccount || forceRetryNewChat;
        const newStreamResult = await acquireUpstreamStream({
          finalPrompt: needsFullPrompt
            ? midStreamRetry.fullPrompt
            : finalPrompt,
          fullPrompt: midStreamRetry.fullPrompt,
          isThinkingModel: midStreamRetry.isThinkingModel,
          model: body.model,
          contextModelId: midStreamRetry.contextModelId,
          shouldResetUpstreamThread: needsFullPrompt,
          allFiles: policy.dropFiles ? [] : midStreamRetry.allFiles,
          isNewSession: midStreamRetry.isNewSession,
          sessionId: midStreamRetry.sessionId,
          useThreadNative: midStreamRetry.useThreadNative,
          updateLogicalThread: midStreamRetry.updateLogicalThread,
          parallelEscape: midStreamRetry.parallelEscape,
          allowThreadReuse: midStreamRetry.allowThreadReuse,
          chatMode: midStreamRetry.chatMode,
          forceNewChat: forceRetryNewChat || switchAccount,
          preferredAccountId: switchAccount ? null : currentAccountId,
          excludeAccountIds: switchAccount ? [currentAccountId] : undefined,
          messageCount: needsFullPrompt
            ? midStreamRetry.fullMessageCount
            : midStreamRetry.messageCount,
          fullMessageCount: midStreamRetry.fullMessageCount,
          toolsCount: midStreamRetry.toolsCount,
          requestPersonalizationInstruction:
            midStreamRetry.requestPersonalizationInstruction,
          contextMode: needsFullPrompt
            ? "replay"
            : (midStreamRetry.contextMode ?? "delta"),
          requestSignal: c.req.raw.signal,
          allowTemporarilyBusyAccountId: currentAccountId,
          messages: midStreamRetry.messages,
        });

        if ("error" in newStreamResult) {
          logger.error("[Chat] Stream recovery could not acquire a new stream", {
            account: currentAccountId,
            error: newStreamResult.error?.message || "unknown error",
            completionId,
          });
          throw newStreamResult.error ?? normalizedError;
        }

        const previousUiSessionId = currentUiSessionId;
        currentAccountId = newStreamResult.activeAccountId;
        currentUiSessionId = newStreamResult.uiSessionId;
        retryContext.releaseAccountLease =
          newStreamResult.releaseAccountLease;
        currentTokenEstimationContext =
          newStreamResult.tokenEstimationContext;
        targetResponseId = null;
        // Keep the text dedup state (lastRawContent/lastThinkingSummary):
        // the recovery chat re-answers the same question from scratch, so
        // getIncrementalDelta's common-prefix logic drops the already-emitted
        // prefix instead of re-printing the first sentence to the client.
        toolParser = shouldParseToolCalls
          ? new StreamingToolParser(declaredTools, {
              incrementalToolCalls: true,
              maxToolCallsPerTurn: config.retry.maxToolCallsPerTurn,
            })
          : null;
        recoverySeedPending = true;
        Object.assign(usageAccumulator, createUsageAccumulator(0));
        buffer = "";
        pendingParentId = null;
        upstreamDone = false;

        const newEntry = getStream(newStreamResult.completionId);
        removeStream(newStreamResult.completionId);
        if (newEntry) {
          registerStream(completionId, {
            ...newEntry,
            targetResponseId: "",
          });
        }

        console.log(
          `🔄 [Chat] Stream recovery switched account | old=${previousUiSessionId.substring(0, 12)} | new=${currentUiSessionId.substring(0, 12)} | account=${currentAccountId}`,
        );
        reader = newStreamResult.stream.getReader();
        activeReader = reader;
        return true;
      };

      // Protocol probe: consume the upstream's first bytes to detect a WAF
      // HTML / non-SSE / early error payload. Runs here (after
      // recoverFromStreamError is defined) so probe failures route through the
      // mid-stream recovery instead of surfacing as an un-retried SSE error.
      // The response is already open — heartbeats cover the wait for the first
      // byte (slow thinking).
      let probeFailed = false;
      try {
        while (true) {
          const { done, value } = await streamReader.read();
          if (done) {
            initialStreamBuffer += streamDecoder.decode();
            break;
          }

          initialStreamBuffer += streamDecoder.decode(value, {
            stream: true,
          });
          if (hasSseProtocolStart(initialStreamBuffer)) {
            break;
          }
          initialProbeBytes += value.byteLength;
          if (initialProbeBytes > MAX_INITIAL_PROTOCOL_BYTES) {
            throw toRetryableStreamError(
              "non_sse_response",
              "Qwen did not start an SSE response before the protocol probe limit.",
            );
          }
        }

        // NOTE: early SSE error events (data: {"error":...}) are deliberately
        // NOT checked here — the read loop detects chunk.error and routes it
        // through recoverFromStreamError. Checking here would duplicate that
        // and swallow the retry.
        const probeUpstreamError = parseQwenErrorPayload(initialStreamBuffer);
        if (probeUpstreamError) {
          throwParsedUpstreamError(probeUpstreamError);
        }
      } catch (probeError) {
        probeFailed = true;
        if (await recoverFromStreamError(probeError)) {
          // Recovery swapped the reader and reset buffer — proceed to the read
          // loop with the fresh stream.
        } else {
          await streamReader.cancel().catch(() => undefined);
          throw probeError;
        }
      }
      if (!probeFailed) {
        buffer = initialStreamBuffer;
      }
      activeReader = reader;

      // Main SSE reader loop
      while (true) {
        if (clientDisconnected && !gracePending) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] stream: breaking loop - client disconnected");
          }
          break;
        }

        // Single indexOf scan: also serves as the "need more data" guard,
        // avoiding a second full-buffer pass via includes().
        let lineStart = 0;
        let lineEnd = buffer.indexOf("\n");

        if (lineEnd === -1) {
          let readResult: ReadableStreamReadResult<Uint8Array>;
          try {
            readResult = await reader.read();
          } catch (readError) {
            if (await recoverFromStreamError(readError)) continue;
            throw readError;
          }
          if (readResult.done) break;

          buffer += decoder.decode(readResult.value, { stream: true });
          lineEnd = buffer.indexOf("\n");
          if (lineEnd === -1) continue;
        }

        for (; lineEnd !== -1; lineEnd = buffer.indexOf("\n", lineStart)) {
          // Extract the data payload with a single substring (no slice/trim
          // cascade). Qwen SSE lines are well-formed `data: <json>` + LF/CRLF.
          let dataStr = "";
          if (buffer.startsWith("data:", lineStart)) {
            let s = lineStart + 5;
            if (buffer.charCodeAt(s) === 32) s++; // single space after "data:"
            let e = lineEnd;
            if (e > s && buffer.charCodeAt(e - 1) === 13) e--; // \r of CRLF
            dataStr = buffer.substring(s, e);
          }
          lineStart = lineEnd + 1;
          if (!dataStr) continue;

          if (dataStr === "[DONE]") {
            upstreamDone = true;
            if (!clientDisconnected) {
              // Drain buffered deltas first; the single final [DONE] is
              // emitted by the stream tail below so we exit the read loop
              // immediately without waiting on the keep-alive connection.
              flushWrites();
            }
            break; // Exit the for loop; the while check below leaves the read loop
          }

          if (upstreamDebugEnabled) {
            console.log(`📤 [Upstream] Chunk | ${dataStr.substring(0, 500)}`);
          }

          // Fast-path: simple text delta (avoids JSON.parse for ~90% of chunks)
          const fastMatch = dataStr.match(
            /^\{"response_id":"[^"]*","choices":\[\{"delta":\{"content":"((?:[^"\\]|\\.)*)"\}\}\]\}$/,
          );
          if (fastMatch) {
            const unescaped = fastMatch[1]
              .replace(/\\n/g, "\n")
              .replace(/\\t/g, "\t")
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, "\\");

            if (unescaped) {
              const result = getIncrementalDelta(
                lastRawContent,
                unescaped,
                lastRawContentLength,
                lastRawContentSuffix,
              );
              const vStr = result.delta;
              if (recoverySeedPending && unescaped) {
                seedParserWithDedupedPrefix(unescaped, vStr || "");
                recoverySeedPending = false;
              }
              if (vStr && vStr !== "FINISHED") {
                lastRawContent = result.matchedContent;
                lastRawContentLength = result.contentLength;
                lastRawContentSuffix = result.contentSuffix;
                await emitAnswerText(vStr);
                if (toolParser?.isToolCapReached()) {
                  stoppedByToolCap = true;
                  if (!clientDisconnected) flushWrites();
                  break;
                }
              }
            }
            continue;
          }

          try {
                      const chunk = JSON.parse(dataStr);
                      rememberSession(extractChatSessionId(chunk));

                      // Generic upstream SSE error handling (retry/switch via policy)
                      if (chunk.error) {
                        const errDetails =
                          chunk.error.details ||
                          chunk.error.message ||
                          JSON.stringify(chunk.error);
                        const errCode = chunk.error.code || "upstream_error";
                        throwFromSseUpstreamError(errCode, errDetails);
                      }

                      if (
                        chunk["response.created"] &&
                        chunk["response.created"].response_id
                      ) {
                        // chat_id first so rememberParent can bind sticky state
                        if (chunk["response.created"].chat_id) {
                          rememberSession(chunk["response.created"].chat_id);
                        }
                        if (!targetResponseId) {
                          targetResponseId = chunk["response.created"].response_id;
                          if (targetResponseId) {
                            updateStreamTargetResponseId(completionId, targetResponseId);
                          }
                        }
                        // Commit the parent only after the stream finishes successfully.
                        pendingParentId = chunk["response.created"].response_id;
                        // Qwen-internal metadata event — never forward to the client.
                        continue;
                      } else if (chunk.response_id && !targetResponseId) {
                        targetResponseId = chunk.response_id;
                        if (targetResponseId) {
                          updateStreamTargetResponseId(completionId, targetResponseId);
                        }
                        pendingParentId = chunk.response_id;
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

              // Qwen streams may end with a {"status":"finished",
              // "phase":"answer"} delta and NO trailing [DONE]. Treat it as
              // the terminal event so we don't wait on the keep-alive
              // connection to close (up to the 60s/10min idle timeout).
              if (delta.phase === "answer" && delta.status === "finished") {
                upstreamDone = true;
                if (!clientDisconnected) flushWrites();
                break; // Exit the for loop; the while check leaves the read loop
              }

              if (delta.phase === "thinking_summary") {
                isThinkingChunk = true;
                const formattedSummary = formatThinkingSummaryContent(delta);
                if (formattedSummary) {
                  const result = getIncrementalDelta(
                    lastThinkingSummary,
                    formattedSummary,
                    lastThinkingSummaryLength,
                    lastThinkingSummarySuffix,
                  );
                  vStr = result.delta;
                  lastThinkingSummary = result.matchedContent;
                  lastThinkingSummaryLength = result.contentLength;
                  lastThinkingSummarySuffix = result.contentSuffix;
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
                    lastRawContentLength,
                    lastRawContentSuffix,
                  );
                  vStr = result.delta;
                  if (recoverySeedPending && newContent) {
                    seedParserWithDedupedPrefix(newContent, vStr || "");
                    recoverySeedPending = false;
                  }
                  if (vStr) {
                    lastRawContent = result.matchedContent;
                    lastRawContentLength = result.contentLength;
                    lastRawContentSuffix = result.contentSuffix;
                    foundStr = true;
                  }
                }
              }
            }

            if (foundStr && vStr !== "") {
              if (vStr === "FINISHED") continue;

              if (isThinkingChunk) {
                emittedModelOutput = true;
                reasoningBuffer += vStr;
                writeDeltaEvent({ reasoning_content: vStr });
              } else {
                await emitAnswerText(vStr);
                if (toolParser?.isToolCapReached()) {
                  stoppedByToolCap = true;
                  if (!clientDisconnected) flushWrites();
                  break;
                }
              }
            }
          } catch (_e) {
            // Never start a transparent retry after the downstream client has
            // gone away. A stop/abort can race the upstream error and otherwise
            // keep creating requests on the same sticky account in the
            // background.
            if ((clientDisconnected && !gracePending) || c.req.raw.signal.aborted) {
              return;
            }

            if (await recoverFromStreamError(_e)) {
              continue;
            }

            if (_e instanceof RetryableQwenStreamError) {
              throw _e;
            }
            // Ignore partial chunk parse errors.
          }
        }

        // A terminal [DONE] / answer-finished delta exits via `break` from
        // the for loop above; leave the while loop instead of re-reading so a
        // lingering keep-alive upstream connection doesn't stall the tail
        // (finish_reason + [DONE]) until the idle timeout or connection close.
        if (upstreamDone) break;
        if (stoppedByToolCap) break;

        buffer = lineStart > 0 ? buffer.slice(lineStart) : buffer;
      }

      // Tool-call cap reached: stop the upstream generation now. The turn
      // closes cleanly below (finish_reason "tool_calls" + [DONE]); this is a
      // SUCCESS path, never a mid-stream retry. Cancelling the active reader
      // closes the upstream connection so Qwen stops generating the calls that
      // would only be dropped.
      if (stoppedByToolCap) {
        logger.warn("[chat] stream: tool-call cap reached — closing turn early", {
          completionId,
          maxToolCallsPerTurn: config.retry.maxToolCallsPerTurn,
          emittedToolCalls: toolParser?.getEmittedToolCallCount() ?? 0,
        });
        // Tell the NEXT turn of this session that calls beyond the cap were not
        // executed, so the model can re-issue them.
        setToolCapNotice(logicalSessionId);
        await reader.cancel().catch(() => undefined);
      }

      // Post-stream: error check + flush remaining content
      const upstreamError = parseQwenErrorPayload(buffer);
      if (upstreamError) {
        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: body.model,
          choices: [makeChoice({ content: upstreamError.message })],
        });
        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: body.model,
          choices: [makeChoice({}, "stop")],
        });
        flushWrites();
        await streamWriter.write("data: [DONE]\n\n");
        return;
      }

      // Activate batch mode — all writeEvent calls accumulate until flushed
      flushBuffer = [];



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
        finalContent += remainingText;
        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
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
          created: createdTimestamp,
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
          created: createdTimestamp,
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

      // ── Auto-retry malformed tool calls BEFORE finish reason ────────────
      // Must run before finish-reason/[DONE] so the client never sees a
      // premature finish_reason or [DONE] before the retry's chunks.
      if (
        !clientDisconnected &&
        midStreamRetry &&
        toolParser &&
        config.retry.autoRetryMalformedTools !== false
      ) {
        let malformedRetryCount = midStreamRetry.malformedRetryCount ?? 0;
        const maxMalformedRetries = config.retry.autoRetryMalformedToolsMax;
        let activeRetryStream: ReadableStream<Uint8Array> | null = null;

        while (malformedRetryCount < maxMalformedRetries) {
          if (!toolParser) break;
          const allToolsFailed =
            toolParser.getMalformedToolCalls().length > 0 &&
            toolParser.getEmittedToolCallCount() === 0;
          if (!allToolsFailed) break;

          const malformedCalls = toolParser.getMalformedToolCalls();
          const malformedCount = malformedCalls.length;

          const undeclaredNames = malformedCalls
            .flatMap((mc) => mc.undeclaredNames || [])
            .filter((name, index, self) => self.indexOf(name) === index);

          const availableToolNames = declaredTools
            .map((t: any) => (t.type === "function" ? t.function?.name : t.name))
            .filter((n: string | undefined): n is string => !!n);
          const toolsHint =
            availableToolNames.length > 0
              ? `\n\nAvailable tools: ${availableToolNames.join(", ")}`
              : "";

          let errorMessage: string;
          if (undeclaredNames.length > 0) {
            errorMessage = `Your previous ${malformedCount} tool call(s) used undeclared tool names: ${undeclaredNames.join(", ")}. Only declared tools can be executed. Please retry with valid tool names.${toolsHint}`;
          } else {
            const previews = malformedCalls
              .slice(0, 3)
              .map((mc) => mc.contentPreview?.substring(0, 100) || "(empty)")
              .join("\n  - ");
            errorMessage = `Your previous ${malformedCount} tool call(s) were malformed and could not be executed. The JSON was invalid or truncated. Please retry with valid JSON.\n\nFailed attempt(s):\n  - ${previews}${toolsHint}`;
          }

          logger.warn("[chat] stream: auto-retrying malformed tool calls", {
            malformedCount,
            undeclaredNames,
            completionId,
            retryAttempt: malformedRetryCount + 1,
            maxRetries: maxMalformedRetries,
          });

          const retryPrompt = `${midStreamRetry.fullPrompt}\n\n[SYSTEM CORRECTION]\n${errorMessage}\n\nPlease retry your tool call(s) with correct JSON and valid tool names from the available tools list above.`;

          // Release the current stream (original or previous retry) and lease.
          const streamToCancel = activeRetryStream ?? stream;
          try {
            await streamToCancel.cancel();
          } catch (cancelErr) {
            // Ignore cancel errors
          }
          midStreamRetry.releaseAccountLease();

          const newStreamResult = await acquireUpstreamStream({
            finalPrompt: retryPrompt,
            fullPrompt: retryPrompt,
            isThinkingModel: midStreamRetry.isThinkingModel,
            model: body.model,
            reasoningMode: midStreamRetry.reasoningMode,
            shouldResetUpstreamThread: true,
            allFiles: midStreamRetry.allFiles,
            isNewSession: midStreamRetry.isNewSession,
            sessionId: midStreamRetry.sessionId,
            useThreadNative: midStreamRetry.useThreadNative,
            updateLogicalThread: midStreamRetry.updateLogicalThread,
            parallelEscape: midStreamRetry.parallelEscape,
            allowThreadReuse: midStreamRetry.allowThreadReuse,
            chatMode: midStreamRetry.chatMode,
            forceNewChat: true,
            preferredAccountId: midStreamRetry.activeAccountId,
            excludeAccountIds: undefined,
            messageCount: midStreamRetry.messageCount,
            fullMessageCount: midStreamRetry.fullMessageCount,
            toolsCount: midStreamRetry.toolsCount,
            requestPersonalizationInstruction:
              midStreamRetry.requestPersonalizationInstruction,
            contextMode: "replay",
            requestSignal: c.req.raw.signal,
            messages: midStreamRetry.messages,
          });

          if ("error" in newStreamResult) {
            // Client abort during the retry acquisition is expected (the client
            // may have disconnected while the retry stream was being created):
            // break silently instead of logging an error.
            if (newStreamResult.error instanceof ClientAbortedError) {
              logger.debug(
                "[chat] stream: auto-retry aborted by client (silent)",
                {
                  completionId,
                },
              );
              break;
            }
            logger.error("[chat] stream: auto-retry failed to acquire stream", {
              error: newStreamResult.error?.message,
              completionId,
            });
            break;
          }

          // P1.1: client may have disconnected while acquiring the retry stream.
          // Release the fresh lease (idempotent) and stop — nobody will read it.
          if (clientDisconnected || c.req.raw.signal.aborted) {
            newStreamResult.releaseAccountLease();
            break;
          }

          console.log(
            `🔄 [Chat] Auto-retry (${malformedRetryCount + 1}/${maxMalformedRetries}) | ${newStreamResult.activeAccountLabel} | ${body.model} | chat=${newStreamResult.uiSessionId.substring(0, 12)} | reason=malformed_tool_calls`,
          );

          // Transfer the retry's stream registry entry to the original
          // completionId so abort/stop target the active upstream stream.
          const retryEntry = getStream(newStreamResult.completionId);
          removeStream(newStreamResult.completionId);
          if (retryEntry) {
            registerStream(completionId, {
              ...retryEntry,
              targetResponseId: "",
            });
          }

          // Reset to a fresh tool-call parser so malformed detection re-evaluates
          // on the retry output. Keep the TEXT dedup state (lastRawContent/
          // lastThinkingSummary): the retry re-answers the earlier text, and
          // getIncrementalDelta drops the already-emitted prefix instead of
          // re-printing it to the client.
          toolParser = shouldParseToolCalls
            ? new StreamingToolParser(declaredTools, {
                incrementalToolCalls: true,
                maxToolCallsPerTurn: config.retry.maxToolCallsPerTurn,
              })
            : null;
          targetResponseId = null;
          pendingParentId = null;
          upstreamDone = false;
          let retryErrorPayload: unknown = null;
          let retrySeedPending = true;

          const retryReader = newStreamResult.stream.getReader();
          activeReader = retryReader;
          activeRetryStream = newStreamResult.stream;
          retryContext.releaseAccountLease = newStreamResult.releaseAccountLease;
          currentUiSessionId = newStreamResult.uiSessionId;
          currentAccountId = newStreamResult.activeAccountId;
          const retryDecoder = new TextDecoder();
          let retryBuf = "";

          retryReadLoop: while (true) {
            const { done, value } = await retryReader.read();
            if (done) break;

            retryBuf += retryDecoder.decode(value, { stream: true });
            let lineStart = 0;
            let lineEnd = retryBuf.indexOf("\n", lineStart);

            for (; lineEnd !== -1; lineEnd = retryBuf.indexOf("\n", lineStart)) {
              let dataStr = "";
              if (retryBuf.startsWith("data:", lineStart)) {
                let s = lineStart + 5;
                if (retryBuf.charCodeAt(s) === 32) s++;
                let e = lineEnd;
                if (e > s && retryBuf.charCodeAt(e - 1) === 13) e--;
                dataStr = retryBuf.substring(s, e);
              }
              lineStart = lineEnd + 1;
              if (!dataStr) continue;
              // Critical detail 2: skip upstream [DONE] so a duplicate [DONE]
              // does not leak to the client. The single final [DONE] is emitted
              // after all retries complete.
              if (dataStr === "[DONE]") {
                upstreamDone = true;
                break retryReadLoop;
              }

              // Parse the retry stream exactly like the main stream: metadata
              // events are consumed (never forwarded), cumulative deltas are
              // deduped, and text/tool deltas stream through emitAnswerText.
              let parsedChunk: any;
              try {
                parsedChunk = JSON.parse(dataStr);
              } catch {
                // Incomplete/partial chunk — drop it instead of leaking raw JSON.
                continue;
              }

              if (parsedChunk.error) {
                // Upstream error on the retry channel. Abort retries and let the
                // normal streaming error path surface it to the client.
                retryErrorPayload = parsedChunk.error;
                break retryReadLoop;
              }

              if (parsedChunk["response.created"]) {
                if (parsedChunk["response.created"].chat_id) {
                  rememberSession(parsedChunk["response.created"].chat_id);
                }
                if (!targetResponseId) {
                  targetResponseId = parsedChunk["response.created"].response_id;
                  if (targetResponseId) {
                    updateStreamTargetResponseId(completionId, targetResponseId);
                  }
                }
                pendingParentId = parsedChunk["response.created"].response_id;
                // Qwen-internal metadata event — never forward to the client.
                continue;
              } else if (parsedChunk.response_id && !targetResponseId) {
                rememberSession(extractChatSessionId(parsedChunk));
                targetResponseId = parsedChunk.response_id;
                if (targetResponseId) {
                  updateStreamTargetResponseId(completionId, targetResponseId);
                }
                pendingParentId = parsedChunk.response_id;
              }

              applyUpstreamUsage(usageAccumulator, parsedChunk.usage);

              const delta = parsedChunk?.choices?.[0]?.delta;
              if (!delta) {
                // Non-metadata event without a delta — consume, don't forward.
                continue;
              }

              // The retry stream may also terminate with an answer-finished
              // delta when upstream sends no [DONE]. Leave the read loop
              // immediately so we don't stall on the keep-alive connection.
              if (delta.phase === "answer" && delta.status === "finished") {
                upstreamDone = true;
                break retryReadLoop;
              }

              let vStr = "";
              let foundStr = false;
              let isThinkingChunk = false;

              if (delta.phase === "thinking_summary") {
                isThinkingChunk = true;
                const formattedSummary = formatThinkingSummaryContent(delta);
                if (formattedSummary) {
                  const result = getIncrementalDelta(
                    lastThinkingSummary,
                    formattedSummary,
                    lastThinkingSummaryLength,
                    lastThinkingSummarySuffix,
                  );
                  vStr = result.delta;
                  lastThinkingSummary = result.matchedContent;
                  lastThinkingSummaryLength = result.contentLength;
                  lastThinkingSummarySuffix = result.contentSuffix;
                  if (vStr) foundStr = true;
                }
              } else if (delta.content !== undefined) {
                const newContent = delta.content || "";
                const result = getIncrementalDelta(
                  lastRawContent,
                  newContent,
                  lastRawContentLength,
                  lastRawContentSuffix,
                );
                vStr = result.delta;
                if (retrySeedPending && newContent) {
                  seedParserWithDedupedPrefix(newContent, vStr || "");
                  retrySeedPending = false;
                }
                if (vStr) {
                  lastRawContent = result.matchedContent;
                  lastRawContentLength = result.contentLength;
                  lastRawContentSuffix = result.contentSuffix;
                  foundStr = true;
                }
              }

              if (foundStr && vStr !== "") {
                if (vStr === "FINISHED") continue;
                if (isThinkingChunk) {
                  emittedModelOutput = true;
                  reasoningBuffer += vStr;
                  writeDeltaEvent({ reasoning_content: vStr });
                } else {
                  await emitAnswerText(vStr);
                }
              }
            }

            retryBuf = lineStart > 0 ? retryBuf.slice(lineStart) : retryBuf;
          }

          // Upstream error on the retry channel: surface it and stop retrying.
          if (retryErrorPayload) {
            const errSummary =
              typeof retryErrorPayload === "object" && retryErrorPayload !== null
                ? (retryErrorPayload as any).message ??
                  JSON.stringify(retryErrorPayload).substring(0, 240)
                : String(retryErrorPayload);
            throw new Error(
              `Qwen stream error during malformed-tool retry: ${errSummary}`,
            );
          }

          // Flush the retry parser (now the active toolParser) to emit any
          // remaining buffered content.
          if (toolParser) {
            const retryFlush = toolParser.flush();
            if (retryFlush.text) {
              finalContent += retryFlush.text;
              writeDeltaEvent({ content: retryFlush.text });
            }
            for (const tcDelta of retryFlush.toolCallDeltas) {
              writeDeltaEvent({
                tool_calls: [
                  {
                    index: tcDelta.index,
                    ...(tcDelta.id ? { id: tcDelta.id } : {}),
                    ...(tcDelta.type ? { type: tcDelta.type } : {}),
                    function: {
                      ...(tcDelta.function.name
                        ? { name: tcDelta.function.name }
                        : {}),
                      ...(tcDelta.function.arguments !== undefined
                        ? { arguments: tcDelta.function.arguments }
                        : {}),
                    },
                  },
                ],
              });
            }
            for (const tc of retryFlush.toolCalls) {
              writeDeltaEvent({
                tool_calls: [
                  {
                    index: toolParser.getEmittedToolCallCount() - 1,
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments),
                    },
                  },
                ],
              });
            }
          }

          // Update state for cleanup.
          currentTokenEstimationContext = newStreamResult.tokenEstimationContext;
          // The active toolParser already points at this attempt's parser, so
          // finish-reason + malformed detection use its results.

          // Propagate retry bookkeeping so a subsequent iteration (or the
          // non-streaming recursion) sees the updated lease / account / count.
          midStreamRetry.releaseAccountLease = newStreamResult.releaseAccountLease;
          midStreamRetry.activeAccountId = newStreamResult.activeAccountId;
          midStreamRetry.malformedRetryCount = malformedRetryCount + 1;

          malformedRetryCount++;
        }
      }

      // The active upstream attempt completed: persist the next-turn parent.
      // Failed/aborted attempts simply never commit, leaving the last successful
      // parent as the append point for the next turn.
      if (pendingParentId && upstreamDone) {
        rememberParent(pendingParentId);
        pendingParentId = null;
      }

      // Finish reason + usage + [DONE]
      const usage = enrichUsageWithContextMeter(
        buildUsage(usageAccumulator),
        currentTokenEstimationContext?.contextMeter,
      );
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

      // Tool calls that were dropped and NOT recovered by the auto-retry. Do NOT
      // surface a [WARNING] text block to the client: the auto-retry already
      // sent the correction to Qwen in the upstream prompt, and echoing it here
      // would leak a bridge-authored text note into the user-facing UI.
      if (
        !clientDisconnected &&
        toolParser &&
        (toolParser.getMalformedToolCalls().length > 0 ||
          toolParser.getCappedToolCalls().length > 0)
      ) {
        const malformedCalls = toolParser.getMalformedToolCalls();
        const undeclaredNames = malformedCalls
          .map((mc) => mc.undeclaredNames)
          .flat()
          .filter((n): n is string => !!n);
        const cappedToolNames = toolParser
          .getCappedToolCalls()
          .map((c) => c.toolName);

        logger.warn(
          "[chat] stream: tool calls not retried (malformed or over per-turn cap)",
          {
            malformedCount: malformedCalls.length,
            cappedCount: cappedToolNames.length,
            cappedToolNames,
            undeclaredNames,
            completionId,
          },
        );
      }

      await writeEvent({
        id: completionId,
        object: "chat.completion.chunk",
        created: createdTimestamp,
        model: body.model,
        choices: [makeChoice({}, finalFinishReason)],
      });

      if (body.stream_options?.include_usage) {
        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: sending usage event", { usage });
        }
        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: body.model,
          choices: [],
          usage,
        });
      }

      if (!clientDisconnected) {
        if (toolParser) {
          toolParser.clearMalformedToolCalls();
        }

        // Single write: flush all accumulated events + [DONE] sentinel
        const donePayload = "data: [DONE]\n\n";
        const payload =
          flushBuffer && flushBuffer.length > 0
            ? flushBuffer.join("") + donePayload
            : donePayload;

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: sending [DONE]", {
            batchedEvents: flushBuffer?.length ?? 0,
          });
        }

        flushWrites();
        await streamWriter.write(payload);
        flushBuffer = null;
        streamCompletedOk = true;

        scheduleAssistantComplete(onAssistantComplete, {
          sessionId: logicalSessionId,
          accountId: activeAccountId,
          chatSessionId: currentUiSessionId,
          parentId: null,
          responseId: targetResponseId,
          userPrompt,
          finalPrompt,
          assistantContent: finalContent,
          reasoningContent: reasoningBuffer || undefined,
          usage,
          finishReason: finalFinishReason,
        });

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: completed successfully", {
            completionId,
            totalEmittedToolCalls: toolParser
              ? toolParser.getEmittedToolCallCount()
              : 0,
            finishReason: finalFinishReason,
          });
        }

        logTokenEstimationSample({
          model: body.model,
          finalPrompt,
          userPrompt,
          assistantContent: finalContent,
          reasoningContent: reasoningBuffer || undefined,
          usage,
          mode: "stream",
          context: currentTokenEstimationContext,
        });
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

            // Idle/upstream aborts are retryable when the client is still connected
            if (
              isAbortError(err) &&
              !clientDisconnected &&
              !c.req.raw.signal.aborted
            ) {
              throw toRetryableStreamError(
                "stream_aborted",
                err?.message || "This operation was aborted",
                {
                  switchAccount: true,
                  forceNewChat: true,
                  retryAfterMs: Math.min(config.retry.baseDelayMs * 2, 3000),
                  reason: "stream_aborted",
                },
              );
            }
            throw err;
    } finally {
      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] stream: cleanup started", {
          completionId,
          clientDisconnected,
        });
      }

      if (logger.isLevelEnabled("info")) {
        const initialRetries = Math.max(0, config.retry.maxAttempts - 1);
        // Only mark as recovered when the stream actually completed (the SSE
        // terminal event was processed) after a mid-stream retry. A FAILED
        // attempt that used retries then threw should not say "recovered".
        const recovered =
          streamCompletedOk && retryContext.retriesLeft < initialRetries;
        const tailMs = lastDeltaAt === null ? null : Date.now() - lastDeltaAt;
        console.log(
          `⏱️ [Chat] Stream done | req=${reqId} | ${Date.now() - streamStartedAt}ms | firstChunk=${firstChunkAt === null ? "none" : `${firstChunkAt - streamStartedAt}ms`}${tailMs === null ? "" : ` | tail=${tailMs}ms`}${recovered ? ` | recovered` : ""}`,
        );
      }

      flushWrites();

      // Release the upstream stream lock immediately. The read loop exits on
      // the SSE terminal event (upstreamDone break) WITHOUT completing the
      // wrapper's pull(); if the upstream keeps the connection open on
      // keep-alive after the terminal event, the wrapper never sees done and
      // the per-account stream lock stays held until the idle timeout (180s for
      // thinking models) — the next turn on the same account blocks on it until
      // the acquire deadline fires (the 120s stall). Same pattern as
      // runDisconnectTeardown.
      void activeReader?.cancel().catch(() => undefined);

      c.req.raw.signal.removeEventListener("abort", abortHandler);
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
      }
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      removeStream(completionId);

      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] stream: cleanup completed", {
          completionId,
        });
      }

      // Release locks now that the stream is fully done
      if (onStreamComplete) onStreamComplete();

      // Release account lease from transparent retry if active
      if (retryContext.releaseAccountLease) {
        retryContext.releaseAccountLease();
        retryContext.releaseAccountLease = null;
      }
    }
  }, async (err: Error, errorStream: any) => {
    const retryable = err instanceof RetryableQwenStreamError;
    const errorCode =
      getQwenErrorCode(err) ||
      (isNetworkLikeError(err) ? "network_error" : "stream_error");
    const normalizedErrorCode = errorCode.toLowerCase();
    const errorType =
      normalizedErrorCode === "quota_limit" ||
      normalizedErrorCode === "ratelimited" ||
      normalizedErrorCode === "rate_limit" ||
      normalizedErrorCode === "rate_limit_exceeded"
        ? "rate_limit_error"
        : "upstream_error";

    const errorDetails = {
      account: activeAccountLabel,
      accountId: activeAccountId,
      code: errorCode,
      errorName: err.name,
      message: err.message?.substring(0, 200),
      stack: err.stack?.split("\n").slice(0, 3).join(" | "),
      completionId,
    };

    if (retryable) {
      if (activeAccountId && isNetworkLikeError(err)) {
        noteMidStreamNetworkFailure(activeAccountId);
      }
      logger.warn(
        "[Chat] Stream ended after retryable error (no more retries)",
        errorDetails,
      );
    } else {
      logger.error("[Chat] Stream callback error", errorDetails);
    }

    // The HTTP response is already committed at this point. Emit a terminal
    // OpenAI-compatible SSE error instead of silently closing the connection.
    try {
      await errorStream.write(
        `data: ${JSON.stringify({
          error: {
            message: err.message,
            type: errorType,
            code: errorCode,
          },
        })}\n\ndata: [DONE]\n\n`,
      );
    } catch (_writeErr) {
      // Stream already closed — client already disconnected or the stream
      // was cancelled. Nothing more we can do.
    }
  });
}

// ─── Top-level error wrapper ───────────────────────────────────────────────────

export function handleChatCompletionsError(c: Context, err: unknown): Response {
  const classified = classifyError(err);

  // Client aborted (or a same-session retry superseded the request) before the
  // stream could be created. Nobody is listening: do not emit a 500, do not
  // count it as a request error, and do not log an error line.
  if (classified instanceof ClientAbortedError) {
    logger.debug("[chat] client aborted during stream creation (silent)", {
      message: err instanceof Error ? err.message : String(err),
    });
    // 499 (Client Closed Request) is not part of Hono's StatusCode union;
    // a plain Response (status: number) is valid here.
    return new Response(null, { status: 499 });
  }

  if (classified.statusCode >= 500) {
    metrics.increment("requests.errors");
  }

  const message = err instanceof Error ? err.message : String(err);
  const code = classified.code || "unknown";
  const status = classified.statusCode;
  console.error(`❌ [Chat] Error | ${status} ${code} | ${message}`);

  // The one-line error omits WHERE the failure originated (account/chat/reason)
  // and the stack — both needed to reproduce. Emit the structured detail once;
  // the classification line stays for the compact terminal.
  if (logger.isLevelEnabled("info")) {
    const detail: Record<string, unknown> = {
      status,
      code,
      type: classified.type ?? undefined,
      message,
    };
    if (err instanceof Error) {
      detail.stack = err.stack;
    }
    const quota = (err as any)?.quotaInfo;
    if (quota) {
      detail.quota = {
        email: quota.email,
        cooldownSeconds: quota.cooldownSeconds,
        until: quota.untilStr,
        message: quota.message,
      };
    }
    const createdChat = (err as any)?.createdNewChat;
    if (createdChat) {
      detail.createdNewChat = true;
      const rawChatId = (err as any)?.chatSessionId;
      detail.chatId = rawChatId ? String(rawChatId).substring(0, 12) : undefined;
      detail.accountId = (err as any)?.accountId;
    }
    console.log(
      `🧾 [Chat] Error details | ${JSON.stringify(detail)}`,
    );
  }

  return sendOpenAIError(c, err);
}
