import { v4 as uuidv4 } from "uuid";
import {
	clearAccountCooldown,
	formatDateTimeBR,
	getAccountCooldownInfo,
	getNextAccount,
	getNextAvailableAccount,
	markAccountRateLimited,
} from "../../core/account-manager.ts";
import { markAccountSuccessful, markAccountFailed } from "../../core/account-priority.ts";
import { loadAccounts } from "../../core/accounts.ts";
import { config } from "../../core/config.ts";
import { UpstreamRateLimit } from "../../core/errors.ts";
import {
	isToolcallDebugEnabled,
	logger,
	maskEmail,
} from "../../core/logger.ts";
import { Mutex } from "../../core/mutex.ts";
import { registerStream, removeStream } from "../../core/stream-registry.ts";
import {
	acquireAccountLease,
	isAccountTemporarilyBusy,
	markAccountTemporarilyBusy,
	type AccountLease,
} from "../../core/account-concurrency.ts";
import { isAuthMockEnabled } from "../../services/auth-playwright.ts";
import { refreshHeaders } from "../../services/playwright.ts";
import {
	clearAllSessionsForAccount,
	createQwenStream,
	deleteQwenChat,
	getLogicalThreadState,
	type LogicalThreadEntry,
	QwenSessionExpiredError,
	RetryableQwenStreamError,
	syncQwenRequestPersonalization,
	updateLogicalThreadState,
} from "../../services/qwen.ts";
import type { TokenEstimationContext } from "../../services/token-estimation-metrics.ts";
import type { QwenFileEntry } from "../upload.ts";
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
	releaseAccountLease: () => void;
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
	/**
	 * Prefer this account when available.
	 * - undefined/omit: use sticky thread account when present, else round-robin
	 * - string: pin to that account if configured
	 * - null: explicitly rotate away from sticky/current account (error failover)
	 */
	preferredAccountId?: string | null;
	/** When rotating, exclude these account ids from the first pick. */
	excludeAccountIds?: string[];
	messageCount?: number;
	fullMessageCount?: number;
	toolsCount?: number;
	requestPersonalizationInstruction?: string | null;
	requestSignal?: AbortSignal;
	/** Allow this request to retry the account it just marked temporarily busy. */
	allowTemporarilyBusyAccountId?: string;
}

/** Exported for unit tests — selects the first account for a request. */
export function resolveInitialAccount(
  preferredAccountId?: string | null,
  excludeAccountIds?: Iterable<string>,
): {
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
		const excluded = new Set(excludeAccountIds ?? []);

		// Explicit preferred account (sticky / same-account retry)
		if (typeof preferredAccountId === "string" && preferredAccountId) {
			const preferred = configuredAccounts.find(
				(candidate) => candidate.id === preferredAccountId,
			);
			if (preferred && !getAccountCooldownInfo(preferred.id)) {
				return { account: preferred, configuredAccounts };
			}
			// Preferred is missing/on cooldown: fall through to next available.
			if (preferred) excluded.add(preferred.id);
		}

		// Error failover: rotate away from sticky/current account when requested.
		if (preferredAccountId === null || excluded.size > 0) {
			const next = getNextAvailableAccount(excluded);
			if (next) return { account: next, configuredAccounts };
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
		const { recoverAntiBotChallenge, isCaptchaSolverEnabled } = await import(
			"../../services/captcha-solver.ts"
		);
		if (!isCaptchaSolverEnabled()) return false;

		console.log(
			`🧩 [Captcha] Starting anti-bot recovery for ${accountEmail}...`,
		);
		const result = await recoverAntiBotChallenge(accountId);
		if (result.success) {
			clearAccountCooldown(accountId);
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
		excludeAccountIds,
	} = params;

	const completionId = "chatcmpl-" + uuidv4();
	// Sticky thread binding is independent of forceNewChat. forceNewChat only
	// means "open a fresh upstream chat", not "forget which account owned the
	// logical conversation".
	const threadState =
		allowThreadReuse && sessionId ? getLogicalThreadState(sessionId) : null;
	const stickyThreadAccountId = threadState?.accountId ?? null;
	const canReuseUpstreamChat =
		!!threadState &&
		!forceNewChat &&
		!!threadState.chatSessionId &&
		threadState.chatSessionId.length > 0;
	const existingThread = canReuseUpstreamChat ? threadState : null;

	// preferredAccountId:
	// - string: pin to account
	// - null: explicit failover away from sticky (error path)
	// - undefined: keep sticky when available
	const resolvedPreferred =
		preferredAccountId === null
			? null
			: (preferredAccountId ?? stickyThreadAccountId ?? undefined);
	const excludeSet = new Set(excludeAccountIds ?? []);
	if (preferredAccountId === null && stickyThreadAccountId) {
		excludeSet.add(stickyThreadAccountId);
	}

	const resolved = resolveInitialAccount(resolvedPreferred, excludeSet);

	let account: SelectedAccount | null = resolved.account;
	const configuredAccounts = resolved.configuredAccounts;
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

		// Skip accounts that recently returned chat_in_progress (temporary busy)
		if (
			isAccountTemporarilyBusy(accountId) &&
			params.allowTemporarilyBusyAccountId !== accountId
		) {
			console.log(
				`⏭️  [Chat] Skipping account ${accountEmail} (${accountId}) temporarily busy (chat in progress)`,
			);
			account = getNextAvailableAccount(triedAccountIds);
			continue;
		}

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
						const { schedulePlaywrightProfileReset } = await import(
							"../../services/playwright.ts"
						);
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
				forceNewChat,
				hasExplicitConversationKey: params.allowThreadReuse,
			});
		}

		try {
			// Any account change vs the sticky owner must resend full history into a
			// brand-new upstream chat — the previous account's parent chain is unusable.
			// Same-account forceNewChat keeps the caller's finalPrompt (may already be
			// a rollover summary or a full-history rebuild from the retry layer).
			const recreatingOnNewAccount =
				!!stickyThreadAccountId && accountId !== stickyThreadAccountId;
			const attemptForceNewChat = forceNewChat || recreatingOnNewAccount;
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
					forceNewChat: attemptForceNewChat,
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
					requestSignal: params.requestSignal,
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
					releaseAccountLease: result.releaseAccountLease,
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
					const { schedulePlaywrightProfileReset } = await import(
						"../../services/playwright.ts"
					);
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
	releaseAccountLease: () => void;
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
		requestSignal?: AbortSignal;
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
	let chatInProgressCount = 0;
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
		let accountLease: AccountLease | null = null;

		try {
			const threadParentId = params.useThreadNative
				? params.forceNewChat
					? null
					: (params.existingThread?.parentId ?? null)
				: params.shouldResetUpstreamThread
					? null
					: undefined;
			// Acquire account concurrency lease before personalization + stream creation.
			// The lease is held for the entire stream lifetime and released by the caller
			// via the returned releaseAccountLease function.
			accountLease = await acquireAccountLease(currentAccountId, {
				timeoutMs: config.concurrency.busyWaitMs,
				signal: params.requestSignal,
			});
			const releasePersonalization = params.requestPersonalizationInstruction
				? await acquirePersonalizationLock(currentAccountId)
				: null;
			let result: Awaited<ReturnType<typeof createQwenStream>>;
			try {
				if (params.requestPersonalizationInstruction !== null) {
						// Let the hash-based cache in syncQwenRequestPersonalization decide
						// whether to actually POST. A new chat does not imply the account's
						// global settings were reset — only session refresh or profile reset
						// should bypass the cache.
						await syncQwenRequestPersonalization(
							params.requestPersonalizationInstruction ?? "",
							currentAccountId === "global" ? undefined : currentAccountId,
							{
								model: params.model,
								toolsCount: params.toolsCount ?? 0,
								sessionId: params.sessionId,
								promptChars: params.finalPrompt.length,
								forceSync: false,
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
				// Bind chat/account immediately. Do NOT write the request parent as the
				// sticky parent — that is the *previous* assistant id we attached to.
				// Streaming will rememberParent(response_id) with the new assistant id
				// so the next turn appends (user_action=chat + parent_id=last response).
				// Preserve any existing sticky parent until the stream updates it.
				const priorParent =
					params.existingThread?.parentId ??
					getLogicalThreadState(params.sessionId)?.parentId ??
					null;
				updateLogicalThreadState(params.sessionId, {
					accountId: result.accountId,
					chatSessionId: result.uiSessionId,
					parentId: params.forceNewChat ? null : priorParent,
					instructionsSent: true,
				});

				if (process.env.CHAT_REQUEST_LOG === "true") {
					logger.info("[chat] thread-native upstream session", {
						sessionId: params.sessionId,
						accountId: result.accountId,
						chatSessionId: result.uiSessionId,
						requestParentId: threadParentId ?? null,
						stickyParentId: params.forceNewChat ? null : priorParent,
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

			markAccountSuccessful(currentAccountId);
			return {
				success: true,
				...result,
				releaseAccountLease: accountLease.release,
			};
		} catch (err: any) {
			attemptError = err;
			// Release the lease on failure — the stream was never created or
			// will not be consumed by the caller.
			accountLease?.release();
		}

		attemptsLeft--;
		const err = attemptError;

		// Log the error details for debugging (skip quota errors — logged separately below)
			const errMsg = err instanceof Error ? err.message : String(err || "");
			if (err && !isAccountUnavailableError(err)) {
				const errCode = err.upstreamCode || err.code || "unknown";
				console.warn(
					`❌ [Chat] Request failed | ${currentAccountEmail} | ${errCode} | ${errMsg.substring(0, 200)}`,
				);
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
				const policy = classifyRetryAction(err);
				
				// Single account: retry once after delay before giving up
				if (isSingleAccount && !quotaRetried && attemptsLeft > 0) {
					quotaRetried = true;
					console.warn(
						`⚠️  [Chat] Quota exceeded | ${currentAccountEmail} | Retrying in ${config.retry.baseDelayMs}ms...`,
					);
					await new Promise((resolve) =>
						setTimeout(resolve, config.retry.baseDelayMs),
					);
					continue;
				}

				// Log consolidated quota error with cooldown info
				const cooldownSeconds = policy.accountCooldownMs 
					? Math.round(policy.accountCooldownMs / 1000)
					: 0;
				const cooldownUntil = policy.accountCooldownMs 
					? new Date(Date.now() + policy.accountCooldownMs)
					: null;
				const untilStr = cooldownUntil 
					? ` | until=${formatDateTimeBR(cooldownUntil.getTime())}`
					: "";
				
				console.warn(
					`⚠️  [Chat] Quota exceeded | ${currentAccountEmail} | cooldown=${cooldownSeconds}s${untilStr} | ${quotaMsg.substring(0, 150)}`,
				);

				markAccountFailed(currentAccountId);
				markAccountRateLimited(
					currentAccountId,
					policy.accountCooldownMs,
					policy.accountCooldownReason || "QuotaExceeded",
				);
				return { success: false, error: err };
			}

		const policy = classifyRetryAction(err);

		// Escalating recovery for chat_in_progress:
		// 1st: retry same chat after delay (policy default)
		// 2nd: force new chat on same account with full prompt
		// 3rd+: allow account switch
		if (policy.reason === "chat_in_progress") {
			chatInProgressCount++;
			markAccountTemporarilyBusy(
				currentAccountId,
				config.retry.chatInProgressBusyMs,
			);
			if (chatInProgressCount >= 2 && params.useThreadNative) {
				console.warn(
					`🔄 [Chat] chat_in_progress escalation (${chatInProgressCount}) | forcing new chat on ${currentAccountEmail}`,
				);
				params.existingThread = null;
				params.finalPrompt = params.fullPrompt;
				params.messageCount = params.fullMessageCount ?? params.messageCount;
				params.forceNewChat = true;
			}
			if (chatInProgressCount >= 3 && !isSingleAccount && accountSwitches < maxAccountSwitches) {
				const nextAccount = getNextAvailableAccount(triedAccounts);
				if (nextAccount && nextAccount.id !== currentAccountId) {
					console.warn(
						`🔄 [Chat] chat_in_progress escalation (${chatInProgressCount}) | switching ${currentAccountEmail} -> ${maskEmail(nextAccount.email)}`,
					);
					triedAccounts.add(currentAccountId);
					currentAccountId = nextAccount.id;
					currentAccountEmail = maskEmail(nextAccount.email);
					accountSwitches++;
					if (params.useThreadNative) {
						params.existingThread = null;
						params.finalPrompt = params.fullPrompt;
						params.messageCount = params.fullMessageCount ?? params.messageCount;
						params.forceNewChat = true;
					}
				}
			}
		}

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

				// Account switch always rebuilds a fresh upstream chat with full history.
				// Do NOT persist sticky binding until create succeeds — premature empty
				// chatSessionId writes make subsequent turns rotate/lose context.
				if (params.useThreadNative) {
					params.existingThread = null;
					params.finalPrompt = params.fullPrompt;
					params.messageCount = params.fullMessageCount ?? params.messageCount;
					params.forceNewChat = true;
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
			params.useThreadNative
		) {
			console.warn(
				`🔄 [Chat] Forcing new chat/full context | reason=${policy.reason}`,
			);
			params.existingThread = null;
			params.finalPrompt = params.fullPrompt;
			params.messageCount = params.fullMessageCount ?? params.messageCount;
			params.forceNewChat = true;
		}

		// Drop files on retry for invalid_input to isolate file-related errors
		if (policy.dropFiles && params.allFiles.length > 0) {
			console.warn(
				`🗂️  [Chat] Dropping ${params.allFiles.length} file(s) on retry to isolate invalid_input error:`,
				params.allFiles.map((f) => ({
						name: f.name,
						type: f.type,
						size: f.size ?? "unknown",
					})),
			);
			params.allFiles = [];
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
