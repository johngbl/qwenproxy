import {
  QwenAccount,
  loadAccounts,
  updateAccountCooldown,
} from "./accounts.ts";
import { getAccountsByPriority } from "./account-priority.ts";
import { formatCooldownUntil } from "./logger.ts";

let currentIndex = 0;

interface CooldownEntry {
  until: number;
  reason: string;
}

const cooldowns = new Map<string, CooldownEntry>();

/**
 * Milliseconds until the next UTC midnight plus a safety margin. The Qwen
 * daily quota resets at 00:00 UTC, so this is the correct "when is this
 * account usable again" for a quota exhaust — regardless of the upstream
 * "Wait about N hour(s)" hint (accurate mid-day, but rounds to ~24h near
 * midnight when the real reset is minutes away).
 */
export function computeQuotaCooldownMs(
  nowMs: number,
  marginMs = 5 * 60 * 1000,
): number {
  const nextMidnight = new Date(nowMs);
  nextMidnight.setUTCHours(24, 0, 0, 0);
  const targetMs = nextMidnight.getTime() - nowMs + marginMs;
  // A daily quota cooldown must never exceed 24h (cap to 24h - 1m so it never spills over
  // during the first marginMs window after 00:00 UTC).
  const maxCooldownMs = 24 * 60 * 60 * 1000 - 60_000;
  return Math.min(maxCooldownMs, Math.max(60_000, targetMs));
}

// The long-ago 24h blind fallback was the source of "treated available accounts
// as unavailable": when no explicit duration was given (e.g. a quota exhaust
// without the wait hint) the account was parked for a full day even though the
// Qwen daily quota resets at the next UTC midnight. Fall back to the same
// midnight-based behavior instead.
function defaultCooldownDurationMs(): number {
  return computeQuotaCooldownMs(Date.now());
}

export function markAccountRateLimited(
  accountId: string,
  cooldownMs?: number,
  reason?: string,
  options: { silent?: boolean } = {},
): void {
  const duration = cooldownMs ?? defaultCooldownDurationMs();
  const until = Date.now() + duration;
  const cooldownReason = reason ?? "RateLimited";

  cooldowns.set(accountId, {
    until,
    reason: cooldownReason,
  });

  // Persist to database
  if (accountId !== "global") {
    try {
      updateAccountCooldown(accountId, until, cooldownReason);
    } catch (err) {
      console.error(
        `❌ [AccountManager] Failed to save cooldown to DB for ${accountId}:`,
        (err as Error).message,
      );
    }
  }

  if (!options.silent) {
    console.log(
      `⏱️  [AccountManager] Cooldown set | ${accountId} | reason=${cooldownReason} | ${Math.round(duration / 1000)}s | until=${formatCooldownUntil(new Date(until))}`,
    );
  }
}

export function clearAccountCooldown(accountId: string): void {
  cooldowns.delete(accountId);
  if (accountId !== "global") {
    try {
      updateAccountCooldown(accountId, 0, null);
    } catch (err) {
      console.error(
        `❌ [AccountManager] Failed to clear cooldown in DB for ${accountId}:`,
        (err as Error).message,
      );
    }
  }
}

export function clearAllAccountCooldowns(): number {
  const accounts = loadAccounts();
  let count = 0;
  for (const account of accounts) {
    if (cooldowns.has(account.id) || (account.cooldown_until && account.cooldown_until > 0)) {
      clearAccountCooldown(account.id);
      count++;
    }
  }
  cooldowns.delete("global");
  return count;
}

export function getAccountCooldownInfo(
  accountId: string,
): { onCooldown: boolean; remainingMs: number; reason: string } | null {
  const entry = cooldowns.get(accountId);
  if (!entry) return null;
  const remaining = entry.until - Date.now();
  if (remaining <= 0) {
    cooldowns.delete(accountId);
    if (accountId !== "global") {
      try {
        updateAccountCooldown(accountId, 0, null);
      } catch (err) {
        console.error(
          `❌ [AccountManager] Failed to clear expired cooldown in DB:`,
          (err as Error).message,
        );
      }
    }
    return null;
  }
  return { onCooldown: true, remainingMs: remaining, reason: entry.reason };
}

function isAccountOnCooldown(accountId: string): boolean {
  return getAccountCooldownInfo(accountId) !== null;
}

// ─── Headers-ready gate (mirrors upstream `markAccountReady`) ───────────────
// Accounts whose anti-bot headers were successfully captured are "ready". The
// rotation pickers below skip not-ready accounts whenever at least one account
// IS ready, so a request never lands on a lane that is still warming up or
// whose context just died (Playwright page unavailable → 300s init cooldown).
// The gate degrades to "all accounts pass" when NO account is ready (startup
// warmup / freshly-restored headers) so a single-account or cold pool stays
// lossless — exactly the upstream `anyReady` rule.
const headersReadyAccounts = new Set<string>();

export function markAccountHeadersReady(accountId: string): void {
  if (!accountId || accountId === "global") return;
  headersReadyAccounts.add(accountId);
}

export function unmarkAccountHeadersReady(accountId: string): void {
  if (!accountId) return;
  headersReadyAccounts.delete(accountId);
}

export function isAccountHeadersReady(accountId: string): boolean {
  return headersReadyAccounts.has(accountId);
}

function anyUsableAccountHeadersReady(
  accounts: QwenAccount[],
  triedSet?: Set<string>,
): boolean {
  return accounts.some(
    (a) =>
      (!triedSet || !triedSet.has(a.id)) &&
      !isAccountOnCooldown(a.id) &&
      isAccountHeadersReady(a.id),
  );
}

function passesHeadersReadyGate(
  accountId: string,
  anyReady: boolean,
): boolean {
  return !anyReady || isAccountHeadersReady(accountId);
}

export function syncCooldownsFromDb(accounts: QwenAccount[]): void {
  const now = Date.now();
  for (const account of accounts) {
    if (account.cooldown_until && account.cooldown_until > now) {
      if (!cooldowns.has(account.id)) {
        cooldowns.set(account.id, {
          until: account.cooldown_until,
          reason: account.cooldown_reason || "RateLimited",
        });
      }
    } else {
      if (cooldowns.has(account.id)) {
        cooldowns.delete(account.id);
      }
    }
  }
}

export function getNextAccount(): QwenAccount | null {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    return null;
  }

  syncCooldownsFromDb(accounts);

  // Ordena por prioridade (contas que funcionaram bem vêm primeiro)
  const prioritized = getAccountsByPriority(accounts);
  // Gate: once ANY usable account has captured headers, only ready accounts rotate.
  // If all ready accounts are on cooldown, anyReady degrades to false so non-ready
  // accounts can be initialized on-demand instead of falsely reporting pool exhaustion.
  const anyReady = anyUsableAccountHeadersReady(accounts);

  for (let i = 0; i < prioritized.length; i++) {
    const account = prioritized[currentIndex % prioritized.length];
    currentIndex = (currentIndex + 1) % prioritized.length;
    if (
      !isAccountOnCooldown(account.id) &&
      passesHeadersReadyGate(account.id, anyReady)
    ) {
      return account;
    }
  }

  // All accounts on cooldown — return the one with the shortest remaining cooldown.
  let best: QwenAccount | null = null;
  let bestRemaining = Infinity;
  for (const account of prioritized) {
    const info = getAccountCooldownInfo(account.id);
    if (info && info.remainingMs < bestRemaining) {
      bestRemaining = info.remainingMs;
      best = account;
    }
  }
  return best;
}

export function getNextAvailableAccount(
  triedAccountIds?: Set<string> | string,
): QwenAccount | null {
  const accounts = loadAccounts();
  if (accounts.length === 0) return null;

  syncCooldownsFromDb(accounts);

  let triedSet: Set<string>;
  if (triedAccountIds instanceof Set) {
    triedSet = triedAccountIds;
  } else {
    triedSet = new Set(triedAccountIds ? [triedAccountIds] : []);
  }

  // Ordena por prioridade (contas que funcionaram bem vêm primeiro)
  const prioritized = getAccountsByPriority(accounts);
  // Gate: once ANY untried, non-cooldown account has captured headers, only ready accounts rotate.
  // If all ready accounts are on cooldown or tried, anyReady degrades to false so non-ready
  // accounts can be initialized on-demand instead of falsely reporting pool exhaustion.
  const anyReady = anyUsableAccountHeadersReady(accounts, triedSet);

  // 1. Try to find an untried account that is NOT on cooldown
  for (let i = 0; i < prioritized.length; i++) {
    const idx = (currentIndex + i) % prioritized.length;
    const account = prioritized[idx];
    if (triedSet.has(account.id)) continue;
    if (
      !isAccountOnCooldown(account.id) &&
      passesHeadersReadyGate(account.id, anyReady)
    ) {
      currentIndex = (idx + 1) % prioritized.length;
      return account;
    }
  }

  // 2. If all untried accounts are on cooldown, return the untried one with the shortest remaining cooldown
  let best: QwenAccount | null = null;
  let bestRemaining = Infinity;
  for (const account of prioritized) {
    if (triedSet.has(account.id)) continue;
    const info = getAccountCooldownInfo(account.id);
    if (info && info.remainingMs < bestRemaining) {
      bestRemaining = info.remainingMs;
      best = account;
    }
  }
  return best;
}

export function getCooldownStatus(): Record<
  string,
  { remainingMs: number; reason: string }
> {
  const result: Record<string, { remainingMs: number; reason: string }> = {};
  for (const [id, info] of cooldowns.entries()) {
    const remaining = info.until - Date.now();
    if (remaining > 0) {
      result[id] = { remainingMs: remaining, reason: info.reason };
    }
  }
  return result;
}
