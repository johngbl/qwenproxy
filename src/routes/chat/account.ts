import { v4 as uuidv4 } from "uuid";
import {

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
  assertPromptWithinLimits,
  truncatePromptToIntelligentLimit,
} from "../../core/prompt-limits.ts";
import {
	isToolcallDebugEnabled,
	logger,
	maskEmail,
} from "../../core/logger.ts";
import { Mutex } from "../../core/mutex.ts";
import { registerStream, removeStream } from "../../core/stream-registry.ts";
import {
	acquireAccountLease,
	isAccountBusy,
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
	fetchQwenModels,
	getQwenErrorCode,
	getLogicalThreadState,
	invalidateLogicalThreadParent,
	type LogicalThreadEntry,
	QwenSessionExpiredError,
	RetryableQwenStreamError,
	syncQwenRequestPersonalization,
	updateLogicalThreadState,
} from "../../services/qwen.ts";
import type { TokenEstimationContext } from "../../services/token-estimation-metrics.ts";
import {
  buildContextMeterSnapshot,
  contextMeterLogData,
  type ContextMeterMode,
} from "../../services/context-meter.ts";
import type { QwenFileEntry } from "../upload.ts";
import type { Message } from "../../utils/types.ts";
import {
	classifyRetryAction,
	isAntiBotError as isAntiBotPolicyError,
	isAccountInitializationError,
	isChatInProgressError,
	isQuotaLikeError,
	isTerminalLocalError,
	shouldRetryInvalidInputOnSameAccount,
} from "./retry-policy.ts";

/** How many alternate accounts a single request may try after a WAF challenge. */
const MAX_ANTI_BOT_ROTATIONS = 1;

// Per-chat lock: serializes requests to the same Qwen chat session
const chatLocks = new Map<string, Mutex>();
// Account-level personalization is global mutable Qwen state; keep update+stream
// creation serialized per account when the experimental request-sync mode is used.
const personalizationLocks = new Map<string, Mutex>();

export async function acquireChatLock(chatId: string): Promise<() => void> {
	let mutex = chatLocks.get(chatId);
	if (!mutex) {
		mutex = new Mutex(`chat:${chatId.substring(0, 8)}`);
		chatLocks.set(chatId, mutex);
	}
	const release = await mutex.acquire(60_000, `chat:${chatId.substring(0, 12)}`);
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
		mutex = new Mutex(`personalization:${accountId.substring(0, 8)}`);
		personalizationLocks.set(accountId, mutex);
	}
	const release = await mutex.acquire(60_000, `personalization:${accountId.substring(0, 8)}`);
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
	reasoningMode?: "auto" | "thinking" | "fast";
	shouldResetUpstreamThread: boolean;
	allFiles: QwenFileEntry[];
	isNewSession: boolean;
	sessionId: string | null;
	useThreadNative: boolean;
	updateLogicalThread: boolean;
	allowThreadReuse: boolean;
	/** Full message history for intelligent context truncation after model sync. */
	messages?: Message[];
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
	  /** Mapped Qwen model id used for local prompt-budget validation. */
	  contextModelId?: string;
	  requestSignal?: AbortSignal;
	  /** Context accounting mode for this concrete upstream attempt. */
	  contextMode?: ContextMeterMode;
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

function hasFreeAlternateAccount(
	accounts: SelectedAccount[],
	currentAccountId: string,
	triedAccountIds: Set<string>,
): boolean {
	return accounts.some(
		(candidate) =>
			candidate.id !== currentAccountId &&
			!triedAccountIds.has(candidate.id) &&
			!getAccountCooldownInfo(candidate.id) &&
			!isAccountTemporarilyBusy(candidate.id) &&
			!isAccountBusy(candidate.id),
	);
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
		reasoningMode,
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
		threadState.chatSessionId.length > 0 &&
		!!threadState.parentId;
	// A thread with an upstream chat but no committed parent is dirty (failed
	// first turn, interrupted generation, corrupted history). It must not be
	// appended to; rebuild a fresh chat with the full prompt instead.
	const threadMissingParent =
		!!threadState &&
		!!threadState.chatSessionId &&
		threadState.chatSessionId.length > 0 &&
		!threadState.parentId;
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
	let antiBotRotations = 0;

	while (account) {
		const accountId = account.id;
		const accountEmail = maskEmail(account.email);

		if (triedAccountIds.has(accountId)) {
			account = getNextAvailableAccount(triedAccountIds);
			continue;
		}
		triedAccountIds.add(accountId);

		// Skip accounts that recently returned chat_in_progress (temporary busy).
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

		// Do not wait 30 seconds on a saturated account when another account is
		// already free. Keep the queue behavior only when this is the last usable
		// account, so single-account deployments remain lossless.
		if (
			isAccountBusy(accountId) &&
			hasFreeAlternateAccount(configuredAccounts, accountId, triedAccountIds)
		) {
			console.log(
				`⏭️  [Chat] Skipping account ${accountEmail} (${accountId}) busy; rotating to a free account`,
			);
			account = getNextAvailableAccount(triedAccountIds);
			continue;
		}

		const cooldownInfo = getAccountCooldownInfo(accountId);
		if (cooldownInfo) {
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
			const mustReplayFullContext =
				recreatingOnNewAccount || threadMissingParent;
			const attemptForceNewChat = forceNewChat || mustReplayFullContext;
			const attemptFinalPrompt = mustReplayFullContext
				? params.fullPrompt
				: finalPrompt;
			const result = await tryCreateStreamWithRetry(
				{
					finalPrompt: attemptFinalPrompt,
					isThinkingModel,
					model,
					reasoningMode,
					shouldResetUpstreamThread,
					allFiles,
					sessionId,
					useThreadNative,
					updateLogicalThread,
					forceNewChat: attemptForceNewChat,
					existingThread:
						!mustReplayFullContext &&
						existingThread &&
						existingThread.accountId === accountId
							? existingThread
							: null,
					messageCount: mustReplayFullContext
						? (params.fullMessageCount ?? params.messageCount)
						: params.messageCount,
					fullMessageCount: params.fullMessageCount,
					toolsCount: params.toolsCount,
					requestPersonalizationInstruction:
						params.requestPersonalizationInstruction,
					contextModelId: params.contextModelId,
					fullPrompt: params.fullPrompt,
					contextMode: mustReplayFullContext
						? "replay"
						: params.contextMode,
					requestSignal: params.requestSignal,
					messages: params.messages,
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

		// The request signal is shared by every account attempt. Once the client
		// disconnects, stop the outer rotation loop as well as inner retries.
		if (params.requestSignal?.aborted) {
			break;
		}

		// Client/proxy validation errors must not be retried on other accounts.
		// In particular, an oversized prompt is independent of the selected
		// account; rotating accounts only repeats the same 400 response and can
		// also rebuild the full history several times.
		if (isTerminalLocalError(lastError)) {
			break;
		}

		const quotaInfo = (lastError as any)?.quotaInfo as
			| {
					email: string;
					cooldownSeconds: number;
					untilStr: string;
					message: string;
			  }
			| undefined;
		if (quotaInfo) {
			const stickyRotation =
				stickyThreadAccountId === accountId &&
				(isAccountUnavailableError(lastError) ||
					isAccountInitializationError(lastError) ||
					isChatInProgressError(lastError));
			console.warn(
				`⚠️  [Chat] Quota exceeded | ${quotaInfo.email} | cooldown=${quotaInfo.cooldownSeconds}s${quotaInfo.untilStr} | ${quotaInfo.message}${stickyRotation ? " | switching sticky account with full context" : ""}`,
			);
		}

		if (stickyThreadAccountId === accountId) {
			// A challenged sticky account must be allowed to fall through to the
			// anti-bot handling below; otherwise the whole conversation dies on the
			// account the WAF happened to pick.
			const stickyAccountMustRotate =
				isAccountUnavailableError(lastError) ||
				isAccountInitializationError(lastError) ||
				isChatInProgressError(lastError) ||
				isAntiBotError(lastError);
			if (stickyAccountMustRotate) {
				if (!quotaInfo) {
					console.warn(
						`⚠️  [Chat] Sticky account unavailable (${isChatInProgressError(lastError) ? "chat_in_progress" : isAntiBotError(lastError) ? "waf_challenge" : "upstream failure"}); trying another account with full context.`,
					);
				}
			} else {
				break;
			}
		}

		// The inner retry loop already replayed this account and tried to clear the
		// challenge. Hand the request to one other account rather than failing it
		// outright, then stop: walking the whole pool would only get every account
		// challenged in turn and multiply the solver budget by the pool size.
		if (isAntiBotError(lastError)) {
			if (config.captcha.accountCooldownMs > 0) {
				markAccountRateLimited(
					accountId,
					config.captcha.accountCooldownMs,
					"WafChallenge",
				);
			}

			if (antiBotRotations >= MAX_ANTI_BOT_ROTATIONS) {
				console.warn(
					`⚠️  [Chat] WAF challenge retries exhausted | ${accountEmail} | no further rotation`,
				);
				break;
			}

			const nextAfterChallenge = getNextAvailableAccount(triedAccountIds);
			if (!nextAfterChallenge) {
				console.warn(
					`⚠️  [Chat] WAF challenge retries exhausted | ${accountEmail} | no other account available`,
				);
				break;
			}

			antiBotRotations++;
			console.warn(
				`🔄 [Chat] WAF challenge on ${accountEmail}; retrying on ${maskEmail(nextAfterChallenge.email)}`,
			);
			account = nextAfterChallenge;
			continue;
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
		reasoningMode?: "auto" | "thinking" | "fast";
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
		contextModelId?: string;
		contextMode?: ContextMeterMode;
		requestSignal?: AbortSignal;
		messages?: Message[];
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
	let lastAttemptError: any = null;
	let invalidInputSameAccountRetried = false;
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
			// The client may have cancelled between account selection and this
			// attempt (or while a previous attempt was running). Bail before
			// spending time on model sync, truncation or personalization.
			if (params.requestSignal?.aborted) {
				return {
					success: false,
					error: new Error("client aborted before stream creation"),
				};
			}

			// Always sync the model catalog so the truncation and prompt-limit
			// checks use the real context window published by Qwen, not the
			// conservative registry fallback. The call is cached per account.
			try {
				await fetchQwenModels(currentAccountId);
			} catch (metadataError) {
				logger.warn("[chat] model metadata sync unavailable; using registry fallback", {
					model: params.contextModelId ?? params.model,
					error:
						metadataError instanceof Error
							? metadataError.message
							: String(metadataError),
				});
			}

			// Truncate after the real context window is known so long conversations
			// are not cut down to the conservative 128K fallback.
			const contextModelId = params.contextModelId ?? params.model;
			const truncation = truncatePromptToIntelligentLimit(
				params.finalPrompt,
				contextModelId,
				currentAccountId,
				params.messages,
			);
			if (truncation.wasTruncated) {
				logger.warn(
					"[chat] prompt exceeded model context limit; intelligent truncation applied",
					{
						originalTokens: truncation.originalTokens,
						truncatedTokens: truncation.truncatedTokens,
						messagesKept: truncation.messagesKept,
						messagesDropped: truncation.messagesDropped,
					},
				);
			}
			const effectivePrompt = truncation.prompt;

			assertPromptWithinLimits(
				effectivePrompt,
				contextModelId,
				{ accountId: currentAccountId },
			);

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
			// Client may have disconnected while waiting for the lease. Bail before
			// spending time on personalization sync / captcha solve.
			if (params.requestSignal?.aborted) {
				accountLease.release();
				return { success: false, error: new Error("client aborted before stream creation") };
			}
			const hasRequestPersonalization =
				params.requestPersonalizationInstruction !== null &&
				params.requestPersonalizationInstruction !== undefined;
			const releasePersonalization = hasRequestPersonalization
				? await acquirePersonalizationLock(currentAccountId)
				: null;
			let result: Awaited<ReturnType<typeof createQwenStream>>;
			try {
				let promptForUpstream = effectivePrompt;
				if (hasRequestPersonalization) {
					// Let the hash-based cache in syncQwenRequestPersonalization decide
					// whether to actually POST. A new chat does not imply the account's
					// global settings were reset — only session refresh or profile reset
					// should bypass the cache.
					const instruction = params.requestPersonalizationInstruction ?? "";
					let personalizationApplied = false;
					try {
						personalizationApplied = await syncQwenRequestPersonalization(
							instruction,
							currentAccountId === "global" ? undefined : currentAccountId,
							{
								model: params.model,
								toolsCount: params.toolsCount ?? 0,
								sessionId: params.sessionId,
								promptChars: effectivePrompt.length,
								forceSync: false,
							},
						);
					} catch (error) {
						logger.warn(
							"[Chat] Personalization sync failed; sending instructions inline",
							{
								accountId: currentAccountId,
								error:
									error instanceof Error ? error.message : String(error),
							},
						);
					}

					if (
						!personalizationApplied &&
						instruction &&
						!promptForUpstream.startsWith(instruction)
					) {
						logger.warn(
							"[Chat] Personalization was not confirmed; sending instructions inline",
							{
								accountId: currentAccountId,
								instructionChars: instruction.length,
							},
						);
						promptForUpstream = `${instruction}\n${promptForUpstream}`;
					}
					}

				assertPromptWithinLimits(
					promptForUpstream,
					params.contextModelId ?? params.model,
					{ accountId: currentAccountId },
				);
				result = await createQwenStream(
						promptForUpstream,
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
									reasoningMode: params.reasoningMode,
								}
							: params.reasoningMode ? { reasoningMode: params.reasoningMode } : undefined,
					params.requestSignal,
				);

				const contextMeter = buildContextMeterSnapshot({
					modelId: params.contextModelId ?? params.model,
					accountId: currentAccountId,
					requestPrompt: promptForUpstream,
					fullPrompt: params.fullPrompt,
					mode:
						params.contextMode ??
						(params.forceNewChat
							? "replay"
							: params.existingThread
								? "delta"
								: "full"),
					qwenPayloadBytes: result.tokenEstimationContext.qwenPayloadBytes,
					qwenPayloadPromptChars:
						result.tokenEstimationContext.qwenPayloadPromptChars,
					qwenPayloadMessageCount:
						result.tokenEstimationContext.qwenPayloadMessageCount,
					messageCount: params.messageCount,
					fullMessageCount: params.fullMessageCount,
					toolsCount: params.toolsCount,
					filesCount: params.allFiles.length,
					activePersonalization:
						result.tokenEstimationContext.activePersonalization,
				});

				if (contextMeter) {
					logger.debug("[context_meter] request", {
						...contextMeterLogData(contextMeter),
						account: currentAccountEmail,
						attempt,
					});
					result = {
						...result,
						tokenEstimationContext: {
							...result.tokenEstimationContext,
							contextMeter,
						},
					};
				}
			} finally {
				releasePersonalization?.();
			}

			// Client cancelled during the (potentially slow) personalization sync.
			// Bail before createQwenStream spends time on header capture / captcha.
			if (params.requestSignal?.aborted) {
				accountLease?.release();
				return {
					success: false,
					error: new Error("client aborted during stream creation"),
				};
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
			lastAttemptError = err;
			// Release the lease on failure — the stream was never created or
			// will not be consumed by the caller.
			accountLease?.release();
		}

		attemptsLeft--;
		const err = attemptError;

		// Once the client request is aborted, do not rotate accounts or retry. The
		// old request can otherwise keep acquiring leases after the client is gone.
		if (params.requestSignal?.aborted) {
			return { success: false, error: err };
		}

		// Log the error details for debugging (skip quota errors — logged separately below)
			const errMsg = err instanceof Error ? err.message : String(err || "");
			if (err && !isAccountUnavailableError(err)) {
				const errCode = getQwenErrorCode(err) || "unknown";
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





		// Account-scoped quota/rate-limit: cool this account and stop local retries
			// so outer account rotation can pick another one immediately.
			if (isAccountUnavailableError(err)) {
				const quotaMsg = err.message || "Unknown quota error";
				const policy = classifyRetryAction(err, {
					requestAborted: params.requestSignal?.aborted === true,
				});
				const isTemporary = policy.accountCooldownReason === "RateLimitTemporary";
				
				// Temporary load shedding or single account: retry same account
				// after a short delay before giving up / rotating.
				if ((isTemporary || isSingleAccount) && !quotaRetried && attemptsLeft > 0) {
					quotaRetried = true;
					const delayMs = isTemporary ? 3_000 : config.retry.baseDelayMs;
					console.warn(
						`⚠️  [Chat] Quota exceeded | ${currentAccountEmail} | ${isTemporary ? "temporary, " : ""}retrying in ${delayMs}ms...`,
					);
					await new Promise((resolve) =>
						setTimeout(resolve, delayMs),
					);
					continue;
				}

				// Consolidate quota details into a single log emitted by the outer
				// rotation loop. The cooldown itself is set silently to avoid duplicates.
				const cooldownSeconds = policy.accountCooldownMs
					? Math.round(policy.accountCooldownMs / 1000)
					: 0;
				const cooldownUntil = policy.accountCooldownMs
					? new Date(Date.now() + policy.accountCooldownMs)
					: null;
				const untilStr = cooldownUntil
					? ` | until=${formatDateTimeBR(cooldownUntil.getTime())}`
					: "";

				try {
					(err as any).quotaInfo = {
						email: currentAccountEmail,
						cooldownSeconds,
						untilStr,
						message: quotaMsg.substring(0, 150),
					};
				} catch {
					// Best-effort metadata for logging.
				}

				markAccountFailed(currentAccountId);
				markAccountRateLimited(
					currentAccountId,
					policy.accountCooldownMs,
					policy.accountCooldownReason || "QuotaExceeded",
					{ silent: true },
				);
				return { success: false, error: err };
			}

		const policy = classifyRetryAction(err, {
			requestAborted: params.requestSignal?.aborted === true,
		});

		// Corrupted history means the stored parent chain is unusable. Purge the
		// parent immediately so a failed recovery cannot leave the tainted thread
		// bound for the next turn.
		if (policy.reason === "corrupted_chat_history") {
			invalidateLogicalThreadParent(params.sessionId);
		}

		// A generic invalid_input is often a stale/corrupted upstream chat rather
		// than an account failure. Rebuild it once on the same account first. If the
		// fresh chat fails again, the normal policy is allowed to rotate.
		const retryInvalidInputOnSameAccount =
			shouldRetryInvalidInputOnSameAccount(
				policy.reason,
				invalidInputSameAccountRetried,
			);
		if (retryInvalidInputOnSameAccount) {
			invalidInputSameAccountRetried = true;
		}
		const shouldSwitchAccount =
			policy.switchAccount && !retryInvalidInputOnSameAccount;

		// chat_in_progress means the previous Qwen generation has not stopped yet;
		// it is not a quota error. Retry the same chat once, then rotate while an
		// attempt remains so the alternate account can actually be used.
		if (policy.reason === "chat_in_progress") {
			chatInProgressCount++;
			markAccountTemporarilyBusy(
				currentAccountId,
				config.retry.chatInProgressBusyMs,
			);

			if (chatInProgressCount >= 2) {
				const nextAccount =
					!isSingleAccount && accountSwitches < maxAccountSwitches
						? getNextAvailableAccount(triedAccounts)
						: null;
				if (nextAccount && nextAccount.id !== currentAccountId) {
					console.warn(
						`🔄 [Chat] chat_in_progress escalation (${chatInProgressCount}) | switching ${currentAccountEmail} -> ${maskEmail(nextAccount.email)}`,
					);
					triedAccounts.add(currentAccountId);
					currentAccountId = nextAccount.id;
					currentAccountEmail = maskEmail(nextAccount.email);
					accountSwitches++;
				} else {
					console.warn(
						`🔄 [Chat] chat_in_progress escalation (${chatInProgressCount}) | forcing a new chat on ${currentAccountEmail}`,
					);
				}

				if (params.useThreadNative) {
					params.existingThread = null;
					params.finalPrompt = params.fullPrompt;
					params.messageCount = params.fullMessageCount ?? params.messageCount;
					params.forceNewChat = true;
				}
			}
		}

		if (policy.reason === "account_initialization_failed") {
			console.warn(
				`⚠️  [Chat] Account initialization failed | ${currentAccountEmail} | cooldown=${Math.round((policy.accountCooldownMs ?? 0) / 1000)}s`,
			);
			markAccountFailed(currentAccountId);
			markAccountRateLimited(
				currentAccountId,
				policy.accountCooldownMs,
				policy.accountCooldownReason,
			);
			return { success: false, error: err };
		}

		// Prefer switching account for any retryable upstream error when possible
		if (
			policy.retryable &&
			shouldSwitchAccount &&
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
						Math.min(policy.retryAfterMs ?? config.retry.baseDelayMs, 1000),
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
			policy.retryAfterMs ?? retryDelay ?? config.retry.baseDelayMs,
		);

		console.warn(
			`🔄 [Chat] Qwen request failed for ${currentAccountEmail}, retrying in ${useDelay}ms... (${attemptsLeft} left). reason=${policy.reason} error=${errMsg.slice(0, 200)}`,
		);
		await new Promise((r) => setTimeout(r, useDelay));
		retryDelay = Math.min(retryDelay * 2, config.retry.maxDelayMs);
	}

	return {
		success: false,
		error:
			lastAttemptError ??
			new Error("Qwen stream retry attempts were exhausted"),
	};
}
