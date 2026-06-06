import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { summarizeMessages } from "../utils/context-summarizer.ts";
import { config } from "../core/config.ts";
import type { Message } from "../utils/types.ts";

const MOCK_PORT = 34567;
const ENDPOINT = `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`;

const savedFetch = globalThis.fetch;
const savedPort = config.server.port;
const savedInternalHost = config.server.internalHost;
const savedModel = process.env.CONTEXT_SUMMARIZATION_MODEL;
const savedTimeout = process.env.CONTEXT_SUMMARIZATION_TIMEOUT;
const savedApiKey = process.env.API_KEY;

function setMockPort(port: number): void {
  config.server.port = port;
  config.server.internalHost = "127.0.0.1";
}

function makeSuccessResponse(summary: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: summary } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function makeErrorResponse(status: number): Response {
  return new Response("error", { status });
}

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: any;
  headers: Record<string, string>;
}

function installFetchMock(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const headers: Record<string, string> = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v: string, k: string) => {
          headers[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v;
      } else {
        Object.assign(headers, init.headers);
      }
    }
    let body: any = null;
    if (init.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, init, body, headers });
    return handler(url, init);
  }) as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = savedFetch;
  config.server.port = savedPort;
  config.server.internalHost = savedInternalHost;
  if (savedModel === undefined) delete process.env.CONTEXT_SUMMARIZATION_MODEL;
  else process.env.CONTEXT_SUMMARIZATION_MODEL = savedModel;
  if (savedTimeout === undefined)
    delete process.env.CONTEXT_SUMMARIZATION_TIMEOUT;
  else process.env.CONTEXT_SUMMARIZATION_TIMEOUT = savedTimeout;
  if (savedApiKey === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = savedApiKey;
});

test("summarizeMessages: returns SummarizationResult with correct shape on success", async () => {
  setMockPort(MOCK_PORT);
  const summaryText = "User asked about auth flow; decided to use JWT.";
  installFetchMock(() => makeSuccessResponse(summaryText));

  const messages: Message[] = [
    { role: "user", content: "How should I implement authentication?" },
    { role: "assistant", content: "Use JWT tokens with refresh rotation." },
  ];

  const result = await summarizeMessages(messages);

  assert.equal(result.summary, summaryText);
  assert.ok(result.originalTokens > 0, "originalTokens must be positive");
  assert.ok(result.summaryTokens > 0, "summaryTokens must be positive");
  assert.ok(result.compressionRatio > 0, "compressionRatio must be positive");
  assert.ok(result.latencyMs >= 0, "latencyMs must be non-negative");
});

test("summarizeMessages: calls the self-loop endpoint with correct payload", async () => {
  setMockPort(MOCK_PORT);
  const { calls } = installFetchMock(() => makeSuccessResponse("ok"));

  const messages: Message[] = [{ role: "user", content: "Hello world" }];

  await summarizeMessages(messages);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.equal(calls[0].headers["X-Internal-Summarization"], "true");

  assert.ok(Array.isArray(calls[0].body.messages));
  assert.equal(calls[0].body.messages.length, 2);
  assert.equal(calls[0].body.messages[0].role, "system");
  assert.equal(calls[0].body.messages[1].role, "user");
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.max_tokens, undefined); // no limit by default
});

test("summarizeMessages: includes Authorization header when API key is configured", async () => {
  process.env.API_KEY = "test-secret";
  setMockPort(MOCK_PORT);
  const { calls } = installFetchMock(() => makeSuccessResponse("ok"));

  await summarizeMessages([{ role: "user", content: "Hello world" }]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, "Bearer test-secret");
});

test("summarizeMessages: builds conversation text from plain string content", async () => {
  setMockPort(MOCK_PORT);
  const { calls } = installFetchMock(() => makeSuccessResponse("ok"));

  const messages: Message[] = [
    { role: "user", content: "First question" },
    { role: "assistant", content: "First answer" },
    { role: "user", content: "Follow-up" },
  ];

  await summarizeMessages(messages);

  const userPayload = calls[0].body.messages[1].content as string;
  assert.ok(userPayload.includes("user: First question"));
  assert.ok(userPayload.includes("assistant: First answer"));
  assert.ok(userPayload.includes("user: Follow-up"));
});

test("summarizeMessages: extracts text from multimodal content array", async () => {
  setMockPort(MOCK_PORT);
  const { calls } = installFetchMock(() => makeSuccessResponse("ok"));

  const messages: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this diagram" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ] as any,
    },
  ];

  await summarizeMessages(messages);

  const userPayload = calls[0].body.messages[1].content as string;
  assert.ok(userPayload.includes("Describe this diagram"));
});

test("summarizeMessages: uses options.maxSummaryTokens when provided", async () => {
  setMockPort(MOCK_PORT);
  const { calls } = installFetchMock(() => makeSuccessResponse("ok"));

  await summarizeMessages([{ role: "user", content: "x" }], {
    maxSummaryTokens: 50,
  });

  assert.equal(calls[0].body.max_tokens, 50);
});

test("summarizeMessages: uses options.model when provided", async () => {
  setMockPort(MOCK_PORT);
  const { calls } = installFetchMock(() => makeSuccessResponse("ok"));

  await summarizeMessages([{ role: "user", content: "x" }], {
    model: "custom-model",
  });

  assert.equal(calls[0].body.model, "custom-model");
});

test("summarizeMessages: compressionRatio is originalTokens / summaryTokens", async () => {
  setMockPort(MOCK_PORT);
  const longConversation = "word ".repeat(400);
  installFetchMock(() => makeSuccessResponse("short summary"));

  const messages: Message[] = [{ role: "user", content: longConversation }];
  const result = await summarizeMessages(messages);

  const expected = result.originalTokens / Math.max(result.summaryTokens, 1);
  assert.ok(Math.abs(result.compressionRatio - expected) < 0.001);
  assert.ok(result.compressionRatio > 1, "long input should compress");
});

test("summarizeMessages: falls back when API returns non-OK status", async () => {
  setMockPort(MOCK_PORT);
  installFetchMock(() => makeErrorResponse(500));

  const result = await summarizeMessages([
    { role: "user", content: "Important question" },
  ]);

  assert.equal(result.summary, "[Summary unavailable - truncated]");
  assert.equal(result.compressionRatio, 0);
  assert.ok(result.originalTokens > 0);
  assert.ok(result.latencyMs >= 0);
});

test("summarizeMessages: falls back when fetch throws network error", async () => {
  setMockPort(MOCK_PORT);
  installFetchMock(() => {
    throw new Error("ECONNREFUSED");
  });

  const result = await summarizeMessages([{ role: "user", content: "test" }]);

  assert.equal(result.summary, "[Summary unavailable - truncated]");
  assert.equal(result.compressionRatio, 0);
});

test("summarizeMessages: falls back when response has no choices", async () => {
  setMockPort(MOCK_PORT);
  installFetchMock(
    () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );

  const result = await summarizeMessages([{ role: "user", content: "test" }]);

  assert.equal(result.summary, "[Summary unavailable - truncated]");
});

test("summarizeMessages: falls back on AbortController timeout", async () => {
  setMockPort(MOCK_PORT);
  installFetchMock(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }
      }),
  );

  const result = await summarizeMessages([{ role: "user", content: "test" }], {
    timeout: 30,
  });

  assert.equal(result.summary, "[Summary unavailable - truncated]");
  assert.equal(result.compressionRatio, 0);
  assert.ok(result.latencyMs >= 25, "must have waited near timeout");
});

test("summarizeMessages: handles empty messages array", async () => {
  setMockPort(MOCK_PORT);
  installFetchMock(() => makeSuccessResponse("summary"));

  const result = await summarizeMessages([]);

  assert.equal(result.originalTokens, 0);
  assert.ok(typeof result.summary === "string");
});

test("summarizeMessages: handles null and object content", async () => {
  setMockPort(MOCK_PORT);
  const { calls } = installFetchMock(() => makeSuccessResponse("ok"));

  const messages: Message[] = [
    { role: "user", content: null as any },
    { role: "assistant", content: { nested: "data" } as any },
  ];

  await summarizeMessages(messages);

  const userPayload = calls[0].body.messages[1].content as string;
  assert.ok(userPayload.includes("user: "));
  assert.ok(userPayload.includes("nested"));
});

test("summarizeMessages: latencyMs reflects elapsed time", async () => {
  setMockPort(MOCK_PORT);
  installFetchMock(
    () =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(makeSuccessResponse("ok")), 40),
      ),
  );

  const result = await summarizeMessages([{ role: "user", content: "x" }]);

  assert.ok(
    result.latencyMs >= 35,
    `latencyMs=${result.latencyMs} should be >= 35`,
  );
});
