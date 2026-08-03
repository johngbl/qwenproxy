import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContextMeterSnapshot,
  enrichUsageWithContextMeter,
  type ContextMeterOptions,
} from "../services/context-meter.ts";
import { estimateTokenCount } from "../utils/context-truncation.ts";

const enabledOptions: ContextMeterOptions = {
  enabled: true,
  windowTokens: 1_000_000,
  reportUsage: false,
};

test("context meter distinguishes complete history from the delta sent to Qwen", () => {
  const fullPrompt = `System instructions\n${"a".repeat(100_000)}`;
  const requestPrompt = "User: continue from the previous answer\n\n";
  const snapshot = buildContextMeterSnapshot(
    {
      modelId: "qwen3.7-plus",
      fullPrompt,
      requestPrompt,
      mode: "delta",
      qwenPayloadBytes: 12_345,
      qwenPayloadPromptChars: requestPrompt.length,
      qwenPayloadMessageCount: 1,
      messageCount: 1,
      fullMessageCount: 42,
      toolsCount: 17,
      filesCount: 0,
    },
    enabledOptions,
  );

  assert.ok(snapshot);
  assert.equal(snapshot.mode, "delta");
  assert.equal(snapshot.fullPromptChars, fullPrompt.length);
  assert.equal(snapshot.fullPromptBytes, Buffer.byteLength(fullPrompt, "utf8"));
  assert.equal(snapshot.requestPromptBytes, Buffer.byteLength(requestPrompt, "utf8"));
  assert.equal(snapshot.qwenPayloadBytes, 12_345);
  assert.equal(snapshot.fullMessageCount, 42);
  assert.equal(snapshot.toolsCount, 17);
  assert.equal(snapshot.estimatedContextTokens, estimateTokenCount(fullPrompt));
  assert.ok(snapshot.estimatedContextTokens > snapshot.estimatedRequestTokens);
  assert.ok(snapshot.estimatedContextPercent > 0);
  assert.equal(snapshot.remainingContextTokens,
    1_000_000 - snapshot.estimatedContextTokens,
  );
});

test("context meter marks full replay separately and preserves payload bytes", () => {
  const prompt = "User: replay the complete conversation\n" + "x".repeat(10_000);
  const snapshot = buildContextMeterSnapshot(
    {
      modelId: "qwen3.7-plus",
      fullPrompt: prompt,
      requestPrompt: prompt,
      mode: "replay",
      qwenPayloadBytes: 1_100_000,
      messageCount: 40,
      fullMessageCount: 40,
    },
    enabledOptions,
  );

  assert.ok(snapshot);
  assert.equal(snapshot.mode, "replay");
  assert.equal(snapshot.requestPromptBytes, snapshot.fullPromptBytes);
  assert.equal(snapshot.qwenPayloadBytes, 1_100_000);
});

test("context meter is disabled without changing usage", () => {
  const snapshot = buildContextMeterSnapshot(
    {
      modelId: "qwen3.7-plus",
      fullPrompt: "history",
      requestPrompt: "delta",
      mode: "delta",
    },
    { enabled: false, windowTokens: 1_000_000, reportUsage: true },
  );

  assert.equal(snapshot, null);
  const usage = {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
  };
  assert.deepEqual(
    enrichUsageWithContextMeter(usage, snapshot, {
      enabled: false,
      windowTokens: 1_000_000,
      reportUsage: true,
    }),
    usage,
  );
});

test("reportUsage can expose effective history usage while retaining upstream usage", () => {
  const snapshot = buildContextMeterSnapshot(
    {
      modelId: "qwen3.7-plus",
      fullPrompt: "z".repeat(4_000),
      requestPrompt: "z",
      mode: "delta",
    },
    enabledOptions,
  );
  assert.ok(snapshot);

  const usage = enrichUsageWithContextMeter(
    {
      prompt_tokens: 18,
      completion_tokens: 7,
      total_tokens: 25,
    },
    snapshot,
    { ...enabledOptions, reportUsage: true },
  );

  assert.equal(usage.prompt_tokens, 18);
  assert.equal(usage.total_tokens, 25);
  assert.equal((usage as any).context_meter.upstreamPromptTokens, 18);
  assert.equal((usage as any).context_meter.measurementSource, "qwen");
  assert.equal((usage as any).context_meter.reportedPromptTokens, 18);
  assert.equal(
    (usage as any).context_meter.upstreamRemainingContextTokens,
    1_000_000 - 18,
  );
  assert.equal((usage as any).context_meter.upstreamContextPercent, 0);
  assert.ok(
    (usage as any).context_meter.estimatedContextTokens >
      (usage as any).context_meter.upstreamPromptTokens,
  );
});

test("reportUsage falls back explicitly to a local estimate when Qwen sends no usage", () => {
  const snapshot = buildContextMeterSnapshot(
    {
      modelId: "qwen3.7-plus",
      fullPrompt: "q".repeat(4_000),
      requestPrompt: "q",
      mode: "delta",
    },
    enabledOptions,
  );
  assert.ok(snapshot);

  const usage = enrichUsageWithContextMeter(
    { prompt_tokens: 0, completion_tokens: 2, total_tokens: 2 },
    snapshot,
    { ...enabledOptions, reportUsage: true },
  );

  assert.equal(usage.prompt_tokens, snapshot.estimatedContextTokens);
  assert.equal((usage as any).context_meter.measurementSource, "local_estimate");
});
