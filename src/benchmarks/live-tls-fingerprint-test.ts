/**
 * LIVE probe: brute-force which TLS-fingerprint client gets completions past
 * the Qwen WAF. Uses the SAME minimal payload + captured headers for every
 * attempt, so the only variable is the TLS stack.
 *
 *   npx tsx src/benchmarks/live-tls-fingerprint-test.ts
 */
import { getQwenHeaders } from "../services/auth-playwright.ts";
import { buildDirectCompletionHeaders } from "../services/qwen.ts";
import { qwenUrl } from "../services/qwen-url.ts";
import { loadAccounts } from "../core/accounts.ts";
import { config } from "../core/config.ts";

function makePayload() {
  const model = config.qwen.chatPoolModels[0] || "qwen3.7-plus";
  const timestamp = Math.floor(Date.now() / 1000);
  const fid = crypto.randomUUID();
  const childId = crypto.randomUUID();
  return {
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
}

function classify(body: string, ct: string): string {
  if (ct.includes("text/event-stream")) return "SSE ✅";
  if (
    body.includes("FAIL_SYS_USER_VALIDATE") ||
    body.includes("RGV587_ERROR") ||
    body.includes("___tmd___") ||
    body.includes("punish")
  )
    return "WAF-BLOCKED";
  if (body.includes("Unauthorized") || body.includes("unauthorized"))
    return "AUTH-ERR";
  if (body.includes('"success"')) return "UPSTREAM-JSON";
  return "OTHER";
}

async function testNodeFetch(headers: Record<string, string>) {
  const started = Date.now();
  try {
    const res = await fetch(qwenUrl("/api/v2/chat/completions"), {
      method: "POST",
      headers,
      body: JSON.stringify(makePayload()),
      signal: AbortSignal.timeout(30000),
    });
    const ct = res.headers.get("content-type") || "";
    const body = await res.text();
    console.log(
      `[node-fetch      ] status=${res.status} elapsed=${Date.now() - started}ms verdict=${classify(body, ct)}`,
    );
  } catch (e) {
    console.log(`[node-fetch      ] ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function testTlsClient(
  label: string,
  clientIdentifier: string,
  headers: Record<string, string>,
) {
  try {
    // Non-literal specifier: the package is optional (not in dependencies);
    // a static import string would fail tsc when it is not installed.
    const spec = "tls-client-node" as string;
    const { ClientIdentifier, TLSClient } = await import(spec);
    const ident =
      (ClientIdentifier as any)[clientIdentifier] ?? clientIdentifier;
    // native mode: load the already-downloaded .dll via koffi directly — no
    // managed tls-client-api sidecar (which downloads more binaries and hangs).
    const client = new TLSClient({ runtimeMode: "native" });
    const started = Date.now();
    const session = client.session({
      clientIdentifier: ident,
      timeoutSeconds: 30,
      forceHttp1: false,
    });
    const res = await session.post(qwenUrl("/api/v2/chat/completions"), {
      headers,
      body: JSON.stringify(makePayload()),
    });
    const ct = (res.headers?.["content-type"]?.[0] as string) || "";
    const body = await res.text();
    console.log(
      `[tls:${label.padEnd(6)}] status=${res.status} elapsed=${Date.now() - started}ms verdict=${classify(body, ct)}`,
    );
    console.log(`      body: ${body.slice(0, 160)}`);
    await session.close().catch(() => {});
    await client.stop().catch(() => {});
  } catch (e) {
    console.log(
      `[tls:${label.padEnd(6)}] SKIPPED/ERROR: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
    );
  }
}

async function main() {
  const accountId = loadAccounts()[0].id;
  const { headers } = await getQwenHeaders(false, accountId);
  const full = buildDirectCompletionHeaders(headers, null);
  console.log(
    `captured: cookie=${Boolean(headers.cookie)} bxUa=${Boolean(headers["bx-ua"])} ua=${headers["user-agent"]?.slice(0, 30)}`,
  );

  console.log("\n== node-fetch (OpenSSL baseline) ==");
  await testNodeFetch(full);

  console.log("\n== tls-client-node (Rust TLS) ==");
  for (const name of ["chrome_146"]) {
    await testTlsClient(`ch146`, name, full);
  }

  console.log("\n== node-tls-client (bogdanfinn, koffi direct) ==");
  await testNodeTlsClient(full);
}

async function testNodeTlsClient(headers: Record<string, string>) {
  let initTLS: any, Session: any, ClientIdentifier: any, destroyTLS: any;
  try {
    // Non-literal specifier: the package is optional (local-only, not in
    // dependencies); a static import string fails tsc in CI where it is
    // not installed (TS2307).
    const spec = "node-tls-client" as string;
    ({ initTLS, Session, ClientIdentifier, destroyTLS } = await import(spec));
  } catch (e) {
    console.log(
      `[node-tls-client ] SKIPPED: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
    );
    return;
  }
  await initTLS();
  try {
    const session = new Session({
      clientIdentifier: ClientIdentifier.chrome_136,
      timeout: 30000,
    });
    const started = Date.now();
    const res = await session.post(qwenUrl("/api/v2/chat/completions"), {
      headers,
      body: JSON.stringify(makePayload()),
    });
    const ct = String(res.headers?.["content-type"] || "");
    const body = await res.text();
    console.log(
      `[node-tls-client ] status=${res.status} elapsed=${Date.now() - started}ms verdict=${classify(body, ct)}`,
    );
    console.log(`      body: ${body.slice(0, 160)}`);
    await session.close().catch(() => {});
  } catch (e) {
    console.log(
      `[node-tls-client ] ERROR: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    await destroyTLS().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });