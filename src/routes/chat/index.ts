/*
 * File: index.ts
 * Project: QwenBridge
 *
 * Thin orchestrator for chat completions. Delegates to specialized modules:
 * - validation.ts: request parsing
 * - context.ts: prompt building and topic analysis
 * - account.ts: upstream stream acquisition with failover
 * - streaming.ts: response processing (SSE/JSON)
 */

import { Context } from "hono";
import { parseRequestBody } from "./validation.ts";
import { buildFinalContext } from "./context.ts";
import { acquireUpstreamStream, acquireChatLock } from "./account.ts";
import {
  processNonStreamingResponse,
  processStreamingResponse,
  handleChatCompletionsError,
  type AssistantCompleteEvent,
} from "./streaming.ts";
import { config } from "../../core/config.ts";
import { logger } from "../../core/logger.ts";
import {
  getLogicalThreadState,
  RetryableQwenStreamError,
} from "../../services/qwen.ts";
import { classifyRetryAction } from "./retry-policy.ts";



function formatTimingHeader(timings: Record<string, number>): string {
  return Object.entries(timings)
    .map(([key, value]) => `${key}=${Math.max(0, Math.round(value))}`)
    .join(";");
}

export async function chatCompletions(c: Context) {
  let releaseChatLock: (() => void) | null = null;
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const mark = (name: string, since: number) => {
    timings[name] = Date.now() - since;
  };

  try {
    let stepStartedAt = Date.now();
    const parsed = await parseRequestBody(c);
    mark("parse", stepStartedAt);
    const {
      body,
      isStream,
      systemPrompt,
      prompt,
      currentPrompt,
      modelId,
      enableThinking,
      allFiles,
      currentFiles,
      shouldParseToolCalls,
      conversationKey,
    } = parsed;

    const messages = body.messages || [];
    const declaredTools = Array.isArray((body as any).tools)
      ? (body as any).tools
      : [];

    stepStartedAt = Date.now();
    const ctx = await buildFinalContext({
      messages,
      systemPrompt,
      prompt,
      currentPrompt,
      modelId,
      enableThinking,
      conversationKey,
      hasExplicitConversationKey: parsed.hasExplicitConversationKey,
    });
    mark("context", stepStartedAt);

    // Acquire per-chat lock to prevent concurrent requests to the same Qwen chat
    // Only lock when we have an explicit conversation key (allowThreadReuse)
    stepStartedAt = Date.now();
    if (ctx.allowThreadReuse && ctx.sessionId) {
      const existingThread = getLogicalThreadState(ctx.sessionId);
      const chatId = existingThread?.chatSessionId;
      if (chatId) {
        releaseChatLock = await acquireChatLock(chatId);
      }
    }
    mark("lock", stepStartedAt);

    let finalPrompt = ctx.finalPrompt;
    mark("thread", stepStartedAt);

    const files = ctx.useThreadNative ? currentFiles : allFiles;

    const msgCount =
      ctx.useThreadNative && !ctx.isNewSession
        ? parsed.currentMessageCount
        : parsed.messageCount;

    const personalizationChars =
      ctx.requestPersonalizationInstruction?.length ?? 0;
    console.log(
      `📤 [Chat] Request | ${body.model} | ${msgCount} msg(s) | ${finalPrompt.length} chars${declaredTools.length ? ` | ${declaredTools.length} tool(s)` : ""}${files.length ? ` | ${files.length} file(s)` : ""}`,
    );
    logger.debug("[chat] request routing details", {
      model: body.model,
      messages: msgCount,
      promptChars: finalPrompt.length,
      tools: declaredTools.length,
      files: files.length,
      personalizationChars,
      sessionId: ctx.sessionId,
      useThreadNative: ctx.useThreadNative,
      isNewSession: ctx.isNewSession,
      hasExplicitConversationKey: ctx.hasExplicitConversationKey,
      allowThreadReuse: ctx.allowThreadReuse,
      sessionIdentitySource: parsed.hasExplicitConversationKey
        ? typeof body.session_id === "string" &&
          body.session_id.trim().length > 0
          ? "session_id"
          : "conversation_id"
        : ctx.isNewSession
          ? "none-new-chat"
          : "implicit-continuation",
    });

    stepStartedAt = Date.now();
    // fullPrompt always carries system + full conversation history so account
    // failover / forceNewChat can rebuild upstream context without deltas only.
    const fullPromptForRequest = ctx.requestPersonalizationInstruction
      ? parsed.prompt
      : parsed.systemPrompt + parsed.prompt;

    let streamResult = await acquireUpstreamStream({
      finalPrompt,
      fullPrompt: fullPromptForRequest,
      isThinkingModel: ctx.isThinkingModel,
      model: body.model,
      shouldResetUpstreamThread: ctx.shouldResetUpstreamThread,
      allFiles: files,
      isNewSession: ctx.isNewSession,
      sessionId: ctx.sessionId,
      useThreadNative: ctx.useThreadNative,
      updateLogicalThread: ctx.updateLogicalThread,
      allowThreadReuse: ctx.allowThreadReuse,
      forceNewChat: false,
      preferredAccountId: undefined,
      messageCount: msgCount,
      fullMessageCount: parsed.messageCount,
      toolsCount: declaredTools.length || undefined,
      requestPersonalizationInstruction: ctx.requestPersonalizationInstruction,
    });



    mark("upstream", stepStartedAt);
    timings.preResponse = Date.now() - startedAt;
    c.header("X-QwenBridge-Timing", formatTimingHeader(timings));

    if ("error" in streamResult) {
      // Release per-chat lock on error (no stream to complete)
      if (releaseChatLock) {
        releaseChatLock();
        releaseChatLock = null;
      }
      if (streamResult.allOnCooldown) {
        const err: any = new Error(
          `All configured accounts are on cooldown. Retry in about ${Math.max(
            1,
            Math.ceil((streamResult.retryAfterMs ?? 0) / 1000),
          )}s.`,
        );
        err.upstreamStatus = 429;
        throw err;
      }
      throw streamResult.error || new Error("All accounts failed");
    }

    console.log(
      `🚀 [Chat] Request routed | ${streamResult.activeAccountLabel} | ${body.model} | ${msgCount} msg(s) | ${finalPrompt.length} chars${declaredTools.length ? ` | ${declaredTools.length} tool(s)` : ""}${files.length ? ` | ${files.length} file(s)` : ""}`,
    );

    const onAssistantComplete: ((event: AssistantCompleteEvent) => Promise<void> | void) | undefined = undefined;

    const params = {
      c,
      completionId: streamResult.completionId,
      stream: streamResult.stream,
      uiSessionId: streamResult.uiSessionId,
      activeAccountId: streamResult.activeAccountId,
      activeAccountLabel: streamResult.activeAccountLabel,
      logicalSessionId: streamResult.logicalSessionId,
      body,
      finalPrompt,
      userPrompt: currentPrompt || prompt,
      shouldParseToolCalls,
      declaredTools,
      tokenEstimationContext: streamResult.tokenEstimationContext,
      onAssistantComplete,
      onStreamComplete: () => {
        if (releaseChatLock) {
          releaseChatLock();
          releaseChatLock = null;
        }
      },
    };

    // Retry loop for mid-stream/create-stream failures (generic policy)
        let streamProcessingRetries = Math.max(0, config.retry.maxAttempts - 1);
        let currentStreamResult = streamResult;
        let currentParams = params;

        while (true) {
          try {
            return isStream
              ? await processStreamingResponse(currentParams)
              : await processNonStreamingResponse(currentParams);
          } catch (streamErr: any) {
            const policy = classifyRetryAction(streamErr);

            // Prefer explicit RetryableQwenStreamError OR generic retryable policy
            const canRetry =
              streamProcessingRetries > 0 &&
              policy.retryable &&
              (streamErr instanceof RetryableQwenStreamError ||
                config.retry.onUnknownUpstream !== false);

            if (!canRetry) {
              throw streamErr;
            }

            streamProcessingRetries--;
            console.warn(
              `[Chat] Stream processing error, retrying with new stream | reason=${policy.reason} | ${streamErr.message?.substring(0, 150)} | retries left: ${streamProcessingRetries}`,
            );

            const switchAccount = policy.switchAccount;
            const forceRetryNewChat = policy.forceNewChat;
            const retryWithFullPrompt = policy.retryWithFullPrompt;

            // Mark current account for cooldown when policy requests it
            if (policy.accountCooldownMs || policy.accountCooldownReason) {
              const { markAccountRateLimited } =
                await import("../../core/account-manager.ts");
              markAccountRateLimited(
                currentStreamResult.activeAccountId,
                policy.accountCooldownMs,
                policy.accountCooldownReason || "StreamRetry",
              );
            }

            // Release current chat lock
            if (releaseChatLock) {
              releaseChatLock();
              releaseChatLock = null;
            }

            // Account switch always rebuilds full history; same-account retry
            // only does so when the policy asks for forceNewChat/full prompt.
            const needsFullPromptOnRetry =
              retryWithFullPrompt || switchAccount || forceRetryNewChat;
            const retryFinalPrompt = needsFullPromptOnRetry
              ? fullPromptForRequest
              : finalPrompt;
            const retryMessageCount = needsFullPromptOnRetry
              ? parsed.messageCount
              : msgCount;

            if (forceRetryNewChat || switchAccount) {
              console.warn(
                `[Chat] Retry will force a new upstream chat and resend full context | ${streamErr.message?.substring(0, 150)}`,
              );
            }
            if (switchAccount) {
              console.warn(
                `[Chat] Retry will prefer another account when available | ${streamErr.message?.substring(0, 150)}`,
              );
            }

            if (policy.retryAfterMs > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(policy.retryAfterMs, 3000)),
              );
            }

            // Re-acquire stream with different account or a fresh upstream chat
            const newStreamResult = await acquireUpstreamStream({
              finalPrompt: retryFinalPrompt,
              fullPrompt: fullPromptForRequest,
              isThinkingModel: ctx.isThinkingModel,
              model: body.model,
              shouldResetUpstreamThread: ctx.shouldResetUpstreamThread,
              allFiles: files,
              isNewSession: ctx.isNewSession,
              sessionId: ctx.sessionId,
              useThreadNative: ctx.useThreadNative,
              updateLogicalThread: ctx.updateLogicalThread,
              allowThreadReuse: ctx.allowThreadReuse,
              forceNewChat:
                forceRetryNewChat || switchAccount,
              preferredAccountId: switchAccount
                ? null
                : currentStreamResult.activeAccountId,
              excludeAccountIds: switchAccount
                ? [currentStreamResult.activeAccountId]
                : undefined,
              messageCount: retryMessageCount,
              fullMessageCount: parsed.messageCount,
              toolsCount: declaredTools.length || undefined,
              requestPersonalizationInstruction:
                ctx.requestPersonalizationInstruction,
            });

            if ("error" in newStreamResult) {
              // Can't get new stream, fail with original error
              throw streamErr;
            }

            console.log(
              `🔄 [Chat] Request routed | ${newStreamResult.activeAccountLabel} | ${body.model} | ${retryMessageCount} msg(s) | ${retryFinalPrompt.length} chars${declaredTools.length ? ` | ${declaredTools.length} tool(s)` : ""}${files.length ? ` | ${files.length} file(s)` : ""} | retry`,
            );

            // Re-acquire chat lock for new stream
            if (ctx.allowThreadReuse && ctx.sessionId) {
              const existingThread = getLogicalThreadState(ctx.sessionId);
              const chatId = existingThread?.chatSessionId;
              if (chatId) {
                releaseChatLock = await acquireChatLock(chatId);
              }
            }

            currentStreamResult = newStreamResult;
            currentParams = {
              c,
              completionId: newStreamResult.completionId,
              stream: newStreamResult.stream,
              uiSessionId: newStreamResult.uiSessionId,
              activeAccountId: newStreamResult.activeAccountId,
              activeAccountLabel: newStreamResult.activeAccountLabel,
              logicalSessionId: newStreamResult.logicalSessionId,
              body,
              finalPrompt: retryFinalPrompt,
              userPrompt: currentPrompt || prompt,
              shouldParseToolCalls,
              declaredTools,
              tokenEstimationContext: newStreamResult.tokenEstimationContext,
              onAssistantComplete,
              onStreamComplete: () => {
                if (releaseChatLock) {
                  releaseChatLock();
                  releaseChatLock = null;
                }
              },
            };
            continue;
          }
        }
  } catch (err) {
    timings.preResponse = Date.now() - startedAt;
    c.header("X-QwenBridge-Timing", formatTimingHeader(timings));
    if (releaseChatLock) {
      releaseChatLock();
      releaseChatLock = null;
    }
    return handleChatCompletionsError(c, err);
  } finally {
    // Lock released via onStreamComplete when stream finishes
  }
}

export { chatCompletionsStop } from "./stop.ts";
