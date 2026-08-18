/**
 * LIVE: reproduce the sync's exact update payload and POST it, printing the
 * JSON so we can see which field trips RequestValidationError.
 *   npx tsx src/benchmarks/live-sync-repro.ts
 */
import { getQwenHeaders } from "../services/auth-playwright.ts";
import {
  buildQwenSettingsUpdatePayload,
  requestQwenSettingsDirectFetch,
} from "../services/qwen.ts";
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

  const get = await requestQwenSettingsDirectFetch(
    accountId, "GET", "/api/v2/users/user/settings", h,
  );
  const currentSettings = get?.json?.data ?? null;

  const payload = buildQwenSettingsUpdatePayload(currentSettings, "probe test");
  console.log("PAYLOAD:", JSON.stringify(payload).slice(0, 500));

  const post = await requestQwenSettingsDirectFetch(
    accountId, "POST", "/api/v2/users/user/settings/update", h, payload as any,
  );
  console.log("POST result:", post ? `status=${post.status} body=${post.raw.slice(0, 300)}` : "UNDEFINED (fell back)");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
