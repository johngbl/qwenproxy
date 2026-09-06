/**
 * QwenProxy TUI - Status and Live Dashboard View (Tab 1)
 */

import type { TuiView, ProxyStatusSnapshot } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, pad } from "../theme.ts";
import { fetchProxyStatus, resetAllCooldowns, formatUptime } from "../proxy-client.ts";
import { ServerManager } from "../server-manager.ts";

export class StatusView implements TuiView {
  public readonly id = "status";
  public readonly title = "Status";
  public readonly tabNumber = 1;

  private statusData: ProxyStatusSnapshot | null = null;
  private actionMessage = "";
  private actionMessageTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.refresh();
  }

  public async refresh(): Promise<void> {
    try {
      this.statusData = await fetchProxyStatus();
    } catch {}
  }

  public onActivate(): void {
    this.refresh();
  }

  public getShortcuts(): Array<{ key: string; label: string }> {
    return [
      { key: "r", label: "Recarregar" },
      { key: "z", label: "Zerar Cooldowns" },
    ];
  }

  private setMessage(msg: string): void {
    this.actionMessage = msg;
    clearTimeout(this.actionMessageTimeout!);
    this.actionMessageTimeout = setTimeout(() => {
      this.actionMessage = "";
    }, 4000);
  }

  public async handleKey(key: KeyEvent): Promise<boolean | void> {
    if (key.name === "r" && !key.ctrl) {
      await this.refresh();
      this.setMessage(theme.green("✓ Status atualizado"));
      return true;
    }

    if (key.name === "z" && !key.ctrl) {
      const cleared = resetAllCooldowns();
      await this.refresh();
      this.setMessage(theme.green(`✓ Cooldowns zerados: ${cleared} conta(s) liberada(s)`));
      return true;
    }
  }

  public render(width: number, height: number, snapshot?: ProxyStatusSnapshot | null): string[] {
    const data = snapshot || this.statusData;
    const isOnline = data?.online ?? false;
    const contentH = Math.max(10, height);

    // Two-column layout
    const leftW = Math.max(34, Math.floor(width * 0.42));
    const rightW = Math.max(34, width - leftW - 1);

    // Left Column: System & Proxy Status
    const serverState = ServerManager.getInstance().getState();
    let onlineBadge: string;
    if (isOnline || serverState === "online") {
      onlineBadge = theme.green(`${glyphs.bullet} Online`);
    } else if (serverState === "warming") {
      onlineBadge = theme.yellow(`🟡 Iniciando...`);
    } else if (serverState === "error") {
      onlineBadge = theme.red(`✗ Erro`);
    } else {
      onlineBadge = theme.muted(`${glyphs.circle} Offline`);
    }

    const uptimeSecs = data?.uptimeSeconds || Math.floor(process.uptime());
    const uptimeStr = formatUptime(uptimeSecs);

    const baseUrl = `http://${data?.host || "127.0.0.1"}:${data?.port || 7936}/v1`;

    const leftContent = [
      "",
      `  ${theme.bold("Status:")}     ${onlineBadge}`,
      `  ${theme.bold("Base URL:")}   ${theme.cyan(baseUrl)}`,
      `  ${theme.bold("Uptime:")}     ${theme.cyan(uptimeStr)}`,
      `  ${theme.bold("RAM:")}        ${theme.cyan(String(data?.rssMb || 0) + " MB")}`,
      `  ${theme.bold("Conexões:")}   ${data?.activeStreams ? theme.yellow(String(data.activeStreams) + " ativas") : "0 ativas"}`,
      "",
      this.actionMessage ? `  ${this.actionMessage}` : "",
    ];

    const leftBox = drawBox({
      title: "Sistema",
      width: leftW,
      height: contentH,
      borderColor: theme.borderInactive,
      titleColor: theme.cyan,
      content: leftContent,
    });

    // Right Column: Accounts Pool Status
    const accounts = data?.accounts || [];
    const readyCount = accounts.filter((a) => !a.onCooldown).length;
    const cooldownCount = accounts.filter((a) => a.onCooldown).length;

    const rightContent: string[] = [
      "",
      `  ${theme.dim("#   Conta                 Status")}`,
      `  ${theme.dim("───────────────────────────────────────")}`,
    ];

    if (accounts.length === 0) {
      rightContent.push(`  ${theme.muted("Nenhuma conta adicionada. (Vá em [5] Contas)")}`);
    } else {
      accounts.slice(0, contentH - 5).forEach((acc, idx) => {
        const num = pad(String(idx + 1), 3);
        const name = pad(acc.emailOrName, 22);
        let status = theme.green(`${glyphs.bullet} Pronto`);
        if (acc.onCooldown) {
          const mins = Math.max(1, Math.round(acc.remainingCooldownMs / 60000));
          status = theme.yellow(`⚠ Cooldown ${mins}m`);
        }
        rightContent.push(`  ${num} ${name} ${status}`);
      });
    }

    const rightBox = drawBox({
      title: `Contas (${readyCount}/${accounts.length})`,
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
