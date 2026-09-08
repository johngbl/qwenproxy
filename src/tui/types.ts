import type { KeyEvent } from "./screen.ts";

export interface TuiView {
  readonly id: string;
  readonly title: string;
  readonly tabNumber: number;
  render(width: number, height: number, snapshot?: ProxyStatusSnapshot | null): string[];
  handleKey(key: KeyEvent): Promise<boolean | void> | boolean | void;
  onActivate?(): void;
  onDeactivate?(): void;
  getShortcuts?(): Array<{ key: string; label: string }>;
}

export interface ProxyStatusSnapshot {
  online: boolean;
  port: number;
  host: string;
  overallStatus?: string;
  uptimeSeconds?: number;
  rssMb?: number;
  systemMemoryPct?: number;
  activeStreams?: number;
  waitingStreams?: number;
  accounts: Array<{
    id: string;
    emailOrName: string;
    priority: number;
    cooldownUntil: number | null;
    onCooldown: boolean;
    remainingCooldownMs: number;
    headersReady: boolean;
    isInitialized?: boolean;
  }>;
}
