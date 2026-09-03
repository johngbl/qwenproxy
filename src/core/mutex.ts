import { logger } from "./logger.js";

/**
 * Maximum time a mutex can be held before it's considered leaked and
 * force-released. Overridable via MUTEX_MAX_HOLD_MS for tests.
 */
const MAX_HOLD_MS = (() => {
  const parsed = parseInt(process.env.MUTEX_MAX_HOLD_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
})();

export class Mutex {
  private queue: Array<{ waiter: () => void; enqueuedAt: number; key: string }> = [];
  private locked = false;
  private lockedAt = 0;
  private lockedByKey = "";

  constructor(
    public readonly name: string = "unnamed",
    private readonly maxHoldMs: number = MAX_HOLD_MS,
  ) {}

  async acquire(timeoutMs = 300_000, key = ""): Promise<() => void> {
    // Stale detection: force-release if held beyond the hold limit
    // (leaked lock). The chat lock uses a longer hold so a legitimate
    // long generation (2-3 min with huge contexts) is not force-released
    // mid-stream; the page/init locks keep the shorter safety net so a
    // stuck browser op releases the account back to the pool faster.
    const holdLimitMs = this.maxHoldMs;
    if (this.locked && Date.now() - this.lockedAt > holdLimitMs) {
      const heldFor = Date.now() - this.lockedAt;
      logger.warn(
        `[Mutex:${this.name}] Force-releasing stale lock | heldBy=${this.lockedByKey} | heldFor=${heldFor}ms | limit=${holdLimitMs}ms`,
      );
      this.locked = false;
      this.lockedAt = 0;
      this.lockedByKey = "";
    }

    if (!this.locked) {
      this.locked = true;
      this.lockedAt = Date.now();
      this.lockedByKey = key;
      return this.createRelease();
    }

    const enqueuedAt = Date.now();
    const logKey = key || "anon";
    if (logger.isLevelEnabled("debug")) {
      logger.debug(`[Mutex:${this.name}] enqueue key=${logKey} queue=${this.queue.length + 1} heldBy=${this.lockedByKey || "unknown"} heldFor=${Date.now() - this.lockedAt}ms`);
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter = () => {
        clearTimeout(timer);
        this.lockedByKey = logKey;
        this.lockedAt = Date.now();
        resolve(this.createRelease());
      };
      const timer = setTimeout(() => {
        const index = this.queue.findIndex((e) => e.waiter === waiter);
        if (index !== -1) this.queue.splice(index, 1);
        const heldFor = Date.now() - this.lockedAt;
        logger.warn(`[Mutex:${this.name}] TIMEOUT key=${logKey} waited=${timeoutMs}ms heldBy=${this.lockedByKey || "unknown"} heldFor=${heldFor}ms queueLeft=${this.queue.length}`);
        reject(new Error(`Mutex[${this.name}] acquire timeout after ${timeoutMs}ms (held by ${this.lockedByKey || "unknown"} for ${heldFor}ms)`));
      }, timeoutMs);
      this.queue.push({ waiter, enqueuedAt, key: logKey });
    });
  }

  async withLock<T>(fn: () => Promise<T> | T, timeoutMs?: number): Promise<T> {
    const release = await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      const waitTime = Date.now() - next.enqueuedAt;
      if (waitTime > 1_000 && logger.isLevelEnabled("debug")) {
        logger.debug(`[Mutex:${this.name}] dequeued key=${next.key} waited=${waitTime}ms`);
      }
      next.waiter();
      return;
    }

    this.locked = false;
    this.lockedAt = 0;
    this.lockedByKey = "";
  }

  /** Returns true if the mutex is not locked and has no waiting queue. */
  isIdle(): boolean {
    return !this.locked && this.queue.length === 0;
  }

  /** Returns diagnostic info about the current lock state. */
  state(): { locked: boolean; heldBy: string; heldForMs: number; queueLength: number } {
    return {
      locked: this.locked,
      heldBy: this.lockedByKey,
      heldForMs: this.locked ? Date.now() - this.lockedAt : 0,
      queueLength: this.queue.length,
    };
  }
}
