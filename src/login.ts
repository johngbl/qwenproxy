import {
  addAccount,
  removeAccount,
  listAccounts,
  getAccountCredentials,
  type QwenAccount,
} from "./core/accounts.ts";
import { initHttpAuthForAccount, loginViaHttp } from "./services/auth-http.ts";
import { maskEmail } from "./core/logger.ts";
import * as readline from "readline";
import * as dotenv from "dotenv";

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim());
    });
  });
}

function clear() {
  process.stdout.write("\x1Bc");
}

async function showMenu() {
  while (true) {
    const accounts = listAccounts();
    clear();
    console.log("=== QwenBridge Account Manager ===\n");
    console.log("Auth mode: HTTP-only (sem navegador)\n");

    if (accounts.length > 0) {
      console.log(`Configured accounts (${accounts.length}):\n`);
      for (let i = 0; i < accounts.length; i++) {
        console.log(
          `  [${i + 1}] ${accounts[i].email} (ID: ${accounts[i].id})`,
        );
      }
    } else {
      console.log("No accounts configured yet.\n");
    }

    console.log("\nOptions:");
    console.log("  [A] Add account and validate HTTP login");
    if (accounts.length > 0) {
      console.log("  [R] Remove an account");
      console.log("  [L] Refresh login for all accounts");
    }
    console.log("  [Q] Quit\n");

    const choice = (await askQuestion("Select an option: ")).toUpperCase();

    if (choice === "Q") {
      rl.close();
      process.exit(0);
    }

    if (choice === "A") {
      await addAccountFlow();
      continue;
    }

    if (choice === "R" && accounts.length > 0) {
      await removeAccountFlow();
      continue;
    }

    if (choice === "L" && accounts.length > 0) {
      await loginAllAccounts();
      await askQuestion("Press Enter to continue...");
    }
  }
}

async function addAccountFlow() {
  clear();
  console.log("=== Add New Account ===\n");
  const email = await askQuestion("Email: ");
  if (!email) {
    console.log("Email is required.");
    await askQuestion("Press Enter to continue...");
    return;
  }

  const password = await askQuestion("Password: ");
  if (!password) {
    console.log("Password is required.");
    await askQuestion("Press Enter to continue...");
    return;
  }

  let account: QwenAccount | null = null;
  try {
    account = addAccount(email, password);
    console.log("\nValidating credentials with Qwen HTTP login...");
    const result = await loginViaHttp(account, { persist: true });
    console.log(`Account added: ${maskEmail(account.email)} (${account.id})`);
    if (result.expiresAt) {
      console.log(
        `Session expires at: ${new Date(result.expiresAt).toISOString()}`,
      );
    }
  } catch (err: any) {
    if (account) removeAccount(account.id);
    console.log(`\nError: ${err.message}`);
  }

  await askQuestion("Press Enter to continue...");
}

async function removeAccountFlow() {
  const accounts = listAccounts();
  if (accounts.length === 0) return;

  clear();
  console.log("=== Remove Account ===\n");

  for (let i = 0; i < accounts.length; i++) {
    console.log(
      `  [${i + 1}] ${maskEmail(accounts[i].email)} (ID: ${accounts[i].id})`,
    );
  }

  const input = await askQuestion(
    "\nSelect account number to remove (or 0 to cancel): ",
  );
  const idx = parseInt(input) - 1;

  if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
    console.log(input !== "0" ? "Invalid selection." : "Cancelled.");
    await askQuestion("Press Enter to continue...");
    return;
  }

  const account = accounts[idx];
  const confirm = await askQuestion(`\nRemove ${account.email}? (y/N): `);
  if (confirm.toLowerCase() === "y") {
    if (removeAccount(account.id)) {
      console.log(`Account ${maskEmail(account.email)} removed.`);
    } else {
      console.log("Failed to remove account.");
    }
  } else {
    console.log("Cancelled.");
  }

  await askQuestion("Press Enter to continue...");
}

async function loginAllAccounts() {
  const accounts = listAccounts();
  if (accounts.length === 0) return;

  clear();
  console.log(`Refreshing HTTP login for ${accounts.length} account(s)...\n`);

  for (const account of accounts) {
    const creds = getAccountCredentials(account.id);
    if (!creds || creds.password === "***" || !creds.password) {
      console.log(
        `[Login] Skipping ${maskEmail(account.email)} - no password available`,
      );
      continue;
    }

    console.log(`[Login] Processing account: ${maskEmail(account.email)}`);
    try {
      await initHttpAuthForAccount(creds, true);
      console.log(`[Login] Account ${maskEmail(account.email)} session saved.`);
    } catch (err: any) {
      console.error(
        `[Login] Failed to login ${maskEmail(account.email)}: ${err.message}`,
      );
    }
  }

  console.log("\n[Login] All accounts processed.");
}

showMenu().catch((err) => {
  console.error(err);
  process.exit(1);
});
