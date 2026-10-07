process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.NODE_TEST_CONTEXT = "true";

import test from "node:test";
import assert from "node:assert/strict";
import {
  startEmailOtpLogin,
  verifyEmailOtpLogin,
  cancelEmailOtpLogin,
} from "../services/playwright.ts";
import { listAccounts, getAccountCredentials, removeAccount } from "../core/accounts.ts";
import { AccountsView } from "../tui/views/accounts-view.ts";
import { stripAnsi } from "../tui/theme.ts";

test("OTP Login: startEmailOtpLogin rejects invalid email format", async () => {
  const res = await startEmailOtpLogin("invalid-email");
  assert.equal(res.success, false);
  assert.equal(res.error, "Formato de e-mail inválido");
});

test("OTP Login: startEmailOtpLogin rejects already registered email", async () => {
  const existing = listAccounts();
  if (existing.length > 0) {
    const res = await startEmailOtpLogin(existing[0].email);
    assert.equal(res.success, false);
    assert.ok(res.error?.includes("já está cadastrada"));
  }
});

test("OTP Login: mock mode starts session and returns sessionId", async () => {
  const testEmail = "new-user-otp-" + Date.now() + "@example.com";
  const startRes = await startEmailOtpLogin(testEmail);
  assert.equal(startRes.success, true);
  assert.ok(typeof startRes.sessionId === "string");
  assert.ok(startRes.sessionId.startsWith("mock-otp-"));

  // Verify wrong code fails
  const failVerify = await verifyEmailOtpLogin(startRes.sessionId, "000000");
  assert.equal(failVerify.success, false);
  assert.equal(failVerify.error, "Código de verificação incorreto ou expirado");

  // Verify correct code succeeds and registers account with passwordless credentials
  const okVerify = await verifyEmailOtpLogin(startRes.sessionId, "123456");
  assert.equal(okVerify.success, true);
  assert.ok(okVerify.account);
  assert.equal(okVerify.account.email, testEmail);
  assert.equal(okVerify.account.password, "");

  // Cleanup created test account
  if (okVerify.account.id) {
    removeAccount(okVerify.account.id);
  }
});

test("OTP Login: cancelEmailOtpLogin cleans up active session", async () => {
  const testEmail = "cancel-test-" + Date.now() + "@example.com";
  const startRes = await startEmailOtpLogin(testEmail);
  assert.equal(startRes.success, true);
  await cancelEmailOtpLogin(startRes.sessionId!);

  // Trying to verify cancelled session should fail
  const verifyRes = await verifyEmailOtpLogin(startRes.sessionId!, "123456");
  assert.equal(verifyRes.success, false);
});

test("TUI AccountsView: Add Modal switches between password and OTP modes via Tab", async () => {
  const view = new AccountsView();

  // Open modal with 'a'
  await view.handleKey({ name: "a", ctrl: false, shift: false, meta: false });
  let render = stripAnsi(view.render(80, 20).join("\n"));
  assert.ok(render.includes("Adicionar Nova Conta Qwen"));
  assert.ok(render.includes("E-mail:"));
  assert.ok(render.includes("Senha:"));
  assert.ok(render.includes("Tab: Sem Senha/OTP") || render.includes("Sem Senha"));

  // Switch to OTP mode via Tab
  await view.handleKey({ name: "tab", ctrl: false, shift: false, meta: false });
  render = stripAnsi(view.render(80, 20).join("\n"));
  assert.ok(render.includes("OTP"));
  assert.ok(render.includes("E-mail:"));
  assert.ok(render.includes("Código:"));
  assert.ok(render.includes("Enviar Código"));

  // Switch back to password mode via Tab
  await view.handleKey({ name: "tab", ctrl: false, shift: false, meta: false });
  render = stripAnsi(view.render(80, 20).join("\n"));
  assert.ok(render.includes("Senha:"));

  // Cancel with Escape
  await view.handleKey({ name: "escape", ctrl: false, shift: false, meta: false });
  render = stripAnsi(view.render(80, 20).join("\n"));
  assert.ok(!render.includes("Adicionar Nova Conta Qwen"));
});

test("TUI AccountsView: Completes full OTP login flow in TUI modal", async () => {
  const view = new AccountsView();
  const testEmail = "tui-otp-" + Date.now() + "@example.com";

  // Open modal
  await view.handleKey({ name: "a", ctrl: false, shift: false, meta: false });

  // Switch to OTP mode
  await view.handleKey({ name: "tab", ctrl: false, shift: false, meta: false });

  // Type email
  for (const ch of testEmail) {
    await view.handleKey({ name: ch, ctrl: false, shift: false, meta: false, char: ch });
  }

  // Press Enter to send code
  await view.handleKey({ name: "return", ctrl: false, shift: false, meta: false });
  let render = stripAnsi(view.render(80, 20).join("\n"));
  assert.ok(render.includes("Código Enviado") || render.includes("Confirmar Código"));
  assert.ok(render.includes("Confirmar Código"));

  // Type 6-digit code: "872643"
  for (const ch of "872643") {
    await view.handleKey({ name: ch, ctrl: false, shift: false, meta: false, char: ch });
  }

  // Press Enter to confirm and add account
  await view.handleKey({ name: "return", ctrl: false, shift: false, meta: false });

  // Modal should be closed and account saved
  render = stripAnsi(view.render(80, 20).join("\n"));
  assert.ok(!render.includes("Adicionar Nova Conta Qwen"));

  const allAccounts = listAccounts();
  const found = allAccounts.find((a) => a.email === testEmail);
  assert.ok(found);
  const creds = getAccountCredentials(found.id);
  assert.ok(creds);
  assert.equal(creds.password, "");

  // Cleanup
  removeAccount(found.id);
});
