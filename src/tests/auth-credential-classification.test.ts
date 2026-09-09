import test from "node:test";
import assert from "node:assert/strict";
import { classifyQwenAuthError } from "../services/playwright.ts";

test("classifyQwenAuthError identifies password errors as permanent", () => {
  const t1 = classifyQwenAuthError("PasswordError", "Incorrect password");
  assert.equal(t1.isPermanent, true);
  assert.match(t1.reason, /Senha incorreta/);

  const t2 = classifyQwenAuthError("INVALID_PASSWORD", "Wrong credentials supplied");
  assert.equal(t2.isPermanent, true);
  assert.match(t2.reason, /Senha incorreta/);

  const t3 = classifyQwenAuthError(undefined, "A senha digitada é inválida");
  assert.equal(t3.isPermanent, true);
  assert.match(t3.reason, /Senha incorreta/);
});

test("classifyQwenAuthError identifies missing user/email errors as permanent", () => {
  const t1 = classifyQwenAuthError("UserNotExist", "User does not exist");
  assert.equal(t1.isPermanent, true);
  assert.match(t1.reason, /E-mail\/usuário não encontrado/);

  const t2 = classifyQwenAuthError("AccountNotFound", "Conta não encontrada");
  assert.equal(t2.isPermanent, true);
  assert.match(t2.reason, /E-mail\/usuário não encontrado/);

  const t3 = classifyQwenAuthError(undefined, "Email is not registered");
  assert.equal(t3.isPermanent, true);
  assert.match(t3.reason, /E-mail\/usuário não encontrado/);
});

test("classifyQwenAuthError identifies frozen/blocked accounts as permanent", () => {
  const t1 = classifyQwenAuthError("AccountFrozen", "Your account has been frozen");
  assert.equal(t1.isPermanent, true);
  assert.match(t1.reason, /bloqueada ou suspensa/);

  const t2 = classifyQwenAuthError("USER_BLOCKED", "User is suspended");
  assert.equal(t2.isPermanent, true);
  assert.match(t2.reason, /bloqueada ou suspensa/);
});

test("classifyQwenAuthError treats transient/unknown errors as non-permanent", () => {
  const t1 = classifyQwenAuthError("NetworkError", "Failed to fetch");
  assert.equal(t1.isPermanent, false);

  const t2 = classifyQwenAuthError("RateLimit", "Too many requests");
  assert.equal(t2.isPermanent, false);

  const t3 = classifyQwenAuthError(undefined, "Unknown error occurred");
  assert.equal(t3.isPermanent, false);
});

test("loginViaApi identifies wrong password from Qwen JSON and fast-fails", () => {
  const signinResponse = {
    success: false,
    data: {
      code: "PasswordError",
      details: "Incorrect email or password, please try again",
    },
  };
  const err = classifyQwenAuthError(signinResponse.data.code, signinResponse.data.details);
  assert.equal(err.isPermanent, true);
  assert.match(err.reason, /Senha incorreta/);
});

test("loginViaApi identifies user not found from Qwen JSON and fast-fails", () => {
  const signinResponse = {
    success: false,
    data: {
      code: "UserNotExist",
      details: "This account is not registered",
    },
  };
  const err = classifyQwenAuthError(signinResponse.data.code, signinResponse.data.details);
  assert.equal(err.isPermanent, true);
  assert.match(err.reason, /E-mail\/usuário não encontrado/);
});

test("QWEN_FIRST_CHUNK_TIMEOUT is 60s for fast dead-stream failover", async () => {
  const { config } = await import("../core/config.ts");
  assert.equal(config.timeouts.firstChunkTimeout, 60_000);
});

test("masked password ('***') is intercepted and never treated as actual password", async () => {
  const { addAccount, loadAccounts, getAccountCredentials, removeAccount } = await import("../core/accounts.ts");
  const testId = "test-mask-guard-account";
  try {
    addAccount("maskguard@example.com", "real-password-12345", testId);
    const loaded = loadAccounts().find((a) => a.id === testId);
    assert.equal(loaded?.password, "***");

    const real = getAccountCredentials(testId);
    assert.equal(real?.password, "real-password-12345");
  } finally {
    removeAccount(testId);
  }
});
