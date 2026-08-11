import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

const {
  installContextDeathHandlers,
  isPlaywrightInitialized,
  registerPlaywrightAccountForTests,
} = await import("../services/playwright.ts");

/**
 * Renderer crashes ("page.evaluate: Target crashed", observed under a 650KB
 * context) and browser deaths used to leave a zombie account entry: every
 * subsequent page operation failed while the maps still claimed the account
 * was initialized. The death handlers must forget the state so the next use
 * re-initializes.
 */
function makeFakeContextAndPage() {
  const handlers: Record<string, Array<() => void>> = {};
  const context: any = {
    on: (event: string, cb: () => void) => {
      (handlers[`context:${event}`] ||= []).push(cb);
    },
    browser: () => ({ process: () => null }),
    pages: () => [],
    close: async () => {},
  };
  const page: any = {
    on: (event: string, cb: () => void) => {
      (handlers[`page:${event}`] ||= []).push(cb);
    },
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    close: async () => {},
  };
  const fire = (key: string): void => {
    for (const cb of handlers[key] || []) cb();
  };
  return { context, page, fire };
}

test("page crash forgets the zombie account state", async () => {
  const accountId = "death-page-crash";
  const { context, page, fire } = makeFakeContextAndPage();
  registerPlaywrightAccountForTests(accountId, page, Date.now());
  installContextDeathHandlers(accountId, context as any, page as any);

  assert.equal(isPlaywrightInitialized(accountId), true);
  fire("page:crash");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    isPlaywrightInitialized(accountId),
    false,
    "crashed account must be re-initializable on next use",
  );
});

test("context close forgets the account state", async () => {
  const accountId = "death-context-close";
  const { context, page, fire } = makeFakeContextAndPage();
  registerPlaywrightAccountForTests(accountId, page, Date.now());
  installContextDeathHandlers(accountId, context as any, page as any);

  assert.equal(isPlaywrightInitialized(accountId), true);
  fire("context:close");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(isPlaywrightInitialized(accountId), false);
});
