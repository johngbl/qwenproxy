/**
 * LIVE definitive personalization probe — NON-DESTRUCTIVE: every POST sends
 * the account's CURRENT instruction back, so the account settings are never
 * overwritten by probe text.
 *
 *   A: repro the OLD sync payload (GET-personalization spread +
 *      enable_for_new_chat) → expect RequestValidationError
 *   B: the CURRENT buildQwenSettingsUpdatePayload output → expect success:true
 *   C: HAR shape + enable_for_new_chat only (no spread) → isolates the culprit
 *   D: QWEN_SAFE_SETTINGS_PATCH combined, no personalization → decides the
 *      disableNativeTools payload shape
 *   E: real syncQwenRequestPersonalization(current instruction, forceSync)
 *      → expect true (end-to-end through the production code path)
 *   F: final GET → instruction hash must be unchanged
 *
 *   npx tsx src/benchmarks/live-personalization-final-probe.ts
 */
import crypto from "node:crypto";
import { getQwenHeaders } from "../services/auth-playwright.ts";
import {
  buildQwenSettingsUpdatePayload,
  syncQwenRequestPersonalization,
} from "../services/qwen.ts";
import { buildQwenRequestHeaders } from "../services/qwen-headers.ts";
import { qwenUrl } from "../services/qwen-url.ts";
import { loadAccounts } from "../core/accounts.ts";

const sha = (s: string) =>
  crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

async function post(
  headers: Record<string, string>,
  payload: unknown,
): Promise<{ status: number; json: any }> {
  const r = await fetch(qwenUrl("/api/v2/users/user/settings/update"), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* WAF HTML or empty */
  }
  return { status: r.status, json };
}

async function getSettings(
  headers: Record<string, string>,
): Promise<{ status: number; json: any }> {
  const r = await fetch(qwenUrl("/api/v2/users/user/settings"), {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: r.status, json };
}

function label(name: string, r: { status: number; json: any }): string {
  if (r.json?.success === true) return `[${name}] status=${r.status} SUCCESS`;
  const code = r.json?.data?.code || "?";
  const msg =
    typeof r.json?.data?.message === "string"
      ? r.json.data.message.slice(0, 160)
      : JSON.stringify(r.json).slice(0, 160);
  return `[${name}] status=${r.status} FAIL code=${code} msg=${msg}`;
}

// Copy of the module-private QWEN_SAFE_SETTINGS_PATCH (qwen.ts) for probe D.
const SAFE_SETTINGS_PATCH = {
  ui: { autoTags: false, largeTextAsFile: false, splitLargeChunks: false },
  mcp_remind: false,
  memory: {
    enable_memory: false,
    enable_history_memory: false,
    memory_version_reminder: false,
  },
  tools_enabled: {
    web_extractor: false,
    web_search_image: false,
    web_search: false,
    image_gen_tool: false,
    code_interpreter: false,
    history_retriever: false,
    image_edit_tool: false,
    bio: false,
    image_zoom_in_tool: false,
  },
};

async function main() {
  const accountId = loadAccounts()[0].id;
  console.log(`account=${accountId}`);
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

  // --- GET: dump the real personalization object (what the spread injects) ---
  const get0 = await getSettings(h);
  const pers = get0.json?.data?.personalization;
  if (!pers) {
    console.log("[GET] FAILED:", JSON.stringify(get0.json).slice(0, 300));
    process.exit(1);
  }
  console.log(
    `[GET] status=${get0.status} personalization keys: ${Object.keys(pers).join(", ")}`,
  );
  for (const [k, v] of Object.entries(pers)) {
    const t = Array.isArray(v)
      ? `array(${v.length})`
      : v === null
        ? "null"
        : typeof v;
    const extra =
      typeof v === "string" && k !== "instruction"
        ? ` =${JSON.stringify(v.slice(0, 60))}`
        : typeof v === "object" && v !== null
          ? ` keys=${Object.keys(v as object).join("|")}`
          : "";
    console.log(`    ${k}: ${t}${extra}`);
  }
  const currentInstruction: string =
    typeof pers.instruction === "string" ? pers.instruction : "";
  const beforeHash = sha(currentInstruction);
  console.log(
    `[GET] instruction chars=${currentInstruction.length} hash=${beforeHash}`,
  );

  // --- A: OLD payload shape (repro): spread of GET personalization + enable_for_new_chat ---
  const oldPayload = {
    personalization: {
      ...pers,
      name: "",
      description: pers.description === undefined ? null : pers.description,
      style: null,
      instruction: currentInstruction,
      enable_for_new_chat: true,
    },
  };
  const a = await post(h, oldPayload);
  console.log(label("A old-payload", a));

  // --- B: CURRENT builder output (post-fix this must be the exact HAR shape) ---
  const builderPayload = buildQwenSettingsUpdatePayload(
    get0.json?.data ?? null,
    currentInstruction,
  );
  console.log(
    `[B] builder payload keys: ${Object.keys((builderPayload as any).personalization).join(", ")}`,
  );
  const b = await post(h, builderPayload);
  console.log(label("B builder", b));

  // --- C: HAR shape + enable_for_new_chat ONLY (no spread) — isolate ---
  const cPayload = {
    personalization: {
      name: typeof pers.name === "string" ? pers.name : "",
      description:
        typeof pers.description === "string" ? pers.description : null,
      style: pers.style && typeof pers.style === "object" ? pers.style : null,
      instruction: currentInstruction,
      enable_for_new_chat: true,
    },
  };
  const c = await post(h, cPayload);
  console.log(label("C har+enable_for_new_chat", c));

  // --- D: safe-settings combined (no personalization) → disableNativeTools shape ---
  const d = await post(h, SAFE_SETTINGS_PATCH);
  console.log(label("D safe-settings-combined", d));

  // --- E: real production sync, forceSync, SAME instruction (non-destructive) ---
  const synced = await syncQwenRequestPersonalization(
    currentInstruction,
    accountId,
    {
      model: "probe",
      toolsCount: 0,
      sessionId: null,
      promptChars: currentInstruction.length,
      forceSync: true,
    },
  );
  console.log(`[E sync] applied=${synced}`);

  // --- F: final GET — instruction must be unchanged ---
  const get1 = await getSettings(h);
  const afterInstruction: string =
    typeof get1.json?.data?.personalization?.instruction === "string"
      ? get1.json.data.personalization.instruction
      : "";
  const afterHash = sha(afterInstruction);
  console.log(
    `[F] instruction unchanged=${afterHash === beforeHash} (before=${beforeHash} after=${afterHash})`,
  );

  const ok =
    b.json?.success === true && synced === true && afterHash === beforeHash;
  console.log(ok ? "PROBE RESULT: PASS" : "PROBE RESULT: FAIL");
  process.exit(ok ? 0 : 1);
}

main()
  .then(() => {})
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
