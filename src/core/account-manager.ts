import {
  QwenAccount,
  loadAccounts,
  updateAccountCooldown,
} from "./accounts.ts";
import { getAccountsByPriority, markAccountSuccessful, markAccountFailed } from "./account-priority.ts";

let currentIndex = 0;

interface CooldownEntry {
  until: number;
  reason: string;
}

const cooldowns = new Map<string, CooldownEntry>();

const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

export function formatDateTimeBR(timestamp: number): string {
	const date = new Date(timestamp);
	const day = String(date.getDate()).padStart(2, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const year = date.getFullYear();
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");
	return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

export function markAccountRateLimited(
  accountId: string,
  cooldownMs?: number,
  reason?: string,
): void {
  const duration = cooldownMs ?? DEFAULT_COOLDOWN_MS;
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

  	console.log(
  		`⏱️  [AccountManager] Cooldown set | ${accountId} | reason=${cooldownReason} | ${Math.round(duration / 1000)}s | until=${formatDateTimeBR(until)}`,
  	);
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

function syncCooldownsFromDb(accounts: QwenAccount[]): void {
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

  for (let i = 0; i < prioritized.length; i++) {
    const account = prioritized[currentIndex % prioritized.length];
    currentIndex = (currentIndex + 1) % prioritized.length;
    if (!isAccountOnCooldown(account.id)) {
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

  // Ordena por prioridade (contas que funcionaram bem vêm primeiro)
  const prioritized = getAccountsByPriority(accounts);

  let triedSet: Set<string>;
  if (triedAccountIds instanceof Set) {
    triedSet = triedAccountIds;
  } else {
    triedSet = new Set(triedAccountIds ? [triedAccountIds] : []);
  }

  // 1. Try to find an untried account that is NOT on cooldown
  for (let i = 0; i < prioritized.length; i++) {
    const idx = (currentIndex + i) % prioritized.length;
    const account = prioritized[idx];
    if (triedSet.has(account.id)) continue;
    if (!isAccountOnCooldown(account.id)) {
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
