/**
 * LIVE raw probe: GET /api/v2/users/user/settings (and POST .../update) from
 * Node with captured headers — does the WAF block /settings too, or is it
 * reachable directly (unlike /chat/completions)?
 *
 *   npx tsx src/benchmarks/live-settings-probe-raw.ts
 */
import { getQwenHeaders } from "../services/auth-playwright.ts";
import { buildQwenRequestHeaders } from "../services/qwen-headers.ts";
import { qwenUrl } from "../services/qwen-url.ts";
import { loadAccounts } from "../core/accounts.ts";

const refHeaders = (h: Record<string, string>) =>
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

function log(label: string, res: any, body: string) {
  console.log(`\n[${label}] status=${res?.status} ct=${res?.headers?.get?.("content-type") || ""} bodyLen=${body?.length || 0}`);
  console.log("body:", JSON.stringify((body || "").slice(0, 400)));
}

async function main() {
  const accounts = loadAccounts();
  const accountId = accounts[0].id;
  await getQwenHeaders(false, accountId);
  const { headers } = await getQwenHeaders(false, accountId);

  const getHeaders = refHeaders(headers);
  const postHeaders = refHeaders(headers);

  // GET settings
  try {
    const r = await fetch(qwenUrl("/api/v2/users/user/settings"), {
      method: "GET",
      headers: getHeaders,
      signal: AbortSignal.timeout(60000),
    });
    log("GET settings", r, await r.text());
  } catch (e) {
    console.log("GET settings ERROR:", e instanceof Error ? e.message : String(e));
  }

  // POST settings/update (minimal personalization payload)
  try {
    const r = await fetch(qwenUrl("/api/v2/users/user/settings/update"), {
      method: "POST",
      headers: postHeaders,
      body: JSON.stringify({ personalization: { name: "", style: null, instruction: "test" } }),
      signal: AbortSignal.timeout(60000),
    });
    log("POST settings/update", r, await r.text());
  } catch (e) {
    console.log("POST settings/update ERROR:", e instanceof Error ? e.message : String(e));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
