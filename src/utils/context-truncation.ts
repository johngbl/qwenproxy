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
  if (!text) return 0;

  let tokens = 0;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    const codePoint = text.codePointAt(i) || 0;

    // CJK Unified Ideographs (U+4E00-U+9FFF)
    if (codePoint >= 0x4E00 && codePoint <= 0x9FFF) {
      tokens += 1.5;
      i += 1;
    }
    // CJK Extension A/B (U+3400-U+2A6DF)
    else if (codePoint >= 0x3400 && codePoint <= 0x2A6DF) {
      tokens += 1.5;
      i += codePoint > 0xFFFF ? 2 : 1;
    }
    // Hiragana/Katakana (U+3040-U+30FF)
    else if (codePoint >= 0x3040 && codePoint <= 0x30FF) {
      tokens += 1.2;
      i += 1;
    }
    // Hangul (U+AC00-U+D7AF)
    else if (codePoint >= 0xAC00 && codePoint <= 0xD7AF) {
      tokens += 1.3;
      i += 1;
    }
    // ASCII printable (space to ~)
    else if (codePoint >= 0x20 && codePoint <= 0x7E) {
      if (
        char === '{' || char === '}' || char === '[' || char === ']' ||
        char === '"' || char === ':' || char === ',' || char === ';' ||
        char === '(' || char === ')' || char === '/' || char === '\\'
      ) {
        tokens += 0.4;
      } else {
        tokens += 0.25; // Standard English: ~4 chars per token
      }
      i += 1;
    }
    // Newlines and whitespace
    else if (char === '\n' || char === '\r' || char === '\t') {
      tokens += 0.2;
      i += 1;
    }
    // Other Unicode (emoji, symbols, etc.)
    else {
      tokens += 1.0;
      i += codePoint > 0xFFFF ? 2 : 1;
    }
  }

  return Math.ceil(tokens);
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

  // Group messages by priority
  const messagesByPriority = new Map<MessagePriority, typeof scoredMessages>();
  for (const msg of scoredMessages) {
    if (!messagesByPriority.has(msg.priority)) {
      messagesByPriority.set(msg.priority, []);
    }
    messagesByPriority.get(msg.priority)!.push(msg);
  }

  // Phase 1: Allocate up to budget for each priority tier (newest first within tier)
  const allocations = {
    [MessagePriority.SYSTEM]: 1.0,
    [MessagePriority.RECENT_USER]: 0.4,
    [MessagePriority.TOOL_CALLS]: 0.3,
    [MessagePriority.ASSISTANT]: 0.2,
    [MessagePriority.OLDER_MESSAGES]: 0.1,
  };

  const allocated = new Map<MessagePriority, typeof scoredMessages>();
  const usedTokensByPriority = new Map<MessagePriority, number>();
  let totalUsedTokens = 0;

  const priorityOrder = [
    MessagePriority.SYSTEM,
    MessagePriority.RECENT_USER,
    MessagePriority.TOOL_CALLS,
    MessagePriority.ASSISTANT,
    MessagePriority.OLDER_MESSAGES,
  ];

  for (const priority of priorityOrder) {
    const msgs = messagesByPriority.get(priority) || [];
    const budget = Math.floor(availableTokens * allocations[priority]);
    const allocatedMsgs: typeof scoredMessages = [];
    let usedTokens = 0;

    // Process newest first within priority tier
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (usedTokens + msg.tokens <= budget) {
        allocatedMsgs.unshift(msg);
        usedTokens += msg.tokens;
      } else {
        break; // Stop when budget exhausted
      }
    }

    allocated.set(priority, allocatedMsgs);
    usedTokensByPriority.set(priority, usedTokens);
    totalUsedTokens += usedTokens;
  }

  // Phase 2: Redistribute unused budget to lower priorities
  let remainingBudget = availableTokens - totalUsedTokens;
  if (remainingBudget > 0) {
    for (const priority of [MessagePriority.ASSISTANT, MessagePriority.TOOL_CALLS, MessagePriority.OLDER_MESSAGES]) {
      if (remainingBudget <= 0) break;

      const msgs = messagesByPriority.get(priority) || [];
      const allocatedMsgs = allocated.get(priority) || [];
      const allocatedIndices = new Set(allocatedMsgs.map(m => m.originalIndex));

      // Add unallocated messages from this priority (newest first)
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (!allocatedIndices.has(msg.originalIndex) && msg.tokens <= remainingBudget) {
          allocatedMsgs.unshift(msg);
          remainingBudget -= msg.tokens;
          totalUsedTokens += msg.tokens;

          if (remainingBudget <= 0) break;
        }
      }

      allocated.set(priority, allocatedMsgs);
    }
  }

  // Build final result in chronological order
  const result: PrioritizedMessage[] = [];

  if (summaryMessage) {
    result.push(summaryMessage);
  }

  // Collect all allocated messages into flat array
  const allAllocated: typeof scoredMessages[number][] = [];
  for (const msgs of allocated.values()) {
    allAllocated.push(...msgs);
  }
  // Sort by originalIndex (chronological order)
  allAllocated.sort((a, b) => a.originalIndex - b.originalIndex);
  // Build final result
  for (const msg of allAllocated) {
    result.push({
      role: msg.role,
      content: msg.content,
      priority: msg.priority,
      tokens: msg.tokens,
    });
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
