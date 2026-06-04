import { Context } from "hono";
import { config } from "../../core/config.ts";
import { getModelContextWindow } from "../../core/model-registry.ts";
import { getCache } from "../../api/server.ts";
import { Message } from "../../utils/types.ts";
import {
    estimateTokenCount,
    truncateMessages,
    PrioritizedMessage,
} from "../../utils/context-truncation.ts";
import {
    deriveSessionId,
    detectTopicChange,
    TopicAnalysis,
} from "../../utils/topic-detector.ts";

export { estimateTokenCount, getModelContextWindow, deriveSessionId, detectTopicChange };

export interface FinalContext {
    finalPrompt: string;
    sessionId: string | null;
    topicAnalysis: TopicAnalysis | null;
    shouldResetUpstreamThread: boolean;
    isNewSession: boolean;
    isThinkingModel: boolean;
    estimatedTokens: number;
    modelContextWindow: number;
}

export interface BuildContextParams {
    messages: Message[];
    systemPrompt: string;
    prompt: string;
    modelId: string;
    enableThinking: boolean;
    conversationKey: string | null;
    isInternalSummarizationRequest: boolean;
}

export async function buildFinalContext(
    params: BuildContextParams,
): Promise<FinalContext> {
    const {
        messages,
        systemPrompt,
        prompt,
        modelId,
        enableThinking,
        conversationKey,
        isInternalSummarizationRequest,
    } = params;

    const modelContextWindow = getModelContextWindow(modelId);
    const estimatedTokens = estimateTokenCount(systemPrompt + prompt);

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

    const isThinkingModel = enableThinking;
    const isNewSession = !messages.some((m) => m.role === "assistant");
    const shouldResetUpstreamThread =
        isNewSession || topicAnalysis?.hasChanged === true;

    return {
        finalPrompt,
        sessionId,
        topicAnalysis,
        shouldResetUpstreamThread,
        isNewSession,
        isThinkingModel,
        estimatedTokens,
        modelContextWindow,
    };
}
