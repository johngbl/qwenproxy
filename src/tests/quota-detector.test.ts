import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import { app } from "../api/server.js";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import {
  clearAllAccountCooldowns,
  getNextAccount,
  getNextAvailableAccount,
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import {
  clearAllModelLimits,
  isAccountModelLimited,
  loadModelLimits,
  markAccountModelLimited,
} from "../core/account-model-limits.ts";
import {
  detectQuotaLimitMessage,
  isQuotaLimitMessage,
} from "../utils/quota-detector.ts";
import { shouldHoldAnswerPrefix } from "../routes/chat/streaming.ts";

test("quota-detector: detects multilingual daily-limit notices and extracts model name", () => {
  const pt = detectQuotaLimitMessage(
    "Você atingiu o limite de hoje para o Qwen3.8-Max. Faça upgrade da sua membership ou mude para outro modelo acima para continuar.",
  );
  assert.equal(pt.isQuotaLimit, true);
  assert.equal(pt.model, "Qwen3.8-Max");

  const en = detectQuotaLimitMessage(
    "You've reached today's usage limit for Qwen3.7-Plus. Upgrade your membership or switch to another model.",
  );
  assert.equal(en.isQuotaLimit, true);
  assert.equal(en.model, "Qwen3.7-Plus");

  assert.equal(isQuotaLimitMessage("Has alcanzado el límite de hoy. Cambia a otro modelo."), true);
  assert.equal(isQuotaLimitMessage("已达到今日的使用限额，请切换到其他模型"), true);
  assert.equal(isQuotaLimitMessage("本日の利用制限に達しました"), true);
  assert.equal(isQuotaLimitMessage("오늘의 사용 한도에 도달했습니다"), true);
});

test("quota-detector: never flags code fences, tool calls, or normal answers", () => {
  assert.equal(
    isQuotaLimitMessage("```ts\nconst msg = 'You have reached daily limit';\n```"),
    false,
  );
  assert.equal(
    isQuotaLimitMessage('<tool_call>{"name":"read_file","arguments":{"path":"quota.ts"}}</tool_call>'),
    false,
  );
  assert.equal(isQuotaLimitMessage("Here is how rate limiting works in Redis."), false);
  assert.equal(isQuotaLimitMessage("x".repeat(1200)), false);
});

test("account-model-limits: isolates limit per (account, model) without blocking other models", () => {
  const db = getDatabase();
  const originalEnv = process.env.QWEN_ACCOUNTS;
  delete process.env.QWEN_ACCOUNTS;
  const existing = db.prepare("SELECT id, email, password FROM accounts").all();
  db.prepare("DELETE FROM accounts").run();
  db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)").run("ml-1", "ml1@test.com", "p1");
  db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)").run("ml-2", "ml2@test.com", "p2");
  invalidateAccountsCache();
  clearAllAccountCooldowns();
  clearAllModelLimits();
  markAccountHeadersReady("ml-1");
  markAccountHeadersReady("ml-2");

  try {
    markAccountModelLimited("ml-1", "qwen3.8-max", Date.now() + 60_000);
    assert.equal(isAccountModelLimited("ml-1", "qwen3.8-max"), true);
    // Same base model via thinking/effort alias shares the limit
    assert.equal(isAccountModelLimited("ml-1", "qwen3.8-max-low"), true);
    // Different model on the SAME account stays usable
    assert.equal(isAccountModelLimited("ml-1", "qwen3.7-plus"), false);

    // Picker for qwen3.8-max must avoid ml-1 and pick ml-2
    const maxPick1 = getNextAccount("qwen3.8-max");
    const maxPick2 = getNextAvailableAccount(new Set(), "qwen3.8-max");
    assert.equal(maxPick1?.id, "ml-2");
    assert.equal(maxPick2?.id, "ml-2");

    // Persistence survives memory reload
    loadModelLimits();
    assert.equal(isAccountModelLimited("ml-1", "qwen3.8-max"), true);
  } finally {
    clearAllAccountCooldowns();
    clearAllModelLimits();
    unmarkAccountHeadersReady("ml-1");
    unmarkAccountHeadersReady("ml-2");
    db.prepare("DELETE FROM accounts").run();
    const insert = db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)");
    for (const row of existing as any[]) insert.run(row.id, row.email, row.password);
    invalidateAccountsCache();
    if (originalEnv !== undefined) process.env.QWEN_ACCOUNTS = originalEnv;
  }
});

test("shouldHoldAnswerPrefix: releases immediately for code/tools/markdown/JSON, holds short ambiguous prose", () => {
  assert.equal(shouldHoldAnswerPrefix("```ts\nconst x = 1;"), false);
  assert.equal(shouldHoldAnswerPrefix("<tool_call>"), false);
  assert.equal(shouldHoldAnswerPrefix("# Heading\nSome text"), false);
  assert.equal(shouldHoldAnswerPrefix('{"ok": true}'), false);
  assert.equal(shouldHoldAnswerPrefix("Line one\nLine two with enough text"), false);

  assert.equal(shouldHoldAnswerPrefix("Estamos"), true);
  assert.equal(shouldHoldAnswerPrefix("Estamos com alta demanda no momento."), true);
  assert.equal(shouldHoldAnswerPrefix("a".repeat(250)), false);
});

test("stream failover: incremental multi-chunk overload notice never leaks to client and rotates account", async () => {
  const db = getDatabase();
  const acc1 = "inc-ov-1";
  const acc2 = "inc-ov-2";
  db.prepare("INSERT OR REPLACE INTO accounts (id, email, password) VALUES (?, ?, ?)").run(acc1, "ov1@test.com", "p1");
  db.prepare("INSERT OR REPLACE INTO accounts (id, email, password) VALUES (?, ?, ?)").run(acc2, "ov2@test.com", "p2");
  invalidateAccountsCache();
  clearAllAccountCooldowns();
  clearAllModelLimits();

  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : "url" in input ? input.url : String(input);
    if (url.includes("/api/v2/chats/new")) {
      return new Response(JSON.stringify({ chat_id: `chat-${attempts}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/v2/chat/completions")) {
      attempts++;
      if (attempts === 1) {
        // Real Qwen Web chunking: word-by-word incremental deltas!
        const sse = [
          'data: {"choices":[{"delta":{"phase":"answer","content":"Estamos"}}]}\n\n',
          'data: {"choices":[{"delta":{"phase":"answer","content":" com alta demanda no"}}]}\n\n',
          'data: {"choices":[{"delta":{"phase":"answer","content":" momento."}}]}\n\n',
          "data: [DONE]\n\n",
        ].join("");
        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      const okSse = [
        'data: {"choices":[{"delta":{"phase":"answer","content":"CLEAN_RECOVERED_ANSWER"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return new Response(okSse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return originalFetch(input, init);
  };

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.7-plus",
        messages: [{ role: "user", content: "Say hello" }],
        stream: true,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body.includes("Estamos"), false, `Overload prefix leaked to client: ${body}`);
    assert.equal(body.includes("alta demanda"), false, `Overload message leaked: ${body}`);
    assert.equal(body.includes("CLEAN_RECOVERED_ANSWER"), true, `Expected clean recovery, got: ${body}`);
    assert.ok(attempts >= 2);
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM accounts WHERE id IN (?, ?)").run(acc1, acc2);
    invalidateAccountsCache();
    clearAllAccountCooldowns();
    clearAllModelLimits();
  }
});

test("stream failover: incremental plain-text daily-limit notice rotates account without leaking notice", async () => {
  const db = getDatabase();
  const acc1 = "inc-ql-1";
  const acc2 = "inc-ql-2";
  db.prepare("INSERT OR REPLACE INTO accounts (id, email, password) VALUES (?, ?, ?)").run(acc1, "ql1@test.com", "p1");
  db.prepare("INSERT OR REPLACE INTO accounts (id, email, password) VALUES (?, ?, ?)").run(acc2, "ql2@test.com", "p2");
  invalidateAccountsCache();
  clearAllAccountCooldowns();
  clearAllModelLimits();

  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : "url" in input ? input.url : String(input);
    if (url.includes("/api/v2/chats/new")) {
      return new Response(JSON.stringify({ chat_id: `chat-${attempts}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/v2/chat/completions")) {
      attempts++;
      if (attempts === 1) {
        const sse = [
          'data: {"choices":[{"delta":{"phase":"answer","content":"Você atingiu"}}]}\n\n',
          'data: {"choices":[{"delta":{"phase":"answer","content":" o limite de hoje para o Qwen3.8-Max."}}]}\n\n',
          'data: {"choices":[{"delta":{"phase":"answer","content":" Faça upgrade da sua membership."}}]}\n\n',
          "data: [DONE]\n\n",
        ].join("");
        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      const okSse = [
        'data: {"choices":[{"delta":{"phase":"answer","content":"QUOTA_FAILOVER_OK"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return new Response(okSse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return originalFetch(input, init);
  };

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.8-max",
        messages: [{ role: "user", content: "Solve task" }],
        stream: true,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body.includes("atingiu"), false, `Quota notice leaked: ${body}`);
    assert.equal(body.includes("QUOTA_FAILOVER_OK"), true, `Expected failover output, got: ${body}`);
    assert.ok(attempts >= 2);
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM accounts WHERE id IN (?, ?)").run(acc1, acc2);
    invalidateAccountsCache();
    clearAllAccountCooldowns();
    clearAllModelLimits();
  }
});
