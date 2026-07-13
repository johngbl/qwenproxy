import v8 from "v8";

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
