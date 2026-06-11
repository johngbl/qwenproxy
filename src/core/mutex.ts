/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(timeoutMs = 300_000): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return this.createRelease();
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(this.createRelease());
      };
      const timer = setTimeout(() => {
        const index = this.queue.indexOf(waiter);
        if (index !== -1) this.queue.splice(index, 1);
        reject(new Error(`Mutex acquire timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.queue.push(waiter);
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
      next();
      return;
    }

    this.locked = false;
  }

  /** Returns true if the mutex is not locked and has no waiting queue. */
  isIdle(): boolean {
    return !this.locked && this.queue.length === 0;
  }
}
