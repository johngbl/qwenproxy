import { getDatabase } from "../core/database.ts";
import { logger } from "../core/logger.ts";
import { isAuthMockEnabled } from "./auth-playwright.ts";

interface SessionEntry {
  accountId: string;
  parentId: string | null;
  timestamp: number;
}

export interface LogicalThreadEntry {
  accountId: string;
  chatSessionId: string;
  parentId: string | null;
  instructionsSent: boolean;
  timestamp: number;
}

const sessionStates: Map<string, SessionEntry> =
  (globalThis as any)._sessionStates || new Map();
(globalThis as any)._sessionStates = sessionStates;

// In-memory cache for logical thread states (backed by SQLite)
const logicalThreadStates: Map<string, LogicalThreadEntry> =
  (globalThis as any)._logicalThreadStates || new Map();
(globalThis as any)._logicalThreadStates = logicalThreadStates;

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Debounce window before dirty logical thread states are upserted to SQLite in
 * a single transaction. The tool-call loop calls updateLogicalThreadState on
 * every turn (~30+ synchronous writes per conversation otherwise). The
 * in-memory cache stays the authoritative source within the process, so reads
 * never observe the delay; flushLogicalThreadState() runs on shutdown.
 */
const LOGICAL_THREAD_FLUSH_DELAY_MS = 300;

const logicalThreadDirty: Set<string> =
  (globalThis as any)._logicalThreadDirty || new Set();
(globalThis as any)._logicalThreadDirty = logicalThreadDirty;

// Pending "tool-call cap reached" notices, keyed by logical session id. Set when
// a turn is closed early at the per-turn tool-call cap; consumed by the NEXT
// turn of the same session so the model is told that calls beyond the cap were
// not executed (and it can re-issue them). In-memory only: a restart drops the
// notice, which is acceptable — the model simply continues without the hint.
const toolCapNotices: Map<string, number> =
  (globalThis as any)._toolCapNotices || new Map();
(globalThis as any)._toolCapNotices = toolCapNotices;

/** Record that `logicalSessionId` hit the per-turn tool-call cap this turn. */
export function setToolCapNotice(
  logicalSessionId: string | null | undefined,
): void {
  if (!logicalSessionId) return;
  toolCapNotices.set(logicalSessionId, Date.now());
}

/**
 * Consume (read + clear) the pending tool-cap notice for `logicalSessionId`.
 * Returns true when the previous turn of this session was closed early at the
 * cap, so the caller can inject a notice into the current turn's prompt.
 */
export function consumeToolCapNotice(
  logicalSessionId: string | null | undefined,
): boolean {
  if (!logicalSessionId) return false;
  const ts = toolCapNotices.get(logicalSessionId);
  if (ts === undefined) return false;
  toolCapNotices.delete(logicalSessionId);
  return Date.now() - ts <= SESSION_TTL_MS;
}

let logicalThreadFlushTimer: NodeJS.Timeout | null = null;

function scheduleLogicalThreadFlush(): void {
  if (logicalThreadFlushTimer) return;
  logicalThreadFlushTimer = setTimeout(() => {
    logicalThreadFlushTimer = null;
    flushLogicalThreadState();
  }, LOGICAL_THREAD_FLUSH_DELAY_MS);
  logicalThreadFlushTimer.unref?.();
}

/**
 * Persist every dirty logical thread state to SQLite in one transaction.
 * Exported so the shutdown path can flush before closeDatabase().
 */
export function flushLogicalThreadState(): void {
  if (logicalThreadFlushTimer) {
    clearTimeout(logicalThreadFlushTimer);
    logicalThreadFlushTimer = null;
  }
  if (isAuthMockEnabled()) return;
  if (logicalThreadDirty.size === 0) return;

  try {
    const db = getDatabase();
    const upsert = db.prepare(
      `INSERT INTO logical_thread_states (session_id, account_id, chat_session_id, parent_id, instructions_sent, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET
         account_id = excluded.account_id,
         chat_session_id = excluded.chat_session_id,
         parent_id = excluded.parent_id,
         instructions_sent = excluded.instructions_sent,
         updated_at = datetime('now')`,
    );
    const flush = db.transaction(
      (entries: Array<{
        sessionId: string;
        accountId: string;
        chatSessionId: string;
        parentId: string | null;
        instructionsSent: number;
      }>) => {
        for (const e of entries) {
          upsert.run(
            e.sessionId,
            e.accountId,
            e.chatSessionId,
            e.parentId,
            e.instructionsSent,
          );
        }
      },
    );

    const entries: Array<{
      sessionId: string;
      accountId: string;
      chatSessionId: string;
      parentId: string | null;
      instructionsSent: number;
    }> = [];
    for (const sessionId of logicalThreadDirty) {
      const entry = logicalThreadStates.get(sessionId);
      // Entries evicted from the cache (clearAllSessionsForAccount / TTL) must
      // NOT be resurrected — the deletion already happened in the cache.
      if (!entry || !entry.chatSessionId) continue;
      entries.push({
        sessionId,
        accountId: entry.accountId,
        chatSessionId: entry.chatSessionId,
        parentId: entry.parentId ?? null,
        instructionsSent: entry.instructionsSent ? 1 : 0,
      });
    }

    if (entries.length > 0) flush(entries);
    logicalThreadDirty.clear();
  } catch (err) {
    logger.warn(
      "[Qwen] Failed to batch-persist logical thread states to SQLite",
      {
        count: logicalThreadDirty.size,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    logicalThreadDirty.clear();
  }
}

function cleanupStaleSessions() {
  const now = Date.now();
  for (const [key, entry] of sessionStates.entries()) {
    if (now - entry.timestamp > SESSION_TTL_MS) {
      sessionStates.delete(key);
    }
  }
  // Cleanup stale entries from SQLite
  try {
    const db = getDatabase();
    const cutoff = new Date(now - SESSION_TTL_MS).toISOString();
    db.prepare("DELETE FROM logical_thread_states WHERE updated_at < ?").run(
      cutoff,
    );
  } catch (error) {
    logger.warn("Failed to clean up stale logical thread states", { error });
  }
  for (const [key, entry] of logicalThreadStates.entries()) {
    if (now - entry.timestamp > SESSION_TTL_MS) {
      logicalThreadStates.delete(key);
      logicalThreadDirty.delete(key);
    }
  }
}

export function getLogicalThreadState(
  logicalSessionId: string | null | undefined,
): LogicalThreadEntry | null {
  if (!logicalSessionId) return null;

  // Check in-memory cache first
  const cached = logicalThreadStates.get(logicalSessionId);
  if (cached && Date.now() - cached.timestamp <= SESSION_TTL_MS) {
    return cached;
  }
  if (cached) {
    logicalThreadStates.delete(logicalSessionId);
  }

  if (isAuthMockEnabled()) return null;

  // Fallback to SQLite
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT session_id, account_id, chat_session_id, parent_id, instructions_sent, updated_at FROM logical_thread_states WHERE session_id = ?",
      )
      .get(logicalSessionId) as
      | {
          session_id: string;
          account_id: string;
          chat_session_id: string;
          parent_id: string | null;
          instructions_sent: number;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;

    const timestamp = new Date(row.updated_at).getTime();
    if (Date.now() - timestamp > SESSION_TTL_MS) {
      db.prepare("DELETE FROM logical_thread_states WHERE session_id = ?").run(
        logicalSessionId,
      );
      return null;
    }

    const entry: LogicalThreadEntry = {
      accountId: row.account_id,
      chatSessionId: row.chat_session_id,
      parentId: row.parent_id,
      instructionsSent: row.instructions_sent === 1,
      timestamp,
    };

    // Populate in-memory cache
    logicalThreadStates.set(logicalSessionId, entry);
    return entry;
  } catch (err) {
    logger.warn("[Qwen] Failed to read logical thread from SQLite", {
      sessionId: logicalSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function updateLogicalThreadState(
  logicalSessionId: string,
  entry: Omit<LogicalThreadEntry, "timestamp" | "instructionsSent"> & {
    instructionsSent?: boolean;
  },
): void {
  if (
    !logicalSessionId ||
    entry.chatSessionId === undefined ||
    entry.chatSessionId === null
  )
    return;
  if (logicalThreadStates.size > 10000) cleanupStaleSessions();
  const existing = logicalThreadStates.get(logicalSessionId);
  const merged = {
    ...entry,
    instructionsSent:
      entry.instructionsSent ?? existing?.instructionsSent ?? false,
    timestamp: Date.now(),
  };

  // Update in-memory cache
  logicalThreadStates.set(logicalSessionId, merged);

  if (isAuthMockEnabled()) return;

  // Persist to SQLite with a short debounce: turns in the tool-call loop
  // update this on every stream creation, and coalescing them into one
  // transaction removes ~30+ synchronous writes per conversation. Reads stay
  // cache-first, so runtime behavior is unchanged; the flush runs on shutdown.
  logicalThreadDirty.add(logicalSessionId);
  scheduleLogicalThreadFlush();
}

export function updateLogicalThreadParent(
  logicalSessionId: string | null | undefined,
  parentId: string | null,
  accountId: string,
  chatSessionId: string,
): void {
  if (!logicalSessionId || !chatSessionId) return;
  updateLogicalThreadState(logicalSessionId, {
    accountId,
    chatSessionId,
    parentId,
    instructionsSent: true,
  });
}

export function updateSessionParent(
  sessionId: string,
  parentId: string | null,
  accountId?: string,
) {
  if (!sessionId) return;

  if (sessionStates.size > 10000) {
    cleanupStaleSessions();
  }

  const existing = sessionStates.get(sessionId);
  sessionStates.set(sessionId, {
    accountId: accountId || existing?.accountId || "global",
    parentId,
    timestamp: Date.now(),
  });
}

/**
 * Invalidate the stored parent for a logical thread without forgetting the
 * upstream chat binding. The next request will see a missing parent and must
 * rebuild the upstream chat with full context instead of appending to a
 * possibly corrupted parent chain.
 */
export function invalidateLogicalThreadParent(
  logicalSessionId: string | null | undefined,
): void {
  if (!logicalSessionId) return;

  const existing = getLogicalThreadState(logicalSessionId);
  if (!existing) return;

  updateSessionParent(existing.chatSessionId, null, existing.accountId);
  updateLogicalThreadState(logicalSessionId, {
    accountId: existing.accountId,
    chatSessionId: existing.chatSessionId,
    parentId: null,
    instructionsSent: existing.instructionsSent,
  });
}

export function clearAllSessionsForAccount(accountId: string): void {
  let removed = 0;

  for (const [key, entry] of sessionStates.entries()) {
    if (entry.accountId === accountId) {
      sessionStates.delete(key);
      removed++;
    }
  }

  for (const [key, entry] of logicalThreadStates.entries()) {
    if (entry.accountId === accountId) {
      logicalThreadStates.delete(key);
      // Drop pending writes too, so a later debounce flush cannot resurrect
      // the just-deleted row.
      logicalThreadDirty.delete(key);
      removed++;
    }
  }

  // Also clear from SQLite
  try {
    const db = getDatabase();
    const result = db
      .prepare("DELETE FROM logical_thread_states WHERE account_id = ?")
      .run(accountId);
    removed += result.changes;
  } catch {}

  console.log(
    `🧹 [Qwen] Cleared ${removed} session(s) for account ${accountId}`,
  );
}

export function getSessionParent(
  sessionId: string,
  accountId?: string,
): string | null | undefined {
  const entry = sessionStates.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > SESSION_TTL_MS) {
    sessionStates.delete(sessionId);
    return undefined;
  }
  if (accountId && entry.accountId !== accountId) {
    return undefined;
  }
  return entry.parentId;
}
