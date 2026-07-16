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
  deleteQwenChat,
  getLogicalThreadState,
  RetryableQwenStreamError,
} from "../../services/qwen.ts";
import { isAuthMockEnabled } from "../../services/auth-playwright.ts";
import { enqueueThreadContextSummary } from "../../services/thread-context-jobs.ts";
import {
  finalizeThreadContextRolloverSuccess,
  markThreadContextRolloverStarted,
  prepareThreadContextRollover,
  type ThreadContextRolloverPlan,
} from "../../services/thread-context-rollover.ts";
import {
  saveThreadContextCompletion,
  setThreadContextStatus,
  upsertThreadContextSession,
} from "../../services/thread-context-store.ts";
import {
  summarizeLargePayload,
  rebuildPromptWithSummary,
  truncateMessages,
} from "../../services/payload-summarizer.ts";

async function reducePromptForRetry(
  messages: Array<{ role: string; content: any }>,
  systemPrompt: string,
  model: string,
): Promise<string | null> {
  try {
    if (messages.length > 2) {
      const result = await summarizeLargePayload(messages, model);
      if (result) {
        const keepCount = Math.min(2, messages.length);
        const recentMessages = messages.slice(messages.length - keepCount);
        const prompt = rebuildPromptWithSummary(
          systemPrompt,
          recentMessages,
          result.summary,
        );
        console.log(
          `📝 [Chat] Reduced prompt via summarization: ${result.originalChars} → ${result.summaryChars} chars`,
        );
        return prompt;
      }
    }

    // Fallback: truncate individual messages
    const truncated = truncateMessages(messages);
    const truncatedText = truncated
      .map((msg: any) => {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .map((p: any) => p.text || JSON.stringify(p))
                  .join("\n")
              : JSON.stringify(msg.content);
        return `${msg.role}: ${content}`;
      })
      .join("\n\n");
    const prompt = systemPrompt
      ? `${systemPrompt}\n\n${truncatedText}`
      : truncatedText;
    console.warn(
      `⚠️  [Chat] Reduced prompt via truncation: ${messages.length} messages → ${prompt.length} chars`,
    );
    return prompt;
  } catch (err) {
    console.warn(
      `❌ [Chat] Failed to reduce prompt: ${(err as Error).message}`,
    );
    return null;
  }
}

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
      isInternalSummarizationRequest,
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
      isInternalSummarizationRequest,
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

    // Thread context management should run for ALL requests in thread-native mode
    // This ensures the first turn is saved and thread context is properly managed
    const shouldManageThreadContext =
      ctx.useThreadNative &&
      !ctx.isAuxiliaryRequest &&
      !!ctx.sessionId &&
      config.context.threadNative.persistenceEnabled &&
      !isAuthMockEnabled();

    let finalPrompt = ctx.finalPrompt;
    let activeRolloverPlan: ThreadContextRolloverPlan | null = null;

    stepStartedAt = Date.now();
    if (shouldManageThreadContext && ctx.sessionId) {
      upsertThreadContextSession({
        sessionId: ctx.sessionId,
        model: body.model,
        modelContextWindow: ctx.modelContextWindow,
        systemPrompt,
      });

      const prepared = await prepareThreadContextRollover({
        sessionId: ctx.sessionId,
        finalPrompt,
        currentPrompt: currentPrompt || prompt,
        systemPrompt,
        skipRollover: ctx.isAuxiliaryRequest,
      });
      finalPrompt = prepared.finalPrompt;
      activeRolloverPlan = prepared.rollover;
    }
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
    let streamResult = await acquireUpstreamStream({
      finalPrompt,
      fullPrompt: ctx.requestPersonalizationInstruction
        ? parsed.prompt
        : parsed.systemPrompt + parsed.prompt,
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
        activeRolloverPlan !== null || isInternalSummarizationRequest,
      preferredAccountId: activeRolloverPlan?.preferredAccountId ?? null,
      messageCount: msgCount,
      fullMessageCount: parsed.messageCount,
      toolsCount: declaredTools.length || undefined,
      requestPersonalizationInstruction: ctx.requestPersonalizationInstruction,
    });

    // TMD retry: if all accounts failed with anti-bot, summarize/truncate and retry
    if (
      "error" in streamResult &&
      streamResult.error?.upstreamCode === "FAIL_SYS_USER_VALIDATE"
    ) {
      console.warn(
        `[Chat] TMD on all accounts; summarizing/truncating prompt and retrying...`,
      );
      const reducedPrompt = await reducePromptForRetry(
        messages,
        systemPrompt,
        body.model,
      );
      if (reducedPrompt && reducedPrompt.length < finalPrompt.length) {
        finalPrompt = reducedPrompt;
        streamResult = await acquireUpstreamStream({
          finalPrompt,
          fullPrompt: finalPrompt,
          isThinkingModel: ctx.isThinkingModel,
          model: body.model,
          shouldResetUpstreamThread: ctx.shouldResetUpstreamThread,
          allFiles: files,
          isNewSession: ctx.isNewSession,
          sessionId: ctx.sessionId,
          useThreadNative: ctx.useThreadNative,
          updateLogicalThread: ctx.updateLogicalThread,
          allowThreadReuse: ctx.allowThreadReuse,
          forceNewChat: true,
          preferredAccountId: null,
          messageCount: msgCount,
          fullMessageCount: parsed.messageCount,
          toolsCount: declaredTools.length || undefined,
          requestPersonalizationInstruction:
            ctx.requestPersonalizationInstruction,
        });
      }
    }

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
      if (activeRolloverPlan) {
        setThreadContextStatus(
          activeRolloverPlan.sessionId,
          "error",
          streamResult.error instanceof Error
            ? streamResult.error.message
            : "Rollover stream acquisition failed",
        );
      }
      throw streamResult.error || new Error("All accounts failed");
    }

    console.log(
      `🚀 [Chat] Request routed | ${streamResult.activeAccountLabel} | ${body.model} | ${msgCount} msg(s) | ${finalPrompt.length} chars${declaredTools.length ? ` | ${declaredTools.length} tool(s)` : ""}${files.length ? ` | ${files.length} file(s)` : ""}`,
    );

    if (activeRolloverPlan) {
      activeRolloverPlan = markThreadContextRolloverStarted({
        plan: activeRolloverPlan,
        toAccountId: streamResult.activeAccountId,
        toChatId: streamResult.uiSessionId,
      });
    }

    const onAssistantComplete = shouldManageThreadContext
      ? async (event: AssistantCompleteEvent) => {
          if (!event.sessionId || !event.chatSessionId) return;

          const savedSession = saveThreadContextCompletion({
            sessionId: event.sessionId,
            model: body.model,
            modelContextWindow: ctx.modelContextWindow,
            accountId: event.accountId,
            chatSessionId: event.chatSessionId,
            parentId: event.parentId,
            responseId: event.responseId,
            userPrompt: event.userPrompt,
            finalPrompt: event.finalPrompt,
            assistantContent: event.assistantContent,
            usage: event.usage,
            finishReason: event.finishReason,
            resetThreadEstimate: activeRolloverPlan !== null,
            metadata: {
              rolloverId: activeRolloverPlan?.rolloverId ?? null,
              rolloverReason: activeRolloverPlan?.reason ?? null,
              reasoningCharacters: event.reasoningContent?.length ?? 0,
            },
          });

          if (
            activeRolloverPlan &&
            (event.responseId || event.assistantContent.trim().length > 0)
          ) {
            await finalizeThreadContextRolloverSuccess(activeRolloverPlan);
          }

          // Background summaries disabled — only summarize at rollover limit
          // enqueueThreadContextSummary(
          //   savedSession.sessionId,
          //   "assistant_complete",
          // );
        }
      : isInternalSummarizationRequest
        ? async (event: AssistantCompleteEvent) => {
            if (!event.chatSessionId) return;
            try {
              await deleteQwenChat(
                event.chatSessionId,
                event.accountId && event.accountId !== "global"
                  ? event.accountId
                  : undefined,
              );
              console.log(
                `[ThreadContext] Summary chat deleted | ${event.chatSessionId}`,
              );
            } catch (error) {
              logger.warn(
                "[thread-context] failed to delete auxiliary summary chat",
                {
                  chatSessionId: event.chatSessionId,
                  accountId: event.accountId,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
            }
          }
        : undefined;

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

    // Retry loop for stream processing errors (quota/anti-bot during SSE)
    let streamProcessingRetries = 2;
    let currentStreamResult = streamResult;
    let currentParams = params;

    while (true) {
      try {
        return isStream
          ? await processStreamingResponse(currentParams)
          : await processNonStreamingResponse(currentParams);
      } catch (streamErr: any) {
        // Only retry RetryableQwenStreamError (quota/anti-bot during stream)
        if (
          streamProcessingRetries > 0 &&
          streamErr instanceof RetryableQwenStreamError
        ) {
          streamProcessingRetries--;
          console.warn(
            `[Chat] Stream processing error, retrying with new stream | ${streamErr.message?.substring(0, 150)} | retries left: ${streamProcessingRetries}`,
          );

          const switchAccount = Boolean(
                      (streamErr as { switchAccount?: boolean }).switchAccount,
                    );
                    const errCode =
                      (streamErr as { upstreamCode?: string }).upstreamCode || "";

                    // Mark current account for cooldown on account-scoped errors
                    if (
                      streamErr.message?.includes("quota") ||
                      errCode === "quota_limit" ||
                      streamErr.message?.includes("alta demanda") ||
                      streamErr.message?.includes("high demand")
                    ) {
                      const { markAccountRateLimited } =
                        await import("../../core/account-manager.ts");
                      markAccountRateLimited(
                        currentStreamResult.activeAccountId,
                        undefined,
                        errCode === "quota_limit" ? "QuotaLimit" : "QuotaExceeded",
                      );
                    }

                    // Release current chat lock
                    if (releaseChatLock) {
                      releaseChatLock();
                      releaseChatLock = null;
                    }

                    const fullPromptForRetry = ctx.requestPersonalizationInstruction
                      ? parsed.prompt
                      : parsed.systemPrompt + parsed.prompt;
                    const forceRetryNewChat = Boolean(
                      (streamErr as { forceNewChat?: boolean }).forceNewChat,
                    );
                    const retryFinalPrompt = (
                      streamErr as { retryWithFullPrompt?: boolean }
                    ).retryWithFullPrompt
                      ? fullPromptForRetry
                      : finalPrompt;
                    const retryMessageCount = (
                      streamErr as { retryWithFullPrompt?: boolean }
                    ).retryWithFullPrompt
                      ? parsed.messageCount
                      : msgCount;

                    if (forceRetryNewChat) {
                      console.warn(
                        `[Chat] Retry will force a new upstream chat and resend full context | ${streamErr.message?.substring(0, 150)}`,
                      );
                    }
                    if (switchAccount) {
                      console.warn(
                        `[Chat] Retry will prefer another account when available | ${streamErr.message?.substring(0, 150)}`,
                      );
                    }

                    // Re-acquire stream with different account or a fresh upstream chat
                    const newStreamResult = await acquireUpstreamStream({
                      finalPrompt: retryFinalPrompt,
                      fullPrompt: fullPromptForRetry,
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
                        forceRetryNewChat ||
                        activeRolloverPlan !== null ||
                        isInternalSummarizationRequest,
                      // null => rotate away from sticky account when possible
                      preferredAccountId: switchAccount
                        ? null
                        : (activeRolloverPlan?.preferredAccountId ?? null),
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

        // Not retryable or retries exhausted — propagate error
        throw streamErr;
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
