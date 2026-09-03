export interface ClientSyncResult {
  client: "claude-code" | "codex" | "opencode" | "omp";
  filePath: string;
  backupPath?: string;
  success: boolean;
  action: "updated" | "created" | "skipped" | "restored" | "failed";
  message?: string;
  error?: string;
}

export interface SyncOptions {
  filePath: string;
  apiKey: string;
  baseUrl: string;
  model?: string;
  setActive?: boolean;
}

export interface SyncAllOptions {
  apiKey?: string;
  port?: number;
  host?: string;
  setActive?: boolean;
  stateFilePath?: string;
  customPaths?: {
    claudeCode?: string;
    codex?: string;
    openCode?: string;
    omp?: string;
  };
}

export interface SyncRecord {
  filePath: string;
  backupPath: string;
  existedBefore: boolean;
  syncedAt: number;
}

export interface SyncStateFile {
  version: number;
  updatedAt: string;
  apiKey: string;
  port: number;
  host: string;
  clients: {
    claudeCode?: SyncRecord;
    codex?: SyncRecord;
    openCode?: SyncRecord;
    omp?: SyncRecord;
  };
}
