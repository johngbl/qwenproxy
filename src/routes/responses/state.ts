import type { ResponsesResponse } from "./types.ts";

// ============ State management for previous_response_id ============
//
// The Responses API supports stateful conversations via `previous_response_id`.
// We store completed responses in memory (with optional SQLite persistence)
// so that subsequent requests can reconstruct the message history.
//
// This is intentionally simple: we store the full output + original input
// messages so we can replay them as Chat Completions history.

export interface StoredResponse {
  response: ResponsesResponse;
  /** The full list of Chat Completions messages sent to the upstream for this response */
  chatMessages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }>;
  /** Timestamp of storage */
  storedAt: number;
}

// In-memory store (responseId → StoredResponse)
const store = new Map<string, StoredResponse>();

// Max entries to prevent memory bloat
const MAX_STORE_SIZE = 10000;
// Max age (ms) - 24 hours
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Store a completed response for future `previous_response_id` lookups.
 */
export function storeResponse(
  responseId: string,
  response: ResponsesResponse,
  chatMessages: StoredResponse["chatMessages"],
): void {
  // Evict old entries if at capacity
  if (store.size >= MAX_STORE_SIZE) {
    const oldest = [...store.entries()]
      .sort((a, b) => a[1].storedAt - b[1].storedAt)
      .slice(0, Math.floor(MAX_STORE_SIZE * 0.1));
    for (const [key] of oldest) {
      store.delete(key);
    }
  }

  store.set(responseId, {
    response,
    chatMessages,
    storedAt: Date.now(),
  });
}

/**
 * Retrieve stored history for a `previous_response_id`.
 * Returns null if not found.
 */
export function getResponseHistory(
  previousResponseId: string,
): StoredResponse["chatMessages"] | null {
  const entry = store.get(previousResponseId);
  if (!entry) return null;

  // Check age
  if (Date.now() - entry.storedAt > MAX_AGE_MS) {
    store.delete(previousResponseId);
    return null;
  }

  return entry.chatMessages;
}

/**
 * Retrieve the full stored response (for GET /v1/responses/:id).
 * Returns null if not found.
 */
export function getStoredResponse(
  responseId: string,
): ResponsesResponse | null {
  const entry = store.get(responseId);
  if (!entry) return null;

  if (Date.now() - entry.storedAt > MAX_AGE_MS) {
    store.delete(responseId);
    return null;
  }

  return entry.response;
}

/**
 * Delete a stored response.
 */
export function deleteStoredResponse(responseId: string): boolean {
  return store.delete(responseId);
}

/**
 * Check if a previous_response_id exists in our store.
 */
export function hasResponse(previousResponseId: string): boolean {
  const entry = store.get(previousResponseId);
  if (!entry) return false;
  if (Date.now() - entry.storedAt > MAX_AGE_MS) {
    store.delete(previousResponseId);
    return false;
  }
  return true;
}

/**
 * Get store size (for metrics/debugging).
 */
export function getStoreSize(): number {
  return store.size;
}

/**
 * Clear all stored responses.
 */
export function clearStore(): void {
  store.clear();
}

/**
 * Iterate all stored response IDs (for debugging).
 */
export function listStoredResponseIds(): string[] {
  return [...store.keys()];
}

// Periodic cleanup (every 10 minutes)
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startPeriodicCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      for (const [key, value] of store) {
        if (now - value.storedAt > MAX_AGE_MS) {
          store.delete(key);
        }
      }
    },
    10 * 60 * 1000,
  );
  // Allow process to exit even if interval is active
  if (
    cleanupInterval &&
    typeof cleanupInterval === "object" &&
    "unref" in cleanupInterval
  ) {
    (cleanupInterval as NodeJS.Timeout).unref();
  }
}

export function stopPeriodicCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
