/**
 * LIVE raw probe: POST the completion from Node with the captured headers and
 * dump the RAW response (status, content-type, body) so we can see exactly what
 * chat.qwen.ai returns to a Node/undici fetch — WAF challenge HTML, a JSON
 * error, or genuine SSE.
 *
 *   npx tsx src/benchmarks/live-direct-probe-raw.ts
 */
import { getQwenHeaders } from "../services/auth-playwright.ts";
import { buildDirectCompletionHeaders } from "../services/qwen.ts";
import { qwenUrl } from "../services/qwen-url.ts";
import { loadAccounts } from "../core/accounts.ts";
import { config } from "../core/config.ts";

async function main() {
  const accounts = loadAccounts();
  const accountId = accounts[0].id;
  const model = config.qwen.chatPoolModels[0] || "qwen3.7-plus";

  const { headers } = await getQwenHeaders(false, accountId);
  console.log("captured: hasCookie=", Boolean(headers.cookie), "hasBxUa=", Boolean(headers["bx-ua"]));

  const timestamp = Math.floor(Date.now() / 1000);
  const fid = crypto.randomUUID();
  const childId = crypto.randomUUID();
  const payload = {
    stream: true, version: "2.1", incremental_output: true,
    chatId: null, parentId: "", chat_id: null, chat_mode: "normal",
    model, parent_id: "",
    messages: [{ id: null, fid, parentId: "", childrenIds: [childId], role: "user", content: "Reply OK", user_action: "chat", files: [], timestamp, models: [model], model: "", chat_type: "t2t" }],
    timestamp: timestamp + 1,
  };

  const url = qwenUrl("/api/v2/chat/completions");
  const reqHeaders = buildDirectCompletionHeaders(headers, null);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 60000);
  try {
    const started = Date.now();
    const res = await fetch(url, { method: "POST", headers: reqHeaders, body: JSON.stringify(payload), signal: controller.signal });
    const ct = res.headers.get("content-type") || "";
    const body = await res.text();
    console.log(`STATUS=${res.status} contentType=${ct} elapsed=${Date.now() - started}ms bodyLen=${body.length}`);
    console.log("HEADERS SENT:", JSON.stringify(Object.keys(reqHeaders)));
    console.log("BODY PREVIEW:", JSON.stringify(body.slice(0, 1200)));
  } catch (e) {
    console.log("FETCH ERROR:", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(t);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
