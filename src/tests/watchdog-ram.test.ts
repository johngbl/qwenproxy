import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRamUsage,
  getHeapUsageSnapshot,
} from "../core/memory-usage.ts";
import { Watchdog } from "../core/watchdog.ts";

test("getHeapUsageSnapshot uses heap_size_limit denominator, not heapTotal", () => {
  const mem = {
    rss: 200_000_000,
    heapTotal: 50_000_000,
    heapUsed: 48_000_000, // ~96% of heapTotal — old bug would mark critical
    external: 0,
    arrayBuffers: 0,
  } as NodeJS.MemoryUsage;

  const limit = 512 * 1024 * 1024;
  const snap = getHeapUsageSnapshot(mem, limit);

  assert.equal(snap.heapUsed, 48_000_000);
  assert.equal(snap.heapTotal, 50_000_000);
  assert.equal(snap.heapSizeLimit, limit);
  // 48e6 / (512 * 1024^2) ≈ 8.94% — healthy vs limit (would be ~96% vs heapTotal)
  assert.ok(snap.usagePercent > 8 && snap.usagePercent < 10);
  assert.equal(classifyRamUsage(snap.usagePercent, 80, 95), "ok");
  assert.equal(classifyRamUsage((mem.heapUsed / mem.heapTotal) * 100, 80, 95), "critical");
});

test("classifyRamUsage thresholds", () => {
  assert.equal(classifyRamUsage(10, 80, 95), "ok");
  assert.equal(classifyRamUsage(81, 80, 95), "warning");
  assert.equal(classifyRamUsage(96, 80, 95), "critical");
});

test("Watchdog.getStatus reports heap snapshot with limit", async () => {
  const watchdog = new Watchdog();
  const status = await watchdog.getStatus();
  assert.ok(status.heap);
  assert.ok(status.heap.heapSizeLimit > 0);
  assert.ok(status.heap.usagePercent >= 0);
  // Real process: usage vs limit should almost never be near 95%
  assert.ok(
    status.heap.usagePercent < 90,
    `unexpectedly high heap pressure in test process: ${status.heap.usagePercent}`,
  );
  assert.ok(["ok", "warning", "critical"].includes(status.ram));
  assert.ok(["healthy", "degraded", "unhealthy"].includes(status.overall));
});
