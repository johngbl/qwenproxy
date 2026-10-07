/**
 * QwenProxy TUI - Accounts & Cooldowns Management View (Tab 5)
 */

import crypto from "crypto";
import type { TuiView, ProxyStatusSnapshot } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, pad, truncate, getClipboardText } from "../theme.ts";
import {
  fetchProxyStatus,
  resetAllCooldowns,
  resetAccountCooldownById,
} from "../proxy-client.ts";
import {
  addAccount,
  removeAccount,
  parseBatchAccounts,
  addAccountsBatch,
} from "../../core/accounts.ts";
import { ServerManager } from "../server-manager.ts";
import { config } from "../../core/config.ts";
import { renderProgressBar } from "./status-view.ts";
export function formatCooldownReason(reason?: string | null, maxLen = 28): string {
  if (!reason) return theme.yellow("Cooldown ativo");
  if (
    reason.startsWith("AuthFailed") ||
    reason.startsWith("AuthPermanentFailure") ||
    reason.includes("All login methods exhausted")
  ) {
    return theme.red(truncate("❌ Senha/Login inválido", maxLen));
  }
  if (reason === "AuthInitFailed") {
    return theme.yellow(truncate("⚠️ Timeout Inicial (WAF/Headers)", maxLen));
  }
  if (reason === "RateLimited" || reason === "QuotaExceeded") {
    return theme.yellow(truncate("⏳ Cota Excedida (Reset 00:00 UTC)", maxLen));
  }
  if (reason === "WafChallenge") {
    return theme.peach(truncate("🛡️ Bloqueio WAF/Anti-Bot", maxLen));
  }
  if (reason.startsWith("StandbyValidationError")) {
    return theme.red(truncate("❌ Falha Validação Standby", maxLen));
  }
  if (reason === "MediaGenFailed") {
    return theme.yellow(truncate("⚠️ Falha Geração de Mídia", maxLen));
  }
  return theme.yellow(truncate(reason, maxLen));
}

export class AccountsView implements TuiView {
  public readonly id = "accounts";
  public readonly title = "Contas";
  public readonly tabNumber = 5;

  private statusData: ProxyStatusSnapshot | null = null;
  private selectedIndex = 0;
  private statusMessage = "";
  private statusMessageTimer: NodeJS.Timeout | null = null;
  private isAddModalOpen = false;
  private isBatchModalOpen = false;
  private isValidatingAccount = false;
  private isOtpRequesting = false;
  private isOtpCodeSent = false;
  private addLoginMode: "password" | "otp" = "password";
  private otpSessionId: string | null = null;
  private addEmailInput = "";
  private addPasswordInput = "";
  private addOtpCodeInput = "";
  private addEmailCursor = 0;
  private addPasswordCursor = 0;
  private addOtpCodeCursor = 0;
  private addActiveField: "email" | "password" | "code" = "email";
  private batchInput = "";
  private batchCursor = 0;
  private batchHoveredButton: "import" | "cancel" | null = null;
  private batchActiveButton: "import" | "cancel" | null = null;
  private lastBatchModalLeftPad = 0;
  private lastBatchModalStartRow = 4;
  private hoveredActionRow: number | null = null;
  private hoveredAccountIndex: number | null = null;
  private modalHoveredField: "email" | "password" | "code" | "save" | "cancel" | "mode" | null = null;
  private lastModalLeftPad = 0;
  private lastLeftW = 46;
  private accountsScrollOffset = 0;
  private confirmDialog: {
    type: "remove_account" | "delete_account_chats" | "delete_all_chats";
    title: string;
    message: string;
    detail: string;
    onConfirm: () => Promise<void>;
  } | null = null;
  private confirmDialogHovered: "confirm" | "cancel" | null = null;
  private lastConfirmModalLeftPad = 0;
  private lastConfirmModalStartRow = 0;
  constructor() {
    if (!process.env.NODE_TEST_CONTEXT) {
      void this.refresh();
    }
  }

  public onActivate(): void {
    this.refresh();
  }

  public isCapturingText(): boolean {
    return this.isAddModalOpen || this.isBatchModalOpen || this.confirmDialog !== null;
  }
  public getShortcuts(): Array<{ key: string; label: string }> {
    if (this.confirmDialog) {
      return [
        { key: "S / Enter", label: "Confirmar" },
        { key: "N / Esc", label: "Cancelar" },
      ];
    }
    if (this.isBatchModalOpen) {
      return [
        { key: "Enter", label: "Importar" },
        { key: "Ctrl+V", label: "Colar Lote" },
        { key: "Esc", label: "Cancelar" },
      ];
    }
    if (this.isAddModalOpen) {
      return [
        { key: "↑↓/Mouse", label: "Alternar" },
        { key: "Enter", label: "Salvar" },
        { key: "Esc", label: "Cancelar" },
      ];
    }
    return [
      { key: "a", label: "Adicionar Conta" },
      { key: "b", label: "Importar em Lote" },
      { key: "d", label: "Remover Conta" },
      { key: "x", label: "Limpar Chats" },
      { key: "l", label: "Limpar Todos Chats" },
      { key: "c", label: "Zerar Cooldown" },
      { key: "z", label: "Zerar Todas" },
    ];
  }

  public async refresh(): Promise<void> {
    try {
      this.statusData = await fetchProxyStatus();
      const count = this.statusData.accounts.length;
      if (this.selectedIndex >= count && count > 0) {
        this.selectedIndex = count - 1;
      }
    } catch {}
  }

  private setStatusMessage(msg: string): void {
    this.statusMessage = msg;
    clearTimeout(this.statusMessageTimer!);
    this.statusMessageTimer = setTimeout(() => {
      this.statusMessage = "";
    }, 4000);
  }

  private resetAddModalState(): void {
    if (this.otpSessionId && !process.env.NODE_TEST_CONTEXT) {
      const sid = this.otpSessionId;
      import("../../services/playwright.ts")
        .then(({ cancelEmailOtpLogin }) => cancelEmailOtpLogin(sid))
        .catch(() => {});
    }
    this.isAddModalOpen = false;
    this.isValidatingAccount = false;
    this.isOtpRequesting = false;
    this.isOtpCodeSent = false;
    this.otpSessionId = null;
    this.addEmailInput = "";
    this.addPasswordInput = "";
    this.addOtpCodeInput = "";
    this.addEmailCursor = 0;
    this.addPasswordCursor = 0;
    this.addOtpCodeCursor = 0;
    this.addActiveField = "email";
    this.addLoginMode = "password";
  }

  private async saveModalAccount(): Promise<void> {
    if (this.isValidatingAccount || this.isOtpRequesting) return;
    const email = this.addEmailInput.trim();
    if (!email) {
      this.setStatusMessage(theme.yellow("[!] E-mail é obrigatório"));
      return;
    }

    if (this.addLoginMode === "otp") {
      if (!this.isOtpCodeSent) {
        if (process.env.NODE_TEST_CONTEXT) {
          this.isOtpCodeSent = true;
          this.addActiveField = "code";
          this.otpSessionId = "mock-otp-" + Date.now();
          this.setStatusMessage(theme.green("✓ Código enviado para o e-mail!"));
          return;
        }

        this.isOtpRequesting = true;
        this.setStatusMessage(theme.yellow(`[...] Enviando código OTP para ${email}...`));

        try {
          const { startEmailOtpLogin } = await import("../../services/playwright.ts");
          const res = await startEmailOtpLogin(email, { headless: config.playwright.headless });
          this.isOtpRequesting = false;
          if (!res.success || !res.sessionId) {
            this.setStatusMessage(theme.red(`✗ Falha ao enviar código: ${res.error || "Erro desconhecido"}`));
            return;
          }
          this.otpSessionId = res.sessionId;
          this.isOtpCodeSent = true;
          this.addActiveField = "code";
          this.setStatusMessage(theme.green("✓ Código enviado! Digite os 6 dígitos abaixo."));
        } catch (err: any) {
          this.isOtpRequesting = false;
          this.setStatusMessage(theme.red(`✗ Erro: ${err?.message || String(err)}`));
        }
        return;
      }

      const code = this.addOtpCodeInput.trim();
      if (!code) {
        this.setStatusMessage(theme.yellow("[!] Digite o código de 6 dígitos recebido por e-mail"));
        return;
      }

      if (process.env.NODE_TEST_CONTEXT) {
        try {
          const newAcc = addAccount(email, "");
          this.resetAddModalState();
          await this.refresh();
          this.setStatusMessage(theme.green(`✓ Conta ${email} salva via código OTP!`));
        } catch (err: any) {
          this.setStatusMessage(theme.red(`✗ Erro ao salvar: ${err?.message || String(err)}`));
        }
        return;
      }

      this.isValidatingAccount = true;
      this.setStatusMessage(theme.yellow("[...] Validando código e capturando sessão de 30 dias..."));
      try {
        const { verifyEmailOtpLogin } = await import("../../services/playwright.ts");
        const res = await verifyEmailOtpLogin(this.otpSessionId!, code);
        this.isValidatingAccount = false;
        if (!res.success || !res.account) {
          this.setStatusMessage(theme.red(`✗ Código inválido: ${res.error || "Verificação falhou"}`));
          return;
        }
        this.resetAddModalState();
        await this.refresh();
        this.setStatusMessage(theme.green(`✓ Conta ${res.account.email} autenticada via código OTP!`));

        if (process.stdout.isTTY) {
          const sManager = ServerManager.getInstance();
          const sState = sManager.getState();
          if (sState !== "online" && sState !== "warming") {
            void sManager.ensureStarted().then(() => this.refresh());
          }
        }
      } catch (err: any) {
        this.isValidatingAccount = false;
        this.setStatusMessage(theme.red(`✗ Erro de verificação: ${err?.message || String(err)}`));
      }
      return;
    }

    const password = this.addPasswordInput.trim();
    if (!password) {
      this.setStatusMessage(theme.yellow("[!] E-mail e senha são obrigatórios"));
      return;
    }

    if (process.env.NODE_TEST_CONTEXT) {
      try {
        const newAcc = addAccount(email, password);
        this.resetAddModalState();
        await this.refresh();
        this.setStatusMessage(theme.green(`✓ Conta ${email} salva! Conectando...`));
      } catch (err: any) {
        this.setStatusMessage(theme.red(`✗ Erro ao salvar: ${err?.message || String(err)}`));
      }
      return;
    }

    this.isValidatingAccount = true;
    this.setStatusMessage(theme.yellow(`[...] Validando credenciais para ${email}...`));

    const tempId = crypto.randomUUID();
    try {
      const { validateAccountLogin } = await import("../../services/playwright.ts");
      const { wipeAccountSessionFiles } = await import("../../core/accounts.ts");
      const { clearAccountCooldown } = await import("../../core/account-manager.ts");

      const ok = await validateAccountLogin(
        { id: tempId, email, password },
        config.playwright.headless,
        config.playwright.browser,
      );

      if (!ok) {
        wipeAccountSessionFiles(tempId);
        clearAccountCooldown(tempId);
        this.setStatusMessage(theme.red(`✗ Falha no login: credenciais inválidas ou bloqueio no Qwen`));
        return;
      }

      const newAcc = addAccount(email, password, tempId);
      this.resetAddModalState();
      await this.refresh();
      this.setStatusMessage(theme.green(`✓ Conta ${email} validada e salva! Conectando...`));

      if (process.stdout.isTTY) {
        const sManager = ServerManager.getInstance();
        const sState = sManager.getState();
        if (sState !== "online" && sState !== "warming") {
          void sManager.ensureStarted().then(() => this.refresh());
        } else {
          // Server already online: initialize session and headers in background for the new account
          void (async () => {
            try {
              const { initPlaywrightForAccount } = await import("../../services/playwright.ts");
              const { getAccountCredentials } = await import("../../core/accounts.ts");
              const creds = getAccountCredentials(newAcc.id);
              if (creds) {
                await initPlaywrightForAccount(
                  creds,
                  config.playwright.headless,
                  config.playwright.browser,
                );
                await this.refresh();
              }
            } catch {}
          })();
        }
      }
    } catch (err: any) {
      const { wipeAccountSessionFiles } = await import("../../core/accounts.ts");
      const { clearAccountCooldown } = await import("../../core/account-manager.ts");
      wipeAccountSessionFiles(tempId);
      clearAccountCooldown(tempId);
      this.setStatusMessage(theme.red(`✗ Erro ao validar: ${err?.message || String(err)}`));
    } finally {
      this.isValidatingAccount = false;
    }
  }
  private async saveBatchAccounts(): Promise<void> {
    const { entries } = parseBatchAccounts(this.batchInput);
    if (entries.length === 0) {
      this.setStatusMessage(theme.yellow("[!] Nenhuma conta válida detectada"));
      return;
    }

    try {
      const result = addAccountsBatch(entries);
      this.isBatchModalOpen = false;
      this.batchInput = "";
      this.batchCursor = 0;
      this.batchActiveButton = null;
      this.batchHoveredButton = null;
      await this.refresh();

      const addedCount = result.added.length;
      const skippedCount = result.skipped.length;
      if (addedCount > 0) {
        const msg =
          skippedCount > 0
            ? `✓ ${addedCount} conta(s) adicionada(s)! (${skippedCount} já existiam)`
            : `✓ ${addedCount} conta(s) adicionada(s) em lote!`;
        this.setStatusMessage(theme.green(msg));
      } else {
        this.setStatusMessage(
          theme.yellow(`[!] Todas as ${skippedCount} conta(s) já existiam no banco.`),
        );
      }
    } catch (err: any) {
      this.setStatusMessage(theme.red(`✗ Erro no lote: ${err?.message || String(err)}`));
    }
  }
  public async handleKey(key: KeyEvent): Promise<boolean | void> {
    // 0. Confirm Dialog Active
    if (this.confirmDialog) {
      if (key.name === "s" || key.name === "S") {
        const dialog = this.confirmDialog;
        this.confirmDialog = null;
        this.confirmDialogHovered = null;
        await dialog.onConfirm();
        return true;
      }
      if (key.name === "escape" || key.name === "n" || key.name === "N") {
        this.confirmDialog = null;
        this.confirmDialogHovered = null;
        this.setStatusMessage(theme.muted("Ação cancelada"));
        return true;
      }
      if (key.name === "enter" || key.name === "return") {
        if (this.confirmDialogHovered === "cancel") {
          this.confirmDialog = null;
          this.confirmDialogHovered = null;
          this.setStatusMessage(theme.muted("Ação cancelada"));
          return true;
        }
        const dialog = this.confirmDialog;
        this.confirmDialog = null;
        this.confirmDialogHovered = null;
        await dialog.onConfirm();
        return true;
      }
      if (key.name === "left" || key.name === "right" || key.name === "tab") {
        this.confirmDialogHovered = this.confirmDialogHovered === "cancel" ? "confirm" : "cancel";
        return true;
      }
      if (key.name === "hover" && key.mouse) {
        const { row, col } = key.mouse;
        const btnRow = (this.lastConfirmModalStartRow || 4) + 5;
        if (row === btnRow || row === btnRow - 1) {
          const relCol = col - (this.lastConfirmModalLeftPad || 0);
          if (relCol >= 2 && relCol <= 34) {
            if (this.confirmDialogHovered !== "confirm") {
              this.confirmDialogHovered = "confirm";
              return true;
            }
            return true;
          }
          if (relCol >= 35 && relCol <= 60) {
            if (this.confirmDialogHovered !== "cancel") {
              this.confirmDialogHovered = "cancel";
              return true;
            }
            return true;
          }
        }
        if (this.confirmDialogHovered !== null) {
          this.confirmDialogHovered = null;
          return true;
        }
      }
      if (key.name === "click" && key.mouse) {
        const { row, col } = key.mouse;
        const btnRow = (this.lastConfirmModalStartRow || 4) + 5;
        if (row === btnRow || row === btnRow - 1) {
          const relCol = col - (this.lastConfirmModalLeftPad || 0);
          if (relCol >= 2 && relCol <= 34) {
            const dialog = this.confirmDialog;
            this.confirmDialog = null;
            this.confirmDialogHovered = null;
            await dialog.onConfirm();
            return true;
          }
          if (relCol >= 35 && relCol <= 60) {
            this.confirmDialog = null;
            this.confirmDialogHovered = null;
            this.setStatusMessage(theme.muted("Ação cancelada"));
            return true;
          }
        }
      }
      return true;
    }
    // 0.5 Batch Account Import Modal Active
    if (this.isBatchModalOpen) {
      if (key.name === "escape") {
        this.isBatchModalOpen = false;
        this.batchInput = "";
        this.batchCursor = 0;
        this.batchActiveButton = null;
        this.batchHoveredButton = null;
        return true;
      }

      // Keyboard button selection navigation
      if (key.name === "tab" || key.name === "left" || key.name === "right") {
        if (this.batchActiveButton === null) {
          this.batchActiveButton = "cancel";
        } else {
          this.batchActiveButton = this.batchActiveButton === "import" ? "cancel" : "import";
        }
        this.batchHoveredButton = null;
        return true;
      }

      // Mouse hover in Batch modal
      if (key.name === "hover" && key.mouse) {
        const { row, col } = key.mouse;
        const btnRow = (this.lastBatchModalStartRow || 4) + 11;
        if (row === btnRow) {
          const leftPad = this.lastBatchModalLeftPad || 0;
          const relCol = col - leftPad;
          let btn: "import" | "cancel" | null = null;
          if (relCol >= 3 && relCol <= 24) {
            btn = "import";
          } else if (relCol >= 25 && relCol <= 44) {
            btn = "cancel";
          }
          if (this.batchHoveredButton !== btn) {
            this.batchHoveredButton = btn;
            return true;
          }
          return true;
        }
        if (this.batchHoveredButton !== null) {
          this.batchHoveredButton = null;
          return true;
        }
      }

      // Mouse click in Batch modal
      if (key.name === "click" && key.mouse) {
        const { row, col } = key.mouse;
        const btnRow = (this.lastBatchModalStartRow || 4) + 11;
        if (row === btnRow) {
          const leftPad = this.lastBatchModalLeftPad || 0;
          const relCol = col - leftPad;
          if (relCol >= 3 && relCol <= 24) {
            await this.saveBatchAccounts();
            return true;
          }
          if (relCol >= 25 && relCol <= 44) {
            this.isBatchModalOpen = false;
            this.batchInput = "";
            this.batchCursor = 0;
            this.batchActiveButton = null;
            this.batchHoveredButton = null;
            return true;
          }
        }
      }

      // Paste event or Ctrl+V
      if (key.name === "paste" || (key.ctrl && (key.name === "v" || key.raw === "\x16"))) {
        const pasted = key.name === "paste" && key.char ? key.char : getClipboardText();
        if (pasted) {
          this.batchInput =
            this.batchInput.slice(0, this.batchCursor) +
            pasted +
            this.batchInput.slice(this.batchCursor);
          this.batchCursor += pasted.length;
          this.batchActiveButton = null;
          return true;
        }
      }

      // Single Ctrl+C in batch modal clears buffer
      if (key.ctrl && key.name === "c") {
        this.batchInput = "";
        this.batchCursor = 0;
        return true;
      }

      // Backspace
      if (key.name === "backspace") {
        if (this.batchCursor > 0) {
          this.batchInput =
            this.batchInput.slice(0, this.batchCursor - 1) +
            this.batchInput.slice(this.batchCursor);
          this.batchCursor--;
        }
        return true;
      }
      // Delete
      if (key.name === "delete") {
        if (this.batchCursor < this.batchInput.length) {
          this.batchInput =
            this.batchInput.slice(0, this.batchCursor) +
            this.batchInput.slice(this.batchCursor + 1);
        }
        return true;
      }

      // Enter saves or triggers focused button
      if (key.name === "return") {
        const target = this.batchHoveredButton || this.batchActiveButton;
        if (target === "cancel") {
          this.isBatchModalOpen = false;
          this.batchInput = "";
          this.batchCursor = 0;
          this.batchActiveButton = null;
          this.batchHoveredButton = null;
          return true;
        }
        await this.saveBatchAccounts();
        return true;
      }

      // Type character into batch buffer (including newline)
      if (key.char && !key.ctrl && !key.meta && key.name !== "tab") {
        this.batchInput =
          this.batchInput.slice(0, this.batchCursor) +
          key.char +
          this.batchInput.slice(this.batchCursor);
        this.batchCursor += key.char.length;
        return true;
      }

      return true;
    }

    // 1. Add Account Modal Active
    if (this.isAddModalOpen) {
      if (this.isValidatingAccount || this.isOtpRequesting) return true;
      if (key.name === "escape") {
        this.resetAddModalState();
        return true;
      }

      // Switch mode with Tab (when code has not been sent yet)
      if (key.name === "tab") {
        if (!this.isOtpCodeSent) {
          this.addLoginMode = this.addLoginMode === "password" ? "otp" : "password";
          this.addActiveField = "email";
          this.setStatusMessage(
            theme.cyan(
              `Modo alterado para: ${
                this.addLoginMode === "password" ? "Senha" : "Código E-mail (Sem Senha)"
              }`,
            ),
          );
          return true;
        }
      }

      // Mouse hover in Add Account modal
      if (key.name === "hover" && key.mouse) {
        const { row, col } = key.mouse;
        const leftPad = this.lastModalLeftPad || 0;
        const relCol = col - leftPad;
        if (row === 6) {
          if (this.modalHoveredField !== "email") {
            this.modalHoveredField = "email";
            return true;
          }
        } else if (row === 7) {
          const field = this.addLoginMode === "password" ? "password" : "code";
          if (this.modalHoveredField !== field) {
            this.modalHoveredField = field;
            return true;
          }
        } else if (row === 9) {
          const btn = relCol <= 28 ? "save" : relCol <= 49 ? "cancel" : "mode";
          if (this.modalHoveredField !== btn) {
            this.modalHoveredField = btn;
            return true;
          }
        } else if (this.modalHoveredField !== null) {
          this.modalHoveredField = null;
          return true;
        }
      }

      // Mouse click in Add Account modal
      if (key.name === "click" && key.mouse) {
        const { row, col } = key.mouse;
        const leftPad = this.lastModalLeftPad || 0;
        const relCol = col - leftPad;
        // Click on email field row (row 6)
        if (row === 6) {
          this.addActiveField = "email";
          return true;
        }
        // Click on second field row (row 7)
        if (row === 7) {
          if (this.addLoginMode === "password") {
            this.addActiveField = "password";
          } else if (this.isOtpCodeSent) {
            this.addActiveField = "code";
          }
          return true;
        }
        // Click on buttons row (row 9)
        if (row === 9) {
          if (relCol <= 28) {
            await this.saveModalAccount();
            return true;
          } else if (relCol <= 49) {
            this.resetAddModalState();
            return true;
          } else {
            // Clicked mode toggle button
            if (!this.isOtpCodeSent) {
              this.addLoginMode = this.addLoginMode === "password" ? "otp" : "password";
              this.addActiveField = "email";
              this.setStatusMessage(
                theme.cyan(
                  `Modo alterado para: ${
                    this.addLoginMode === "password" ? "Senha" : "Código E-mail (Sem Senha)"
                  }`,
                ),
              );
              return true;
            }
          }
        }
      }
      // Switch field with Up / Down arrow keys
      if (key.name === "up" || key.name === "down") {
        if (this.addLoginMode === "password") {
          this.addActiveField = this.addActiveField === "email" ? "password" : "email";
        } else if (this.isOtpCodeSent) {
          this.addActiveField = this.addActiveField === "email" ? "code" : "email";
        }
        return true;
      }

      // Cursor navigation with Left / Right / Home / End
      if (key.name === "left") {
        if (this.addActiveField === "email") {
          this.addEmailCursor = Math.max(0, this.addEmailCursor - 1);
        } else if (this.addActiveField === "password") {
          this.addPasswordCursor = Math.max(0, this.addPasswordCursor - 1);
        } else {
          this.addOtpCodeCursor = Math.max(0, this.addOtpCodeCursor - 1);
        }
        return true;
      }
      if (key.name === "right") {
        if (this.addActiveField === "email") {
          this.addEmailCursor = Math.min(this.addEmailInput.length, this.addEmailCursor + 1);
        } else if (this.addActiveField === "password") {
          this.addPasswordCursor = Math.min(this.addPasswordInput.length, this.addPasswordCursor + 1);
        } else {
          this.addOtpCodeCursor = Math.min(this.addOtpCodeInput.length, this.addOtpCodeCursor + 1);
        }
        return true;
      }
      if (key.name === "home") {
        if (this.addActiveField === "email") this.addEmailCursor = 0;
        else if (this.addActiveField === "password") this.addPasswordCursor = 0;
        else this.addOtpCodeCursor = 0;
        return true;
      }
      if (key.name === "end") {
        if (this.addActiveField === "email") this.addEmailCursor = this.addEmailInput.length;
        else if (this.addActiveField === "password") this.addPasswordCursor = this.addPasswordInput.length;
        else this.addOtpCodeCursor = this.addOtpCodeInput.length;
        return true;
      }

      // Paste from clipboard with Ctrl+V
      if (key.ctrl && (key.name === "v" || key.raw === "\x16")) {
        const pasted = getClipboardText();
        if (pasted) {
          if (this.addActiveField === "email") {
            this.addEmailInput =
              this.addEmailInput.slice(0, this.addEmailCursor) +
              pasted +
              this.addEmailInput.slice(this.addEmailCursor);
            this.addEmailCursor += pasted.length;
          } else if (this.addActiveField === "password") {
            this.addPasswordInput =
              this.addPasswordInput.slice(0, this.addPasswordCursor) +
              pasted +
              this.addPasswordInput.slice(this.addPasswordCursor);
            this.addPasswordCursor += pasted.length;
          } else {
            this.addOtpCodeInput =
              this.addOtpCodeInput.slice(0, this.addOtpCodeCursor) +
              pasted +
              this.addOtpCodeInput.slice(this.addOtpCodeCursor);
            this.addOtpCodeCursor += pasted.length;
          }
          return true;
        }
      }
      // Single Ctrl+C in active field clears current field (normal CLI function)
      if (key.ctrl && key.name === "c") {
        if (this.addActiveField === "email") {
          this.addEmailInput = "";
          this.addEmailCursor = 0;
        } else if (this.addActiveField === "password") {
          this.addPasswordInput = "";
          this.addPasswordCursor = 0;
        } else {
          this.addOtpCodeInput = "";
          this.addOtpCodeCursor = 0;
        }
        return true;
      }

      // Backspace in active field at cursor
      if (key.name === "backspace") {
        if (this.addActiveField === "email") {
          if (this.addEmailCursor > 0) {
            this.addEmailInput =
              this.addEmailInput.slice(0, this.addEmailCursor - 1) +
              this.addEmailInput.slice(this.addEmailCursor);
            this.addEmailCursor--;
          }
        } else if (this.addActiveField === "password") {
          if (this.addPasswordCursor > 0) {
            this.addPasswordInput =
              this.addPasswordInput.slice(0, this.addPasswordCursor - 1) +
              this.addPasswordInput.slice(this.addPasswordCursor);
            this.addPasswordCursor--;
          }
        } else {
          if (this.addOtpCodeCursor > 0) {
            this.addOtpCodeInput =
              this.addOtpCodeInput.slice(0, this.addOtpCodeCursor - 1) +
              this.addOtpCodeInput.slice(this.addOtpCodeCursor);
            this.addOtpCodeCursor--;
          }
        }
        return true;
      }

      // Delete key at cursor
      if (key.name === "delete") {
        if (this.addActiveField === "email") {
          if (this.addEmailCursor < this.addEmailInput.length) {
            this.addEmailInput =
              this.addEmailInput.slice(0, this.addEmailCursor) +
              this.addEmailInput.slice(this.addEmailCursor + 1);
          }
        } else if (this.addActiveField === "password") {
          if (this.addPasswordCursor < this.addPasswordInput.length) {
            this.addPasswordInput =
              this.addPasswordInput.slice(0, this.addPasswordCursor) +
              this.addPasswordInput.slice(this.addPasswordCursor + 1);
          }
        } else {
          if (this.addOtpCodeCursor < this.addOtpCodeInput.length) {
            this.addOtpCodeInput =
              this.addOtpCodeInput.slice(0, this.addOtpCodeCursor) +
              this.addOtpCodeInput.slice(this.addOtpCodeCursor + 1);
          }
        }
        return true;
      }

      // Save on Enter
      if (key.name === "return") {
        await this.saveModalAccount();
        return true;
      }
      // Type character into active field at cursor position
      if (key.char && !key.ctrl && !key.meta && key.name !== "tab") {
        if (key.char >= " ") {
          if (this.addActiveField === "email") {
            this.addEmailInput =
              this.addEmailInput.slice(0, this.addEmailCursor) +
              key.char +
              this.addEmailInput.slice(this.addEmailCursor);
            this.addEmailCursor += key.char.length;
          } else if (this.addActiveField === "password") {
            this.addPasswordInput =
              this.addPasswordInput.slice(0, this.addPasswordCursor) +
              key.char +
              this.addPasswordInput.slice(this.addPasswordCursor);
            this.addPasswordCursor += key.char.length;
          } else if (this.addActiveField === "code") {
            if (this.addOtpCodeInput.length < 10) {
              this.addOtpCodeInput =
                this.addOtpCodeInput.slice(0, this.addOtpCodeCursor) +
                key.char +
                this.addOtpCodeInput.slice(this.addOtpCodeCursor);
              this.addOtpCodeCursor += key.char.length;
            }
          }
          return true;
        }
      }
      return true;
    }

    const accounts = this.statusData?.accounts || [];

    // Open Add Account modal with 'a' or 'A'
    if ((key.name === "a" || key.name === "A") && !key.ctrl) {
      this.isAddModalOpen = true;
      this.addEmailInput = "";
      this.addPasswordInput = "";
      this.addActiveField = "email";
      return true;
    }

    // Open Batch Import modal with 'b' or 'B'
    if ((key.name === "b" || key.name === "B") && !key.ctrl) {
      this.isBatchModalOpen = true;
      this.batchInput = "";
      this.batchCursor = 0;
      this.batchActiveButton = null;
      this.batchHoveredButton = null;
      return true;
    }

    // Delete selected account with 'd' or 'D' (requires confirmation)
    if ((key.name === "d" || key.name === "D") && !key.ctrl) {
      const selected = accounts[this.selectedIndex];
      if (!selected) {
        this.setStatusMessage(theme.yellow("[!] Nenhuma conta selecionada para remover"));
        return true;
      }
      this.confirmDialog = {
        type: "remove_account",
        title: "⚠️  Confirmar Remoção de Conta",
        message: `Deseja remover a conta ${selected.emailOrName}?`,
        detail: "A conta será excluída do banco de dados e sua sessão encerrada.",
        onConfirm: async () => {
          removeAccount(selected.id);
          try {
            const { closePlaywrightForAccount, removePlaywrightProfile } = await import("../../services/playwright.ts");
            const { getAccountProfilePath } = await import("../../core/paths.ts");
            await closePlaywrightForAccount(selected.id);
            removePlaywrightProfile(getAccountProfilePath(selected.id));
          } catch {}
          await this.refresh();
          this.setStatusMessage(theme.green(`✓ Conta ${selected.emailOrName} removida com sucesso`));
        },
      };
      return true;
    }

    // Delete chats of selected account with 'x' or 'X' (requires confirmation)
    if ((key.name === "x" || key.name === "X") && !key.ctrl) {
      const selected = accounts[this.selectedIndex];
      if (!selected) {
        this.setStatusMessage(theme.yellow("[!] Nenhuma conta selecionada"));
        return true;
      }
      this.confirmDialog = {
        type: "delete_account_chats",
        title: "⚠️  Apagar Chats Remotos no Qwen",
        message: `Apagar TODOS os chats no Qwen da conta ${selected.emailOrName}?`,
        detail: "Esta ação é irreversível e limpará todas as conversas em chat.qwen.ai.",
        onConfirm: async () => {
          this.setStatusMessage(theme.yellow(`⏳ Apagando chats no Qwen para ${selected.emailOrName}...`));
          try {
            const { deleteChatsForAccountId } = await import("../../services/chat-cleanup.ts");
            await deleteChatsForAccountId(selected.id);
            await this.refresh();
            this.setStatusMessage(theme.green(`✓ Todos os chats de ${selected.emailOrName} foram apagados no Qwen!`));
          } catch (err: any) {
            this.setStatusMessage(theme.red(`✗ Falha ao apagar chats: ${err?.message || String(err)}`));
          }
        },
      };
      return true;
    }

    // Delete chats of all accounts with 'l' or 'L' (requires confirmation)
    if ((key.name === "l" || key.name === "L") && !key.ctrl) {
      if (accounts.length === 0) {
        this.setStatusMessage(theme.yellow("[!] Nenhuma conta configurada"));
        return true;
      }
      this.confirmDialog = {
        type: "delete_all_chats",
        title: "⚠️  Apagar Chats de TODAS as Contas",
        message: `Apagar TODOS os chats remotos de TODAS as ${accounts.length} contas no Qwen?`,
        detail: "Esta ação é irreversível e limpará o histórico no chat.qwen.ai.",
        onConfirm: async () => {
          this.setStatusMessage(theme.yellow(`⏳ Apagando chats no Qwen de todas as contas...`));
          try {
            const { deleteChatsForConfiguredAccounts } = await import("../../services/chat-cleanup.ts");
            const res = await deleteChatsForConfiguredAccounts(true);
            await this.refresh();
            this.setStatusMessage(theme.green(`✓ Chats apagados no Qwen: ${res.succeeded}/${res.attempted} contas limpas!`));
          } catch (err: any) {
            this.setStatusMessage(theme.red(`✗ Falha ao apagar chats: ${err?.message || String(err)}`));
          }
        },
      };
      return true;
    }

    // Mouse hover on account rows or right panel actions
    if (key.name === "hover" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 46;

      // Account list rows start at row 8 (row 4=box border, 5=blank, 6=header, 7=divider)
      const availableRows = 14;
      if (col >= 2 && col <= leftW - 1 && row >= 8 && row < 8 + Math.min(accounts.length, availableRows)) {
        const hoverIdx = this.accountsScrollOffset + (row - 8);
        if (this.hoveredAccountIndex !== hoverIdx && hoverIdx < accounts.length) {
          this.hoveredAccountIndex = hoverIdx;
          return true;
        }
      } else if (this.hoveredAccountIndex !== null) {
        this.hoveredAccountIndex = null;
        return true;
      }

      // Right panel action buttons hover (rows 16 to 21)
      if (col >= leftW) {
        if (row === 16) {
          const actionRow = col < leftW + 18 ? 16 : 22;
          if (this.hoveredActionRow !== actionRow) {
            this.hoveredActionRow = actionRow;
            return true;
          }
        } else if (row >= 17 && row <= 21) {
          if (this.hoveredActionRow !== row) {
            this.hoveredActionRow = row;
            return true;
          }
        } else if (this.hoveredActionRow !== null) {
          this.hoveredActionRow = null;
          return true;
        }
      } else if (this.hoveredActionRow !== null) {
        this.hoveredActionRow = null;
        return true;
      }
    }
    // Mouse click on account rows or action buttons
    if (key.name === "click" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 46;

      const availableRows = Math.max(4, (this.lastLeftW ? 18 : 14));
      // Click on account row (rows 8, 9, ...)
      if (col >= 2 && col <= leftW - 1 && row >= 8 && row < 8 + Math.min(accounts.length, availableRows)) {
        const targetIdx = this.accountsScrollOffset + (row - 8);
        if (targetIdx >= 0 && targetIdx < accounts.length) {
          this.selectedIndex = targetIdx;
          return true;
        }
      }
      // Right panel action buttons click (rows 16 to 21)
      if (col >= leftW) {
        if (row === 16) {
          if (col < leftW + 18) {
            await this.handleKey({ name: "a", ctrl: false, shift: false, meta: false });
          } else {
            await this.handleKey({ name: "b", ctrl: false, shift: false, meta: false });
          }
          return true;
        }
        if (row === 17) {
          await this.handleKey({ name: "d", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 18) {
          await this.handleKey({ name: "c", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 19) {
          await this.handleKey({ name: "z", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 20) {
          await this.handleKey({ name: "x", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 21) {
          await this.handleKey({ name: "l", ctrl: false, shift: false, meta: false });
          return true;
        }
      }
    }
    if (key.name === "up" || key.name === "wheelup" || (key.name === "k" && !key.ctrl)) {
      if (accounts.length > 0) {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      }
      return true;
    }
    if (key.name === "down" || key.name === "wheeldown" || (key.name === "j" && !key.ctrl)) {
      if (accounts.length > 0) {
        this.selectedIndex = Math.min(accounts.length - 1, this.selectedIndex + 1);
      }
      return true;
    }

    // Refresh with 'r' or 'R'
    if ((key.name === "r" || key.name === "R") && !key.ctrl) {
      await this.refresh();
      this.setStatusMessage(theme.green("✓ Lista de contas atualizada"));
      return true;
    }

    // Clear cooldown of all accounts with 'z' or 'Z'
    if ((key.name === "z" || key.name === "Z") && !key.ctrl) {
      const cleared = resetAllCooldowns();
      await this.refresh();
      this.setStatusMessage(theme.green(`✓ Cooldowns zerados: ${cleared} conta(s) liberada(s)`));
      return true;
    }

    // Clear cooldown of selected account with 'c' or 'C'
    if ((key.name === "c" || key.name === "C") && !key.ctrl) {
      const selected = accounts[this.selectedIndex];
      if (!selected) {
        this.setStatusMessage(theme.yellow("[!] Nenhuma conta selecionada"));
        return true;
      }
      resetAccountCooldownById(selected.id);
      await this.refresh();
      this.setStatusMessage(
        theme.green(`✓ Cooldown da conta ${selected.emailOrName} zerado com sucesso`),
      );
      return true;
    }
  }

  public render(width: number, height: number, snapshot?: ProxyStatusSnapshot | null): string[] {
    const contentH = Math.max(12, height);
    const leftW = Math.max(46, Math.floor(width * 0.54));
    this.lastLeftW = leftW;
    const rightW = Math.max(30, width - leftW - 1);

    if (snapshot) {
      this.statusData = snapshot;
    }
    const data = snapshot || this.statusData;
    const accounts = data?.accounts || [];
    const selected = accounts[this.selectedIndex];

    const availableRows = Math.max(4, contentH - 6);
    if (this.selectedIndex >= accounts.length && accounts.length > 0) {
      this.selectedIndex = accounts.length - 1;
    }

    // Left Panel: Accounts List Table
    const showUsageCol = leftW >= 48;
    const headerUsage = showUsageCol ? "Uso%  " : "";
    const leftContent: string[] = [
      "",
      `  ${theme.dim(`#   Conta                 ${headerUsage}Status`)}`,
      `  ${theme.dim("───────────────────────────────────────")}`,
    ];

    if (accounts.length === 0) {
      leftContent.push("");
      leftContent.push(`  ${theme.yellow("Nenhuma conta configurada ainda.")}`);
      leftContent.push(
        `  ${theme.muted("Pressione ")}${theme.cyan("'A'")}${theme.muted(" (individual) ou ")}${theme.cyan("'B'")}${theme.muted(" (em lote).")}`,
      );
    } else {
      // Clamp scroll offset to keep selectedIndex inside visible window
      if (this.selectedIndex < this.accountsScrollOffset) {
        this.accountsScrollOffset = this.selectedIndex;
      } else if (this.selectedIndex >= this.accountsScrollOffset + availableRows) {
        this.accountsScrollOffset = this.selectedIndex - availableRows + 1;
      }
      const maxScroll = Math.max(0, accounts.length - availableRows);
      this.accountsScrollOffset = Math.max(0, Math.min(this.accountsScrollOffset, maxScroll));

      const visibleAccounts = accounts.slice(
        this.accountsScrollOffset,
        this.accountsScrollOffset + availableRows,
      );

      visibleAccounts.forEach((acc, visibleIdx) => {
        const actualIdx = this.accountsScrollOffset + visibleIdx;
        const isFocused = actualIdx === this.selectedIndex;
        const isHovered = actualIdx === this.hoveredAccountIndex;
        const pointer = isFocused ? theme.cyan(`${glyphs.pointer} `) : "  ";
        const num = pad(String(actualIdx + 1) + ".", 4);
        const name = pad(truncate(acc.emailOrName, 20), 22);

        let status = theme.green(`${glyphs.bullet} Pronto   `);
        if (acc.onCooldown) {
          const reason = acc.cooldownReason || "";
          if (
            reason.startsWith("AuthFailed") ||
            reason.startsWith("AuthPermanentFailure") ||
            reason.includes("All login methods exhausted")
          ) {
            status = theme.red(`❌ Auth Fail `);
          } else if (reason === "WafChallenge") {
            status = theme.peach(`🛡️ WAF Block  `);
          } else if (reason === "AuthInitFailed") {
            const mins = Math.max(1, Math.round(acc.remainingCooldownMs / 60000));
            status = theme.yellow(`⚠️ ${mins}m init `);
          } else {
            const mins = Math.max(1, Math.round(acc.remainingCooldownMs / 60000));
            status = theme.yellow(`⚠️ ${mins}m cd   `);
          }
        } else if (!acc.headersReady) {
          status = acc.isInitialized
            ? theme.yellow(`◐ Aquecendo...`)
            : theme.muted(`○ Standby     `);
        }

        const usagePct = acc.dailyUsagePercent ?? 0;
        const usagePctStr = showUsageCol
          ? (usagePct > 0
              ? (usagePct >= 80 ? theme.red(pad(`${usagePct}%`, 5)) : usagePct >= 40 ? theme.yellow(pad(`${usagePct}%`, 5)) : theme.cyan(pad(`${usagePct}%`, 5)))
              : theme.dim(pad("0%", 5))) + " "
          : "";

        const line = `${pointer}${num}${name}${usagePctStr}${status}`;
        if (isHovered) {
          leftContent.push(theme.bgHover(line));
        } else if (isFocused) {
          leftContent.push(theme.bgSelected(line));
        } else {
          leftContent.push(line);
        }
      });
    }

    const boxTitle =
      accounts.length > availableRows
        ? `Contas (${this.accountsScrollOffset + 1}-${Math.min(accounts.length, this.accountsScrollOffset + availableRows)} de ${accounts.length})`
        : `Contas (${accounts.length})`;

    const leftBox = drawBox({
      title: boxTitle,
      width: leftW,
      height: contentH,
      borderColor: theme.borderActive,
      titleColor: theme.blue,
      footer: this.statusMessage || undefined,
      content: leftContent,
    });
    // Right Panel: Selected Account Details
    const rightContent: string[] = [
      "",
      `  ${theme.bold("Detalhes:")}`,
      `  ${theme.dim("─────────────────────────────────")}`,
    ];

    if (!selected) {
      rightContent.push("");
      rightContent.push(theme.muted("  Nenhuma conta configurada."));
      rightContent.push("");
      rightContent.push("");
      rightContent.push("");
      rightContent.push("");
      rightContent.push("");
      rightContent.push(`  ${theme.dim("─────────────────────────────────")}`);
      const btnA = this.hoveredActionRow === 16 ? theme.bgHover(` ${theme.cyan("[ A ] Adicionar")} `) : ` ${theme.cyan("[ A ]")} Adicionar `;
      const btnB = this.hoveredActionRow === 22 ? theme.bgHover(` ${theme.cyan("[ B ] Em Lote")} `) : ` ${theme.cyan("[ B ]")} Em Lote `;
      rightContent.push(`  ${btnA}   ${btnB}`);
    } else {
      const email = truncate(selected.emailOrName, 18);
      rightContent.push(`  ${theme.bold("Conta:")}      ${theme.cyan(email)}`);
      rightContent.push(`  ${theme.bold("Sistema ID:")} ${theme.muted(selected.id.slice(0, 14))}`);
      rightContent.push(`  ${theme.bold("Nível:")}      ${selected.priority}`);

      const usagePct = selected.dailyUsagePercent ?? 0;
      const usageTokens = selected.dailyTokens ?? 0;
      const usageTurns = selected.dailyTurns ?? 0;
      const usageColor = usagePct >= 80 ? theme.red : usagePct >= 40 ? theme.yellow : theme.cyan;
      const usageBar = renderProgressBar(usagePct, 6, usageColor);
      rightContent.push(`  ${theme.bold("Cota Hoje:")}  [${usageBar}] ${usageColor(`${usagePct}%`)} ${theme.dim(`(~${Math.round(usageTokens / 1000)}k / ${usageTurns} reqs)`)}`);

      const cdStatus = selected.onCooldown
        ? theme.yellow(`[!] Cooldown ${Math.round(selected.remainingCooldownMs / 60000)}m`)
        : theme.green(`${glyphs.check} Disponível`);
      rightContent.push(`  ${theme.bold("Estado:")}     ${cdStatus}`);

      const hStatus = selected.headersReady
        ? theme.green(`${glyphs.check} Capturados`)
        : selected.isInitialized
          ? theme.yellow(`◐ Aquecendo...`)
          : theme.muted(`${glyphs.circle} Standby (Sob Demanda)`);
      rightContent.push(`  ${theme.bold("Headers:")}    ${hStatus}`);
      if (selected.onCooldown && selected.cooldownReason) {
        const maxReasonW = Math.max(16, rightW - 14);
        const cdReason = formatCooldownReason(selected.cooldownReason, maxReasonW);
        rightContent.push(`  ${theme.bold("Motivo:")}     ${cdReason}`);
      } else {
        rightContent.push("");
      }
      rightContent.push(`  ${theme.dim("─────────────────────────────────")}`);
      const btnA = this.hoveredActionRow === 16 ? theme.bgHover(` ${theme.cyan("[ A ] Adicionar")} `) : ` ${theme.cyan("[ A ]")} Adicionar `;
      const btnB = this.hoveredActionRow === 22 ? theme.bgHover(` ${theme.cyan("[ B ] Em Lote")} `) : ` ${theme.cyan("[ B ]")} Em Lote `;
      rightContent.push(`  ${btnA}   ${btnB}`);
      rightContent.push(`  ${this.hoveredActionRow === 17 ? theme.bgHover(` ${theme.red("[ D ] Remover Conta")} `) : ` ${theme.red("[ D ]")} Remover Conta `}`);
      rightContent.push(`  ${this.hoveredActionRow === 18 ? theme.bgHover(` ${theme.yellow("[ C ] Zerar Cooldown")} `) : ` ${theme.yellow("[ C ]")} Zerar Cooldown `}`);
      rightContent.push(`  ${this.hoveredActionRow === 19 ? theme.bgHover(` ${theme.green("[ Z ] Zerar Todas")} `) : ` ${theme.green("[ Z ]")} Zerar Todas `}`);
      rightContent.push(`  ${this.hoveredActionRow === 20 ? theme.bgHover(` ${theme.peach("[ X ] Limpar Chats (Conta)")} `) : ` ${theme.peach("[ X ]")} Limpar Chats (Conta) `}`);
      rightContent.push(`  ${this.hoveredActionRow === 21 ? theme.bgHover(` ${theme.red("[ L ] Limpar Todos os Chats")} `) : ` ${theme.red("[ L ]")} Limpar Todos os Chats `}`);
    }
    const rightBox = drawBox({
      title: "Inspeção de Conta",
      width: rightW,
      height: contentH,
      borderColor: theme.borderInactive,
      titleColor: theme.lavender,
      content: rightContent,
    });

    // Merge columns side by side
    const mergedLines: string[] = [];
    const maxRows = Math.max(leftBox.length, rightBox.length);
    for (let r = 0; r < maxRows; r++) {
      const leftRow = leftBox[r] || " ".repeat(leftW);
      const rightRow = rightBox[r] || " ".repeat(rightW);
      mergedLines.push(leftRow + " " + rightRow);
    }
    if (this.isBatchModalOpen) {
      const modalW = Math.min(width - 4, 70);
      this.lastBatchModalLeftPad = Math.max(0, Math.floor((width - modalW) / 2));
      this.lastBatchModalStartRow = 4;

      const parsed = parseBatchAccounts(this.batchInput);
      const count = parsed.entries.length;
      const invalidCount = parsed.invalid.length;

      const rawLines = this.batchInput.split(/\r?\n/).filter(Boolean);
      let displaySnippet: string[];
      if (rawLines.length === 0) {
        displaySnippet = [
          "",
          "    " + theme.dim("Nenhuma conta colada ainda."),
          "    " + theme.cyan("Pressione Ctrl+V") + " " + theme.dim("para colar suas contas aqui..."),
          "",
        ];
      } else {
        const previewLines = rawLines.slice(-4);
        displaySnippet = previewLines.map((l) => "    " + truncate(l, modalW - 8));
        while (displaySnippet.length < 4) {
          displaySnippet.unshift("");
        }
      }

      const countBadge =
        count > 0
          ? theme.green(`✓ ${count} conta(s) detectada(s)`)
          : theme.yellow("0 contas detectadas");
      const invalidBadge =
        invalidCount > 0 ? theme.red(` | ${invalidCount} formato(s) ignorado(s)`) : "";

      const isImportHovered = this.batchHoveredButton === "import";
      const isCancelHovered = this.batchHoveredButton === "cancel";
      const isImportSelected = !this.batchHoveredButton && this.batchActiveButton === "import";
      const isCancelSelected = !this.batchHoveredButton && this.batchActiveButton === "cancel";

      const importLabel = " [ Enter ] Importar ";
      const cancelLabel = " [ Esc ] Cancelar ";
      const importBtn = isImportHovered
        ? theme.bgHover(theme.green(importLabel))
        : isImportSelected
        ? theme.bgSelected(theme.green(importLabel))
        : theme.green(importLabel);

      const cancelBtn = isCancelHovered
        ? theme.bgHover(theme.red(cancelLabel))
        : isCancelSelected
        ? theme.bgSelected(theme.red(cancelLabel))
        : theme.muted(cancelLabel);
      const modalContent = [
        "",
        `  ${theme.bold("Cole suas contas")} ${theme.dim("(email:senha, uma por linha ou formato .env)")}:`,
        `  ${theme.dim("────────────────────────────────────────────────────────")}`,
        ...displaySnippet,
        `  ${theme.dim("────────────────────────────────────────────────────────")}`,
        `  Status: ${countBadge}${invalidBadge}`,
        "",
        `  ${importBtn}  ${cancelBtn}    ${theme.dim("(Ctrl+V colar)")}`,
      ];
      const modalBox = drawBox({
        title: "Importar Contas em Lote (Multi-Contas)",
        width: modalW,
        height: Math.min(contentH, 13),
        borderColor: theme.borderActive,
        titleColor: theme.cyan,
        content: modalContent,
      });

      const padStr = " ".repeat(this.lastBatchModalLeftPad);
      return modalBox.map((line) => padStr + line);
    }
    if (this.isAddModalOpen) {
      const modalW = Math.min(width - 4, 76);
      this.lastModalLeftPad = Math.max(0, Math.floor((width - modalW) / 2));

      const isEmail = this.addActiveField === "email";
      const isPass = this.addActiveField === "password";
      const isCode = this.addActiveField === "code";

      // Render Email field with clean cursor (no white background hover)
      let emailDisplay: string;
      if (isEmail) {
        if (this.addEmailInput.length === 0) {
          emailDisplay = `${theme.inverse(" ")} ${theme.dim("(digite o e-mail)")}`;
        } else {
          const before = this.addEmailInput.slice(0, this.addEmailCursor);
          const at = this.addEmailInput[this.addEmailCursor] || " ";
          const after = this.addEmailInput.slice(this.addEmailCursor + 1);
          emailDisplay = `${theme.cyan(before)}${theme.inverse(at)}${theme.cyan(after)}`;
        }
      } else {
        emailDisplay = this.addEmailInput
          ? theme.cyan(this.addEmailInput)
          : theme.muted("(digite o e-mail)");
      }

      // Render Password or Code field with clean cursor
      let secondFieldLabel: string;
      let secondFieldDisplay: string;

      if (this.addLoginMode === "password") {
        secondFieldLabel = "Senha:";
        const maskedPass = "•".repeat(this.addPasswordInput.length);
        if (isPass) {
          if (this.addPasswordInput.length === 0) {
            secondFieldDisplay = `${theme.inverse(" ")} ${theme.dim("(digite a senha)")}`;
          } else {
            const before = maskedPass.slice(0, this.addPasswordCursor);
            const at = maskedPass[this.addPasswordCursor] || " ";
            const after = maskedPass.slice(this.addPasswordCursor + 1);
            secondFieldDisplay = `${theme.cyan(before)}${theme.inverse(at)}${theme.cyan(after)}`;
          }
        } else {
          secondFieldDisplay = this.addPasswordInput
            ? theme.cyan(maskedPass)
            : theme.muted("(digite a senha)");
        }
      } else {
        secondFieldLabel = "Código:";
        if (!this.isOtpCodeSent) {
          secondFieldDisplay = theme.dim("(será enviado p/ seu e-mail)");
        } else if (isCode) {
          if (this.addOtpCodeInput.length === 0) {
            secondFieldDisplay = `${theme.inverse(" ")} ${theme.dim("(digite o código de 6 dígitos)")}`;
          } else {
            const before = this.addOtpCodeInput.slice(0, this.addOtpCodeCursor);
            const at = this.addOtpCodeInput[this.addOtpCodeCursor] || " ";
            const after = this.addOtpCodeInput.slice(this.addOtpCodeCursor + 1);
            secondFieldDisplay = `${theme.cyan(before)}${theme.inverse(at)}${theme.cyan(after)}`;
          }
        } else {
          secondFieldDisplay = this.addOtpCodeInput
            ? theme.cyan(this.addOtpCodeInput)
            : theme.muted("(digite o código de 6 dígitos)");
        }
      }

      let saveBtnText: string;
      if (this.addLoginMode === "password") {
        saveBtnText = "[ Enter ] Salvar";
      } else if (!this.isOtpCodeSent) {
        saveBtnText = "[ Enter ] Enviar Código";
      } else {
        saveBtnText = "[ Enter ] Confirmar Código";
      }

      const saveBtn = (this.isValidatingAccount || this.isOtpRequesting)
        ? theme.yellow(" [ Aguarde... ] ")
        : this.modalHoveredField === "save"
          ? theme.bgHover(` ${saveBtnText} `)
          : ` ${theme.green(saveBtnText)} `;

      const cancelBtn =
        this.modalHoveredField === "cancel"
          ? theme.bgHover(" [ Esc ] Cancelar ")
          : ` ${theme.muted("[ Esc ] Cancelar")} `;

      const modeBtnText = this.addLoginMode === "password"
        ? "[ Tab ] Sem Senha (OTP)"
        : "[ Tab ] Modo Senha";

      const modeBtn =
        this.modalHoveredField === "mode"
          ? theme.bgHover(` ${modeBtnText} `)
          : ` ${theme.cyan(modeBtnText)} `;

      const modalContent = [
        "",
        `  ${theme.bold("E-mail:")}  ${emailDisplay}${this.isOtpCodeSent ? ` ${theme.green("✓ Código Enviado")}` : ""}`,
        `  ${theme.bold(secondFieldLabel)}   ${secondFieldDisplay}`,
        "",
        `  ${saveBtn}  ${cancelBtn}  ${modeBtn}`,
      ];

      const modalTitle = this.addLoginMode === "password"
        ? "Adicionar Nova Conta Qwen (Login com Senha)"
        : "Adicionar Nova Conta Qwen (Login sem Senha - OTP)";

      const modalBox = drawBox({
        title: modalTitle,
        width: modalW,
        height: Math.min(contentH, 11),
        borderColor: theme.borderActive,
        titleColor: theme.cyan,
        content: modalContent,
      });

      const padStr = " ".repeat(this.lastModalLeftPad);
      return modalBox.map((line) => padStr + line);
    }

    if (this.confirmDialog) {
      const modalW = Math.min(width - 4, 66);
      this.lastConfirmModalLeftPad = Math.max(0, Math.floor((width - modalW) / 2));
      this.lastConfirmModalStartRow = 4;
      const confirmBtn =
        this.confirmDialogHovered === "confirm"
          ? theme.bgHover(theme.red(" [ S / Enter ] Sim, Confirmar "))
          : ` ${theme.red("[ S / Enter ] Sim, Confirmar")} `;
      const cancelBtn =
        this.confirmDialogHovered === "cancel"
          ? theme.bgHover(theme.green(" [ N / Esc ] Cancelar "))
          : ` ${theme.green("[ N / Esc ] Cancelar")} `;

      const modalContent = [
        "",
        `  ${theme.bold(this.confirmDialog.message)}`,
        `  ${theme.muted(this.confirmDialog.detail)}`,
        "",
        `  ${confirmBtn}   ${cancelBtn}`,
      ];

      const modalBox = drawBox({
        title: this.confirmDialog.title,
        width: modalW,
        height: Math.min(contentH, 8),
        borderColor: theme.red,
        titleColor: theme.red,
        content: modalContent,
      });

      const padStr = " ".repeat(this.lastConfirmModalLeftPad);
      return modalBox.map((line) => padStr + line);
    }

    return mergedLines;
  }
}
