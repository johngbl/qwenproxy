import { loadAccounts, type QwenAccount } from "../core/accounts.ts";
import { config } from "../core/config.ts";
import {
  type BrowserType,
  closePlaywright,
  closePlaywrightForAccount,
  initPlaywright,
  initPlaywrightForAccount,
} from "./playwright.ts";
import { deleteAllQwenChats } from "./qwen.ts";

export interface DeleteChatsResult {
  attempted: number;
  succeeded: number;
  mode: "accounts" | "global";
}

export interface DeleteChatsOptions {
  browserType?: BrowserType;
  headless?: boolean;
  useExistingSessions?: boolean;
}

export function resolveBrowserTypeFromArgsAndEnv(
  args: string[] = process.argv,
): BrowserType {
  const browserArg = args.find((arg) => arg.startsWith("--browser="));
  if (browserArg) {
    return browserArg.split("=")[1] as BrowserType;
  }

  return (process.env.BROWSER as BrowserType | undefined) || "chromium";
}

async function deleteChatsForAccount(
  account: QwenAccount,
  options: Required<DeleteChatsOptions>,
): Promise<boolean> {
  if (!options.useExistingSessions) {
    await initPlaywrightForAccount(
      account,
      options.headless,
      options.browserType,
    );
  }

  try {
    return await deleteAllQwenChats(account.id);
  } finally {
    if (!options.useExistingSessions) {
      await closePlaywrightForAccount(account.id);
    }
  }
}

export async function deleteChatsForConfiguredAccounts(
  options: DeleteChatsOptions = {},
): Promise<DeleteChatsResult> {
  const resolved: Required<DeleteChatsOptions> = {
    browserType: options.browserType || "chromium",
    headless: options.headless ?? config.browser.headless,
    useExistingSessions: options.useExistingSessions ?? false,
  };

  const accounts = loadAccounts();
  if (accounts.length === 0) {
    if (!resolved.useExistingSessions) {
      await initPlaywright(resolved.headless, resolved.browserType);
    }

    try {
      const ok = await deleteAllQwenChats();
      return {
        attempted: 1,
        succeeded: ok ? 1 : 0,
        mode: "global",
      };
    } finally {
      if (!resolved.useExistingSessions) {
        await closePlaywright();
      }
    }
  }

  let succeeded = 0;
  for (const account of accounts) {
    try {
      const ok = await deleteChatsForAccount(account, resolved);
      if (ok) {
        succeeded++;
      }
    } catch (error) {
      console.error(
        `[DeleteChats] Failed to delete chats for ${account.email}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (!resolved.useExistingSessions) {
    await closePlaywright();
  }

  return {
    attempted: accounts.length,
    succeeded,
    mode: "accounts",
  };
}
