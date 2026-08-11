import test from "node:test";
import assert from "node:assert";
import { Logger } from "../core/logger.ts";

const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

function capture(
  method: "log" | "warn" | "error",
  fn: (log: Logger) => void,
): string {
  // Logger.debug/info write via console.log; warn/error map 1:1.
  const target = (method === "log" ? "log" : method) as "log" | "warn" | "error";
  const original = console[target];
  let captured = "";
  const stub = (msg?: unknown, ...args: unknown[]) => {
    captured += String(msg) + (args.length ? " " + args.join(" ") : "") + "\n";
  };
  console[target] = stub as typeof console.log;
  try {
    fn(new Logger("debug", "unit-test"));
  } finally {
    console[target] = original;
  }
  return captured;
}

// Audit finding 7.2: the sanitizer must redact loose JWTs (eyJ...) even when
// they appear without a labeled key, inside nested values or inside message
// payload previews — and must not break non-secret log data.
test("9.5: sensitive keys are redacted in structured data", () => {
  const out = capture("warn", (log) => {
    log.warn("credentials present", {
      authorization: "Bearer abc123",
      api_key: "sk-test-abcdefghijklmnopqrstuvwxyz",
      cookie: "x5secdata=deadbeef",
      password: "hunter2",
      token: FAKE_JWT,
      nested: { auth: "secret", ok: "fine" },
    });
  });

  assert.doesNotMatch(out, /Bearer abc123/);
  assert.doesNotMatch(out, /sk-test-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(out, /x5secdata=deadbeef/);
  assert.doesNotMatch(out, /hunter2/);
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1Ni/);
  assert.match(out, /"ok": "fine"/, "non-sensitive values pass through");
});

test("9.5: loose JWT inside a string value is redacted (no labeled key)", () => {
  const out = capture("error", (log) => {
    log.error("upstream payload", {
      detail: `session=${FAKE_JWT} scope="chat"`,
    });
  });
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1Ni/);
  assert.match(out, /\[REDACTED\]/);
  assert.match(out, /scope=/, "non-secret string content passes through");
});

test("9.5: loose JWT inside the message itself is redacted", () => {
  const out = capture("error", (log) => {
    log.error(`auth failed: ${FAKE_JWT}`, { code: 401 });
  });
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1Ni/);
  assert.match(out, /\[REDACTED\]/);
  assert.match(out, /"code": 401/);
});

test("9.5: redaction is recursive through arrays and quoted JSON dumps", () => {
  const out = capture("warn", (log) => {
    log.warn("malformed tool call", {
      content: `{"name": "grep", "arguments": {"auth": "Bearer ${FAKE_JWT}"}}`,
      history: [
        { token: FAKE_JWT },
        { value: "plain" },
      ],
    });
  });
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1Ni/);
  assert.match(out, /\[REDACTED\]/);
  assert.match(out, /"value": "plain"/);
});

test("9.5: non-secret content is not over-redacted", () => {
  const out = capture("log", (log) => {
    log.info("request", {
      model: "qwen3.8-max",
      path: "src/browser/worker.js",
      chars: 275520,
      note: "base64 eyJhbGci fragment without dots is not a JWT",
      timestamp: new Date("2026-08-09T00:00:00.000Z"),
    });
  });
  assert.match(out, /"model": "qwen3.8-max"/);
  assert.match(out, /"chars": 275520/);
  assert.match(out, /eyJhbGci fragment/);
  assert.match(out, /2026-08-09T00:00:00\.000Z/, "Date serializes as before");
  assert.doesNotMatch(out, /\[REDACTED\]/);
});

// Auditor follow-up: WAF cookie families ship many variants (x5sec_v3,
// x5sec-cn, bx-temp, bx-user...) and the project's real credentials ARE these
// cookies — the exact-match key list missed them.
test("9.5: WAF cookie variants (x5sec_*, x5sec-*, bx-*) are redacted", () => {
  const out = capture("warn", (log) => {
    log.warn("waf state", {
      x5sec: "deadbeef",
      x5sec_v3: "deadbeef1234",
      "x5sec-cn": "deadbeef",
      bx_tmp: "t0",
      "bx-temp": "t1",
      "bx-user": "u1",
      "bx-vid": "v1",
      note: "plain",
    });
  });
  for (const leaked of ["deadbeef", "deadbeef1234", "t0", "t1", "u1", "v1"]) {
    assert.doesNotMatch(out, new RegExp(leaked), `value ${leaked} must be redacted`);
  }
  assert.match(out, /"note": "plain"/);
});

// Auditor follow-up: class instances (sessions, response wrappers) must not
// bypass redaction, and credentials embedded in header strings (cookie jars)
// must be redacted even without a labeled key.
test("9.5: class instances and header-string credentials are redacted", () => {
  class Session {
    token = "sk-test-abcdefghijklmnopqrstuvwxyz";
    account = "ok-account";
  }
  const out = capture("error", (log) => {
    log.error("upstream failed", {
      session: new Session(),
      headers: "cookie: x5sec_v3=leaky-v3; bx-temp=leaky-temp; bx_tmp=leaky-tmp2",
      authLine: "authorization: Bearer " + FAKE_JWT,
    });
  });
  assert.doesNotMatch(out, /sk-test-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(out, /leaky-v3/);
  assert.doesNotMatch(out, /leaky-temp/);
  assert.doesNotMatch(out, /leaky-tmp2/);
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1Ni/);
  assert.match(out, /"account": "ok-account"/, "non-secret class props pass");
});
