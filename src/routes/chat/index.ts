/*
 * File: index.ts
 * Project: qproxy
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
} from "./streaming.ts";

export async function chatCompletions(c: Context) {
    try {
        const parsed = await parseRequestBody(c);
        const {
            body,
            isStream,
            systemPrompt,
            prompt,
            modelId,
            enableThinking,
            allFiles,
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
            modelId,
            enableThinking,
            conversationKey,
            isInternalSummarizationRequest,
        });

        const streamResult = await acquireUpstreamStream({
            finalPrompt: ctx.finalPrompt,
            isThinkingModel: ctx.isThinkingModel,
            model: body.model,
            shouldResetUpstreamThread: ctx.shouldResetUpstreamThread,
            allFiles,
            isNewSession: ctx.isNewSession,
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
            throw streamResult.error || new Error("All accounts failed");
        }

        const params = {
            c,
            completionId: streamResult.completionId,
            stream: streamResult.stream,
            uiSessionId: streamResult.uiSessionId,
            activeAccountId: streamResult.activeAccountId,
            body,
            finalPrompt: ctx.finalPrompt,
            shouldParseToolCalls,
            declaredTools,
        };

        return isStream
            ? await processStreamingResponse(params)
            : await processNonStreamingResponse(params);
    } catch (err) {
        return handleChatCompletionsError(c, err);
    }
}

export { chatCompletionsStop } from "./stop.ts";
