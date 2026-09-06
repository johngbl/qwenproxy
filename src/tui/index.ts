#!/usr/bin/env node
/**
 * QwenProxy TUI - Interactive Terminal Control Interface Entrypoint
 */

import { TuiApp } from "./app.ts";

function parseInitialTab(): number {
  const args = process.argv.slice(2);
  const tabArgIdx = args.findIndex((a) => a === "--tab" || a === "-t");
  if (tabArgIdx !== -1 && args[tabArgIdx + 1]) {
    const parsed = parseInt(args[tabArgIdx + 1], 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 6) {
      return parsed;
    }
  }

  // Positional numeric argument (e.g. `npm run tui 2`)
  const firstNumeric = args.find((a) => /^[1-6]$/.test(a));
  if (firstNumeric) {
    return parseInt(firstNumeric, 10);
  }

  return 1;
}

async function main() {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.log(
      "\x1b[33m[QwenProxy TUI]\x1b[0m A interface interativa TUI requer uma sessão de terminal interativo.",
    );
    console.log("Execute diretamente no seu terminal: npm run tui");
    process.exit(0);
  }

  const initialTab = parseInitialTab();
  const app = new TuiApp(initialTab);

  process.on("uncaughtException", async (err) => {
    try {
      await app.stop();
    } catch {}
    console.error("[QwenProxy TUI] Erro inesperado:", err);
    process.exit(1);
  });

  process.on("unhandledRejection", async (err) => {
    try {
      await app.stop();
    } catch {}
    console.error("[QwenProxy TUI] Promessa rejeitada:", err);
    process.exit(1);
  });

  await app.start();
}

main().catch((err) => {
  console.error("[QwenProxy TUI] Falha ao inicializar:", err);
  process.exit(1);
});
