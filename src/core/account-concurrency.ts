/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 *
 * Per-account concurrency guard. Limits the number of simultaneous upstream
 * streams per account and queues excess requests with FIFO ordering, timeout,
 * and abort support.
 */

import { config } from "./config.ts";
import { logger } from "./logger.ts";

export interface AccountLease {
  accountId: string;
  release(): void;
}

export interface AcquireAccountLeaseOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface QueueEntry {
  resolve: (lease: AccountLease) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  signal: AbortSignal | null;
}

interface AccountSlot {
  active: number;
  queue: QueueEntry[];
}

const slots = new Map<string, AccountSlot>();

function getSlot(accountId: string): AccountSlot {
  let slot = slots.get(accountId);
  if (!slot) {
    slot = { active: 0, queue: [] };
    slots.set(accountId, slot);
  }
  return slot;
}

function createLease(accountId: string): AccountLease {
  let released = false;
  return {
    accountId,
    release() {
      if (released) return;
      released = true;
      releaseSlot(accountId);
    },
  };
}

function releaseSlot(accountId: string): void {
  const slot = slots.get(accountId);
  if (!slot) return;

  slot.active = Math.max(0, slot.active - 1);

  // Deliver to the next waiter in FIFO order
  while (slot.queue.length > 0 && slot.active < config.concurrency.maxStreamsPerAccount) {
    const entry = slot.queue.shift();
    if (!entry) break;
    cleanupEntry(entry);
    slot.active++;
    entry.resolve(createLease(accountId));
    return; // one at a time to preserve ordering
  }

  // Clean up empty slots to avoid unbounded map growth
  if (slot.active === 0 && slot.queue.length === 0) {
    slots.delete(accountId);
  }
}

function cleanupEntry(entry: QueueEntry): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.onAbort && entry.signal) {
    entry.signal.removeEventListener("abort", entry.onAbort);
    entry.onAbort = null;
  }
}

/**
 * Try to acquire a lease without waiting. Returns null if the account is at
 * capacity.
 */
export function tryAcquireAccountLease(accountId: string): AccountLease | null {
  const slot = getSlot(accountId);
  if (slot.active < config.concurrency.maxStreamsPerAccount) {
    slot.active++;
    return createLease(accountId);
  }
  return null;
}

/**
 * Acquire a lease, waiting in FIFO order if the account is at capacity.
 * Rejects on timeout or abort.
 */
export function acquireAccountLease(
  accountId: string,
  options?: AcquireAccountLeaseOptions,
): Promise<AccountLease> {
  const signal = options?.signal ?? null;

  // Already aborted — reject before touching any slot
  if (signal?.aborted) {
    return Promise.reject(new Error("Aborted before acquiring account lease"));
  }

  const slot = getSlot(accountId);

  // Fast path: capacity available
  if (slot.active < config.concurrency.maxStreamsPerAccount) {
    slot.active++;
    return Promise.resolve(createLease(accountId));
  }

  const timeoutMs = options?.timeoutMs ?? config.concurrency.busyWaitMs;

  return new Promise<AccountLease>((resolve, reject) => {
    const entry: QueueEntry = {
      resolve,
      reject,
      timer: null,
      onAbort: null,
      signal,
    };

    const removeSelf = () => {
      const idx = slot.queue.indexOf(entry);
      if (idx !== -1) slot.queue.splice(idx, 1);
      cleanupEntry(entry);
      if (slot.active === 0 && slot.queue.length === 0) {
        slots.delete(accountId);
      }
    };

    // Timeout
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        removeSelf();
        reject(
          new Error(
            `Account ${accountId} busy: timed out after ${timeoutMs}ms waiting for a free slot`,
          ),
        );
      }, timeoutMs);
      entry.timer.unref?.();
    }

    // Abort signal
    if (signal) {
      entry.onAbort = () => {
        removeSelf();
        reject(new Error("Aborted while waiting for account lease"));
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
    }

    slot.queue.push(entry);

    logger.debug("[concurrency] queued for account lease", {
      accountId,
      active: slot.active,
      queueLength: slot.queue.length,
      timeoutMs,
    });
  });
}

/**
 * Check whether an account currently has no free slots.
 */
export function isAccountBusy(accountId: string): boolean {
  const slot = slots.get(accountId);
  if (!slot) return false;
  return slot.active >= config.concurrency.maxStreamsPerAccount;
}

/**
 * Mark an account as temporarily busy (e.g. after chat_in_progress).
 * This is a lightweight hint that prevents immediate re-selection without
 * consuming a lease slot.
 */
const temporaryBusyUntil = new Map<string, number>();

export function markAccountTemporarilyBusy(
  accountId: string,
  durationMs: number,
): void {
  temporaryBusyUntil.set(accountId, Date.now() + durationMs);
}

export function isAccountTemporarilyBusy(accountId: string): boolean {
  const until = temporaryBusyUntil.get(accountId);
  if (!until) return false;
  if (Date.now() >= until) {
    temporaryBusyUntil.delete(accountId);
    return false;
  }
  return true;
}

export function clearTemporaryBusy(accountId: string): void {
  temporaryBusyUntil.delete(accountId);
}

/**
 * Snapshot for logging/metrics.
 */
export function getAccountConcurrencySnapshot(): Array<{
  accountId: string;
  active: number;
  waiting: number;
  limit: number;
}> {
  const result: Array<{
    accountId: string;
    active: number;
    waiting: number;
    limit: number;
  }> = [];
  for (const [accountId, slot] of slots) {
    result.push({
      accountId,
      active: slot.active,
      waiting: slot.queue.length,
      limit: config.concurrency.maxStreamsPerAccount,
    });
  }
  return result;
}

/**
 * Reset all state. For tests only.
 */
export function resetAccountConcurrencyForTests(): void {
  for (const [, slot] of slots) {
    for (const entry of slot.queue) {
      cleanupEntry(entry);
      entry.reject(new Error("Reset for tests"));
    }
  }
  slots.clear();
  temporaryBusyUntil.clear();
}
