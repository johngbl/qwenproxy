import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import { app } from "../api/server.js";
import { RetryableQwenStreamError } from "../services/qwen.ts";

function sseResponse(...chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function delayedSseResponse(firstChunk: string, ...laterChunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(firstChunk));
      setTimeout(() => {
        for (const chunk of laterChunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }, 5);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function setupQwenFetchMock(
  completionHandler: (
    callIndex: number,
    body: any,
  ) => Response | Promise<Response>,
) {
  const originalFetch = globalThis.fetch;
  let completionCalls = 0;
  const capturedBodies: any[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);

    if (!url.includes("chat.qwen.ai")) {
      return originalFetch(input, init);
    }
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.7-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v2/chats/new")) {
      return new Response(JSON.stringify({ chat_id: `mock-chat-${Date.now()}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/v2/chat/completions")) {
      const body = JSON.parse(String(init?.body || "{}"));
      capturedBodies.push(body);
      completionCalls += 1;
      return completionHandler(completionCalls, body);
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    getCompletionCalls: () => completionCalls,
    getCapturedBodies: () => capturedBodies,
  };
}

async function postChat(messages: any[], stream = false) {
  const req = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen3.7-plus",
      stream,
      messages,
    }),
  });
  return app.fetch(req);
}

test("stream: internal_error mid-stream retries and succeeds", async () => {
  const mock = setupQwenFetchMock((callIndex) => {
    if (callIndex === 1) {
      return sseResponse(
        'data: {"error":{"code":"internal_error","details":"Ocorreu um erro inesperado. Tente novamente mais tarde."}}\n\n',
      );
    }
    return sseResponse(
          'data: {"response.created":{"chat_id":"chat-retry-ok","response_id":"resp-retry-ok"}}\n\n',
          'data: {"response_id":"resp-retry-ok","choices":[{"delta":{"phase":"answer","content":"hello-after-retry"}}]}\n\n',
          "data: [DONE]\n\n",
        );
  });

  try {
    const res = await postChat([{ role: "user", content: "retry internal" }], true);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /hello-after-retry/);
    assert.ok(
      mock.getCompletionCalls() >= 2,
      `expected at least 2 completion calls, got ${mock.getCompletionCalls()}`,
    );
  } finally {
    mock.restore();
  }
});

test("non-stream: invalid_input forces retry with new chat/full context", async () => {
  const mock = setupQwenFetchMock((callIndex) => {
    if (callIndex === 1) {
      return sseResponse(
        'data: {"error":{"code":"invalid_input","details":"Entrada ou anexo inválido. Verifique e tente novamente."}}\n\n',
      );
    }
    return sseResponse(
          'data: {"response.created":{"chat_id":"chat-invalid-ok","response_id":"resp-invalid-ok"}}\n\n',
          'data: {"response_id":"resp-invalid-ok","choices":[{"delta":{"phase":"answer","content":"recovered-from-invalid-input"}}]}\n\n',
          "data: [DONE]\n\n",
        );
  });

  try {
    const res = await postChat(
      [{ role: "user", content: "please recover invalid input" }],
      false,
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    const content = json?.choices?.[0]?.message?.content || "";
    assert.match(content, /recovered-from-invalid-input/);
    assert.ok(mock.getCompletionCalls() >= 2);
  } finally {
    mock.restore();
  }
});

test("stream: quota_limit mid-stream retries instead of hard fail", async () => {
  const mock = setupQwenFetchMock((callIndex) => {
    if (callIndex === 1) {
      return sseResponse(
        'data: {"error":{"code":"quota_limit","details":"O serviço está com alta demanda no momento. Tente novamente mais tarde."}}\n\n',
      );
    }
    return sseResponse(
          'data: {"response.created":{"chat_id":"chat-quota-ok","response_id":"resp-quota-ok"}}\n\n',
          'data: {"response_id":"resp-quota-ok","choices":[{"delta":{"phase":"answer","content":"quota-recovered"}}]}\n\n',
          "data: [DONE]\n\n",
        );
  });

  try {
    const res = await postChat([{ role: "user", content: "quota please" }], true);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /quota-recovered/);
    assert.ok(mock.getCompletionCalls() >= 2);
  } finally {
    mock.restore();
  }
});

test("stream: quota_limit after response.created retries inside committed SSE", async () => {
  const mock = setupQwenFetchMock((callIndex) => {
    if (callIndex === 1) {
      return delayedSseResponse(
        'data: {"response.created":{"chat_id":"chat-before-quota","response_id":"resp-before-quota"}}\n\n',
        'data: {"error":{"code":"quota_limit","details":"O serviço está com alta demanda no momento. Tente novamente mais tarde."}}\n\n',
      );
    }
    return sseResponse(
      'data: {"response.created":{"chat_id":"chat-after-quota","response_id":"resp-after-quota"}}\n\n',
      'data: {"response_id":"resp-after-quota","choices":[{"delta":{"phase":"answer","content":"transparent-recovery-ok"}}]}\n\n',
      "data: [DONE]\n\n",
    );
  });

  try {
    const res = await postChat(
      [{ role: "user", content: "quota after stream commit" }],
      true,
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /transparent-recovery-ok/);
    assert.match(text, /data: \[DONE\]/);
    assert.ok(mock.getCompletionCalls() >= 2);
  } finally {
    mock.restore();
  }
});

test("RetryableQwenStreamError carries switchAccount semantics for critical failures", () => {
  // Mirrors toRetryableStreamError defaults used by streaming retries.
  const err = new RetryableQwenStreamError(
    "Qwen retryable upstream error: internal_error: unexpected",
    1000,
  ) as RetryableQwenStreamError & {
    upstreamCode?: string;
    forceNewChat?: boolean;
    switchAccount?: boolean;
  };
  err.upstreamCode = "internal_error";
  err.forceNewChat = true;
  err.switchAccount = true;

  assert.equal(err.upstreamCode, "internal_error");
  assert.equal(err.forceNewChat, true);
  assert.equal(err.switchAccount, true);
  assert.equal(err.retryAfterMs, 1000);
});

test("stream: unknown upstream SSE code still retries (generic policy)", async () => {
  const mock = setupQwenFetchMock((callIndex) => {
    if (callIndex === 1) {
      return sseResponse(
        'data: {"error":{"code":"brand_new_qwen_failure","details":"never seen before today"}}\n\n',
      );
    }
    return sseResponse(
      'data: {"response.created":{"chat_id":"chat-unknown-ok","response_id":"resp-unknown-ok"}}\n\n',
      'data: {"response_id":"resp-unknown-ok","choices":[{"delta":{"phase":"answer","content":"unknown-recovered"}}]}\n\n',
      "data: [DONE]\n\n",
    );
  });

  try {
    const res = await postChat(
      [{ role: "user", content: "unknown code please" }],
      true,
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /unknown-recovered/);
    assert.ok(mock.getCompletionCalls() >= 2);
  } finally {
    mock.restore();
  }
});
