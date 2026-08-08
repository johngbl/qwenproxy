/**
 * Per-account concurrency guard. Limits the number of simultaneous upstream
 * streams per account and queues excess requests with FIFO ordering, timeout,
 * and abort support.
 *
 * Includes stale-lease detection: if a lease is held longer than
 * `concurrency.leaseMaxDurationMs` it is considered leaked and force-released.
 */

import { config } from "./config.ts";
import { logger } from "./logger.ts";

export interface AccountLease {
  accountId: string;
  /** Unique id for correlating lease acquire/release in logs. */
  leaseId: string;
  release(): void;
}

export interface AcquireAccountLeaseOptions {
  signal?: AbortSignal;
  /**
   * Deadline for hanging on a free slot.
   * - `number`: reject with `account_busy` after this many ms.
   * - `null`: wait without a deadline until a slot frees or `signal` aborts.
   * - `undefined`: fall back to `concurrency.busyWaitMs`.
   */
  timeoutMs?: number | null;
  /** Human-readable label for diagnostics (e.g. reqId or chat session). */
  label?: string;
}

interface ActiveLeaseInfo {
  leaseId: string;
  acquiredAt: number;
  label: string;
}

interface QueueEntry {
  resolve: (lease: AccountLease) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  signal: AbortSignal | null;
  enqueuedAt: number;
}

interface AccountSlot {
  activeLeases: ActiveLeaseInfo[];
  queue: QueueEntry[];
}

const slots = new Map<string, AccountSlot>();
let leaseCounter = 0;

function generateLeaseId(): string {
  return `lease_${(++leaseCounter).toString(36)}_${Date.now().toString(36)}`;
}

function getSlot(accountId: string): AccountSlot {
  let slot = slots.get(accountId);
  if (!slot) {
    slot = { activeLeases: [], queue: [] };
    slots.set(accountId, slot);
  }
  return slot;
}

/** Format active lease holders for log output. */
function formatHolders(slot: AccountSlot): string {
  if (slot.activeLeases.length === 0) return "none";
  const now = Date.now();
  return slot.activeLeases
    .map((l) => `${l.label || "unknown"}(held ${Math.round((now - l.acquiredAt) / 1000)}s)`)
    .join(", ");
}

function createLease(accountId: string, label: string): AccountLease {
  const leaseId = generateLeaseId();
  const slot = getSlot(accountId);
  const info: ActiveLeaseInfo = { leaseId, acquiredAt: Date.now(), label };
  slot.activeLeases.push(info);

  let released = false;
  return {
    accountId,
    leaseId,
    release() {
      if (released) return;
      released = true;
      const idx = slot.activeLeases.findIndex((l) => l.leaseId === leaseId);
      if (idx !== -1) slot.activeLeases.splice(idx, 1);
      releaseSlot(accountId);
    },
  };
}

function releaseSlot(accountId: string): void {
  const slot = slots.get(accountId);
  if (!slot) return;

  // Deliver to the next waiter in FIFO order
  while (slot.queue.length > 0 && slot.activeLeases.length < config.concurrency.maxStreamsPerAccount) {
    const entry = slot.queue.shift();
    if (!entry) break;
    cleanupEntry(entry);
    console.log(
      `🚦 [Server] Stream slot granted | account=${accountId} | waited ${Date.now() - entry.enqueuedAt}ms | ${slot.queue.length} still queued`,
    );
    entry.resolve(createLease(accountId, "queued-request"));
    return; // one at a time to preserve ordering
  }

  // Clean up empty slots to avoid unbounded map growth
  if (slot.activeLeases.length === 0 && slot.queue.length === 0) {
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
 * Check for and force-release stale leases that exceeded the max duration.
 * Returns the number of leases force-released.
 */
function sweepStaleLeases(accountId: string): number {
  const slot = slots.get(accountId);
  if (!slot) return 0;

  const maxDuration = config.concurrency.leaseMaxDurationMs;
  if (maxDuration <= 0) return 0;

  const now = Date.now();
  let swept = 0;

  for (let i = slot.activeLeases.length - 1; i >= 0; i--) {
    const lease = slot.activeLeases[i];
    const heldMs = now - lease.acquiredAt;
    if (heldMs > maxDuration) {
      slot.activeLeases.splice(i, 1);
      swept++;
      console.warn(
        `⚠️  [Server] Stale lease force-released | account=${accountId} | label=${lease.label} | held ${Math.round(heldMs / 1000)}s (limit: ${Math.round(maxDuration / 1000)}s) | leaseId=${lease.leaseId}`,
      );
      logger.warn("[concurrency] stale lease force-released (possible leak)", {
        accountId,
        leaseId: lease.leaseId,
        label: lease.label,
        heldMs,
        maxDurationMs: maxDuration,
      });
    }
  }

  // If we swept any, try to deliver to waiters
  if (swept > 0) {
    releaseSlot(accountId);
  }

  return swept;
}

/**
 * Try to acquire a lease without waiting. Returns null if the account is at
 * capacity.
 */
export function tryAcquireAccountLease(accountId: string, label?: string): AccountLease | null {
  const slot = getSlot(accountId);
  sweepStaleLeases(accountId);
  if (slot.activeLeases.length < config.concurrency.maxStreamsPerAccount) {
    return createLease(accountId, label ?? "try-acquire");
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
  const label = options?.label ?? "unlabeled";

  // Already aborted — reject before touching any slot
  if (signal?.aborted) {
    return Promise.reject(new Error("Aborted before acquiring account lease"));
  }

  const slot = getSlot(accountId);

  // Sweep stale leases before checking capacity — a leaked lease should not
  // block new requests indefinitely.
  sweepStaleLeases(accountId);

  // Fast path: capacity available
  if (slot.activeLeases.length < config.concurrency.maxStreamsPerAccount) {
    return Promise.resolve(createLease(accountId, label));
  }

  const hasExplicitTimeout =
    options != null &&
    Object.prototype.hasOwnProperty.call(options, "timeoutMs");
  const timeoutMs = hasExplicitTimeout
    ? options?.timeoutMs
    : config.concurrency.busyWaitMs;

  return new Promise<AccountLease>((resolve, reject) => {
    const entry: QueueEntry = {
      resolve,
      reject,
      timer: null,
      onAbort: null,
      signal,
      enqueuedAt: Date.now(),
    };

    const removeSelf = () => {
      const idx = slot.queue.indexOf(entry);
      if (idx !== -1) slot.queue.splice(idx, 1);
      cleanupEntry(entry);
      if (slot.activeLeases.length === 0 && slot.queue.length === 0) {
        slots.delete(accountId);
      }
    };

    // Timeout — only when the caller supplied a finite deadline. `null` means
    // "wait as long as it takes" (bounded by the abort signal), which is what
    // the last-usable account or the thread owner must do to stay lossless.
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        removeSelf();
        console.log(
          `🚦 [Server] Stream wait timeout | account=${accountId} | waited ${timeoutMs}ms | ${slot.queue.length} still queued`,
        );
        const busyError = new Error(
          `Account ${accountId} busy: timed out after ${timeoutMs}ms waiting for a free slot`,
        ) as Error & { code?: string };
        busyError.code = "account_busy";
        reject(busyError);
      }, timeoutMs);
    }

    // Abort signal
    if (signal) {
      entry.onAbort = () => {
        removeSelf();
        console.log(
          `🚦 [Server] Stream waiter aborted | account=${accountId} | waited ${Date.now() - entry.enqueuedAt}ms | ${slot.queue.length} still queued`,
        );
        reject(new Error("Aborted while waiting for account lease"));
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
    }

    slot.queue.push(entry);

    const holders = formatHolders(slot);
    console.log(
      `🚦 [Server] Stream slot busy | account=${accountId} | held by: ${holders} | queued at position ${slot.queue.length} | timeout=${typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? `${timeoutMs}ms` : "unbounded"}`,
    );

    logger.debug("[concurrency] queued for account lease", {
      accountId,
      activeLeases: slot.activeLeases.length,
      holders: slot.activeLeases.map((l) => ({ label: l.label, heldMs: Date.now() - l.acquiredAt })),
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
  return slot.activeLeases.length >= config.concurrency.maxStreamsPerAccount;
}

/**
 * Check whether an account is currently serving at least one stream.
 * Different question from isAccountBusy: that one answers "are all slots
 * taken", while callers that must not disturb a generation in flight care
 * about a single active lease even when spare slots remain.
 */
export function hasActiveAccountLease(accountId: string): boolean {
  const slot = slots.get(accountId);
  if (!slot) return false;
  return slot.activeLeases.length > 0;
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
): number {
  const requestedUntil = Date.now() + Math.max(0, durationMs);
  const currentUntil = temporaryBusyUntil.get(accountId) ?? 0;
  const effectiveUntil = Math.max(currentUntil, requestedUntil);
  temporaryBusyUntil.set(accountId, effectiveUntil);
  return effectiveUntil;
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

export function clearTemporaryBusy(
  accountId: string,
  expectedUntil?: number,
): void {
  if (
    expectedUntil !== undefined &&
    temporaryBusyUntil.get(accountId) !== expectedUntil
  ) {
    return;
  }
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
  holders: Array<{ label: string; heldMs: number }>;
}> {
  const result: Array<{
    accountId: string;
    active: number;
    waiting: number;
    limit: number;
    holders: Array<{ label: string; heldMs: number }>;
  }> = [];
  const now = Date.now();
  for (const [accountId, slot] of slots) {
    result.push({
      accountId,
      active: slot.activeLeases.length,
      waiting: slot.queue.length,
      limit: config.concurrency.maxStreamsPerAccount,
      holders: slot.activeLeases.map((l) => ({
        label: l.label,
        heldMs: now - l.acquiredAt,
      })),
    });
  }
  return result;
}

/**
 * Sweep all accounts for stale leases. Call periodically (e.g. from a timer
 * or before each request batch) to catch leaked leases proactively.
 */
export function sweepAllStaleLeases(): number {
  let total = 0;
  for (const accountId of slots.keys()) {
    total += sweepStaleLeases(accountId);
  }
  return total;
}

// Periodic stale-lease sweep: runs every 30s to catch leaked leases even when
// no new requests arrive. This is the safety net that prevents "slot busy
// forever" from a single missed release() call.
const SWEEP_INTERVAL_MS = 30_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startLeaseSweepTimer(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const swept = sweepAllStaleLeases();
    if (swept > 0) {
      logger.info("[concurrency] periodic stale lease sweep", { swept });
    }
  }, SWEEP_INTERVAL_MS);
  // Allow the process to exit even if the timer is running
  if (sweepTimer && typeof sweepTimer === "object" && "unref" in sweepTimer) {
    (sweepTimer as NodeJS.Timeout).unref();
  }
}

export function stopLeaseSweepTimer(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/**
 * Reset all state. For tests only.
 */
export function resetAccountConcurrencyForTests(): void {
  stopLeaseSweepTimer();
  for (const [, slot] of slots) {
    for (const entry of slot.queue) {
      cleanupEntry(entry);
      entry.reject(new Error("Reset for tests"));
    }
  }
  slots.clear();
  temporaryBusyUntil.clear();
  leaseCounter = 0;
}
