import { mapClientModelToQwen } from "./model-alias.ts";
import {
  deleteAllModelLimitsFromDb,
  deleteModelLimit,
  deleteModelLimitsForAccount,
  listPersistedModelLimits,
  upsertModelLimit,
} from "./database.ts";

/**
 * Tracks which models are out of daily quota for a given account.
 *
 * Qwen enforces a daily limit per model: exhausting `qwen3.8-max` does not
 * exhaust `qwen3.7-plus` on the same account. Parking only `(account, model)`
 * preserves the rest of the account's models instead of falsely rotating the
 * whole account out of the pool.
 */

export interface ModelLimitEntry {
  accountId: string;
  model: string;
  until: number;
  reason: string;
  updatedAt: number;
}

const modelLimits = new Map<string, ModelLimitEntry>();
let loadedFromDb = false;

const KEY_SEPARATOR = "::";

export function normalizeModelLimitId(model: string): string {
  const raw = (model || "").trim();
  if (!raw) return "";
  return mapClientModelToQwen(raw).trim().toLowerCase();
}

function limitKey(accountId: string, normalizedModel: string): string {
  return `${accountId}${KEY_SEPARATOR}${normalizedModel}`;
}

function ensureLoaded(): void {
  if (loadedFromDb) return;
  loadedFromDb = true;
  loadModelLimits();
}

export function markAccountModelLimited(
  accountId: string,
  model: string,
  until: number,
  reason = "MembershipLimit",
): void {
  if (!accountId || accountId === "global") return;
  ensureLoaded();
  const normalized = normalizeModelLimitId(model);
  if (!normalized) return;

  const entry: ModelLimitEntry = {
    accountId,
    model: normalized,
    until,
    reason,
    updatedAt: Date.now(),
  };
  modelLimits.set(limitKey(accountId, normalized), entry);
  try {
    upsertModelLimit(entry);
  } catch {
    /* DB persistence is best-effort */
  }
}

export function getModelLimit(
  accountId: string,
  model: string,
): ModelLimitEntry | null {
  if (!accountId || accountId === "global") return null;
  ensureLoaded();
  const normalized = normalizeModelLimitId(model);
  if (!normalized) return null;

  const key = limitKey(accountId, normalized);
  const entry = modelLimits.get(key);
  if (!entry) return null;
  if (entry.until <= Date.now()) {
    modelLimits.delete(key);
    try {
      deleteModelLimit(accountId, normalized);
    } catch {}
    return null;
  }
  return entry;
}

export function isAccountModelLimited(
  accountId: string,
  model: string,
): boolean {
  return getModelLimit(accountId, model) !== null;
}

export function getModelLimitRemainingMs(
  accountId: string,
  model: string,
): number {
  const entry = getModelLimit(accountId, model);
  return entry ? Math.max(0, entry.until - Date.now()) : 0;
}

export function clearAccountModelLimit(accountId: string, model: string): void {
  ensureLoaded();
  const normalized = normalizeModelLimitId(model);
  if (!normalized) return;
  modelLimits.delete(limitKey(accountId, normalized));
  try {
    deleteModelLimit(accountId, normalized);
  } catch {}
}

export function clearAllAccountModelLimits(accountId: string): void {
  ensureLoaded();
  for (const [key, entry] of [...modelLimits.entries()]) {
    if (entry.accountId === accountId) {
      modelLimits.delete(key);
    }
  }
  try {
    deleteModelLimitsForAccount(accountId);
  } catch {}
}

export function clearAllModelLimits(): number {
  const memCount = modelLimits.size;
  modelLimits.clear();
  loadedFromDb = true;
  let dbCount = 0;
  try {
    dbCount = deleteAllModelLimitsFromDb();
  } catch {}
  return Math.max(memCount, dbCount);
}

export function listModelLimits(): ModelLimitEntry[] {
  ensureLoaded();
  const now = Date.now();
  const out: ModelLimitEntry[] = [];
  for (const [key, entry] of [...modelLimits.entries()]) {
    if (entry.until <= now) {
      modelLimits.delete(key);
      continue;
    }
    out.push(entry);
  }
  return out;
}

export function loadModelLimits(): void {
  try {
    const now = Date.now();
    for (const row of listPersistedModelLimits()) {
      if (row.until <= now) continue;
      modelLimits.set(limitKey(row.account_id, row.model), {
        accountId: row.account_id,
        model: row.model,
        until: row.until,
        reason: row.reason,
        updatedAt: row.updated_at,
      });
    }
  } catch {
    /* DB persistence is best-effort */
  }
}
