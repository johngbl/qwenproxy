/**
 * LIVE probe: does the WAF block Node/undici completions REGARDLESS of the
 * headers sent? Post the same minimal payload with several header variants:
 *
 *   A full    — captured browser headers (cookie/bx-ua/bx-umidtoken/version/...)
 *   B no-bxua — full minus bx-ua/bx-umidtoken
 *   C cookie  — cookie + Content-Type only (no UA, no bx-*, no version)
 *   D minimal — Content-Type only (no cookie at all)
 *   E bare    — NO headers at all
 *
 * If every variant returns the same FAIL_SYS_USER_VALIDATE/captcha payload,
 * the block is decided by TLS fingerprint (JA3/JA4), not by headers.
 *
 *   npx tsx src/benchmarks/live-direct-probe-headers.ts
 */
import { getQwenHeaders } from "../services/auth-playwright.ts";
import { buildDirectCompletionHeaders } from "../services/qwen.ts";
import { qwenUrl } from "../services/qwen-url.ts";
import { loadAccounts } from "../core/accounts.ts";
import { config } from "../core/config.ts";

async function post(
  label: string,
  headers: Record<string, string> | undefined,
): Promise<void> {
  const model = config.qwen.chatPoolModels[0] || "qwen3.7-plus";
  const timestamp = Math.floor(Date.now() / 1000);
  const fid = crypto.randomUUID();
  const childId = crypto.randomUUID();
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
  const url = qwenUrl("/api/v2/chat/completions");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  try {
    const started = Date.now();
    const res = await fetch(url, {
      method: "POST",
      ...(headers ? { headers } : {}),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const ct = res.headers.get("content-type") || "";
    const body = await res.text();
    const verdict = body.includes("text/event-stream")
      ? "SSE ✓"
      : body.includes("FAIL_SYS_USER_VALIDATE") ||
          body.includes("RGV587_ERROR") ||
          body.includes("___tmd___") ||
          body.includes("punish")
        ? "WAF-BLOCKED"
        : body.includes("Unauthorized") || body.includes("unauthorized")
          ? "AUTH-ERR"
          : "OTHER";
    console.log(
      `[${label.padEnd(8)}] status=${res.status} ct=${ct.slice(0, 30)} elapsed=${Date.now() - started}ms verdict=${verdict}`,
    );
    console.log(`    body: ${body.slice(0, 220)}`);
  } catch (e) {
    console.log(
      `[${label.padEnd(8)}] ERROR: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const accountId = loadAccounts()[0].id;
  const { headers } = await getQwenHeaders(false, accountId);

  const full = buildDirectCompletionHeaders(headers, null);
  const noBxUa = { ...full } as Record<string, string>;
  delete noBxUa["bx-ua"];
  delete noBxUa["bx-umidtoken"];
  const cookieOnly: Record<string, string> = {
    Cookie: headers.cookie,
    "Content-Type": "application/json",
  };
  const minimal: Record<string, string> = {
    "Content-Type": "application/json",
  };

  console.log(
    `captured: cookie=${Boolean(headers.cookie)} bxUa=${Boolean(headers["bx-ua"])} ua=${headers["user-agent"]?.slice(0, 30)}`,
  );
  console.log("== 1x full ==");
  await post("A full", full);
  console.log("== 1x no-bxua ==");
  await post("B no-bxua", noBxUa);
  console.log("== 1x cookie-only ==");
  await post("C cookie", cookieOnly);
  console.log("== 1x minimal ==");
  await post("D minimal", minimal);
  console.log("== 1x bare ==");
  await post("E bare", undefined);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });