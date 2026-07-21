import type { ResponsesResponse } from "./types.ts";
import { getDatabase } from "../../core/database.ts";

// ============ State management for previous_response_id ============
//
// The Responses API supports stateful conversations via `previous_response_id`.
// We store completed responses in SQLite (durable) with an in-memory LRU cache
// for fast lookups. This ensures memory persists across server restarts.

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

// In-memory LRU cache (responseId → StoredResponse)
const cache = new Map<string, StoredResponse>();
const MAX_CACHE_SIZE = 500;
// Max age (ms) - 7 days for SQLite, 24h for cache
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  try {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS responses_store (
        response_id TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        chat_messages_json TEXT NOT NULL,
        stored_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_responses_store_stored_at
      ON responses_store(stored_at)
    `);
    tableReady = true;
  } catch {
    // Database not available — fall back to memory-only
    tableReady = false;
  }
}

/**
 * Store a completed response for future `previous_response_id` lookups.
 * Persists to SQLite + in-memory cache.
 */
export function storeResponse(
  responseId: string,
  response: ResponsesResponse,
  chatMessages: StoredResponse["chatMessages"],
): void {
  const entry: StoredResponse = {
    response,
    chatMessages,
    storedAt: Date.now(),
  };

  // In-memory cache (LRU eviction)
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = [...cache.entries()]
      .sort((a, b) => a[1].storedAt - b[1].storedAt)
      .slice(0, Math.floor(MAX_CACHE_SIZE * 0.1));
    for (const [key] of oldest) {
      cache.delete(key);
    }
  }
  cache.set(responseId, entry);

  // SQLite persistence
  ensureTable();
  if (tableReady) {
    try {
      const db = getDatabase();
      db.prepare(
        `INSERT OR REPLACE INTO responses_store (response_id, response_json, chat_messages_json, stored_at)
         VALUES (?, ?, ?, ?)`,
      ).run(
        responseId,
        JSON.stringify(response),
        JSON.stringify(chatMessages),
        entry.storedAt,
      );
    } catch {
      // Non-fatal: memory cache still works
    }
  }
}

/**
 * Retrieve stored history for a `previous_response_id`.
 * Returns null if not found.
 */
export function getResponseHistory(
  previousResponseId: string,
): StoredResponse["chatMessages"] | null {
  // Check memory cache first
  const cached = cache.get(previousResponseId);
  if (cached) {
    if (Date.now() - cached.storedAt > CACHE_MAX_AGE_MS) {
      cache.delete(previousResponseId);
    } else {
      return cached.chatMessages;
    }
  }

  // Fall back to SQLite
  ensureTable();
  if (!tableReady) return null;

  try {
    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT chat_messages_json, stored_at FROM responses_store WHERE response_id = ?`,
      )
      .get(previousResponseId) as
      | { chat_messages_json: string; stored_at: number }
      | undefined;

    if (!row) return null;

    if (Date.now() - row.stored_at > MAX_AGE_MS) {
      db.prepare(`DELETE FROM responses_store WHERE response_id = ?`).run(
        previousResponseId,
      );
      return null;
    }

    const chatMessages = JSON.parse(row.chat_messages_json);
    // Re-populate cache
    const responseRow = db
      .prepare(`SELECT response_json FROM responses_store WHERE response_id = ?`)
      .get(previousResponseId) as { response_json: string } | undefined;
    if (responseRow) {
      cache.set(previousResponseId, {
        response: JSON.parse(responseRow.response_json),
        chatMessages,
        storedAt: row.stored_at,
      });
    }

    return chatMessages;
  } catch {
    return null;
  }
}

/**
 * Retrieve the full stored response (for GET /v1/responses/:id).
 * Returns null if not found.
 */
export function getStoredResponse(
  responseId: string,
): ResponsesResponse | null {
  // Check memory cache first
  const cached = cache.get(responseId);
  if (cached) {
    if (Date.now() - cached.storedAt > CACHE_MAX_AGE_MS) {
      cache.delete(responseId);
    } else {
      return cached.response;
    }
  }

  // Fall back to SQLite
  ensureTable();
  if (!tableReady) return null;

  try {
    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT response_json, chat_messages_json, stored_at FROM responses_store WHERE response_id = ?`,
      )
      .get(responseId) as
      | { response_json: string; chat_messages_json: string; stored_at: number }
      | undefined;

    if (!row) return null;

    if (Date.now() - row.stored_at > MAX_AGE_MS) {
      db.prepare(`DELETE FROM responses_store WHERE response_id = ?`).run(
        responseId,
      );
      return null;
    }

    return JSON.parse(row.response_json);
  } catch {
    return null;
  }
}

/**
 * Delete a stored response.
 */
export function deleteStoredResponse(responseId: string): boolean {
  const fromCache = cache.delete(responseId);

  ensureTable();
  if (tableReady) {
    try {
      const db = getDatabase();
      const result = db
        .prepare(`DELETE FROM responses_store WHERE response_id = ?`)
        .run(responseId);
      return fromCache || result.changes > 0;
    } catch {
      return fromCache;
    }
  }

  return fromCache;
}

/**
 * Check if a previous_response_id exists in our store.
 */
export function hasResponse(previousResponseId: string): boolean {
  if (cache.has(previousResponseId)) {
    const entry = cache.get(previousResponseId)!;
    if (Date.now() - entry.storedAt > CACHE_MAX_AGE_MS) {
      cache.delete(previousResponseId);
      return false;
    }
    return true;
  }

  ensureTable();
  if (!tableReady) return false;

  try {
    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT stored_at FROM responses_store WHERE response_id = ? LIMIT 1`,
      )
      .get(previousResponseId) as { stored_at: number } | undefined;
    if (!row) return false;
    if (Date.now() - row.stored_at > MAX_AGE_MS) {
      db.prepare(`DELETE FROM responses_store WHERE response_id = ?`).run(
        previousResponseId,
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get store size (for metrics/debugging).
 */
export function getStoreSize(): number {
  return cache.size;
}

/**
 * Clear all stored responses.
 */
export function clearStore(): void {
  cache.clear();
  ensureTable();
  if (tableReady) {
    try {
      getDatabase().prepare(`DELETE FROM responses_store`).run();
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Iterate all stored response IDs (for debugging).
 */
export function listStoredResponseIds(): string[] {
  return [...cache.keys()];
}

// Periodic cleanup (every 30 minutes — SQLite TTL is 7 days)
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startPeriodicCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      // Clean memory cache
      for (const [key, value] of cache) {
        if (now - value.storedAt > CACHE_MAX_AGE_MS) {
          cache.delete(key);
        }
      }
      // Clean SQLite
      ensureTable();
      if (tableReady) {
        try {
          getDatabase()
            .prepare(`DELETE FROM responses_store WHERE stored_at < ?`)
            .run(now - MAX_AGE_MS);
        } catch {
          // Non-fatal
        }
      }
    },
    30 * 60 * 1000,
  );
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
