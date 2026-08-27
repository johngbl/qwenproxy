import { clearAllAccountCooldowns } from "./core/account-manager.ts";
import { loadAccounts } from "./core/accounts.ts";

function main() {
  const accounts = loadAccounts();
  console.log(`🔍 Checking cooldowns for ${accounts.length} configured account(s)...`);
  const cleared = clearAllAccountCooldowns();
  console.log(`✅ Cooldowns reset successfully: ${cleared} account(s) cleared.`);
}

main();
