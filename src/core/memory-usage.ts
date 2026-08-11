import v8 from "v8";
import os from "os";

/**
 * Heap pressure relative to V8 heap_size_limit (not heapTotal).
 * heapUsed/heapTotal is almost always high (~95%+) and caused false criticals.
 */
export interface HeapUsageSnapshot {
  heapUsed: number;
  heapTotal: number;
  heapSizeLimit: number;
  rss: number;
  usagePercent: number;
}

export function getHeapUsageSnapshot(
  mem: NodeJS.MemoryUsage = process.memoryUsage(),
  heapSizeLimit: number = v8.getHeapStatistics().heap_size_limit,
): HeapUsageSnapshot {
  const limit =
    Number.isFinite(heapSizeLimit) && heapSizeLimit > 0
      ? heapSizeLimit
      : Math.max(mem.heapTotal, 1);
  const usagePercent = (mem.heapUsed / limit) * 100;
  return {
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    heapSizeLimit: limit,
    rss: mem.rss,
    usagePercent,
  };
}

export function classifyRamUsage(
  usagePercent: number,
  warningThreshold: number,
  criticalThreshold: number,
): "ok" | "warning" | "critical" {
  if (usagePercent > criticalThreshold) return "critical";
  if (usagePercent > warningThreshold) return "warning";
  return "ok";
}

/**
 * RSS pressure relative to TOTAL system memory. The heap-vs-limit ratio misses
 * Playwright browser processes (RSS lives outside the V8 heap); RSS vs total
 * RAM is the metric that actually predicts OOM on a VPS.
 */
export interface RssUsageSnapshot {
  rss: number;
  totalSystemMemory: number;
  /** RSS as a percentage of total system memory. */
  usagePercent: number;
}

export function getRssUsageSnapshot(
  mem: NodeJS.MemoryUsage = process.memoryUsage(),
  totalSystemMemory: number = os.totalmem(),
): RssUsageSnapshot {
  const usagePercent =
    Number.isFinite(totalSystemMemory) && totalSystemMemory > 0
      ? (mem.rss / totalSystemMemory) * 100
      : 0;
  return {
    rss: mem.rss,
    totalSystemMemory,
    usagePercent,
  };
}

/** % of system RAM used by this process (RSS), rounded to one decimal. */
export function getMemoryUsagePct(
  mem: NodeJS.MemoryUsage = process.memoryUsage(),
  totalSystemMemory: number = os.totalmem(),
): number {
  const snap = getRssUsageSnapshot(mem, totalSystemMemory);
  if (
    !Number.isFinite(snap.rss) ||
    snap.totalSystemMemory <= 0
  ) {
    return 0;
  }
  return Number(snap.usagePercent.toFixed(1));
}
