/**
 * QwenProxy TUI - Storage & Cache Management View (Tab 4)
 */

import fs from "node:fs";
import path from "node:path";
import type { TuiView } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, pad } from "../theme.ts";
import { pruneAllPlaywrightProfiles } from "../../services/playwright.ts";
import { getProfilesDir } from "../../core/paths.ts";
import {
  formatBytes,
  getDirStats,
  cleanPlaywrightBrowsers,
} from "../../clean-cache.ts";
import { loadAccounts } from "../../core/accounts.ts";
import { maskAccountIdentifier, resetAllCooldowns } from "../proxy-client.ts";

export class StorageView implements TuiView {
  public readonly id = "storage";
  public readonly title = "Storage";
  public readonly tabNumber = 4;

  private profilesTotalBytes = 0;
  private profilesCount = 0;
  private profileStats: Array<{ name: string; size: string; files: number }> = [];

  private activeBrowser = "--";
  private unusedBrowsersCount = 0;
  private reclaimableBrowserBytes = 0;

  private actionLogs: string[] = [];
  private isScanning = false;

  private addLog(message: string): void {
    this.actionLogs.push(message);
    if (this.actionLogs.length > 50) {
      this.actionLogs.shift();
    }
  }

  constructor() {
    this.refresh();
  }
  private hoveredActionRow: number | null = null;
  private lastLeftW = 48;
  public getShortcuts(): Array<{ key: string; label: string }> {
    return [
      { key: "p", label: "Podar Caches" },
      { key: "b", label: "Limpar Navegadores" },
      { key: "z", label: "Zerar Cooldowns" },
      { key: "r", label: "Atualizar Disco" },
    ];
  }

  public async refresh(): Promise<void> {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      // 1. Scan profiles
      const profilesDir = getProfilesDir();
      let totalBytes = 0;
      let count = 0;
      this.profileStats = [];
      if (fs.existsSync(profilesDir)) {
        const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            count++;
            const fullPath = path.join(profilesDir, entry.name);
            const stats = getDirStats(fullPath);
            totalBytes += stats.bytes;
            this.profileStats.push({
              name: entry.name,
              size: formatBytes(stats.bytes),
              files: stats.files,
            });
          }
        }
      }
      this.profilesTotalBytes = totalBytes;
      this.profilesCount = count;

      // 2. Scan Playwright browsers
      const browserRes = await cleanPlaywrightBrowsers(false);
      this.activeBrowser = browserRes.activeBrowserDir || "chromium";
      this.unusedBrowsersCount = browserRes.unusedDirs.length;
      this.reclaimableBrowserBytes = browserRes.unusedDirs.reduce(
        (acc, d) => acc + d.bytes,
        0,
      );
    } catch (err: any) {
      this.addLog(
        theme.red(`✗ Erro ao calcular armazenamento: ${err?.message || String(err)}`),
      );
    } finally {
      this.isScanning = false;
    }
  }

  public async handleKey(key: KeyEvent): Promise<boolean | void> {
    // Mouse hover over quick actions
    if (key.name === "hover" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 48;
      if (col >= 2 && col <= leftW - 1 && row >= 13 && row <= 16) {
        if (this.hoveredActionRow !== row) {
          this.hoveredActionRow = row;
          return true;
        }
      } else if (this.hoveredActionRow !== null) {
        this.hoveredActionRow = null;
        return true;
      }
    }

    // Mouse click interactions
    if (key.name === "click" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 48;
      if (col >= 2 && col <= leftW - 1) {
        if (row === 13) {
          this.handleKey({ name: "p", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 14) {
          this.handleKey({ name: "b", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 15) {
          this.handleKey({ name: "z", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 16) {
          this.handleKey({ name: "r", ctrl: false, shift: false, meta: false });
          return true;
        }
      }
    }

    // Reset cooldowns with 'z'
    if ((key.name === "z" || key.name === "Z") && !key.ctrl) {
      const cleared = resetAllCooldowns();
      this.addLog(
        theme.green(`✓ Cooldowns zerados: ${cleared} conta(s) destravada(s)`),
      );
      return true;
    }

    // Refresh storage stats
    if ((key.name === "r" || key.name === "R") && !key.ctrl) {
      await this.refresh();
      this.addLog(
        theme.green(`✓ Medições atualizadas: ${formatBytes(this.profilesTotalBytes)} em ${this.profilesCount} perfil(is)`),
      );
      return true;
    }
    // Prune profile caches
    if ((key.name === "p" || key.name === "P") && !key.ctrl) {
      try {
        const res = pruneAllPlaywrightProfiles();
        this.addLog(
          theme.green(
            `✓ Caches limpos: ${formatBytes(res.totalFreedBytes)} liberados em ${res.totalFreedFiles} arquivos (${res.profilesCleaned} perfis)`,
          ),
        );
        await this.refresh();
      } catch (err: any) {
        this.addLog(theme.red(`✗ Falha ao limpar perfis: ${err?.message || String(err)}`));
      }
      return true;
    }

    // Clean unused playwright browsers
    if ((key.name === "b" || key.name === "B") && !key.ctrl) {
      try {
        const res = await cleanPlaywrightBrowsers(true);
        if (res.freedBytes > 0 || res.unusedDirs.length > 0) {
          this.addLog(
            theme.green(
              `✓ Navegadores limpos: ${formatBytes(res.freedBytes)} recuperados no SSD (${res.unusedDirs.length} versões removidas)`,
            ),
          );
        } else {
          this.addLog(
            theme.green(
              `✓ Navegadores verificados: nenhum navegador antigo encontrado`,
            ),
          );
        }
        await this.refresh();
      } catch (err: any) {
        this.addLog(
          theme.red(`✗ Falha ao remover navegadores: ${err?.message || String(err)}`),
        );
      }
      return true;
    }
  }
  public render(width: number, height: number): string[] {
    const contentH = Math.max(12, height);
    const leftW = Math.max(48, Math.floor(width * 0.48));
    this.lastLeftW = leftW;
    const rightW = Math.max(34, width - leftW - 1);

    // Map account directory UUIDs to real user emails
    const accountMap = new Map<string, string>();
    try {
      const accs = loadAccounts();
      for (const a of accs) {
        accountMap.set(a.id, maskAccountIdentifier(a.email || a.id));
      }
    } catch {}

    // Left Panel: Storage Diagnostics
    const unusedStatus =
      this.unusedBrowsersCount > 0
        ? theme.yellow(`${glyphs.bullet} ${formatBytes(this.reclaimableBrowserBytes)} (${this.unusedBrowsersCount} versões)`)
        : theme.green("✓ Nenhum");

    const leftContent: string[] = [
      "",
      `  ${theme.bold(theme.white("Armazenamento dos Perfis:"))}`,
      `    ${theme.dim("Perfis Qwen:")}         ${theme.cyan(formatBytes(this.profilesTotalBytes))} ${theme.muted(`(${this.profilesCount} conta${this.profilesCount === 1 ? "" : "s"})`)}`,
      `    ${theme.dim("Navegador Ativo:")}     ${theme.green(`${glyphs.bullet} ${this.activeBrowser}`)}`,
      `    ${theme.dim("Navegadores Antigos:")} ${unusedStatus}`,
      `    ${theme.dim("Integridade:")}         ${theme.green("✓ Sessões salvas")}`,
      "",
      `  ${theme.bold(theme.white("Ações Rápidas:"))}`,
      `    ${this.hoveredActionRow === 13 ? theme.bgHover(` ${theme.cyan("[ P ] Podar Caches")} `) : `${theme.cyan("[ P ]")} Podar Caches`}`,
      `    ${this.hoveredActionRow === 14 ? theme.bgHover(` ${theme.yellow("[ B ] Limpar Navegadores")} `) : `${theme.yellow("[ B ]")} Limpar Navegadores`}`,
      `    ${this.hoveredActionRow === 15 ? theme.bgHover(` ${theme.green("[ Z ] Zerar Todos os Cooldowns")} `) : `${theme.green("[ Z ]")} Zerar Todos os Cooldowns`}`,
      `    ${this.hoveredActionRow === 16 ? theme.bgHover(` ${theme.muted("[ R ] Atualizar Disco")} `) : `${theme.muted("[ R ]")} Atualizar Disco`}`,
      "",
    ];

    const leftBox = drawBox({
      title: "Espaço em Disco",
      width: leftW,
      height: contentH,
      borderColor: theme.borderInactive,
      titleColor: theme.cyan,
      content: leftContent,
    });

    // Right Panel: Account Profiles & Optimization Logs
    const rightContent: string[] = [
      "",
      `  ${theme.bold(theme.white("Perfis de Conta no Disco:"))}`,
      `  ${theme.dim("#   Conta                 Tamanho       Arquivos")}`,
      `  ${theme.dim("──────────────────────────────────────────────────────────")}`,
    ];

    if (this.profileStats.length === 0) {
      rightContent.push(`  ${theme.muted("Nenhum perfil de navegador inicializado ainda.")}`);
    } else {
      this.profileStats.forEach((p, idx) => {
        const num = pad(String(idx + 1) + ".", 4);
        const rawName = accountMap.get(p.name) || maskAccountIdentifier(p.name);
        const name = pad(rawName, 22);
        rightContent.push(
          `  ${theme.dim(num)}${theme.white(name)}  ${theme.cyan(pad(p.size, 12))}  ${theme.muted(p.files + " arq")}`,
        );
      });
    }

    rightContent.push("");
    rightContent.push(`  ${theme.bold(theme.white("Histórico de Otimizações:"))}`);
    rightContent.push(`  ${theme.dim("──────────────────────────────────────────────────────────")}`);

    if (this.actionLogs.length === 0) {
      rightContent.push(theme.muted("  Nenhuma otimização executada nesta sessão."));
      rightContent.push(theme.muted("  Execute uma das Ações Rápidas ao lado para otimizar o disco."));
    } else {
      const maxLogs = Math.max(1, contentH - 12);
      const visibleLogs = this.actionLogs.slice(-maxLogs);
      for (const log of visibleLogs) {
        rightContent.push(`  ${log}`);
      }
    }
    const rightBox = drawBox({
      title: "Perfis & Histórico",
      width: rightW,
      height: contentH,
      borderColor: theme.borderInactive,
      titleColor: theme.cyan,
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
