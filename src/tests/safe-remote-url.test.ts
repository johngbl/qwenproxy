import test from "node:test";
import assert from "node:assert/strict";
import {
  UnsafeRemoteUrlError,
  assertSafeRemoteMediaUrl,
  isPrivateOrLocalIp,
} from "../core/safe-remote-url.ts";

test("safe-remote-url: private IP detection", () => {
  assert.equal(isPrivateOrLocalIp("127.0.0.1"), true);
  assert.equal(isPrivateOrLocalIp("10.0.0.8"), true);
  assert.equal(isPrivateOrLocalIp("192.168.1.1"), true);
  assert.equal(isPrivateOrLocalIp("169.254.169.254"), true);
  assert.equal(isPrivateOrLocalIp("::1"), true);
  assert.equal(isPrivateOrLocalIp("8.8.8.8"), false);
});

test("safe-remote-url: blocks localhost, metadata, and file URLs", async () => {
  await assert.rejects(
    () => assertSafeRemoteMediaUrl("http://127.0.0.1/secret"),
    UnsafeRemoteUrlError,
  );
  await assert.rejects(
    () => assertSafeRemoteMediaUrl("http://localhost/admin"),
    UnsafeRemoteUrlError,
  );
  await assert.rejects(
    () => assertSafeRemoteMediaUrl("http://169.254.169.254/latest/meta-data/"),
    UnsafeRemoteUrlError,
  );
  await assert.rejects(
    () => assertSafeRemoteMediaUrl("file:///etc/passwd"),
    UnsafeRemoteUrlError,
  );
});
