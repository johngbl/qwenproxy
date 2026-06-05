import type { Usage } from "../utils/types.ts";
import { config } from "../core/config.ts";
import { getDatabase } from "../core/database.ts";
import { logger } from "../core/logger.ts";
import {
  decideThreadContextThresholds,
  estimateThreadTextTokens,
  type ThreadContextStatus,
} from "./thread-context-estimator.ts";

export type { ThreadContextStatus };

export interface ThreadContextSession {
  sessionId: string;
  clientName: string | null;
  accountId: string | null;
  activeChatSessionId: string | null;
  activeParentId: string | null;
  previousChatSessionId: string | null;
  model: string;
  modelContextWindow: number;
  systemPrompt: string | null;
  toolInstructionsHash: string | null;
  estimatedThreadTokens: number;
  estimatedRecentTokens: number;
  estimatedSummaryTokens: number;
  latestSummaryId: number | null;
  summarySequence: number;
  status: ThreadContextStatus;
  rolloverCount: number;
  lastSummaryAt: string | null;
  lastRolloverAt: string | null;
  lastActivityAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface ThreadContextTurn {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  contentTokens: number;
  qwenAccountId: string | null;
  qwenChatId: string | null;
  qwenParentId: string | null;
  qwenResponseId: string | null;
  isAuxiliary: boolean;
  isSummarized: boolean;
  isRecentAnchor: boolean;
  usageJson: string | null;
  metadataJson: string | null;
  createdAt: string;
}

export interface ThreadContextSummary {
  id: number;
  sessionId: string;
  sequence: number;
  summary: string;
  summaryTokens: number;
  sourceTurnStart: number | null;
  sourceTurnEnd: number | null;
  model: string | null;
  accountId: string | null;
  summaryChatId: string | null;
  compressionRatio: number | null;
  createdAt: string;
}

interface ThreadContextSessionRow {
  session_id: string;
  client_name: string | null;
  account_id: string | null;
  active_chat_session_id: string | null;
  active_parent_id: string | null;
  previous_chat_session_id: string | null;
  model: string;
  model_context_window: number;
  system_prompt: string | null;
  tool_instructions_hash: string | null;
  estimated_thread_tokens: number;
  estimated_recent_tokens: number;
  estimated_summary_tokens: number;
  latest_summary_id: number | null;
  summary_sequence: number;
  status: ThreadContextStatus;
  rollover_count: number;
  last_summary_at: string | null;
  last_rollover_at: string | null;
  last_activity_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

interface ThreadContextTurnRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  content_tokens: number;
  qwen_account_id: string | null;
  qwen_chat_id: string | null;
  qwen_parent_id: string | null;
  qwen_response_id: string | null;
  is_auxiliary: number;
  is_summarized: number;
  is_recent_anchor: number;
  usage_json: string | null;
  metadata_json: string | null;
  created_at: string;
}

interface ThreadContextSummaryRow {
  id: number;
  session_id: string;
  sequence: number;
  summary: string;
  summary_tokens: number;
  source_turn_start: number | null;
  source_turn_end: number | null;
  model: string | null;
  account_id: string | null;
  summary_chat_id: string | null;
  compression_ratio: number | null;
  created_at: string;
}

export interface UpsertThreadContextSessionInput {
  sessionId: string;
  model: string;
  modelContextWindow: number;
  clientName?: string | null;
  accountId?: string | null;
  activeChatSessionId?: string | null;
  activeParentId?: string | null;
  previousChatSessionId?: string | null;
  systemPrompt?: string | null;
  toolInstructionsHash?: string | null;
  estimatedThreadTokens?: number;
  status?: ThreadContextStatus;
}

export interface SaveThreadContextCompletionInput {
  sessionId: string;
  model: string;
  modelContextWindow: number;
  accountId: string;
  chatSessionId: string;
  parentId?: string | null;
  responseId?: string | null;
  userPrompt: string;
  finalPrompt: string;
  assistantContent: string;
  usage?: Usage | null;
  finishReason?: string | null;
  isAuxiliary?: boolean;
  resetThreadEstimate?: boolean;
  metadata?: Record<string, unknown>;
}

export interface InsertThreadContextSummaryInput {
  sessionId: string;
  summary: string;
  summaryTokens?: number;
  sourceTurnStart?: number | null;
  sourceTurnEnd?: number | null;
  model?: string | null;
  accountId?: string | null;
  summaryChatId?: string | null;
  compressionRatio?: number | null;
}

export interface RecordThreadContextRolloverInput {
  sessionId: string;
  fromAccountId?: string | null;
  fromChatId?: string | null;
  toAccountId?: string | null;
  toChatId?: string | null;
  summaryId?: number | null;
  reason: string;
  oldEstimatedTokens: number;
  newInitialTokens: number;
}

function mapSession(row: ThreadContextSessionRow): ThreadContextSession {
  return {
    sessionId: row.session_id,
    clientName: row.client_name,
    accountId: row.account_id,
    activeChatSessionId: row.active_chat_session_id,
    activeParentId: row.active_parent_id,
    previousChatSessionId: row.previous_chat_session_id,
    model: row.model,
    modelContextWindow: row.model_context_window,
    systemPrompt: row.system_prompt,
    toolInstructionsHash: row.tool_instructions_hash,
    estimatedThreadTokens: row.estimated_thread_tokens,
    estimatedRecentTokens: row.estimated_recent_tokens,
    estimatedSummaryTokens: row.estimated_summary_tokens,
    latestSummaryId: row.latest_summary_id,
    summarySequence: row.summary_sequence,
    status: row.status,
    rolloverCount: row.rollover_count,
    lastSummaryAt: row.last_summary_at,
    lastRolloverAt: row.last_rollover_at,
    lastActivityAt: row.last_activity_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function mapTurn(row: ThreadContextTurnRow): ThreadContextTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    contentTokens: row.content_tokens,
    qwenAccountId: row.qwen_account_id,
    qwenChatId: row.qwen_chat_id,
    qwenParentId: row.qwen_parent_id,
    qwenResponseId: row.qwen_response_id,
    isAuxiliary: row.is_auxiliary === 1,
    isSummarized: row.is_summarized === 1,
    isRecentAnchor: row.is_recent_anchor === 1,
    usageJson: row.usage_json,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
  };
}

function mapSummary(row: ThreadContextSummaryRow): ThreadContextSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    summary: row.summary,
    summaryTokens: row.summary_tokens,
    sourceTurnStart: row.source_turn_start,
    sourceTurnEnd: row.source_turn_end,
    model: row.model,
    accountId: row.account_id,
    summaryChatId: row.summary_chat_id,
    compressionRatio: row.compression_ratio,
    createdAt: row.created_at,
  };
}

function expiresAtFromConfig(): string | null {
  const ttlHours = config.context.threadNative.sessionTtlHours;
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) return null;
  return new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
}

function safeJsonStringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

function compactContentForStorage(
  role: string,
  content: string,
): { content: string; metadata: Record<string, unknown> | null } {
  const maxChars = 100_000;
  if (content.length <= maxChars) {
    return { content, metadata: null };
  }

  const preview = content.slice(0, maxChars);
  return {
    content:
      preview +
      `\n\n[QwenBridge truncated ${content.length - maxChars} character(s) from this ${role} turn before local persistence.]`,
    metadata: {
      locallyTruncated: true,
      originalCharacters: content.length,
      omittedCharacters: content.length - maxChars,
    },
  };
}

export function getThreadContextSession(
  sessionId: string | null | undefined,
): ThreadContextSession | null {
  if (!sessionId) return null;
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM thread_context_sessions WHERE session_id = ?`)
    .get(sessionId) as ThreadContextSessionRow | undefined;
  return row ? mapSession(row) : null;
}

export function upsertThreadContextSession(
  input: UpsertThreadContextSessionInput,
): ThreadContextSession {
  const existing = getThreadContextSession(input.sessionId);
  const expiresAt = expiresAtFromConfig();
  const db = getDatabase();

  if (!existing) {
    db.prepare(
      `INSERT INTO thread_context_sessions (
        session_id, client_name, account_id, active_chat_session_id,
        active_parent_id, previous_chat_session_id, model, model_context_window,
        system_prompt, tool_instructions_hash, estimated_thread_tokens,
        status, last_activity_at, expires_at
      ) VALUES (
        @sessionId, @clientName, @accountId, @activeChatSessionId,
        @activeParentId, @previousChatSessionId, @model, @modelContextWindow,
        @systemPrompt, @toolInstructionsHash, @estimatedThreadTokens,
        @status, datetime('now'), @expiresAt
      )`,
    ).run({
      sessionId: input.sessionId,
      clientName: input.clientName ?? null,
      accountId: input.accountId ?? null,
      activeChatSessionId: input.activeChatSessionId ?? null,
      activeParentId: input.activeParentId ?? null,
      previousChatSessionId: input.previousChatSessionId ?? null,
      model: input.model,
      modelContextWindow: input.modelContextWindow,
      systemPrompt: input.systemPrompt ?? null,
      toolInstructionsHash: input.toolInstructionsHash ?? null,
      estimatedThreadTokens: input.estimatedThreadTokens ?? 0,
      status: input.status ?? "normal",
      expiresAt,
    });
    return refreshThreadContextAggregates(input.sessionId, {
      estimatedThreadTokens: input.estimatedThreadTokens ?? 0,
      status: input.status,
    });
  }

  db.prepare(
    `UPDATE thread_context_sessions SET
      client_name = @clientName,
      account_id = @accountId,
      active_chat_session_id = @activeChatSessionId,
      active_parent_id = @activeParentId,
      previous_chat_session_id = @previousChatSessionId,
      model = @model,
      model_context_window = @modelContextWindow,
      system_prompt = @systemPrompt,
      tool_instructions_hash = @toolInstructionsHash,
      estimated_thread_tokens = @estimatedThreadTokens,
      status = @status,
      last_activity_at = datetime('now'),
      updated_at = datetime('now'),
      expires_at = @expiresAt
    WHERE session_id = @sessionId`,
  ).run({
    sessionId: input.sessionId,
    clientName: input.clientName ?? existing.clientName,
    accountId: input.accountId ?? existing.accountId,
    activeChatSessionId:
      input.activeChatSessionId ?? existing.activeChatSessionId,
    activeParentId: input.activeParentId ?? existing.activeParentId,
    previousChatSessionId:
      input.previousChatSessionId ?? existing.previousChatSessionId,
    model: input.model || existing.model,
    modelContextWindow: input.modelContextWindow || existing.modelContextWindow,
    systemPrompt: input.systemPrompt ?? existing.systemPrompt,
    toolInstructionsHash:
      input.toolInstructionsHash ?? existing.toolInstructionsHash,
    estimatedThreadTokens:
      input.estimatedThreadTokens ?? existing.estimatedThreadTokens,
    status: input.status ?? existing.status,
    expiresAt: expiresAt ?? existing.expiresAt,
  });

  return refreshThreadContextAggregates(input.sessionId, {
    estimatedThreadTokens:
      input.estimatedThreadTokens ?? existing.estimatedThreadTokens,
    status: input.status,
  });
}

export function getLatestThreadContextSummary(
  sessionId: string,
): ThreadContextSummary | null {
  const row = getDatabase()
    .prepare(
      `SELECT * FROM thread_context_summaries
       WHERE session_id = ?
       ORDER BY sequence DESC, id DESC
       LIMIT 1`,
    )
    .get(sessionId) as ThreadContextSummaryRow | undefined;
  return row ? mapSummary(row) : null;
}

export function getUnsummarizedThreadContextTurns(
  sessionId: string,
): ThreadContextTurn[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM thread_context_turns
       WHERE session_id = ? AND is_auxiliary = 0 AND is_summarized = 0
       ORDER BY id ASC`,
    )
    .all(sessionId) as ThreadContextTurnRow[];
  return rows.map(mapTurn);
}

export function getRecentThreadContextTurns(
  sessionId: string,
  limit = config.context.threadNative.recentTurnsToKeep,
): ThreadContextTurn[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM (
         SELECT * FROM thread_context_turns
         WHERE session_id = ? AND is_auxiliary = 0
         ORDER BY id DESC
         LIMIT ?
       ) ORDER BY id ASC`,
    )
    .all(sessionId, Math.max(0, limit)) as ThreadContextTurnRow[];
  return rows.map(mapTurn);
}

function insertThreadContextTurn(input: {
  sessionId: string;
  role: string;
  content: string;
  contentTokens: number;
  qwenAccountId?: string | null;
  qwenChatId?: string | null;
  qwenParentId?: string | null;
  qwenResponseId?: string | null;
  isAuxiliary?: boolean;
  usage?: Usage | null;
  metadata?: Record<string, unknown> | null;
}): number {
  const compacted = compactContentForStorage(input.role, input.content);
  const metadata = {
    ...(input.metadata ?? {}),
    ...(compacted.metadata ?? {}),
  };
  const metadataJson = Object.keys(metadata).length
    ? safeJsonStringify(metadata)
    : null;

  const result = getDatabase()
    .prepare(
      `INSERT INTO thread_context_turns (
        session_id, role, content, content_tokens, qwen_account_id,
        qwen_chat_id, qwen_parent_id, qwen_response_id, is_auxiliary,
        usage_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      input.role,
      compacted.content,
      Math.max(0, input.contentTokens),
      input.qwenAccountId ?? null,
      input.qwenChatId ?? null,
      input.qwenParentId ?? null,
      input.qwenResponseId ?? null,
      input.isAuxiliary ? 1 : 0,
      safeJsonStringify(input.usage),
      metadataJson,
    );

  return Number(result.lastInsertRowid);
}

function usageTotalTokens(usage?: Usage | null): number | null {
  const total = usage?.total_tokens;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

export function insertRecoveredThreadContextTurn(input: {
  sessionId: string;
  role: string;
  content: string;
  qwenAccountId?: string | null;
  qwenChatId?: string | null;
  qwenParentId?: string | null;
  qwenResponseId?: string | null;
  metadata?: Record<string, unknown>;
}): number {
  const id = insertThreadContextTurn({
    sessionId: input.sessionId,
    role: input.role,
    content: input.content,
    contentTokens: estimateThreadTextTokens(input.content),
    qwenAccountId: input.qwenAccountId,
    qwenChatId: input.qwenChatId,
    qwenParentId: input.qwenParentId,
    qwenResponseId: input.qwenResponseId,
    metadata: {
      recoverySource: "qwen_history",
      ...(input.metadata ?? {}),
    },
  });
  refreshThreadContextAggregates(input.sessionId);
  return id;
}

export function saveThreadContextCompletion(
  input: SaveThreadContextCompletionInput,
): ThreadContextSession {
  const existing =
    getThreadContextSession(input.sessionId) ??
    upsertThreadContextSession({
      sessionId: input.sessionId,
      model: input.model,
      modelContextWindow: input.modelContextWindow,
      accountId: input.accountId,
      activeChatSessionId: input.chatSessionId,
      activeParentId: input.responseId ?? null,
    });

  const finalPromptTokens = estimateThreadTextTokens(input.finalPrompt);
  const userTokens = estimateThreadTextTokens(input.userPrompt);
  const assistantTokens = estimateThreadTextTokens(input.assistantContent);
  const observedTotal = usageTotalTokens(input.usage);
  const estimatedThreadTokens = Math.max(
    input.resetThreadEstimate
      ? finalPromptTokens + assistantTokens
      : existing.estimatedThreadTokens + finalPromptTokens + assistantTokens,
    observedTotal ?? 0,
  );

  const baseMetadata = {
    ...(input.metadata ?? {}),
    finalPromptTokens,
    userTokens,
    assistantTokens,
    finishReason: input.finishReason ?? null,
    resetThreadEstimate: input.resetThreadEstimate === true,
  };

  if (input.userPrompt.trim()) {
    insertThreadContextTurn({
      sessionId: input.sessionId,
      role: "user",
      content: input.userPrompt,
      contentTokens: userTokens,
      qwenAccountId: input.accountId,
      qwenChatId: input.chatSessionId,
      qwenParentId: input.parentId ?? null,
      isAuxiliary: input.isAuxiliary,
      metadata: baseMetadata,
    });
  }

  insertThreadContextTurn({
    sessionId: input.sessionId,
    role: "assistant",
    content: input.assistantContent,
    contentTokens: assistantTokens,
    qwenAccountId: input.accountId,
    qwenChatId: input.chatSessionId,
    qwenParentId: input.parentId ?? null,
    qwenResponseId: input.responseId ?? null,
    isAuxiliary: input.isAuxiliary,
    usage: input.usage,
    metadata: baseMetadata,
  });

  getDatabase()
    .prepare(
      `UPDATE thread_context_sessions SET
        account_id = ?,
        active_chat_session_id = ?,
        active_parent_id = ?,
        model = ?,
        model_context_window = ?,
        estimated_thread_tokens = ?,
        last_activity_at = datetime('now'),
        updated_at = datetime('now'),
        expires_at = ?
       WHERE session_id = ?`,
    )
    .run(
      input.accountId,
      input.chatSessionId,
      input.responseId ?? existing.activeParentId,
      input.model,
      input.modelContextWindow,
      estimatedThreadTokens,
      expiresAtFromConfig() ?? existing.expiresAt,
      input.sessionId,
    );

  return refreshThreadContextAggregates(input.sessionId, {
    estimatedThreadTokens,
  });
}

export function refreshThreadContextAggregates(
  sessionId: string,
  options?: {
    estimatedThreadTokens?: number;
    status?: ThreadContextStatus;
  },
): ThreadContextSession {
  const db = getDatabase();
  const existing = getThreadContextSession(sessionId);
  if (!existing) {
    throw new Error(`Thread context session not found: ${sessionId}`);
  }

  const recent = db
    .prepare(
      `SELECT COALESCE(SUM(content_tokens), 0) AS tokens, COUNT(*) AS turns
       FROM thread_context_turns
       WHERE session_id = ? AND is_auxiliary = 0 AND is_summarized = 0`,
    )
    .get(sessionId) as { tokens: number; turns: number };
  const latestSummary = getLatestThreadContextSummary(sessionId);
  const estimatedThreadTokens =
    options?.estimatedThreadTokens ?? existing.estimatedThreadTokens;

  const decision = decideThreadContextThresholds({
    estimatedThreadTokens,
    estimatedRecentTokens: recent.tokens ?? 0,
    modelContextWindow: existing.modelContextWindow,
    unsummarizedTurns: recent.turns ?? 0,
    hasLatestSummary: latestSummary !== null,
    lastSummaryAt: existing.lastSummaryAt,
  });

  db.prepare(
    `UPDATE thread_context_sessions SET
      estimated_thread_tokens = ?,
      estimated_recent_tokens = ?,
      estimated_summary_tokens = ?,
      status = ?,
      updated_at = datetime('now')
     WHERE session_id = ?`,
  ).run(
    estimatedThreadTokens,
    recent.tokens ?? 0,
    latestSummary?.summaryTokens ?? 0,
    options?.status ?? decision.status,
    sessionId,
  );

  const updated = getThreadContextSession(sessionId);
  if (!updated) {
    throw new Error(`Thread context session disappeared: ${sessionId}`);
  }
  return updated;
}

export function insertThreadContextSummary(
  input: InsertThreadContextSummaryInput,
): ThreadContextSummary {
  const existing = getThreadContextSession(input.sessionId);
  if (!existing) {
    throw new Error(`Thread context session not found: ${input.sessionId}`);
  }

  const sequence = existing.summarySequence + 1;
  const summaryTokens =
    input.summaryTokens ?? estimateThreadTextTokens(input.summary);
  const db = getDatabase();
  const result = db
    .prepare(
      `INSERT INTO thread_context_summaries (
        session_id, sequence, summary, summary_tokens, source_turn_start,
        source_turn_end, model, account_id, summary_chat_id, compression_ratio
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      sequence,
      input.summary,
      summaryTokens,
      input.sourceTurnStart ?? null,
      input.sourceTurnEnd ?? null,
      input.model ?? null,
      input.accountId ?? null,
      input.summaryChatId ?? null,
      input.compressionRatio ?? null,
    );

  const summaryId = Number(result.lastInsertRowid);
  db.prepare(
    `UPDATE thread_context_sessions SET
      latest_summary_id = ?,
      summary_sequence = ?,
      estimated_summary_tokens = ?,
      last_summary_at = datetime('now'),
      last_error = NULL,
      updated_at = datetime('now')
     WHERE session_id = ?`,
  ).run(summaryId, sequence, summaryTokens, input.sessionId);

  if (input.sourceTurnEnd !== undefined && input.sourceTurnEnd !== null) {
    markThreadContextTurnsSummarized(
      input.sessionId,
      input.sourceTurnEnd,
      config.context.threadNative.recentTurnsToKeep,
    );
  } else {
    refreshThreadContextAggregates(input.sessionId);
  }

  cleanupThreadContextSession(input.sessionId);

  const inserted = db
    .prepare(`SELECT * FROM thread_context_summaries WHERE id = ?`)
    .get(summaryId) as ThreadContextSummaryRow | undefined;
  if (!inserted) throw new Error(`Failed to load summary ${summaryId}`);
  return mapSummary(inserted);
}

export function markThreadContextTurnsSummarized(
  sessionId: string,
  throughTurnId: number,
  preserveLastTurns = config.context.threadNative.recentTurnsToKeep,
): void {
  const db = getDatabase();
  const preserveRows = db
    .prepare(
      `SELECT id FROM thread_context_turns
       WHERE session_id = ? AND is_auxiliary = 0
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(sessionId, Math.max(0, preserveLastTurns)) as Array<{ id: number }>;
  const preserveIds = preserveRows.map((row) => row.id);

  if (preserveIds.length > 0) {
    const placeholders = preserveIds.map(() => "?").join(", ");
    db.prepare(
      `UPDATE thread_context_turns SET is_summarized = 1
       WHERE session_id = ? AND is_auxiliary = 0 AND id <= ?
         AND id NOT IN (${placeholders})`,
    ).run(sessionId, throughTurnId, ...preserveIds);
  } else {
    db.prepare(
      `UPDATE thread_context_turns SET is_summarized = 1
       WHERE session_id = ? AND is_auxiliary = 0 AND id <= ?`,
    ).run(sessionId, throughTurnId);
  }

  refreshThreadContextAggregates(sessionId);
}

export function updateThreadContextActiveChat(input: {
  sessionId: string;
  accountId: string;
  activeChatSessionId: string;
  activeParentId?: string | null;
  previousChatSessionId?: string | null;
  incrementRolloverCount?: boolean;
  status?: ThreadContextStatus;
}): ThreadContextSession {
  const existing = getThreadContextSession(input.sessionId);
  if (!existing) {
    throw new Error(`Thread context session not found: ${input.sessionId}`);
  }

  getDatabase()
    .prepare(
      `UPDATE thread_context_sessions SET
        account_id = ?,
        active_chat_session_id = ?,
        active_parent_id = ?,
        previous_chat_session_id = ?,
        rollover_count = rollover_count + ?,
        last_rollover_at = CASE WHEN ? = 1 THEN datetime('now') ELSE last_rollover_at END,
        status = ?,
        last_activity_at = datetime('now'),
        updated_at = datetime('now')
       WHERE session_id = ?`,
    )
    .run(
      input.accountId,
      input.activeChatSessionId,
      input.activeParentId ?? null,
      input.previousChatSessionId ?? existing.activeChatSessionId,
      input.incrementRolloverCount ? 1 : 0,
      input.incrementRolloverCount ? 1 : 0,
      input.status ?? existing.status,
      input.sessionId,
    );

  return refreshThreadContextAggregates(input.sessionId, {
    estimatedThreadTokens: existing.estimatedThreadTokens,
    status: input.status,
  });
}

export function recordThreadContextRollover(
  input: RecordThreadContextRolloverInput,
): number {
  const result = getDatabase()
    .prepare(
      `INSERT INTO thread_context_rollovers (
        session_id, from_account_id, from_chat_id, to_account_id, to_chat_id,
        summary_id, reason, old_estimated_tokens, new_initial_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      input.fromAccountId ?? null,
      input.fromChatId ?? null,
      input.toAccountId ?? null,
      input.toChatId ?? null,
      input.summaryId ?? null,
      input.reason,
      input.oldEstimatedTokens,
      input.newInitialTokens,
    );
  return Number(result.lastInsertRowid);
}

export function markThreadContextRolloverChatDeleted(
  sessionId: string,
  fromChatId: string,
): void {
  getDatabase()
    .prepare(
      `UPDATE thread_context_rollovers SET old_chat_deleted = 1
       WHERE session_id = ? AND from_chat_id = ?`,
    )
    .run(sessionId, fromChatId);
}

export function setThreadContextStatus(
  sessionId: string,
  status: ThreadContextStatus,
  error?: string | null,
): void {
  getDatabase()
    .prepare(
      `UPDATE thread_context_sessions SET
        status = ?,
        last_error = ?,
        updated_at = datetime('now')
       WHERE session_id = ?`,
    )
    .run(status, error ?? null, sessionId);
}

export function cleanupThreadContextSession(sessionId: string): void {
  const cfg = config.context.threadNative;
  const db = getDatabase();

  db.prepare(
    `DELETE FROM thread_context_summaries
     WHERE session_id = ?
       AND id NOT IN (
         SELECT id FROM thread_context_summaries
         WHERE session_id = ?
         ORDER BY sequence DESC, id DESC
         LIMIT ?
       )`,
  ).run(sessionId, sessionId, Math.max(1, cfg.maxSummariesPerSession));

  db.prepare(
    `DELETE FROM thread_context_turns
     WHERE session_id = ?
       AND is_summarized = 1
       AND id NOT IN (
         SELECT id FROM thread_context_turns
         WHERE session_id = ?
         ORDER BY id DESC
         LIMIT ?
       )`,
  ).run(sessionId, sessionId, Math.max(1, cfg.maxRawTurnsPerSession));
}

export function cleanupExpiredThreadContextSessions(): void {
  try {
    getDatabase()
      .prepare(
        `DELETE FROM thread_context_sessions
         WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`,
      )
      .run();
  } catch (error) {
    logger.warn("[thread-context] failed to cleanup expired sessions", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function deleteThreadContextSession(sessionId: string): void {
  getDatabase()
    .prepare(`DELETE FROM thread_context_sessions WHERE session_id = ?`)
    .run(sessionId);
}
