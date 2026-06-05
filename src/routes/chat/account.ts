import { v4 as uuidv4 } from "uuid";
import {
  createQwenStream,
  clearAllSessionsForAccount,
  getLogicalThreadState,
  updateLogicalThreadState,
  deleteQwenChat,
  QwenSessionExpiredError,
  RetryableQwenStreamError,
  type LogicalThreadEntry,
} from "../../services/qwen.ts";
import { Mutex, initPlaywrightForAccount } from "../../services/playwright.ts";
import {
  getNextAccount,
  getNextAvailableAccount,
  markAccountRateLimited,
  getAccountCooldownInfo,
} from "../../core/account-manager.ts";
import { loadAccounts, getAccountCredentials } from "../../core/accounts.ts";
import { registerStream, removeStream } from "../../core/stream-registry.ts";
import { logger, isToolcallDebugEnabled } from "../../core/logger.ts";
import { config } from "../../core/config.ts";
import { QwenFileEntry } from "../upload.ts";

export interface SelectedAccount {
  id: string;
  email: string;
  password: string;
}

export interface StreamCreationResult {
  stream: ReadableStream;
  uiSessionId: string;
  activeAccountId: string;
  completionId: string;
  logicalSessionId: string | null;
  createdNewChat: boolean;
}

export interface StreamCreationFailure {
  error: any;
  completionId: string;
  allOnCooldown: boolean;
  retryAfterMs?: number;
}

export interface AcquireParams {
  finalPrompt: string;
  isThinkingModel: boolean;
  model: string;
  shouldResetUpstreamThread: boolean;
  allFiles: QwenFileEntry[];
  isNewSession: boolean;
  sessionId: string | null;
  useThreadNative: boolean;
  updateLogicalThread: boolean;
  forceNewChat?: boolean;
  preferredAccountId?: string | null;
}

// Module-level mutex registry, one per account to prevent concurrent startups.
const accountMutexes = new Map<string, Mutex>();
function getAccountMutex(accountId: string): Mutex {
  let mutex = accountMutexes.get(accountId);
  if (!mutex) {
    mutex = new Mutex();
    accountMutexes.set(accountId, mutex);
  }
  return mutex;
}

function resolveInitialAccount(preferredAccountId?: string): {
  account: SelectedAccount;
  configuredAccounts: SelectedAccount[];
} {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return {
      account: { id: "mock-account", email: "mock@test.com", password: "" },
      configuredAccounts: [],
    };
  }

  const configuredAccounts = loadAccounts();
  if (configuredAccounts.length > 0) {
    if (preferredAccountId) {
      const preferred = configuredAccounts.find(
        (candidate) => candidate.id === preferredAccountId,
      );
      if (preferred) return { account: preferred, configuredAccounts };
    }

    const account = getNextAccount();
    if (!account) {
      // All accounts on cooldown; caller will handle this.
      return { account: configuredAccounts[0], configuredAccounts };
    }
    return { account, configuredAccounts };
  }

  // Fallback: global Playwright session.
  if (preferredAccountId && preferredAccountId !== "global") {
    console.warn(
      `[Chat] Sticky account ${preferredAccountId} not found; falling back to global session.`,
    );
  }
  return {
    account: {
      id: "global",
      email: process.env.QWEN_EMAIL || "global-session",
      password: process.env.QWEN_PASSWORD || "",
    },
    configuredAccounts: [],
  };
}

async function attemptRelogin(
  accountId: string,
  accountEmail: string,
): Promise<boolean> {
  try {
    const creds = getAccountCredentials(accountId);
    if (creds) {
      await initPlaywrightForAccount(creds, true);
      console.log(
        `[Chat] Re-login successful for ${accountEmail}. Retrying...`,
      );
      return true;
    }
  } catch (reLoginErr: unknown) {
    logger.error("[Chat] Re-login failed", {
      accountEmail,
      error:
        reLoginErr instanceof Error ? reLoginErr.message : String(reLoginErr),
      cause:
        reLoginErr instanceof Error
          ? reLoginErr.constructor.name
          : typeof reLoginErr,
    });
  }
  return false;
}

export async function acquireUpstreamStream(
  params: AcquireParams,
): Promise<StreamCreationResult | StreamCreationFailure> {
  const {
    finalPrompt,
    isThinkingModel,
    model,
    shouldResetUpstreamThread,
    allFiles,
    isNewSession,
    sessionId,
    useThreadNative,
    updateLogicalThread,
    forceNewChat = false,
    preferredAccountId,
  } = params;

  const completionId = "chatcmpl-" + uuidv4();
  const existingThread =
    useThreadNative && !forceNewChat ? getLogicalThreadState(sessionId) : null;
  const resolved = resolveInitialAccount(
    preferredAccountId ?? existingThread?.accountId,
  );

  let account: SelectedAccount | null = resolved.account;
  const configuredAccounts = resolved.configuredAccounts;
  const stickyThreadAccountId = forceNewChat
    ? null
    : (existingThread?.accountId ?? null);
  const triedAccountIds = new Set<string>();
  let lastError: any = null;

  while (account) {
    const accountId = account.id;
    const accountEmail = account.email;

    if (triedAccountIds.has(accountId)) {
      account = getNextAvailableAccount(accountId);
      continue;
    }
    triedAccountIds.add(accountId);

    const cooldownInfo = getAccountCooldownInfo(accountId);
    if (cooldownInfo && accountId !== "global") {
      console.log(
        `[Chat] Skipping account ${accountEmail} (${accountId}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`,
      );
      if (stickyThreadAccountId === accountId) {
        const cooldownError: any = new Error(
          `Sticky Qwen account for this conversation is on cooldown. Retry in about ${Math.max(1, Math.ceil(cooldownInfo.remainingMs / 1000))}s.`,
        );
        cooldownError.upstreamStatus = 429;
        cooldownError.retryAfterMs = cooldownInfo.remainingMs;
        return {
          error: cooldownError,
          completionId,
          allOnCooldown: true,
          retryAfterMs: cooldownInfo.remainingMs,
        };
      }
      account = getNextAvailableAccount(accountId);
      continue;
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[chat] account selected", {
        accountId,
        accountEmail,
        isNewSession,
        isThinkingModel,
        promptLength: finalPrompt.length,
      });
    }

    if (useThreadNative && logger && process.env.CHAT_REQUEST_LOG === "true") {
      logger.info("[chat] thread-native routing", {
        sessionId,
        accountId,
        stickyAccountId: stickyThreadAccountId,
        hasExistingThread: !!existingThread,
        existingChatSessionId: existingThread?.chatSessionId || null,
        existingParentId: existingThread?.parentId || null,
        instructionsSent: existingThread?.instructionsSent || false,
      });
    }

    try {
      const result = await tryCreateStreamWithRetry(
        {
          finalPrompt,
          isThinkingModel,
          model,
          shouldResetUpstreamThread,
          allFiles,
          sessionId,
          useThreadNative,
          updateLogicalThread,
          forceNewChat,
          existingThread:
            existingThread && existingThread.accountId === accountId
              ? existingThread
              : null,
        },
        accountId,
        accountEmail,
      );

      if (result.success) {
        registerStream(completionId, {
          abortController: result.controller,
          accountId: result.accountId,
          uiSessionId: result.uiSessionId,
          targetResponseId: "",
          headers: result.headers,
        });

        return {
          stream: result.stream,
          uiSessionId: result.uiSessionId,
          activeAccountId: result.accountId,
          completionId,
          logicalSessionId:
            useThreadNative && updateLogicalThread ? sessionId : null,
          createdNewChat: result.createdNewChat,
        };
      }

      lastError = result.error;
    } catch (err: any) {
      lastError = err;
    }

    if (stickyThreadAccountId === accountId) {
      break;
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[chat] account failed, rotating", {
        accountId,
        accountEmail,
        triedAccounts: Array.from(triedAccountIds),
      });
    }

    account = getNextAvailableAccount(accountId);
  }

  // All accounts exhausted.
  removeStream(completionId);

  if (!lastError && configuredAccounts.length > 0) {
    const cooldownInfos = configuredAccounts
      .map((acc) => getAccountCooldownInfo(acc.id))
      .filter(
        (
          info,
        ): info is NonNullable<ReturnType<typeof getAccountCooldownInfo>> =>
          info !== null,
      );

    if (cooldownInfos.length === configuredAccounts.length) {
      const retryAfterMs = Math.min(
        ...cooldownInfos.map((info) => info.remainingMs),
      );
      const cooldownError: any = new Error(
        `All configured accounts are on cooldown. Retry in about ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`,
      );
      cooldownError.upstreamStatus = 429;
      cooldownError.retryAfterMs = retryAfterMs;
      return {
        error: cooldownError,
        completionId,
        allOnCooldown: true,
        retryAfterMs,
      };
    }
  }

  return {
    error: lastError ?? new Error("No accounts available"),
    completionId,
    allOnCooldown: false,
  };
}

interface CreateStreamSuccess {
  success: true;
  stream: ReadableStream;
  uiSessionId: string;
  accountId: string;
  controller: AbortController;
  headers: Record<string, string>;
  createdNewChat: boolean;
}

interface CreateStreamFailure {
  success: false;
  error: any;
}

async function tryCreateStreamWithRetry(
  params: {
    finalPrompt: string;
    isThinkingModel: boolean;
    model: string;
    shouldResetUpstreamThread: boolean;
    allFiles: QwenFileEntry[];
    sessionId: string | null;
    useThreadNative: boolean;
    updateLogicalThread: boolean;
    forceNewChat: boolean;
    existingThread: LogicalThreadEntry | null;
  },
  accountId: string,
  accountEmail: string,
): Promise<CreateStreamSuccess | CreateStreamFailure> {
  let retries = 3;
  let retryDelay = 500;

  while (retries > 0) {
    let attemptError: any = null;
    const accountMutex = getAccountMutex(accountId);
    const releaseLock = await accountMutex.acquire();

    if (isToolcallDebugEnabled()) {
      logger.debug("[chat] account startup lock acquired", {
        accountId,
        accountEmail,
      });
    }

    try {
      const threadParentId = params.useThreadNative
        ? params.forceNewChat
          ? null
          : (params.existingThread?.parentId ?? null)
        : params.shouldResetUpstreamThread
          ? null
          : undefined;
      const result = await createQwenStream(
        params.finalPrompt,
        params.isThinkingModel,
        params.model,
        threadParentId,
        accountId === "global" ? undefined : accountId,
        params.allFiles.length > 0 ? params.allFiles : undefined,
        params.forceNewChat || params.useThreadNative
          ? {
              chatSessionId: params.forceNewChat
                ? null
                : (params.existingThread?.chatSessionId ?? null),
              forceNewChat: false,
            }
          : undefined,
      );

      if (
        params.useThreadNative &&
        params.updateLogicalThread &&
        params.sessionId &&
        result.uiSessionId
      ) {
        updateLogicalThreadState(params.sessionId, {
          accountId: result.accountId,
          chatSessionId: result.uiSessionId,
          parentId: threadParentId ?? null,
          instructionsSent: true,
        });

        if (process.env.CHAT_REQUEST_LOG === "true") {
          logger.info("[chat] thread-native upstream session", {
            sessionId: params.sessionId,
            accountId: result.accountId,
            chatSessionId: result.uiSessionId,
            parentId: threadParentId ?? null,
            createdNewChat: !params.existingThread,
          });
        }
      }

      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] stream created successfully", {
          accountId,
          accountEmail,
          uiSessionId: result.uiSessionId,
        });
      }

      return { success: true, ...result };
    } catch (err: any) {
      attemptError = err;
    } finally {
      releaseLock();
    }

    retries--;
    const err = attemptError;
    if (
      err?.createdNewChat === true &&
      typeof err.chatSessionId === "string" &&
      err.chatSessionId &&
      config.context.threadNative.deleteFailedNewChats
    ) {
      try {
        await deleteQwenChat(
          err.chatSessionId,
          err.accountId && err.accountId !== "global"
            ? err.accountId
            : accountId === "global"
              ? undefined
              : accountId,
        );
        logger.info("[thread-context] deleted failed new Qwen chat", {
          accountId,
          chatSessionId: err.chatSessionId,
        });
      } catch (deleteErr) {
        logger.warn("[thread-context] failed to delete failed new Qwen chat", {
          accountId,
          chatSessionId: err.chatSessionId,
          error:
            deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
        });
      }
    }

    if (!err) {
      return {
        success: false,
        error: new Error("Failed to create Qwen stream"),
      };
    }

    if (err.name === "QwenSessionExpiredError") {
      console.warn(
        `[Chat] Session expired for ${accountEmail} (${accountId}). Attempting re-login...`,
      );
      const reLoginOk = await attemptRelogin(accountId, accountEmail);
      if (reLoginOk) continue;
      return { success: false, error: err };
    }

    if (err.upstreamCode === "RateLimited" || err.upstreamStatus === 429) {
      const hourHint = err.message?.match(/Wait about (\d+) hour/);
      const cooldownMs = hourHint
        ? parseInt(hourHint[1]) * 60 * 60 * 1000
        : undefined;
      markAccountRateLimited(accountId, cooldownMs, "RateLimited");
      console.warn(
        `[Chat] Account ${accountEmail} (${accountId}) rate-limited. Marked for cooldown.`,
      );
      return { success: false, error: err };
    }

    // Detect "chat not exist" error and force new chat creation on retry
    const isChatNotExistError =
      err.message?.includes("is not exist") ||
      err.message?.includes("not exist") ||
      err.message?.includes("does not exist");

    if (isChatNotExistError && params.useThreadNative && params.sessionId) {
      console.warn(
        `[Chat] Chat session deleted externally for ${accountEmail} (${accountId}). Forcing new chat creation.`,
      );
      // Clear the stale chat session ID from logical thread state
      // so the next attempt creates a fresh chat
      params.existingThread = null;
      updateLogicalThreadState(params.sessionId, {
        accountId,
        chatSessionId: "", // Empty forces new chat creation
        parentId: null,
        instructionsSent: false,
      });
    }

    if (retries === 0) {
      if (err.upstreamStatus && err.upstreamStatus >= 500) {
        markAccountRateLimited(accountId, undefined, "ServerError");
        console.warn(
          `[Chat] Account ${accountEmail} (${accountId}) returned server error. Marked for cooldown.`,
        );
      }

      if (
        err instanceof RetryableQwenStreamError ||
        err.message?.includes("in progress")
      ) {
        console.warn(
          `[Chat] Clearing session state for ${accountEmail} (${accountId}) due to persistent 'chat in progress'`,
        );
        clearAllSessionsForAccount(accountId);
      }

      return { success: false, error: err };
    }

    let useDelay = retryDelay;
    if (
      err instanceof RetryableQwenStreamError &&
      err.retryAfterMs !== undefined
    ) {
      useDelay = err.retryAfterMs;
    }
    const isRetryable =
      err instanceof RetryableQwenStreamError ||
      err.message?.includes("in progress") ||
      err.message?.includes("Bad_Request");
    if (!isRetryable) {
      return { success: false, error: err };
    }

    console.warn(
      `[Chat] Qwen request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left). Error: ${err.message?.slice(0, 200) || err}`,
    );
    await new Promise((r) => setTimeout(r, useDelay));
    retryDelay = Math.min(retryDelay * 2, 5000);
  }

  return { success: false, error: new Error("Retry exhausted") };
}
