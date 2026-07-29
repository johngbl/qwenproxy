/*
 * File: streaming.ts
 * Project: QwenBridge
 *
 * Upstream stream consumption: both non-streaming (JSON) and streaming (SSE)
 * response modes. Encapsulates heartbeat, abort handling, reasoning tag
 * sanitization, and incremental tool-call parsing.
 */

import { Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import { buildQwenRequestHeaders } from "../../services/qwen-headers.ts";
import {
  updateLogicalThreadParent,
  updateSessionParent,
  RetryableQwenStreamError,
} from "../../services/qwen.ts";
import { acquireUpstreamStream } from "./account.ts";
import { markAccountRateLimited } from "../../core/account-manager.ts";
import { classifyRetryAction } from "./retry-policy.ts";
import type { OpenAIRequest, Usage } from "../../utils/types.ts";
import { StreamingToolParser } from "../../tools/parser.ts";
import {
  getStream,
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
import { config } from "../../core/config.js";
import { parseQwenErrorPayload } from "./errors.ts";
import {
  parseSseErrorFromBuffer,
  throwFromSseUpstreamError,
  toRetryableStreamError,
} from "./retry-policy.ts";
import {
  logTokenEstimationSample,
  type TokenEstimationContext,
} from "../../services/token-estimation-metrics.ts";
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

function hasSseProtocolStart(buffer: string): boolean {
  const trimmed = buffer.trimStart();
  return trimmed.startsWith("data:") || trimmed.startsWith(":");
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
    allFiles: any[];
    isNewSession: boolean;
    sessionId: string | null;
    useThreadNative: boolean;
    updateLogicalThread: boolean;
    allowThreadReuse: boolean;
    messageCount: number;
    fullMessageCount: number;
    toolsCount?: number;
    requestPersonalizationInstruction?: string | null;
    releaseAccountLease: () => void;
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
    let currentUiSessionId = uiSessionId;
    const toolParser = shouldParseToolCalls
      ? new StreamingToolParser(declaredTools)
      : null;
    const toolCallsOut: any[] = [];
    let buffer = "";
    let protocolBuffer = "";
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
        if (
          !sawSseProtocol &&
          Buffer.byteLength(protocolBuffer, "utf8") > MAX_INITIAL_PROTOCOL_BYTES
        ) {
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
        const line = buffer.slice(lineStart, lineEnd);
        lineStart = lineEnd + 1;
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const dataStr = trimmed.slice(5).trimStart();
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
                    // Next turn appends with parent_id = this assistant response
                    rememberParent(chunk["response.created"].response_id);
                  } else if (chunk.response_id && !targetResponseId) {
                    targetResponseId = chunk.response_id;
                    rememberParent(chunk.response_id);
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

    // Auto-retry if all tool calls were malformed (no successful tool calls)
    const allToolsFailed = toolParser && toolParser.getMalformedToolCalls().length > 0 && toolCallsOut.length === 0;
    if (allToolsFailed && config.retry.autoRetryMalformedTools !== false && midStreamRetry) {
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
      await stream.cancel();
      midStreamRetry.releaseAccountLease();

      // Acquire new stream for retry
      const newStreamResult = await acquireUpstreamStream({
        finalPrompt: retryPrompt,
        fullPrompt: retryPrompt,
        isThinkingModel: midStreamRetry.isThinkingModel,
        model: body.model,
        contextModelId: midStreamRetry.contextModelId,
        shouldResetUpstreamThread: true,
        allFiles: midStreamRetry.allFiles,
        isNewSession: midStreamRetry.isNewSession,
        sessionId: midStreamRetry.sessionId,
        useThreadNative: midStreamRetry.useThreadNative,
        updateLogicalThread: midStreamRetry.updateLogicalThread,
        allowThreadReuse: midStreamRetry.allowThreadReuse,
        forceNewChat: true,
        preferredAccountId: null,
        excludeAccountIds: undefined,
        messageCount: midStreamRetry.messageCount,
        fullMessageCount: midStreamRetry.fullMessageCount,
        toolsCount: midStreamRetry.toolsCount,
        requestPersonalizationInstruction: midStreamRetry.requestPersonalizationInstruction,
        requestSignal: c.req.raw.signal,
      });

      if ("error" in newStreamResult) {
        // Retry failed, return original error
        logger.error("[chat] non-stream: auto-retry failed to acquire stream", {
          error: newStreamResult.error?.message,
          completionId,
        });
        return sendOpenAIError(c, newStreamResult.error);
      }

      console.log(`🔄 [Chat] Auto-retry | ${newStreamResult.activeAccountLabel} | ${body.model} | chat=${newStreamResult.uiSessionId.substring(0, 12)} | reason=malformed_tool_calls`);

      // Process the new stream (recursive call with retry disabled)
      return processNonStreamingResponse({
        ...params,
        stream: newStreamResult.stream,
        uiSessionId: newStreamResult.uiSessionId,
        activeAccountId: newStreamResult.activeAccountId,
        activeAccountLabel: newStreamResult.activeAccountLabel,
        midStreamRetry: undefined, // Prevent infinite retry loop
        onStreamComplete: () => {
          newStreamResult.releaseAccountLease();
          onStreamComplete?.();
        },
      });
    }

    // Check for malformed tool calls and inject error feedback
    if (toolParser && toolParser.getMalformedToolCalls().length > 0) {
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
        errorMessage = `\n\n⚠️ [TOOL CALL ERROR] ${malformedCount} tool call(s) used undeclared tool names: ${undeclaredNames.join(", ")}. Only declared tools can be executed. Please retry with valid tool names.${toolsHint}\n\n`;
      } else {
        errorMessage = `\n\n⚠️ [TOOL CALL ERROR] ${malformedCount} tool call(s) were malformed and could not be executed. The JSON was invalid or the tool call was truncated. Please retry the tool call with valid JSON.${toolsHint}\n\n`;
      }

      finalContent += errorMessage;
      if (message.content) {
        message.content += errorMessage;
      } else {
        message.content = errorMessage;
      }

      logger.debug("[chat] non-stream: injected malformed tool call error feedback", {
        malformedCount,
        undeclaredNames,
        completionId,
      });

      toolParser.clearMalformedToolCalls();
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
      context: tokenEstimationContext,
    });

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

  // Pre-read initial bytes to detect upstream error before committing to SSE
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
    if (hasSseProtocolStart(trimmedInitialBuffer)) {
      break;
    }
    if (
      Buffer.byteLength(initialStreamBuffer, "utf8") >
      MAX_INITIAL_PROTOCOL_BYTES
    ) {
      await streamReader.cancel().catch(() => undefined);
      throw toRetryableStreamError(
        "non_sse_response",
        "Qwen did not start an SSE response before the protocol probe limit.",
      );
    }
  }

  const upstreamError = parseQwenErrorPayload(initialStreamBuffer);
  if (upstreamError) {
    await streamReader.cancel().catch(() => undefined);
    removeStream(completionId);
    if (onStreamComplete) onStreamComplete();
    throwParsedUpstreamError(upstreamError);
  }

    // Detect first-chunk SSE error BEFORE committing to SSE so outer retry loop can run
    const earlySseError = parseSseErrorFromBuffer(initialStreamBuffer);
    if (earlySseError) {
      await streamReader.cancel().catch(() => undefined);
      removeStream(completionId);
      if (onStreamComplete) onStreamComplete();
      throwFromSseUpstreamError(earlySseError.code, earlySseError.details);
    }

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

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
    let currentUiSessionId = retryContext.uiSessionId;
    let currentAccountId = retryContext.activeAccountId;
    let currentAccountLabel = retryContext.activeAccountLabel;

    const abortHandler = async () => {
      if (clientDisconnected) return;
      clientDisconnected = true;

      console.log(
        `🔌 [Chat] Client disconnected | ${completionId} | stopping Qwen generation`,
      );

      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] stream: client disconnected", {
          completionId,
          uiSessionId: currentUiSessionId,
        });
      }

      try {
        const streamData = getStream(completionId);
        if (streamData && currentUiSessionId) {
          const targetResponseId = streamData.targetResponseId;
          if (targetResponseId) {
            console.log(
              `🛑 [Chat] Stopping Qwen generation | session=${currentUiSessionId} | response=${targetResponseId}`,
            );
            await fetch(
              `https://chat.qwen.ai/api/v2/chat/completions/stop?chat_id=${currentUiSessionId}`,
              {
                method: "POST",
                headers: buildQwenRequestHeaders({
                  cookie: streamData.headers.cookie,
                  userAgent: streamData.headers["user-agent"],
                  bxUa: streamData.headers["bx-ua"],
                  bxUmidtoken: streamData.headers["bx-umidtoken"],
                  bxV: streamData.headers["bx-v"],
                  chatSessionId: currentUiSessionId,
                }),
                body: JSON.stringify({
                  chat_id: currentUiSessionId,
                  response_id: targetResponseId,
                }),
              },
            ).catch((err) => {
              console.error(
                `❌ [Chat] Stop failed | ${err.message}`,
              );
            });
          } else {
            console.log(
              `⏭️  [Chat] Skip Qwen stop | ${completionId} | no response_id yet`,
            );
          }
        }

        try {
          streamData?.abortController.abort();
        } catch (abortErr: any) {
          if (abortErr.name !== "AbortError") {
            console.error(
              `❌ [Chat] Abort stream failed | ${abortErr.message}`,
            );
          }
        }
      } catch (err: any) {
        console.error(
          `❌ [Chat] Disconnect cleanup failed | ${err.message}`,
        );
      }

      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
      }
      removeStream(completionId);
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
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
      if (writeBuffer) {
        const data = writeBuffer;
        writeBuffer = '';
        streamWriter.write(data);
      }
    };

    try {
      await streamWriter.write(": heartbeat\n\n");

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
        writeBuffer += data;
        if (writeBuffer.length >= WRITE_FLUSH_BYTES) {
          flushWrites();
        } else if (!writeTimer) {
          writeTimer = setTimeout(flushWrites, WRITE_FLUSH_MS);
        }
      };

      // Batch buffer: when non-null, writeEvent accumulates instead of flushing
      let flushBuffer: string[] | null = null;

      const writeEvent = async (data: any) => {
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

      // Initial role chunk
      await writeEvent({
        id: completionId,
        object: "chat.completion.chunk",
        created: createdTimestamp,
        model: body.model,
        choices: [makeChoice({ role: "assistant", content: "" })],
      });

      let reader: ReadableStreamDefaultReader<Uint8Array> = streamReader;
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
      const toolParser = shouldParseToolCalls
        ? new StreamingToolParser(declaredTools, {
            incrementalToolCalls: true,
          })
        : null;

      let buffer = initialStreamBuffer;
      const usageAccumulator = createUsageAccumulator(0);
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
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: body.model,
            choices: [makeChoice({ content: textChunk })],
          });
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
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
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



      // Main SSE reader loop
      while (true) {
        if (clientDisconnected) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] stream: breaking loop - client disconnected");
          }
          break;
        }

        if (!buffer.includes("\n")) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
        }

        let lineStart = 0;
        let lineEnd = buffer.indexOf("\n", lineStart);

        for (; lineEnd !== -1; lineEnd = buffer.indexOf("\n", lineStart)) {
          const line = buffer.slice(lineStart, lineEnd);
          lineStart = lineEnd + 1;
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const dataStr = trimmed.slice(5).trimStart();
          if (dataStr === "[DONE]") {
            if (!clientDisconnected) {
              await streamWriter.write("data: [DONE]\n\n");
            }
            break; // Exit loop immediately - no need to wait for connection close
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
              if (vStr && vStr !== "FINISHED") {
                lastRawContent = result.matchedContent;
                lastRawContentLength = result.contentLength;
                lastRawContentSuffix = result.contentSuffix;
                await emitAnswerText(vStr);
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
                        // Next turn must parent to this assistant response (append, not edit)
                        rememberParent(chunk["response.created"].response_id);
                      } else if (chunk.response_id && !targetResponseId) {
                        targetResponseId = chunk.response_id;
                        if (targetResponseId) {
                          updateStreamTargetResponseId(completionId, targetResponseId);
                        }
                        rememberParent(chunk.response_id);
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
                emittedModelOutput = true;
                reasoningBuffer += vStr;
                await writeEvent({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created: createdTimestamp,
                  model: body.model,
                  choices: [makeChoice({ reasoning_content: vStr })],
                });
              } else {
                await emitAnswerText(vStr);
              }
            }
          } catch (_e) {
            if (
              _e instanceof RetryableQwenStreamError &&
              retryContext.retriesLeft > 0 &&
              midStreamRetry &&
              !emittedModelOutput
            ) {
              const policy = classifyRetryAction(_e);
              if (policy.retryable) {
                retryContext.retriesLeft--;
                console.warn(
                  `[Chat] Stream mid-stream error, retrying transparently | reason=${policy.reason} | ${_e.message?.substring(0, 150)} | retries left: ${retryContext.retriesLeft}`,
                );

                if (policy.accountCooldownMs || policy.accountCooldownReason) {
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

                const switchAccount = policy.switchAccount;
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
                  allowThreadReuse: midStreamRetry.allowThreadReuse,
                  forceNewChat: forceRetryNewChat || switchAccount,
                  preferredAccountId: switchAccount ? null : currentAccountId,
                  excludeAccountIds: switchAccount
                    ? [currentAccountId]
                    : undefined,
                  messageCount: needsFullPrompt
                    ? midStreamRetry.fullMessageCount
                    : midStreamRetry.messageCount,
                  fullMessageCount: midStreamRetry.fullMessageCount,
                  toolsCount: midStreamRetry.toolsCount,
                  requestPersonalizationInstruction:
                    midStreamRetry.requestPersonalizationInstruction,
                  requestSignal: c.req.raw.signal,
                  allowTemporarilyBusyAccountId: currentAccountId,
                });

                if ("error" in newStreamResult) {
                  console.error(
                    `[Chat] Transparent retry failed to acquire stream | ${newStreamResult.error?.message || "unknown error"}`,
                  );
                  throw newStreamResult.error ?? _e;
                }

                console.log(
                  `🔄 [Chat] Transparent retry acquired stream | ${newStreamResult.activeAccountLabel} | ${body.model} | chat=${newStreamResult.uiSessionId.substring(0, 12)}`,
                );

                const newEntry = getStream(newStreamResult.completionId);
                removeStream(newStreamResult.completionId);
                if (newEntry) {
                  registerStream(completionId, {
                    ...newEntry,
                    targetResponseId: "",
                  });
                }

                currentAccountId = newStreamResult.activeAccountId;
                currentAccountLabel = newStreamResult.activeAccountLabel;
                currentUiSessionId = newStreamResult.uiSessionId;
                retryContext.releaseAccountLease =
                  newStreamResult.releaseAccountLease;
                targetResponseId = null;
                lastThinkingSummary = "";
                lastThinkingSummaryLength = 0;
                lastThinkingSummarySuffix = "";
                lastRawContent = "";
                lastRawContentLength = 0;
                lastRawContentSuffix = "";
                Object.assign(usageAccumulator, createUsageAccumulator(0));
                buffer = "";

                console.log(
                  `🔄 [Chat] Transparent retry switching reader | old=${currentUiSessionId} | new=${newStreamResult.uiSessionId.substring(0, 12)}`,
                );
                reader = newStreamResult.stream.getReader();

                console.log(
                  `🔄 [Chat] Transparent retry ready to continue`,
                );
                continue;
              }
            }

            if (_e instanceof RetryableQwenStreamError) {
              throw _e;
            }
            // Ignore partial chunk parse errors.
          }
        }

        buffer = lineStart > 0 ? buffer.slice(lineStart) : buffer;
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

      // Finish reason + usage + [DONE]
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
        created: createdTimestamp,
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
          created: createdTimestamp,
          model: body.model,
          choices: [],
          usage,
        });
      }

      if (!clientDisconnected) {
        // Auto-retry if all tool calls were malformed (no successful tool calls)
        // Only retry if we haven't emitted any content to the client yet
        const allToolsFailed = toolParser && toolParser.getMalformedToolCalls().length > 0 && toolParser.getEmittedToolCallCount() === 0;
        if (allToolsFailed && config.retry.autoRetryMalformedTools !== false && midStreamRetry && !emittedModelOutput) {
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

          logger.warn("[chat] stream: auto-retrying malformed tool calls", {
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

          // Acquire new stream for retry
          const newStreamResult = await acquireUpstreamStream({
            finalPrompt: retryPrompt,
            fullPrompt: retryPrompt,
            isThinkingModel: midStreamRetry.isThinkingModel,
            model: body.model,
            contextModelId: midStreamRetry.contextModelId,
            shouldResetUpstreamThread: true,
            allFiles: midStreamRetry.allFiles,
            isNewSession: midStreamRetry.isNewSession,
            sessionId: midStreamRetry.sessionId,
            useThreadNative: midStreamRetry.useThreadNative,
            updateLogicalThread: midStreamRetry.updateLogicalThread,
            allowThreadReuse: midStreamRetry.allowThreadReuse,
            forceNewChat: true,
            preferredAccountId: null,
            excludeAccountIds: undefined,
            messageCount: midStreamRetry.messageCount,
            fullMessageCount: midStreamRetry.fullMessageCount,
            toolsCount: midStreamRetry.toolsCount,
            requestPersonalizationInstruction: midStreamRetry.requestPersonalizationInstruction,
            requestSignal: c.req.raw.signal,
          });

          if ("error" in newStreamResult) {
            // Retry failed, log and fall through to error injection
            logger.error("[chat] stream: auto-retry failed to acquire stream", {
              error: newStreamResult.error?.message,
              completionId,
            });
          } else {
            console.log(`🔄 [Chat] Auto-retry | ${newStreamResult.activeAccountLabel} | ${body.model} | chat=${newStreamResult.uiSessionId.substring(0, 12)} | reason=malformed_tool_calls`);

            // Read from new stream and continue writing to the same streamWriter
            const retryReader = newStreamResult.stream.getReader();
            const retryDecoder = new TextDecoder();
            let retryBuffer = "";

            while (true) {
              const { done, value } = await retryReader.read();
              if (done) break;

              retryBuffer += retryDecoder.decode(value, { stream: true });
              let lineStart = 0;
              let lineEnd = retryBuffer.indexOf("\n", lineStart);

              for (; lineEnd !== -1; lineEnd = retryBuffer.indexOf("\n", lineStart)) {
                const line = retryBuffer.slice(lineStart, lineEnd);
                lineStart = lineEnd + 1;
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith("data:")) continue;

                const dataStr = trimmed.slice(5).trimStart();
                if (dataStr === "[DONE]") continue;

                // Forward the chunk to the client
                await streamWriter.write(`data: ${dataStr}\n\n`);
              }

              retryBuffer = lineStart > 0 ? retryBuffer.slice(lineStart) : retryBuffer;
            }

            // Update state for cleanup
            currentUiSessionId = newStreamResult.uiSessionId;
            currentAccountId = newStreamResult.activeAccountId;
            currentAccountLabel = newStreamResult.activeAccountLabel;
            retryContext.releaseAccountLease = newStreamResult.releaseAccountLease;

            // Skip error injection since we successfully retried
            toolParser.clearMalformedToolCalls();
          }
        }

        // Check for malformed tool calls and inject error feedback
        if (toolParser && toolParser.getMalformedToolCalls().length > 0) {
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
            errorMessage = `\n\n⚠️ [TOOL CALL ERROR] ${malformedCount} tool call(s) used undeclared tool names: ${undeclaredNames.join(", ")}. Only declared tools can be executed. Please retry with valid tool names.${toolsHint}\n\n`;
          } else {
            errorMessage = `\n\n⚠️ [TOOL CALL ERROR] ${malformedCount} tool call(s) were malformed and could not be executed. The JSON was invalid or the tool call was truncated. Please retry the tool call with valid JSON.${toolsHint}\n\n`;
          }

          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: body.model,
            choices: [makeChoice({ content: errorMessage })],
          });

          logger.debug("[chat] stream: injected malformed tool call error feedback", {
            malformedCount,
            undeclaredNames,
            completionId,
          });

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
          context: tokenEstimationContext,
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

      flushWrites();

      c.req.raw.signal.removeEventListener("abort", abortHandler);
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
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
    const errorCode = (err as any).upstreamCode || (err as any).code || "stream_error";
    const errorType = (err as any).type || "upstream_error";

    if (retryable) {
      logger.warn("[Chat] Stream ended after retryable error (no more retries)", {
        code: errorCode,
        message: err.message?.substring(0, 200),
        completionId,
      });
    } else {
      logger.error("[Chat] Stream callback error", {
        error: err.message,
        completionId,
      });
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
  if (classified.statusCode >= 500) {
    metrics.increment("requests.errors");
  }

  const message = err instanceof Error ? err.message : String(err);
  const code = classified.code || "unknown";
  const status = classified.statusCode;
  console.error(`❌ [Chat] Error | ${status} ${code} | ${message}`);

  return sendOpenAIError(c, err);
}
