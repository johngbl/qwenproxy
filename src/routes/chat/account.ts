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
import {
  classifyRetryAction,
  isAntiBotError as isAntiBotPolicyError,
  isChatInProgressError,
  isQuotaLikeError,
} from "./retry-policy.ts";

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
  activeAccountLabel: string;
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
  // Quota/rate-limit style failures that should cool the account and rotate.
  if (isQuotaLikeError(err)) return true;
  return (
    (err instanceof UpstreamRateLimit &&
      !(err instanceof RetryableQwenStreamError)) ||
    err?.upstreamCode === "RateLimited" ||
    err?.upstreamStatus === 429
  );
}

function isAntiBotError(err: any): boolean {
  return isAntiBotPolicyError(err);
}

async function tryRecoverAntiBot(
  accountId: string,
  accountEmail: string,
): Promise<boolean> {
  try {
    const { recoverAntiBotChallenge, isCaptchaSolverEnabled } =
      await import("../../services/captcha-solver.ts");
    if (!isCaptchaSolverEnabled()) return false;

    console.log(
      `🧩 [Captcha] Starting anti-bot recovery for ${accountEmail}...`,
    );
    const result = await recoverAntiBotChallenge(accountId);
    if (result.success) {
      clearAccountCooldown(accountId);
      console.log(
        `✅ [Captcha] Recovery ok for ${accountEmail} | method=${result.method} | ${result.durationMs}ms`,
      );
      return true;
    }
    console.warn(
      `⚠️  [Captcha] Recovery failed for ${accountEmail} | method=${result.method} | ${result.detail || ""}`,
    );
    return false;
  } catch (error) {
    console.warn(
      `❌ [Captcha] Recovery error for ${accountEmail}:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

async function attemptRelogin(
  accountId: string,
  accountEmail: string,
): Promise<boolean> {
  try {
    await refreshHeaders(accountId);
    console.log(
      `✅ [Chat] Playwright headers refreshed for ${maskEmail(accountEmail)}. Retrying...`,
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
          `⚠️  [Chat] All accounts are on cooldown; clearing cooldowns and resetting all profiles in background.`,
        );

        // Clear all cooldowns
        for (const acc of configuredAccounts) {
          clearAccountCooldown(acc.id);
        }

        // Reset all profiles in background
        void (async () => {
          try {
            const { schedulePlaywrightProfileReset } =
              await import("../../services/playwright.ts");
            for (const acc of configuredAccounts) {
              schedulePlaywrightProfileReset(acc.id);
            }
          } catch (err) {
            console.warn(
              `❌ [Playwright] Failed to start background profile resets:`,
              (err as Error).message,
            );
          }
        })();
      } else {
        console.log(
          `⏭️  [Chat] Skipping account ${accountEmail} (${accountId}) on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`,
        );
        if (stickyThreadAccountId === accountId) {
          console.warn(
            `⚠️  [Chat] Sticky account is on cooldown; recreating upstream chat on another account with full context.`,
          );
        }
        account = getNextAvailableAccount(triedAccountIds);
        continue;
      }
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
          activeAccountLabel: accountEmail,
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
          `⚠️  [Chat] Sticky account unavailable; trying another account with full context.`,
        );
      } else {
        break;
      }
    }

    // Anti-bot: try in-browser captcha recovery first; only then cooldown + profile reset
    if (isAntiBotError(lastError)) {
      const recovered = await tryRecoverAntiBot(accountId, accountEmail);
      if (recovered) {
        // Give the same account one more chance with fresh tokens/session
        triedAccountIds.delete(accountId);
        continue;
      }

      markAccountRateLimited(
        accountId,
        config.captchaSolver.failCooldownMs,
        "AntiBot",
      );
      void (async () => {
        try {
          const { schedulePlaywrightProfileReset } =
            await import("../../services/playwright.ts");
          console.log(
            `🔄 [Playwright] Scheduling profile reset for ${accountEmail}...`,
          );
          schedulePlaywrightProfileReset(accountId);
        } catch (resetErr) {
          console.warn(
            `❌ [Playwright] Background profile reset failed for ${accountEmail}:`,
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
  const maxAttempts = Math.max(1, config.retry.maxAttempts);
  const maxAccountSwitches = Math.max(0, config.retry.maxAccountSwitches);
  let attemptsLeft = maxAttempts;
  let retryDelay = config.retry.baseDelayMs;
  let attempt = 0;
  let quotaRetried = false;
  let accountSwitches = 0;
  const accounts = loadAccounts();
  const isSingleAccount = accounts.length <= 1;
  let currentAccountId = accountId;
  let currentAccountEmail = accountEmail;
  const triedAccounts = new Set<string>([accountId]);

  while (attemptsLeft > 0) {
    attempt++;
    if (attempt > 1) {
      console.log(
        `🔄 [Chat] Retrying request | ${currentAccountEmail} | ${params.model} | ${params.messageCount ?? "?"} msg(s) | ${params.finalPrompt.length} chars${params.toolsCount ? ` | ${params.toolsCount} tool(s)` : ""} | attempt ${attempt}`,
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
        ? await acquirePersonalizationLock(currentAccountId)
        : null;
      let result: Awaited<ReturnType<typeof createQwenStream>>;
      try {
        if (params.requestPersonalizationInstruction !== null) {
          await syncQwenRequestPersonalization(
            params.requestPersonalizationInstruction ?? "",
            currentAccountId === "global" ? undefined : currentAccountId,
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
          currentAccountId === "global" ? undefined : currentAccountId,
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
          accountId: currentAccountId,
          accountEmail: currentAccountEmail,
          uiSessionId: result.uiSessionId,
        });
      }

      return { success: true, ...result };
    } catch (err: any) {
      attemptError = err;
    }

    attemptsLeft--;
    const err = attemptError;

    // Log the error details for debugging
    const errMsg = err instanceof Error ? err.message : String(err || "");
    if (err) {
      const errCode = err.upstreamCode || err.code || "unknown";
      console.warn(
        `❌ [Chat] Request failed | ${currentAccountEmail} | ${errCode} | ${errMsg.substring(0, 200)}`,
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
            : currentAccountId === "global"
              ? undefined
              : currentAccountId,
        );
        console.log(
          `🗑️  [ThreadContext] Deleted failed chat | ${err.chatSessionId} | account=${currentAccountId}`,
        );
      } catch (deleteErr) {
        const msg =
          deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
        console.error(
          `❌ [ThreadContext] Delete failed chat error | ${err.chatSessionId} | ${msg}`,
        );
      }
    }

    if (!err) {
      return {
        success: false,
        error: new Error("Failed to create Qwen stream"),
      };
    }

    if (
      err instanceof QwenSessionExpiredError ||
      err.name === "QwenSessionExpiredError"
    ) {
      console.warn(
        `🔄 [Chat] Session expired for ${currentAccountEmail} (${currentAccountId}). Attempting re-login...`,
      );
      const reLoginOk = await attemptRelogin(
        currentAccountId,
        currentAccountEmail,
      );
      if (reLoginOk) continue;
      return { success: false, error: err };
    }

    // In-request captcha recovery before burning remaining retries / rotating
    if (isAntiBotError(err) && attemptsLeft > 0) {
      const recovered = await tryRecoverAntiBot(
        currentAccountId,
        currentAccountEmail,
      );
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          recovered
            ? Math.min(config.antiBot.baseDelayMs, 2500)
            : Math.min(config.antiBot.baseDelayMs, 4000),
        ),
      );
      // Always continue once for anti-bot so a fresh header/token set can land
      continue;
    }

    // Account-scoped quota/rate-limit: cool this account and stop local retries
    // so outer account rotation can pick another one immediately.
    if (isAccountUnavailableError(err)) {
      const quotaMsg = err.message || "Unknown quota error";
      console.warn(
        `⚠️  [Chat] Quota exceeded | ${currentAccountEmail} | ${quotaMsg.substring(0, 200)}`,
      );

      // Single account: retry once after delay before giving up
      if (isSingleAccount && !quotaRetried && attemptsLeft > 0) {
        quotaRetried = true;
        console.warn(
          `🔄 [Chat] Single account mode | Retrying in ${config.retry.baseDelayMs}ms...`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, config.retry.baseDelayMs),
        );
        continue;
      }

      const policy = classifyRetryAction(err);
      markAccountRateLimited(
        currentAccountId,
        policy.accountCooldownMs,
        policy.accountCooldownReason || "QuotaExceeded",
      );
      return { success: false, error: err };
    }

    const policy = classifyRetryAction(err);

    // Prefer switching account for any retryable upstream error when possible
    if (
      policy.retryable &&
      policy.switchAccount &&
      !isSingleAccount &&
      accountSwitches < maxAccountSwitches
    ) {
      const nextAccount = getNextAvailableAccount(triedAccounts);
      if (nextAccount && nextAccount.id !== currentAccountId) {
        console.warn(
          `🔄 [Chat] Switching account after ${policy.reason} | ${currentAccountEmail} -> ${maskEmail(nextAccount.email)}`,
        );
        if (policy.accountCooldownMs || policy.accountCooldownReason) {
          markAccountRateLimited(
            currentAccountId,
            policy.accountCooldownMs,
            policy.accountCooldownReason || "RetrySwitch",
          );
        }
        triedAccounts.add(currentAccountId);
        currentAccountId = nextAccount.id;
        currentAccountEmail = maskEmail(nextAccount.email);
        accountSwitches++;

        // Switching accounts invalidates sticky thread/chat state
        if (params.useThreadNative && params.sessionId) {
          params.existingThread = null;
          params.finalPrompt = params.fullPrompt;
          params.messageCount =
            params.fullMessageCount ?? params.messageCount;
          params.forceNewChat = true;
          updateLogicalThreadState(params.sessionId, {
            accountId: currentAccountId,
            chatSessionId: "",
            parentId: null,
            instructionsSent: false,
          });
        }

        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(policy.retryAfterMs || config.retry.baseDelayMs, 1000),
          ),
        );
        continue;
      }

      console.warn(
        `⚠️  [Chat] No other account available after ${policy.reason} | Retrying on same account`,
      );
    }

    // Force new chat / full context when policy requests it (invalid_input, chat gone, etc.)
    if (
      policy.retryable &&
      (policy.forceNewChat || policy.retryWithFullPrompt) &&
      params.useThreadNative &&
      params.sessionId
    ) {
      console.warn(
        `🔄 [Chat] Forcing new chat/full context | reason=${policy.reason}`,
      );
      params.existingThread = null;
      params.finalPrompt = params.fullPrompt;
      params.messageCount = params.fullMessageCount ?? params.messageCount;
      params.forceNewChat = true;
      updateLogicalThreadState(params.sessionId, {
        accountId: currentAccountId,
        chatSessionId: "",
        parentId: null,
        instructionsSent: false,
      });
    }

    if (!policy.retryable || attemptsLeft <= 0) {
      if (policy.accountCooldownMs || policy.accountCooldownReason) {
        markAccountRateLimited(
          currentAccountId,
          policy.accountCooldownMs,
          policy.accountCooldownReason || "RetryExhausted",
        );
      }

      if (
        err instanceof RetryableQwenStreamError ||
        isChatInProgressError(err)
      ) {
        console.warn(
          `🧹 [Chat] Clearing session state for ${currentAccountEmail} (${currentAccountId}) after exhausted retries`,
        );
        clearAllSessionsForAccount(currentAccountId);
      }

      return { success: false, error: err };
    }

    const useDelay = Math.max(
      0,
      policy.retryAfterMs || retryDelay || config.retry.baseDelayMs,
    );

    console.warn(
      `🔄 [Chat] Qwen request failed for ${currentAccountEmail}, retrying in ${useDelay}ms... (${attemptsLeft} left). reason=${policy.reason} error=${errMsg.slice(0, 200)}`,
    );
    await new Promise((r) => setTimeout(r, useDelay));
    retryDelay = Math.min(retryDelay * 2, config.retry.maxDelayMs);
  }

  return { success: false, error: new Error("Retry exhausted") };
}
