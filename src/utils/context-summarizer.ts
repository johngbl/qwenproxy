import { Message } from "./types.ts";
import { config } from "../core/config.ts";
import { estimateTokenCount } from "./context-truncation.ts";

export interface SummarizationResult {
  summary: string;
  originalTokens: number;
  summaryTokens: number;
  compressionRatio: number;
  latencyMs: number;
  error?: string;
}

const SUMMARIZATION_PROMPT = `Summarize the following conversation, preserving:
1. Key decisions made
2. Important code snippets or file paths mentioned
3. Current task or problem being solved
4. Unresolved questions

Keep the summary concise (max 200 tokens) but information-dense.

Conversation:
`;

export async function summarizeMessages(
  messages: Message[],
  options?: {
    model?: string;
    maxSummaryTokens?: number;
    timeout?: number;
    systemPromptOverride?: string;
    purpose?: "rollover" | "truncation";
  },
): Promise<SummarizationResult> {
  const startTime = Date.now();
  const model = options?.model || config.context.summarization.model;
  const maxTokens = options?.maxSummaryTokens || 200;
  const timeout = options?.timeout || config.context.summarization.timeout;
  const systemPrompt = options?.systemPromptOverride || SUMMARIZATION_PROMPT;

  // Build conversation text
  const conversationText = messages
    .map((msg) => {
      const content = Array.isArray(msg.content)
        ? msg.content.map((c: any) => c.text || JSON.stringify(c)).join("\n")
        : typeof msg.content === "object"
          ? JSON.stringify(msg.content)
          : msg.content || "";
      return `${msg.role}: ${content}`;
    })
    .join("\n\n");

  const originalTokens = estimateTokenCount(conversationText);

  // Self-loop: call /v1/chat/completions endpoint
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const apiKey = process.env.API_KEY || config.apiKey;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Summarization": "true",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(
      `http://localhost:${config.server.port}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: conversationText,
            },
          ],
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: controller.signal,
      },
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `Summarization API error: ${response.status} ${errorBody.substring(0, 300)}`,
      );
    }

    const result = await response.json();
    const summary =
      result.choices?.[0]?.message?.content ||
      "[Summary unavailable - truncated]";
    const summaryTokens = estimateTokenCount(summary);
    const latencyMs = Date.now() - startTime;

    return {
      summary,
      originalTokens,
      summaryTokens,
      compressionRatio: originalTokens / Math.max(summaryTokens, 1),
      latencyMs,
    };
  } catch (error: any) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Fallback: return error summary
    return {
      summary: "[Summary unavailable - truncated]",
      originalTokens,
      summaryTokens: estimateTokenCount("[Summary unavailable - truncated]"),
      compressionRatio: 0,
      latencyMs,
      error: errorMessage,
    };
  }
}
