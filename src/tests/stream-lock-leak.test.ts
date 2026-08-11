import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { config } from "../core/config.ts";
import { createQwenStream } from "../services/qwen.ts";

function createMockStreamResponse() {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function installMockFetch() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);
    if (url.includes("/api/v2/chat/completions")) {
      return createMockStreamResponse();
    }
    return originalFetch(input, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const ACCOUNT_A = "stream-lock-test-a";
const ACCOUNT_B = "stream-lock-test-b";

test("acquire deadline is configurable via ACQUIRE_DEADLINE_MS (default 120s)", () => {
  assert.equal(
    config.concurrency.acquireDeadlineMs,
    120_000,
    "default acquire deadline should be 2 minutes",
  );
});

test("cancelling a created stream releases the per-account stream lock", async () => {
  const restoreFetch = installMockFetch();
  try {
    const first = await createQwenStream(
      "Prompt 1",
      true,
      "qwen3.6-plus",
      undefined,
      ACCOUNT_A,
    );
    // The caller (account.ts early-bail) cancels the stream instead of
    // dropping it; cancel must release the stream lock or the next acquire
    // on the SAME account blocks until the acquire deadline (phantom wait).
    await first.stream.cancel();

    const second = await Promise.race([
      createQwenStream("Prompt 2", true, "qwen3.6-plus", undefined, ACCOUNT_A),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("second acquire blocked on a leaked stream lock")),
          5_000,
        ),
      ),
    ]);
    await second.stream.cancel();
  } finally {
    restoreFetch();
  }
});

test("an uncancelled stream holds the lock: next acquire blocks (phantom-wait repro)", async () => {
  const restoreFetch = installMockFetch();
  let secondResult: Awaited<ReturnType<typeof createQwenStream>> | undefined;
  let secondFailed: unknown;
  try {
    const first = await createQwenStream(
      "Prompt 1",
      true,
      "qwen3.6-plus",
      undefined,
      ACCOUNT_B,
    );
    // DO NOT cancel: this is the leak — the stream is dropped without
    // cancel() (or its read loop died) so the lock stays held.
    const second = createQwenStream(
      "Prompt 2",
      true,
      "qwen3.6-plus",
      undefined,
      ACCOUNT_B,
    ).then(
      (r) => {
        secondResult = r;
        return r;
      },
      (e) => {
        secondFailed = e;
        throw e;
      },
    );

    await assert.rejects(
      Promise.race([
        second,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("expected lock block")), 300),
        ),
      ]),
      /expected lock block/,
    );

    // Releasing the lock (the account.ts fix cancels the stream on abort)
    // hands the lock to the queued waiter, which then proceeds.
    await first.stream.cancel();
    const recovered = await Promise.race([
      second,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("queued acquire never recovered after cancel")),
          5_000,
        ),
      ),
    ]);
    await recovered.stream.cancel();
    assert.equal(secondFailed, undefined);
    assert.ok(secondResult, "queued acquire should complete after lock release");
  } finally {
    restoreFetch();
  }
});
