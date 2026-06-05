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
import { getLogicalThreadState } from "../../services/qwen.ts";

export {
  estimateTokenCount,
  getModelContextWindow,
  deriveSessionId,
  detectTopicChange,
};

export interface FinalContext {
  finalPrompt: string;
  sessionId: string | null;
  topicAnalysis: TopicAnalysis | null;
  shouldResetUpstreamThread: boolean;
  isNewSession: boolean;
  useThreadNative: boolean;
  updateLogicalThread: boolean;
  isThinkingModel: boolean;
  estimatedTokens: number;
  modelContextWindow: number;
}

export interface BuildContextParams {
  messages: Message[];
  systemPrompt: string;
  prompt: string;
  currentPrompt: string;
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
    currentPrompt,
    modelId,
    enableThinking,
    conversationKey,
    isInternalSummarizationRequest,
  } = params;

  const modelContextWindow = getModelContextWindow(modelId);
  const useThreadNative =
    !isInternalSummarizationRequest && config.context.mode === "thread-native";
  const activePrompt = useThreadNative ? currentPrompt || prompt : prompt;
  const estimatedTokens = estimateTokenCount(systemPrompt + activePrompt);

  const sessionId =
    !isInternalSummarizationRequest && (conversationKey || useThreadNative)
      ? deriveSessionId(
          messages,
          conversationKey ? systemPrompt : "",
          conversationKey ?? "implicit-thread",
        )
      : null;

  const existingThread = useThreadNative
    ? getLogicalThreadState(sessionId)
    : null;
  const isTitleGenerationRequest = detectTitleGenerationRequest(messages);
  const updateLogicalThread = !(isTitleGenerationRequest && !!existingThread);
  const shouldSendInstructions =
    !useThreadNative || !existingThread?.instructionsSent;

  const cache = getCache();
  const topicAnalysis =
    cache && sessionId
      ? await detectTopicChange(messages, sessionId, cache).catch(() => null)
      : null;

  const summarizationTriggerTokens = Math.floor(modelContextWindow * 0.9);

  let finalPrompt: string;
  if (!useThreadNative && estimatedTokens > summarizationTriggerTokens) {
    const truncated = await truncateMessages(messages, {
      maxContextLength: modelContextWindow,
      systemPrompt,
      enableSummarization:
        !isInternalSummarizationRequest && config.context.summarization.enabled,
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
    finalPrompt =
      shouldSendInstructions && systemPrompt
        ? `${systemPrompt}\n${activePrompt}`
        : activePrompt;
  }

  const isThinkingModel = enableThinking;
  const isNewSession = !messages.some((m) => m.role === "assistant");
  const shouldResetUpstreamThread = useThreadNative
    ? false
    : isNewSession || topicAnalysis?.hasChanged === true;

  return {
    finalPrompt,
    sessionId,
    topicAnalysis,
    shouldResetUpstreamThread,
    isNewSession,
    useThreadNative,
    updateLogicalThread,
    isThinkingModel,
    estimatedTokens,
    modelContextWindow,
  };
}

function extractMessageText(message: Message | undefined): string {
  if (!message) return "";
  const content: unknown = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part?.type === "text" ? part.text || "" : ""))
      .join("\n");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

function detectTitleGenerationRequest(messages: Message[]): boolean {
  if (messages.length < 2) return false;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return false;

  const text = extractMessageText(last).toLowerCase();
  if (!text) return false;

  return (
    /\b(generate|create|suggest|write)\b[\s\S]{0,80}\btitle\b[\s\S]{0,80}\bconversation\b/.test(
      text,
    ) ||
    /\btitle\b[\s\S]{0,80}\bconversation\b/.test(text) ||
    /\bconversation\b[\s\S]{0,80}\btitle\b/.test(text)
  );
}
