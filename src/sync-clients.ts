import "dotenv/config";
import {
  syncAllClients,
  restoreAllClients,
  normalizeClientName,
  getDefaultPaths,
} from "./sync/index.ts";
import fs from "node:fs";

function parseArgs() {
  const args = process.argv.slice(2);
  const options: {
    restore: boolean;
    list: boolean;
    help: boolean;
    apiKey?: string;
    port?: number;
    host?: string;
    setActive: boolean;
    targets: ("claude-code" | "codex" | "opencode" | "omp")[];
  } = {
    restore: false,
    list: false,
    help: false,
    setActive: true,
    targets: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--restore" || arg === "restore") {
      options.restore = true;
    } else if (arg === "--list" || arg === "list") {
      options.list = true;
    } else if (arg === "--help" || arg === "-h" || arg === "help") {
      options.help = true;
    } else if (arg === "--api-key" && args[i + 1]) {
      options.apiKey = args[++i];
    } else if (arg === "--port" && args[i + 1]) {
      options.port = parseInt(args[++i], 10);
    } else if (arg === "--host" && args[i + 1]) {
      options.host = args[++i];
    } else if (arg === "--no-active") {
      options.setActive = false;
    } else if (arg === "--client" && args[i + 1]) {
      const normalized = normalizeClientName(args[++i]);
      if (normalized) options.targets.push(normalized);
    } else if (!arg.startsWith("-")) {
      const normalized = normalizeClientName(arg);
      if (normalized) options.targets.push(normalized);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Uso:
  npm run sync:clients [clientes...] [opções]

Exemplos:
  npm run sync:clients                # Sincroniza todos os clientes detectados
  npm run sync:clients claude         # Sincroniza apenas o Claude Code
  npm run sync:clients codex          # Sincroniza apenas o Codex CLI
  npm run sync:clients opencode       # Sincroniza apenas o OpenCode
  npm run sync:clients omp            # Sincroniza apenas o OMP (Oh My Pi)
  npm run sync:clients claude codex   # Sincroniza Claude Code e Codex
  npm run sync:clients --list         # Lista os arquivos dos clientes detectados
  npm run sync:clients --restore      # Restaura as configurações originais (rollback)

Opções:
  --client <nome>    Nome do cliente (claude, codex, opencode, omp)
  --api-key <chave>  Sobrescrever chave de API (padrão: lê do .env ou usa sk-qwenproxy-local)
  --port <porta>     Sobrescrever porta do servidor (padrão: lê do .env ou usa 7936)
  --host <host>      Sobrescrever host do servidor (padrão: 127.0.0.1)
  --no-active        Não definir o modelo ativo no Codex (apenas adiciona o provider)
  --restore          Desfaz alterações restaurando backups
  --list             Mostra status de detecção dos arquivos de configuração
`);
}

async function main() {
  const options = parseArgs();

  console.log("==================================================");
  console.log(" 🚀 QwenProxy - Client Configuration Sync");
  console.log("==================================================");

  if (options.help) {
    printHelp();
    return;
  }

  if (options.list) {
    console.log("\n📁 Status de detecção dos clientes no seu computador:\n");
    const defaultPaths = getDefaultPaths();
    const clients = [
      { id: "claude-code", name: "Claude Code", path: defaultPaths.claudeCode },
      { id: "codex", name: "Codex CLI", path: defaultPaths.codex },
      { id: "opencode", name: "OpenCode", path: defaultPaths.openCode },
      { id: "omp", name: "OMP (Oh My Pi)", path: defaultPaths.omp },
    ];

    for (const c of clients) {
      const exists = fs.existsSync(c.path);
      const icon = exists ? "✅" : "⚪";
      console.log(`  ${icon} ${c.name.padEnd(16)} ${exists ? "[Encontrado]" : "[Não encontrado]"}`);
      console.log(`     ${c.path}`);
    }
    console.log("\nPara sincronizar um ou todos, execute:");
    console.log("  npm run sync:clients");
    console.log("  npm run sync:clients claude\n");
    return;
  }

  if (options.restore) {
    console.log("\n🔄 Restaurando configurações originais a partir dos backups...\n");
    const result = restoreAllClients();
    if (result.restoredCount === 0) {
      console.log("ℹ️ Nenhum backup ou arquivo de estado anterior encontrado para restaurar.");
    } else {
      for (const item of result.details) {
        console.log(`  ✓ Restaurado [${item.client}]: ${item.filePath}`);
      }
      console.log(`\n✅ ${result.restoredCount} configuração(ões) restaurada(s) com sucesso!`);
    }
    return;
  }

  const targetNames = options.targets.length > 0
    ? options.targets.join(", ")
    : "todos os detectados";

  console.log(`\n📡 Sincronizando clientes: [${targetNames}]...\n`);

  const result = syncAllClients({
    apiKey: options.apiKey,
    port: options.port,
    host: options.host,
    setActive: options.setActive,
    targets: options.targets.length > 0 ? options.targets : undefined,
  });

  console.log(`🔑 Chave API:   ${result.apiKey}`);
  console.log(`🌐 Porta:       ${result.port}`);
  console.log(`🏠 Host:        ${result.host}\n`);

  let count = 0;
  for (const client of Object.values(result.clients)) {
    if (!client) continue;
    count++;
    const icon = client.success ? "✅" : "❌";
    console.log(`${icon} [${client.client}]`);
    console.log(`   Arquivo: ${client.filePath}`);
    if (client.backupPath) {
      console.log(`   Backup:  ${client.backupPath}`);
    }
    if (client.message) {
      console.log(`   Status:  ${client.message}`);
    }
    if (client.error) {
      console.log(`   Erro:    ${client.error}`);
    }
    console.log("");
  }

  console.log("--------------------------------------------------");
  console.log(`✨ ${count} cliente(s) sincronizado(s) com zero perda de outras configs/provedores!`);
  console.log("💡 Para desfazer e restaurar a qualquer momento:");
  console.log("   npm run sync:clients -- --restore");
  console.log("==================================================\n");
}

main().catch((err) => {
  console.error("❌ Erro fatal durante a sincronização:", err);
  process.exit(1);
});
