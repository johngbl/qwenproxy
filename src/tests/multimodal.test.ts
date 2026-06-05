import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { processImagesForQwen } from "../routes/upload.ts";
import { fetchQwenModels } from "../services/qwen.ts";

test("fetchQwenModels caches results per account", async () => {
  const originalFetch = globalThis.fetch;
  let modelRequests = 0;

  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/models")) {
      modelRequests++;
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }
    return originalFetch(input);
  };

  try {
    const first = await fetchQwenModels("acc-a");
    const second = await fetchQwenModels("acc-a");
    const third = await fetchQwenModels("acc-b");

    assert.strictEqual(modelRequests, 2);
    assert.strictEqual(first[0]?.id, "qwen3.6-plus");
    assert.strictEqual(second[1]?.id, "qwen3.6-plus-no-thinking");
    assert.strictEqual(third[0]?.id, "qwen3.6-plus");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("processImagesForQwen re-uploads remote HTTP files to Qwen OSS", async () => {
  const originalFetch = globalThis.fetch;
  const remoteUrl = "https://example.com/docs/report.pdf?download=1";
  const remoteBuffer = Buffer.from("pdf");
  let remoteDownloads = 0;
  let stsRequests = 0;

  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;

    if (url === remoteUrl) {
      remoteDownloads++;
      return new Response(remoteBuffer, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
        },
      });
    }

    if (url.includes("/api/v2/files/getstsToken")) {
      stsRequests++;
      const body = JSON.parse(String(init?.body || "{}"));
      assert.strictEqual(body.filename, "report.pdf");
      assert.strictEqual(body.filetype, "file");
      assert.strictEqual(body.filesize, String(remoteBuffer.length));

      return new Response(
        JSON.stringify({
          success: true,
          request_id: "req-1",
          data: {
            access_key_id: "ak",
            access_key_secret: "sk",
            security_token: "token",
            file_url: "https://oss.example/report.pdf?signature=123",
            file_path: "uploads/report.pdf",
            file_id: "file-123",
            bucketname: "bucket",
            region: "oss-region",
            endpoint: "oss.example",
          },
        }),
        { status: 200 },
      );
    }

    return originalFetch(input, init);
  };

  try {
    const result = await processImagesForQwen(
      [
        { type: "text", text: "Veja o anexo" },
        { type: "file_url", file_url: { url: remoteUrl } },
      ],
      {
        cookie: "token=mock",
        "user-agent": "mock",
        "bx-ua": "mock-bx-ua",
        "bx-umidtoken": "mock-bx-umidtoken",
        "bx-v": "2.5.36",
      },
    );

    assert.strictEqual(result.text, "Veja o anexo");
    assert.strictEqual(remoteDownloads, 1);
    assert.strictEqual(stsRequests, 1);
    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].url, "https://oss.example/report.pdf");
    assert.strictEqual(result.files[0].id, "file-123");
    assert.strictEqual(result.files[0].name, "report.pdf");
    assert.strictEqual(result.files[0].file.meta.content_type, "application/pdf");
    assert.strictEqual(result.files[0].size, remoteBuffer.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
