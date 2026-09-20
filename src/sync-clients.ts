process.env.DOTENV_CONFIG_QUIET = "true";
import fs from "node:fs";
import dotenv from "dotenv";
import { ensureDataDirs, getEnvFilePath } from "./core/paths.ts";
import {
  syncAllClients,
  restoreAllClients,
  normalizeClientName,
  getDefaultPaths,
  inspectClientSyncStatus,
} from "./sync/index.ts";
import type { SyncClientName } from "./sync/types.ts";

ensureDataDirs();
const envPath = getEnvFilePath();
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true });
} else {
  dotenv.config({ quiet: true });
}

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
    targets: SyncClientName[];
    model?: string;
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
    } else if ((arg === "--model" || arg === "-m") && args[i + 1]) {
      options.model = args[++i];
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
  npm run sync [clientes...] [opções]

Exemplos:
  npm run sync                # Sincroniza todos os 10 clientes detectados
  npm run sync hermes         # Sincroniza apenas o Hermes Agent
  npm run sync opencode       # Sincroniza apenas o OpenCode
  npm run sync claude         # Sincroniza apenas o Claude Code
  npm run sync openclaw       # Sincroniza apenas o OpenClaw
  npm run sync kilo           # Sincroniza apenas o Kilo Code
  npm run sync cline          # Sincroniza apenas o Cline
  npm run sync omp            # Sincroniza apenas o OMP (Oh My Pi)
  npm run sync codex          # Sincroniza apenas o Codex CLI
  npm run sync zed            # Sincroniza apenas o Zed Editor
  npm run sync aider          # Sincroniza apenas o Aider
  npm run sync claude codex   # Sincroniza múltiplos clientes específicos
  npm run sync --list         # Lista status de detecção de todos os 10 clientes (ou qpx sync --list)
  npm run sync --restore      # Restaura as configurações originais (ou qpx sync --restore)

Opções:
  --client <nome>    Nome do cliente (hermes, opencode, claude, openclaw, kilo, cline, omp, codex, zed, aider)
  --model <modelo>   Modelo padrão a configurar (padrão: qwen3.8-max)
  --api-key <chave>  Sobrescrever chave de API (obrigatória; não usa placeholder)
  --port <porta>     Sobrescrever porta do servidor (padrão: lê do .env ou usa 7936)
  --host <host>      Sobrescrever host do servidor (padrão: 127.0.0.1)
  --no-active        Não definir o modelo ativo como padrão (apenas adiciona o provider)
  --restore          Desfaz alterações restaurando backups
  --list             Mostra status de detecção dos arquivos de configuração
`);
}

async function main() {
  const options = parseArgs();

  console.log("==================================================");
  console.log(" 🚀 QwenProxy - Top 10 Client Configuration Sync");
  console.log("==================================================");

  if (options.help) {
    printHelp();
    return;
  }

  if (options.list) {
    console.log("\n📁 Status de detecção dos 10 clientes no seu computador:\n");
    const defaultPaths = getDefaultPaths();
    const clients: { id: SyncClientName; name: string; path: string }[] = [
      { id: "hermes", name: "1. Hermes Agent", path: defaultPaths.hermes },
      { id: "opencode", name: "2. OpenCode", path: defaultPaths.openCode },
      { id: "claude-code", name: "3. Claude Code", path: defaultPaths.claudeCode },
      { id: "openclaw", name: "4. OpenClaw", path: defaultPaths.openClaw },
      { id: "kilo", name: "5. Kilo Code", path: defaultPaths.kilo },
      { id: "cline", name: "6. Cline", path: defaultPaths.cline },
      { id: "omp", name: "7. OMP (Oh My Pi)", path: defaultPaths.omp },
      { id: "codex", name: "8. Codex CLI", path: defaultPaths.codex },
      { id: "zed", name: "9. Zed Editor", path: defaultPaths.zed },
      { id: "aider", name: "10. Aider", path: defaultPaths.aider },
    ];

    for (const c of clients) {
      const status = inspectClientSyncStatus(c.id, c.path);
      let badge = "";
      let icon = "⚪";
      if (status.synced) {
        icon = "✅";
        badge = status.model ? `[Sincronizado: ${status.model}]` : "[Sincronizado]";
      } else if (status.installed) {
        icon = "⚠️ ";
        badge = "[Detectado - Outro provedor]";
      } else {
        icon = "⚪";
        badge = "[Não instalado]";
      }
      console.log(`  ${icon} ${c.name.padEnd(20)} ${badge}`);
      console.log(`     ${c.path}`);
    }
    console.log("\nPara sincronizar um ou todos, execute:");
    console.log("  npm run sync");
    console.log("  npm run sync hermes");
    console.log("  npm run sync claude cline zed\n");
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
    model: options.model,
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
  console.log("   qpx sync --restore (ou npm run sync --restore)");
}

main().catch((err) => {
  console.error("❌ Erro fatal durante a sincronização:", err);
  process.exit(1);
});
