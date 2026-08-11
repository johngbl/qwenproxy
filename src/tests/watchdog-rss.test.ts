import { test, mock } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import {
  classifyRamUsage,
  getMemoryUsagePct,
  getRssUsageSnapshot,
} from "../core/memory-usage.ts";
import { Watchdog } from "../core/watchdog.ts";

test("getRssUsageSnapshot computes RSS share of system memory", () => {
  const mem = {
    rss: 2_000_000_000,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
  } as NodeJS.MemoryUsage;
  const snap = getRssUsageSnapshot(mem, 8 * 1024 ** 3);
  assert.equal(snap.rss, 2_000_000_000);
  assert.equal(snap.totalSystemMemory, 8 * 1024 ** 3);
  // 2e9 / 8GiB ≈ 23.28%
  assert.ok(Math.abs(snap.usagePercent - 23.28) < 0.1);
  assert.equal(classifyRamUsage(snap.usagePercent, 20, 90), "warning");
});

test("getRssUsageSnapshot degrades gracefully when total memory is unknown", () => {
  const mem = {
    rss: 100_000_000,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
  } as NodeJS.MemoryUsage;
  const snap = getRssUsageSnapshot(mem, 0);
  assert.equal(snap.usagePercent, 0);
  assert.equal(classifyRamUsage(snap.usagePercent, 80, 95), "ok");
});

test("getMemoryUsagePct rounds RSS share to one decimal", () => {
  const mem = {
    rss: 1_000_000_000,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
  } as NodeJS.MemoryUsage;
  assert.equal(getMemoryUsagePct(mem, 3_000_000_000), 33.3);
});

test("Watchdog classifies RAM from RSS, not heap", async () => {
  // Huge heap vs limit (old classifier -> critical) but tiny RSS (new -> ok).
  mock.method(process, "memoryUsage", () => ({
    rss: 200_000_000,
    heapTotal: 300_000_000,
    heapUsed: 10_000_000_000, // far above any real heap_size_limit
    external: 0,
    arrayBuffers: 0,
  }));
  mock.method(os, "totalmem", () => 8 * 1024 ** 3);
  try {
    const watchdog = new Watchdog();
    const status = await watchdog.getStatus();
    assert.ok(status.heap);
    assert.ok(
      status.heap.usagePercent > 90,
      `heap should read extreme: ${status.heap.usagePercent}`,
    );
    assert.ok(status.rss);
    assert.ok(status.rss.usagePercent < 5);
    assert.equal(status.ram, "ok");
    assert.equal(status.overall, "healthy");
  } finally {
    mock.restoreAll();
  }
});

test("Watchdog reports critical RAM when RSS exceeds the critical threshold", async () => {
  mock.method(process, "memoryUsage", () => ({
    rss: 7.7 * 1024 ** 3, // 96.25% of 8 GiB — strictly above the 95% threshold
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
  }));
  mock.method(os, "totalmem", () => 8 * 1024 ** 3);
  try {
    const watchdog = new Watchdog();
    const status = await watchdog.getStatus();
    assert.equal(status.ram, "critical");
    assert.equal(status.overall, "unhealthy");
  } finally {
    mock.restoreAll();
  }
});
