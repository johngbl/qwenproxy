import { AuthError } from "../core/errors.ts";
import { getAccountCredentials, loadAccounts } from "../core/accounts.ts";
import { config } from "../core/config.ts";
import {
  getBasicHeaders as getPlaywrightBasicHeaders,
  initPlaywrightForAccount,
  isPlaywrightInitialized,
  refreshHeaders,
} from "./playwright.ts";

export interface HeaderResult {
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
}

export function isAuthMockEnabled(): boolean {
  return (
    process.env.TEST_MOCK_QWEN_AUTH === "true" &&
    process.env.NODE_ENV !== "production"
  );
}

function isRunningUnderNodeTest(): boolean {
  return process.argv.some(
    (arg) =>
      arg === "--test" ||
      arg.includes("src/tests/") ||
      arg.includes("src\\tests\\"),
  );
}

async function ensurePlaywrightInitialized(accountId: string): Promise<void> {
  if (isPlaywrightInitialized(accountId)) return;

  if (isRunningUnderNodeTest()) {
    throw new Error(`Playwright not initialized for account: ${accountId}`);
  }

  const credentials = getAccountCredentials(accountId);
  if (!credentials) {
    throw new AuthError(`Qwen account ${accountId} is not configured.`);
  }

  await initPlaywrightForAccount(
    credentials,
    config.playwright.headless,
    config.playwright.browser,
  );
}

export async function getBasicHeaders(accountId?: string): Promise<{
  cookie: string;
  userAgent: string;
  bxV: string;
  bxUa: string;
  bxUmidtoken: string;
}> {
  if (isAuthMockEnabled()) {
    return {
      cookie: "token=mock",
      userAgent: "mock",
      bxV: "2.5.36",
      bxUa: "mock-bx-ua",
      bxUmidtoken: "mock-bx-umidtoken",
    };
  }

  const resolvedAccountId = accountId ?? loadAccounts()[0]?.id;
  if (!resolvedAccountId) {
    throw new AuthError(
      "No Qwen accounts configured. Add accounts with npm run login.",
    );
  }

  await ensurePlaywrightInitialized(resolvedAccountId);
  return getPlaywrightBasicHeaders(resolvedAccountId);
}

export async function getQwenHeaders(
  forceNew = false,
  accountId?: string,
): Promise<HeaderResult> {
  if (isAuthMockEnabled()) {
    const basic = await getBasicHeaders(accountId);
    return {
      headers: {
        cookie: basic.cookie,
        "user-agent": basic.userAgent,
        "bx-v": basic.bxV,
        "bx-ua": basic.bxUa,
        "bx-umidtoken": basic.bxUmidtoken,
      },
      chatSessionId: "",
      parentMessageId: null,
    };
  }

  const resolvedAccountId = accountId ?? loadAccounts()[0]?.id;
  if (!resolvedAccountId) {
    throw new AuthError(
      "No Qwen accounts configured. Add accounts with npm run login.",
    );
  }

  await ensurePlaywrightInitialized(resolvedAccountId);

  if (forceNew) {
    await refreshHeaders(resolvedAccountId);
  }

  const basic = await getPlaywrightBasicHeaders(resolvedAccountId);
  return {
    headers: {
      cookie: basic.cookie,
      "user-agent": basic.userAgent,
      "bx-v": basic.bxV,
      "bx-ua": basic.bxUa || "",
      "bx-umidtoken": basic.bxUmidtoken || "",
    },
    chatSessionId: "",
    parentMessageId: null,
  };
}
