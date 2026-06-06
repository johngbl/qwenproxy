/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

import { loadAccounts, type QwenAccount } from "../core/accounts.ts";
import { initHttpAuth, initHttpAuthForAccount } from "./auth-http.ts";
import { deleteAllQwenChats } from "./qwen.ts";

export interface DeleteChatsResult {
  attempted: number;
  succeeded: number;
  mode: "accounts" | "global";
}

export interface DeleteChatsOptions {
  useExistingSessions?: boolean;
}

async function deleteChatsForAccount(
  account: QwenAccount,
  options: Required<DeleteChatsOptions>,
): Promise<boolean> {
  if (!options.useExistingSessions) {
    await initHttpAuthForAccount(account, true);
  }

  return deleteAllQwenChats(account.id);
}

export async function deleteChatsForConfiguredAccounts(
  options: DeleteChatsOptions = {},
): Promise<DeleteChatsResult> {
  const resolved: Required<DeleteChatsOptions> = {
    useExistingSessions: options.useExistingSessions ?? false,
  };

  const accounts = loadAccounts();
  if (accounts.length === 0) {
    if (!resolved.useExistingSessions) {
      await initHttpAuth(true);
    }

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
      const ok = await deleteChatsForAccount(account, resolved);
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
