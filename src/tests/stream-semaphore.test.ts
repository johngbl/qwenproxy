// Integration test: deliberately exercises the real FIFO handoff of the
// per-account stream semaphore against the platform clock (same pattern as
// stream-lock-leak.test.ts) — the awaited condition IS the timing behavior.
import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { config } from "../core/config.ts";
import { createQwenStream } from "../services/qwen.ts";
function createMockStreamResponse() {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode("data: [DONE]\n\n"),
      );
      // Never close: this is an in-flight generation holding its slot —
      // exactly the state the old capacity-1 mutex serialized.
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

const ACCOUNT = "stream-semaphore-test";

test("two streams run CONCURRENTLY on one account when maxStreamsPerAccount=2", async () => {
  const restoreFetch = installMockFetch();
  const prevCap = config.concurrency.maxStreamsPerAccount;
  config.concurrency.maxStreamsPerAccount = 2;
  try {
    const first = await createQwenStream(
      "Prompt 1",
      true,
      "qwen3.6-plus",
      undefined,
      ACCOUNT,
    );
    // The first stream is NOT cancelled (still in flight). With the old
    // capacity-1 mutex the second createQwenStream would block here forever
    // (the phantom wait); with the semaphore it must proceed immediately.
    const second = await Promise.race([
      createQwenStream("Prompt 2", true, "qwen3.6-plus", undefined, ACCOUNT),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error("second stream blocked behind a serialized stream lock"),
            ),
          3_000,
        ),
      ),
    ]);
    await first.stream.cancel();
    await second.stream.cancel();
  } finally {
    config.concurrency.maxStreamsPerAccount = prevCap;
    restoreFetch();
  }
});

test("a third stream waits when capacity 2 is exhausted", async () => {
  const restoreFetch = installMockFetch();
  const prevCap = config.concurrency.maxStreamsPerAccount;
  config.concurrency.maxStreamsPerAccount = 2;
  try {
    const first = await createQwenStream(
      "Prompt 1",
      true,
      "qwen3.6-plus",
      undefined,
      ACCOUNT,
    );
    const second = await createQwenStream(
      "Prompt 2",
      true,
      "qwen3.6-plus",
      undefined,
      ACCOUNT,
    );
    const third = createQwenStream(
      "Prompt 3",
      true,
      "qwen3.6-plus",
      undefined,
      ACCOUNT,
    );

    await assert.rejects(
      Promise.race([
        third,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("expected capacity block")), 300),
        ),
      ]),
      /expected capacity block/,
    );

    // Cancelling one holder hands the slot to the queued waiter.
    await first.stream.cancel();
    const recovered = await Promise.race([
      third,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("queued acquire never recovered after cancel")),
          3_000,
        ),
      ),
    ]);
    await second.stream.cancel();
    await recovered.stream.cancel();
  } finally {
    config.concurrency.maxStreamsPerAccount = prevCap;
    restoreFetch();
  }
});
