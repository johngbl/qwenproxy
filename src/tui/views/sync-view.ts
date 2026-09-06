/**
 * QwenProxy TUI - Selective Client Sync View (Tab 3)
 */

import fs from "node:fs";
import type { TuiView } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, pad } from "../theme.ts";
import {
  syncAllClients,
  restoreAllClients,
  getDefaultPaths,
} from "../../sync/index.ts";
import { fetchLiveModels } from "../proxy-client.ts";

interface ClientOption {
  id: "claude-code" | "codex" | "opencode" | "omp";
  name: string;
  path: string;
  selected: boolean;
  detected: boolean;
}

export class SyncView implements TuiView {
  public readonly id = "sync";
  public readonly title = "Sync";
  public readonly tabNumber = 3;

  private clients: ClientOption[] = [];
  private selectedRowIndex = 0; // 0..3 for clients, 4 for model, 5 for sync button, 6 for rollback button
  private availableModels = [
    "qwen3.8-max",
    "qwen3.7-plus",
    "qwen3.7-max",
    "z-image-turbo",
    "qwen-image-3.0-pro",
    "wan3.0-video",
  ];
  private modelIndex = 0;
  private syncAllModels = true;
  private actionLog: string[] = [];
  private lastLeftW = 46;
  constructor() {
    this.detectClients();
  }

  public onActivate(): void {
    this.detectClients();
    void this.refreshModels();
  }

  private async refreshModels(): Promise<void> {
    try {
      const live = await fetchLiveModels();
      if (live && live.length > 0) {
        this.availableModels = live;
      }
    } catch {}
  }

  private detectClients(): void {
    const paths = getDefaultPaths();
    this.clients = [
      {
        id: "claude-code",
        name: "Claude Code",
        path: paths.claudeCode,
        selected: false,
        detected: fs.existsSync(paths.claudeCode),
      },
      {
        id: "codex",
        name: "OpenAI Codex",
        path: paths.codex,
        selected: false,
        detected: fs.existsSync(paths.codex),
      },
      {
        id: "opencode",
        name: "OpenCode",
        path: paths.openCode,
        selected: false,
        detected: fs.existsSync(paths.openCode),
      },
      {
        id: "omp",
        name: "OMP (Oh My Pi)",
        path: paths.omp,
        selected: false,
        detected: fs.existsSync(paths.omp),
      },
    ];
  }

  public getShortcuts(): Array<{ key: string; label: string }> {
    return [
      { key: "Espaço", label: "Marcar/Desmarcar" },
      { key: "Enter", label: "Sincronizar" },
      { key: "r", label: "Restaurar Backups" },
      { key: "a", label: "Alternar Todos" },
    ];
  }

  public async handleKey(key: KeyEvent): Promise<boolean | void> {
    // Mouse hover interactions
    if (key.name === "hover" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 46;
      if (col >= 2 && col <= leftW - 1) {
        if (row >= 8 && row <= 11) {
          const targetRow = row - 8;
          if (this.selectedRowIndex !== targetRow) {
            this.selectedRowIndex = targetRow;
            return true;
          }
        } else if (row === 14) {
          if (this.selectedRowIndex !== 4) {
            this.selectedRowIndex = 4;
            return true;
          }
        } else if (row === 15) {
          if (this.selectedRowIndex !== 5) {
            this.selectedRowIndex = 5;
            return true;
          }
        } else if (row === 18) {
          if (this.selectedRowIndex !== 6) {
            this.selectedRowIndex = 6;
            return true;
          }
        }
      }
    }

    // Mouse click interactions
    if (key.name === "click" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 46;
      if (col >= 2 && col <= leftW - 1) {
        // Rows 8, 9, 10, 11: Toggle client
        if (row >= 8 && row <= 11) {
          const client = this.clients[row - 8];
          if (client) {
            client.selected = !client.selected;
            this.selectedRowIndex = row - 8;
            return true;
          }
        }
        // Row 14: Model selector
        if (row === 14) {
          this.modelIndex = (this.modelIndex + 1) % this.availableModels.length;
          this.selectedRowIndex = 4;
          return true;
        }
        // Row 15: Scope selector
        if (row === 15) {
          this.syncAllModels = !this.syncAllModels;
          this.selectedRowIndex = 5;
          return true;
        }
        // Row 18: Action buttons
        if (row === 18) {
          if (col <= 26) {
            this.selectedRowIndex = 6;
            this.executeSync();
            return true;
          } else {
            this.executeRollback();
            return true;
          }
        }
      }
    }

    // Navigate rows (Mouse wheel or Up/Down keys)
    if (key.name === "up" || key.name === "wheelup" || (key.name === "k" && !key.ctrl)) {
      this.selectedRowIndex = Math.max(0, this.selectedRowIndex - 1);
      return true;
    }
    if (key.name === "down" || key.name === "wheeldown" || (key.name === "j" && !key.ctrl)) {
      this.selectedRowIndex = Math.min(6, this.selectedRowIndex + 1);
      return true;
    }

    // Toggle client selection with Space
    if (key.name === "space") {
      if (this.selectedRowIndex < 4) {
        const client = this.clients[this.selectedRowIndex];
        if (client) {
          client.selected = !client.selected;
        }
      } else if (this.selectedRowIndex === 4) {
        // Cycle model with space
        this.modelIndex = (this.modelIndex + 1) % this.availableModels.length;
      } else if (this.selectedRowIndex === 5) {
        this.syncAllModels = !this.syncAllModels;
      }
      return true;
    }

    // Cycle model left/right on row 4
    if (this.selectedRowIndex === 4 && (key.name === "left" || key.name === "right")) {
      if (key.name === "left") {
        this.modelIndex =
          (this.modelIndex - 1 + this.availableModels.length) %
          this.availableModels.length;
      } else {
        this.modelIndex = (this.modelIndex + 1) % this.availableModels.length;
      }
      return true;
    }

    // Toggle all with 'a'
    if (key.name === "a" && !key.ctrl) {
      const allSelected = this.clients.every((c) => c.selected);
      for (const c of this.clients) {
        c.selected = !allSelected;
      }
      this.actionLog.unshift(
        allSelected ? "Desmarcados todos os clientes." : "Selecionados todos os clientes.",
      );
      return true;
    }

    // Rollback with 'r'
    if ((key.name === "r" || key.name === "R") && !key.ctrl) {
      this.executeRollback();
      return true;
    }

    // Confirm action on Enter
    if (key.name === "return") {
      if (this.selectedRowIndex === 6) {
        this.executeRollback();
      } else {
        this.executeSync();
      }
      return true;
    }
  }

  private executeSync(): void {
    const selectedTargets = this.clients
      .filter((c) => c.selected)
      .map((c) => c.id);

    if (selectedTargets.length === 0) {
      this.actionLog.unshift(theme.yellow("⚠ Nenhum cliente selecionado para sincronizar."));
      return;
    }
    const currentModel = this.availableModels[this.modelIndex] || "qwen3.8-max";
    this.actionLog.unshift(
      theme.cyan(`⏳ Sincronizando [${selectedTargets.join(", ")}] com modelo ${currentModel}...`),
    );
    try {
      const res = syncAllClients({
        targets: selectedTargets,
      });

      let successCount = 0;
      for (const [key, clientRes] of Object.entries(res.clients)) {
        if (clientRes && clientRes.success) {
          successCount++;
          this.actionLog.unshift(
            theme.green(`✓ [${key}] ${clientRes.message || "Configurado com sucesso"}`),
          );
        } else if (clientRes) {
          this.actionLog.unshift(
            theme.red(`✗ [${key}] Falha: ${clientRes.error || "Erro desconhecido"}`),
          );
        }
      }

      this.actionLog.unshift(
        theme.green(`🎉 Concluído: ${successCount} cliente(s) sincronizado(s) com zero perdas!`),
      );
    } catch (err: any) {
      this.actionLog.unshift(theme.red(`✗ Erro ao sincronizar: ${err?.message || String(err)}`));
    }
  }

  private executeRollback(): void {
    this.actionLog.unshift(theme.yellow("⏳ Restaurando backups anteriores de configuração..."));
    try {
      const res = restoreAllClients();
      this.actionLog.unshift(
        theme.green(`✓ Rollback concluído: ${res.restoredCount} arquivo(s) restaurados com sucesso.`),
      );
    } catch (err: any) {
      this.actionLog.unshift(theme.red(`✗ Erro ao restaurar backups: ${err?.message || String(err)}`));
    }
  }

  public render(width: number, height: number): string[] {
    const contentH = Math.max(12, height);
    const leftW = Math.max(46, Math.floor(width * 0.52));
    this.lastLeftW = leftW;
    const rightW = Math.max(30, width - leftW - 1);

    // Left Panel: Options and Selectors
    const leftContent: string[] = [
      "",
      `  ${theme.bold("Clientes:")} (Espaço para marcar)`,
      "",
    ];

    this.clients.forEach((c, idx) => {
      const isFocused = this.selectedRowIndex === idx;
      const pointer = isFocused ? theme.cyan(`${glyphs.pointer} `) : "  ";
      const check = c.selected ? theme.green(glyphs.checkOn) : theme.muted(glyphs.checkOff);
      const name = pad(c.name, 18);
      const status = c.detected
        ? theme.green(`${glyphs.bullet} Detectado`)
        : theme.muted(`${glyphs.circle} Criará novo`);

      const line = `${pointer}${check} ${name} ${status}`;
      leftContent.push(isFocused ? theme.bgSelected(line) : line);
    });

    leftContent.push("");
    leftContent.push(`  ${theme.bold("Modelo:")}`);

    // Row index 4: Model Selector
    const isModelFocused = this.selectedRowIndex === 4;
    const modelPointer = isModelFocused ? theme.cyan(`${glyphs.pointer} `) : "  ";
    const currentModel = this.availableModels[this.modelIndex] || "qwen3.8-max";
    const modelText = `${currentModel} (${this.modelIndex + 1}/${this.availableModels.length})`;

    const modelLine = this.syncAllModels
      ? `${modelPointer}${theme.dim(`${modelText}`)}`
      : `${modelPointer}${theme.cyan(modelText)}`;

    leftContent.push(isModelFocused ? theme.bgSelected(modelLine) : modelLine);

    // Row index 5: Scope Selector
    const isScopeFocused = this.selectedRowIndex === 5;
    const scopePointer = isScopeFocused ? theme.cyan(`${glyphs.pointer} `) : "  ";
    const scopeCheck = this.syncAllModels ? theme.green(glyphs.radioOn) : theme.muted(glyphs.radioOff);
    const scopeLine = `${scopePointer}${scopeCheck} Registrar todos os modelos`;
    leftContent.push(isScopeFocused ? theme.bgSelected(scopeLine) : scopeLine);
    leftContent.push("");
    leftContent.push(`  ${theme.bold("Ações:")}`);
    // Row index 6: Buttons
    const isSyncButtonFocused = this.selectedRowIndex === 6;
    const actionLine = isSyncButtonFocused
      ? `  ${theme.bgSelected(" [ Enter ] Sincronizar ")}   ${theme.dim("[ R ] Restaurar")}`
      : `  ${theme.blue("[ Enter ] Sincronizar")}   ${theme.yellow("[ R ] Restaurar")}`;
    leftContent.push(actionLine);

    const leftBox = drawBox({
      title: "Configurar",
      width: leftW,
      height: contentH,
      borderColor: theme.borderActive,
      titleColor: theme.blue,
      content: leftContent,
    });

    // Right Panel: Action Log & Backups
    const rightContent: string[] = [
      "",
      `  ${theme.bold("Histórico:")}`,
      `  ${theme.dim("───────────────────────────────────────")}`,
    ];

    if (this.actionLog.length === 0) {
      rightContent.push("");
      rightContent.push(theme.muted("  Nenhuma sincronização recente executada nesta sessão."));
      rightContent.push("");
      rightContent.push(
        theme.muted("  Pressione [ Enter ] para sincronizar os clientes selecionados."),
      );
      rightContent.push(
        theme.muted("  Backups (.bak) são criados automaticamente antes de cada alteração."),
      );
    } else {
      for (const log of this.actionLog.slice(0, contentH - 5)) {
        rightContent.push(`  ${log}`);
      }
    }
    const rightBox = drawBox({
      title: "Histórico & Backups",
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

    return mergedLines;
  }
}
