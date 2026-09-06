/**
 * QwenProxy TUI - Server Logs View (Tab 6)
 * Real-time event log viewer with level filtering (All, Warnings, Errors).
 */

import type { TuiView } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, drawBox, stringWidth, truncate, pad, stripAnsi, setClipboardText } from "../theme.ts";
import { ServerManager } from "../server-manager.ts";

export class LogsView implements TuiView {
  public readonly id = "logs";
  public readonly title = "Logs";
  public readonly tabNumber = 6;

  private filter: "all" | "warn" | "error" = "all";
  private scrollOffset = 0; // 0 = at the bottom (follow newest)
  private hoveredChip: "all" | "warn" | "error" | "copy" | "clear" | null = null;
  private selectedLogIndex: number | null = null;
  private copyNotification = false;
  private copyTimeout: NodeJS.Timeout | null = null;
  private lastStartIndex = 0;
  private lastVisibleCount = 0;
  private lastTotalCount = 0;

  public getShortcuts(): Array<{ key: string; label: string }> {
    return [
      { key: "T", label: "Todos" },
      { key: "W", label: "Avisos" },
      { key: "E", label: "Erros" },
      { key: "Y", label: "Copiar" },
      { key: "C", label: "Limpar" },
      { key: "↑/↓", label: "Rolar" },
    ];
  }

  public handleKey(key: KeyEvent): boolean | void {
    const rawEntries = ServerManager.getInstance().getLogEntries(this.filter);
    const prefixW = stringWidth(`Logs (${rawEntries.length}) `) + 3;
    const copyLabel = this.copyNotification ? " [ Y ] Copiado! " : " [ Y ] Copiar ";

    const w1 = stringWidth(" [ T ] Todos ");
    const w2 = stringWidth(" [ W ] Avisos ");
    const w3 = stringWidth(" [ E ] Erros ");
    const w4 = stringWidth(copyLabel);
    const w5 = stringWidth(" [ C ] Limpar ");

    const c1Start = prefixW;
    const c1End = c1Start + w1;
    const c2Start = c1End;
    const c2End = c2Start + w2;
    const c3Start = c2End;
    const c3End = c3Start + w3;
    const c4Start = c3End;
    const c4End = c4Start + w4;
    const c5Start = c4End;
    const c5End = c5Start + w5;

    // Mouse hover on chips in row 4
    if (key.name === "hover" && key.mouse && key.mouse.row === 4) {
      const col = key.mouse.col;
      let target: "all" | "warn" | "error" | "copy" | "clear" | null = null;
      if (col >= c1Start && col < c1End) target = "all";
      else if (col >= c2Start && col < c2End) target = "warn";
      else if (col >= c3Start && col < c3End) target = "error";
      else if (col >= c4Start && col < c4End) target = "copy";
      else if (col >= c5Start && col < c5End) target = "clear";
      if (this.hoveredChip !== target) {
        this.hoveredChip = target;
        return true;
      }
    } else if (this.hoveredChip !== null && key.mouse) {
      this.hoveredChip = null;
      return true;
    }

    // Mouse click on chips in row 4
    if (key.name === "click" && key.mouse && key.mouse.row === 4) {
      const col = key.mouse.col;
      if (col >= c1Start && col < c1End) {
        this.filter = "all";
        this.scrollOffset = 0;
        this.selectedLogIndex = null;
        return true;
      }
      if (col >= c2Start && col < c2End) {
        this.filter = "warn";
        this.scrollOffset = 0;
        this.selectedLogIndex = null;
        return true;
      }
      if (col >= c3Start && col < c3End) {
        this.filter = "error";
        this.scrollOffset = 0;
        this.selectedLogIndex = null;
        return true;
      }
      if (col >= c4Start && col < c4End) {
        this.copyLogs();
        return true;
      }
      if (col >= c5Start && col < c5End) {
        ServerManager.getInstance().clearLogs();
        this.scrollOffset = 0;
        this.selectedLogIndex = null;
        return true;
      }
    }

    // Mouse click on log rows (rows 5+)
    if (key.name === "click" && key.mouse && key.mouse.row >= 5) {
      const rowOffset = key.mouse.row - 5;
      if (rowOffset >= 0 && rowOffset < this.lastVisibleCount) {
        const clickedIdx = this.lastStartIndex + rowOffset;
        if (this.selectedLogIndex === clickedIdx) {
          this.selectedLogIndex = null;
        } else {
          this.selectedLogIndex = clickedIdx;
        }
        return true;
      }
    }

    // Filter toggles
    if ((key.name === "t" || key.name === "T") && !key.ctrl) {
      this.filter = "all";
      this.scrollOffset = 0;
      this.selectedLogIndex = null;
      return true;
    }
    if ((key.name === "w" || key.name === "W") && !key.ctrl) {
      this.filter = "warn";
      this.scrollOffset = 0;
      this.selectedLogIndex = null;
      return true;
    }
    if ((key.name === "e" || key.name === "E") && !key.ctrl) {
      this.filter = "error";
      this.scrollOffset = 0;
      this.selectedLogIndex = null;
      return true;
    }

    // Clear logs with 'c'
    if ((key.name === "c" || key.name === "C") && !key.ctrl) {
      ServerManager.getInstance().clearLogs();
      this.scrollOffset = 0;
      this.selectedLogIndex = null;
      return true;
    }

    // Copy logs with 'y' or 'Y'
    if ((key.name === "y" || key.name === "Y") && !key.ctrl) {
      this.copyLogs();
      return true;
    }

    // Enter copies selected log if a row is selected
    if (key.name === "return" || key.name === "enter") {
      if (this.selectedLogIndex !== null) {
        this.copyLogs();
        return true;
      }
    }

    // Escape clears log selection
    if (key.name === "escape") {
      if (this.selectedLogIndex !== null) {
        this.selectedLogIndex = null;
        return true;
      }
    }

    // Navigate or scroll up (Up key, k)
    if (key.name === "up" || (key.name === "k" && !key.ctrl)) {
      if (this.selectedLogIndex !== null) {
        this.selectedLogIndex = Math.max(0, this.selectedLogIndex - 1);
        if (this.selectedLogIndex < this.lastStartIndex) {
          this.scrollOffset = Math.max(0, this.lastTotalCount - this.lastVisibleCount - this.selectedLogIndex);
        }
      } else {
        this.scrollOffset += 1;
      }
      return true;
    }

    // Mouse wheel up
    if (key.name === "wheelup") {
      this.scrollOffset += 2;
      return true;
    }

    // Navigate or scroll down (Down key, j)
    if (key.name === "down" || (key.name === "j" && !key.ctrl)) {
      if (this.selectedLogIndex !== null) {
        this.selectedLogIndex = Math.min(this.lastTotalCount - 1, this.selectedLogIndex + 1);
        if (this.selectedLogIndex >= this.lastStartIndex + this.lastVisibleCount) {
          this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        }
      } else {
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      }
      return true;
    }

    // Mouse wheel down
    if (key.name === "wheeldown") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 2);
      return true;
    }

    // Page Up / Page Down
    if (key.name === "pageup") {
      this.scrollOffset += 10;
      return true;
    }
    if (key.name === "pagedown") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      return true;
    }

    // Home / End
    if (key.name === "home") {
      this.scrollOffset = 500;
      return true;
    }
    if (key.name === "end") {
      this.scrollOffset = 0;
      return true;
    }
  }

  public render(width: number, height: number): string[] {
    const rawEntries = ServerManager.getInstance().getLogEntries(this.filter);
    const contentH = Math.max(8, height);
    const innerW = width - 4;

    // Filter Chips in Top Title
    const allChip =
      this.filter === "all"
        ? `\x1b[48;2;45;35;85m\x1b[38;2;247;248;252m [ T ] Todos \x1b[49m\x1b[39m`
        : this.hoveredChip === "all"
          ? theme.bgHover(" [ T ] Todos ")
          : theme.cyan(" [ T ] Todos ");

    const warnChip =
      this.filter === "warn"
        ? `\x1b[48;2;65;48;10m\x1b[38;2;242;178;45m [ W ] Avisos \x1b[49m\x1b[39m`
        : this.hoveredChip === "warn"
          ? theme.bgHover(" [ W ] Avisos ")
          : theme.yellow(" [ W ] Avisos ");

    const errChip =
      this.filter === "error"
        ? `\x1b[48;2;70;20;25m\x1b[38;2;252;109;109m [ E ] Erros \x1b[49m\x1b[39m`
        : this.hoveredChip === "error"
          ? theme.bgHover(" [ E ] Erros ")
          : theme.red(" [ E ] Erros ");

    const copyLabel = this.copyNotification ? " [ Y ] Copiado! " : " [ Y ] Copiar ";
    const copyChip =
      this.copyNotification
        ? `\x1b[48;2;15;50;35m\x1b[38;2;8;229;166m${copyLabel}\x1b[49m\x1b[39m`
        : this.hoveredChip === "copy"
          ? theme.bgHover(copyLabel)
          : theme.green(copyLabel);

    const clearChip =
      this.hoveredChip === "clear"
        ? theme.bgHover(" [ C ] Limpar ")
        : theme.muted(" [ C ] Limpar ");

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

        const prefix = `${theme.dim(entry.time)} ${tag} `;
        const prefixW = stringWidth(prefix);
        const maxMsgW = Math.max(20, innerW - prefixW - 4);
        const truncatedMsg = truncate(entry.message, maxMsgW);
        formattedLines.push(`${prefix}${truncatedMsg}`);
      }
    }

    this.lastTotalCount = formattedLines.length;

    // Scroll Window
    const visibleCapacity = Math.max(1, contentH - 2);
    const total = formattedLines.length;
    const maxOffset = Math.max(0, total - visibleCapacity);
    const clampedOffset = Math.min(this.scrollOffset, maxOffset);
    const scrollFromTop = maxOffset - clampedOffset;

    const startIndex = Math.max(0, total - visibleCapacity - clampedOffset);
    const visibleSlice = formattedLines.slice(startIndex, startIndex + visibleCapacity);

    this.lastStartIndex = startIndex;
    this.lastVisibleCount = visibleSlice.length;

    // Scrollbar calculation
    const hasScrollbar = total > visibleCapacity;
    const thumbSize = hasScrollbar
      ? Math.max(1, Math.round((visibleCapacity / total) * visibleCapacity))
      : 0;
    const trackRange = Math.max(1, visibleCapacity - thumbSize);
    const thumbTop = hasScrollbar
      ? Math.min(
          visibleCapacity - thumbSize,
          Math.max(0, Math.round((scrollFromTop / maxOffset) * trackRange)),
        )
      : 0;

    const finalRows: string[] = [];
    for (let r = 0; r < visibleCapacity; r++) {
      if (r < visibleSlice.length) {
        const actualIdx = startIndex + r;
        const rawLine = visibleSlice[r];
        let styledText = rawLine;
        if (this.selectedLogIndex === actualIdx) {
          styledText = theme.bgSelected(`▸ ${stripAnsi(rawLine)} `);
        } else {
          styledText = `  ${rawLine}`;
        }

        if (hasScrollbar) {
          const isThumb = r >= thumbTop && r < thumbTop + thumbSize;
          const scrollChar = isThumb ? theme.cyan("█") : theme.dark("│");
          const padded = pad(styledText, innerW - 1);
          finalRows.push(`${padded}${scrollChar}`);
        } else {
          finalRows.push(styledText);
        }
      } else {
        finalRows.push("");
      }
    }

    const scrollIndicator =
      clampedOffset > 0 ? theme.yellow(` [ Rolar: +${clampedOffset} ]`) : "";

    const box = drawBox({
      title: `Logs (${rawEntries.length}) ${allChip}${warnChip}${errChip}${copyChip}${clearChip}${scrollIndicator}`,
      width,
      height: contentH,
      borderColor: theme.borderActive,
      titleColor: theme.cyan,
      content: finalRows,
    });
    return box;
  }
  private copyLogs(): void {
    const rawEntries = ServerManager.getInstance().getLogEntries(this.filter);
    if (rawEntries.length === 0) return;

    let text = "";
    if (this.selectedLogIndex !== null && rawEntries[this.selectedLogIndex]) {
      const entry = rawEntries[this.selectedLogIndex];
      text = `[${entry.time}] [${entry.level}] ${entry.message}`;
    } else {
      text = rawEntries
        .map((entry) => `[${entry.time}] [${entry.level}] ${entry.message}`)
        .join("\n");
    }

    setClipboardText(text);
    this.copyNotification = true;
    if (this.copyTimeout) clearTimeout(this.copyTimeout);
    this.copyTimeout = setTimeout(() => {
      this.copyNotification = false;
    }, 2500);
  }
}
