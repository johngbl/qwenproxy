import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_PLAYWRIGHT = "true";
process.env.API_KEY = "";

import { app } from "../api/server.js";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";

test("Chat Completions works with the global Playwright session when no accounts are configured", async () => {
  const originalFetch = globalThis.fetch;
  const db = getDatabase();
  const existing = db.prepare("SELECT id, email, password FROM accounts").all();

  db.prepare("DELETE FROM accounts").run();
  invalidateAccountsCache();

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : "url" in input ? input.url : String(input);

    if (url.includes("/api/v2/chat/completions")) {
      const payload = JSON.parse((init?.body as string) || "{}");
      assert.strictEqual(payload.chat_id, "mock-session");

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "answer", "content": "Hello from global"}}]}\n\ndata: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    return originalFetch(input, init);
  };

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.choices[0].message.content, "Hello from global");
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM accounts").run();
    const insert = db.prepare(
      "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
    );
    for (const row of existing as any[]) {
      insert.run(row.id, row.email, row.password);
    }
    invalidateAccountsCache();
  }
});
