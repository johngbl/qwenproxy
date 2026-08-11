/**
 * Coverage tests for pure-logic core modules:
 * prompt-limits, model-registry, account-priority, crypto-utils, errors,
 * memory-usage.
 *
 * Everything runs inside a throwaway temp directory (chdir happens before any
 * dynamic import) so no module can touch the real data/ folder:
 * - crypto-utils writes its .encryption_key into <tmp>/data/db
 * - account-priority sees <tmp>/data/account-priority.json as a DIRECTORY,
 *   which makes both readFileSync (loadPriority) and writeFileSync
 *   (savePriority) throw, exercising both catch branches without touching the
 *   production priority file.
 */
import test, { after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const originalMaxPromptBytes = process.env.QWEN_MAX_PROMPT_BYTES;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-core-logic-"));
fs.mkdirSync(path.join(tmpDir, "data", "account-priority.json"), {
  recursive: true,
});

delete process.env.ENCRYPTION_KEY; // force the key-file creation branch
delete process.env.QWEN_ACCOUNTS;
// Non-zero budget enables the byte-limit rejection branch in
// assertPromptWithinLimits.
process.env.QWEN_MAX_PROMPT_BYTES = "100";

process.chdir(tmpDir);

const { encrypt, decrypt, isEncrypted } = await import(
  "../core/crypto-utils.ts"
);
const {
  getPromptLimitStats,
  assertPromptWithinLimits,
  truncatePromptToIntelligentLimit,
} = await import("../core/prompt-limits.ts");
const registry = await import("../core/model-registry.ts");
const { ContextLengthExceededError, ServiceUnavailable } = await import(
  "../core/errors.ts"
);
const { classifyRamUsage, getHeapUsageSnapshot } = await import(
  "../core/memory-usage.ts"
);
const priority = await import("../core/account-priority.ts");

after(() => {
  process.chdir(originalCwd);
  if (originalMaxPromptBytes === undefined) {
    delete process.env.QWEN_MAX_PROMPT_BYTES;
  } else {
    process.env.QWEN_MAX_PROMPT_BYTES = originalMaxPromptBytes;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* errors.ts                                                           */
/* ------------------------------------------------------------------ */

test("errors: ServiceUnavailable exposes 503/service_unavailable metadata", () => {
  const err = new ServiceUnavailable("degraded");
  assert.strictEqual(err.statusCode, 503);
  assert.strictEqual(err.type, "service_unavailable");
  assert.strictEqual(err.code, "service_degraded");
  assert.strictEqual(err.name, "ServiceUnavailable");
  assert.strictEqual(err.message, "degraded");
  assert.deepStrictEqual(err.toOpenAI(), {
    error: {
      message: "degraded",
      type: "service_unavailable",
      code: "service_degraded",
      param: undefined,
    },
  });
});

/* ------------------------------------------------------------------ */
/* memory-usage.ts                                                     */
/* ------------------------------------------------------------------ */

test("memory-usage: classifyRamUsage threshold boundaries", () => {
  assert.strictEqual(classifyRamUsage(50, 80, 95), "ok");
  assert.strictEqual(classifyRamUsage(80, 80, 95), "ok"); // not strictly >
  assert.strictEqual(classifyRamUsage(80.5, 80, 95), "warning");
  assert.strictEqual(classifyRamUsage(95, 80, 95), "warning"); // not strictly >
  assert.strictEqual(classifyRamUsage(95.1, 80, 95), "critical");
});

test("memory-usage: getHeapUsageSnapshot falls back when limit is invalid", () => {
  const mem = {
    heapUsed: 50,
    heapTotal: 100,
    rss: 200,
    external: 0,
    arrayBuffers: 0,
  } as NodeJS.MemoryUsage;

  const zeroLimit = getHeapUsageSnapshot(mem, 0);
  assert.strictEqual(zeroLimit.heapSizeLimit, 100); // falls back to heapTotal
  assert.strictEqual(zeroLimit.usagePercent, 50);

  const nanLimit = getHeapUsageSnapshot(mem, Number.NaN);
  assert.strictEqual(nanLimit.heapSizeLimit, 100);

  const explicit = getHeapUsageSnapshot(mem, 200);
  assert.strictEqual(explicit.heapSizeLimit, 200);
  assert.strictEqual(explicit.usagePercent, 25);

  const defaults = getHeapUsageSnapshot();
  assert.ok(defaults.heapUsed > 0);
  assert.ok(defaults.usagePercent >= 0);
});

/* ------------------------------------------------------------------ */
/* crypto-utils.ts                                                     */
/* ------------------------------------------------------------------ */

test("crypto-utils: first encrypt creates the key file, roundtrip decrypts", () => {
  const keyFile = path.join(tmpDir, "data", "db", ".encryption_key");
  assert.strictEqual(fs.existsSync(keyFile), false);

  const ciphertext = encrypt("hello world");
  assert.notStrictEqual(ciphertext, "hello world");
  assert.strictEqual(isEncrypted(ciphertext), true);
  // Key was generated and persisted for future decrypts.
  assert.strictEqual(fs.existsSync(keyFile), true);
  assert.strictEqual(decrypt(ciphertext), "hello world");

  // Unicode roundtrip through the same cached key.
  const unicode = "senha com acentuação 🚀 {special}:chars";
  assert.strictEqual(decrypt(encrypt(unicode)), unicode);
});

test("crypto-utils: empty and unparseable values pass through unchanged", () => {
  assert.strictEqual(encrypt(""), "");
  assert.strictEqual(decrypt(""), "");
  assert.strictEqual(decrypt("no-colons-here"), "no-colons-here");
  assert.strictEqual(decrypt("only:two"), "only:two"); // not 3 parts
});

test("crypto-utils: tampered ciphertext fails auth and is returned as-is", () => {
  const ciphertext = encrypt("payload");
  const [iv, authTag, data] = ciphertext.split(":");
  // Zero out the GCM auth tag so decryption must throw internally.
  const corrupted = `${iv}:${"0".repeat(authTag.length)}:${data}`;
  assert.strictEqual(decrypt(corrupted), corrupted);
});

test("crypto-utils: isEncrypted shape detection", () => {
  assert.strictEqual(isEncrypted(""), false);
  assert.strictEqual(isEncrypted("plain"), false);
  assert.strictEqual(isEncrypted("aa:bb"), false); // only 2 parts
  assert.strictEqual(isEncrypted("xx:yy:zz"), false); // non-hex parts
  assert.strictEqual(isEncrypted("aabb:ccdd:eeff"), true);
});

/* ------------------------------------------------------------------ */
/* model-registry.ts                                                   */
/* ------------------------------------------------------------------ */

test("model-registry: setModelContextWindow stores per-account context windows", () => {
  registry.setModelContextWindow("reg-m1", 32_000, "reg-acc-A");
  assert.strictEqual(
    registry.getModelContextWindow("reg-m1", "reg-acc-A"),
    32_000,
  );

  // Variant suffixes resolve to the base model entry.
  assert.strictEqual(
    registry.getModelContextWindow("reg-m1-thinking", "reg-acc-A"),
    32_000,
  );
  assert.strictEqual(
    registry.getModelContextWindow("reg-m1-no-thinking", "reg-acc-A"),
    32_000,
  );
  assert.strictEqual(
    registry.getModelContextWindow("reg-m1-fast", "reg-acc-A"),
    32_000,
  );

  // Never leaks across accounts.
  assert.strictEqual(
    registry.getModelContextWindow("reg-m1", "reg-acc-B"),
    1_048_576,
  );

  // Invalid values are ignored.
  registry.setModelContextWindow("reg-m1", 0, "reg-acc-A");
  registry.setModelContextWindow("reg-m1", -5, "reg-acc-A");
  registry.setModelContextWindow("reg-m1", Number.NaN, "reg-acc-A");
  assert.strictEqual(
    registry.getModelContextWindow("reg-m1", "reg-acc-A"),
    32_000,
  );

  assert.strictEqual(
    registry.getModelContextWindowSource("reg-m1", "reg-acc-A"),
    "upstream",
  );
  assert.strictEqual(
    registry.getModelContextWindowSource("reg-unknown", "reg-acc-A"),
    "default",
  );
});

test("model-registry: getModelMetadata returns registered metadata or undefined", () => {
  const meta = registry.getModelMetadata("reg-m1-thinking", "reg-acc-A");
  assert.ok(meta);
  assert.strictEqual(meta.id, "reg-m1"); // base id
  assert.strictEqual(meta.contextWindow, 32_000);
  assert.strictEqual(meta.raw.id, "reg-m1");
  assert.strictEqual(meta.capabilities.maxOutputTokens, 65536); // defaults

  assert.strictEqual(
    registry.getModelMetadata("reg-never-registered", "reg-acc-A"),
    undefined,
  );
});

test("model-registry: setModelCapabilities merges partial capabilities", () => {
  registry.setModelCapabilities("reg-m2", { maxOutputTokens: 4096 }, "reg-acc-C");
  const caps = registry.getModelCapabilities("reg-m2", "reg-acc-C");
  assert.strictEqual(caps.maxOutputTokens, 4096);
  assert.strictEqual(caps.maxThinkingTokens, 16_384); // default preserved
  assert.deepStrictEqual(caps.modalities, ["text"]);

  registry.setModelCapabilities(
    "reg-m2",
    {
      modalities: ["text", "image"],
      chatTypes: ["standard"],
      mcp: ["code-interpreter"],
    },
    "reg-acc-C",
  );
  const updated = registry.getModelCapabilities("reg-m2", "reg-acc-C");
  assert.deepStrictEqual(updated.modalities, ["text", "image"]);
  assert.deepStrictEqual(updated.chatTypes, ["standard"]);
  assert.deepStrictEqual(updated.mcp, ["code-interpreter"]);

  // Returned capabilities are clones: mutating them must not leak back.
  updated.modalities.push("hologram");
  assert.deepStrictEqual(
    registry.getModelCapabilities("reg-m2", "reg-acc-C").modalities,
    ["text", "image"],
  );
});

test("model-registry: syncModelContextWindows parses numeric strings", () => {
  registry.syncModelContextWindows(
    [
      { id: "reg-sw1", context_window: "12345" }, // string → parsed
      { id: "reg-sw2" }, // no context window → skipped
      { id: "reg-sw3", context_window: "not-a-number", max_context_length: 777 },
    ],
    "reg-acc-D",
  );
  assert.strictEqual(registry.getModelContextWindow("reg-sw1", "reg-acc-D"), 12_345);
  assert.strictEqual(
    registry.getModelContextWindow("reg-sw2", "reg-acc-D"),
    1_048_576,
  );
  assert.strictEqual(registry.getModelContextWindow("reg-sw3", "reg-acc-D"), 777);
});

test("model-registry: syncModelMetadata derives flags from numeric abilities", () => {
  registry.syncModelMetadata(
    [
      { id: "reg-ab1", abilities: { thinking: 1, vision: 0, citations: 2 } },
      { id: "   " }, // blank id → skipped
    ],
    "reg-acc-E",
  );
  const caps = registry.getModelCapabilities("reg-ab1", "reg-acc-E");
  assert.strictEqual(caps.supportsThinking, true); // positiveFlag(1) → true
  assert.strictEqual(caps.supportsVision, false); // positiveFlag(0) → false
  assert.strictEqual(caps.supportsCitations, true); // positiveFlag(2) → true
});

test("model-registry: isAlwaysThinkingModel and stripFastSuffix", () => {
  registry.setModelCapabilities(
    "reg-think",
    { supportsThinking: true, canSkipThinking: false },
    "reg-acc-F",
  );
  assert.strictEqual(registry.isAlwaysThinkingModel("reg-think", "reg-acc-F"), true);

  registry.setModelCapabilities("reg-think", { canSkipThinking: true }, "reg-acc-F");
  assert.strictEqual(registry.isAlwaysThinkingModel("reg-think", "reg-acc-F"), false);

  // Unknown model → default capabilities (no thinking).
  assert.strictEqual(
    registry.isAlwaysThinkingModel("reg-never-registered", "reg-acc-F"),
    false,
  );

  assert.strictEqual(registry.stripFastSuffix("qwen3-fast"), "qwen3");
  assert.strictEqual(registry.stripFastSuffix("qwen3"), "qwen3");
});

/* ------------------------------------------------------------------ */
/* prompt-limits.ts                                                    */
/* ------------------------------------------------------------------ */

test("prompt-limits: getPromptLimitStats computes bytes/tokens/usable budget", () => {
  const stats = getPromptLimitStats("hello", "pl-model", "pl-acc");
  assert.strictEqual(stats.bytes, 5);
  assert.ok(stats.estimatedTokens > 0);
  assert.strictEqual(stats.modelContextWindow, 1_048_576);
  // Default reservation: max(4096, 65536, 16384) = 65536.
  assert.strictEqual(stats.usableInputTokens, 1_048_576 - 65_536);
});

test("prompt-limits: assertPromptWithinLimits rejects oversized byte input", () => {
  // QWEN_MAX_PROMPT_BYTES=100 for this process.
  assert.throws(
    () => assertPromptWithinLimits("x".repeat(200), "pl-model"),
    (err: unknown) =>
      err instanceof ContextLengthExceededError &&
      /UTF-8 bytes/.test(err.message),
  );
});

test("prompt-limits: assertPromptWithinLimits rejects token overflow", () => {
  // Shrink the usable context to 66 tokens; 100 control chars ≈ 100 tokens.
  registry.setModelContextWindow("pl-tiny", 16_450, "pl-acc");
  const prompt = "\u0001".repeat(100); // 100 bytes, ~100 tokens
  assert.throws(
    () => assertPromptWithinLimits(prompt, "pl-tiny", { accountId: "pl-acc" }),
    (err: unknown) =>
      err instanceof ContextLengthExceededError &&
      /usable context/.test(err.message),
  );
});

test("prompt-limits: assertPromptWithinLimits passes small input", () => {
  const stats = assertPromptWithinLimits("hello", "pl-model");
  assert.strictEqual(stats.bytes, 5);
  const skipped = assertPromptWithinLimits("hello", "pl-model", {
    checkModelContext: false,
  });
  assert.strictEqual(skipped.bytes, 5);
});

test("prompt-limits: truncation is a no-op within limits", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  const result = truncatePromptToIntelligentLimit(
    "hi", "pl-model", "pl-acc", messages,
  );
  assert.strictEqual(result.wasTruncated, false);
  assert.strictEqual(result.prompt, "hi");
  assert.strictEqual(result.messagesKept, 2);
  assert.strictEqual(result.messagesDropped, 0);
  assert.strictEqual(result.truncatedTokens, result.originalTokens);

  const noMessages = truncatePromptToIntelligentLimit("hi", "pl-model", "pl-acc");
  assert.strictEqual(noMessages.messagesKept, 0);
});

test("prompt-limits: char-based truncation when no messages are provided", () => {
  // usable = 20000 - 16384 = 3616 tokens → maxChars = 14464.
  registry.setModelContextWindow("pl-trunc", 20_000, "pl-trunc-acc");
  registry.setModelCapabilities(
    "pl-trunc",
    { maxOutputTokens: 16_384, maxThinkingTokens: 0 },
    "pl-trunc-acc",
  );
  const prompt = "a".repeat(20_000); // ≈ 5000 tokens > 3616

  const result = truncatePromptToIntelligentLimit(
    prompt, "pl-trunc", "pl-trunc-acc",
  );
  assert.strictEqual(result.wasTruncated, true);
  assert.strictEqual(result.messagesKept, 0);
  assert.strictEqual(result.messagesDropped, 0);
  assert.ok(result.prompt.startsWith("aaaa"));
  assert.ok(result.prompt.includes("[Context truncated"));
  // 14464 kept chars plus the truncation notice.
  assert.ok(result.prompt.length > 14_464);
  assert.ok(result.prompt.length < 14_464 + 200);
  assert.ok(result.truncatedTokens < result.originalTokens);
});

test("prompt-limits: message truncation keeps recent messages when they fit", () => {
  // usable = 20000 - 16384 = 3616 tokens.
  registry.setModelContextWindow("pl-trunc2", 20_000, "pl-trunc-acc2");
  registry.setModelCapabilities(
    "pl-trunc2",
    { maxOutputTokens: 16_384, maxThinkingTokens: 0 },
    "pl-trunc-acc2",
  );
  const messages: Array<{ role: string; content: string | null }> = Array.from({ length: 24 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: "a".repeat(1000), // ≈ 250 tokens each
  }));
  messages[0] = { role: "user", content: null }; // null content path

  const result = truncatePromptToIntelligentLimit(
    "a".repeat(24_000), // ≈ 6000 tokens > 3616 → triggers truncation
    "pl-trunc2",
    "pl-trunc-acc2",
    messages,
  );
  assert.strictEqual(result.wasTruncated, true);
  // 20 kept messages still overflow (~5000 tokens) → halved to 10 (~2500).
  assert.strictEqual(result.messagesKept, 10);
  assert.strictEqual(result.messagesDropped, 14);
  assert.ok(result.prompt.includes("[Context truncated"));
  assert.ok(result.truncatedTokens <= 3616);
});

test("prompt-limits: message truncation falls back to hard char limit", () => {
  // usable = 17000 - 16384 = 616 tokens — even one message overflows.
  registry.setModelContextWindow("pl-trunc3", 17_000, "pl-trunc-acc3");
  registry.setModelCapabilities(
    "pl-trunc3",
    { maxOutputTokens: 16_384, maxThinkingTokens: 0 },
    "pl-trunc-acc3",
  );
  const messages = Array.from({ length: 24 }, () => ({
    role: "user",
    content: "a".repeat(5000), // ≈ 1250 tokens each
  }));

  const result = truncatePromptToIntelligentLimit(
    "a".repeat(5000), // ≈ 1250 tokens > 616
    "pl-trunc3",
    "pl-trunc-acc3",
    messages,
  );
  assert.strictEqual(result.wasTruncated, true);
  assert.strictEqual(result.messagesKept, 1);
  assert.strictEqual(result.messagesDropped, 23);
  // Hard cap: usable * 4 chars plus the notice.
  assert.ok(result.prompt.length <= 616 * 4 + 200);
  assert.ok(result.prompt.includes("[Context truncated"));
});

/* ------------------------------------------------------------------ */
/* account-priority.ts                                                 */
/* ------------------------------------------------------------------ */

test("account-priority: empty priority order returns accounts unchanged", () => {
  // First loadPriority call: the priority file path is a directory, so
  // readFileSync throws and the module falls back to an empty order.
  const accounts = [{ id: "z1" }, { id: "z2" }];
  const ordered = priority.getAccountsByPriority(accounts);
  assert.deepStrictEqual(ordered, accounts);
  // The empty-order fast path returns the input array itself.
  assert.strictEqual(ordered, accounts);
});

test("account-priority: markAccountSuccessful moves account to the top", () => {
  priority.markAccountSuccessful("pa-1");
  priority.markAccountSuccessful("pa-2");
  priority.markAccountSuccessful("pa-1"); // duplicate removed, re-added on top

  const ordered = priority.getAccountsByPriority([
    { id: "pa-2" },
    { id: "pa-1" },
  ]);
  assert.deepStrictEqual(
    ordered.map((a) => a.id),
    ["pa-1", "pa-2"],
  );
});

test("account-priority: markAccountFailed moves account to the end", () => {
  priority.markAccountFailed("pa-1");
  const ordered = priority.getAccountsByPriority([
    { id: "pa-1" },
    { id: "pa-2" },
  ]);
  assert.deepStrictEqual(
    ordered.map((a) => a.id),
    ["pa-2", "pa-1"],
  );
});

test("account-priority: mock account is never persisted", () => {
  priority.markAccountSuccessful("mock-account");
  priority.markAccountFailed("mock-account");
  priority.ensureAccountInPriority("mock-account");

  const ordered = priority.getAccountsByPriority([
    { id: "mock-account" },
    { id: "pa-2" },
  ]);
  // mock-account has no priority entry, so it sorts after pa-2.
  assert.deepStrictEqual(
    ordered.map((a) => a.id),
    ["pa-2", "mock-account"],
  );
});

test("account-priority: ensureAccountInPriority appends only new accounts", () => {
  priority.ensureAccountInPriority("pa-3");
  priority.ensureAccountInPriority("pa-3"); // already present → no-op

  const ordered = priority.getAccountsByPriority([
    { id: "pa-3" },
    { id: "pa-2" },
    { id: "pa-1" },
  ]);
  // Current order: [pa-2, pa-1, pa-3].
  assert.deepStrictEqual(
    ordered.map((a) => a.id),
    ["pa-2", "pa-1", "pa-3"],
  );
});

test("account-priority: sort mixes listed and unlisted accounts", () => {
  // Listed account first, unlisted second → comparator returns -1.
  const listedFirst = priority.getAccountsByPriority([
    { id: "pa-1" },
    { id: "unknown-x" },
  ]);
  assert.deepStrictEqual(
    listedFirst.map((a) => a.id),
    ["pa-1", "unknown-x"],
  );

  // Unlisted account first, listed second → comparator returns 1.
  const listedSecond = priority.getAccountsByPriority([
    { id: "unknown-y" },
    { id: "pa-2" },
  ]);
  assert.deepStrictEqual(
    listedSecond.map((a) => a.id),
    ["pa-2", "unknown-y"],
  );

  // Neither listed → original order preserved.
  const noneListed = priority.getAccountsByPriority([
    { id: "u1" },
    { id: "u2" },
  ]);
  assert.deepStrictEqual(
    noneListed.map((a) => a.id),
    ["u1", "u2"],
  );
});
