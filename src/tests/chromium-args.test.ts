import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../core/config.ts";
import { buildChromiumLaunchArgs } from "../services/playwright.ts";

test("buildChromiumLaunchArgs includes low-memory heap cap by default", () => {
  assert.equal(config.playwright.lowMemoryFlags, true);
  const args = buildChromiumLaunchArgs({ width: 1280, height: 720 });

  assert.ok(args.includes("--disable-dev-shm-usage"));
  assert.ok(args.includes("--disable-gpu"));
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
