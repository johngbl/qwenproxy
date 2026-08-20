/**
 * LIVE probe: does a Qwen "temp chat" (chat_mode:"local") persist in the
 * account's chat history / chat list?
 *
 * Ground truth from network/chat.qwen.ai.tempchat.har: the only payload
 * difference vs a normal new chat is `"chat_mode":"local"` (normal = "normal"),
 * in both `POST /api/v2/chats/new` and the completions payload. The UI opens
 * `/c/local` for temp chats.
 *
 * This probe (non-destructive — it only CREATES two throwaway chats and reads
 * the list, no account settings touched):
 *
 *   1. Baseline list  GET /api/v2/chats/?page=1&exclude_project=true
 *   2. Control        POST /api/v2/chats/new  chat_mode:"normal"  → normalId
 *   3. Temp           POST /api/v2/chats/new  chat_mode:"local"   → tempId
 *   4. After list     GET /api/v2/chats/?page=1&exclude_project=true
 *
 * Verdict: normalId MUST appear (proves the list reflects new chats); tempId
 * SHOULD NOT appear (proves temp chats are ephemeral / not persisted).
 *
 * Uses the production browser-relay path (requestQwenTextInBrowser) — the same
 * one createQwenChatSession / fetchUnusedChats use — so the result matches
 * what the proxy would observe.
 *
 *   npx tsx src/benchmarks/live-tempchat-persistence-probe.ts
 */
import { getQwenHeaders } from "../services/auth-playwright.ts";
import { requestQwenTextInBrowser } from "../services/qwen.ts";
import { buildQwenRequestHeaders } from "../services/qwen-headers.ts";
import { qwenUrl } from "../services/qwen-url.ts";
import { loadAccounts } from "../core/accounts.ts";

const MODEL = "qwen3.7-plus";

function buildNewChatBody(mode: "normal" | "local"): string {
  return JSON.stringify({
    chatId: "",
    models: [MODEL],
    project_id: "",
    timestamp: Date.now(),
    chat_type: "t2t",
    chat_mode: mode,
  });
}

async function createChat(
  accountId: string,
  headers: Record<string, string>,
  mode: "normal" | "local",
): Promise<{ id: string; status: number; json: any }> {
  const res = await requestQwenTextInBrowser(
    accountId,
    "POST",
    "/api/v2/chats/new",
    headers,
    buildNewChatBody(mode),
    { referrer: qwenUrl("/") },
  );
  const raw = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* WAF HTML / empty */
  }
  const id =
    typeof json?.data?.id === "string" ? json.data.id : "";
  return { id, status: res.status, json };
}

async function listChatIds(
  accountId: string,
  headers: Record<string, string>,
): Promise<{ ids: Set<string>; count: number; status: number; json: any }> {
  const res = await requestQwenTextInBrowser(
    accountId,
    "GET",
    "/api/v2/chats/?page=1&exclude_project=true",
    headers,
    undefined,
    { referrer: qwenUrl("/settings/chats") },
  );
  const raw = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  const data = Array.isArray(json?.data) ? json.data : [];
  const ids = new Set<string>();
  for (const chat of data) {
    if (typeof chat?.id === "string") ids.add(chat.id);
  }
  return { ids, count: data.length, status: res.status, json };
}

async function main() {
  const accounts = loadAccounts();
  const accountId = accounts[0]?.id;
  if (!accountId) {
    console.error("No Qwen accounts configured.");
    process.exit(1);
  }
  console.log(`account=${accountId} model=${MODEL}`);

  const { headers } = await getQwenHeaders(false, accountId);
  const requestHeaders = buildQwenRequestHeaders({
    cookie: headers["cookie"],
    userAgent: headers["user-agent"],
    bxUa: headers["bx-ua"],
    bxUmidtoken: headers["bx-umidtoken"],
    bxV: headers["bx-v"],
    secChUa: headers["sec-ch-ua"] || undefined,
    secChUaMobile: headers["sec-ch-ua-mobile"] || undefined,
    secChUaPlatform: headers["sec-ch-ua-platform"] || undefined,
    version: headers.version || undefined,
  });

  const before = await listChatIds(accountId, requestHeaders);
  console.log(
    `[list:before] status=${before.status} chats=${before.count}`,
  );

  const control = await createChat(accountId, requestHeaders, "normal");
  console.log(
    `[create:normal] status=${control.status} id=${control.id || "(none)"}`,
  );

  const temp = await createChat(accountId, requestHeaders, "local");
  console.log(
    `[create:temp]   status=${temp.status} id=${temp.id || "(none)"}`,
  );

  const after = await listChatIds(accountId, requestHeaders);
  console.log(
    `[list:after]  status=${after.status} chats=${after.count}`,
  );

  if (!control.id || !temp.id) {
    console.error(
      "PROBE RESULT: FAIL — could not create one or both chats (see status above).",
    );
    process.exit(1);
  }

  const controlPersisted = after.ids.has(control.id);
  const tempPersisted = after.ids.has(temp.id);

  console.log("");
  console.log(`[control normal] ${control.id} in list = ${controlPersisted}`);
  console.log(`[temp local]     ${temp.id} in list = ${tempPersisted}`);
  console.log("");

  const ok = controlPersisted && !tempPersisted;
  console.log(
    ok
      ? "PROBE RESULT: PASS — temp chat (chat_mode:local) does NOT persist; normal chat DOES."
      : "PROBE RESULT: FAIL — unexpected persistence behavior (see above).",
  );
  process.exit(ok ? 0 : 1);
}

main()
  .then(() => {})
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
