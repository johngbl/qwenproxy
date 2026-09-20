import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PLACEHOLDER_API_KEY,
  assertBindAllowed,
  isLoopbackHost,
  isPlaceholderApiKey,
  isWildcardBind,
  persistApiKey,
} from "../core/local-auth.ts";

test("local-auth: loopback and placeholder helpers", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isWildcardBind("0.0.0.0"), true);
  assert.equal(isPlaceholderApiKey(""), true);
  assert.equal(isPlaceholderApiKey(PLACEHOLDER_API_KEY), true);
  assert.equal(isPlaceholderApiKey("sk-real-key"), false);
});

test("local-auth: wildcard bind requires a real API key", () => {
  assert.doesNotThrow(() => assertBindAllowed("127.0.0.1", ""));
  assert.throws(
    () => assertBindAllowed("0.0.0.0", ""),
    /requires a strong API_KEY/,
  );
  assert.throws(
    () => assertBindAllowed("0.0.0.0", PLACEHOLDER_API_KEY),
    /requires a strong API_KEY/,
  );
  assert.doesNotThrow(() => assertBindAllowed("0.0.0.0", "sk-real-key"));
});

test("local-auth: persistApiKey replaces an empty existing assignment", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwenproxy-auth-"));
  const envPath = path.join(tempDir, ".env");

  try {
    fs.writeFileSync(envPath, "PORT=7936\r\nAPI_KEY=   \r\nHOST=127.0.0.1\r\n");
    persistApiKey("sk-generated", envPath);

    assert.equal(
      fs.readFileSync(envPath, "utf8"),
      "PORT=7936\r\nAPI_KEY=sk-generated\r\nHOST=127.0.0.1\r\n",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("local-auth: persistApiKey preserves a non-empty existing assignment", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwenproxy-auth-"));
  const envPath = path.join(tempDir, ".env");

  try {
    fs.writeFileSync(envPath, "API_KEY=sk-existing\n");
    persistApiKey("sk-generated", envPath);

    assert.equal(fs.readFileSync(envPath, "utf8"), "API_KEY=sk-existing\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
