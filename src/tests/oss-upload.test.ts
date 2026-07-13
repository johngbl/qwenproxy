import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "stream";
import {
  uploadBufferToOssClient,
  type OssUploadClient,
} from "../routes/upload.ts";

function createMockClient() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client: OssUploadClient = {
    putStream: async (...args) => {
      calls.push({ method: "putStream", args });
      return {};
    },
    multipartUpload: async (...args) => {
      calls.push({ method: "multipartUpload", args });
      return {};
    },
  };
  return { client, calls };
}

test("uploadBufferToOssClient uses putStream for small payloads", async () => {
  const { client, calls } = createMockClient();
  const buffer = Buffer.alloc(1024, 1);
  const mode = await uploadBufferToOssClient(
    client,
    "path/file.png",
    buffer,
    "image/png",
    5 * 1024 * 1024,
  );

  assert.equal(mode, "putStream");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "putStream");
  assert.equal(calls[0].args[0], "path/file.png");
  assert.ok(calls[0].args[1] instanceof Readable);
  assert.deepEqual(calls[0].args[2], {
    contentLength: 1024,
    headers: { "Content-Type": "image/png" },
  });
});

test("uploadBufferToOssClient uses multipart for large payloads", async () => {
  const { client, calls } = createMockClient();
  const buffer = Buffer.alloc(6 * 1024 * 1024, 2);
  const mode = await uploadBufferToOssClient(
    client,
    "path/big.bin",
    buffer,
    "application/octet-stream",
    5 * 1024 * 1024,
  );

  assert.equal(mode, "multipart");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "multipartUpload");
  assert.equal(calls[0].args[0], "path/big.bin");
  assert.ok(Buffer.isBuffer(calls[0].args[1]));
  assert.equal((calls[0].args[1] as Buffer).length, buffer.length);
});
