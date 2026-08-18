/**
 * LIVE probe: run the real personalization sync (syncQwenRequestPersonalization)
 * for the first configured account with a small instruction and time it. On
 * success this confirms the direct /settings path is fast and stable (the
 * browser page.evaluate / navigation path that used to hang 30s is bypassed).
 *
 *   npx tsx src/benchmarks/live-personalization-sync-probe.ts
 */
import { getQwenHeaders } from "../services/auth-playwright.ts";
import { syncQwenRequestPersonalization } from "../services/qwen.ts";
import { loadAccounts } from "../core/accounts.ts";

async function main() {
  const accounts = loadAccounts();
  const accountId = accounts[0].id;
  await getQwenHeaders(false, accountId);

  const started = Date.now();
  const result = await syncQwenRequestPersonalization(
    "You are a probe. Reply concisely.",
    accountId,
    { model: "qwen3.7-plus", toolsCount: 0, sessionId: null, promptChars: 40, forceSync: true },
  );
  const elapsed = Date.now() - started;
  console.log(`sync result=${result} after ${elapsed}ms (via direct /settings path)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("PROBE ERROR:", e); process.exit(1); });
