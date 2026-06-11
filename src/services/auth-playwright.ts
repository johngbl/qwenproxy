import { AuthError } from "../core/errors.ts";
import { loadAccounts } from "../core/accounts.ts";
import {
  getBasicHeaders as getPlaywrightBasicHeaders,
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
