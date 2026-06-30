/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

import {
  getAccountCredentials,
  loadAccounts,
  type QwenAccount,
} from "../core/accounts.ts";
import { deleteAllQwenChats } from "./qwen.ts";
import {
  initPlaywrightForAccount,
  isPlaywrightInitialized,
  closeAllPlaywright,
} from "./playwright.ts";

export interface DeleteChatsResult {
  attempted: number;
  succeeded: number;
  mode: "accounts" | "global";
}

async function ensurePlaywrightSession(account: QwenAccount): Promise<void> {
  if (isPlaywrightInitialized(account.id)) return;

  const credentials = getAccountCredentials(account.id);
  if (!credentials) {
    throw new Error(`Account ${account.id} credentials not found`);
  }

  console.log(
    `[DeleteChats] Initializing Playwright session for ${account.email}...`,
  );
  await initPlaywrightForAccount(credentials);
  console.log(`[DeleteChats] Playwright session ready for ${account.email}.`);
}

async function deleteChatsForAccount(account: QwenAccount): Promise<boolean> {
  await ensurePlaywrightSession(account);
  return deleteAllQwenChats(account.id);
}

export async function deleteChatsForConfiguredAccounts(): Promise<DeleteChatsResult> {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    const ok = await deleteAllQwenChats();
    return {
      attempted: 1,
      succeeded: ok ? 1 : 0,
      mode: "global",
    };
  }

  let succeeded = 0;

  try {
    for (const account of accounts) {
      try {
        const ok = await deleteChatsForAccount(account);
        if (ok) succeeded++;
      } catch (error) {
        console.error(
          `[DeleteChats] Failed to delete chats for ${account.email}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } finally {
    await closeAllPlaywright().catch((error) => {
      console.warn(
        `[DeleteChats] Failed to close Playwright sessions:`,
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  return {
    attempted: accounts.length,
    succeeded,
    mode: "accounts",
  };
}
