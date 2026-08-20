import { config, type ChatMode } from "../../core/config.ts";
import { ContextLengthExceededError, ValidationError } from "../../core/errors.ts";
import { getModelContextWindow } from "../../core/model-registry.ts";
import {
  assertPromptWithinLimits,
  isRequestPersonalizationWithinLimit,
} from "../../core/prompt-limits.ts";
import type { Message } from "../../utils/types.ts";
import { estimateTokenCount } from "../../utils/context-truncation.ts";
import { deriveSessionId } from "../../utils/session-id.ts";
import { getLogicalThreadState } from "../../services/qwen.ts";

export { estimateTokenCount, getModelContextWindow, deriveSessionId };

export interface FinalContext {
  finalPrompt: string;
  sessionId: string | null;
  existingThread: boolean;
  shouldResetUpstreamThread: boolean;
  isNewSession: boolean;
  useThreadNative: boolean;
  updateLogicalThread: boolean;
  chatMode: ChatMode;
  isThinkingModel: boolean;
  estimatedTokens: number;
  modelContextWindow: number;
  isTitleGenerationRequest: boolean;
  requestPersonalizationInstruction: string | null;
  hasExplicitConversationKey: boolean;
  allowThreadReuse: boolean;
}

export interface BuildContextParams {
  messages: Message[];
  systemPrompt: string;
  toolInstructions: string;
  prompt: string;
  currentPrompt: string;
  modelId: string;
  enableThinking: boolean;
  conversationKey: string | null;
  hasExplicitConversationKey: boolean;
  chatMode?: ChatMode;
}

export async function buildFinalContext(
  params: BuildContextParams,
): Promise<FinalContext> {
  const {
    messages,
    systemPrompt,
    toolInstructions,
    prompt,
    currentPrompt,
    modelId,
    enableThinking,
    conversationKey,
    hasExplicitConversationKey,
    chatMode = "thread",
  } = params;

  const modelContextWindow = getModelContextWindow(modelId);
  const useThreadNative = true;
  const isTempMode = chatMode === "temp";
  // A continuation is ANY evidence of a prior turn, not just a plain
  // role:"assistant" message. Tool-loop clients (Zed/Cline) can send history
  // with tool/function responses or assistant tool_calls but WITHOUT a plain
  // assistant entry; misclassifying those as a new session forced the FULL
  // history to be re-sent on every request (and every chat_in_progress retry)
  // instead of the thread-native delta.
  // In temp mode EVERY request is a new (ephemeral) chat, so the whole history
  // is always sent and no thread state is ever consulted.
  const isNewSession = isTempMode
    ? true
    : !messages.some(isContinuationMessage);
  const completeInstructions = [systemPrompt.trim(), toolInstructions.trim()]
    .filter(Boolean)
    .join("\n\n");

  // Thread reuse is allowed when:
  // 1. Thread-native mode is active
  // 2. Either: explicit session_id/conversation_id was provided
  //    OR: this is a continuation (has assistant messages in history)
  // This prevents new IDE chats from accidentally reusing old Qwen chats
  // while still allowing continuations without explicit session_id
  const allowThreadReuse = isTempMode
    ? false
    : useThreadNative && (hasExplicitConversationKey || !isNewSession); // has assistant messages = continuation of existing chat

  // Compute sessionId: only generate a persistent session ID when we have
  // an explicit conversation key. Otherwise, generate an ephemeral ID for
  // logging/metrics only (not used for thread reuse). Temp mode never persists
  // a thread, so it has no session id.
  const sessionId = isTempMode
    ? null
    : (conversationKey || useThreadNative)
      ? deriveSessionId(
          messages,
          conversationKey ? completeInstructions : "",
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
  // Temp mode: always send the FULL history (OpenAI standard).
  const activePrompt = isTempMode
    ? prompt
    : (!existingThread && !hasTrailingToolResult ? prompt : currentPrompt) ||
      prompt;
  const isTitleGenerationRequest = detectTitleGenerationRequest(messages);
  const requestedPersonalization =
    config.qwen.personalizationFromRequest && !isTitleGenerationRequest;
  const personalizationInstruction = completeInstructions;
  const useRequestPersonalization =
    requestedPersonalization &&
    isRequestPersonalizationWithinLimit(personalizationInstruction);

  // Agent instructions and tools ride ONLY the account-level personalization
  // (confirmed before the completion request is sent — the real Qwen client
  // also never sends a system prompt in the completions payload). When the
  // channel cannot carry them, fail loud instead of degrading to inline.
  if (completeInstructions && !useRequestPersonalization) {
    if (requestedPersonalization) {
      throw new ContextLengthExceededError(
        `System instructions and tools (${Buffer.byteLength(personalizationInstruction, "utf8")} bytes) exceed the personalization payload limit (${config.qwen.maxPersonalizationBytes} bytes) and are no longer sent inline. Raise QWEN_MAX_PERSONALIZATION_BYTES or reduce the instruction size.`,
      );
    }
    if (!isTitleGenerationRequest) {
      throw new ValidationError(
        "Agent instructions can only be delivered via Qwen account personalization, but QWEN_PERSONALIZATION_FROM_REQUEST is disabled. Re-enable it or remove the system instructions from the request.",
      );
    }
  }
  const estimatedTokens = estimateTokenCount(
    completeInstructions,
    activePrompt,
  );
  // Instructions are delivered exclusively via account-level personalization;
  // the prompt carries only the conversation. Title generation does not sync
  // personalization, so it keeps its (small) instructions inline.
  const finalPrompt =
    isTitleGenerationRequest && completeInstructions
      ? `${completeInstructions}\n${activePrompt}`
      : activePrompt;

  // Truncation is deferred to tryCreateStreamWithRetry, which runs after the
  // account is selected and the real model context window has been synced from
  // Qwen's /api/models catalog. The early context build only performs the byte
  // limit check; the authoritative token check happens downstream.
  assertPromptWithinLimits(finalPrompt, modelId, { checkModelContext: false });

  const isThinkingModel = enableThinking;
  const shouldResetUpstreamThread = false;

  return {
    finalPrompt,
    sessionId,
    existingThread: !!existingThread,
    shouldResetUpstreamThread,
    isNewSession,
    useThreadNative,
    // Thread state is only persisted in thread mode (temp chats are ephemeral).
    updateLogicalThread: isTempMode ? false : useThreadNative,
    chatMode,
    isThinkingModel,
    estimatedTokens,
    modelContextWindow,
    isTitleGenerationRequest,
    requestPersonalizationInstruction: useRequestPersonalization
      ? personalizationInstruction
      : null,
    hasExplicitConversationKey,
    allowThreadReuse,
  };
}

function isContinuationMessage(message: Message): boolean {
  return (
    message.role === "assistant" ||
    message.role === "tool" ||
    message.role === "function" ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
  );
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

  // The first pattern is strictly subsumed by the second (which does not
  // require the leading verb), so it is redundant and was removed.
  return (
    /\btitle\b[\s\S]{0,80}\bconversation\b/.test(text) ||
    /\bconversation\b[\s\S]{0,80}\btitle\b/.test(text)
  );
}
