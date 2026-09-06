import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..", "..");
const binPath = path.join(packageRoot, "bin", "qwenproxy.js");

test("CLI: --version outputs version and exits with code 0", () => {
  const result = spawnSync(process.execPath, [binPath, "--version"], {
    encoding: "utf-8",
  });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("QwenProxy v"));
});

test("CLI: --help outputs usage options and exits with code 0", () => {
  const result = spawnSync(process.execPath, [binPath, "--help"], {
    encoding: "utf-8",
  });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("Usage:"));
  assert.ok(result.stdout.includes("qwenproxy"));
  assert.ok(result.stdout.includes("qpx"));
  assert.ok(result.stdout.includes("Commands:"));
});
