import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import {
  classifyRetryAction,
  isTerminalLocalError,
  parseSseErrorFromBuffer,
  throwFromSseUpstreamError,
  toRetryableStreamError,
} from "../routes/chat/retry-policy.ts";
import {
  QwenNetworkError,
  QwenUpstreamError,
  RetryableQwenStreamError,
} from "../services/qwen.ts";
import { ValidationError, AuthError } from "../core/errors.ts";

test("classifyRetryAction: unknown upstream errors are retryable by default", () => {
  const err = Object.assign(new Error("brand new qwen failure xyz"), {
    upstreamCode: "totally_new_code_2026",
  });
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
  assert.equal(action.forceNewChat, true);
  assert.equal(action.reason, "unknown_upstream_default_retry");
});

test("classifyRetryAction: terminal local errors are not retryable", () => {
  assert.equal(isTerminalLocalError(new ValidationError("bad body")), true);
  assert.equal(isTerminalLocalError(new AuthError("no key")), true);

  const validation = classifyRetryAction(new ValidationError("messages required"));
  assert.equal(validation.retryable, false);
  assert.equal(validation.reason, "terminal_local");

  const auth = classifyRetryAction(new AuthError("Missing or invalid authorization"));
  assert.equal(auth.retryable, false);
});

test("classifyRetryAction: invalid_input forces new chat + full prompt + switch", () => {
  const err = Object.assign(
    new Error("invalid_input: Entrada ou anexo inválido. Verifique e tente novamente."),
    { upstreamCode: "invalid_input" },
  );
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
  assert.equal(action.forceNewChat, true);
  assert.equal(action.retryWithFullPrompt, true);
  assert.equal(action.reason, "invalid_input");
});

test("classifyRetryAction: quota prefers account switch", () => {
  const err = Object.assign(
    new Error("quota_limit: O serviço está com alta demanda no momento."),
    { upstreamCode: "quota_limit", upstreamStatus: 502 },
  );
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
  assert.equal(action.reason, "quota_or_rate_limit");
});

test("classifyRetryAction: network / abort / upstream error classes retry with switch", () => {
  const network = classifyRetryAction(new QwenNetworkError("fetch failed"));
  assert.equal(network.retryable, true);
  assert.equal(network.switchAccount, true);
  assert.equal(network.forceNewChat, true);
  assert.equal(network.reason, "network");

  const upstream = classifyRetryAction(
    new QwenUpstreamError(
      "Qwen upstream error: internal_error: boom",
      "internal_error",
      502,
    ),
  );
  assert.equal(upstream.retryable, true);
  assert.equal(upstream.switchAccount, true);
  assert.equal(upstream.forceNewChat, true);
  assert.equal(upstream.reason, "upstream_error");

  const abort = Object.assign(new Error("This operation was aborted"), {
    name: "AbortError",
  });
  const abortAction = classifyRetryAction(abort);
  assert.equal(abortAction.retryable, true);
  assert.equal(abortAction.switchAccount, true);
  assert.equal(abortAction.forceNewChat, true);
  assert.equal(abortAction.reason, "stream_aborted");
});

test("classifyRetryAction: chat not exist is not treated as quota", () => {
  const err = new RetryableQwenStreamError(
    "Qwen: Invalid input the chat stale-chat is not exist.",
    1000,
  );
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.forceNewChat, true);
  assert.equal(action.retryWithFullPrompt, true);
  assert.equal(action.reason, "chat_not_exist");
  assert.equal(action.accountCooldownReason, undefined);
});

test("classifyRetryAction: preserves explicit RetryableQwenStreamError flags", () => {
  const err = new RetryableQwenStreamError("mid-stream fail", 1500) as RetryableQwenStreamError & {
    switchAccount?: boolean;
    forceNewChat?: boolean;
    retryWithFullPrompt?: boolean;
    upstreamCode?: string;
  };
  err.switchAccount = false;
  err.forceNewChat = true;
  err.retryWithFullPrompt = true;
  err.upstreamCode = "custom";

  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, false);
  assert.equal(action.forceNewChat, true);
  assert.equal(action.retryWithFullPrompt, true);
  assert.equal(action.retryAfterMs, 1500);
  assert.equal(action.reason, "explicit_retryable");
});

test("throwFromSseUpstreamError maps any SSE error to RetryableQwenStreamError", () => {
  assert.throws(
    () => throwFromSseUpstreamError("internal_error", "Ocorreu um erro inesperado."),
    (err: unknown) => {
      assert.ok(err instanceof RetryableQwenStreamError);
      const typed = err as RetryableQwenStreamError & {
        switchAccount?: boolean;
        forceNewChat?: boolean;
        upstreamCode?: string;
      };
      assert.equal(typed.upstreamCode, "internal_error");
      assert.equal(typed.switchAccount, true);
      assert.equal(typed.forceNewChat, true);
      return true;
    },
  );

  assert.throws(
    () =>
      throwFromSseUpstreamError(
        "invalid_input",
        "Entrada ou anexo inválido. Verifique e tente novamente.",
      ),
    (err: unknown) => {
      assert.ok(err instanceof RetryableQwenStreamError);
      const typed = err as RetryableQwenStreamError & {
        forceNewChat?: boolean;
        retryWithFullPrompt?: boolean;
        switchAccount?: boolean;
      };
      assert.equal(typed.forceNewChat, true);
      assert.equal(typed.retryWithFullPrompt, true);
      assert.equal(typed.switchAccount, true);
      assert.match(String((err as Error).message), /invalid input/i);
      return true;
    },
  );

  assert.throws(
    () =>
      throwFromSseUpstreamError(
        "weird_new_code",
        "Completely novel upstream failure from tomorrow",
      ),
    (err: unknown) => err instanceof RetryableQwenStreamError,
  );
});

test("toRetryableStreamError merges policy defaults with options", () => {
  const err = toRetryableStreamError("stream_aborted", "This operation was aborted", {
    forceNewChat: true,
    switchAccount: true,
    retryAfterMs: 2000,
    reason: "stream_aborted",
  });
  assert.ok(err instanceof RetryableQwenStreamError);
  assert.equal(err.upstreamCode, "stream_aborted");
  assert.equal(err.forceNewChat, true);
  assert.equal(err.switchAccount, true);
  assert.equal(err.retryAfterMs, 2000);
});

test("parseSseErrorFromBuffer extracts first data error chunk", () => {
  const parsed = parseSseErrorFromBuffer(
    'data: {"error":{"code":"quota_limit","details":"alta demanda"}}\n\n',
  );
  assert.deepEqual(parsed, {
    code: "quota_limit",
    details: "alta demanda",
  });

  assert.equal(parseSseErrorFromBuffer("data: [DONE]\n\n"), null);
  assert.equal(
    parseSseErrorFromBuffer(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    ),
    null,
  );
});
