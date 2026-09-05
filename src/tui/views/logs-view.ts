/**
 * QwenProxy TUI - Server Logs View (Tab 6)
 * Real-time event log viewer with level filtering (All, Warnings, Errors).
 */

import type { TuiView } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, drawBox, stringWidth, truncate } from "../theme.ts";
import { ServerManager, type ServerLogEntry } from "../server-manager.ts";

export class LogsView implements TuiView {
  public readonly id = "logs";
  public readonly title = "Logs";
  public readonly tabNumber = 6;

  private filter: "all" | "warn" | "error" = "all";
  private scrollOffset = 0; // 0 = at the bottom (follow newest)
  private autoScroll = true;

  public getShortcuts(): Array<{ key: string; label: string }> {
    return [
      { key: "t", label: "Todos" },
      { key: "w", label: "Avisos" },
      { key: "e", label: "Erros" },
      { key: "c", label: "Limpar" },
      { key: "↑/↓", label: "Rolar" },
    ];
  }

  public handleKey(key: KeyEvent): boolean | void {
    // Mouse click on filter chips in row 4
    if (key.name === "click" && key.mouse && key.mouse.row === 4) {
      const col = key.mouse.col;
      if (col >= 6 && col <= 18) {
        this.filter = "all";
        this.scrollOffset = 0;
        this.autoScroll = true;
        return true;
      }
      if (col >= 19 && col <= 31) {
        this.filter = "warn";
        this.scrollOffset = 0;
        this.autoScroll = true;
        return true;
      }
      if (col >= 32 && col <= 44) {
        this.filter = "error";
        this.scrollOffset = 0;
        this.autoScroll = true;
        return true;
      }
    }

    // Filter toggles
    if (key.name === "t" && !key.ctrl) {
      this.filter = "all";
      this.scrollOffset = 0;
      this.autoScroll = true;
      return true;
    }
    if (key.name === "w" && !key.ctrl) {
      this.filter = "warn";
      this.scrollOffset = 0;
      this.autoScroll = true;
      return true;
    }
    if (key.name === "e" && !key.ctrl) {
      this.filter = "error";
      this.scrollOffset = 0;
      this.autoScroll = true;
      return true;
    }

    // Clear logs with 'c'
    if (key.name === "c" && !key.ctrl) {
      ServerManager.getInstance().clearLogs();
      this.scrollOffset = 0;
      this.autoScroll = true;
      return true;
    }

    // Scroll up (Mouse wheel up: 2 lines, Up key: 1 line)
    if (key.name === "up" || key.name === "wheelup" || (key.name === "k" && !key.ctrl)) {
      this.scrollOffset += key.name === "wheelup" ? 2 : 1;
      this.autoScroll = false;
      return true;
    }

    // Scroll down (Mouse wheel down: 2 lines, Down key: 1 line)
    if (key.name === "down" || key.name === "wheeldown" || (key.name === "j" && !key.ctrl)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - (key.name === "wheeldown" ? 2 : 1));
      if (this.scrollOffset === 0) {
        this.autoScroll = true;
      }
      return true;
    }
    // Page Up / Page Down
    if (key.name === "pageup") {
      this.scrollOffset += 10;
      this.autoScroll = false;
      return true;
    }
    if (key.name === "pagedown") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      if (this.scrollOffset === 0) {
        this.autoScroll = true;
      }
      return true;
    }

    // Home / End
    if (key.name === "home") {
      this.scrollOffset = 500;
      this.autoScroll = false;
      return true;
    }
    if (key.name === "end") {
      this.scrollOffset = 0;
      this.autoScroll = true;
      return true;
    }
  }

  public render(width: number, height: number): string[] {
    const rawEntries = ServerManager.getInstance().getLogEntries(this.filter);
    const contentH = Math.max(8, height - 2);
    const innerW = width - 4;

    // Filter Chips in Top Title
    const allChip =
      this.filter === "all" ? theme.bgSelected(" [t] Todos ") : theme.dim(" [t] Todos ");
    const warnChip =
      this.filter === "warn" ? theme.bgSelected(" [w] Avisos ") : theme.dim(" [w] Avisos ");
    const errChip =
      this.filter === "error" ? theme.bgSelected(" [e] Erros ") : theme.dim(" [e] Erros ");

    const formattedLines: string[] = [];

    if (rawEntries.length === 0) {
      formattedLines.push("");
      formattedLines.push(
        theme.muted(`  Nenhum log registrado para o filtro atual [${this.filter}].`),
      );
      formattedLines.push(
        theme.muted("  Eventos de inicialização, requisições e alertas do proxy aparecerão aqui."),
      );
    } else {
      for (const entry of rawEntries) {
        let tag = theme.dim("[INFO]");
        if (entry.level === "WARN") {
          tag = theme.yellow("[WARN]");
        } else if (entry.level === "ERROR") {
          tag = theme.red("[ERR]");
        }

        const prefix = `  ${theme.dim(entry.time)} ${tag} `;
        const prefixW = stringWidth(prefix);
        const maxMsgW = Math.max(20, innerW - prefixW);
        const truncatedMsg = truncate(entry.message, maxMsgW);
        formattedLines.push(`${prefix}${truncatedMsg}`);
      }
    }

    // Scroll Window
    const visibleCapacity = contentH;
    const maxOffset = Math.max(0, formattedLines.length - visibleCapacity);
    const clampedOffset = Math.min(this.scrollOffset, maxOffset);
    const startIndex = Math.max(0, formattedLines.length - visibleCapacity - clampedOffset);
    const visibleLines = formattedLines.slice(startIndex, startIndex + visibleCapacity);

    const scrollIndicator =
      clampedOffset > 0 ? theme.yellow(` [ Rolar: +${clampedOffset} ] `) : "";

    const box = drawBox({
      title: `Logs ${allChip} ${warnChip} ${errChip} (${rawEntries.length})${scrollIndicator}`,
      width,
      height,
      borderColor: theme.borderActive,
      titleColor: theme.cyan,
      content: visibleLines,
    });
    return box;
  }
}
