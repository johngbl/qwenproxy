/**
 * LIVE schema probe: which settings/update payloads does the current Qwen API
 * accept? Tests each partial payload + the full spread used by
 * buildQwenSettingsUpdatePayload (which the sync currently sends and which a
 * live test showed is rejected with RequestValidationError).
 *
 *   npx tsx src/benchmarks/live-settings-schema-probe.ts
 */
import { getQwenHeaders } from "../services/auth-playwright.ts";
import { buildQwenRequestHeaders } from "../services/qwen-headers.ts";
import { qwenUrl } from "../services/qwen-url.ts";
import { loadAccounts } from "../core/accounts.ts";

const hdrs = (h: Record<string, string>) =>
  buildQwenRequestHeaders({
    cookie: h.cookie,
    userAgent: h["user-agent"],
    bxUa: h["bx-ua"],
    bxUmidtoken: h["bx-umidtoken"],
    bxV: h["bx-v"],
    secChUa: h["sec-ch-ua"] || undefined,
    secChUaMobile: h["sec-ch-ua-mobile"] || undefined,
    secChUaPlatform: h["sec-ch-ua-platform"] || undefined,
    version: h.version || undefined,
    extra: { Referer: qwenUrl("/settings/personalization") },
  });

const personalization = {
  name: "",
  description: null,
  style: null,
  instruction: "probe schema test",
  enable_for_new_chat: true,
};

const TOOLS = ["web_extractor","web_search_image","web_search","image_gen_tool","code_interpreter","history_retriever","image_edit_tool","bio","image_zoom_in_tool"];

async function tryPost(headers: Record<string, string>, payload: unknown, label: string) {
  try {
    const r = await fetch(qwenUrl("/api/v2/users/user/settings/update"), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    const short = text.length > 140 ? text.slice(0, 140) + "..." : text;
    console.log(`[${label}] status=${r.status} -> ${short}`);
  } catch (e) {
    console.log(`[${label}] ERROR:`, e instanceof Error ? e.message : String(e));
  }
}

async function main() {
  const accountId = loadAccounts()[0].id;
  const { headers } = await getQwenHeaders(false, accountId);
  const h = hdrs(headers);

  await tryPost(h, { personalization }, "personalization-only");
  await tryPost(h, { tools_enabled: Object.fromEntries(TOOLS.map((t) => [t, false])) }, "tools_enabled-only");
  await tryPost(h, { ui: { autoTags: false, largeTextAsFile: false, splitLargeChunks: false } }, "ui-only");
  await tryPost(h, { memory: { enable_memory: false, enable_history_memory: false } }, "memory-only");
  await tryPost(h, { mcp_remind: false }, "mcp_remind-only");
  // The current sync payload, now broken:
  await tryPost(h, {
    ui: { autoTags: false, largeTextAsFile: false, splitLargeChunks: false },
    mcp_remind: false,
    memory: { enable_memory: false, enable_history_memory: false },
    tools_enabled: Object.fromEntries(TOOLS.map((t) => [t, false])),
    personalization,
  }, "FULL (current sync)");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
