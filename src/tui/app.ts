/**
 * QwenProxy TUI - Main Application Controller & Navigation Coordinator
 */

import { Screen, type KeyEvent } from "./screen.ts";
import type { TuiView, ProxyStatusSnapshot } from "./types.ts";
import { theme, glyphs, drawBox, stringWidth } from "./theme.ts";
import { fetchProxyStatus } from "./proxy-client.ts";
import { ServerManager } from "./server-manager.ts";

import { StatusView } from "./views/status-view.ts";
import { ChatView } from "./views/chat-view.ts";
import { SyncView } from "./views/sync-view.ts";
import { StorageView } from "./views/storage-view.ts";
import { AccountsView } from "./views/accounts-view.ts";
import { LogsView } from "./views/logs-view.ts";
export class TuiApp {
  private screen: Screen;
  private views: TuiView[] = [];
  private activeViewIndex = 0;
  private hoveredTabIndex: number | null = null;
  private isRunning = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private statusSnapshot: ProxyStatusSnapshot | null = null;
  private renderScheduled = false;
  constructor(initialTab = 1) {
    this.screen = new Screen();

    this.views = [
      new StatusView(),
      new ChatView(() => this.requestRender()),
      new SyncView(),
      new StorageView(),
      new AccountsView(),
      new LogsView(),
    ];
    const tabIdx = Math.max(0, Math.min(this.views.length - 1, initialTab - 1));
    this.activeViewIndex = tabIdx;
  }

  private getTabAtCol(col: number): number | null {
    let curCol = 3;
    for (let i = 0; i < this.views.length; i++) {
      const tabLabel = ` [${this.views[i].tabNumber}] ${this.views[i].title} `;
      const width = stringWidth(tabLabel);
      if (col >= curCol && col <= curCol + width) {
        return i;
      }
      curCol += width + 2;
    }
    return null;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    // Activate stdio sandbox immediately so zero logs can leak to terminal screen
    ServerManager.getInstance().interceptLogs();
    const ok = this.screen.start();
    if (!ok) {
      console.error(
        "[QwenProxy TUI] A interface interativa requer um terminal TTY interativo.",
      );
      process.exit(1);
    }

    this.isRunning = true;

    // Listen for key events
    // Listen for key and mouse events with microtask coalescing
    this.screen.onKey(async (key) => {
      await this.handleKey(key);
      this.requestRender();
    });

    // Listen for terminal resize
    this.screen.onResize(() => {
      this.render();
    });

    // Start server in-process together with TUI ("tudo junto uma coisa só")
    void ServerManager.getInstance().ensureStarted();

    // Initial status fetch
    try {
      this.statusSnapshot = await fetchProxyStatus();
    } catch {}

    // Background polling every 1s for live status updates and model catalog synchronization
    this.pollInterval = setInterval(async () => {
      if (!this.isRunning) return;
      try {
        this.statusSnapshot = await fetchProxyStatus();
        // If the active view has a model refresher, keep it synchronized
        const activeView = this.views[this.activeViewIndex];
        if ("refreshModels" in activeView && typeof (activeView as any).refreshModels === "function") {
          void (activeView as any).refreshModels();
        }
        this.requestRender();
      } catch {}
    }, 1000);
    // Initial render
    this.render();
  }

  public requestRender(): void {
    if (this.renderScheduled || !this.isRunning) return;
    this.renderScheduled = true;
    queueMicrotask(() => {
      this.renderScheduled = false;
      this.render();
    });
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    clearInterval(this.pollInterval!);
    await ServerManager.getInstance().stop();
    this.screen.stop();
    ServerManager.getInstance().restoreLogs();
  }

  private async handleKey(key: KeyEvent): Promise<void> {
    const activeView = this.views[this.activeViewIndex];

    // 1. Global mouse hover & click on Header Tabs (row 2)
    if (key.mouse && key.mouse.row === 2) {
      const tabIdx = this.getTabAtCol(key.mouse.col);
      if (key.name === "hover") {
        if (this.hoveredTabIndex !== tabIdx) {
          this.hoveredTabIndex = tabIdx;
          this.requestRender();
        }
        return;
      }
      if (key.name === "click") {
        if (tabIdx !== null && tabIdx !== this.activeViewIndex && this.views[tabIdx]) {
          if (activeView.onDeactivate) activeView.onDeactivate();
          this.activeViewIndex = tabIdx;
          this.hoveredTabIndex = null;
          const nextView = this.views[this.activeViewIndex];
          if (nextView.onActivate) nextView.onActivate();
          this.requestRender();
          return;
        }
      }
    } else if (this.hoveredTabIndex !== null && key.mouse) {
      this.hoveredTabIndex = null;
      this.requestRender();
    }

    // 2. Global Quit with Ctrl+C always
    if (key.ctrl && key.name === "c") {
      this.stop();
      process.exit(0);
    }

    // 3. Determine if view is typing text / capturing input
    const isTypingText =
      activeView.id === "chat" ||
      (typeof (activeView as any).isCapturingText === "function" &&
        (activeView as any).isCapturingText());

    // 'q' key quits ONLY when NOT typing text
    if (key.name === "q" && !key.ctrl && !isTypingText) {
      this.stop();
      process.exit(0);
    }

    // Modal check: if a modal dialog is open (in Accounts or Chat), don't cycle tabs with Tab
    const isModalOpen =
      (typeof (activeView as any).isCapturingText === "function" &&
        (activeView as any).isCapturingText()) ||
      (typeof (activeView as any).isModalOpen === "function" &&
        (activeView as any).isModalOpen());

    // Tab for cycling tabs across views (including from Chat view when no modal is open!)
    if (key.name === "tab" && !isModalOpen) {
      const newIdx = (this.activeViewIndex + 1) % this.views.length;
      if (activeView.onDeactivate) activeView.onDeactivate();
      this.activeViewIndex = newIdx;
      this.hoveredTabIndex = null;
      const nextView = this.views[this.activeViewIndex];
      if (nextView.onActivate) nextView.onActivate();
      this.requestRender();
      return;
    }

    // Direct tab switching with numbers 1..6 only when NOT typing text in an input
    if (!isTypingText) {
      if (!key.ctrl && !key.meta && ["1", "2", "3", "4", "5", "6"].includes(key.name)) {
        const newIdx = parseInt(key.name, 10) - 1;
        if (newIdx !== this.activeViewIndex && this.views[newIdx]) {
          if (activeView.onDeactivate) activeView.onDeactivate();
          this.activeViewIndex = newIdx;
          this.hoveredTabIndex = null;
          const nextView = this.views[this.activeViewIndex];
          if (nextView.onActivate) nextView.onActivate();
          this.requestRender();
          return;
        }
      }
    }
    // Pass event to active view and render immediately if handled
    const handled = await activeView.handleKey(key);
    if (handled) {
      this.requestRender();
    }
  }
  private render(): void {
    if (!this.isRunning) return;
    const { cols, rows } = this.screen.getSize();
    const frame: string[] = [];

    // 1. Header Deck (Tabs & Title)
    const serverState = ServerManager.getInstance().getState();
    let statusChip: string;
    if (this.statusSnapshot?.online || serverState === "online") {
      statusChip = theme.green(`[ ${glyphs.bullet} Online ]`);
    } else if (serverState === "warming") {
      statusChip = theme.yellow(`[ 🟡 Iniciando... ]`);
    } else if (serverState === "error") {
      statusChip = theme.red(`[ ✗ Erro ]`);
    } else {
      statusChip = theme.muted(`[ ○ Offline ]`);
    }

    const tabsBar = this.views
      .map((v, idx) => {
        const isSelected = idx === this.activeViewIndex;
        const isHovered = idx === this.hoveredTabIndex;
        const tabLabel = `[${v.tabNumber}] ${v.title}`;
        if (isSelected) {
          return theme.bgSelected(` ${tabLabel} `);
        }
        if (isHovered) {
          return theme.bgHover(` ${tabLabel} `);
        }
        return theme.dim(` ${tabLabel} `);
      })
      .join("  ");

    const headerContent = [` ${tabsBar}`];
    const headerBox = drawBox({
      title: `QwenProxy v1.0.0 ${statusChip}`,
      width: cols,
      height: 3,
      borderColor: theme.borderActive,
      titleColor: theme.cyan,
      content: headerContent,
    });
    frame.push(...headerBox);

    // 2. Active View Content
    const activeView = this.views[this.activeViewIndex];
    const availableContentRows = Math.max(8, rows - 6);
    const viewLines = activeView.render(cols, availableContentRows, this.statusSnapshot);
    frame.push(...viewLines);

    // 3. Footer Key Strip
    const shortcuts = activeView.getShortcuts ? activeView.getShortcuts() : [];
    const shortcutsText = shortcuts
      .map((s) => `${theme.cyan(s.key)}: ${s.label}`)
      .join("  ");

    const tabShortcuts =
      activeView.id === "chat"
        ? `${theme.cyan("Tab")}: Próxima Aba`
        : `${theme.cyan("Tab")}: Abas  ${theme.cyan("q")}: Sair`;

    const fullFooter = shortcutsText
      ? `  ${tabShortcuts}  •  ${shortcutsText}`
      : `  ${tabShortcuts}`;
    const footerBox = drawBox({
      width: cols,
      height: 3,
      borderColor: theme.borderInactive,
      content: [fullFooter],
    });
    frame.push(...footerBox);

    // Render atomically
    this.screen.render(frame);
  }
}
