import { v4 as uuidv4 } from "uuid";
import {
  createQwenStream,
  clearAllSessionsForAccount,
  getLogicalThreadState,
  updateLogicalThreadState,
  deleteQwenChat,
  QwenSessionExpiredError,
  RetryableQwenStreamError,
  syncQwenRequestPersonalization,
  type LogicalThreadEntry,
} from "../../services/qwen.ts";
import type { TokenEstimationContext } from "../../services/token-estimation-metrics.ts";
import { isAuthMockEnabled } from "../../services/auth-playwright.ts";
import { refreshHeaders } from "../../services/playwright.ts";
import { Mutex } from "../../core/mutex.ts";
import {
  getNextAccount,
  getNextAvailableAccount,
  markAccountRateLimited,
  getAccountCooldownInfo,
  clearAccountCooldown,
} from "../../core/account-manager.ts";
import { loadAccounts } from "../../core/accounts.ts";
import { registerStream, removeStream } from "../../core/stream-registry.ts";
import {
  logger,
  isToolcallDebugEnabled,
  maskEmail,
} from "../../core/logger.ts";
import { config } from "../../core/config.ts";
import { UpstreamRateLimit } from "../../core/errors.ts";
import { QwenFileEntry } from "../upload.ts";

// Per-chat lock: serializes requests to the same Qwen chat session
const chatLocks = new Map<string, Mutex>();
// Account-level personalization is global mutable Qwen state; keep update+stream
// creation serialized per account when the experimental request-sync mode is used.
const personalizationLocks = new Map<string, Mutex>();

export async function acquireChatLock(chatId: string): Promise<() => void> {
  let mutex = chatLocks.get(chatId);
  if (!mutex) {
    mutex = new Mutex();
    chatLocks.set(chatId, mutex);
  }
  const release = await mutex.acquire();
  return () => {
    release();
    if (mutex!.isIdle()) {
      chatLocks.delete(chatId);
    }
  };
}

async function acquirePersonalizationLock(
  accountId: string,
): Promise<() => void> {
  let mutex = personalizationLocks.get(accountId);
  if (!mutex) {
    mutex = new Mutex();
    personalizationLocks.set(accountId, mutex);
  }
  const release = await mutex.acquire();
  return () => {
    release();
    if (mutex!.isIdle()) {
      personalizationLocks.delete(accountId);
    }
  };
}

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
  tokenEstimationContext: TokenEstimationContext;
}

export interface StreamCreationFailure {
  error: any;
  completionId: string;
  allOnCooldown: boolean;
  retryAfterMs?: number;
}

export interface AcquireParams {
  finalPrompt: string;
  fullPrompt: string;
  isThinkingModel: boolean;
  model: string;
  shouldResetUpstreamThread: boolean;
  allFiles: QwenFileEntry[];
  isNewSession: boolean;
  sessionId: string | null;
  useThreadNative: boolean;
  updateLogicalThread: boolean;
  allowThreadReuse: boolean;
  forceNewChat?: boolean;
  preferredAccountId?: string | null;
  messageCount?: number;
  fullMessageCount?: number;
  toolsCount?: number;
  requestPersonalizationInstruction?: string | null;
}

function resolveInitialAccount(preferredAccountId?: string): {
  account: SelectedAccount;
  configuredAccounts: SelectedAccount[];
} {
  if (isAuthMockEnabled()) {
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

  throw new Error(
    "No Qwen accounts configured. Add accounts with npm run login.",
  );
}

function isAccountUnavailableError(err: any): boolean {
  const message = String(err?.message || err || "").toLowerCase();
  return (
    (err instanceof UpstreamRateLimit &&
      !(err instanceof RetryableQwenStreamError)) ||
    err?.upstreamCode === "RateLimited" ||
    err?.upstreamStatus === 429 ||
    message.includes("allocated quota exceeded") ||
    message.includes("quota exceeded") ||
    message.includes("increase your quota") ||
    message.includes("token-limit") ||
    message.includes("insufficient quota") ||
    message.includes("request rate increased too quickly") ||
    message.includes("rate increased too quickly")
  );
}

function isAntiBotError(err: any): boolean {
  if (err instanceof RetryableQwenStreamError) {
    return err.message?.includes("anti-bot") || false;
  }
  const message = String(err?.message || err || "").toLowerCase();
  return (
    err?.upstreamCode === "FAIL_SYS_USER_VALIDATE" ||
    err?.upstreamCode === "RGV587_ERROR" ||
    message.includes("fail_sys_user_validate") ||
    message.includes("rgv587_error")
  );
}

async function attemptRelogin(
  accountId: string,
  accountEmail: string,
): Promise<boolean> {
  try {
    await refreshHeaders(accountId);
    console.log(
      `[Chat] Playwright headers refreshed for ${maskEmail(accountEmail)}. Retrying...`,
    );
    return true;
  } catch (refreshErr: unknown) {
    logger.error("[Chat] Playwright header refresh failed", {
      accountEmail: maskEmail(accountEmail),
      error:
        refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
      cause:
        refreshErr instanceof Error
          ? refreshErr.constructor.name
          : typeof refreshErr,
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
    allowThreadReuse,
    forceNewChat = false,
    preferredAccountId,
  } = params;

  const completionId = "chatcmpl-" + uuidv4();
  // Only load existing thread when reuse is explicitly allowed
  const existingThread =
    allowThreadReuse && !forceNewChat ? getLogicalThreadState(sessionId) : null;
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
  let verifiedPersistedCooldown = false;

  while (account) {
    const accountId = account.id;
    const accountEmail = maskEmail(account.email);

    if (triedAccountIds.has(accountId)) {
      account = getNextAvailableAccount(triedAccountIds);
      continue;
    }
    triedAccountIds.add(accountId);

    const cooldownInfo = getAccountCooldownInfo(accountId);
    if (cooldownInfo) {
      const allConfiguredAccountsOnCooldown = configuredAccounts.every(
        (configuredAccount) => getAccountCooldownInfo(configuredAccount.id),
      );

      if (allConfiguredAccountsOnCooldown && !verifiedPersistedCooldown) {
        verifiedPersistedCooldown = true;
        console.warn(
          `[Chat] All accounts are on cooldown; clearing cooldowns and resetting all profiles in background.`,
        );

        // Clear all cooldowns
        for (const acc of configuredAccounts) {
          clearAccountCooldown(acc.id);
        }

        // Reset all profiles in background
        void (async () => {
          try {
            const { refreshHeadersWithProfileReset } =
              await import("../../services/playwright.ts");
            for (const acc of configuredAccounts) {
              void refreshHeadersWithProfileReset(acc.id).catch((err) => {
                console.warn(
                  `[Playwright] Background profile reset failed for ${acc.id}:`,
                  (err as Error).message,
                );
              });
            }
          } catch (err) {
            console.warn(
              `[Playwright] Failed to start background profile resets:`,
              (err as Error).message,
            );
          }
        })();
      } else {
        console.log(
          `[Chat] Skipping account ${accountEmail} (${accountId}) on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`,
        );
        if (stickyThreadAccountId === accountId) {
          console.warn(
            `[Chat] Sticky account is on cooldown; recreating upstream chat on another account with full context.`,
          );
        }
        account = getNextAvailableAccount(triedAccountIds);
        continue;
      }
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[chat] account selected", {
        accountId,
        accountEmail: maskEmail(accountEmail),
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
        allowThreadReuse,
        hasExplicitConversationKey: params.allowThreadReuse,
      });
    }

    try {
      const recreatingOnNewAccount =
        !!stickyThreadAccountId && accountId !== stickyThreadAccountId;
      const attemptFinalPrompt = recreatingOnNewAccount
        ? params.fullPrompt
        : finalPrompt;
      const result = await tryCreateStreamWithRetry(
        {
          finalPrompt: attemptFinalPrompt,
          isThinkingModel,
          model,
          shouldResetUpstreamThread,
          allFiles,
          sessionId,
          useThreadNative,
          updateLogicalThread,
          forceNewChat,
          existingThread:
            !recreatingOnNewAccount &&
            existingThread &&
            existingThread.accountId === accountId
              ? existingThread
              : null,
          messageCount: recreatingOnNewAccount
            ? (params.fullMessageCount ?? params.messageCount)
            : params.messageCount,
          fullMessageCount: params.fullMessageCount,
          toolsCount: params.toolsCount,
          requestPersonalizationInstruction:
            params.requestPersonalizationInstruction,
          fullPrompt: params.fullPrompt,
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
          tokenEstimationContext: {
            ...result.tokenEstimationContext,
            requestDeclaredToolCount: params.toolsCount ?? 0,
          },
        };
      }

      lastError = result.error;
    } catch (err: any) {
      lastError = err;
    }

    if (stickyThreadAccountId === accountId) {
      if (isAccountUnavailableError(lastError) || isAntiBotError(lastError)) {
        console.warn(
          `[Chat] Sticky account unavailable; trying another account with full context.`,
        );
      } else {
        break;
      }
    }

    // Mark anti-bot blocked accounts for cooldown and reset profile in background
    if (isAntiBotError(lastError)) {
      markAccountRateLimited(accountId, 10 * 60 * 1000, "AntiBot");
      void (async () => {
        try {
          const { refreshHeadersWithProfileReset } =
            await import("../../services/playwright.ts");
          console.log(
            `[Playwright] Background profile reset for ${accountEmail}...`,
          );
          await refreshHeadersWithProfileReset(accountId);
          console.log(
            `[Playwright] Background profile reset complete for ${accountEmail}.`,
          );
        } catch (resetErr) {
          console.warn(
            `[Playwright] Background profile reset failed for ${accountEmail}:`,
            (resetErr as Error).message,
          );
        }
      })();
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[chat] account failed, rotating", {
        accountId,
        accountEmail: maskEmail(accountEmail),
        triedAccounts: Array.from(triedAccountIds),
      });
    }

    account = getNextAvailableAccount(triedAccountIds);
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
  tokenEstimationContext: TokenEstimationContext;
}

interface CreateStreamFailure {
  success: false;
  error: any;
}

async function tryCreateStreamWithRetry(
  params: {
    finalPrompt: string;
    fullPrompt: string;
    isThinkingModel: boolean;
    model: string;
    shouldResetUpstreamThread: boolean;
    allFiles: QwenFileEntry[];
    sessionId: string | null;
    useThreadNative: boolean;
    updateLogicalThread: boolean;
    forceNewChat: boolean;
    existingThread: LogicalThreadEntry | null;
    messageCount?: number;
    fullMessageCount?: number;
    toolsCount?: number;
    requestPersonalizationInstruction?: string | null;
  },
  accountId: string,
  accountEmail: string,
): Promise<CreateStreamSuccess | CreateStreamFailure> {
  let retries = 3;
  let retryDelay = config.retry.baseDelayMs;
  let attempt = 0;
  let quotaRetried = false;
  const accounts = loadAccounts();
  const isSingleAccount = accounts.length <= 1;

  while (retries > 0) {
    attempt++;
    if (attempt > 1) {
      console.log(
        `[Chat] Retrying request | ${params.model} | ${params.messageCount ?? "?"} msg(s) | ${params.finalPrompt.length} chars${params.toolsCount ? ` | ${params.toolsCount} tool(s)` : ""} | attempt ${attempt}`,
      );
    }
    let attemptError: any = null;

    try {
      const threadParentId = params.useThreadNative
        ? params.forceNewChat
          ? null
          : (params.existingThread?.parentId ?? null)
        : params.shouldResetUpstreamThread
          ? null
          : undefined;
      const releasePersonalization = params.requestPersonalizationInstruction
        ? await acquirePersonalizationLock(accountId)
        : null;
      let result: Awaited<ReturnType<typeof createQwenStream>>;
      try {
        if (params.requestPersonalizationInstruction) {
          await syncQwenRequestPersonalization(
            params.requestPersonalizationInstruction,
            accountId === "global" ? undefined : accountId,
            {
              model: params.model,
              toolsCount: params.toolsCount ?? 0,
              sessionId: params.sessionId,
              promptChars: params.finalPrompt.length,
            },
          );
        }

        result = await createQwenStream(
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
      } finally {
        releasePersonalization?.();
      }

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
          accountEmail: maskEmail(accountEmail),
          uiSessionId: result.uiSessionId,
        });
      }

      return { success: true, ...result };
    } catch (err: any) {
      attemptError = err;
    }

    retries--;
    const err = attemptError;

    // Log the error details for debugging
    const errMsg = err instanceof Error ? err.message : String(err || "");
    if (err) {
      const errCode = err.upstreamCode || err.code || "unknown";
      console.warn(
        `[Chat] Request failed | ${accountEmail} | ${errCode} | ${errMsg.substring(0, 200)}`,
      );
    }

    if (
      err?.createdNewChat === true &&
      typeof err.chatSessionId === "string" &&
      err.chatSessionId &&
      config.context.threadNative.deleteFailedNewChats &&
      // Don't delete chat for temporary errors (anti-bot, retryable)
      !(err instanceof RetryableQwenStreamError)
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
        console.log(
          `[ThreadContext] Deleted failed chat | ${err.chatSessionId} | account=${accountId}`,
        );
      } catch (deleteErr) {
        const msg =
          deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
        console.error(
          `[ThreadContext] Delete failed chat error | ${err.chatSessionId} | ${msg}`,
        );
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

    if (isAccountUnavailableError(err)) {
      const quotaMsg = err.message || "Unknown quota error";
      console.warn(
        `[Chat] Quota exceeded | ${accountEmail} | ${quotaMsg.substring(0, 200)}`,
      );

      // Single account: retry once after delay before giving up
      if (isSingleAccount && !quotaRetried && retries > 1) {
        quotaRetried = true;
        console.warn(
          `[Chat] Single account mode | Retrying in ${config.retry.baseDelayMs}ms...`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, config.retry.baseDelayMs),
        );
        continue;
      }

      const hourHint = err.message?.match(/Wait about (\d+) hour/);
      let cooldownMs: number | undefined;
      let cooldownReason = "RateLimited";

      if (hourHint) {
        cooldownMs = parseInt(hourHint[1]) * 60 * 60 * 1000;
      } else if (
        errMsg.toLowerCase().includes("request rate increased too quickly") ||
        errMsg.toLowerCase().includes("rate increased too quickly")
      ) {
        // Temporary rate limit — shorter cooldown (5 min)
        cooldownMs = 5 * 60 * 1000;
        cooldownReason = "RateLimitTemporary";
      }

      markAccountRateLimited(accountId, cooldownMs, cooldownReason);
      return { success: false, error: err };
    }

    // Detect "chat not exist" error and force new chat creation on retry
    const isChatNotExistError =
      err.message?.includes("is not exist") ||
      err.message?.includes("not exist") ||
      err.message?.includes("does not exist");

    if (isChatNotExistError && params.useThreadNative && params.sessionId) {
      console.warn(`[Chat] Session expired | forcing new chat`);
      // Clear the stale chat session ID from logical thread state
      // so the next attempt creates a fresh chat
      params.existingThread = null;
      params.finalPrompt = params.fullPrompt;
      params.messageCount = params.fullMessageCount ?? params.messageCount;
      updateLogicalThreadState(params.sessionId, {
        accountId,
        chatSessionId: "", // Empty forces new chat creation
        parentId: null,
        instructionsSent: false,
      });
      // Retry immediately without delay — the session just needs to be recreated
      continue;
    }

    if (retries === 0) {
      // Only mark account for cooldown on actual account-specific errors
      // Qwen internal errors (Bad_Request, server issues) are not the account's fault
      const isQwenInternalError =
        err.message?.includes("Bad_Request") ||
        err.message?.includes("internal_error") ||
        err.message?.includes("Internal error");

      if (
        err.upstreamStatus &&
        err.upstreamStatus >= 500 &&
        !isQwenInternalError
      ) {
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
      err.message?.includes("Bad_Request") ||
      err.message?.includes("internal_error") ||
      err.message?.includes("Internal error") ||
      err?.upstreamCode === "internal_error";
    if (!isRetryable) {
      return { success: false, error: err };
    }

    console.warn(
      `[Chat] Qwen request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left). Error: ${err.message?.slice(0, 200) || err}`,
    );
    await new Promise((r) => setTimeout(r, useDelay));
    retryDelay = Math.min(retryDelay * 2, config.retry.maxDelayMs);
  }

  return { success: false, error: new Error("Retry exhausted") };
}
