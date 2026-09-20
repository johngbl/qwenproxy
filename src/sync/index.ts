import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";

import { config } from "../core/config.ts";
import { getSyncStatePath } from "../core/paths.ts";
import {
  PLACEHOLDER_API_KEY,
  isLoopbackHost,
  isPlaceholderApiKey,
} from "../core/local-auth.ts";
import type {
  ClientSyncResult,
  SyncAllOptions,
  SyncClientName,
  SyncRecord,
  SyncStateFile,
} from "./types.ts";
import { syncClaudeCode, restoreClaudeCode } from "./claude-code.ts";
import { syncCodex, restoreCodex } from "./codex.ts";
import { syncOpenCode, restoreOpenCode } from "./opencode.ts";
import { syncOmp, restoreOmp } from "./omp.ts";
import { syncHermes, restoreHermes } from "./hermes.ts";
import { syncOpenClaw, restoreOpenClaw } from "./openclaw.ts";
import { syncKilo, restoreKilo } from "./kilo.ts";
import { syncCline, restoreCline } from "./cline.ts";
import { syncZed, restoreZed } from "./zed.ts";
import { syncAider, restoreAider } from "./aider.ts";

export {
  syncClaudeCode,
  restoreClaudeCode,
  syncCodex,
  restoreCodex,
  syncOpenCode,
  restoreOpenCode,
  syncOmp,
  restoreOmp,
  syncHermes,
  restoreHermes,
  syncOpenClaw,
  restoreOpenClaw,
  syncKilo,
  restoreKilo,
  syncCline,
  restoreCline,
  syncZed,
  restoreZed,
  syncAider,
  restoreAider,
};
export function resolveApiKey(
  overrideKey?: string,
  configKey?: string,
  host = "127.0.0.1",
): string {
  if (overrideKey && overrideKey.trim().length > 0) {
    if (isPlaceholderApiKey(overrideKey) && !isLoopbackHost(host)) {
      throw new Error(
        `Refusing to sync clients with placeholder API key ${PLACEHOLDER_API_KEY}. Set API_KEY first.`,
      );
    }
    return overrideKey.trim();
  }
  const envKey = process.env.API_KEY || process.env.ADMIN_PASSWORD || configKey;
  if (envKey && !isPlaceholderApiKey(envKey)) {
    return envKey.trim();
  }
  if (isLoopbackHost(host)) return PLACEHOLDER_API_KEY;
  throw new Error(
    `Refusing to sync clients with placeholder API key ${PLACEHOLDER_API_KEY}. Set API_KEY or start the proxy once to generate one.`,
  );
}

export function normalizeClientName(name: string): SyncClientName | null {
  const clean = name.trim().toLowerCase().replace(/[-_ ]/g, "");
  if (clean === "claude" || clean === "claudecode" || clean === "anthropic") return "claude-code";
  if (clean === "codex" || clean === "codexcli" || clean === "openai") return "codex";
  if (clean === "opencode") return "opencode";
  if (clean === "omp" || clean === "ohmypi" || clean === "pi") return "omp";
  if (clean === "hermes" || clean === "hermesagent" || clean === "nous" || clean === "nousresearch") return "hermes";
  if (clean === "openclaw" || clean === "claw" || clean === "clawdbot" || clean === "moltbot") return "openclaw";
  if (clean === "kilo" || clean === "kilocode") return "kilo";
  if (
    clean === "cline" ||
    clean === "claudedev" ||
    clean === "zoo" ||
    clean === "zoocode" ||
    clean === "roo" ||
    clean === "roocode" ||
    clean === "roocline"
  ) {
    return "cline";
  }
  if (clean === "zed" || clean === "zededitor") return "zed";
  if (clean === "aider" || clean === "aiderchat") return "aider";
  return null;
}

export function resolveBaseUrls(port = 7936, host = "127.0.0.1"): {
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
  hermes: string;
  openClaw: string;
  kilo: string;
  cline: string;
  zed: string;
  aider: string;
} {
  const home = os.homedir();
  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const appData = process.env.APPDATA || (isWindows ? path.join(home, "AppData", "Roaming") : "");

  // OpenCode candidates
  const openCodeCandidates = [
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".opencode", "opencode.jsonc"),
    path.join(home, ".opencode", "opencode.json"),
  ];
  const existingOpenCode = openCodeCandidates.find((p) => fs.existsSync(p));

  // Kilo candidates
  const kiloCandidates = [
    path.join(home, ".config", "kilo", "kilo.json"),
    path.join(home, ".kilo", "kilo.json"),
    path.join(home, ".config", "kilo", "config.json"),
    path.join(home, ".kilo", "config.json"),
  ];
  const existingKilo = kiloCandidates.find((p) => fs.existsSync(p));

  // Cline state.vscdb
  let clinePath: string;
  if (isWindows) {
    clinePath = path.join(appData, "Code", "User", "globalStorage", "state.vscdb");
  } else if (isMac) {
    clinePath = path.join(home, "Library", "Application Support", "Code", "User", "globalStorage", "state.vscdb");
  } else {
    clinePath = path.join(home, ".config", "Code", "User", "globalStorage", "state.vscdb");
  }

  // Zed settings.json
  let zedPath: string;
  if (isWindows) {
    zedPath = path.join(appData, "Zed", "settings.json");
  } else {
    zedPath = path.join(home, ".config", "zed", "settings.json");
  }

  return {
    claudeCode: path.join(home, ".claude", "settings.json"),
    codex: process.env.CODEX_HOME
      ? path.join(process.env.CODEX_HOME, "config.toml")
      : path.join(home, ".codex", "config.toml"),
    openCode: existingOpenCode || openCodeCandidates[0],
    omp: path.join(home, ".omp", "agent", "models.yml"),
    hermes: path.join(home, ".hermes", "config.yaml"),
    openClaw: path.join(home, ".openclaw", "openclaw.json"),
    kilo: existingKilo || kiloCandidates[0],
    cline: clinePath,
    zed: zedPath,
    aider: path.join(home, ".aider.conf.yml"),
  };
}

export function getDefaultStateFilePath(): string {
  return getSyncStatePath();
}

export interface ClientDetectionStatus {
  id: SyncClientName;
  installed: boolean;
  synced: boolean;
  model?: string;
  url?: string;
}

export function isExecutableInPath(name: string): boolean {
  const envPath = process.env.PATH || "";
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
    : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, name + ext);
      try {
        if (fs.existsSync(fullPath) && !fs.statSync(fullPath).isDirectory()) {
          return true;
        }
      } catch {}
    }
  }
  return false;
}

export function isVscodeExtensionInstalled(pattern: RegExp): boolean {
  const home = os.homedir();
  const candidateDirs = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".windsurf", "extensions"),
  ];
  for (const d of candidateDirs) {
    if (fs.existsSync(d)) {
      try {
        const entries = fs.readdirSync(d);
        if (entries.some((e) => pattern.test(e))) return true;
      } catch {}
    }
  }
  return false;
}

export function isZedInstalled(): boolean {
  if (isExecutableInPath("zed")) return true;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    if (fs.existsSync(path.join(local, "Programs", "Zed"))) return true;
  } else if (process.platform === "darwin") {
    if (fs.existsSync("/Applications/Zed.app")) return true;
  }
  return false;
}

export function isMatchingLocalHost(text: string, port = 7936): boolean {
  if (!text) return false;
  const configuredPort = config.server?.port || 7936;
  const ports = new Set([String(port), String(configuredPort), "7936", "3000"]);
  const isLocal = text.includes("127.0.0.1") || text.includes("localhost") || text.includes("0.0.0.0");
  return isLocal && Array.from(ports).some((p) => text.includes(`:${p}`));
}

export function isClientToolInstalled(
  id: SyncClientName,
  targetPath: string,
  isCustomTestPath = false,
): boolean {
  if (isCustomTestPath) {
    return fs.existsSync(targetPath);
  }
  switch (id) {
    case "hermes":
      return isExecutableInPath("hermes");
    case "openclaw":
      return isExecutableInPath("openclaw") || isExecutableInPath("clawdbot") || isExecutableInPath("moltbot");
    case "aider":
      return isExecutableInPath("aider");
    case "kilo":
      return isExecutableInPath("kilo") || isVscodeExtensionInstalled(/kilo/i);
    case "cline":
      return isExecutableInPath("cline") || isVscodeExtensionInstalled(/cline|zoo-code|roo-cline/i);
    case "zed":
      return isZedInstalled();
    case "claude-code":
      return isExecutableInPath("claude") || fs.existsSync(targetPath);
    case "codex":
      return isExecutableInPath("codex") || fs.existsSync(targetPath);
    case "opencode":
      return isExecutableInPath("opencode") || fs.existsSync(targetPath);
    case "omp":
      return isExecutableInPath("omp") || fs.existsSync(targetPath);
    default:
      return fs.existsSync(targetPath);
  }
}

/**
 * Inspects a client configuration file to determine whether the client is installed
 * and whether it is actively configured to route to QwenProxy.
 */
export function inspectClientSyncStatus(
  id: SyncClientName,
  filePath?: string,
  port = 7936,
): ClientDetectionStatus {
  const defaultPaths = getDefaultPaths();
  const defaultTarget = (defaultPaths as Record<string, string>)[id] || "";
  const isCustomTestPath = Boolean(
    filePath && defaultTarget && path.resolve(filePath) !== path.resolve(defaultTarget),
  );
  const targetPath = filePath || defaultTarget;

  if (!fs.existsSync(targetPath)) {
    return { id, installed: false, synced: false };
  }

  const toolInstalled = isClientToolInstalled(id, targetPath, isCustomTestPath);
  if (!toolInstalled) {
    return { id, installed: false, synced: false };
  }

  try {
    if (id === "cline") {
      let isSynced = false;
      let model: string | undefined;
      let rowExists = false;
      try {
        const db = new Database(targetPath, { readonly: true });
        const row = db
          .prepare(
            `SELECT value FROM ItemTable WHERE key = 'saoudrizwan.claude-dev' OR key = 'ZooCodeOrganization.zoo-code' LIMIT 1`,
          )
          .get() as { value: string } | undefined;
        db.close();
        if (row && row.value) {
          rowExists = true;
          const parsed = JSON.parse(row.value);
          const url = parsed.openAiBaseUrl || "";
          model = parsed.openAiModelId;
          isSynced = isMatchingLocalHost(url, port);
        }
      } catch {}

      const isInstalled = isCustomTestPath
        ? true
        : rowExists || isExecutableInPath("cline") || isVscodeExtensionInstalled(/cline|zoo-code|roo-cline/i);

      return { id, installed: isInstalled, synced: isInstalled && isSynced, model };
    }

    const raw = fs.readFileSync(targetPath, "utf-8");

    if (id === "claude-code") {
      const data = JSON.parse(raw);
      const url = data?.env?.ANTHROPIC_BASE_URL || "";
      const model = data?.env?.ANTHROPIC_MODEL || data?.model || "";
      const isSynced =
        isMatchingLocalHost(url, port) &&
        (model.toLowerCase().includes("qwen") || Boolean(data?.env?.ANTHROPIC_AUTH_TOKEN));
      return {
        id,
        installed: true,
        synced: isSynced,
        model: model || undefined,
        url: url || undefined,
      };
    }

    if (id === "codex") {
      const hasProvider = raw.includes("[model_providers.qwenproxy]");
      const isProviderActive = /^model_provider\s*=\s*["']qwenproxy["']/m.test(raw);
      const modelMatch = raw.match(/^model\s*=\s*["']([^"']+)["']/m);
      const model = modelMatch ? modelMatch[1] : undefined;
      const urlMatch = raw.match(/\[model_providers\.qwenproxy\][\s\S]*?base_url\s*=\s*["']([^"']+)["']/);
      const url = urlMatch ? urlMatch[1] : "";
      const isSynced = hasProvider && isProviderActive && isMatchingLocalHost(url, port);
      return {
        id,
        installed: true,
        synced: isSynced,
        model,
      };
    }

    if (id === "opencode") {
      let isSynced = false;
      try {
        const data = JSON.parse(raw);
        const provider = data?.provider?.qwenproxy;
        const url = provider?.options?.baseURL || "";
        const isSynced = Boolean(provider && isMatchingLocalHost(url, port));
        return { id, installed: true, synced: isSynced };
      } catch {
        const qwenBlockMatch = raw.match(/"qwenproxy"\s*:\s*\{[\s\S]*?"baseURL"\s*:\s*"([^"]+)"/);
        const url = qwenBlockMatch ? qwenBlockMatch[1] : "";
        const isSynced = Boolean(url && isMatchingLocalHost(url, port));
        return { id, installed: true, synced: isSynced };
      }
      return {
        id,
        installed: true,
        synced: isSynced,
      };
    }

    if (id === "omp") {
      const ompMatch = raw.match(/^[ \t]*qwenproxy:\s*\r?\n((?:[ \t]{4,}.*\r?\n?)*)/m);
      let isSynced = false;
      let url: string | undefined;
      if (ompMatch) {
        const urlMatch = ompMatch[1].match(/baseUrl:\s*(\S+)/);
        url = urlMatch ? urlMatch[1].replace(/['"]/g, "") : undefined;
        isSynced = Boolean(url && isMatchingLocalHost(url, port));
      }
      return {
        id,
        installed: true,
        synced: isSynced,
        url,
      };
    }

    if (id === "hermes") {
      const isSynced = isMatchingLocalHost(raw, port) && (raw.includes("qwenproxy") || raw.includes("qwen"));
      return { id, installed: true, synced: isSynced };
    }

    if (id === "openclaw") {
      const isSynced = isMatchingLocalHost(raw, port) && raw.includes("qwenproxy");
      return { id, installed: true, synced: isSynced };
    }

    if (id === "kilo") {
      const isSynced = isMatchingLocalHost(raw, port) && raw.includes("qwenproxy");
      return { id, installed: true, synced: isSynced };
    }

    if (id === "zed") {
      const isSynced = isMatchingLocalHost(raw, port) && raw.includes("QwenProxy");
      return { id, installed: true, synced: isSynced };
    }

    if (id === "aider") {
      const isSynced = isMatchingLocalHost(raw, port) && raw.includes("qwen");
      return { id, installed: true, synced: isSynced };
    }
  } catch {
    return { id, installed: true, synced: false };
  }

  return { id, installed: true, synced: false };
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
    hermes?: ClientSyncResult;
    openClaw?: ClientSyncResult;
    kilo?: ClientSyncResult;
    cline?: ClientSyncResult;
    zed?: ClientSyncResult;
    aider?: ClientSyncResult;
  };
}

export function syncAllClients(options: SyncAllOptions = {}): SyncAllResult {
  const defaultPaths = getDefaultPaths();
  const paths = {
    claudeCode: options.customPaths?.claudeCode || defaultPaths.claudeCode,
    codex: options.customPaths?.codex || defaultPaths.codex,
    openCode: options.customPaths?.openCode || defaultPaths.openCode,
    omp: options.customPaths?.omp || defaultPaths.omp,
    hermes: options.customPaths?.hermes || defaultPaths.hermes,
    openClaw: options.customPaths?.openClaw || defaultPaths.openClaw,
    kilo: options.customPaths?.kilo || defaultPaths.kilo,
    cline: options.customPaths?.cline || defaultPaths.cline,
    zed: options.customPaths?.zed || defaultPaths.zed,
    aider: options.customPaths?.aider || defaultPaths.aider,
  };

  const port = options.port ?? (config.server?.port || 7936);
  const configuredHost = config.server?.host;
  const host = options.host ?? (configuredHost && configuredHost !== "0.0.0.0" ? configuredHost : "127.0.0.1");
  const authHost = options.host ?? configuredHost ?? host;
  const apiKey = resolveApiKey(options.apiKey, config.apiKey, authHost);
  const { anthropicBaseUrl, openaiBaseUrl } = resolveBaseUrls(port, host);
  const stateFilePath = options.stateFilePath || getDefaultStateFilePath();
  const selectedModel = options.model || "qwen3.8-max";
  const allModels = options.models && options.models.length > 0 ? options.models : undefined;
  const syncModels = options.syncAllModels !== false && allModels ? allModels : [selectedModel];

  const results: SyncAllResult = {
    apiKey,
    port,
    host,
    clients: {},
  };

  const stateRecords: SyncStateFile["clients"] = {};
  const shouldSync = (client: SyncClientName) => {
    if (!options.targets || options.targets.length === 0) return true;
    return options.targets.includes(client);
  };

  // 1. Claude Code
  if (shouldSync("claude-code")) {
    const claudeExisted = fs.existsSync(paths.claudeCode);
    const claudeRes = syncClaudeCode({
      filePath: paths.claudeCode,
      apiKey,
      baseUrl: anthropicBaseUrl,
      model: selectedModel,
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
  }

  // 2. Codex
  if (shouldSync("codex")) {
    const codexExisted = fs.existsSync(paths.codex);
    const codexRes = syncCodex({
      filePath: paths.codex,
      apiKey,
      baseUrl: openaiBaseUrl,
      setActive: options.setActive ?? true,
      model: selectedModel,
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
  }

  // 3. OpenCode
  if (shouldSync("opencode")) {
    const openCodeExisted = fs.existsSync(paths.openCode);
    const openCodeRes = syncOpenCode({
      filePath: paths.openCode,
      apiKey,
      baseUrl: openaiBaseUrl,
      model: selectedModel,
      models: syncModels,
      setActive: options.setActive ?? true,
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
  }

  // 4. OMP
  if (shouldSync("omp")) {
    const ompExisted = fs.existsSync(paths.omp);
    const ompRes = syncOmp({
      filePath: paths.omp,
      apiKey,
      baseUrl: openaiBaseUrl,
      model: selectedModel,
      models: syncModels,
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
  }

  // 5. Hermes Agent
  if (shouldSync("hermes")) {
    const hermesExisted = fs.existsSync(paths.hermes);
    const hermesRes = syncHermes({
      filePath: paths.hermes,
      apiKey,
      baseUrl: openaiBaseUrl,
      model: selectedModel,
    });
    results.clients.hermes = hermesRes;
    if (hermesRes.success && hermesRes.backupPath) {
      stateRecords.hermes = {
        filePath: paths.hermes,
        backupPath: hermesRes.backupPath,
        existedBefore: hermesExisted,
        syncedAt: Date.now(),
      };
    }
  }

  // 6. OpenClaw
  if (shouldSync("openclaw")) {
    const openClawExisted = fs.existsSync(paths.openClaw);
    const openClawRes = syncOpenClaw({
      filePath: paths.openClaw,
      apiKey,
      baseUrl: openaiBaseUrl,
      model: selectedModel,
      models: syncModels,
    });
    results.clients.openClaw = openClawRes;
    if (openClawRes.success && openClawRes.backupPath) {
      stateRecords.openClaw = {
        filePath: paths.openClaw,
        backupPath: openClawRes.backupPath,
        existedBefore: openClawExisted,
        syncedAt: Date.now(),
      };
    }
  }

  // 7. Kilo Code
  if (shouldSync("kilo")) {
    const kiloExisted = fs.existsSync(paths.kilo);
    const kiloRes = syncKilo({
      filePath: paths.kilo,
      apiKey,
      baseUrl: openaiBaseUrl,
      setActive: options.setActive ?? true,
      model: selectedModel,
      models: syncModels,
    });
    results.clients.kilo = kiloRes;
    if (kiloRes.success && kiloRes.backupPath) {
      stateRecords.kilo = {
        filePath: paths.kilo,
        backupPath: kiloRes.backupPath,
        existedBefore: kiloExisted,
        syncedAt: Date.now(),
      };
    }
  }

  // 8. Cline
  if (shouldSync("cline")) {
    const clineExisted = fs.existsSync(paths.cline);
    const clineRes = syncCline({
      filePath: paths.cline,
      apiKey,
      baseUrl: openaiBaseUrl,
      model: selectedModel,
    });
    results.clients.cline = clineRes;
    if (clineRes.success && clineRes.backupPath) {
      stateRecords.cline = {
        filePath: paths.cline,
        backupPath: clineRes.backupPath,
        existedBefore: clineExisted,
        syncedAt: Date.now(),
      };
    }
  }

  // 9. Zed Editor
  if (shouldSync("zed")) {
    const zedExisted = fs.existsSync(paths.zed);
    const zedRes = syncZed({
      filePath: paths.zed,
      apiKey,
      baseUrl: openaiBaseUrl,
      setActive: options.setActive ?? true,
      model: selectedModel,
      models: syncModels,
    });
    results.clients.zed = zedRes;
    if (zedRes.success && zedRes.backupPath) {
      stateRecords.zed = {
        filePath: paths.zed,
        backupPath: zedRes.backupPath,
        existedBefore: zedExisted,
        syncedAt: Date.now(),
      };
    }
  }

  // 10. Aider
  if (shouldSync("aider")) {
    const aiderExisted = fs.existsSync(paths.aider);
    const aiderRes = syncAider({
      filePath: paths.aider,
      apiKey,
      baseUrl: openaiBaseUrl,
      model: selectedModel,
    });
    results.clients.aider = aiderRes;
    if (aiderRes.success && aiderRes.backupPath) {
      stateRecords.aider = {
        filePath: paths.aider,
        backupPath: aiderRes.backupPath,
        existedBefore: aiderExisted,
        syncedAt: Date.now(),
      };
    }
  }

  // Persist sync state (merge with existing state if present)
  try {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    let existingClients: SyncStateFile["clients"] = {};
    if (fs.existsSync(stateFilePath)) {
      try {
        const raw = fs.readFileSync(stateFilePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed?.clients && typeof parsed.clients === "object") {
          existingClients = parsed.clients;
        }
      } catch {}
    }
    const stateContent: SyncStateFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      apiKey,
      port,
      host,
      clients: {
        ...existingClients,
        ...stateRecords,
      },
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

export interface RestoreAllOptions {
  stateFilePath?: string;
  targets?: SyncClientName[];
}

export function restoreAllClients(options: RestoreAllOptions = {}): RestoreAllResult {
  const defaultPaths = getDefaultPaths();
  const stateFilePath = options.stateFilePath || getDefaultStateFilePath();
  const details: ClientSyncResult[] = [];
  let restoredCount = 0;

  let state: SyncStateFile | null = null;
  if (fs.existsSync(stateFilePath)) {
    try {
      const raw = fs.readFileSync(stateFilePath, "utf-8");
      state = JSON.parse(raw);
    } catch {}
  }

  const shouldRestore = (client: SyncClientName) => {
    if (!options.targets || options.targets.length === 0) return true;
    return options.targets.includes(client);
  };

  const restoreClientsList: Array<{
    id: SyncClientName;
    stateKey: keyof SyncStateFile["clients"];
    defaultPath: string;
    stateRecord?: SyncRecord;
    restoreFn: (filePath: string, backupPath?: string) => ClientSyncResult;
  }> = [
    { id: "claude-code", stateKey: "claudeCode", defaultPath: defaultPaths.claudeCode, stateRecord: state?.clients?.claudeCode, restoreFn: restoreClaudeCode },
    { id: "codex", stateKey: "codex", defaultPath: defaultPaths.codex, stateRecord: state?.clients?.codex, restoreFn: restoreCodex },
    { id: "opencode", stateKey: "openCode", defaultPath: defaultPaths.openCode, stateRecord: state?.clients?.openCode, restoreFn: restoreOpenCode },
    { id: "omp", stateKey: "omp", defaultPath: defaultPaths.omp, stateRecord: state?.clients?.omp, restoreFn: restoreOmp },
    { id: "hermes", stateKey: "hermes", defaultPath: defaultPaths.hermes, stateRecord: state?.clients?.hermes, restoreFn: restoreHermes },
    { id: "openclaw", stateKey: "openClaw", defaultPath: defaultPaths.openClaw, stateRecord: state?.clients?.openClaw, restoreFn: restoreOpenClaw },
    { id: "kilo", stateKey: "kilo", defaultPath: defaultPaths.kilo, stateRecord: state?.clients?.kilo, restoreFn: restoreKilo },
    { id: "cline", stateKey: "cline", defaultPath: defaultPaths.cline, stateRecord: state?.clients?.cline, restoreFn: restoreCline },
    { id: "zed", stateKey: "zed", defaultPath: defaultPaths.zed, stateRecord: state?.clients?.zed, restoreFn: restoreZed },
    { id: "aider", stateKey: "aider", defaultPath: defaultPaths.aider, stateRecord: state?.clients?.aider, restoreFn: restoreAider },
  ];

  for (const c of restoreClientsList) {
    if (!shouldRestore(c.id)) continue;
    const filePath = c.stateRecord?.filePath || c.defaultPath;
    const backupPath = c.stateRecord?.backupPath;

    const canAttempt = options.stateFilePath
      ? Boolean(c.stateRecord)
      : Boolean(c.stateRecord || fs.existsSync(filePath));

    if (canAttempt) {
      const res = c.restoreFn(filePath, backupPath);
      details.push(res);
      if (res.success) {
        restoredCount++;
        if (state?.clients) {
          delete state.clients[c.stateKey];
          delete (state.clients as any)[c.id];
        }
      }
    }
  }
  // Update or delete state file
  if (stateFilePath && fs.existsSync(stateFilePath)) {
    try {
      if (state && state.clients && Object.keys(state.clients).length > 0) {
        fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
      } else {
        fs.unlinkSync(stateFilePath);
      }
    } catch {}
  }

  return { restoredCount, details };
}
