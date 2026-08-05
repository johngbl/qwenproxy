import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";

const originalMockAuth = process.env.TEST_MOCK_QWEN_AUTH;
const originalQwenAccounts = process.env.QWEN_ACCOUNTS;

function snapshotAccounts(): any[] {
  return getDatabase()
    .prepare("SELECT id, email, password, cooldown_until, cooldown_reason FROM accounts")
    .all() as any[];
}

function restoreAccounts(rows: any[]): void {
  const db = getDatabase();
  db.prepare("DELETE FROM accounts").run();
  const insert = db.prepare(
    "INSERT INTO accounts (id, email, password, cooldown_until, cooldown_reason) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.email,
      row.password,
      row.cooldown_until ?? 0,
      row.cooldown_reason ?? null,
    );
  }
  invalidateAccountsCache();
}

afterEach(() => {
  if (originalMockAuth === undefined) delete process.env.TEST_MOCK_QWEN_AUTH;
  else process.env.TEST_MOCK_QWEN_AUTH = originalMockAuth;

  if (originalQwenAccounts === undefined) delete process.env.QWEN_ACCOUNTS;
  else process.env.QWEN_ACCOUNTS = originalQwenAccounts;

  invalidateAccountsCache();
});

test("auth-playwright: mock mode returns complete headers", async () => {
  process.env.TEST_MOCK_QWEN_AUTH = "true";
  const { getBasicHeaders, getQwenHeaders, isAuthMockEnabled } = await import(
    "../services/auth-playwright.ts"
  );

  assert.equal(isAuthMockEnabled(), true);

  const basic = await getBasicHeaders();
  assert.equal(basic.cookie, "token=mock");
  assert.equal(basic.userAgent, "mock");
  assert.equal(basic.bxV, "2.5.36");
  assert.equal(basic.bxUa, "mock-bx-ua");
  assert.equal(basic.bxUmidtoken, "mock-bx-umidtoken");

  const full = await getQwenHeaders(true);
  assert.equal(full.headers.cookie, "token=mock");
  assert.equal(full.headers["bx-ua"], "mock-bx-ua");
  assert.equal(full.parentMessageId, null);
});

test("auth-playwright: requires configured account outside mock mode", async () => {
  const existing = snapshotAccounts();
  delete process.env.TEST_MOCK_QWEN_AUTH;
  delete process.env.QWEN_ACCOUNTS;

  try {
    restoreAccounts([]);
    const { getBasicHeaders } = await import("../services/auth-playwright.ts");
    await assert.rejects(
      () => getBasicHeaders(),
      /No Qwen accounts configured/,
    );
  } finally {
    restoreAccounts(existing);
  }
});

test("auth-playwright: only a parseable JWT expiry triggers proactive refresh", async () => {
  const { isTokenExpiringSoon } = await import("../services/auth-playwright.ts");
  const now = Math.floor(Date.now() / 1000);
  const token = (exp: number) =>
    `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;

  assert.equal(isTokenExpiringSoon("token=opaque-qwen-session"), false);
  assert.equal(isTokenExpiringSoon("session=without-token"), false);
  assert.equal(isTokenExpiringSoon("token=not.a.valid.jwt"), false);
  assert.equal(isTokenExpiringSoon(`token=${token(now + 60)}`), true);
  assert.equal(isTokenExpiringSoon(`token=${token(now - 1)}`), true);
  assert.equal(isTokenExpiringSoon(`token=${token(now + 3600)}`), false);
});

test("playwright header capture rejects empty headers and timeouts", async () => {
  const { captureQwenHeaders, hasRequiredQwenHeaders } = await import(
    "../services/playwright.ts"
  );

  assert.equal(hasRequiredQwenHeaders({}), false);
  assert.equal(
    hasRequiredQwenHeaders({ "bx-ua": "present", "bx-umidtoken": " " }),
    false,
  );
  assert.equal(
    hasRequiredQwenHeaders({
      "bx-ua": "present",
      "bx-umidtoken": "present",
    }),
    true,
  );

  let timeoutUnroutes = 0;
  const timeoutPage = {
    isClosed: () => false,
    route: async () => {},
    unroute: async () => {
      timeoutUnroutes++;
    },
    goto: () => new Promise<void>(() => {}),
  };
  await assert.rejects(
    () => captureQwenHeaders("test-header-timeout", timeoutPage as any, 20),
    /timed out/,
  );
  assert.equal(timeoutUnroutes, 1);

  let incompleteUnroutes = 0;
  const incompletePage = {
    isClosed: () => false,
    route: async (_pattern: string, handler: any) => {
      await handler(
        { abort: async () => {} },
        { headers: () => ({ "bx-ua": "present" }) },
      );
    },
    unroute: async () => {
      incompleteUnroutes++;
    },
  };
  await assert.rejects(
    () => captureQwenHeaders("test-header-incomplete", incompletePage as any, 20),
    /incomplete anti-fraud headers/,
  );
  assert.equal(incompleteUnroutes, 1);
});

test("playwright header capture gives up shortly after a send that fires no request", async () => {
  const { captureQwenHeaders } = await import("../services/playwright.ts");

  const invisible = {
    first: () => invisible,
    isVisible: async () => false,
    waitFor: async () => undefined,
    boundingBox: async () => null,
  };
  const silentPage = {
    isClosed: () => false,
    route: async () => {},
    unroute: async () => {},
    goto: async () => {},
    locator: () => invisible,
    frameLocator: () => ({ locator: () => invisible }),
    focus: async () => {},
    fill: async () => {},
    type: async () => {},
    $: async () => null,
    keyboard: { press: async () => {} },
  };

  const startedAt = Date.now();
  await assert.rejects(
    // The overall budget is 30s; the send completes but no completion request
    // ever arrives, so only the trigger grace period may be spent.
    () => captureQwenHeaders("test-header-silent", silentPage as any, 30_000, 50),
    /timed out/,
  );
  assert.ok(
    Date.now() - startedAt < 15_000,
    "capture must not wait out the full header budget after the send",
  );
});

/**
 * Fake page whose send produces one completion request per attempt, with the
 * headers taken from `headerSets` in order (the last entry repeats).
 */
function makeRetriggerPage(headerSets: Record<string, string>[]) {
  const invisible = {
    first: () => invisible,
    isVisible: async () => false,
    waitFor: async () => undefined,
    boundingBox: async () => null,
  };
  const state = { sends: 0, unroutes: 0, aborts: 0 };
  let handler: any;

  const page = {
    isClosed: () => false,
    route: async (_pattern: string, routeHandler: any) => {
      handler = routeHandler;
    },
    unroute: async () => {
      state.unroutes++;
    },
    goto: async () => {},
    locator: () => invisible,
    frameLocator: () => ({ locator: () => invisible }),
    focus: async () => {
      // Stands in for the completion request the previous/next send fires: one
      // interception per trigger attempt, at a point the attempt is still alive.
      const headers = headerSets[Math.min(state.sends, headerSets.length - 1)];
      state.sends++;
      await handler(
        {
          abort: async () => {
            state.aborts++;
          },
        },
        { headers: () => headers },
      );
    },
    fill: async () => {},
    type: async () => {},
    $: async () => null,
    keyboard: { press: async () => {} },
  };

  return { page, state };
}

test("playwright header capture re-triggers the send after incomplete headers", async () => {
  const { captureQwenHeaders } = await import("../services/playwright.ts");

  // First interception is missing bx-umidtoken (the bx SDK had not computed it
  // yet); the re-triggered send carries both headers.
  const { page, state } = makeRetriggerPage([
    { "bx-ua": "present" },
    { "bx-ua": "present", "bx-umidtoken": "present", cookie: "token=x" },
  ]);

  // 30s budget: the two hard-coded 2s sleeps in the trigger sequence plus the
  // settle delay have to fit, the grace window never should.
  await captureQwenHeaders("test-header-retrigger", page as any, 30_000, 50);

  assert.equal(state.sends, 2, "the incomplete interception must cost one extra send");
  assert.equal(state.aborts, 2, "no intercepted request may reach Qwen");
  assert.equal(state.unroutes, 1);
});

test("playwright header capture stops re-triggering when headers stay incomplete", async () => {
  const { captureQwenHeaders } = await import("../services/playwright.ts");

  const { page, state } = makeRetriggerPage([{ "bx-ua": "present" }]);

  const startedAt = Date.now();
  await assert.rejects(
    () => captureQwenHeaders("test-header-retrigger-exhausted", page as any, 30_000, 50),
    /incomplete anti-fraud headers/,
  );
  assert.ok(
    state.sends <= 3,
    `bounded re-triggers expected, got ${state.sends} sends`,
  );
  assert.ok(
    Date.now() - startedAt < 20_000,
    "capture must not keep re-sending for the whole header budget",
  );
  assert.equal(state.unroutes, 1);
});

test("auth-playwright: falls back to first configured account when no account id is provided", async () => {
  const existing = snapshotAccounts();
  delete process.env.TEST_MOCK_QWEN_AUTH;
  delete process.env.QWEN_ACCOUNTS;

  try {
    restoreAccounts([
      {
        id: "auth-pw-account",
        email: "auth-pw@example.com",
        password: "secret",
        cooldown_until: 0,
        cooldown_reason: null,
      },
    ]);

    const { getBasicHeaders } = await import("../services/auth-playwright.ts");
    await assert.rejects(
      () => getBasicHeaders(),
      /Playwright not initialized for account: auth-pw-account/,
    );
  } finally {
    restoreAccounts(existing);
  }
});
