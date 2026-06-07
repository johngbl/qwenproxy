import { config } from "../../core/config.ts";
import { getModelContextWindow } from "../../core/model-registry.ts";
import { getCache } from "../../api/server.ts";
import type { Message } from "../../utils/types.ts";
import {
  estimateTokenCount,
  truncateMessages,
  type PrioritizedMessage,
} from "../../utils/context-truncation.ts";
import {
  deriveSessionId,
  detectTopicChange,
  type TopicAnalysis,
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
  isAuxiliaryRequest: boolean;
  isTitleGenerationRequest: boolean;
  requestPersonalizationInstruction: string | null;
  hasExplicitConversationKey: boolean;
  allowThreadReuse: boolean;
}

export interface BuildContextParams {
  messages: Message[];
  systemPrompt: string;
  prompt: string;
  currentPrompt: string;
  modelId: string;
  enableThinking: boolean;
  conversationKey: string | null;
  hasExplicitConversationKey: boolean;
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
    hasExplicitConversationKey,
    isInternalSummarizationRequest,
  } = params;

  const modelContextWindow = getModelContextWindow(modelId);
  const useThreadNative =
    !isInternalSummarizationRequest && config.context.mode === "thread-native";
  const isNewSession = !messages.some((m) => m.role === "assistant");

  // Thread reuse is allowed when:
  // 1. Thread-native mode is active
  // 2. Either: explicit session_id/conversation_id was provided
  //    OR: this is a continuation (has assistant messages in history)
  // This prevents new IDE chats from accidentally reusing old Qwen chats
  // while still allowing continuations without explicit session_id
  const allowThreadReuse =
    useThreadNative && (hasExplicitConversationKey || !isNewSession); // has assistant messages = continuation of existing chat

  // Compute sessionId: only generate a persistent session ID when we have
  // an explicit conversation key. Otherwise, generate an ephemeral ID for
  // logging/metrics only (not used for thread reuse).
  const sessionId =
    !isInternalSummarizationRequest && (conversationKey || useThreadNative)
      ? deriveSessionId(
          messages,
          conversationKey ? systemPrompt : "",
          conversationKey ?? "implicit-thread",
        )
      : null;

  // Only load existing thread when reuse is allowed
  const existingThread = allowThreadReuse
    ? getLogicalThreadState(sessionId)
    : null;

  const hasTrailingToolResult = detectTrailingToolResult(messages);
  // Thread-native: send full history when Qwen has no context yet, but preserve
  // tool-result deltas because the upstream parent chain already owns the call.
  const activePrompt = useThreadNative
    ? (!existingThread && !hasTrailingToolResult ? prompt : currentPrompt) ||
      prompt
    : prompt;
  const isTitleGenerationRequest = detectTitleGenerationRequest(messages);
  const isAuxiliaryRequest =
    isInternalSummarizationRequest || isTitleGenerationRequest;
  const useRequestPersonalization =
    config.qwen.personalizationFromRequest &&
    !isAuxiliaryRequest &&
    systemPrompt.trim().length > 0;
  const estimatedTokens = estimateTokenCount(systemPrompt + activePrompt);
  // Normally, system/tool instructions are prepended to the chat prompt. In the
  // experimental Qwen personalization mode, they are synced to the account-level
  // personalization.instruction instead, so they do not appear as chat content.
  const shouldSendInstructions = !useRequestPersonalization;

  const cache = getCache();
  const topicAnalysis =
    cache && sessionId
      ? await detectTopicChange(messages, sessionId, cache).catch(() => null)
      : null;

  const summarizationTriggerTokens = Math.floor(modelContextWindow * 0.9);

  let finalPrompt: string;
  if (!useThreadNative && estimatedTokens > summarizationTriggerTokens) {
    const truncationMessages = useRequestPersonalization
      ? messages.filter((message) => message.role !== "system")
      : messages;
    const truncated = await truncateMessages(truncationMessages, {
      maxContextLength: modelContextWindow,
      systemPrompt: useRequestPersonalization ? "" : systemPrompt,
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
    // Always update logical thread in thread-native mode (except title generation)
    // This ensures the thread state is saved even for new sessions
    updateLogicalThread: useThreadNative && !isTitleGenerationRequest,
    isThinkingModel,
    estimatedTokens,
    modelContextWindow,
    isAuxiliaryRequest,
    isTitleGenerationRequest,
    requestPersonalizationInstruction: useRequestPersonalization
      ? systemPrompt
      : null,
    hasExplicitConversationKey,
    allowThreadReuse,
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

function detectTrailingToolResult(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role;
    if (role === "system") continue;
    return role === "tool" || role === "function";
  }
  return false;
}

function detectTitleGenerationRequest(messages: Message[]): boolean {
  if (messages.length < 2) return false;
  const last = messages[messages.length - 1];
  if (last?.role !== "user") return false;

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
