import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DATA_DIR = path.resolve("data");
const DB_DIR = path.join(DATA_DIR, "db");
const DB_PATH = path.join(DB_DIR, "qwenbridge.db");
const LEGACY_DB_PATH = path.join(DATA_DIR, "qwenproxy.db");
const LEGACY_DB_IN_DIR_PATH = path.join(DB_DIR, "qwenproxy.db");
const LEGACY_DB_WAL_PATH = `${LEGACY_DB_PATH}-wal`;
const LEGACY_DB_SHM_PATH = `${LEGACY_DB_PATH}-shm`;
const LEGACY_DB_IN_DIR_WAL_PATH = `${LEGACY_DB_IN_DIR_PATH}-wal`;
const LEGACY_DB_IN_DIR_SHM_PATH = `${LEGACY_DB_IN_DIR_PATH}-shm`;
const DB_WAL_PATH = `${DB_PATH}-wal`;
const DB_SHM_PATH = `${DB_PATH}-shm`;
const LEGACY_JSON_PATH = path.resolve("accounts.json");
const LEGACY_JSON_BAK_PATH = path.resolve("accounts.json.bak");
const DB_JSON_BAK_PATH = path.join(DB_DIR, "accounts.json.bak");

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (db) return db;

  // Ensure data directory exists with proper permissions
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o755 });
    }
    const migrateLegacyDatabase = (
      legacyPath: string,
      legacyWalPath: string,
      legacyShmPath: string,
    ) => {
      if (fs.existsSync(legacyPath) && !fs.existsSync(DB_PATH)) {
        fs.renameSync(legacyPath, DB_PATH);
        if (fs.existsSync(legacyWalPath) && !fs.existsSync(DB_WAL_PATH)) {
          fs.renameSync(legacyWalPath, DB_WAL_PATH);
        }
        if (fs.existsSync(legacyShmPath) && !fs.existsSync(DB_SHM_PATH)) {
          fs.renameSync(legacyShmPath, DB_SHM_PATH);
        }
        console.log(`[Database] Migrated legacy database to ${DB_PATH}`);
      }
    };

    migrateLegacyDatabase(
      LEGACY_DB_PATH,
      LEGACY_DB_WAL_PATH,
      LEGACY_DB_SHM_PATH,
    );
    migrateLegacyDatabase(
      LEGACY_DB_IN_DIR_PATH,
      LEGACY_DB_IN_DIR_WAL_PATH,
      LEGACY_DB_IN_DIR_SHM_PATH,
    );
    if (
      fs.existsSync(LEGACY_JSON_BAK_PATH) &&
      !fs.existsSync(DB_JSON_BAK_PATH)
    ) {
      fs.renameSync(LEGACY_JSON_BAK_PATH, DB_JSON_BAK_PATH);
    }
    // Test write access
    const testFile = path.join(DB_DIR, ".write-test");
    fs.writeFileSync(testFile, "");
    fs.unlinkSync(testFile);
  } catch (err: any) {
    console.error(
      `[Database] Cannot access database directory '${DB_DIR}':`,
      err.message,
    );
    console.error(
      "[Database] Ensure the directory exists and has proper permissions",
    );
    console.error("[Database] In Docker, mount a volume: -v ./data:/app/data");
    throw new Error(`Database directory not accessible: ${DB_DIR}`);
  }

  try {
    db = new Database(DB_PATH);
  } catch (err: any) {
    console.error(
      `[Database] Failed to open database at '${DB_PATH}':`,
      err.message,
    );
    console.error("[Database] Check file permissions and disk space");
    throw err;
  }

  // Enable WAL mode for better concurrent read performance (ideal for VPS)
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000"); // 64MB cache
  db.pragma("foreign_keys = ON");

  runMigrations(db);
  migrateFromJson(db);

  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);

    CREATE TABLE IF NOT EXISTS logical_thread_states (
      session_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      chat_session_id TEXT NOT NULL,
      parent_id TEXT,
      instructions_sent INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_thread_updated ON logical_thread_states(updated_at);

    CREATE TABLE IF NOT EXISTS thread_context_sessions (
      session_id TEXT PRIMARY KEY,
      client_name TEXT,
      account_id TEXT,
      active_chat_session_id TEXT,
      active_parent_id TEXT,
      previous_chat_session_id TEXT,
      model TEXT NOT NULL,
      model_context_window INTEGER NOT NULL DEFAULT 0,
      system_prompt TEXT,
      tool_instructions_hash TEXT,
      estimated_thread_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_recent_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_summary_tokens INTEGER NOT NULL DEFAULT 0,
      latest_summary_id INTEGER,
      summary_sequence INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'normal',
      rollover_count INTEGER NOT NULL DEFAULT 0,
      last_summary_at TEXT,
      last_rollover_at TEXT,
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_thread_context_sessions_status
      ON thread_context_sessions(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_thread_context_sessions_activity
      ON thread_context_sessions(last_activity_at);

    CREATE TABLE IF NOT EXISTS thread_context_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      content_tokens INTEGER NOT NULL DEFAULT 0,
      qwen_account_id TEXT,
      qwen_chat_id TEXT,
      qwen_parent_id TEXT,
      qwen_response_id TEXT,
      is_auxiliary INTEGER NOT NULL DEFAULT 0,
      is_summarized INTEGER NOT NULL DEFAULT 0,
      is_recent_anchor INTEGER NOT NULL DEFAULT 0,
      usage_json TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(session_id) REFERENCES thread_context_sessions(session_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_thread_context_turns_session_id
      ON thread_context_turns(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_thread_context_turns_unsummarized
      ON thread_context_turns(session_id, is_auxiliary, is_summarized, id);

    CREATE TABLE IF NOT EXISTS thread_context_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      summary TEXT NOT NULL,
      summary_tokens INTEGER NOT NULL DEFAULT 0,
      source_turn_start INTEGER,
      source_turn_end INTEGER,
      model TEXT,
      account_id TEXT,
      summary_chat_id TEXT,
      compression_ratio REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(session_id) REFERENCES thread_context_sessions(session_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_thread_context_summaries_session_sequence
      ON thread_context_summaries(session_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS thread_context_rollovers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      from_account_id TEXT,
      from_chat_id TEXT,
      to_account_id TEXT,
      to_chat_id TEXT,
      summary_id INTEGER,
      reason TEXT NOT NULL,
      old_estimated_tokens INTEGER,
      new_initial_tokens INTEGER,
      old_chat_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(session_id) REFERENCES thread_context_sessions(session_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_thread_context_rollovers_session
      ON thread_context_rollovers(session_id, id);
  `);
}

/**
 * Auto-migrate existing accounts.json into SQLite on first run.
 * The legacy JSON file is moved to data/db/accounts.json.bak after successful migration.
 */
function migrateFromJson(db: Database.Database): void {
  const jsonPath = LEGACY_JSON_PATH;
  if (!fs.existsSync(jsonPath)) return;

  try {
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const accounts = JSON.parse(raw) as Array<{
      id: string;
      email: string;
      password: string;
    }>;

    if (!Array.isArray(accounts) || accounts.length === 0) {
      // Empty or invalid file — just rename it
      fs.renameSync(jsonPath, DB_JSON_BAK_PATH);
      return;
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO accounts (id, email, password) VALUES (?, ?, ?)
    `);

    const migrate = db.transaction(() => {
      for (const account of accounts) {
        if (
          account.id &&
          typeof account.email === "string" &&
          account.email.trim().length > 0
        ) {
          insert.run(account.id, account.email.trim(), account.password || "");
        }
      }
    });

    migrate();

    // Rename old file to .bak to avoid re-migration
    fs.renameSync(jsonPath, DB_JSON_BAK_PATH);
    console.log(
      `[Database] Migrated ${accounts.length} account(s) from accounts.json to SQLite`,
    );
  } catch (err: any) {
    console.error("[Database] Failed to migrate accounts.json:", err.message);
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
