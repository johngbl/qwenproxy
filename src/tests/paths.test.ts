import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  getDataDir,
  getDbDir,
  getDbPath,
  getEncryptionKeyPath,
  getProfilesDir,
  getAccountPriorityPath,
  getSyncStatePath,
  ensureDataDirs,
  resolveDataDir,
} from "../core/paths.ts";

test("Paths: resolveDataDir respects explicit QWEN_DATA_DIR env variable", () => {
  const customPath = path.resolve("custom-data-dir");
  const resolved = resolveDataDir({
    envDataDir: customPath,
    isNodeTest: false,
    localDataExists: false,
  });
  assert.equal(resolved, customPath);
});

test("Paths: resolveDataDir returns data-test when running under node test", () => {
  const resolved = resolveDataDir({
    isNodeTest: true,
    localDataExists: false,
  });
  assert.equal(resolved, path.resolve("data-test"));
});

test("Paths: resolveDataDir prefers local data directory when developing in checkout", () => {
  const resolved = resolveDataDir({
    isNodeTest: false,
    localDataExists: true,
  });
  assert.equal(resolved, path.resolve("data"));
});

test("Paths: resolveDataDir resolves to OS global user directory when not in local checkout", () => {
  const resolved = resolveDataDir({
    isNodeTest: false,
    localDataExists: false,
    platform: "win32",
    appData: "C:\\Users\\Test\\AppData\\Roaming",
  });
  const expectedWin = (path.win32 || path).join("C:\\Users\\Test\\AppData\\Roaming", "qwenproxy");
  assert.equal(resolved, expectedWin);

  const resolvedLinux = resolveDataDir({
    isNodeTest: false,
    localDataExists: false,
    platform: "linux",
    homeDir: "/home/test",
  });
  assert.equal(resolvedLinux, path.join("/home/test", ".local", "share", "qwenproxy"));
});

test("Paths: helper accessors produce properly nested paths under data dir", () => {
  const dataDir = getDataDir();
  assert.equal(getDbDir(), path.join(dataDir, "db"));
  assert.equal(getDbPath(), path.join(dataDir, "db", "qwenproxy.db"));
  assert.equal(getEncryptionKeyPath(), path.join(dataDir, "db", ".encryption_key"));
  assert.equal(getProfilesDir(), path.join(dataDir, "qwen_profiles"));
  assert.equal(getAccountPriorityPath(), path.join(dataDir, "account-priority.json"));
  assert.equal(getSyncStatePath(), path.join(dataDir, "sync-state.json"));
});

test("Paths: ensureDataDirs creates all directory structures cleanly without throwing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-paths-test-"));
  try {
    ensureDataDirs(tmpDir);
    assert.ok(fs.existsSync(tmpDir));
    assert.ok(fs.existsSync(path.join(tmpDir, "db")));
    assert.ok(fs.existsSync(path.join(tmpDir, "qwen_profiles")));
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
