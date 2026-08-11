import test from "node:test";
import assert from "node:assert";

// Set the environment BEFORE the module graph under test loads.
process.env.TEST_MOCK_QWEN_AUTH = "true";

const { classifyError } = await import("../api/error-classifier.ts");
const { InternalError, ClientAbortedError } = await import("../core/errors.ts");
const { metrics } = await import("../core/metrics.js");
const { handleChatCompletionsError } = await import(
  "../routes/chat/streaming.ts"
);

function fakeContext(): {
  c: any;
  calls: Array<{ method: string; status?: number; body?: unknown }>;
} {
  const calls: Array<{ method: string; status?: number; body?: unknown }> = [];
  const c = {
    json: (body: unknown, status?: number) => {
      calls.push({ method: "json", status, body });
      return { status };
    },
    body: (body: unknown, status?: number) => {
      calls.push({ method: "body", status, body });
      return { status };
    },
    newResponse: (body: unknown, init?: { status?: number }) => {
      calls.push({ method: "newResponse", status: init?.status, body });
      return { status: init?.status };
    },
    req: { raw: { signal: { aborted: false } } },
  } as any;
  return { c, calls };
}

// ---------------------------------------------------------------------------
// T4 — "client aborted during stream creation" must be a silent abort, not a
// 500. Reproduces logs2.txt 2026-08-09T02:22:36 (two 500s) and the
// auto-retry failure log at 02:09:13.
// ---------------------------------------------------------------------------

test("T4: classifyError maps client-abort to ClientAbortedError, not InternalError", () => {
  const aborted = new ClientAbortedError(
    "client aborted during stream creation",
  );
  const classified = classifyError(aborted);
  assert.ok(
    classified instanceof ClientAbortedError,
    "must preserve the abort marker",
  );
  assert.ok(
    !(classified instanceof InternalError),
    "client abort must not be a 500",
  );
  assert.strictEqual(classified.statusCode, 499);
});

test("T4: handleChatCompletionsError suppresses client aborts (no 500, no error metric)", () => {
  metrics.reset();

  const { c, calls } = fakeContext();
  const res = handleChatCompletionsError(
    c,
    new ClientAbortedError("client aborted during stream creation"),
  );

  assert.strictEqual(res.status, 499);
  // No OpenAI-style error body is produced (no `json` call with a 500).
  const jsonCall = calls.find((call) => call.method === "json");
  assert.strictEqual(jsonCall, undefined, "no error JSON should be emitted");
  const errorMetric = metrics.get("requests.errors");
  assert.strictEqual(
    errorMetric?.value ?? 0,
    0,
    "client abort must not count as a request error",
  );
});

test("T4: non-abort errors still go through normal classification", () => {
  metrics.reset();

  const { c } = fakeContext();
  const res = handleChatCompletionsError(c, new Error("boom"));
  // Plain unknown errors remain 500 (classifier default), unchanged behavior.
  assert.strictEqual(res.status, 500);
});
