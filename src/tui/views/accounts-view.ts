/**
 * QwenProxy TUI - Accounts & Cooldowns Management View (Tab 5)
 */

import type { TuiView, ProxyStatusSnapshot } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, pad, truncate } from "../theme.ts";
import {
  fetchProxyStatus,
  resetAllCooldowns,
  resetAccountCooldownById,
} from "../proxy-client.ts";
import { addAccount, removeAccount } from "../../core/accounts.ts";
export class AccountsView implements TuiView {
  public readonly id = "accounts";
  public readonly title = "Contas";
  public readonly tabNumber = 5;

  private statusData: ProxyStatusSnapshot | null = null;
  private selectedIndex = 0;
  private statusMessage = "";
  private statusMessageTimer: NodeJS.Timeout | null = null;
  private isAddModalOpen = false;
  private addEmailInput = "";
  private addPasswordInput = "";
  private addEmailCursor = 0;
  private addPasswordCursor = 0;
  private addActiveField: "email" | "password" = "email";
  private hoveredActionRow: number | null = null;
  private hoveredAccountIndex: number | null = null;
  private modalHoveredField: "email" | "password" | "save" | "cancel" | null = null;
  private lastModalLeftPad = 0;
  private lastLeftW = 46;
  constructor() {
    this.refresh();
  }

  public onActivate(): void {
    this.refresh();
  }

  public isCapturingText(): boolean {
    return this.isAddModalOpen;
  }
  public getShortcuts(): Array<{ key: string; label: string }> {
    if (this.isAddModalOpen) {
      return [
        { key: "↑↓/Mouse", label: "Alternar" },
        { key: "Enter", label: "Salvar" },
        { key: "Esc", label: "Cancelar" },
      ];
    }
    return [
      { key: "a", label: "Adicionar Conta" },
      { key: "d", label: "Remover Conta" },
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

  private async saveModalAccount(): Promise<void> {
    const email = this.addEmailInput.trim();
    const password = this.addPasswordInput.trim();
    if (!email || !password) {
      this.setStatusMessage(theme.yellow("⚠️ E-mail e senha são obrigatórios"));
      return;
    }

    try {
      addAccount(email, password);
      this.isAddModalOpen = false;
      this.addEmailInput = "";
      this.addPasswordInput = "";
      this.addEmailCursor = 0;
      this.addPasswordCursor = 0;
      await this.refresh();
      this.setStatusMessage(theme.green(`✓ Conta ${email} salva com sucesso!`));
    } catch (err: any) {
      this.setStatusMessage(theme.red(`✗ Erro ao salvar: ${err?.message || String(err)}`));
    }
  }
  public async handleKey(key: KeyEvent): Promise<boolean | void> {
    // 1. Add Account Modal Active
    if (this.isAddModalOpen) {
      if (key.name === "escape") {
        this.isAddModalOpen = false;
        this.addEmailInput = "";
        this.addPasswordInput = "";
        return true;
      }

      // Mouse hover in Add Account modal
      if (key.name === "hover" && key.mouse) {
        const { row, col } = key.mouse;
        const leftPad = this.lastModalLeftPad || 0;
        const relCol = col - leftPad;
        if (row === 5 || row === 6) {
          if (this.modalHoveredField !== "email") {
            this.modalHoveredField = "email";
            return true;
          }
        } else if (row === 7 || row === 8) {
          if (this.modalHoveredField !== "password") {
            this.modalHoveredField = "password";
            return true;
          }
        } else if (row === 9) {
          const btn = relCol <= 24 ? "save" : "cancel";
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
        // Click on email field row (rows 5 and 6)
        if (row === 5 || row === 6) {
          this.addActiveField = "email";
          return true;
        }
        // Click on password field row (rows 7 and 8)
        if (row === 7 || row === 8) {
          this.addActiveField = "password";
          return true;
        }
        // Click on buttons row (row 9)
        if (row === 9) {
          if (relCol <= 24) {
            await this.saveModalAccount();
            return true;
          } else {
            this.isAddModalOpen = false;
            this.addEmailInput = "";
            this.addPasswordInput = "";
            this.addEmailCursor = 0;
            this.addPasswordCursor = 0;
            return true;
          }
        }
      }
      // Switch field with Up / Down arrow keys
      if (key.name === "up" || key.name === "down") {
        this.addActiveField = this.addActiveField === "email" ? "password" : "email";
        return true;
      }

      // Cursor navigation with Left / Right / Home / End
      if (key.name === "left") {
        if (this.addActiveField === "email") {
          this.addEmailCursor = Math.max(0, this.addEmailCursor - 1);
        } else {
          this.addPasswordCursor = Math.max(0, this.addPasswordCursor - 1);
        }
        return true;
      }
      if (key.name === "right") {
        if (this.addActiveField === "email") {
          this.addEmailCursor = Math.min(this.addEmailInput.length, this.addEmailCursor + 1);
        } else {
          this.addPasswordCursor = Math.min(this.addPasswordInput.length, this.addPasswordCursor + 1);
        }
        return true;
      }
      if (key.name === "home") {
        if (this.addActiveField === "email") this.addEmailCursor = 0;
        else this.addPasswordCursor = 0;
        return true;
      }
      if (key.name === "end") {
        if (this.addActiveField === "email") this.addEmailCursor = this.addEmailInput.length;
        else this.addPasswordCursor = this.addPasswordInput.length;
        return true;
      }

      // Paste from clipboard with Ctrl+V
      if (key.ctrl && (key.name === "v" || key.raw === "\x16")) {
        const { getClipboardText } = require("../theme.ts");
        const pasted = getClipboardText();
        if (pasted) {
          if (this.addActiveField === "email") {
            this.addEmailInput =
              this.addEmailInput.slice(0, this.addEmailCursor) +
              pasted +
              this.addEmailInput.slice(this.addEmailCursor);
            this.addEmailCursor += pasted.length;
          } else {
            this.addPasswordInput =
              this.addPasswordInput.slice(0, this.addPasswordCursor) +
              pasted +
              this.addPasswordInput.slice(this.addPasswordCursor);
            this.addPasswordCursor += pasted.length;
          }
          return true;
        }
      }
      // Single Ctrl+C in active field clears current field (normal CLI function)
      if (key.ctrl && key.name === "c") {
        if (this.addActiveField === "email") {
          this.addEmailInput = "";
          this.addEmailCursor = 0;
        } else {
          this.addPasswordInput = "";
          this.addPasswordCursor = 0;
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
        } else {
          if (this.addPasswordCursor > 0) {
            this.addPasswordInput =
              this.addPasswordInput.slice(0, this.addPasswordCursor - 1) +
              this.addPasswordInput.slice(this.addPasswordCursor);
            this.addPasswordCursor--;
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
        } else {
          if (this.addPasswordCursor < this.addPasswordInput.length) {
            this.addPasswordInput =
              this.addPasswordInput.slice(0, this.addPasswordCursor) +
              this.addPasswordInput.slice(this.addPasswordCursor + 1);
          }
        }
        return true;
      }

      // Save on Enter
      if (key.name === "return") {
        await this.saveModalAccount();
        return true;
      }
      // Type character into active field
      // Type character into active field at cursor position
      if (key.char && !key.ctrl && !key.meta && key.name !== "tab") {
        if (key.char >= " ") {
          if (this.addActiveField === "email") {
            this.addEmailInput =
              this.addEmailInput.slice(0, this.addEmailCursor) +
              key.char +
              this.addEmailInput.slice(this.addEmailCursor);
            this.addEmailCursor += key.char.length;
          } else {
            this.addPasswordInput =
              this.addPasswordInput.slice(0, this.addPasswordCursor) +
              key.char +
              this.addPasswordInput.slice(this.addPasswordCursor);
            this.addPasswordCursor += key.char.length;
          }
          return true;
        }
      }
      return true;
    }

    const accounts = this.statusData?.accounts || [];

    // Open Add Account modal with 'a'
    if (key.name === "a" && !key.ctrl) {
      this.isAddModalOpen = true;
      this.addEmailInput = "";
      this.addPasswordInput = "";
      this.addActiveField = "email";
      return true;
    }

    // Delete selected account with 'd'
    if (key.name === "d" && !key.ctrl) {
      const selected = accounts[this.selectedIndex];
      if (!selected) {
        this.setStatusMessage(theme.yellow("⚠️ Nenhuma conta selecionada para remover"));
        return true;
      }
      removeAccount(selected.id);
      await this.refresh();
      this.setStatusMessage(theme.green(`✓ Conta ${selected.emailOrName} removida com sucesso`));
      return true;
    }
    // Mouse hover on account rows or right panel actions
    if (key.name === "hover" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 46;

      // Account list rows start at row 8 (row 4=box border, 5=blank, 6=header, 7=divider)
      if (col >= 2 && col <= leftW - 1 && row >= 8 && row < 8 + accounts.length) {
        const hoverIdx = row - 8;
        if (this.hoveredAccountIndex !== hoverIdx) {
          this.hoveredAccountIndex = hoverIdx;
          return true;
        }
      } else if (this.hoveredAccountIndex !== null) {
        this.hoveredAccountIndex = null;
        return true;
      }

      // Right panel action buttons hover (rows 15 to 18)
      if (col >= leftW) {
        if (row >= 15 && row <= 18) {
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

      // Click on account row (rows 8, 9, ...)
      if (col >= 2 && col <= leftW - 1 && row >= 8 && row < 8 + accounts.length) {
        this.selectedIndex = row - 8;
        return true;
      }
      // Right panel action buttons click (rows 15, 16, 17, 18)
      if (col >= leftW) {
        if (row === 15) {
          await this.handleKey({ name: "a", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 16) {
          await this.handleKey({ name: "d", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 17) {
          await this.handleKey({ name: "c", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 18) {
          await this.handleKey({ name: "z", ctrl: false, shift: false, meta: false });
          return true;
        }
      }
    }
    // Navigate accounts list (Mouse wheel or Up/Down keys)
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

    // Refresh
    if (key.name === "r" && !key.ctrl) {
      await this.refresh();
      this.setStatusMessage(theme.green("✓ Lista de contas atualizada"));
      return true;
    }

    // Clear cooldown of all accounts
    if (key.name === "z" && !key.ctrl) {
      const cleared = resetAllCooldowns();
      await this.refresh();
      this.setStatusMessage(theme.green(`✓ Cooldowns zerados: ${cleared} conta(s) liberada(s)`));
      return true;
    }

    // Clear cooldown of selected account
    if (key.name === "c" && !key.ctrl) {
      const selected = accounts[this.selectedIndex];
      if (!selected) {
        this.setStatusMessage(theme.yellow("⚠ Nenhuma conta selecionada"));
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

    const data = snapshot || this.statusData;
    const accounts = data?.accounts || [];
    const selected = accounts[this.selectedIndex];

    // Left Panel: Accounts List Table
    const leftContent: string[] = [
      "",
      `  ${theme.dim("#   Conta                 Status")}`,
      `  ${theme.dim("───────────────────────────────────────")}`,
    ];

    if (accounts.length === 0) {
      leftContent.push("");
      leftContent.push(`  ${theme.yellow("Nenhuma conta configurada ainda.")}`);
      leftContent.push(`  ${theme.muted("Pressione ")}${theme.cyan("'a'")}${theme.muted(" ou use a opção ao lado para adicionar.")}`);
    } else {
      accounts.forEach((acc, idx) => {
        const isFocused = idx === this.selectedIndex;
        const isHovered = idx === this.hoveredAccountIndex;
        const pointer = isFocused ? theme.cyan(`${glyphs.pointer} `) : "  ";
        const num = pad(String(idx + 1) + ".", 4);
        const name = pad(acc.emailOrName, 22);

        let status = theme.green(`${glyphs.bullet} Pronto   `);
        if (acc.onCooldown) {
          const mins = Math.max(1, Math.round(acc.remainingCooldownMs / 60000));
          status = theme.yellow(`⚠ ${mins}m cd   `);
        }

        const line = `${pointer}${num}${name}${status}`;
        if (isHovered) {
          leftContent.push(theme.bgHover(line));
        } else if (isFocused) {
          leftContent.push(theme.bgSelected(line));
        } else {
          leftContent.push(line);
        }
      });
    }

    const leftBox = drawBox({
      title: `Contas (${accounts.length})`,
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
      rightContent.push(`  ${theme.dim("─────────────────────────────────")}`);
      rightContent.push(`  ${this.hoveredActionRow === 15 ? theme.bgHover(` ${theme.cyan(`[ a ] ${glyphs.plus} Adicionar Conta`)} `) : `${theme.cyan(`[ a ] ${glyphs.plus}`)} Adicionar Conta`}`);
    } else {
      const email = truncate(selected.emailOrName, 18);
      rightContent.push(`  ${theme.bold("Conta:")}      ${theme.cyan(email)}`);
      rightContent.push(`  ${theme.bold("Sistema ID:")} ${theme.muted(selected.id.slice(0, 14))}`);
      rightContent.push(`  ${theme.bold("Nível:")}      ${selected.priority}`);

      const cdStatus = selected.onCooldown
        ? theme.yellow(`⚠ Cooldown ${Math.round(selected.remainingCooldownMs / 60000)}m`)
        : theme.green(`${glyphs.check} Disponível`);
      rightContent.push(`  ${theme.bold("Estado:")}     ${cdStatus}`);

      const hStatus = selected.headersReady
        ? theme.green(`${glyphs.check} Capturados`)
        : theme.muted(`${glyphs.circle} Pendente`);
      rightContent.push(`  ${theme.bold("Headers:")}    ${hStatus}`);
      rightContent.push("");
      rightContent.push(`  ${theme.dim("─────────────────────────────────")}`);
      rightContent.push(`  ${this.hoveredActionRow === 15 ? theme.bgHover(` ${theme.cyan(`[ a ] ${glyphs.plus} Adicionar Conta`)} `) : `${theme.cyan(`[ a ] ${glyphs.plus}`)} Adicionar Conta`}`);
      rightContent.push(`  ${this.hoveredActionRow === 16 ? theme.bgHover(` ${theme.red(`[ d ] ${glyphs.remove} Remover Conta`)} `) : `${theme.red(`[ d ] ${glyphs.remove}`)} Remover Conta`}`);
      rightContent.push(`  ${this.hoveredActionRow === 17 ? theme.bgHover(` ${theme.yellow(`[ c ] ${glyphs.zap} Zerar Cooldown`)} `) : `${theme.yellow(`[ c ] ${glyphs.zap}`)} Zerar Cooldown`}`);
      rightContent.push(`  ${this.hoveredActionRow === 18 ? theme.bgHover(` ${theme.green(`[ z ] ${glyphs.zap} Zerar Todas`)} `) : `${theme.green(`[ z ] ${glyphs.zap}`)} Zerar Todas`}`);
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
    if (this.isAddModalOpen) {
      const modalW = Math.min(width - 4, 66);
      this.lastModalLeftPad = Math.max(0, Math.floor((width - modalW) / 2));

      const isEmail = this.addActiveField === "email";
      const isPass = this.addActiveField === "password";

      const emailHover = !isEmail && this.modalHoveredField === "email";
      const passHover = !isPass && this.modalHoveredField === "password";

      // Render Email field with clean cursor
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
          ? (emailHover ? theme.bgHover(` ${this.addEmailInput} `) : theme.cyan(` ${this.addEmailInput} `))
          : (emailHover ? theme.bgHover(" (digite o e-mail) ") : theme.muted(" (digite o e-mail) "));
      }

      // Render Password field with clean cursor
      let passDisplay: string;
      const maskedPass = "•".repeat(this.addPasswordInput.length);
      if (isPass) {
        if (this.addPasswordInput.length === 0) {
          passDisplay = `${theme.inverse(" ")} ${theme.dim("(digite a senha)")}`;
        } else {
          const before = maskedPass.slice(0, this.addPasswordCursor);
          const at = maskedPass[this.addPasswordCursor] || " ";
          const after = maskedPass.slice(this.addPasswordCursor + 1);
          passDisplay = `${theme.cyan(before)}${theme.inverse(at)}${theme.cyan(after)}`;
        }
      } else {
        passDisplay = this.addPasswordInput
          ? (passHover ? theme.bgHover(` ${maskedPass} `) : theme.cyan(` ${maskedPass} `))
          : (passHover ? theme.bgHover(" (digite a senha) ") : theme.muted(" (digite a senha) "));
      }
      const saveBtn =
        this.modalHoveredField === "save"
          ? theme.bgHover(theme.green(` [ Enter ] ${glyphs.enter} Salvar `))
          : theme.green(`[ Enter ] ${glyphs.enter} Salvar`);

      const cancelBtn =
        this.modalHoveredField === "cancel"
          ? theme.bgHover(theme.red(` [ Esc ] ${glyphs.cross} Cancelar `))
          : theme.muted(`[ Esc ] ${glyphs.cross} Cancelar`);
      const modalContent = [
        "",
        `  ${theme.bold("E-mail:")}  ${emailDisplay}`,
        `  ${theme.bold("Senha:")}   ${passDisplay}`,
        "",
        `  ${saveBtn}   ${cancelBtn}   ${theme.dim("(↑↓/mouse alternar)")}`,
      ];

      const modalBox = drawBox({
        title: "Adicionar Nova Conta Qwen (Login)",
        width: modalW,
        height: Math.min(contentH, 11),
        borderColor: theme.borderActive,
        titleColor: theme.cyan,
        content: modalContent,
      });

      const padStr = " ".repeat(this.lastModalLeftPad);
      return modalBox.map((line) => padStr + line);
    }

    return mergedLines;
  }
}
