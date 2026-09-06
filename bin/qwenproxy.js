#!/usr/bin/env node

/**
 * QwenProxy - Unified CLI Entrypoint & Runner
 *
 * Commands:
 *   qwenproxy (default) -> Launches the interactive TUI management dashboard and proxy
 *   qwenproxy --server  -> Runs headless proxy server in background
 *   qwenproxy sync      -> Synchronizes AI coding clients (Claude Code, Codex, OpenCode, OMP)
 *   qwenproxy clean     -> Prunes transient caches
 *   qwenproxy clean:all -> Reclaims unused Playwright browsers and caches
 *   qwenproxy reset     -> Resets rate-limit and auth cooldowns
 *   qwenproxy purge     -> Deletes remote chats across configured accounts
 *   qwenproxy login     -> Authenticates accounts via visible browser
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(packageRoot, "package.json");

const rawArgs = process.argv.slice(2);
const firstArg = rawArgs[0]?.toLowerCase();

// 1. Version check
if (rawArgs.includes("-v") || rawArgs.includes("--version") || firstArg === "version") {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    console.log(`QwenProxy v${pkg.version || "1.0.0"}`);
  } catch {
    console.log("QwenProxy v1.0.0");
  }
  process.exit(0);
}

// 2. Help check
if (rawArgs.includes("-h") || rawArgs.includes("--help") || firstArg === "help") {
  console.log(`
QwenProxy — High-performance AI Coding Gateway & Management TUI

Usage:
  qwenproxy [options] [command]
  qpx [options] [command]

Commands:
  (default)     Launch interactive TUI management dashboard and proxy
  start         Run headless HTTP/SSE proxy server
  login         Authenticate new accounts via visible browser
  sync          Synchronize AI clients (Claude Code, Codex, OpenCode, OMP)
  clean         Prune transient profile caches
  clean:all     Prune profile caches and clean unused Playwright browsers
  reset         Reset rate-limit and auth cooldowns in database
  purge         Delete remote chats across configured accounts

Options:
  --tui         Open interactive TUI dashboard (default)
  --server      Run in headless server mode
  --port <num>  Override server listening port (default: 7936)
  -v, --version Show version number
  -h, --help    Show this help message
`);
  process.exit(0);
}

// 3. Command dispatcher
let scriptFile = "src/index.ts";
let scriptArgs = [];

if (firstArg === "start" || rawArgs.includes("--server")) {
  scriptFile = "src/index.ts";
  scriptArgs = rawArgs.filter((a) => a !== "start" && a !== "--server");
} else if (firstArg === "tui" || rawArgs.includes("--tui") || rawArgs.length === 0) {
  scriptFile = "src/index.ts";
  scriptArgs = ["--tui", ...rawArgs.filter((a) => a !== "tui" && a !== "--tui")];
} else if (firstArg === "sync") {
  scriptFile = "src/sync-clients.ts";
  scriptArgs = rawArgs.slice(1);
} else if (firstArg === "clean") {
  scriptFile = "src/clean-cache.ts";
  scriptArgs = rawArgs.slice(1);
} else if (firstArg === "clean:all") {
  scriptFile = "src/clean-cache.ts";
  scriptArgs = ["--all", ...rawArgs.slice(1)];
} else if (firstArg === "reset") {
  scriptFile = "src/reset-cooldowns.ts";
  scriptArgs = rawArgs.slice(1);
} else if (firstArg === "purge") {
  scriptFile = "src/delete-chats.ts";
  scriptArgs = rawArgs.slice(1);
} else if (firstArg === "login") {
  scriptFile = "src/login.ts";
  scriptArgs = rawArgs.slice(1);
} else {
  // Pass through remaining options to index.ts with default TUI flag
  scriptFile = "src/index.ts";
  scriptArgs = ["--tui", ...rawArgs];
}

const targetPath = path.resolve(packageRoot, scriptFile);

// Resolve tsx loader relative to the package installation rather than cwd
let tsxLoaderArg = "tsx";
try {
  const tsxEntry = require.resolve("tsx");
  tsxLoaderArg = pathToFileURL(tsxEntry).href;
} catch {}

// Ensure Playwright Chromium is installed for first-time global users
try {
  const { chromium } = await import("playwright");
  const execPath = chromium.executablePath();
  if (!fs.existsSync(execPath)) {
    console.log("⏳ [QwenProxy] Instalando o navegador Chromium pela primeira vez (Playwright)...");
    spawnSync("npx", ["playwright", "install", "chromium"], {
      stdio: "inherit",
      shell: true,
    });
    console.log("✓ [QwenProxy] Navegador instalado com sucesso!\n");
  }
} catch {}

const child = spawn(process.execPath, ["--import", tsxLoaderArg, targetPath, ...scriptArgs], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

child.on("error", (err) => {
  console.error("❌ [QwenProxy] Failed to execute CLI script:", err.message);
  process.exit(1);
});
