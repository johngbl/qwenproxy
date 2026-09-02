import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { processImagesForQwen } from "../routes/upload.ts";
import { formatGeneratedVideoContent } from "../routes/chat/media.ts";
import { fetchQwenModels } from "../services/qwen.ts";
import {
  resolveMediaModel,
  classifyMediaModel,
  isSupportedMediaSize,
  MEDIA_SIZE_OPTIONS,
  listMediaGenerationModels,
  getMediaModelModes,
  supportsPromptMediaGeneration,
  mediaLog,
} from "../services/media-generation.ts";

test("fetchQwenModels caches results per account", async () => {
  const originalFetch = globalThis.fetch;
  let modelRequests = 0;

  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/models")) {
      modelRequests++;
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen3.6-plus",
              owned_by: "qwen",
              info: {
                meta: {
                  capabilities: { thinking: true },
                  modality: ["text"],
                  think_skip: { enable: true },
                },
              },
            },
          ],
        }),
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
    assert.strictEqual(second.length, 1);
    assert.strictEqual(second[0]?.id, "qwen3.6-plus");
    assert.strictEqual(third[0]?.id, "qwen3.6-plus");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("media generation uses the model selected by the client", async () => {
  assert.deepEqual(resolveMediaModel("caller-selected-model"), {
    chatModel: "caller-selected-model",
    generationModel: undefined,
  });
  assert.throws(
    () => resolveMediaModel(undefined),
    /model selected by the client/i,
  );
});

test("classifyMediaModel routes generation models for native chat media", () => {
  assert.strictEqual(classifyMediaModel("qwen-image-3.0-pro"), "image");
  assert.strictEqual(classifyMediaModel("qwen-image-3.0"), "image");
  assert.strictEqual(classifyMediaModel("wan2.7-image-pro"), "image");
  assert.strictEqual(classifyMediaModel("wan2.7-image"), "image");
  assert.strictEqual(classifyMediaModel("z-image-turbo"), "image");
  assert.strictEqual(classifyMediaModel("wan3.0-video"), "video");
  assert.strictEqual(classifyMediaModel("wan2.7-t2v"), "video");
  assert.strictEqual(classifyMediaModel("wan2.6-t2v"), null);
  assert.strictEqual(classifyMediaModel("qwen-image-max"), null);
  assert.strictEqual(classifyMediaModel("qwen3.8-max"), null);
  assert.strictEqual(classifyMediaModel("qwen3.7-plus"), null);
  assert.strictEqual(classifyMediaModel(undefined), null);
  assert.strictEqual(classifyMediaModel("   "), null);
});

test("media catalog includes the requested model IDs and modality metadata", () => {
  const models = new Map(
    listMediaGenerationModels().map((model) => [model.id, model]),
  );
  const expectedIds = [
    "qwen-image-3.0-pro",
    "qwen-image-3.0",
    "wan2.7-image-pro",
    "wan2.7-image",
    "z-image-turbo",
    "wan3.0-video",
    "wan2.7-t2v",
    "wan2.7-i2v",
  ];
  for (const id of expectedIds) {
    assert.ok(models.has(id), `missing media model: ${id}`);
  }
  assert.deepEqual(getMediaModelModes("qwen-image-3.0-pro"), [
    "t2i",
    "i2i",
  ]);
  assert.deepEqual(getMediaModelModes("wan3.0-video"), [
    "t2v",
    "i2v",
  ]);
  assert.strictEqual(supportsPromptMediaGeneration("wan2.7-i2v", "video"), false);
  assert.strictEqual(supportsPromptMediaGeneration("wan2.7-t2v", "video"), true);
  assert.strictEqual(supportsPromptMediaGeneration("wan3.0-video", "video"), true);
  assert.strictEqual(supportsPromptMediaGeneration("qwen-image-3.0", "image"), true);
  assert.strictEqual(supportsPromptMediaGeneration("z-image-turbo", "image"), true);
});

test("media sizes include the Qwen portrait ratio and reject unknown ratios", () => {
  assert.ok(isSupportedMediaSize("auto"));
  assert.ok(isSupportedMediaSize("1:1"));
  assert.ok(isSupportedMediaSize("3:4"));
  assert.ok(isSupportedMediaSize("4:3"));
  assert.ok(isSupportedMediaSize("16:9"));
  assert.ok(isSupportedMediaSize("9:16"));
  assert.ok(isSupportedMediaSize("1024x1024"));
  assert.strictEqual(isSupportedMediaSize("2:5"), false);
  assert.ok(MEDIA_SIZE_OPTIONS.includes("3:4"));
});

test("chat video results use a clickable Markdown link", () => {
  const content = formatGeneratedVideoContent(
    "https://cdn.qwenlm.ai/output/video.mp4?key=test-token",
  );

  assert.strictEqual(
    content,
    "[🎬 Generated video](https://cdn.qwenlm.ai/output/video.mp4?key=test-token)",
  );
});

test("media logs are standardized and redact signed URLs", () => {
  const message = mediaLog("image", "generation_completed", {
    account: "1234567890abcdef",
    url: "https://cdn.qwenlm.ai/output/image.png?key=secret-token",
    error: "first line\nsecond line",
  });

  assert.match(message, /^🎨 \[Media\] generation_completed \|/);
  assert.match(message, /account=1234567890ab/);
  assert.match(message, /url=\[redacted-url\]/);
  assert.doesNotMatch(message, /secret-token/);
  assert.doesNotMatch(message, /\n/);
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
    assert.strictEqual(
      result.files[0].file.meta.content_type,
      "application/pdf",
    );
    assert.strictEqual(result.files[0].size, remoteBuffer.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
