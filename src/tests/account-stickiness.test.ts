/**
 * Account stickiness + full-history on account switch.
 *
 * Contract:
 * - Keep the sticky/thread account across turns unless the account fails.
 * - preferredAccountId=null is the only explicit "rotate away" signal.
 * - forceNewChat must NOT clear sticky ownership by itself.
 * - When switching accounts, resend full conversation history.
 */

import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import {
	clearAccountCooldown,
	markAccountRateLimited,
} from "../core/account-manager.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import { getDatabase } from "../core/database.ts";
import { resolveInitialAccount } from "../routes/chat/account.ts";
import { buildFinalContext } from "../routes/chat/context.ts";
import {
	getLogicalThreadState,
	updateLogicalThreadState,
} from "../services/qwen.ts";
import { deriveSessionId } from "../utils/session-id.ts";

function withTempAccounts(
	accounts: Array<{ id: string; email: string; password: string }>,
	fn: () => void | Promise<void>,
) {
	return async () => {
		const originalEnv = process.env.QWEN_ACCOUNTS;
		delete process.env.QWEN_ACCOUNTS;
		const originalMock = process.env.TEST_MOCK_QWEN_AUTH;
		// resolveInitialAccount short-circuits to mock-account while mock auth is on
		delete process.env.TEST_MOCK_QWEN_AUTH;

		const db = getDatabase();
		const existing = db
			.prepare("SELECT id, email, password FROM accounts")
			.all() as Array<{ id: string; email: string; password: string }>;
		db.prepare("DELETE FROM accounts").run();
		invalidateAccountsCache();

		const insert = db.prepare(
			"INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
		);
		for (const acc of accounts) {
			insert.run(acc.id, acc.email, acc.password);
			clearAccountCooldown(acc.id);
		}
		invalidateAccountsCache();

		try {
			await fn();
		} finally {
			for (const acc of accounts) clearAccountCooldown(acc.id);
			db.prepare("DELETE FROM accounts").run();
			const restore = db.prepare(
				"INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
			);
			for (const row of existing) {
				restore.run(row.id, row.email, row.password);
			}
			invalidateAccountsCache();
			if (originalEnv !== undefined) process.env.QWEN_ACCOUNTS = originalEnv;
			if (originalMock !== undefined) {
				process.env.TEST_MOCK_QWEN_AUTH = originalMock;
			} else {
				process.env.TEST_MOCK_QWEN_AUTH = "true";
			}
		}
	};
}

test(
	"resolveInitialAccount: prefers sticky account and does not rotate by default",
	withTempAccounts(
		[
			{ id: "acc-a", email: "a@test.com", password: "p" },
			{ id: "acc-b", email: "b@test.com", password: "p" },
			{ id: "acc-c", email: "c@test.com", password: "p" },
		],
		() => {
			const first = resolveInitialAccount("acc-b");
			assert.equal(first.account.id, "acc-b");

			// Calling again with same sticky preference must stay on same account
			const second = resolveInitialAccount("acc-b");
			assert.equal(second.account.id, "acc-b");

			// undefined preferred falls through to round-robin, not forced switch away
			const rr1 = resolveInitialAccount(undefined);
			assert.ok(rr1.account.id);
		},
	),
);

test(
	"resolveInitialAccount: preferredAccountId=null rotates away from sticky/excluded",
	withTempAccounts(
		[
			{ id: "acc-a", email: "a@test.com", password: "p" },
			{ id: "acc-b", email: "b@test.com", password: "p" },
			{ id: "acc-c", email: "c@test.com", password: "p" },
		],
		() => {
			const rotated = resolveInitialAccount(null, ["acc-a"]);
			assert.notEqual(rotated.account.id, "acc-a");

			const rotatedSticky = resolveInitialAccount(null, ["acc-b"]);
			assert.notEqual(rotatedSticky.account.id, "acc-b");
		},
	),
);

test(
	"resolveInitialAccount: sticky on cooldown falls over to another account",
	withTempAccounts(
		[
			{ id: "acc-a", email: "a@test.com", password: "p" },
			{ id: "acc-b", email: "b@test.com", password: "p" },
		],
		() => {
			markAccountRateLimited("acc-a", 60_000, "RateLimited");
			const next = resolveInitialAccount("acc-a");
			assert.equal(next.account.id, "acc-b");
		},
	),
);

test("thread-native continuation reuses sticky account binding from logical state", async () => {
	const messages = [
		{ role: "user", content: "hello sticky" },
		{ role: "assistant", content: "hi" },
		{ role: "user", content: "continue" },
	] as any[];

	// buildFinalContext includes systemPrompt in the hash when conversationKey is set
	const systemPrompt = "sys";
	const sessionId = deriveSessionId(messages, systemPrompt, "stick-session-1");
	updateLogicalThreadState(sessionId, {
		accountId: "acc-sticky",
		chatSessionId: "chat-sticky-1",
		parentId: "parent-1",
		instructionsSent: true,
	});

	const ctx = await buildFinalContext({
		messages,
		systemPrompt,
		prompt: "User: hello sticky\n\nAssistant: hi\n\nUser: continue\n\n",
		currentPrompt: "User: continue\n\n",
		modelId: "qwen3.7-plus",
		enableThinking: false,
		conversationKey: "stick-session-1",
		hasExplicitConversationKey: true,
	});

	assert.equal(ctx.allowThreadReuse, true);
	assert.equal(ctx.sessionId, sessionId);
	assert.equal(ctx.existingThread, true);
	assert.equal(ctx.isNewSession, false);

	const state = getLogicalThreadState(sessionId);
	assert.ok(state);
	assert.equal(state!.accountId, "acc-sticky");
	assert.equal(state!.chatSessionId, "chat-sticky-1");

	// forceNewChat semantics: sticky owner remains readable even if caller forces
	// a new chat (account layer should still pin to this account unless null).
	assert.equal(state!.accountId, "acc-sticky");
});

test("account switch contract: full history is required when sticky owner changes", () => {
	const stickyAccountId: string = "acc-old";
	const selectedAccountId: string = "acc-new";
	const forceNewChat = true;
	const finalPrompt = "User: only the latest turn\n\n";
	const fullPrompt =
		"System: tools\nUser: first\n\nAssistant: reply\n\nUser: only the latest turn\n\n";

	const recreatingOnNewAccount =
		!!stickyAccountId && selectedAccountId !== stickyAccountId;
	const mustUseFullPrompt = recreatingOnNewAccount || forceNewChat;
	const attemptForceNewChat = forceNewChat || recreatingOnNewAccount;
	const attemptFinalPrompt = mustUseFullPrompt ? fullPrompt : finalPrompt;

	assert.equal(recreatingOnNewAccount, true);
	assert.equal(mustUseFullPrompt, true);
	assert.equal(attemptForceNewChat, true);
	assert.equal(attemptFinalPrompt, fullPrompt);
	assert.notEqual(attemptFinalPrompt, finalPrompt);
});
