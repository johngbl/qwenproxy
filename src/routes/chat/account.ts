import { v4 as uuidv4 } from "uuid";
import {
	getAccountCooldownInfo,
	getNextAccount,
	getNextAvailableAccount,
	markAccountRateLimited,
	syncCooldownsFromDb,
} from "../../core/account-manager.ts";
import { markAccountSuccessful, markAccountFailed, getAccountsByPriority } from "../../core/account-priority.ts";
import { recordWafHardBlock, noteWafRecovery } from "../../core/waf-isolation.ts";
import { loadAccounts, type QwenAccount } from "../../core/accounts.ts";
import { config, type ChatMode } from "../../core/config.ts";
import { ClientAbortedError, UpstreamRateLimit } from "../../core/errors.ts";
import {
  assertPromptWithinLimits,
  truncatePromptToIntelligentLimit,
} from "../../core/prompt-limits.ts";
import {
	formatCooldownUntil,
	isToolcallDebugEnabled,
	logger,
	maskEmail,
} from "../../core/logger.ts";
import { Mutex } from "../../core/mutex.ts";
import { registerStream, removeStream } from "../../core/stream-registry.ts";
import {
	abortLeaseByLabel,
	acquireAccountLease,
	isAccountBusy,
	isAccountSlotHeldByOtherSession,
	isAccountTemporarilyBusy,
	markAccountTemporarilyBusy,
	markLeaseCompletion,
	tryAcquireAccountLease,
	type AccountLease,
} from "../../core/account-concurrency.ts";
import { isAuthMockEnabled } from "../../services/auth-playwright.ts";
import { refreshHeaders } from "../../services/playwright.ts";
import {
	clearAllSessionsForAccount,
	createQwenStream,
	fetchQwenModels,
	getQwenErrorCode,
	getLogicalThreadState,
	invalidateLogicalThreadParent,
	type LogicalThreadEntry,
	PersonalizationSyncError,
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
import { buildRepeatedToolCallReminder } from "../../utils/tool-call-guard.ts";
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

/**
 * Hard deadline for the whole personalization sync. A normal sync takes ~2s;
 * a stuck account page (closed context / WAF) can otherwise hold each browser
 * op for 60s and keep the personalization mutex blocked for minutes.
 */
const PERSONALIZATION_SYNC_DEADLINE_MS = 30_000;

/**
 * Hard deadline for a single stream-acquire attempt (models sync + truncation
 * + personalization + header capture + completion fetch metadata + internal
 * retries). A silent hang past this (observed: 180s with zero logs) fails the
 * attempt with a visible retryable error so the outer loop switches account.
 * Configurable via ACQUIRE_DEADLINE_MS (default 120000).
 */

// Per-chat lock: serializes requests to the same Qwen chat session
const chatLocks = new Map<string, Mutex>();
// Account-level personalization is global mutable Qwen state; keep update+stream
// creation serialized per account when the experimental request-sync mode is used.
const personalizationLocks = new Map<string, Mutex>();

	export async function acquireChatLock(chatId: string): Promise<() => void> {
	const acquireStartedAt = Date.now();
	const timeoutMs = config.concurrency.chatLockTimeoutMs;
	let mutex = chatLocks.get(chatId);
	if (!mutex) {
		mutex = new Mutex(
			`chat:${chatId.substring(0, 8)}`,
			// The chat lock is held for the whole stream lifetime. A long
			// generation (reasoning + huge context) can legitimately exceed the
			// global 120s hold limit; use the same budget as the acquire timeout
			// so the force-release never kills a healthy mid-stream turn.
			timeoutMs,
		);
		chatLocks.set(chatId, mutex);
	}
	const release = await mutex.acquire(timeoutMs, `chat:${chatId.substring(0, 12)}`);
	// Held time must exclude the wait: capture right after the acquire settles,
	// not at function entry (the wait is already visible as `waited Xms` above).
	const heldStartedAt = Date.now();
	if (logger.isLevelEnabled("info")) {
		console.log(
			`🔐 [Chat] Chat lock acquired | chat=${chatId.substring(0, 12)} | waited ${heldStartedAt - acquireStartedAt}ms`,
		);
	}
	return () => {
		release();
		if (logger.isLevelEnabled("info")) {
			console.log(
				`🔓 [Chat] Chat lock released | chat=${chatId.substring(0, 12)} | held ${Date.now() - heldStartedAt}ms`,
			);
		}
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
	/** True when the request resent the FULL prompt on a new upstream chat
	 * (account switch / missing thread parent). The 📤 log line uses this to
	 * show the real payload instead of the thread-native delta. */
	replayedFullContext: boolean;
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
	/** "thread" (reuse upstream chat) or "temp" (new ephemeral chat per request). */
	chatMode: ChatMode;
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
	  /**
	   * True when this request races a same-session stream that has NOT emitted
	   * yet: run on its OWN chat and hop accounts fast instead of waiting.
	   */
	  parallelEscape?: boolean;
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
		syncCooldownsFromDb(configuredAccounts);
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

/**
 * Pick the next account for a PARALLEL escape, preferring one with a FREE slot:
 * not busy, not temporarily busy, not on cooldown, not already tried. A normal
 * request keeps getNextAvailableAccount (cooldown-only picker) so saturated or
 * single-account pools stay lossless — but an auxiliary parallel request must
 * land on an available slot fast and never queue behind a second occupied
 * account (the 2026-08-20 stall rotated ldyjl->cgnx3, both busy, ~14s wait).
 * Falls back to the cooldown-only picker when no FREE account is left, so a
 * fully-busy pool still rotates instead of dead-ending.
 */
function getNextFreeAccountForParallel(
	accounts: QwenAccount[],
	triedAccountIds: Set<string>,
	currentAccountId: string,
): QwenAccount | null {
	const ordered = getAccountsByPriority(accounts);
	const free = ordered.find(
		(c) =>
			c.id !== currentAccountId &&
			!triedAccountIds.has(c.id) &&
			!getAccountCooldownInfo(c.id) &&
			!isAccountTemporarilyBusy(c.id) &&
			!isAccountBusy(c.id),
	);
	if (free) return free;
	// No free slot anywhere: fall back to the normal picker so we still rotate
	// (the tryAcquireAccountLease fail-fast will report account_busy and the
	// loop gives up rather than blocking on a busy pool).
	return getNextAvailableAccount(triedAccountIds);
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
		chatMode,
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
	// A PARALLEL escape must NOT pin to the sticky thread owner: it races the
	// main generation that is likely using that very account, so targeting the
	// sticky would just fail-fast account_busy and waste a rotation hop (the
	// 2026-08-20 02:43:41 stall: parallel req chose the sticky busy account, then
	// a second busy one, ~18s until the client aborted). Rotate to any account
	// so the first hop has a real chance of landing on a free slot.
	const effectivePreferred = params.parallelEscape ? null : preferredAccountId;
	const resolvedPreferred =
		effectivePreferred === null
			? null
			: (effectivePreferred ?? stickyThreadAccountId ?? undefined);
	const excludeSet = new Set(excludeAccountIds ?? []);
	// When rotating away (resolvedPreferred === null) — either an explicit
	// failover OR a parallel escape — exclude the sticky owner so the rotation
	// can never land back on the account the main generation is using.
	if (resolvedPreferred === null && stickyThreadAccountId) {
		excludeSet.add(stickyThreadAccountId);
	}

	const resolved = resolveInitialAccount(resolvedPreferred, excludeSet);

	if (logger.isLevelEnabled("info")) {
		// Why THIS account? The operator needs the decision, not just the
		// result — the previous rounds' "stale label" / "switching" confusion
		// came from logs that showed only the outcome.
		const poolSize = resolved.configuredAccounts.length;
		const cooldownCount = resolved.configuredAccounts.filter((a) =>
			getAccountCooldownInfo(a.id),
		).length;
		const why =
			resolved.account.id === stickyThreadAccountId
				? "sticky"
				: typeof resolvedPreferred === "string" &&
					resolved.account.id === resolvedPreferred
					? "preferred"
					: resolvedPreferred === null
						? "failover-rotate"
						: "round-robin";
		console.log(
			`🎯 [Chat] Account selected | ${maskEmail(resolved.account.email)} (${resolved.account.id}) | reason=${why} | pool=${poolSize}${cooldownCount ? ` | cooldown=${cooldownCount}` : ""}${stickyThreadAccountId ? ` | sticky=${stickyThreadAccountId === resolved.account.id}` : ""}`,
		);
	}

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

		// Skip accounts that recently returned chat_in_progress (temporary busy) —
		// except the sticky thread owner: hopping the owner splinters the
		// conversation and replays the full context on a cold account (~12s
		// reopen + captcha) when the upstream chat is merely settling (2-4s,
		// covered by the same-chat settle retries). Mirrors the saturated-account
		// exception below.
		if (
			isAccountTemporarilyBusy(accountId) &&
			params.allowTemporarilyBusyAccountId !== accountId &&
			accountId !== stickyThreadAccountId
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
		// The thread owner is excluded: rotating the sticky account during a
		// tool/think pause splinters the conversation across upstream chats, so
		// it must queue on its own slot instead of being skipped.
		if (
			isAccountBusy(accountId) &&
			accountId !== stickyThreadAccountId &&
			hasFreeAlternateAccount(configuredAccounts, accountId, triedAccountIds)
		) {
			console.log(
				`⏭️  [Chat] Skipping account ${accountEmail} (${accountId}) busy; rotating to a free account`,
			);
			const nextCandidate = getNextAvailableAccount(triedAccountIds);
			if (nextCandidate && !getAccountCooldownInfo(nextCandidate.id)) {
				account = nextCandidate;
				continue;
			}
			// No usable alternate account exists (e.g. all other accounts are on cooldown):
			// do NOT skip this busy account to death. Fall through and queue on its slot.
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
			// The thread owner (or a deployment where no alternate account is
			// free) must queue on its own slot until generation finishes. A hard
			// 30s busy timeout here would needlessly 500 the same conversation
			// while the model is paused mid-tool/think.
			const waitForSlot =
				(!!stickyThreadAccountId && accountId === stickyThreadAccountId) ||
				!hasFreeAlternateAccount(
					configuredAccounts,
					accountId,
					triedAccountIds,
				);
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
					queueSlotUntilFree: waitForSlot,
					messages: params.messages,
					completionId,
					parallelEscape: params.parallelEscape,
					chatMode,
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
					activeAccountLabel: result.accountEmail,
					replayedFullContext: mustReplayFullContext,
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

		// chat_in_progress exhaustion is TERMINAL: tryCreateStreamWithRetry already
		// spent the full same-chat settle budget AND its single bounded escalation
		// (fresh chat + full replay). Reaching this point means even the escalated
		// fresh chat failed — the inner loop already cleared the origin binding, so
		// the client's next turn starts fresh. Rotating from here would only add a
		// SECOND full-context replay on a cold account for no gain.
		if (isChatInProgressError(lastError)) {
			if (logger.isLevelEnabled("info")) {
				console.log(
					`🛑 [Chat] chat_in_progress budget exhausted (post-escalation) | ${maskEmail(accountEmail)} | failing without account rotation`,
				);
			}
			break;
		}

		if (stickyThreadAccountId === accountId) {
			// A challenged sticky account must be allowed to fall through to the
			// anti-bot handling below; otherwise the whole conversation dies on the
			// account the WAF happened to pick.
			const stickyAccountMustRotate =
				isAccountUnavailableError(lastError) ||
				isAccountInitializationError(lastError) ||
				isAntiBotError(lastError);
			if (stickyAccountMustRotate) {
				if (!quotaInfo) {
					console.warn(
						`⚠️  [Chat] Sticky account unavailable (${isAntiBotError(lastError) ? "waf_challenge" : "upstream failure"}); trying another account with full context.`,
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
			// Hard block: the challenge was NOT solved here. Quarantine with an
			// escalating window AND rotate the device fingerprint + reset the
			// browser context, so the account does not return from cooldown on the
			// same identity the WAF already flagged (upstream account-isolation).
			recordWafHardBlock(accountId);

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

	if (!lastError) {
		const busyOrCooldownError: any = new Error(
			"No accounts available: all accounts are either in use or on cooldown. Retry shortly.",
		);
		busyOrCooldownError.upstreamStatus = 429;
		return {
			error: busyOrCooldownError,
			completionId,
			allOnCooldown: false,
		};
	}

	return {
		error: lastError,
		completionId,
		allOnCooldown: false,
	};
}

interface CreateStreamSuccess {
	success: true;
	stream: ReadableStream;
	uiSessionId: string;
	accountId: string;
	/** Account email that actually served the request (inner rotation may
	 * switch accounts — parallel escape / other retry policies). */
	accountEmail: string;
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

/**
 * Pure: jittered same-chat settle wait for the nth chat_in_progress retry.
 * The base grows with the failure count (busyMs → 2×busyMs from the 4th
 * retry) and context size (promptChars > 500KB/1MB/2MB), randomized within ±25%
 * so concurrent sessions sharing an account never retry in lock-step.
 */
export function jitterChatInProgressDelay(
	retryCount: number,
	busyMs: number,
	rand: () => number = Math.random,
	promptChars: number = 0,
): number {
	let base = retryCount >= 4 ? busyMs * 2 : busyMs;
	if (promptChars > 2_000_000) {
		base = Math.round(base * 1.75);
	} else if (promptChars > 1_000_000) {
		base = Math.round(base * 1.5);
	} else if (promptChars > 500_000) {
		base = Math.round(base * 1.25);
	}
	const raw = base * (0.75 + 0.5 * Math.min(1, Math.max(0, rand())));
	return Math.min(20_000, Math.max(1, Math.round(raw)));
}

/**
 * Decision helper for the per-account lease queue deadline.
 *
 * `true` means the request may wait up to `queueWaitForeverCapMs` for the
 * slot (thread owner waiting on its OWN session, or the last usable account).
 * `false` means it waits at most `busyWaitMs` and then fails with
 * `account_busy` so the attempt loop can rotate accounts.
 *
 * The thread-owner preference is NOT enough on its own: when another session
 * holds the slot, waiting long is pure latency (the other session may keep
 * generating for minutes). Only the same-session holder justifies the long
 * wait (same-session latest-wins / tool loop).
 */
export function shouldWaitQueueForever(
	isThreadOwnerWaiting: boolean,
	heldByOtherSession: boolean,
	hasFreeAlternate: boolean,
): boolean {
	return (isThreadOwnerWaiting && !heldByOtherSession) || !hasFreeAlternate;
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
		queueSlotUntilFree?: boolean;
		messages?: Message[];
		/** Stream registry key; the emit-aware supersede links the lease to it. */
		completionId: string;
		/**
		 * True when this request races a same-session stream that has NOT
		 * emitted yet (title/parallel request): run on its OWN chat instead of
		 * waiting on the main chat's lock, and hop accounts fast (tryAcquire).
		 */
		parallelEscape?: boolean;
		/** "thread" (reuse upstream chat) or "temp" (new ephemeral chat per request). */
		chatMode: ChatMode;
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
	let chatInProgressEscalated = false;
	// Account that accumulated the chat_in_progress failures (the one whose
	// upstream chat is actually stuck "in progress"). The post-budget
	// escalation switches to a FRESH chat, and the loop-exit session clear
	// must drop the binding to the stuck chat — NOT clear the sessions of an
	// account that never served this session (cross-session damage).
	let chatInProgressOriginAccountId: string | null = null;
	let chatInProgressOriginAccountEmail: string | null = null;
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
		const acquireStartedAt = Date.now();

		try {
			// The client may have cancelled between account selection and this
			// attempt (or while a previous attempt was running). Bail before
			// spending time on model sync, truncation or personalization.
			if (params.requestSignal?.aborted) {
				return {
					success: false,
					error: new ClientAbortedError(
						"client aborted before stream creation",
					),
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
			const loopReminder = buildRepeatedToolCallReminder(
				params.messages,
				config.retry.repeatedToolCallWarnThreshold,
			);
			const effectivePrompt = loopReminder
				? `${truncation.prompt}\n\n${loopReminder}`
				: truncation.prompt;

			assertPromptWithinLimits(
				effectivePrompt,
				contextModelId,
				{ accountId: currentAccountId },
			);

			const threadParentId = params.useThreadNative
				? params.forceNewChat || params.parallelEscape
					? null
					: (params.existingThread?.parentId ?? null)
				: params.shouldResetUpstreamThread
					? null
					: undefined;
			// Acquire account concurrency lease before personalization + stream creation.
			// The lease is held for the entire stream lifetime and released by the caller
			// via the returned releaseAccountLease function.
			// The thread owner or the last usable account waits without a hard
			// deadline (bounded by the client's abort signal): a fixed 30s timeout
			// here rejects a single conversation while the model is paused
			// mid-tool/thinking, which burns the request instead of serving it.
			const hasFreeAlt =
				!isSingleAccount &&
				hasFreeAlternateAccount(accounts, currentAccountId, triedAccounts);
			const sessionLabel = params.sessionId ?? currentAccountEmail;
			// The thread owner (or the last usable account) may wait for the slot
			// without a short deadline — but ONLY when the slot is busy with OUR
			// session (same-session latest-wins / tool loop). If ANOTHER session is
			// generating on this account, waiting 120s is pure latency: the other
			// session may hold the slot for minutes. Fail fast with account_busy so
			// the attempt loop rotates to a different account instead (or retries
			// quickly when no alternative exists).
			const heldByOtherSession = isAccountSlotHeldByOtherSession(
				currentAccountId,
				sessionLabel,
			);
			const waitQueueForever = shouldWaitQueueForever(
				params.queueSlotUntilFree === true,
				heldByOtherSession,
				hasFreeAlt,
			);

			// Latest-wins: if the client retried the same session, abort the old
			// generation and free the slot immediately instead of queueing behind it.
			// onlyIfEmitted: a stream that has NOT reached the client yet is
			// protected — killing it would waste a generation the client has not
			// consumed. A PARALLEL request (parallelEscape) never kills at all: it
			// runs on its own chat and must not abort the main generation even
			// after the main emits its first chunk.
			if (params.sessionId && !params.parallelEscape) {
				abortLeaseByLabel(currentAccountId, sessionLabel, {
					onlyIfEmitted: true,
				});
			}

			// Create an AbortController for this lease so a future same-session
			// retry can abort it via abortLeaseByLabel().
			const leaseAbort = new AbortController();
			// Second per-attempt controller: the acquire deadline aborts it so a
			// race-lost createQwenStream (still queued on the account stream
			// lock) dies instead of winning the lock later and burning an
			// upstream request while unobserved.
			const acquireAbort = new AbortController();
			const combinedSignal = params.requestSignal
				? AbortSignal.any([
						params.requestSignal,
						leaseAbort.signal,
						acquireAbort.signal,
					])
				: AbortSignal.any([leaseAbort.signal, acquireAbort.signal]);

			if (params.parallelEscape) {
				// Parallel request racing an unemitted stream: do NOT queue on this
				// account's slot (the main may hold it for minutes while thinking).
				// Fail fast with account_busy so the attempt loop hops to a free
				// account; on a free account the request proceeds on its own chat.
				const quick = tryAcquireAccountLease(
					currentAccountId,
					sessionLabel,
					leaseAbort,
					true,
				);
				if (!quick) {
					const busyError = new Error(
						`Account ${currentAccountId} busy: parallel request (session stream unemitted)`,
					) as Error & { code?: string; parallelEscape?: boolean };
					busyError.code = "account_busy";
					// Expected hop, not an error: suppress the "Request failed" warn.
					busyError.parallelEscape = true;
					throw busyError;
				}
				accountLease = quick;
			} else {
				accountLease = await acquireAccountLease(currentAccountId, {
					timeoutMs: waitQueueForever
						? config.concurrency.queueWaitForeverCapMs
						: config.concurrency.busyWaitMs,
					signal: combinedSignal,
					label: sessionLabel,
					leaseAbortController: leaseAbort,
				});
			}
			// Client may have disconnected (or a same-session retry superseded us)
			// while waiting for the lease. Bail before spending time on
			// personalization sync / captcha solve.
			if (combinedSignal.aborted) {
				accountLease.release();
				return {
					success: false,
					error: new ClientAbortedError(
						"client aborted before stream creation",
					),
				};
			}
			if (logger.isLevelEnabled("info")) {
				console.log(
					`⏱️ [Chat] Acquire: lease | account=${currentAccountEmail} | +${Date.now() - acquireStartedAt}ms`,
				);
			}
			const hasRequestPersonalization =
				params.requestPersonalizationInstruction !== null &&
				params.requestPersonalizationInstruction !== undefined;
			const releasePersonalization = hasRequestPersonalization
				? await acquirePersonalizationLock(currentAccountId)
				: null;
			// A same-session retry (or client disconnect) can abort this request
			// while the personalization sync is still stuck on a hung page op
			// (closed Playwright context / WAF). The sync never resolves, so the
			// finally below would not run and the mutex would stay held for
			// minutes, blocking the retry until its 60s acquire timeout fires.
			// Release the lock immediately on abort instead.
			const onPersonalizationAbort = () => releasePersonalization?.();
			if (combinedSignal.aborted) {
				onPersonalizationAbort();
			} else {
				combinedSignal.addEventListener("abort", onPersonalizationAbort, {
					once: true,
				});
			}
			let result: Awaited<ReturnType<typeof createQwenStream>>;
			try {
				let promptForUpstream = effectivePrompt;
				if (hasRequestPersonalization) {
					// Let the hash-based cache in syncQwenRequestPersonalization decide
					// whether to actually POST. A new chat does not imply the account's
					// global settings were reset — only session refresh or profile reset
					// should bypass the cache.
					const instruction =
						params.requestPersonalizationInstruction ?? "";
					let personalizationApplied = false;
					let syncFailure: string | null = null;
					try {
						// Hard deadline for the whole sync (browser ops each have
						// their own 60s timeout; several sequential stuck ops can
						// hold the personalization mutex for minutes). A normal
						// sync takes ~2s; beyond 30s the account page is stuck —
						// fail fast so the retry loop switches accounts.
						let syncSettled = false;
						let personalizationDeadlineTimer: NodeJS.Timeout | undefined;
						const syncPromise = syncQwenRequestPersonalization(
							instruction,
							currentAccountId === "global"
								? undefined
								: currentAccountId,
							{
								model: params.model,
								toolsCount: params.toolsCount ?? 0,
								sessionId: params.sessionId,
								promptChars: effectivePrompt.length,
								forceSync: false,
							},
						).then(
							(value) => {
								syncSettled = true;
								return value;
							},
							(error) => {
								syncSettled = true;
								syncFailure =
									error instanceof Error ? error.message : String(error);
								return false;
							},
						);
						personalizationApplied = await Promise.race([
							syncPromise,
							new Promise<boolean>((resolve) => {
								personalizationDeadlineTimer = setTimeout(() => {
									if (!syncSettled) {
										syncFailure = `sync timed out after ${PERSONALIZATION_SYNC_DEADLINE_MS}ms`;
									}
									resolve(false);
								}, PERSONALIZATION_SYNC_DEADLINE_MS);
							}),
						]);
						// The sync won the race: stop the deadline so it cannot keep the
						// event loop alive for the full 30s window (it used to leak one
						// 30s timer per request → ~30s of test-suite drain per file).
						if (personalizationDeadlineTimer) {
							clearTimeout(personalizationDeadlineTimer);
						}
					} catch (error) {
						syncFailure =
							error instanceof Error ? error.message : String(error);
					}

					// Agent instructions ride ONLY the account-level personalization —
					// the prompt never carries them. An unconfirmed sync must fail the
					// attempt (retryable → rotates accounts, each re-syncs on its own
					// account) instead of degrading to inline. An empty instruction has
					// nothing to guarantee (plain chat), so it stays best-effort.
					if (instruction && !personalizationApplied) {
						throw new PersonalizationSyncError(
							`personalization sync not confirmed for ${currentAccountEmail}: ${syncFailure ?? "settings response did not confirm the instruction"}`,
						);
					}
					}
					if (logger.isLevelEnabled("info")) {
						console.log(
							`⏱️ [Chat] Acquire: sync | account=${currentAccountEmail} | +${Date.now() - acquireStartedAt}ms`,
						);
					}

					assertPromptWithinLimits(
					promptForUpstream,
					params.contextModelId ?? params.model,
					{ accountId: currentAccountId },
				);
				// Bound the whole acquire with a hard deadline: a silent hang in any
				// phase (mutex wait, header capture, fetch metadata, internal retries)
				// fails fast and retryable instead of blocking the request for minutes
				// with zero log output.
				const acquireDeadlineMs = config.concurrency.acquireDeadlineMs;
				let acquireDeadlineTimer: NodeJS.Timeout | undefined;
				const acquireDeadline = new Promise<never>((_, reject) => {
					acquireDeadlineTimer = setTimeout(() => {
						// Abort the losing createQwenStream (it is still queued on the
						// stream lock or mid-create); the post-lock signal re-check in
						// createQwenStream then throws instead of letting the orphan
						// win the lock later and waste an upstream request.
						acquireAbort.abort();
						const err = new Error(
							`Acquire deadline (${acquireDeadlineMs}ms) exceeded creating stream on ${currentAccountEmail}`,
						) as Error & { code?: string };
						err.code = "acquire_deadline";
						reject(err);
					}, acquireDeadlineMs);
					acquireDeadlineTimer.unref?.();
				});
				result = await Promise.race([
					createQwenStream(
						promptForUpstream,
						params.isThinkingModel,
						params.model,
						threadParentId,
						currentAccountId === "global" ? undefined : currentAccountId,
						params.allFiles.length > 0 ? params.allFiles : undefined,
						params.forceNewChat || params.useThreadNative || params.parallelEscape
							? {
									chatSessionId:
										params.forceNewChat || params.parallelEscape
											? null
											: (params.existingThread?.chatSessionId ?? null),
									forceNewChat: false,
									reasoningMode: params.reasoningMode,
									parallelEscape: params.parallelEscape,
									chatMode: params.chatMode,
								}
							: params.reasoningMode ? { reasoningMode: params.reasoningMode } : undefined,
						combinedSignal,
					),
					acquireDeadline,
				]);
				// The acquire won: stop the deadline so it cannot fire later and
				// abort a signal nobody observes anymore.
				if (acquireDeadlineTimer) clearTimeout(acquireDeadlineTimer);

				if (logger.isLevelEnabled("info")) {
					console.log(
						`⏱️ [Chat] Acquire done | completion=${params.completionId.substring(0, 8)} | account=${currentAccountEmail} | +${Date.now() - acquireStartedAt}ms`,
					);
				}

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
				combinedSignal.removeEventListener(
					"abort",
					onPersonalizationAbort,
				);
				releasePersonalization?.();
			}

			// Client cancelled (or a same-session retry superseded us) during the
			// (potentially slow) personalization sync. Bail before createQwenStream
			// spends time on header capture / captcha.
			if (combinedSignal.aborted) {
				// Never drop a created stream without cancelling it: the wrapped
				// stream's cancel() releases the per-account stream lock. Dropping it
				// silently LEAKS that lock and the next acquire on this account blocks
				// until the acquire deadline (observed symptom: 150s phantom wait).
				void result.stream
					.cancel("client aborted after stream creation")
					.catch(() => {});
				accountLease?.release();
				return {
					success: false,
					error: new ClientAbortedError(
						"client aborted during stream creation",
					),
				};
			}

			if (
				params.useThreadNative &&
				params.updateLogicalThread &&
				!params.parallelEscape &&
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

			// A served stream means the WAF accepted this account's identity:
			// clear the hard-block escalation streak (keeps the next block at the
			// base window instead of compounding forever).
			noteWafRecovery(currentAccountId);
			markAccountSuccessful(currentAccountId);
			if (accountLease) {
				markLeaseCompletion(
					currentAccountId,
					accountLease.leaseId,
					params.completionId,
				);
			}
			return {
				success: true,
				...result,
				accountEmail: currentAccountEmail,
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
		// The account that actually failed THIS attempt — captured before any
		// branch below can switch currentAccountId/Email (chat_in_progress
		// escalation moves to a fresh account). The generic retry log must name
		// the account that failed, not the newly-selected one that was never
		// attempted (observed: "Qwen request failed for 280wu" when 280wu had
		// never been tried and ldyjl had failed 4x with chat_in_progress).
		const failedAccountEmail = currentAccountEmail;

		// Once the client request is aborted, do not rotate accounts or retry. The
		// old request can otherwise keep acquiring leases after the client is gone.
		if (params.requestSignal?.aborted) {
			return { success: false, error: err };
		}

		// Log the error details for debugging (skip quota errors — logged separately below,
		// client aborts — they are silent by design, and chat_in_progress — handled
		// by the dedicated settling log below to avoid alarming false-positive error spam).
		const errMsg = err instanceof Error ? err.message : String(err || "");
		if (
			err &&
			!(err instanceof ClientAbortedError) &&
			!isAccountUnavailableError(err) &&
			!(err as any)?.parallelEscape &&
			!isChatInProgressError(err)
		) {
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
					? ` | until=${formatCooldownUntil(cooldownUntil)}`
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

		// The full retry decision — the `❌ Request failed` line shows the error
		// but not WHY this action was chosen. Surface every field so the next
		// escalation/switch/cooldown is explainable from the log alone.
		if (logger.isLevelEnabled("info")) {
			console.log(
				`🧭 [Chat] Retry policy | account=${currentAccountEmail} | reason=${policy.reason} | retryable=${policy.retryable} | switch=${policy.switchAccount} | newChat=${policy.forceNewChat} | fullPrompt=${policy.retryWithFullPrompt}${policy.dropFiles ? ` | dropFiles` : ""} | retryAfter=${policy.retryAfterMs}ms${policy.accountCooldownMs ? ` | cooldown=${Math.round(policy.accountCooldownMs / 1000)}s (${policy.accountCooldownReason ?? ""})` : ""}`,
			);
		}

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

		// chat_in_progress means the previous Qwen generation has not stopped
		// yet (the tool loop fires the next turn the instant the previous one
		// completes; the upstream chat stays "in progress" for a few seconds
		// after the terminal event — usually 2-4s, measured >6s after a 491KB
		// turn). Policy design (settle-aware, upstream-aligned):
		//  1. Retry the SAME chat with JITTERED busyMs-based waits — never a
		//     fixed ladder (concurrent sessions would retry in lock-step).
		//  2. After the settle budget (CHAT_IN_PROGRESS_MAX_RETRIES, ~35s):
		//     ONE bounded escalation. A chat can be "in progress" for MINUTES
		//     when a superseded generation keeps running server-side — retrying
		//     the same chat then fails every request until it frees (observed:
		//     2.1MB turn held a chat busy ~9min). The single escalation opens a
		//     FRESH chat with the full context so the turn makes progress; it
		//     fires at most once per request (a second replay would only repeat
		//     the ~1MB re-upload cost the settle design removes).
		//  3. If the escalated attempt ALSO fails with chat_in_progress, the
		//     request FAILS and the origin binding is cleared (next client turn
		//     starts fresh with a replay instead of wedging on the stuck chat).
		if (policy.reason === "chat_in_progress") {
			if (chatInProgressOriginAccountId === null) {
				// First chat_in_progress of this request: remember the account
				// whose chat is stuck (used by the loop-exit session handling).
				chatInProgressOriginAccountId = currentAccountId;
				chatInProgressOriginAccountEmail = currentAccountEmail;
			}
			chatInProgressCount++;
			markAccountTemporarilyBusy(
				currentAccountId,
				config.retry.chatInProgressBusyMs,
			);

			if (chatInProgressCount > config.retry.chatInProgressMaxAttempts) {
				if (!chatInProgressEscalated) {
					// Same-chat settle budget exhausted: the chat is genuinely
					// busy, not settling. One bounded escalation — a fresh chat
					// with the full context (the only way to progress while the
					// old chat runs on server-side). Bounded: this fires at most
					// once per request.
					chatInProgressEscalated = true;
					console.warn(
						`🔄 [Chat] chat_in_progress escalation (${chatInProgressCount}) | forcing a new chat with full context on ${currentAccountEmail}`,
					);
					if (params.useThreadNative) {
						params.existingThread = null;
						params.finalPrompt = params.fullPrompt;
						params.messageCount =
							params.fullMessageCount ?? params.messageCount;
						params.forceNewChat = true;
					}
					// The escalation targets a FRESH chat (not the busy one), so
					// no settle wait — it gets its own attempt budget.
					attemptsLeft = Math.max(attemptsLeft, 1);
					policy.retryAfterMs = 0;
				} else {
					// The escalated fresh chat ALSO failed with chat_in_progress
					// (bizarre, but possible on a wedged account). Give up — the
					// outer rotation treats this as terminal.
					attemptsLeft = 0;
					policy.retryable = false;
				}
			} else {
				// The settle window has its own budget, independent of the
				// global RETRY_MAX_ATTEMPTS: with maxAttempts=3 the counter
				// above would hit 0 on the 3rd failure and skip the longer
				// waits that absorb the >6s settles of huge turns (2026-08-11).
				attemptsLeft = Math.max(attemptsLeft, 1);

				// The 1st failure keeps the upstream-suggested wait (~1.2s);
				// later retries wait a jittered context-scaled busyMs-based window.
				if (chatInProgressCount >= 2) {
					const promptChars =
						params.fullPrompt?.length ??
						params.finalPrompt?.length ??
						0;
					policy.retryAfterMs = jitterChatInProgressDelay(
						chatInProgressCount,
						config.retry.chatInProgressBusyMs,
						Math.random,
						promptChars,
					);
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

		// Prefer switching account for any retryable upstream error when possible.
		// A PARALLEL escape hops to a FREE account (skip busy/temporarily-busy):
		// the auxiliary request must land on an available slot fast, never on a
		// second occupied account (the 2026-08-20 stall rotated ldyjl→cgnx3, both
		// busy, ~14s lease wait). Normal requests keep the cooldown-only picker so
		// single-account/saturated pools stay lossless.
		if (
			policy.retryable &&
			shouldSwitchAccount &&
			!isSingleAccount &&
			accountSwitches < maxAccountSwitches
		) {
			const nextAccount = params.parallelEscape
				? getNextFreeAccountForParallel(accounts, triedAccounts, currentAccountId)
				: getNextAvailableAccount(triedAccounts);
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
				// Chat_in_progress give-up only happens AFTER the bounded escalation
				// (the settle window alone cannot exhaust the budget — the first
				// over-budget failure escalates). The escalated chat was freshly
				// created; the STORED binding still points at the stuck chat, so
				// clearing the origin account's sessions frees the next turn to
				// start fresh instead of re-wedging on the stuck chat. For other
				// retryable upstream errors (network/quota) the same clear drops a
				// binding that may point at a genuinely stuck chat. Clear the ORIGIN
				// account — never the current one (other policies may have switched).
				const clearTargetId = chatInProgressOriginAccountId ?? currentAccountId;
				const clearTargetEmail =
					chatInProgressOriginAccountEmail ?? currentAccountEmail;
				console.warn(
					`🧹 [Chat] Clearing session state for ${clearTargetEmail} (${clearTargetId}) after exhausted retries`,
				);
				clearAllSessionsForAccount(clearTargetId);
			}

			return { success: false, error: err };
		}

		const useDelay = Math.max(
			0,
			policy.retryAfterMs ?? retryDelay ?? config.retry.baseDelayMs,
		);

		if (policy.reason === "chat_in_progress") {
			const promptChars =
				params.fullPrompt?.length ??
				params.finalPrompt?.length ??
				0;
			const contextLabel =
				promptChars > 1_000_000
					? `${(promptChars / (1024 * 1024)).toFixed(1)}MB context`
					: promptChars > 100_000
						? `${Math.round(promptChars / 1024)}KB context`
						: "";
			const contextSuffix = contextLabel ? ` | ${contextLabel}` : "";
			console.warn(
				`⏳ [Chat] Chat settling | ${failedAccountEmail}${contextSuffix} | waiting ${(useDelay / 1000).toFixed(1)}s (attempt ${chatInProgressCount}/${config.retry.chatInProgressMaxAttempts})...`,
			);
		} else {
			console.warn(
				`🔄 [Chat] Qwen request failed for ${failedAccountEmail}, retrying in ${useDelay}ms... (${attemptsLeft} left). reason=${policy.reason} error=${errMsg.slice(0, 200)}`,
			);
		}
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
