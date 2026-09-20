import "dotenv/config";
import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";
import { getDatabase } from "./database.ts";
import { decrypt, encrypt } from "./crypto-utils.ts";
import { getAccountProfilePath, getProfilesDir } from "./paths.ts";

export interface QwenAccount {
  id: string;
  email: string;
  password: string;
  cooldown_until?: number;
  cooldown_reason?: string | null;
}

function generateId(email: string): string {
  return crypto
    .createHash("md5")
    .update(email)
    .digest("hex")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
}

function parseEnvAccounts(): QwenAccount[] {
  const envAccounts = process.env.QWEN_ACCOUNTS;
  if (!envAccounts) return [];

  const clean = (s: string) => s.trim().replace(/^[,;\s"'`]+|[,;\s"'`]+$/g, "").trim();

  const lines = envAccounts.split(/[\r\n;]+/);
  const rawEntries: string[] = [];

  for (const rawLine of lines) {
    const line = clean(rawLine);
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    // Check if line contains multiple accounts separated by comma (e.g. "a@b.com:p1, c@d.com:p2")
    if (line.includes(",") && (line.match(/@/g) || []).length > 1) {
      for (const seg of line.split(",")) {
        const trimmed = clean(seg);
        if (trimmed) rawEntries.push(trimmed);
      }
    } else {
      const trimmed = clean(line);
      if (trimmed) rawEntries.push(trimmed);
    }
  }

  return rawEntries
    .map((entry, index) => {
      const trimmed = clean(entry);
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) {
        console.warn(
          `[Accounts] Invalid QWEN_ACCOUNTS entry at index ${index}: "${trimmed}"`,
        );
        return null;
      }
      const email = clean(trimmed.substring(0, colonIdx));
      const password = clean(trimmed.substring(colonIdx + 1));
      if (!email || !password) {
        console.warn(
          `[Accounts] Invalid QWEN_ACCOUNTS entry at index ${index}: "${trimmed}"`,
        );
        return null;
      }
      return {
        id: generateId(email),
        email,
        password,
      };
    })
    .filter((a): a is QwenAccount => a !== null);
}

let lastSyncedEnv = "";
let lastSyncTime = 0;
const SYNC_INTERVAL = 30_000;

function syncEnvAccounts(): void {
  const envAccounts = process.env.QWEN_ACCOUNTS || "";
  const now = Date.now();
  if (envAccounts === lastSyncedEnv && now - lastSyncTime < SYNC_INTERVAL)
    return;

  lastSyncedEnv = envAccounts;
  lastSyncTime = now;

  const accounts = parseEnvAccounts();
  if (accounts.length === 0) return;

  const db = getDatabase();
  const upsert = db.prepare(`
    INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET password = excluded.password, updated_at = datetime('now')
  `);

  const sync = db.transaction(() => {
    for (const acc of accounts) {
      upsert.run(acc.id, acc.email, encrypt(acc.password));
    }
  });

  sync();
}

let accountsCache: QwenAccount[] | null = null;
let accountsCacheTime = 0;
const ACCOUNTS_CACHE_TTL = 5_000;

function getCachedAccounts(): QwenAccount[] {
  syncEnvAccounts();

  const now = Date.now();
  if (accountsCache && now - accountsCacheTime < ACCOUNTS_CACHE_TTL) {
    return accountsCache;
  }

  const db = getDatabase();
  const rows = db
    .prepare(
      "SELECT id, email, password, cooldown_until, cooldown_reason FROM accounts ORDER BY created_at ASC",
    )
    .all() as QwenAccount[];

  accountsCache = rows.map((row) => {
    let password = "";
    try {
      password = decrypt(row.password);
    } catch {
      password = "";
    }
    return { ...row, password };
  });
  accountsCacheTime = now;
  return accountsCache;
}

export function loadAccounts(): QwenAccount[] {
  return getCachedAccounts().map((account) => ({
    ...account,
    password: "***",
  }));
}

export function invalidateAccountsCache(): void {
  accountsCache = null;
  accountsCacheTime = 0;
  lastSyncedEnv = "";
  lastSyncTime = 0;
}
export interface BatchAccountEntry {
  email: string;
  password: string;
}

export function parseBatchAccounts(rawInput: string): {
  entries: BatchAccountEntry[];
  invalid: string[];
} {
  if (!rawInput || typeof rawInput !== "string") {
    return { entries: [], invalid: [] };
  }

  let text = rawInput.trim();
  // Strip optional QWEN_ACCOUNTS= prefix and surrounding quotes
  text = text.replace(/^QWEN_ACCOUNTS\s*=\s*["']?/i, "").replace(/["']?\s*$/i, "");

  const lines = text.split(/\r?\n/);
  const entries: BatchAccountEntry[] = [];
  const invalid: string[] = [];
  const seenEmails = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    // Check if line contains multiple accounts separated by comma or semicolon
    const segments =
      (line.includes(",") || line.includes(";")) && (line.match(/@/g) || []).length > 1
        ? line.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
        : [line];

    for (const seg of segments) {
      let email = "";
      let password = "";

      const clean = (s: string) => s.trim().replace(/^[,;\s"'`]+|[,;\s"'`]+$/g, "").trim();
      if (seg.includes("---")) {
        const parts = seg.split("---");
        email = clean(parts[0]);
        password = clean(parts.slice(1).join("---"));
      } else if (seg.includes("\t")) {
        const parts = seg.split("\t");
        email = clean(parts[0]);
        password = clean(parts.slice(1).join("\t"));
      } else if (seg.includes(" | ")) {
        const parts = seg.split(" | ");
        email = clean(parts[0]);
        password = clean(parts.slice(1).join(" | "));
      } else if (seg.includes(":")) {
        const colonIdx = seg.indexOf(":");
        email = clean(seg.slice(0, colonIdx));
        password = clean(seg.slice(colonIdx + 1));
      } else if (seg.includes(",")) {
        const commaIdx = seg.indexOf(",");
        email = clean(seg.slice(0, commaIdx));
        password = clean(seg.slice(commaIdx + 1));
      } else {
        invalid.push(seg);
        continue;
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!email || !password || !emailRegex.test(email)) {
        invalid.push(seg);
        continue;
      }

      const normalizedEmail = email.toLowerCase();
      if (!seenEmails.has(normalizedEmail)) {
        seenEmails.add(normalizedEmail);
        entries.push({ email, password });
      }
    }
  }

  return { entries, invalid };
}

export function addAccountsBatch(
  entries: BatchAccountEntry[],
): { added: QwenAccount[]; skipped: string[]; invalid: string[] } {
  const db = getDatabase();
  const added: QwenAccount[] = [];
  const skipped: string[] = [];
  const invalid: string[] = [];

  const existingEmails = new Set(
    (db.prepare("SELECT email FROM accounts").all() as Array<{ email: string }>).map((r) =>
      r.email.toLowerCase(),
    ),
  );

  const insertStmt = db.prepare(
    "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
  );

  const insertBatch = db.transaction((items: BatchAccountEntry[]) => {
    for (const item of items) {
      const email = item.email.trim();
      const password = item.password;
      if (!email || !password) {
        invalid.push(email || "(empty)");
        continue;
      }

      if (existingEmails.has(email.toLowerCase())) {
        skipped.push(email);
        continue;
      }

      const newAccount: QwenAccount = {
        id: crypto.randomUUID(),
        email,
        password,
      };

      insertStmt.run(newAccount.id, newAccount.email, encrypt(newAccount.password));
      existingEmails.add(email.toLowerCase());
      added.push(newAccount);
    }
  });

  insertBatch(entries);

  if (added.length > 0) {
    invalidateAccountsCache();
  }

  return { added, skipped, invalid };
}
export function addAccount(
  email: string,
  password: string,
  id?: string,
): QwenAccount {
  if (!email || typeof email !== "string" || email.trim().length === 0) {
    throw new Error("Email is required");
  }

  const db = getDatabase();

  const existing = db
    .prepare("SELECT id FROM accounts WHERE email = ?")
    .get(email.trim());
  if (existing) {
    throw new Error("Account with this email already exists");
  }

  const newAccount: QwenAccount = {
    id: id || crypto.randomUUID(),
    email: email.trim(),
    password,
  };

  db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)").run(
    newAccount.id,
    newAccount.email,
    encrypt(newAccount.password),
  );

  invalidateAccountsCache();
  return newAccount;
}

function wipeAccountSessionFiles(id: string): void {
  const profilePath = getAccountProfilePath(id);
  try {
    fs.rmSync(profilePath, { recursive: true, force: true });
  } catch {}
  const siblingState = path.join(getProfilesDir(), `${id}_state.json`);
  try {
    fs.rmSync(siblingState, { force: true });
  } catch {}
}

export function removeAccount(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  if (result.changes > 0) {
    wipeAccountSessionFiles(id);
  }
  invalidateAccountsCache();
  return result.changes > 0;
}

export function listAccounts(): QwenAccount[] {
  return loadAccounts();
}

export function getAccountCredentials(id: string): QwenAccount | undefined {
  const cached = getCachedAccounts();
  return cached.find((a) => a.id === id);
}

export function updateAccountCooldown(
  id: string,
  cooldownUntil: number,
  reason: string | null,
): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE accounts SET cooldown_until = ?, cooldown_reason = ? WHERE id = ?",
  ).run(cooldownUntil, reason, id);
  invalidateAccountsCache();
}
