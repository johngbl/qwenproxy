/**
 * QwenProxy - Unified Cross-Platform Storage & Path Resolution Engine
 *
 * Provides resilient, OS-standard persistent data paths for:
 * - SQLite Database & WAL logs
 * - AES-256-GCM Master Encryption Key
 * - Chromium persistent browser profiles (cookies & session storage)
 * - Account priority & AI client sync caches
 *
 * Guarantees zero data loss on package reinstall/update across npm, pnpm, bun, and yarn.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ResolveDataDirOptions {
  envDataDir?: string;
  isNodeTest?: boolean;
  localDataExists?: boolean;
  platform?: NodeJS.Platform;
  appData?: string;
  homeDir?: string;
  xdgDataHome?: string;
}

/**
 * Checks if the current process is running as a unit/mock test.
 */
export function isRunningUnderNodeTest(): boolean {
  return process.argv.some(
    (arg) =>
      arg === "--test" ||
      arg.includes("src/tests/") ||
      arg.includes("src\\tests\\"),
  );
}

/**
 * Computes the canonical global user data directory according to OS conventions:
 * - Windows: %APPDATA%\qwenproxy
 * - macOS:   ~/Library/Application Support/qwenproxy
 * - Linux:   $XDG_DATA_HOME/qwenproxy or ~/.local/share/qwenproxy
 */
export function getOsGlobalDataDir(options?: {
  platform?: NodeJS.Platform;
  appData?: string;
  homeDir?: string;
  xdgDataHome?: string;
}): string {
  const currentPlatform = options?.platform || process.platform;
  const home = options?.homeDir || os.homedir();

  if (currentPlatform === "win32") {
    const appData =
      options?.appData ||
      process.env.APPDATA ||
      path.join(home, "AppData", "Roaming");
    return path.join(appData, "qwenproxy");
  }

  if (currentPlatform === "darwin") {
    return path.join(home, "Library", "Application Support", "qwenproxy");
  }

  // Linux / BSD / POSIX
  const xdgDataHome =
    options?.xdgDataHome ||
    process.env.XDG_DATA_HOME ||
    path.join(home, ".local", "share");
  return path.join(xdgDataHome, "qwenproxy");
}

/**
 * Resolves the active data directory based on environment, testing state,
 * local checkout presence, or the persistent global OS user directory.
 */
export function resolveDataDir(options?: ResolveDataDirOptions): string {
  // 1. Explicit environment variable override takes top precedence
  const envDir = options?.envDataDir ?? process.env.QWEN_DATA_DIR;
  if (envDir && envDir.trim().length > 0) {
    return path.resolve(envDir.trim());
  }

  // 2. Automated test isolation
  const isTest = options?.isNodeTest ?? isRunningUnderNodeTest();
  if (isTest) {
    if (options?.localDataExists === false) {
      return path.resolve("data-test");
    }
    if (fs.existsSync(path.resolve("data"))) {
      return path.resolve("data");
    }
    return path.resolve("data-test");
  }
  // 3. Local repository checkout (development mode)
  const localDir = path.resolve("data");
  const localExists =
    options?.localDataExists ??
    (fs.existsSync(path.join(localDir, "db", "qwenproxy.db")) ||
      fs.existsSync(localDir));

  if (localExists) {
    return localDir;
  }

  // 4. Global OS user directory (npm/pnpm/bun/yarn global mode)
  return getOsGlobalDataDir({
    platform: options?.platform,
    appData: options?.appData,
    homeDir: options?.homeDir,
    xdgDataHome: options?.xdgDataHome,
  });
}

/**
 * Returns the active root data directory.
 */
export function getDataDir(): string {
  return resolveDataDir();
}

/**
 * Directory for SQLite database and encryption key.
 */
export function getDbDir(customDataDir?: string): string {
  return path.join(customDataDir || getDataDir(), "db");
}

/**
 * Absolute path to the SQLite database file.
 */
export function getDbPath(customDataDir?: string): string {
  return path.join(getDbDir(customDataDir), "qwenproxy.db");
}

/**
 * Absolute path to the master AES-256 encryption key.
 */
export function getEncryptionKeyPath(customDataDir?: string): string {
  return path.join(getDbDir(customDataDir), ".encryption_key");
}

/**
 * Directory for persistent Chromium browser profiles.
 */
export function getProfilesDir(customDataDir?: string): string {
  return path.join(customDataDir || getDataDir(), "qwen_profiles");
}

/**
 * Path to a specific account's Chromium profile directory.
 */
export function getAccountProfilePath(accountId: string, customDataDir?: string): string {
  return path.join(getProfilesDir(customDataDir), accountId);
}

/**
 * Path to account priority persistence file.
 */
export function getAccountPriorityPath(customDataDir?: string): string {
  return path.join(customDataDir || getDataDir(), "account-priority.json");
}

/**
 * Path to AI coding clients synchronization state file.
 */
export function getSyncStatePath(customDataDir?: string): string {
  return path.join(customDataDir || getDataDir(), "sync-state.json");
}

/**
 * Path to user configuration .env file (either local or in global data dir).
 */
export function getEnvFilePath(customDataDir?: string): string {
  const localEnv = path.resolve(".env");
  if (fs.existsSync(localEnv)) {
    return localEnv;
  }
  return path.join(customDataDir || getDataDir(), ".env");
}

/**
 * Ensures all standard directories exist on disk with proper recursive creation.
 */
export function ensureDataDirs(targetDataDir?: string): void {
  const root = targetDataDir || getDataDir();
  const dbDir = getDbDir(root);
  const profilesDir = getProfilesDir(root);

  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
  } catch (err: any) {
    console.error(`[Paths] Error ensuring data directories at ${root}:`, err?.message || String(err));
  }
}
