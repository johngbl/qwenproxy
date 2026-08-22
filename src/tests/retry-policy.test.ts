import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import {
  classifyRetryAction,
  isTerminalLocalError,
  shouldRetryChatInProgressOnSameAccount,
  shouldRetryInvalidInputOnSameAccount,
  throwFromSseUpstreamError,
  toRetryableStreamError,
} from "../routes/chat/retry-policy.ts";
import {
  getQwenErrorCode,
  QwenNetworkError,
  QwenUpstreamError,
  RetryableQwenStreamError,
} from "../services/qwen.ts";
import { classifyError } from "../api/error-classifier.ts";
import {
  ValidationError,
  AuthError,
  ContextLengthExceededError,
  ClientAbortedError,
} from "../core/errors.ts";
import { parseQwenErrorPayload } from "../routes/chat/errors.ts";

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

test("classifyRetryAction: context length is terminal and does not rotate accounts", () => {
  const err = new ContextLengthExceededError("Input is too large");
  const action = classifyRetryAction(err);

  assert.equal(action.retryable, false);
  assert.equal(action.switchAccount, false);
  assert.equal(action.reason, "terminal_local");
});

test("classifyRetryAction: aborted request is not retried", () => {
  const action = classifyRetryAction(new Error("Aborted before acquiring account lease"), {
    requestAborted: true,
  });

  assert.equal(action.retryable, false);
  assert.equal(action.switchAccount, false);
  assert.equal(action.reason, "client_abort");
});

test("classifyRetryAction: failed account initialization cools and rotates", () => {
  const action = classifyRetryAction(
    new Error("Header capture returned incomplete anti-fraud headers for account"),
  );

  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
  assert.equal(action.forceNewChat, false);
  assert.equal(action.accountCooldownReason, "AuthInitFailed");
  assert.ok(action.accountCooldownMs! >= 30_000);
  assert.equal(action.reason, "account_initialization_failed");
});

test("classifyRetryAction: account lease timeout is retryable without rebuilding chat", () => {
  const action = classifyRetryAction(
    new Error("Account abc busy: timed out after 30000ms waiting for a free slot"),
  );

  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
  assert.equal(action.forceNewChat, false);
  assert.equal(action.retryWithFullPrompt, false);
  assert.equal(action.reason, "account_busy");
});

test("classifyRetryAction: stuck Playwright page is account initialization failure", () => {
  const action = classifyRetryAction(
    new Error(
      "Playwright page operation timed out for account abc after 120000ms",
    ),
  );

  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
  assert.equal(action.forceNewChat, false);
  assert.equal(action.accountCooldownReason, "AuthInitFailed");
  assert.equal(action.reason, "account_initialization_failed");
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

test("invalid_input retries a clean chat once before account rotation", () => {
  assert.equal(
    shouldRetryInvalidInputOnSameAccount("invalid_input", false),
    true,
  );
  assert.equal(
    shouldRetryInvalidInputOnSameAccount("invalid_input", true),
    false,
  );
  assert.equal(
    shouldRetryInvalidInputOnSameAccount("anti_bot", false),
    false,
  );
});

test("chat_in_progress allows three same-account retries before rotating", () => {
  assert.equal(
    shouldRetryChatInProgressOnSameAccount("chat_in_progress", 0),
    true,
  );
  assert.equal(
    shouldRetryChatInProgressOnSameAccount("chat_in_progress", 1),
    true,
  );
  assert.equal(
    shouldRetryChatInProgressOnSameAccount("chat_in_progress", 2),
    true,
  );
  assert.equal(
    shouldRetryChatInProgressOnSameAccount("chat_in_progress", 3),
    false,
  );
  assert.equal(
    shouldRetryChatInProgressOnSameAccount("quota_or_rate_limit", 0),
    false,
  );
});

test("classifyRetryAction: temporary quota (alta demanda) retries same account", () => {
  const err = Object.assign(
    new Error("quota_limit: O serviço está com alta demanda no momento."),
    { upstreamCode: "quota_limit", upstreamStatus: 502 },
  );
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, false);
  assert.equal(action.accountCooldownReason, "RateLimitTemporary");
  assert.equal(action.reason, "quota_or_rate_limit");
});

test("classifyRetryAction: real quota exhaustion prefers account switch", () => {
  const err = Object.assign(
    new Error("RateLimited: You've reached the upper limit for today's usage."),
    { upstreamCode: "RateLimited", upstreamStatus: 429 },
  );
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
  assert.equal(action.reason, "quota_or_rate_limit");
});

test("classifyRetryAction: WAF challenges retry the same account immediately", () => {
  const err = Object.assign(
    new Error("Qwen returned an anti-bot challenge instead of an SSE response."),
    { upstreamCode: "waf_challenge" },
  );
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, false);
  assert.equal(action.retryAfterMs, 0);
  assert.equal(action.accountCooldownMs, undefined);
  assert.equal(action.accountCooldownReason, undefined);
  assert.equal(action.reason, "anti_bot");
});

test("classifyRetryAction: Not_Found model not found is terminal (no retry)", () => {
  const err = Object.assign(
    new Error("Qwen upstream error: Not_Found: Model not found."),
    { upstreamCode: "Not_Found", upstreamStatus: 404 },
  );
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, false);
  assert.equal(action.switchAccount, false);
  assert.equal(action.forceNewChat, false);
  assert.equal(action.reason, "model_not_found");
});

test("classifyRetryAction: generic Qwen 404 for missing chat remains retryable", () => {
  const err = Object.assign(
    new Error("Qwen upstream error: Not_Found: chat is not exist."),
    { upstreamCode: "Not_Found", upstreamStatus: 404 },
  );
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.reason, "chat_not_exist");
});

test("parseQwenErrorPayload sanitizes an HTML WAF page", () => {
  const parsed = parseQwenErrorPayload(
    '<!doctype html><meta name="aliyun_waf_aa" content="do-not-expose-this-page">',
  );

  assert.deepEqual(parsed, {
    code: "waf_challenge",
    details: "Qwen returned an anti-bot challenge instead of an SSE response.",
    message:
      "Qwen upstream error: Qwen returned an anti-bot challenge instead of an SSE response.",
    status: 502,
  });
  assert.doesNotMatch(parsed!.message, /aliyun_waf|do-not-expose-this-page/i);
});

test("classifyRetryAction: network / abort / upstream error classes retry with switch", () => {
  const network = classifyRetryAction(new QwenNetworkError("fetch failed"));
  assert.equal(network.retryable, true);
  assert.equal(network.switchAccount, true);

  const browserNetwork = classifyRetryAction(new Error("network error"));
  assert.equal(browserNetwork.retryable, true);
  assert.equal(browserNetwork.switchAccount, true);
  assert.equal(browserNetwork.reason, "network");
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

test("classifyRetryAction: superseded request (client aborted) is silent, not retried", () => {
  // A same-session retry superseded this request's stream DURING creation.
  // createQwenStreamInternal throws "client aborted before completion request"
  // as a plain Error — the supersede aborted the lease signal, NOT the client's
  // own request signal. This must NOT spin a full-context retry on another
  // account (that produced the 597s stall): the newer request owns the session.
  const superseded = new Error("client aborted before completion request");
  const action = classifyRetryAction(superseded);
  assert.equal(action.retryable, false);
  assert.equal(action.switchAccount, false);
  assert.equal(action.forceNewChat, false);
  assert.equal(action.reason, "client_abort");

  // The ClientAbortedError variants thrown by tryCreateStreamWithRetry must
  // classify identically even without the requestAborted flag.
  const variant = classifyRetryAction(
    new ClientAbortedError("client aborted during stream creation"),
  );
  assert.equal(variant.retryable, false);
  assert.equal(variant.switchAccount, false);
  assert.equal(variant.reason, "client_abort");
});

test("classifyRetryAction: bare AbortError (idle/upstream) stays retryable", () => {
  // Regression guard: only OUR "client aborted" markers are silent. A bare
  // AbortError mid-stream is an idle/upstream timeout and must keep retrying.
  const abort = Object.assign(new Error("This operation was aborted"), {
    name: "AbortError",
  });
  const action = classifyRetryAction(abort);
  assert.equal(action.retryable, true);
  assert.equal(action.reason, "stream_aborted");
});

test("error classification keeps network and chat state out of rate limits", () => {
  const network = new QwenNetworkError("network error");
  assert.equal(getQwenErrorCode(network), "network_error");
  const networkResult = classifyError(network);
  assert.equal(networkResult.statusCode, 502);
  assert.equal(networkResult.code, "upstream_unavailable");

  const chatInProgress = new RetryableQwenStreamError(
    "Qwen: The chat is in progress!",
    2000,
  );
  chatInProgress.upstreamCode = "chat_in_progress";
  assert.equal(getQwenErrorCode(chatInProgress), "chat_in_progress");
  const chatResult = classifyError(chatInProgress);
  assert.equal(chatResult.statusCode, 502);
  assert.equal(chatResult.code, "upstream_unavailable");
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
        "RateLimited",
        "Qwen: The chat is in progress!",
      ),
    (err: unknown) => {
      assert.ok(err instanceof RetryableQwenStreamError);
      assert.equal(
        (err as RetryableQwenStreamError).upstreamCode,
        "chat_in_progress",
      );
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

test("classifyRetryAction: content moderation (data_inspection_failed) is not retryable", () => {
  // Simulates the error thrown by throwFromSseUpstreamError for content moderation
  const err = Object.assign(
    new RetryableQwenStreamError(
      "Qwen content moderation: data_inspection_failed: Aviso de segurança do conteúdo",
      0,
    ),
    { upstreamCode: "data_inspection_failed", switchAccount: false },
  );
  const action = classifyRetryAction(err);

  assert.equal(action.retryable, false);
  assert.equal(action.switchAccount, false);
  assert.equal(action.forceNewChat, false);
  assert.equal(action.retryWithFullPrompt, false);
  assert.equal(action.reason, "content_moderation");
});

test("classifyError: content moderation maps to ValidationError with content_policy_violation", () => {
  const err = Object.assign(
    new RetryableQwenStreamError(
      "Qwen content moderation: data_inspection_failed: Aviso de segurança do conteúdo: os dados inseridos podem conter conteúdo inadequado!",
      0,
    ),
    { upstreamCode: "data_inspection_failed" },
  );
  const classified = classifyError(err);

  assert.equal(classified.statusCode, 400);
  assert.equal((classified as any).code, "content_policy_violation");
  assert.ok(classified.message.includes("Content rejected by Qwen safety filter"));
  assert.ok(!classified.message.includes("data_inspection_failed"));
});

test("throwFromSseUpstreamError: data_inspection_failed throws non-retryable moderation error", () => {
  assert.throws(
    () =>
      throwFromSseUpstreamError(
        "data_inspection_failed",
        "Aviso de segurança do conteúdo: os dados inseridos podem conter conteúdo inadequado!",
      ),
    (err: unknown) => {
      const e = err as RetryableQwenStreamError & { switchAccount?: boolean };
      assert.ok(e instanceof RetryableQwenStreamError);
      assert.ok(e.message.includes("content moderation"));
      assert.equal(e.upstreamCode, "data_inspection_failed");
      assert.equal(e.switchAccount, false);
      // Verify classifyRetryAction marks it non-retryable
      const action = classifyRetryAction(e);
      assert.equal(action.retryable, false);
      assert.equal(action.reason, "content_moderation");
      return true;
    },
  );
});
