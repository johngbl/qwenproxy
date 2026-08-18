/**
 * LIVE probe: does the direct (Node-side) completion fetch actually return a
 * clean SSE stream against the real chat.qwen.ai, or does the WAF block it
 * (falling back to the browser relay)?
 *
 * Runs the real header capture (Playwright) + a real POST to /chat/completions
 * with a minimal payload. Prints the outcome. Not part of the test suite.
 *
 *   npx tsx src/benchmarks/live-direct-probe.ts
 */
import { getQwenHeaders } from "../services/auth-playwright.ts";
import { tryDirectCompletionFetch } from "../services/qwen.ts";
import { qwenUrl } from "../services/qwen-url.ts";
import { loadAccounts } from "../core/accounts.ts";
import { config } from "../core/config.ts";

async function main() {
  const accounts = loadAccounts();
  if (!accounts.length) {
    console.log("NO ACCOUNTS");
    return;
  }
  const accountId = accounts[0].id;
  const model = config.qwen.chatPoolModels[0] || "qwen3.7-plus";
  console.log("account:", accountId.slice(0, 12), "model:", model);

  const { headers } = await getQwenHeaders(false, accountId);
  console.log(
    "captured headers:",
    {
      hasCookie: Boolean(headers.cookie),
      ua: headers["user-agent"]?.slice(0, 40),
      bxV: headers["bx-v"],
      hasBxUa: Boolean(headers["bx-ua"]),
      version: headers.version,
    },
  );

  const timestamp = Math.floor(Date.now() / 1000);
  const fid = crypto.randomUUID();
  const childId = crypto.randomUUID();
  const chatId = ""; // empty = new chat (no id) — mirrors the client's first turn
  const payload = {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chatId: null,
    parentId: "",
    chat_id: null,
    chat_mode: "normal",
    model,
    parent_id: "",
    messages: [
      {
        id: null,
        fid,
        parentId: "",
        childrenIds: [childId],
        role: "user",
        content: "Reply with exactly: OK",
        user_action: "chat",
        files: [],
        timestamp,
        models: [model],
        model: "",
        chat_type: "t2t",
      },
    ],
    timestamp: timestamp + 1,
  };

  const url = qwenUrl(
    chatId
      ? `/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`
      : "/api/v2/chat/completions",
  );
  const signal = new AbortController().signal;
  const started = Date.now();
  const result = await tryDirectCompletionFetch(
    accountId,
    chatId || null,
    url,
    JSON.stringify(payload),
    headers,
    signal,
  );
  const elapsed = Date.now() - started;

  if (!result) {
    console.log(`RESULT: UNDEFINED after ${elapsed}ms — direct fetch failed/WAF-blocked, will fall back to browser relay`);
    return;
  }
  console.log(`RESULT: SSE response (${result.status}) in ${elapsed}ms`);
  const reader = result.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (let i = 0; i < 3; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.length > 500) break;
  }
  reader.cancel().catch(() => {});
  console.log("first bytes:", JSON.stringify(buf.slice(0, 500)));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("PROBE ERROR:", e);
    process.exit(1);
  });
