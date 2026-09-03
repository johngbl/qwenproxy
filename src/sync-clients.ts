import { syncAllClients, restoreAllClients } from "./sync/index.ts";

function parseArgs() {
  const args = process.argv.slice(2);
  const options: {
    restore: boolean;
    apiKey?: string;
    port?: number;
    host?: string;
    setActive: boolean;
  } = {
    restore: false,
    setActive: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--restore" || arg === "restore") {
      options.restore = true;
    } else if (arg === "--api-key" && args[i + 1]) {
      options.apiKey = args[++i];
    } else if (arg === "--port" && args[i + 1]) {
      options.port = parseInt(args[++i], 10);
    } else if (arg === "--host" && args[i + 1]) {
      options.host = args[++i];
    } else if (arg === "--no-active") {
      options.setActive = false;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  console.log("==================================================");
  console.log(" 🚀 QwenProxy - Client Configuration Sync");
  console.log("==================================================\n");

  if (options.restore) {
    console.log("🔄 Rolling back all client configurations from backups...\n");
    const result = restoreAllClients();
    if (result.restoredCount === 0) {
      console.log("ℹ️ No previous sync state or backup files found to restore.");
    } else {
      for (const item of result.details) {
        console.log(`  ✓ Restored [${item.client}]: ${item.filePath}`);
      }
      console.log(`\n✅ Successfully restored ${result.restoredCount} client configuration(s)!`);
    }
    return;
  }

  console.log("📡 Detecting installed coding agents and synchronizing providers...\n");

  const result = syncAllClients({
    apiKey: options.apiKey,
    port: options.port,
    host: options.host,
    setActive: options.setActive,
  });

  console.log(`🔑 API Key:     ${result.apiKey}`);
  console.log(`🌐 Server Port: ${result.port}`);
  console.log(`🏠 Host:        ${result.host}\n`);

  let count = 0;
  for (const client of Object.values(result.clients)) {
    if (!client) continue;
    count++;
    const icon = client.success ? "✅" : "❌";
    console.log(`${icon} [${client.client}]`);
    console.log(`   File:   ${client.filePath}`);
    if (client.backupPath) {
      console.log(`   Backup: ${client.backupPath}`);
    }
    if (client.message) {
      console.log(`   Status: ${client.message}`);
    }
    if (client.error) {
      console.log(`   Error:  ${client.error}`);
    }
    console.log("");
  }

  console.log("--------------------------------------------------");
  console.log(`✨ Synced ${count} client(s) with zero loss of other configs/providers!`);
  console.log("💡 To undo/revert changes at any time, run:");
  console.log("   npm run sync:clients -- --restore");
  console.log("==================================================\n");
}

main().catch((err) => {
  console.error("❌ Fatal error during client sync:", err);
  process.exit(1);
});
