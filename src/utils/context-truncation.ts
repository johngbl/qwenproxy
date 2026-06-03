import { Message } from './types.ts';
import { summarizeMessages } from './context-summarizer.ts';

export enum MessagePriority {
  SYSTEM = 0,
  RECENT_USER = 1,
  TOOL_CALLS = 2,
  ASSISTANT = 3,
  OLDER_MESSAGES = 4,
}

export interface TruncatedMessage {
  role: string;
  content: string;
}

export interface PrioritizedMessage extends TruncatedMessage {
  priority: MessagePriority;
  tokens: number;
  isSummarized?: boolean;
}

export interface TruncationOptions {
  maxContextLength: number;
  systemPrompt?: string;
  enableSummarization?: boolean;
  summarizationModel?: string;
  minMessagesToKeep?: number;
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function normalizeMessageContent(content: string | null | any[]): string {
  if (Array.isArray(content)) {
    return content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
  } else if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }
  return content || '';
}

function calculatePriorityScore(
  msg: Message,
  index: number,
  totalMessages: number,
): MessagePriority {
  // System messages always highest priority
  if (msg.role === 'system') return MessagePriority.SYSTEM;

  // Recent user messages (last 3)
  if (msg.role === 'user' && index >= totalMessages - 3) {
    return MessagePriority.RECENT_USER;
  }

  // Tool calls and results (last 5)
  if (
    (msg.role === 'tool' || (msg as any).tool_calls) &&
    index >= totalMessages - 5
  ) {
    return MessagePriority.TOOL_CALLS;
  }

  // Assistant messages (last 5)
  if (msg.role === 'assistant' && index >= totalMessages - 5) {
    return MessagePriority.ASSISTANT;
  }

  // Everything else is older content
  return MessagePriority.OLDER_MESSAGES;
}

export async function truncateMessages(
  messages: Message[],
  options: TruncationOptions,
): Promise<PrioritizedMessage[]> {
  const { maxContextLength, systemPrompt = '', enableSummarization, minMessagesToKeep = 10 } = options;

  const systemTokens = estimateTokenCount(systemPrompt);
  const availableTokens = maxContextLength - systemTokens - 500;

  if (availableTokens <= 0) {
    return [
      {
        role: 'user',
        content: systemPrompt,
        priority: MessagePriority.SYSTEM,
        tokens: systemTokens,
      },
    ];
  }

  // Summarize older messages if enabled and threshold exceeded
  let summaryMessage: PrioritizedMessage | null = null;
  let messagesToProcess = messages;

  if (enableSummarization && messages.length > minMessagesToKeep) {
    const olderMessages = messages.slice(0, messages.length - minMessagesToKeep);
    const recentMessages = messages.slice(messages.length - minMessagesToKeep);

    try {
      const result = await summarizeMessages(olderMessages, {
        model: options.summarizationModel,
      });

      if (result.summary && !result.summary.startsWith('[Summary unavailable')) {
        summaryMessage = {
          role: 'system',
          content: `[Context Summary]\n${result.summary}`,
          priority: MessagePriority.SYSTEM,
          tokens: result.summaryTokens,
          isSummarized: true,
        };
        messagesToProcess = recentMessages;
      }
    } catch (error) {
      // Summarization failed, continue without summary
    }
  }

  // Normalize and score all messages
  const scoredMessages = messagesToProcess.map((msg, index) => {
    const content = normalizeMessageContent(msg.content);
    const tokens = estimateTokenCount(content);
    const priority = calculatePriorityScore(msg, index, messages.length);

    return {
      role: msg.role,
      content,
      priority,
      tokens,
      originalIndex: index,
    };
  });

  // Allocate tokens by priority tier
  const allocations = {
    [MessagePriority.SYSTEM]: 1.0,
    [MessagePriority.RECENT_USER]: 0.4,
    [MessagePriority.TOOL_CALLS]: 0.3,
    [MessagePriority.ASSISTANT]: 0.2,
    [MessagePriority.OLDER_MESSAGES]: 0.1,
  };

  const result: PrioritizedMessage[] = [];
  const usedTokensByPriority = new Map<MessagePriority, number>();

  // Prepend summary if available
  if (summaryMessage) {
    result.push(summaryMessage);
  }

  // Process messages in reverse order (newest first)
  for (let i = scoredMessages.length - 1; i >= 0; i--) {
    const msg = scoredMessages[i];
    const priorityLimit = Math.floor(availableTokens * allocations[msg.priority]);
    const usedForPriority = usedTokensByPriority.get(msg.priority) || 0;

    if (usedForPriority + msg.tokens <= priorityLimit) {
      result.unshift({
        role: msg.role,
        content: msg.content,
        priority: msg.priority,
        tokens: msg.tokens,
      });
      usedTokensByPriority.set(msg.priority, usedForPriority + msg.tokens);
    } else {
      // Truncate or skip based on remaining budget
      const remainingTokens = priorityLimit - usedForPriority;
      if (remainingTokens > 100) {
        const truncatedContent = msg.content.slice(0, Math.floor(remainingTokens * 3.5));
        result.unshift({
          role: msg.role,
          content: `[Truncated] ${truncatedContent}...`,
          priority: msg.priority,
          tokens: remainingTokens,
        });
        usedTokensByPriority.set(msg.priority, priorityLimit);
      }
    }
  }

  // Fallback: ensure at least one message if result is empty
  if (result.length === 0 && scoredMessages.length > 0) {
    const lastMsg = scoredMessages[scoredMessages.length - 1];
    const truncatedContent = lastMsg.content.slice(0, Math.max(200, Math.floor(availableTokens * 3.5)));
    result.push({
      role: lastMsg.role,
      content: `[Truncated] ${truncatedContent}...`,
      priority: lastMsg.priority,
      tokens: estimateTokenCount(truncatedContent),
    });
  }

  return result;
}
