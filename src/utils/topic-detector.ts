import { createHash } from "crypto";
import type { Message } from "./types.js";
import type { MemoryCache } from "../cache/memory-cache.js";
import { config } from "../core/config.js";
import { metrics } from "../core/metrics.js";
import { Logger } from "../core/logger.js";

const logger = new Logger("info", "TopicDetector");

export interface TopicAnalysis {
  hasChanged: boolean;
  confidence: number;
  previousTopic?: string;
  currentTopic?: string;
}

interface CachedTopic {
  topic: string;
  keywords: string[];
  updatedAt: number;
}

// Explicit topic-transition phrases
const TRANSITION_PATTERNS: RegExp[] = [
  /\b(mudando de assunto|novo tópico|nova pergunta|outra coisa|esquece|esqueça|deixa pra lá|deixa isso|falando agora)\b/i,
  /\b(new topic|different subject|change of topic|moving on|forget about|never mind|let.s switch|on another note)\b/i,
];

// Common stopwords stripped during keyword extraction
const STOPWORDS = new Set([
  "a",
  "o",
  "e",
  "de",
  "da",
  "do",
  "em",
  "um",
  "uma",
  "os",
  "as",
  "dos",
  "das",
  "que",
  "se",
  "com",
  "por",
  "para",
  "no",
  "na",
  "nos",
  "nas",
  "ao",
  "aos",
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "is",
  "it",
  "this",
  "that",
  "was",
  "are",
  "be",
  "has",
  "had",
  "have",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "can",
  "may",
  "might",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "me",
  "my",
  "your",
  "our",
  "their",
  "como",
  "qual",
  "quando",
  "onde",
  "quem",
  "por que",
  "what",
  "when",
  "where",
  "who",
  "how",
  "why",
  "which",
  "muito",
  "muitos",
  "pouco",
  "mais",
  "menos",
  "também",
  "ainda",
  "já",
  "só",
  "não",
  "sim",
  "ok",
  "please",
  "thanks",
]);

/**
 * Derive a deterministic session ID from a caller-provided key plus the
 * conversation's anchoring content.
 */
export function deriveSessionId(
  messages: Message[],
  systemPrompt: string = "",
  sessionKey?: string,
): string {
  const firstUser = messages.find((m) => m.role === "user");
  const anchor = [
    sessionKey?.trim(),
    systemPrompt.trim(),
    extractTextContent(firstUser),
  ]
    .filter((part) => part && part.length > 0)
    .join("|");
  const hash = createHash("sha256").update(anchor).digest("hex").slice(0, 16);
  return `sess_${hash}`;
}

/**
 * Detect whether the conversation topic has changed compared to the cached state.
 */
export async function detectTopicChange(
  messages: Message[],
  sessionId: string,
  cache: MemoryCache,
): Promise<TopicAnalysis> {
  if (!config.topicDetection.enabled || messages.length === 0) {
    return { hasChanged: false, confidence: 0 };
  }

  const lastUserMsg = findLastUserMessage(messages);
  if (!lastUserMsg) {
    return { hasChanged: false, confidence: 0 };
  }

  const currentText = extractTextContent(lastUserMsg);
  if (!currentText.trim()) {
    return { hasChanged: false, confidence: 0 };
  }

  const currentKeywords = extractKeywords(currentText);
  const cacheKey = `topic:${sessionId}` as const;

  // Check for explicit transition phrases first (highest confidence signal)
  const transitionMatch = detectKeywordTransition(currentText);
  if (transitionMatch) {
    const analysis = await handleTopicChange(
      cache,
      cacheKey,
      currentText,
      currentKeywords,
      0.95,
    );
    return analysis;
  }

  // Load cached topic state
  const cached = await cache.get<CachedTopic>(cacheKey);
  if (!cached) {
    // First interaction for this session
    await cache.set<CachedTopic>(
      cacheKey,
      {
        topic: currentText.slice(0, 200),
        keywords: currentKeywords,
        updatedAt: Date.now(),
      },
      3600,
    );
    return {
      hasChanged: false,
      confidence: 0,
      currentTopic: currentText.slice(0, 200),
    };
  }

  // Compare keyword overlap using Jaccard similarity
  const similarity = computeSimilarity(cached.keywords, currentKeywords);
  const changeConfidence = 1 - similarity;

  const threshold = config.topicDetection.confidence;
  if (changeConfidence >= threshold) {
    return handleTopicChange(
      cache,
      cacheKey,
      currentText,
      currentKeywords,
      changeConfidence,
      cached.topic,
      cached.keywords,
    );
  }

  // Topic continues
  const merged = mergeKeywords(cached.keywords, currentKeywords);
  await cache.set<CachedTopic>(
    cacheKey,
    {
      topic: cached.topic,
      keywords: merged,
      updatedAt: Date.now(),
    },
    3600,
  );

  return {
    hasChanged: false,
    confidence: changeConfidence,
    previousTopic: cached.topic,
    currentTopic: cached.topic,
  };
}

async function handleTopicChange(
  cache: MemoryCache,
  cacheKey: `topic:${string}`,
  currentText: string,
  currentKeywords: string[],
  confidence: number,
  previousTopic?: string,
  _previousKeywords?: string[],
): Promise<TopicAnalysis> {
  const newTopic = currentText.slice(0, 200);

  // Invalidate cached responses for this session
  const sessionId = cacheKey.replace("topic:", "");
  const invalidated = await cache.invalidateBySession(sessionId);

  // Store new topic state
  await cache.set<CachedTopic>(
    cacheKey,
    {
      topic: newTopic,
      keywords: currentKeywords,
      updatedAt: Date.now(),
    },
    3600,
  );

  metrics.increment("topic.change.detected");
  logger.debug("Topic change detected", {
    sessionId,
    confidence,
    invalidated,
    previousTopic: previousTopic?.slice(0, 80),
    newTopic: newTopic.slice(0, 80),
  });

  return {
    hasChanged: true,
    confidence,
    previousTopic,
    currentTopic: newTopic,
  };
}

function findLastUserMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i];
  }
  return undefined;
}

function extractTextContent(msg: Message | undefined): string {
  if (!msg || !msg.content) return "";
  if (typeof msg.content === "string") return msg.content;

  // Handle multimodal content (array of parts)
  const content = msg.content as any;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text || "")
      .join(" ");
  }
  return "";
}

function extractKeywords(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\sà-ú]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

  // Deduplicate preserving order
  return [...new Set(normalized)];
}

/**
 * Jaccard similarity coefficient between two keyword sets.
 * Returns 0.0 (completely different) to 1.0 (identical).
 */
function computeSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function detectKeywordTransition(text: string): boolean {
  return TRANSITION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Merge old and new keywords, keeping the most recent terms.
 */
function mergeKeywords(oldKw: string[], newKw: string[]): string[] {
  const merged = [...new Set([...oldKw, ...newKw])];
  return merged.slice(-50);
}
