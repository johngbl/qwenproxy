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
  private lastWidth = 80;
  private lastHeight = 24;
  private lastMaxOffset = 0;
  private lastVisibleCapacity = 0;
  private getChips(rawCount: number): {
    titlePrefix: string;
    chips: Array<{ id: "all" | "warn" | "error" | "copy" | "clear"; label: string; startCol: number; endCol: number }>;
  } {
    const titlePrefix = `Logs (${rawCount})  `;
    const copyLabel = this.copyNotification ? " [ Y ] Copiado! " : " [ Y ] Copiar ";
    const defs = [
      { id: "all" as const, label: " [ T ] Todos " },
      { id: "warn" as const, label: " [ W ] Avisos " },
      { id: "error" as const, label: " [ E ] Erros " },
      { id: "copy" as const, label: copyLabel },
      { id: "clear" as const, label: " [ C ] Limpar " },
    ];

    let currentCol = 4 + stringWidth(titlePrefix);
    const chips: Array<{ id: "all" | "warn" | "error" | "copy" | "clear"; label: string; startCol: number; endCol: number }> = [];

    for (let i = 0; i < defs.length; i++) {
      const d = defs[i];
      const w = stringWidth(d.label);
      const startCol = currentCol;
      const endCol = startCol + w - 1;
      chips.push({
        id: d.id,
        label: d.label,
        startCol: startCol - (i === 0 ? 1 : 0),
        endCol: endCol + 1,
      });
      currentCol += w;
    }
    return { titlePrefix, chips };
  }

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
    const { chips } = this.getChips(rawEntries.length);

    // Mouse hover on chips (accepts rows 3 to 5 for generous vertical target)
    if (key.name === "hover" && key.mouse && key.mouse.row >= 3 && key.mouse.row <= 5) {
      const col = key.mouse.col;
      let target: "all" | "warn" | "error" | "copy" | "clear" | null = null;
      for (const c of chips) {
        if (col >= c.startCol && col <= c.endCol) {
          target = c.id;
          break;
        }
      }
      if (this.hoveredChip !== target) {
        this.hoveredChip = target;
        return true;
      }
    } else if (this.hoveredChip !== null && key.mouse) {
      this.hoveredChip = null;
      return true;
    }

    // Mouse click on chips (accepts rows 3 to 5 for effortless immediate click matching tabs)
    if (key.name === "click" && key.mouse && key.mouse.row >= 3 && key.mouse.row <= 5) {
      const col = key.mouse.col;
      for (const c of chips) {
        if (col >= c.startCol && col <= c.endCol) {
          if (c.id === "all") {
            this.filter = "all";
            this.scrollOffset = 0;
            this.selectedLogIndex = null;
            return true;
          }
          if (c.id === "warn") {
            this.filter = "warn";
            this.scrollOffset = 0;
            this.selectedLogIndex = null;
            return true;
          }
          if (c.id === "error") {
            this.filter = "error";
            this.scrollOffset = 0;
            this.selectedLogIndex = null;
            return true;
          }
          if (c.id === "copy") {
            this.copyLogs();
            return true;
          }
          if (c.id === "clear") {
            ServerManager.getInstance().clearLogs();
            this.scrollOffset = 0;
            this.selectedLogIndex = null;
            return true;
          }
        }
      }
    }

    // Mouse click on scrollbar (accepts rows 4 to 7 + lastVisibleCapacity, cols width-3 to width)
    if (
      key.name === "click" &&
      key.mouse &&
      key.mouse.col >= this.lastWidth - 3 &&
      key.mouse.col <= this.lastWidth &&
      key.mouse.row >= 4 &&
      key.mouse.row <= 7 + this.lastVisibleCapacity
    ) {
      if (this.lastMaxOffset > 0 && this.lastVisibleCapacity > 0) {
        const r = key.mouse.row - 7;
        const pct = Math.max(0, Math.min(1, r / Math.max(1, this.lastVisibleCapacity - 1)));
        const targetScrollFromTop = Math.round(pct * this.lastMaxOffset);
        this.scrollOffset = Math.max(0, Math.min(this.lastMaxOffset, this.lastMaxOffset - targetScrollFromTop));
        this.selectedLogIndex = null;
        return true;
      }
    }

    // Mouse click on log rows (terminal row 7+, accounting for 2-line top margin)
    if (key.name === "click" && key.mouse && key.mouse.row >= 7) {
      const rowOffset = key.mouse.row - 7;
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
          this.scrollOffset = Math.max(0, Math.min(this.lastMaxOffset, this.lastTotalCount - this.lastVisibleCount - this.selectedLogIndex));
        }
      } else {
        this.scrollOffset = this.lastMaxOffset > 0 ? Math.min(this.lastMaxOffset, this.scrollOffset + 1) : this.scrollOffset + 1;
      }
      return true;
    }
    // Mouse wheel up
    if (key.name === "wheelup") {
      this.scrollOffset = this.lastMaxOffset > 0 ? Math.min(this.lastMaxOffset, this.scrollOffset + 2) : this.scrollOffset + 2;
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
      this.scrollOffset = this.lastMaxOffset > 0 ? Math.min(this.lastMaxOffset, this.scrollOffset + 10) : this.scrollOffset + 10;
      return true;
    }
    if (key.name === "pagedown") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      return true;
    }

    // Home / End
    if (key.name === "home") {
      this.scrollOffset = this.lastMaxOffset;
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
        if (!entry || !entry.message || !entry.message.trim()) continue;
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

    // Scroll Window with top margin breathing room (2 rows reserved at the top)
    const visibleCapacity = Math.max(1, contentH - 4);
    const total = formattedLines.length;
    const maxOffset = Math.max(0, total - visibleCapacity);
    this.lastWidth = width;
    this.lastHeight = height;
    this.lastMaxOffset = maxOffset;
    this.lastVisibleCapacity = visibleCapacity;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    const clampedOffset = this.scrollOffset;
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

    // Lines 0 and 1 are empty breathing margin between filter chips and logs
    const finalRows: string[] = ["", ""];
    const boxInnerW = Math.max(1, width - 2);

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
          const padded = pad(styledText, boxInnerW - 1);
          finalRows.push(`${padded}${scrollChar}`);
        } else {
          finalRows.push(styledText);
        }
      } else {
        finalRows.push("");
      }
    }

    const { titlePrefix } = this.getChips(rawEntries.length);
    const box = drawBox({
      title: `${titlePrefix}${allChip}${warnChip}${errChip}${copyChip}${clearChip}`,
      width,
      height: contentH,
      borderColor: theme.borderActive,
      titleColor: theme.cyan,
      content: finalRows,
    });
    return box;
  }
  private copyLogs(): void {
    const rawEntries = ServerManager.getInstance()
      .getLogEntries(this.filter)
      .filter((e) => e && e.message && e.message.trim().length > 0);
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
