import test from "node:test";
import assert from "node:assert/strict";
import { isOverloadMessage, OVERLOAD_COOLDOWN_MS } from "../utils/overload-detector.ts";
import { isOverloadError, classifyRetryAction } from "../routes/chat/retry-policy.ts";

test("overload-detector: detects English overload phrases", () => {
  assert.equal(isOverloadMessage("We are experiencing high demand right now."), true);
  assert.equal(isOverloadMessage("There is a problem connecting to the service. Please try again later."), true);
  assert.equal(isOverloadMessage("The server is busy, please try again."), true);
  assert.equal(isOverloadMessage("Service is temporarily unavailable."), true);
  assert.equal(isOverloadMessage("Too many requests, please wait."), true);
  assert.equal(isOverloadMessage("Unable to connect to service. Try again later."), true);
});

test("overload-detector: detects Portuguese overload phrases", () => {
  assert.equal(isOverloadMessage("Estamos com alta demanda no momento. Tente novamente mais tarde."), true);
  assert.equal(isOverloadMessage("O serviço está com alta demanda no momento."), true);
  assert.equal(isOverloadMessage("Houve um problema de conexão. Tente novamente mais tarde."), true);
  assert.equal(isOverloadMessage("Servidor ocupado, tente novamente mais tarde."), true);
  assert.equal(isOverloadMessage("Serviço indisponível no momento."), true);
});

test("overload-detector: does not flag normal coding responses", () => {
  assert.equal(isOverloadMessage("Aqui está a solução para o seu problema."), false);
  assert.equal(isOverloadMessage("The code connects to the database using a connection pool."), false);
  assert.equal(isOverloadMessage("```typescript\nfunction retry() { console.log('retry'); }\n```"), false);
  assert.equal(isOverloadMessage("<tool_call>{\"name\": \"read_file\", \"arguments\": {}}</tool_call>"), false);
  assert.equal(isOverloadMessage(""), false);
  assert.equal(isOverloadMessage(null), false);
  assert.equal(isOverloadMessage(undefined), false);
});

test("overload-detector: rejects long content (> 500 chars)", () => {
  const longText = "Estamos com alta demanda no momento. ".repeat(30);
  assert.equal(isOverloadMessage(longText), false);
});

test("retry-policy: isOverloadError detects overload errors and classifies action", () => {
  const err = Object.assign(
    new Error("Estamos com alta demanda no momento. Tente novamente mais tarde."),
    { upstreamCode: "server_overloaded" },
  );
  assert.equal(isOverloadError(err), true);

  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
  assert.equal(action.forceNewChat, true);
  assert.equal(action.reason, "server_busy");
  assert.equal(action.accountCooldownMs, OVERLOAD_COOLDOWN_MS);
  assert.equal(action.accountCooldownReason, "ServerOverloaded");
});
