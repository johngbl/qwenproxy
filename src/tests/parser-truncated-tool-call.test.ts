import test from "node:test";
import assert from "node:assert";

import { StreamingToolParser } from "../tools/parser.ts";

const TOOL_START = "<tool_call>";
const TOOL_END = "</tool_call>";

const declaredTools: any[] = [
  { type: "function", function: { name: "bash", description: "shell", parameters: { type: "object" } } },
  { type: "function", function: { name: "write", description: "write file", parameters: { type: "object" } } },
  { type: "function", function: { name: "grep", description: "search", parameters: { type: "object" } } },
  { type: "function", function: { name: "edit_file", description: "edit", parameters: { type: "object" } } },
];

// logs1 2829-char write drop: a big escaped payload (Python source with
// f-strings and escaped quotes) truncated mid-string.
const py = ` """Fresh-identifier probe: random email per run to test if region error_code 7
is per-identifier throttling."""

from __future__ import annotations

import asyncio
import random
import string
from urllib.parse import urlencode

import httpx

from checker.js_signer import JsSigner
from checker.warmup import warmup

PROXY = "socks5://47.85.195.135:1080"

async def main() -> None:
    email = f"cronus.probe.{''.join(random.choices(string.digits, k=10))}@gmail.com"
    pw = "SenhaFalsa" + "".join(random.choices(string.ascii_letters, k=8))
    print(f"[probe] fresh email: {email}")

    signer = JsSigner()
    client = httpx.AsyncClient(
        proxy=PROXY,
        timeout=httpx.Timeout(15.0, connect=10.0),
        follow_redirects=True,
        http2=True,
    )
    try:
        ctx = await warmup(client, signer, timeout=12.0)
        await signer.push_cookies(
            {c.name: c.value for c in client.cookies.jar if c.name in ("msToken", "ttwid")}
        )
        device_id, csrf = ctx["device_id"], ctx["csrf"]
        print(f"[warmup] ok csrf={csrf[:10]}...")

        region_url = f"https://www.tiktok.com/passport/web/region/?{urlencode(_base_query(device_id))}"
        hashed, typ = _hashed_id(email, True)
        region_body = urlencode({"hashed_id": hashed, "type": str(typ), "aid": "1459"})
        signed = await signer.sign(region_url, method="POST", body=region_body)
        r = await client.post(signed.url, content=region_body, headers=_api_headers(csrf), timeout=12.0)
        print(f"[region] http {r.status_code} body {r.text[:300]}")
`;
const completeWrite = `{"name":"write","arguments":{"content":${JSON.stringify(py)}}}`;
const truncatedWrite = completeWrite.slice(0, 900);

function collect(parser: StreamingToolParser) {
  return {
    malformed: parser.getMalformedToolCalls(),
    emitted: parser.getEmittedToolCallCount(),
    capped: parser.getCappedToolCalls(),
  };
}

test("logs1 repro: truncated escaped payload (no close tag) is tracked malformed, not recovered", () => {
  const parser = new StreamingToolParser(declaredTools, {
    incrementalToolCalls: true,
    maxToolCallsPerTurn: 8,
  });
  parser.feed(`\n${TOOL_START}\n${truncatedWrite}`);
  const flushed = parser.flush();

  const state = collect(parser);
  // The malformed record is what triggers the [SYSTEM CORRECTION] auto-retry.
  assert.strictEqual(state.malformed.length, 1, "truncated payload must be tracked malformed");
  assert.strictEqual(state.malformed[0].category, "truncated");
  // No call materialized and no visible text leaked (the partial arguments
  // deltas are discarded, so the client never sees the broken call).
  assert.strictEqual(flushed.toolCalls.length, 0);
  assert.strictEqual(flushed.text, "");
  assert.strictEqual(flushed.toolCallDeltas.length, 0);
});

test("logs1 repro: truncated payload with close tag present is tracked malformed", () => {
  const parser = new StreamingToolParser(declaredTools, {
    incrementalToolCalls: true,
    maxToolCallsPerTurn: 8,
  });
  parser.feed(`\n${TOOL_START}\n${truncatedWrite}\n${TOOL_END}\n`);
  const flushed = parser.flush();

  const state = collect(parser);
  assert.strictEqual(state.malformed.length, 1, "truncated payload must be tracked malformed");
  assert.strictEqual(flushed.toolCalls.length, 0);
  assert.strictEqual(flushed.text, "");
});

test("logs1 repro: COMPLETE escaped payload still recovers cleanly", () => {
  const parser = new StreamingToolParser(declaredTools);
  const fed = parser.feed(`\n${TOOL_START}\n${completeWrite}\n${TOOL_END}\n`);
  const flushed = parser.flush();

  const state = collect(parser);
  assert.strictEqual(state.malformed.length, 0);
  const calls = [...fed.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(calls.length, 1, "complete payload must parse as one call");
  assert.strictEqual(calls[0].name, "write");
  const content = (calls[0].arguments as any)?.content as string | undefined;
  assert.ok(content, "content argument must be present");
  assert.ok(
    content.includes("Fresh-identifier probe") && content.includes("region_body"),
    "content must NOT be truncated",
  );
});

test("gate is end-balanced, not length-based: unbalanced-quotes payload still recovers (T3 guard)", () => {
  const payload =
    '{"name": "grep", "arguments":regex": "foo </tool_call> bar", "include_pattern": "logs.txt"}}';
  const parser = new StreamingToolParser(declaredTools);
  const fed = parser.feed(`${TOOL_START}${payload}${TOOL_END}`);
  const flushed = parser.flush();

  const state = collect(parser);
  assert.strictEqual(state.malformed.length, 0);
  const calls = [...fed.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(calls.length, 1, "end-balanced payload must still recover");
  assert.strictEqual(calls[0].name, "grep");
});

test("gate does not block double-encoded payloads (still recovered)", () => {
  const payload = '"{\\"name\\":\\"write\\",\\"arguments\\":{\\"content\\":\\"hello\\"}}"';
  const parser = new StreamingToolParser(declaredTools);
  const fed = parser.feed(`${TOOL_START}${payload}${TOOL_END}`);
  const flushed = parser.flush();

  const state = collect(parser);
  assert.strictEqual(state.malformed.length, 0);
  const calls = [...fed.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(calls.length, 1, "double-encoded payload must still recover");
  assert.strictEqual(calls[0].name, "write");
});

// ─── Multi-call pattern (user's Zed agent report) ───────────────────────────
// The model emitted 3 calls in one turn: the first inside a proper
// `<tool_call>` pair, the next two MISSING their opening tag, all using
// `arguments":` (missing opening quote on the key), plus a stray extra
// `</tool_call>` at the end. The Zed client reported "tool input was not
// fully received" because the two list_directory calls vanished silently.
const multiCallTools: any[] = [
  { type: "function", function: { name: "read_file", description: "", parameters: { type: "object" } } },
  { type: "function", function: { name: "list_directory", description: "", parameters: { type: "object" } } },
];

const multiCallPattern =
  `${TOOL_START}{"name":"read_file",arguments":{"path":"C:\\\\Users\\\\John\\\\Desktop\\\\EscolaChave\\\\frontend\\\\package.json"}}\n` +
  `${TOOL_END}\n` +
  `{"name":"list_directory",arguments":{"path":"C:\\\\Users\\\\John\\\\Desktop\\\\EscolaChave\\\\backend\\\\src"}}\n` +
  `${TOOL_END}\n` +
  `{"name":"list_directory",arguments":{"path":"C:\\\\Users\\\\John\\\\Desktop\\\\EscolaChave\\\\frontend\\\\src"}}\n` +
  `${TOOL_END}\n` +
  `${TOOL_END}`;

function feedChunked(parser: StreamingToolParser, text: string, chunkSize: number) {
  const calls: any[] = [];
  let outText = "";
  for (let i = 0; i < text.length; i += chunkSize) {
    const r = parser.feed(text.slice(i, i + chunkSize));
    calls.push(...r.toolCalls);
    outText += r.text;
  }
  const flushed = parser.flush();
  calls.push(...flushed.toolCalls);
  outText += flushed.text;
  return { calls, outText };
}

test("multi-call pattern: all 3 calls recovered with intact arguments (single feed)", () => {
  const parser = new StreamingToolParser(multiCallTools);
  const fed = parser.feed(multiCallPattern);
  const flushed = parser.flush();

  const state = collect(parser);
  assert.strictEqual(state.malformed.length, 0);
  const calls = [...fed.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(calls.length, 3, "all three calls must be recovered");
  assert.strictEqual(calls[0].name, "read_file");
  assert.strictEqual(calls[1].name, "list_directory");
  assert.strictEqual(calls[2].name, "list_directory");
  assert.strictEqual(
    (calls[0].arguments as any).path,
    "C:\\Users\\John\\Desktop\\EscolaChave\\frontend\\package.json",
  );
  assert.strictEqual(
    (calls[1].arguments as any).path,
    "C:\\Users\\John\\Desktop\\EscolaChave\\backend\\src",
  );
  assert.strictEqual(
    (calls[2].arguments as any).path,
    "C:\\Users\\John\\Desktop\\EscolaChave\\frontend\\src",
  );
});

test("multi-call pattern: all 3 calls recovered at any chunk boundary (chunked feed)", () => {
  for (const chunkSize of [7, 20, 50, 100]) {
    const parser = new StreamingToolParser(multiCallTools);
    const { calls } = feedChunked(parser, multiCallPattern, chunkSize);
    assert.strictEqual(
      calls.length,
      3,
      `chunkSize=${chunkSize}: all three calls must be recovered`,
    );
    assert.deepStrictEqual(
      calls.map((c) => c.name),
      ["read_file", "list_directory", "list_directory"],
      `chunkSize=${chunkSize}: order must be preserved`,
    );
    assert.strictEqual(collect(parser).malformed.length, 0);
  }
});

test("multi-call pattern: prose starting with { outside a tool call is NOT swallowed", () => {
  const parser = new StreamingToolParser(multiCallTools);
  const text = '{"json": true} is a JSON example';
  const { outText, calls } = feedChunked(parser, text, 5);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(outText, text, "prose must be preserved verbatim");
  assert.strictEqual(collect(parser).malformed.length, 0);
});
