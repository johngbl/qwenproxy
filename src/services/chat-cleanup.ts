/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

import { loadAccounts, type QwenAccount } from "../core/accounts.ts";
import { deleteAllQwenChats } from "./qwen.ts";

export interface DeleteChatsResult {
  attempted: number;
  succeeded: number;
  mode: "accounts" | "global";
}

async function deleteChatsForAccount(account: QwenAccount): Promise<boolean> {
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

  return {
    attempted: accounts.length,
    succeeded,
    mode: "accounts",
  };
}
