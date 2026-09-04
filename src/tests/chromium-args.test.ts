import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../core/config.ts";
import { buildChromiumLaunchArgs } from "../services/playwright.ts";

test("buildChromiumLaunchArgs includes low-memory heap cap by default", () => {
  assert.equal(config.playwright.lowMemoryFlags, true);
  const args = buildChromiumLaunchArgs({ width: 1280, height: 720 });

  assert.ok(args.includes("--disable-dev-shm-usage"));
  assert.ok(args.includes("--enable-webgl"));
  assert.ok(args.includes("--ignore-gpu-blocklist"));
  assert.ok(args.includes("--enable-accelerated-2d-canvas"));
  assert.ok(!args.includes("--disable-gpu"), "--disable-gpu is a detection signal and must not be present");
  assert.ok(
    args.some((arg) =>
      arg.startsWith(
        `--js-flags=--max-old-space-size=${config.playwright.jsHeapMb}`,
      ),
    ),
    "expected js-flags max-old-space-size",
  );
  assert.ok(args.includes("--renderer-process-limit=2"));
  assert.ok(args.includes("--window-size=1280,720"));
});

test("buildChromiumLaunchArgs includes resource-saving background and disk-cache flags", () => {
  const args = buildChromiumLaunchArgs({ width: 1280, height: 720 });
  assert.ok(args.includes("--disable-breakpad"));
  assert.ok(args.includes("--disable-component-update"));
  assert.ok(args.includes("--disable-domain-reliability"));
  assert.ok(args.includes("--disable-gpu-shader-disk-cache"));
  assert.ok(
    args.some((arg) =>
      arg.startsWith("--disable-features=") &&
      arg.includes("Translate") &&
      arg.includes("OptimizationHints") &&
      arg.includes("MediaRouter")
    ),
    "expected disabled features including Translate, OptimizationHints, MediaRouter",
  );
});

test("prunePlaywrightProfileCaches safely removes transient cache directories while preserving session state", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const { prunePlaywrightProfileCaches } = await import("../services/playwright.ts");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-profile-prune-"));
  try {
    const defaultDir = path.join(tmpDir, "Default");
    fs.mkdirSync(path.join(defaultDir, "Local Storage", "leveldb"), { recursive: true });
    fs.mkdirSync(path.join(defaultDir, "IndexedDB", "qwen.indexeddb"), { recursive: true });
    fs.mkdirSync(path.join(defaultDir, "Code Cache", "js"), { recursive: true });
    fs.mkdirSync(path.join(defaultDir, "Cache"), { recursive: true });
    fs.mkdirSync(path.join(defaultDir, "GPUCache"), { recursive: true });

    // Session files (must NOT be deleted)
    fs.writeFileSync(path.join(defaultDir, "Cookies"), "session-cookie-data");
    fs.writeFileSync(path.join(defaultDir, "Local Storage", "leveldb", "000001.log"), "local-storage-data");
    fs.writeFileSync(path.join(defaultDir, "IndexedDB", "qwen.indexeddb", "data.blob"), "indexeddb-data");

    // Transient cache files (MUST be deleted)
    fs.writeFileSync(path.join(defaultDir, "Code Cache", "js", "v8_cached_code.bin"), "v8-cache-content");
    fs.writeFileSync(path.join(defaultDir, "Cache", "http_cache.bin"), "http-cache-content");
    fs.writeFileSync(path.join(defaultDir, "GPUCache", "gpu_shader.bin"), "shader-cache-content");

    const result = prunePlaywrightProfileCaches(tmpDir);
    assert.equal(result.freedFiles, 3);
    assert.ok(result.freedBytes > 0);

    // Transient caches deleted
    assert.equal(fs.existsSync(path.join(defaultDir, "Code Cache")), false);
    assert.equal(fs.existsSync(path.join(defaultDir, "Cache")), false);
    assert.equal(fs.existsSync(path.join(defaultDir, "GPUCache")), false);

    // Crucial session state PRESERVED intact
    assert.equal(fs.existsSync(path.join(defaultDir, "Cookies")), true);
    assert.equal(fs.readFileSync(path.join(defaultDir, "Cookies"), "utf-8"), "session-cookie-data");
    assert.equal(fs.existsSync(path.join(defaultDir, "Local Storage", "leveldb", "000001.log")), true);
    assert.equal(fs.existsSync(path.join(defaultDir, "IndexedDB", "qwen.indexeddb", "data.blob")), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
