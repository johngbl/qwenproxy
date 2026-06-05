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
import { acquireUpstreamStream } from "./account.ts";
import {
  processNonStreamingResponse,
  processStreamingResponse,
  handleChatCompletionsError,
  type AssistantCompleteEvent,
} from "./streaming.ts";
import { config } from "../../core/config.ts";
import { logger } from "../../core/logger.ts";
import { deleteQwenChat } from "../../services/qwen.ts";
import { isAuthMockEnabled } from "../../services/auth-http.ts";
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

export async function chatCompletions(c: Context) {
  try {
    const parsed = await parseRequestBody(c);
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

    const ctx = await buildFinalContext({
      messages,
      systemPrompt,
      prompt,
      currentPrompt,
      modelId,
      enableThinking,
      conversationKey,
      isInternalSummarizationRequest,
    });

    const shouldManageThreadContext =
      ctx.useThreadNative &&
      !ctx.isAuxiliaryRequest &&
      !!ctx.sessionId &&
      config.context.threadNative.persistenceEnabled &&
      !isAuthMockEnabled();

    let finalPrompt = ctx.finalPrompt;
    let activeRolloverPlan: ThreadContextRolloverPlan | null = null;

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

    const streamResult = await acquireUpstreamStream({
      finalPrompt,
      isThinkingModel: ctx.isThinkingModel,
      model: body.model,
      shouldResetUpstreamThread: ctx.shouldResetUpstreamThread,
      allFiles: ctx.useThreadNative ? currentFiles : allFiles,
      isNewSession: ctx.isNewSession,
      sessionId: ctx.sessionId,
      useThreadNative: ctx.useThreadNative,
      updateLogicalThread: ctx.updateLogicalThread,
      forceNewChat:
        activeRolloverPlan !== null || isInternalSummarizationRequest,
      preferredAccountId: activeRolloverPlan?.preferredAccountId ?? null,
    });

    if ("error" in streamResult) {
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

          enqueueThreadContextSummary(
            savedSession.sessionId,
            "assistant_complete",
          );
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
              logger.info("[thread-context] deleted auxiliary summary chat", {
                chatSessionId: event.chatSessionId,
                accountId: event.accountId,
              });
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
      logicalSessionId: streamResult.logicalSessionId,
      body,
      finalPrompt,
      userPrompt: currentPrompt || prompt,
      shouldParseToolCalls,
      declaredTools,
      onAssistantComplete,
    };

    return isStream
      ? await processStreamingResponse(params)
      : await processNonStreamingResponse(params);
  } catch (err) {
    return handleChatCompletionsError(c, err);
  }
}

export { chatCompletionsStop } from "./stop.ts";
