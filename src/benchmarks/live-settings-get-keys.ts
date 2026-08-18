/**
 * LIVE: dump the top-level keys + types of GET /api/v2/users/user/settings
 * so we can see what `...currentSettings` spreads into the update payload.
 *   npx tsx src/benchmarks/live-settings-get-keys.ts
 */
import { getQwenHeaders } from "../services/auth-playwright.ts";
import { buildQwenRequestHeaders } from "../services/qwen-headers.ts";
import { qwenUrl } from "../services/qwen-url.ts";
import { loadAccounts } from "../core/accounts.ts";

async function main() {
  const accountId = loadAccounts()[0].id;
  const { headers } = await getQwenHeaders(false, accountId);
  const h = buildQwenRequestHeaders({
    cookie: headers.cookie,
    userAgent: headers["user-agent"],
    bxUa: headers["bx-ua"],
    bxUmidtoken: headers["bx-umidtoken"],
    bxV: headers["bx-v"],
    secChUa: headers["sec-ch-ua"] || undefined,
    secChUaMobile: headers["sec-ch-ua-mobile"] || undefined,
    secChUaPlatform: headers["sec-ch-ua-platform"] || undefined,
    version: headers.version || undefined,
    extra: { Referer: qwenUrl("/settings/personalization") },
  });
  const r = await fetch(qwenUrl("/api/v2/users/user/settings"), {
    method: "GET",
    headers: h,
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  const data = j?.data;
  if (!data) {
    console.log("no data, resp:", JSON.stringify(j).slice(0, 300));
    return;
  }
  for (const k of Object.keys(data)) {
    const v = data[k];
    const t = Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v;
    console.log(`${k}: ${t}`);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      console.log(`    keys: ${Object.keys(v).join(", ")}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
