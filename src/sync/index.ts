import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { config } from "../core/config.ts";
import type {
  ClientSyncResult,
  SyncAllOptions,
  SyncRecord,
  SyncStateFile,
} from "./types.ts";
import { syncClaudeCode, restoreClaudeCode } from "./claude-code.ts";
import { syncCodex, restoreCodex } from "./codex.ts";
import { syncOpenCode, restoreOpenCode } from "./opencode.ts";
import { syncOmp, restoreOmp } from "./omp.ts";

export function resolveApiKey(overrideKey?: string, configKey?: string): string {
  if (overrideKey && overrideKey.trim().length > 0) {
    return overrideKey.trim();
  }
  const envKey = process.env.API_KEY || process.env.ADMIN_PASSWORD || configKey;
  if (envKey && envKey.trim().length > 0) {
    return envKey.trim();
  }
  return "sk-qwenproxy-local";
}

export function resolveBaseUrls(port = 3000, host = "127.0.0.1"): {
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
} {
  const cleanHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return {
    anthropicBaseUrl: `http://${cleanHost}:${port}`,
    openaiBaseUrl: `http://${cleanHost}:${port}/v1`,
  };
}

export function getDefaultPaths(): {
  claudeCode: string;
  codex: string;
  openCode: string;
  omp: string;
} {
  const home = os.homedir();

  // OpenCode can be ~/.config/opencode/opencode.jsonc or ~/.opencode/opencode.jsonc
  const openCodeCandidates = [
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".opencode", "opencode.jsonc"),
    path.join(home, ".opencode", "opencode.json"),
  ];
  const existingOpenCode = openCodeCandidates.find((p) => fs.existsSync(p));

  return {
    claudeCode: path.join(home, ".claude", "settings.json"),
    codex: path.join(home, ".codex", "config.toml"),
    openCode: existingOpenCode || openCodeCandidates[0],
    omp: path.join(home, ".omp", "agent", "models.yml"),
  };
}

export function getDefaultStateFilePath(): string {
  return path.join(process.cwd(), "data", "sync-state.json");
}

export interface SyncAllResult {
  apiKey: string;
  port: number;
  host: string;
  clients: {
    claudeCode?: ClientSyncResult;
    codex?: ClientSyncResult;
    openCode?: ClientSyncResult;
    omp?: ClientSyncResult;
  };
}

export function syncAllClients(options: SyncAllOptions = {}): SyncAllResult {
  const defaultPaths = getDefaultPaths();
  const paths = {
    claudeCode: options.customPaths?.claudeCode || defaultPaths.claudeCode,
    codex: options.customPaths?.codex || defaultPaths.codex,
    openCode: options.customPaths?.openCode || defaultPaths.openCode,
    omp: options.customPaths?.omp || defaultPaths.omp,
  };

  const port = options.port ?? (config.server?.port || 3000);
  const configuredHost = config.server?.host;
  const host = options.host ?? (configuredHost && configuredHost !== "0.0.0.0" ? configuredHost : "127.0.0.1");
  const apiKey = resolveApiKey(options.apiKey, config.apiKey);
  const { anthropicBaseUrl, openaiBaseUrl } = resolveBaseUrls(port, host);
  const stateFilePath = options.stateFilePath || getDefaultStateFilePath();

  const results: SyncAllResult = {
    apiKey,
    port,
    host,
    clients: {},
  };

  const stateRecords: SyncStateFile["clients"] = {};

  // 1. Claude Code
  const claudeExisted = fs.existsSync(paths.claudeCode);
  const claudeRes = syncClaudeCode({
    filePath: paths.claudeCode,
    apiKey,
    baseUrl: anthropicBaseUrl,
  });
  results.clients.claudeCode = claudeRes;
  if (claudeRes.success && claudeRes.backupPath) {
    stateRecords.claudeCode = {
      filePath: paths.claudeCode,
      backupPath: claudeRes.backupPath,
      existedBefore: claudeExisted,
      syncedAt: Date.now(),
    };
  }

  // 2. Codex
  const codexExisted = fs.existsSync(paths.codex);
  const codexRes = syncCodex({
    filePath: paths.codex,
    apiKey,
    baseUrl: openaiBaseUrl,
    setActive: options.setActive ?? true,
  });
  results.clients.codex = codexRes;
  if (codexRes.success && codexRes.backupPath) {
    stateRecords.codex = {
      filePath: paths.codex,
      backupPath: codexRes.backupPath,
      existedBefore: codexExisted,
      syncedAt: Date.now(),
    };
  }

  // 3. OpenCode
  const openCodeExisted = fs.existsSync(paths.openCode);
  const openCodeRes = syncOpenCode({
    filePath: paths.openCode,
    apiKey,
    baseUrl: openaiBaseUrl,
  });
  results.clients.openCode = openCodeRes;
  if (openCodeRes.success && openCodeRes.backupPath) {
    stateRecords.openCode = {
      filePath: paths.openCode,
      backupPath: openCodeRes.backupPath,
      existedBefore: openCodeExisted,
      syncedAt: Date.now(),
    };
  }

  // 4. OMP
  const ompExisted = fs.existsSync(paths.omp);
  const ompRes = syncOmp({
    filePath: paths.omp,
    apiKey,
    baseUrl: openaiBaseUrl,
  });
  results.clients.omp = ompRes;
  if (ompRes.success && ompRes.backupPath) {
    stateRecords.omp = {
      filePath: paths.omp,
      backupPath: ompRes.backupPath,
      existedBefore: ompExisted,
      syncedAt: Date.now(),
    };
  }

  // Persist sync state
  try {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    const stateContent: SyncStateFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      apiKey,
      port,
      host,
      clients: stateRecords,
    };
    fs.writeFileSync(stateFilePath, JSON.stringify(stateContent, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error("Warning: could not write sync state file:", err);
  }

  return results;
}

export interface RestoreAllResult {
  restoredCount: number;
  details: ClientSyncResult[];
}

export function restoreAllClients(options: { stateFilePath?: string } = {}): RestoreAllResult {
  const stateFilePath = options.stateFilePath || getDefaultStateFilePath();
  const details: ClientSyncResult[] = [];
  let restoredCount = 0;

  if (!fs.existsSync(stateFilePath)) {
    return { restoredCount: 0, details };
  }

  try {
    const raw = fs.readFileSync(stateFilePath, "utf-8");
    const state: SyncStateFile = JSON.parse(raw);

    if (state.clients.claudeCode?.backupPath) {
      const res = restoreClaudeCode(state.clients.claudeCode.filePath, state.clients.claudeCode.backupPath);
      details.push(res);
      if (res.success) restoredCount++;
    }

    if (state.clients.codex?.backupPath) {
      const res = restoreCodex(state.clients.codex.filePath, state.clients.codex.backupPath);
      details.push(res);
      if (res.success) restoredCount++;
    }

    if (state.clients.openCode?.backupPath) {
      const res = restoreOpenCode(state.clients.openCode.filePath, state.clients.openCode.backupPath);
      details.push(res);
      if (res.success) restoredCount++;
    }

    if (state.clients.omp?.backupPath) {
      const res = restoreOmp(state.clients.omp.filePath, state.clients.omp.backupPath);
      details.push(res);
      if (res.success) restoredCount++;
    }

    // Remove state file after successful restoration
    try {
      fs.unlinkSync(stateFilePath);
    } catch {
      // Ignore
    }
  } catch (err) {
    console.error("Error reading sync state file:", err);
  }

  return { restoredCount, details };
}
