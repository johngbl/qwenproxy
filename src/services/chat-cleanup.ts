import {
  getAccountCredentials,
  loadAccounts,
  type QwenAccount,
} from "../core/accounts.ts";
import {
  deleteAllQwenChats,
  deleteSingleQwenChat,
  fetchRemoteQwenChats,
} from "./qwen.ts";
import {
  initPlaywrightForAccount,
  isPlaywrightInitialized,
  closeAllPlaywright,
  getActivePlaywrightAccountIds,
} from "./playwright.ts";
import { isChatSessionActive } from "./qwen-thread-state.ts";
import { hasActiveAccountLease, isAccountBusy } from "../core/account-concurrency.ts";
import { isAuthMockEnabled } from "./auth-playwright.ts";
import { maskEmail, logger } from "../core/logger.ts";
import { config } from "../core/config.ts";
import { sleep } from "./human-behavior.ts";
import { metrics } from "../core/metrics.ts";

export interface DeleteChatsResult {
  attempted: number;
  succeeded: number;
  mode: "accounts";
}

async function ensurePlaywrightSession(
  account: QwenAccount,
  index = 1,
  total = 1,
): Promise<void> {
  if (isPlaywrightInitialized(account.id) || isAuthMockEnabled()) return;

  const credentials = getAccountCredentials(account.id);
  if (!credentials) {
    throw new Error(`Credenciais da conta ${account.id} não encontradas.`);
  }

  console.log(
    `[DeleteChats] [${index}/${total}] Abrindo navegador para ${maskEmail(account.email)}...`,
  );
  await initPlaywrightForAccount(credentials, true, "chromium", {
    skipHeaderCapture: true,
  });
  console.log(
    `✅ [DeleteChats] [${index}/${total}] Sessão pronta para ${maskEmail(account.email)}.`,
  );
}

export async function deleteChatsForAccount(
  account: QwenAccount,
  index = 1,
  total = 1,
): Promise<boolean> {
  await ensurePlaywrightSession(account, index, total);
  console.log(
    `🗑️  [DeleteChats] [${index}/${total}] Apagando conversas remotas de ${maskEmail(account.email)}...`,
  );
  const ok = await deleteAllQwenChats(account.id);
  if (ok) {
    console.log(
      `✅ [DeleteChats] [${index}/${total}] Conversas apagadas com sucesso para ${maskEmail(account.email)}.`,
    );
  }
  return ok;
}

export async function deleteChatsForAccountId(accountId: string): Promise<boolean> {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    throw new Error(`Conta ${accountId} não encontrada.`);
  }
  const credentials = getAccountCredentials(account.id);
  if (!credentials) {
    throw new Error(`Credenciais da conta ${account.email} não encontradas.`);
  }
  const wasInitialized = isPlaywrightInitialized(account.id);
  try {
    return await deleteChatsForAccount(credentials);
  } finally {
    if (!wasInitialized && !isAuthMockEnabled()) {
      const { closePlaywrightForAccount } = await import("./playwright.ts");
      await closePlaywrightForAccount(account.id).catch(() => {});
    }
  }
}

export async function deleteChatsForConfiguredAccounts(keepBrowserOpen = false): Promise<DeleteChatsResult> {
  // Playwright requests are account-scoped. Use every account persisted in the
  // database, including accounts created through `npm run login`, instead of
  // falling back to a global request without an account context.
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    throw new Error(
      "No Qwen accounts configured. Add an account with npm run login.",
    );
  }

  let succeeded = 0;

  try {
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const currentIdx = i + 1;
      const totalCount = accounts.length;
      const wasInitialized = isPlaywrightInitialized(account.id);
      try {
        const ok = await deleteChatsForAccount(account, currentIdx, totalCount);
        if (ok) succeeded++;
      } catch (error) {
        console.error(
          `❌ [DeleteChats] [${currentIdx}/${totalCount}] Falha ao apagar conversas de ${maskEmail(account.email)}:`,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if ((!keepBrowserOpen || !wasInitialized) && !isAuthMockEnabled()) {
          const { closePlaywrightForAccount } = await import("./playwright.ts");
          await closePlaywrightForAccount(account.id).catch(() => {});
        }
      }
    }
  } finally {
    if (!keepBrowserOpen) {
      await closeAllPlaywright().catch((error) => {
        console.warn(
          `[DeleteChats] Failed to close Playwright sessions:`,
          error instanceof Error ? error.message : String(error),
        );
      });
    }
  }
  return {
    attempted: accounts.length,
    succeeded,
    mode: "accounts",
  };
}

interface OrphanChatEntry {
  accountId: string;
  chatId: string;
  reason: string;
  enqueuedAt: number;
}

const orphanChatQueue: OrphanChatEntry[] = [];
let isProcessingQueue = false;

export function getOrphanQueueLengthForTests(): number {
  return orphanChatQueue.length;
}

/**
 * Enqueues an abandoned/orphan chat for asynchronous deletion in background.
 * Never blocks the calling request and never deletes a chat actively in use.
 */
export function enqueueOrphanChatDeletion(
  accountId: string,
  chatId: string,
  reason = "orphan",
): void {
  if (!config.qwen.autoCleanOrphanChats || !accountId || !chatId) return;
  if (orphanChatQueue.some((e) => e.accountId === accountId && e.chatId === chatId)) {
    return;
  }
  orphanChatQueue.push({
    accountId,
    chatId,
    reason,
    enqueuedAt: Date.now(),
  });

  if (!isProcessingQueue) {
    const timer = setTimeout(() => {
      void processOrphanChatQueue().catch(() => {});
    }, 1_000);
    timer.unref?.();
  }
}

async function processOrphanChatQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  try {
    while (orphanChatQueue.length > 0) {
      const entry = orphanChatQueue[0];

      // Never delete a chat that is currently actively bound to an ongoing session
      if (isChatSessionActive(entry.chatId)) {
        orphanChatQueue.shift();
        continue;
      }

      // If the account is actively serving a stream, postpone deletion
      if (!isAuthMockEnabled() && isAccountBusy(entry.accountId)) {
        await sleep(2_000);
        continue;
      }

      try {
        const ok = await deleteSingleQwenChat(entry.accountId, entry.chatId);
        if (ok) {
          metrics.increment("chats.cleaned");
          logger.debug("[ChatCleanup] Deleted orphan chat", {
            accountId: entry.accountId,
            chatId: entry.chatId,
            reason: entry.reason,
          });
        }
      } catch (err) {
        logger.debug("[ChatCleanup] Failed to delete orphan chat", {
          accountId: entry.accountId,
          chatId: entry.chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      orphanChatQueue.shift();
      if (orphanChatQueue.length > 0) {
        await sleep(300);
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

export async function drainOrphanChatQueueForTests(): Promise<void> {
  await processOrphanChatQueue();
}

/**
 * Scan an account's remote chat list and delete chats older than maxAgeHours,
 * skipping any chat that is currently actively bound to a session.
 */
export async function cleanOldChatsForAccount(
  accountId: string,
  maxAgeHours = config.qwen.autoCleanChatMaxAgeHours,
): Promise<number> {
  try {
    const chats = await fetchRemoteQwenChats(accountId);
    if (!Array.isArray(chats) || chats.length === 0) return 0;

    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const now = Date.now();
    let cleaned = 0;

    for (const chat of chats) {
      if (!chat?.id) continue;
      if (isChatSessionActive(chat.id)) continue;

      const updatedMs =
        typeof chat.updated_at === "number"
          ? (chat.updated_at > 1e11 ? chat.updated_at : chat.updated_at * 1000)
          : new Date(chat.updated_at).getTime();

      if (now - updatedMs >= maxAgeMs) {
        // Cooperative yield: if account becomes active with a request, stop cleanup immediately
        if (hasActiveAccountLease(accountId) || isAccountBusy(accountId)) {
          break;
        }

        const ok = await deleteSingleQwenChat(accountId, chat.id);
        if (ok) {
          cleaned++;
          metrics.increment("chats.cleaned");
          await sleep(150);
        }
      }
    }

    if (cleaned > 0) {
      console.log(
        `🧹 [ChatCleanup] Remotely cleaned ${cleaned} old chat(s) (> ${maxAgeHours}h) for account ${accountId}`,
      );
    }
    return cleaned;
  } catch (error) {
    logger.debug("[ChatCleanup] cleanOldChatsForAccount error", {
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Startup hook: runs 15s after startup in the background, cleaning old chats
 * for active accounts without holding up the server or user requests.
 */
export function scheduleStartupChatCleanup(): void {
  if (!config.qwen.autoCleanChatsOnStartup || isAuthMockEnabled()) return;

  const timer = setTimeout(async () => {
    try {
      const activeIds = getActivePlaywrightAccountIds();
      for (const accountId of activeIds) {
        // Yield to active requests: skip if account is busy serving a stream or lease
        if (hasActiveAccountLease(accountId) || isAccountBusy(accountId)) continue;
        await cleanOldChatsForAccount(accountId);
        await sleep(1_000);
      }
    } catch {}
  }, 15_000);
  timer.unref?.();
}
