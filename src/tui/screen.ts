/**
 * QwenProxy TUI - Screen Buffer, Resize Listener & Raw Keyboard Engine
 */

import readline from "node:readline";
import fs from "node:fs";
import { ANSI, theme, pad } from "./theme.ts";
import { ServerManager } from "./server-manager.ts";
export interface MouseInfo {
  type: "click" | "release" | "drag" | "scroll-up" | "scroll-down" | "hover";
  button?: "left" | "right";
  col: number;
  row: number;
}

export interface KeyEvent {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  raw?: string;
  char?: string;
  mouse?: MouseInfo;
}
export type KeyHandler = (key: KeyEvent) => void;
export type ResizeHandler = (cols: number, rows: number) => void;
export class Screen {
  private active = false;
  private keyListeners: Set<KeyHandler> = new Set();
  private resizeListeners: Set<ResizeHandler> = new Set();
  private keypressHandler: ((ch: string | undefined, key: any) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private exitHandler: (() => void) | null = null;
  private prevRenderedRows: string[] = [];
  private originalStdinEmit: typeof process.stdin.emit | null = null;
  private lastHoverCol = -1;
  private lastHoverRow = -1;
  private lastHoverTime = 0;
  private pendingHoverTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.exitHandler = () => this.stop();
  }

  public start(): boolean {
    if (this.active) return true;
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      return false;
    }

    this.active = true;
    this.prevRenderedRows = [];
    // Switch to alternate screen buffer, clear screen, hide cursor, and enable mouse tracking
    ServerManager.getInstance().withTuiRendering(() => {
      process.stdout.write(
        ANSI.enterAltScreen + "\x1b[2J" + ANSI.cursorHome + ANSI.hideCursor + ANSI.enableMouse,
      );
    });
    // Setup raw keyboard input
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    readline.emitKeypressEvents(process.stdin);

    // Intercept stdin 'data' to capture SGR mouse wheel sequences before readline
    this.originalStdinEmit = process.stdin.emit.bind(process.stdin);
    const self = this;
    process.stdin.emit = function (event: string, ...args: any[]) {
      if (event === "data" && args[0] && self.active) {
        const str = typeof args[0] === "string" ? args[0] : args[0].toString();
        const mouseRegex = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
        let match: RegExpExecArray | null;
        let handled = false;
        while ((match = mouseRegex.exec(str)) !== null) {
          handled = true;
          const btn = parseInt(match[1], 10);
          const col = parseInt(match[2], 10);
          const row = parseInt(match[3], 10);
          const isRelease = match[4] === "m";

          if (btn === 64) {
            self.dispatchKey({
              name: "wheelup",
              ctrl: false,
              shift: false,
              meta: false,
              mouse: { type: "scroll-up", col, row },
            });
          } else if (btn === 65) {
            self.dispatchKey({
              name: "wheeldown",
              ctrl: false,
              shift: false,
              meta: false,
              mouse: { type: "scroll-down", col, row },
            });
          } else if (isRelease) {
            self.dispatchKey({
              name: "release",
              ctrl: false,
              shift: false,
              meta: false,
              mouse: { type: "release", button: btn === 0 ? "left" : "right", col, row },
            });
          } else if (btn === 0 && !isRelease) {
            self.dispatchKey({
              name: "click",
              ctrl: false,
              shift: false,
              meta: false,
              mouse: { type: "click", button: "left", col, row },
            });
          } else if (btn === 32) {
            self.dispatchKey({
              name: "drag",
              ctrl: false,
              shift: false,
              meta: false,
              mouse: { type: "drag", button: "left", col, row },
            });
          } else if (btn === 35) {
            if (col === self.lastHoverCol && row === self.lastHoverRow) {
              continue;
            }
            const now = Date.now();
            const timeSinceLast = now - self.lastHoverTime;
            const emitHover = (c: number, r: number) => {
              if (!self.active) return;
              self.lastHoverCol = c;
              self.lastHoverRow = r;
              self.lastHoverTime = Date.now();
              self.dispatchKey({
                name: "hover",
                ctrl: false,
                shift: false,
                meta: false,
                mouse: { type: "hover", col: c, row: r },
              });
            };

            if (timeSinceLast >= 30) {
              if (self.pendingHoverTimeout) {
                clearTimeout(self.pendingHoverTimeout);
                self.pendingHoverTimeout = null;
              }
              emitHover(col, row);
            } else {
              if (self.pendingHoverTimeout) {
                clearTimeout(self.pendingHoverTimeout);
              }
              self.pendingHoverTimeout = setTimeout(() => {
                self.pendingHoverTimeout = null;
                if (col !== self.lastHoverCol || row !== self.lastHoverRow) {
                  emitHover(col, row);
                }
              }, 30 - timeSinceLast);
            }
          }
        }
        if (handled) {
          return true;
        }
      }
      return self.originalStdinEmit!.apply(process.stdin, [event, ...args] as any);
    } as any;

    this.keypressHandler = (_ch: string | undefined, key: any) => {
      if (!this.active || !key) return;

      let name = key.name || "";
      let shift = Boolean(key.shift);
      if (key.sequence === "\x1b[Z") {
        name = "tab";
        shift = true;
      }

      // Suppress control characters from event.char
      const isControlChar =
        _ch && (_ch === "\t" || _ch === "\r" || _ch === "\n" || _ch < " ");
      const char = isControlChar ? undefined : _ch;

      const event: KeyEvent = {
        name,
        ctrl: Boolean(key.ctrl),
        shift,
        meta: Boolean(key.meta),
        raw: key.sequence,
        char,
      };

      // Direct Ctrl+C fallback to exit cleanly
      this.dispatchKey(event);
    };

    this.resizeHandler = () => {
      if (!this.active) return;
      const { cols, rows } = this.getSize();
      for (const listener of this.resizeListeners) {
        listener(cols, rows);
      }
    };

    process.stdin.on("keypress", this.keypressHandler);
    process.stdout.on("resize", this.resizeHandler);
    process.on("SIGINT", this.exitHandler!);
    process.on("SIGTERM", this.exitHandler!);
    process.on("SIGBREAK", this.exitHandler!);
    process.on("exit", this.exitHandler!);
    return true;
  }

  private dispatchKey(event: KeyEvent): void {
    if (!this.active) return;
    for (const listener of this.keyListeners) {
      listener(event);
    }
  }

  public stop(): void {
    if (!this.active) return;
    this.active = false;

    if (this.keypressHandler) {
      process.stdin.removeListener("keypress", this.keypressHandler);
      this.keypressHandler = null;
    }
    if (this.resizeHandler) {
      process.stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.exitHandler) {
      process.removeListener("SIGINT", this.exitHandler);
      process.removeListener("SIGTERM", this.exitHandler);
      process.removeListener("SIGBREAK", this.exitHandler);
      process.removeListener("exit", this.exitHandler);
      this.exitHandler = null;
    }

    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    if (this.originalStdinEmit) {
      process.stdin.emit = this.originalStdinEmit;
      this.originalStdinEmit = null;
    }
    if (this.pendingHoverTimeout) {
      clearTimeout(this.pendingHoverTimeout);
      this.pendingHoverTimeout = null;
    }
    this.lastHoverCol = -1;
    this.lastHoverRow = -1;
    this.lastHoverTime = 0;

    // Restore original screen buffer, cursor, and disable all mouse tracking modes synchronously
    const restoreSeq = ANSI.disableMouse + ANSI.exitAltScreen + ANSI.showCursor + ANSI.reset;
    try {
      fs.writeSync(1, restoreSeq);
    } catch {
      try {
        ServerManager.getInstance().withTuiRendering(() => {
          process.stdout.write(restoreSeq);
        });
      } catch {}
    }
  }

  public onKey(handler: KeyHandler): () => void {
    this.keyListeners.add(handler);
    return () => this.keyListeners.delete(handler);
  }

  public onResize(handler: ResizeHandler): () => void {
    this.prevRenderedRows = [];
    this.resizeListeners.add(handler);
    return () => this.resizeListeners.delete(handler);
  }

  public getSize(): { cols: number; rows: number } {
    return {
      cols: process.stdout.columns || 100,
      rows: process.stdout.rows || 30,
    };
  }

  /**
   * Renders the frame atomically with zero flicker.
   */
  public render(lines: string[]): void {
    if (!this.active) return;
    const { cols, rows } = this.getSize();

    if (cols < 70 || rows < 18) {
      // Terminal size warning
      const warnLines = [
        "",
        theme.yellow("  ⚠️  Terminal muito pequeno para a interface QwenProxy."),
        theme.muted(`  Tamanho atual: ${cols}x${rows} | Mínimo recomendado: 80x24`),
        theme.cyan("  Por favor, expanda a janela do seu terminal."),
        "",
        theme.muted("  Pressione Ctrl+C duas vezes para sair."),
      ];
      process.stdout.write(ANSI.cursorHome + warnLines.join("\n") + "\n");
      return;
    }
    const currentRows: string[] = [];
    for (let r = 0; r < rows; r++) {
      const rawLine = r < lines.length ? lines[r] : "";
      currentRows.push(pad(rawLine, cols));
    }

    let diffBuffer = "";
    let changed = 0;
    const isFirstRender = this.prevRenderedRows.length !== rows;

    for (let r = 0; r < rows; r++) {
      if (isFirstRender || this.prevRenderedRows[r] !== currentRows[r]) {
        diffBuffer += `\x1b[${r + 1};1H${currentRows[r]}`;
        changed++;
      }
    }

    if (changed === 0) {
      return;
    }

    this.prevRenderedRows = currentRows;

    ServerManager.getInstance().withTuiRendering(() => {
      process.stdout.write(ANSI.hideCursor + diffBuffer + ANSI.cursorHome);
    });
  }
}
