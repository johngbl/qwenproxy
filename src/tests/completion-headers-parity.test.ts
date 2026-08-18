import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Completions request-header parity with the real browser client (0.2.86 HAR,
 * network/): the POST carries bx-ua/bx-umidtoken + a chat referer regardless
 * of QWEN_SEND_BX_UA. These are the headers the browser relay sends
 * (buildCompletionHeaders) — the direct Node fetch they were originally built
 * for was removed (the Qwen WAF fingerprints the HTTP stack beyond headers
 * and JA3), but the header shape must stay HAR-aligned.
 */
const VALID_CAPTURED_HEADERS: Record<string, string> = {
  cookie: "qwen_session=abc; x5sec=def",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0",
  "bx-v": "2.5.37",
  "bx-ua": "231!token",
  "bx-umidtoken": "umid-token",
  "sec-ch-ua": '"Edge";v="151"',
  version: "0.2.86",
};

async function loadModule() {
  return await import("../services/qwen.ts");
}

test("completion headers: inject bx-ua/bx-umidtoken and chat referer", async () => {
  const { buildCompletionHeaders } = await loadModule();
  const built = buildCompletionHeaders(VALID_CAPTURED_HEADERS, "chat-9");
  assert.equal(built["bx-ua"], "231!token", "bx-ua must be injected");
  assert.equal(built["bx-umidtoken"], "umid-token", "bx-umidtoken must be injected");
  assert.equal(built["bx-v"], "2.5.37");
  assert.equal(
    built["Referer"],
    "https://chat.qwen.ai/c/chat-9",
    "referer must use the chat id (matches the HAR)",
  );
});

test("completion headers: missing bx tokens stay absent (no fabrication)", async () => {
  const { buildCompletionHeaders } = await loadModule();
  const { "bx-ua": _ua, "bx-umidtoken": _umid, ...rest } = VALID_CAPTURED_HEADERS;
  const built = buildCompletionHeaders(rest, null);
  assert.equal(built["bx-ua"], undefined, "bx-ua must not be fabricated");
  assert.equal(built["bx-umidtoken"], undefined, "bx-umidtoken must not be fabricated");
  assert.equal(
    built["Referer"],
    "https://chat.qwen.ai",
    "no chat id means the root referer",
  );
});
