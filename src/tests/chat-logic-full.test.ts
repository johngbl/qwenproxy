import test from "node:test";
import assert from "node:assert";

// Set the environment BEFORE the module graph under test loads. Static ESM
// imports are hoisted above these assignments, so the project modules are
// imported dynamically below.
process.env.TEST_MOCK_QWEN_AUTH = "true";

const { config } = await import("../core/config.ts");
const {
  classifyRetryAction,
  isTerminalLocalError,
  isQuotaLikeError,
  throwFromSseUpstreamError,
  parseSseErrorFromBuffer,
  shouldRetryChatInProgressOnSameAccount,
  shouldRetryInvalidInputOnSameAccount,
} = await import("../routes/chat/retry-policy.ts");
const { parseQwenErrorPayload } = await import("../routes/chat/errors.ts");
const { buildFinalContext } = await import("../routes/chat/context.ts");
const { getIncrementalDelta } = await import("../routes/chat/helpers.ts");
const { classifyError } = await import("../api/error-classifier.ts");
const { createError, sendOpenAIError } = await import("../api/error-helpers.ts");
const {
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  UpstreamRateLimit,
  UpstreamError,
  UpstreamTimeout,
  InternalError,
  ServiceUnavailable,
} = await import("../core/errors.ts");
const {
  QwenNetworkError,
  QwenUpstreamUnavailableError,
  QwenUpstreamError,
  QwenSessionExpiredError,
  RetryableQwenStreamError,
} = await import("../services/qwen.ts");
const { ZodError } = await import("zod");

// ---------------------------------------------------------------------------
// retry-policy.ts — remaining branches
// ---------------------------------------------------------------------------

test("isTerminalLocalError treats proxy auth/validation failures as terminal", () => {
  assert.strictEqual(
    isTerminalLocalError(
      Object.assign(new Error("Invalid API key provided"), {
        code: "invalid_api_key",
      }),
    ),
    true,
  );
  assert.strictEqual(
    isTerminalLocalError(
      Object.assign(new Error("Authentication failed"), {
        code: "authentication_error",
      }),
    ),
    true,
  );
  assert.strictEqual(
    isTerminalLocalError(new Error("Missing or invalid Authorization header")),
    true,
  );
  assert.strictEqual(
    isTerminalLocalError(new Error("messages is required")),
    true,
  );
  assert.strictEqual(
    isTerminalLocalError(new Error("Provide at least one user message")),
    true,
  );
  assert.strictEqual(
    isTerminalLocalError(new Error("No Qwen accounts configured")),
    true,
  );
});

test("isTerminalLocalError distinguishes local bad_request from Qwen upstream bad_request", () => {
  const local = Object.assign(new Error("payload shape is wrong"), {
    code: "bad_request",
  });
  assert.strictEqual(isTerminalLocalError(local), true);

  const upstreamQwen = Object.assign(new Error("Qwen rejected the payload"), {
    code: "bad_request",
  });
  assert.strictEqual(isTerminalLocalError(upstreamQwen), false);

  const upstreamInvalidInput = Object.assign(
    new Error("invalid input for upstream"),
    { code: "bad_request" },
  );
  assert.strictEqual(isTerminalLocalError(upstreamInvalidInput), false);

  const upstreamPt = Object.assign(new Error("entrada ou anexo inválido"), {
    code: "bad_request",
  });
  assert.strictEqual(isTerminalLocalError(upstreamPt), false);
});

test("isQuotaLikeError accepts rate_limit_exceeded only with quota-like wording", () => {
  const quota = Object.assign(new Error("quota exhausted for today"), {
    code: "rate_limit_exceeded",
  });
  assert.strictEqual(isQuotaLikeError(quota), true);

  const rate = Object.assign(
    new Error("request rate increased too quickly"),
    { code: "rate_limit_exceeded" },
  );
  assert.strictEqual(isQuotaLikeError(rate), true);

  const demand = Object.assign(new Error("alta demanda no momento"), {
    code: "rate_limit_exceeded",
  });
  assert.strictEqual(isQuotaLikeError(demand), true);

  const unrelated = Object.assign(new Error("attachment rejected"), {
    code: "rate_limit_exceeded",
  });
  assert.strictEqual(isQuotaLikeError(unrelated), false);
});

test("classifyRetryAction rebuilds chat for corrupted history without switching account", () => {
  const action = classifyRetryAction(
    new Error("first message must not be assistant"),
  );
  assert.strictEqual(action.reason, "corrupted_chat_history");
  assert.strictEqual(action.retryable, true);
  assert.strictEqual(action.switchAccount, false);
  assert.strictEqual(action.forceNewChat, true);
  assert.strictEqual(action.retryWithFullPrompt, true);
  assert.strictEqual(action.retryAfterMs, 0);
});

test("classifyRetryAction stops on unknown errors when policy disabled", () => {
  const original = config.retry.onUnknownUpstream;
  config.retry.onUnknownUpstream = false;
  try {
    const action = classifyRetryAction(new Error("mysterious upstream failure"));
    assert.strictEqual(action.retryable, false);
    assert.strictEqual(action.switchAccount, false);
    assert.strictEqual(action.retryAfterMs, 0);
    assert.strictEqual(action.reason, "unknown_not_retryable");
  } finally {
    config.retry.onUnknownUpstream = original;
  }
});

// Note: the dedicated model-not-found early throw inside
// throwFromSseUpstreamError (retry-policy.ts lines ~729-739) is unreachable:
// it passes a plain object { upstreamCode, message } to isModelNotFoundError,
// but errMessage() stringifies plain objects to "[object Object]", so the
// message match can never succeed. The failure therefore flows through the
// generic toRetryableStreamError path, which still yields a non-switchable
// error because classifyRetryAction recognizes it as model_not_found.
test("throwFromSseUpstreamError keeps model-not-found non-switchable end to end", () => {
  try {
    throwFromSseUpstreamError("Not_Found", "Model not found: qwen-x");
    assert.fail("expected throwFromSseUpstreamError to throw");
  } catch (err) {
    assert.ok(err instanceof RetryableQwenStreamError);
    const typed = err as InstanceType<typeof RetryableQwenStreamError> & {
      upstreamCode?: string;
      switchAccount?: boolean;
    };
    assert.strictEqual(typed.upstreamCode, "Not_Found");
    assert.strictEqual(typed.switchAccount, false);
    assert.ok(typed.message.toLowerCase().includes("model not found"));

    const action = classifyRetryAction(err);
    assert.strictEqual(action.reason, "model_not_found");
    assert.strictEqual(action.retryable, false);
  }
});

test("throwFromSseUpstreamError maps WAF user-validate codes to retryable stream error", () => {
  try {
    throwFromSseUpstreamError(
      "FAIL_SYS_USER_VALIDATE",
      "FAIL_SYS_USER_VALIDATE: solve the challenge",
    );
    assert.fail("expected throwFromSseUpstreamError to throw");
  } catch (err) {
    assert.ok(err instanceof RetryableQwenStreamError);
    const typed = err as InstanceType<typeof RetryableQwenStreamError> & {
      upstreamCode?: string;
      switchAccount?: boolean;
    };
    assert.strictEqual(typed.upstreamCode, "FAIL_SYS_USER_VALIDATE");
    assert.strictEqual(typed.switchAccount, true);
    assert.ok(typed.message.includes("anti-bot"));
  }
});

test("parseSseErrorFromBuffer skips malformed, empty and DONE data lines", () => {
  const buffer = [
    "event: junk",
    "data: {not valid json",
    "data:",
    "data: [DONE]",
    'data: {"error":{"message":"boom"}}',
  ].join("\n");
  const parsed = parseSseErrorFromBuffer(buffer);
  assert.ok(parsed);
  assert.strictEqual(parsed!.code, "upstream_error");
  assert.strictEqual(parsed!.details, "boom");

  assert.strictEqual(parseSseErrorFromBuffer("nothing here"), null);
});

test("same-account retry helpers gate by reason and prior attempt", () => {
  assert.strictEqual(
    shouldRetryChatInProgressOnSameAccount("chat_in_progress", 0),
    true,
  );
  assert.strictEqual(
    shouldRetryChatInProgressOnSameAccount("chat_in_progress", 1),
    true,
  );
  assert.strictEqual(
    shouldRetryChatInProgressOnSameAccount("chat_in_progress", 2),
    false,
  );
  assert.strictEqual(
    shouldRetryChatInProgressOnSameAccount("chat_not_exist", 0),
    false,
  );
  assert.strictEqual(
    shouldRetryInvalidInputOnSameAccount("invalid_input", false),
    true,
  );
  assert.strictEqual(
    shouldRetryInvalidInputOnSameAccount("corrupted_chat_history", false),
    true,
  );
  assert.strictEqual(
    shouldRetryInvalidInputOnSameAccount("invalid_input", true),
    false,
  );
});

// ---------------------------------------------------------------------------
// routes/chat/errors.ts — parseQwenErrorPayload remaining branches
// ---------------------------------------------------------------------------

test("parseQwenErrorPayload parses payload.error documents", () => {
  const withObject = parseQwenErrorPayload(
    JSON.stringify({ error: { code: "Boom", details: "bad thing" } }),
  );
  assert.ok(withObject);
  assert.strictEqual(withObject!.code, "Boom");
  assert.strictEqual(withObject!.details, "bad thing");
  assert.strictEqual(withObject!.status, 502);

  const withString = parseQwenErrorPayload(
    JSON.stringify({ error: "plain failure", code: "X1" }),
  );
  assert.ok(withString);
  assert.strictEqual(withString!.code, "X1");
  assert.strictEqual(withString!.details, "plain failure");

  const withMessageOnly = parseQwenErrorPayload(
    JSON.stringify({ error: { message: "inner" } }),
  );
  assert.ok(withMessageOnly);
  assert.strictEqual(withMessageOnly!.code, "UpstreamError");
  assert.strictEqual(withMessageOnly!.details, "inner");

  const withObjectNoFields = parseQwenErrorPayload(
    JSON.stringify({ error: { weird: 1 } }),
  );
  assert.ok(withObjectNoFields);
  assert.strictEqual(withObjectNoFields!.details, JSON.stringify({ weird: 1 }));
});

test("parseQwenErrorPayload detects WAF challenges and generic non-SSE bodies", () => {
  const waf = parseQwenErrorPayload(
    "<html>aliyun_waf captcha Security Verification page</html>",
  );
  assert.ok(waf);
  assert.strictEqual(waf!.code, "waf_challenge");
  assert.ok(waf!.details.includes("anti-bot"));
  assert.strictEqual(waf!.status, 502);

  const plain = parseQwenErrorPayload("<html>maintenance</html>");
  assert.ok(plain);
  assert.strictEqual(plain!.code, "non_sse_response");

  assert.strictEqual(parseQwenErrorPayload(""), null);
  assert.strictEqual(parseQwenErrorPayload("data: {keep-alive}"), null);
  assert.strictEqual(parseQwenErrorPayload(JSON.stringify({ ok: true })), null);
});

test("parseQwenErrorPayload maps success:false with wait hint and statuses", () => {
  const rate = parseQwenErrorPayload(
    JSON.stringify({
      success: false,
      data: { code: "RateLimited", details: "quota gone", num: 3 },
    }),
  );
  assert.ok(rate);
  assert.strictEqual(rate!.status, 429);
  assert.ok(rate!.message.includes("Wait about 3 hour"));

  const notFound = parseQwenErrorPayload(
    JSON.stringify({ success: false, code: "Not_Found", message: "chat missing" }),
  );
  assert.ok(notFound);
  assert.strictEqual(notFound!.status, 404);
  assert.strictEqual(notFound!.details, "chat missing");
});

// ---------------------------------------------------------------------------
// routes/chat/context.ts — remaining branches
// ---------------------------------------------------------------------------

test("buildFinalContext skips personalization when instruction exceeds limit", async () => {
  const original = config.qwen.maxPersonalizationBytes;
  config.qwen.maxPersonalizationBytes = 10;
  try {
    const ctx = await buildFinalContext({
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "You are a helpful assistant.",
      toolInstructions: "",
      prompt: "User: hi\n\n",
      currentPrompt: "User: hi\n\n",
      modelId: "qwen3.7-plus",
      enableThinking: false,
      conversationKey: null,
      hasExplicitConversationKey: false,
    });
    assert.strictEqual(ctx.requestPersonalizationInstruction, null);
    // Instructions must still be sent inline for a brand-new chat.
    assert.ok(ctx.finalPrompt.includes("You are a helpful assistant."));
    assert.strictEqual(ctx.isTitleGenerationRequest, false);
  } finally {
    config.qwen.maxPersonalizationBytes = original;
  }
});

test("buildFinalContext detects title generation request with array content", async () => {
  const ctx = await buildFinalContext({
    messages: [
      { role: "user", content: "first question about coding" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Please generate a title for this conversation",
          },
        ] as any,
      },
    ],
    systemPrompt: "",
    toolInstructions: "",
    prompt: "User: first question about coding",
    currentPrompt: "User: Please generate a title",
    modelId: "qwen3.7-plus",
    enableThinking: true,
    conversationKey: "key-1",
    hasExplicitConversationKey: true,
  });
  assert.strictEqual(ctx.isTitleGenerationRequest, true);
  // Title generation never rides the personalization path.
  assert.strictEqual(ctx.requestPersonalizationInstruction, null);
  assert.strictEqual(ctx.isThinkingModel, true);
});

test("buildFinalContext title detection stringifies object content", async () => {
  const ctx = await buildFinalContext({
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: { topic: "conversation title request" } as any },
    ],
    systemPrompt: "",
    toolInstructions: "",
    prompt: "User: hi",
    currentPrompt: "User: hi",
    modelId: "qwen3.7-plus",
    enableThinking: false,
    conversationKey: null,
    hasExplicitConversationKey: false,
  });
  assert.strictEqual(ctx.isTitleGenerationRequest, true);
});

// ---------------------------------------------------------------------------
// routes/chat/helpers.ts — startsWith fallback in getIncrementalDelta
// ---------------------------------------------------------------------------

test("getIncrementalDelta falls back to startsWith when suffix check fails", () => {
  const result = getIncrementalDelta("abc", "abcde", 3, "zzz");
  assert.strictEqual(result.delta, "de");
  assert.strictEqual(result.matchedContent, "abcde");
  assert.strictEqual(result.contentLength, 5);
  assert.strictEqual(result.contentSuffix, "abcde");

  const zeroLength = getIncrementalDelta("abc", "abcX", 0, "");
  assert.strictEqual(zeroLength.delta, "X");
});

// ---------------------------------------------------------------------------
// api/error-classifier.ts — remaining branches
// ---------------------------------------------------------------------------

test("classifyError maps network and unavailable errors to UpstreamError", () => {
  const network = classifyError(new QwenNetworkError("net down"));
  assert.ok(network instanceof UpstreamError);
  assert.strictEqual(network.statusCode, 502);

  const unavailable = classifyError(
    new QwenUpstreamUnavailableError("unavailable", 503),
  );
  assert.ok(unavailable instanceof UpstreamError);
});

test("classifyError splits RetryableQwenStreamError into rate limit vs upstream", () => {
  const quota = new RetryableQwenStreamError("quota exceeded", 100);
  quota.upstreamCode = "quota_limit";
  assert.ok(classifyError(quota) instanceof UpstreamRateLimit);

  const busy = new RetryableQwenStreamError("the chat is busy", 100);
  busy.upstreamCode = "chat_in_progress";
  assert.ok(classifyError(busy) instanceof UpstreamError);
});

test("classifyError passes through known QwenBridgeError instances", () => {
  const upstream = new QwenUpstreamError("boom", "BadGateway", 502);
  assert.strictEqual(classifyError(upstream), upstream);

  const expired = new QwenSessionExpiredError("expired", "acc-1");
  assert.strictEqual(classifyError(expired), expired);

  const timeout = new UpstreamTimeout("slow");
  assert.strictEqual(classifyError(timeout), timeout);
});

test("classifyError maps account_busy and zod errors", () => {
  const busy = Object.assign(
    new Error("busy: timed out waiting for a free slot"),
    { code: "account_busy" },
  );
  assert.ok(classifyError(busy) instanceof UpstreamRateLimit);

  assert.ok(classifyError(new ZodError([])) instanceof ValidationError);
});

test("classifyError falls back to InternalError for unknown errors", () => {
  const classified = classifyError({ weird: true });
  assert.ok(classified instanceof InternalError);
  assert.strictEqual(classified.statusCode, 500);

  const fromString = classifyError("boom");
  assert.ok(fromString instanceof InternalError);
  assert.ok(fromString.message.includes("boom"));
});

// ---------------------------------------------------------------------------
// api/error-helpers.ts — createError / sendOpenAIError
// ---------------------------------------------------------------------------

test("createError builds typed errors for every supported status", () => {
  const cases: Array<[number, new (message: string) => Error]> = [
    [400, ValidationError],
    [401, AuthError],
    [403, ForbiddenError],
    [404, NotFoundError],
    [429, UpstreamRateLimit],
    [500, InternalError],
    [502, UpstreamError],
    [503, ServiceUnavailable],
    [504, UpstreamTimeout],
  ];
  for (const [status, ctor] of cases) {
    const err = createError(status as any, `msg ${status}`, "param-x");
    assert.ok(err instanceof ctor, `status ${status}`);
    assert.strictEqual(err.statusCode, status);
    assert.strictEqual(err.param, "param-x");
  }
});

function fakeContext() {
  const calls: Array<{ body: unknown; status?: number }> = [];
  const c = {
    json: (body: unknown, status?: number) => {
      calls.push({ body, status });
      return { body, status };
    },
  } as any;
  return { c, calls };
}

test("sendOpenAIError serializes QwenBridgeError directly", () => {
  const { c, calls } = fakeContext();
  sendOpenAIError(c, new ValidationError("bad input"));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].status, 400);
  const body = calls[0].body as any;
  assert.strictEqual(body.error.message, "bad input");
  assert.strictEqual(body.error.type, "invalid_request_error");
  assert.strictEqual(body.error.code, "bad_request");
  assert.strictEqual(body.error.param, null);
});

test("sendOpenAIError honors upstreamStatus hints and fallbacks", () => {
  const { c, calls } = fakeContext();

  sendOpenAIError(c, Object.assign(new Error("missing chat"), { upstreamStatus: 404 }));
  assert.strictEqual(calls[0].status, 404);

  // Invalid hint falls back to the provided status.
  sendOpenAIError(c, Object.assign(new Error("odd"), { upstreamStatus: 999 }), 503);
  assert.strictEqual(calls[1].status, 503);

  // No hint, no fallback: classifier decides (InternalError -> 500).
  sendOpenAIError(c, "plain string failure");
  assert.strictEqual(calls[2].status, 500);

  // Non-Error value with a valid hint uses String(err) as message.
  sendOpenAIError(c, { upstreamStatus: 429 });
  assert.strictEqual(calls[3].status, 429);
});
