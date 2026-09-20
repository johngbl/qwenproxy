import test from "node:test";
import assert from "node:assert/strict";
import {
  PLACEHOLDER_API_KEY,
  assertBindAllowed,
  isLoopbackHost,
  isPlaceholderApiKey,
  isWildcardBind,
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
