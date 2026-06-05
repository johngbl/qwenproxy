import crypto from "crypto";
import { config } from "../core/config.ts";
import { getDatabase } from "../core/database.ts";
import { getAccountCredentials, type QwenAccount } from "../core/accounts.ts";
import { AuthError } from "../core/errors.js";
import { Mutex } from "../core/mutex.ts";

export { Mutex };

export interface AuthResult {
  accountId: string;
  cookie: string;
  userAgent: string;
  bxV: string;
  bxUa: string;
  bxUmidtoken: string;
  userId?: string;
  expiresAt?: number;
}

export interface HeaderResult {
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
}

interface PersistedAuthSessionRow {
  account_id: string;
  cookie: string;
  user_agent: string;
  bx_v: string | null;
  bx_ua: string | null;
  bx_umidtoken: string | null;
  user_id: string | null;
  token_expires_at: number | null;
  updated_at: string;
}

const AUTH_CACHE_TTL_MS = 30 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const QWEN_WEB_VERSION = "0.2.63";

const authCache = new Map<string, { result: AuthResult; cachedAt: number }>();
const authMutexes = new Map<string, Mutex>();

function getAuthMutex(accountId: string): Mutex {
  let mutex = authMutexes.get(accountId);
  if (!mutex) {
    mutex = new Mutex();
    authMutexes.set(accountId, mutex);
  }
  return mutex;
}

export function isAuthMockEnabled(): boolean {
  return process.env.TEST_MOCK_QWEN_AUTH === "true";
}

export function hasGlobalCredentials(): boolean {
  return !!(process.env.QWEN_EMAIL && process.env.QWEN_PASSWORD);
}

function accountKey(accountId?: string): string {
  return accountId || "global";
}

function defaultAuthResult(accountId = "global"): AuthResult {
  return {
    accountId,
    cookie: "token=mock",
    userAgent: "mock",
    bxV: config.auth.bxV,
    bxUa: "",
    bxUmidtoken: "",
    userId: "mock-user",
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
}

function authResultToHeaders(result: AuthResult): Record<string, string> {
  const headers: Record<string, string> = {
    cookie: result.cookie,
    "user-agent": result.userAgent,
    "bx-v": result.bxV || config.auth.bxV,
  };

  if (result.bxUa) headers["bx-ua"] = result.bxUa;
  if (result.bxUmidtoken) headers["bx-umidtoken"] = result.bxUmidtoken;

  return headers;
}

function splitSetCookieHeader(header: string): string[] {
  const parts: string[] = [];
  let start = 0;

  for (let i = 0; i < header.length; i++) {
    if (header[i] !== ",") continue;

    const rest = header.slice(i + 1);
    if (/^\s*[^=;,\s]+=/.test(rest)) {
      parts.push(header.slice(start, i).trim());
      start = i + 1;
    }
  }

  parts.push(header.slice(start).trim());
  return parts.filter(Boolean);
}

function extractCookieHeader(headers: Headers): string {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies = withGetSetCookie.getSetCookie?.() ?? [];
  const rawSetCookie = headers.get("set-cookie");
  const cookieLines =
    setCookies.length > 0
      ? setCookies
      : rawSetCookie
        ? splitSetCookieHeader(rawSetCookie)
        : [];

  return cookieLines
    .map((cookie) => cookie.split(";")[0]?.trim() || "")
    .filter((cookie) => cookie.includes("="))
    .join("; ");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function getTokenExpiration(cookie: string): number | undefined {
  const match = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  if (!match) return undefined;

  const [, token] = match;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;

  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function isAuthResultFresh(result: AuthResult, cachedAt: number): boolean {
  const now = Date.now();
  if (!result.cookie.includes("token=")) return false;
  if (result.expiresAt) return result.expiresAt - now > TOKEN_REFRESH_BUFFER_MS;
  return now - cachedAt < AUTH_CACHE_TTL_MS;
}

function rowToAuthResult(row: PersistedAuthSessionRow): AuthResult {
  return {
    accountId: row.account_id,
    cookie: row.cookie,
    userAgent: row.user_agent || config.auth.userAgent,
    bxV: row.bx_v || config.auth.bxV,
    bxUa: row.bx_ua || config.auth.bxUa,
    bxUmidtoken: row.bx_umidtoken || config.auth.bxUmidtoken,
    userId: row.user_id || undefined,
    expiresAt: row.token_expires_at || undefined,
  };
}

function readPersistedSession(accountId: string): AuthResult | null {
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT account_id, cookie, user_agent, bx_v, bx_ua, bx_umidtoken, user_id, token_expires_at, updated_at
         FROM qwen_auth_sessions
         WHERE account_id = ?`,
      )
      .get(accountId) as PersistedAuthSessionRow | undefined;

    if (!row) return null;

    const result = rowToAuthResult(row);
    const cachedAt = new Date(row.updated_at).getTime();
    if (isAuthResultFresh(result, Number.isFinite(cachedAt) ? cachedAt : 0)) {
      authCache.set(accountId, { result, cachedAt: Date.now() });
      return result;
    }

    db.prepare("DELETE FROM qwen_auth_sessions WHERE account_id = ?").run(
      accountId,
    );
  } catch {
    // SQLite is an optimization for session reuse; login can proceed without it.
  }

  return null;
}

function persistSession(result: AuthResult): void {
  try {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO qwen_auth_sessions (
         account_id, cookie, user_agent, bx_v, bx_ua, bx_umidtoken, user_id, token_expires_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(account_id) DO UPDATE SET
         cookie = excluded.cookie,
         user_agent = excluded.user_agent,
         bx_v = excluded.bx_v,
         bx_ua = excluded.bx_ua,
         bx_umidtoken = excluded.bx_umidtoken,
         user_id = excluded.user_id,
         token_expires_at = excluded.token_expires_at,
         updated_at = datetime('now')`,
    ).run(
      result.accountId,
      result.cookie,
      result.userAgent,
      result.bxV,
      result.bxUa,
      result.bxUmidtoken,
      result.userId ?? null,
      result.expiresAt ?? null,
    );
  } catch {
    // Avoid failing a valid auth flow only because persistence is unavailable.
  }
}

function resolveCredentials(accountId?: string): QwenAccount {
  if (accountId) {
    const account = getAccountCredentials(accountId);
    if (!account) {
      throw new AuthError(`Qwen account not found: ${accountId}`);
    }
    if (!account.password || account.password === "***") {
      throw new AuthError(
        `Qwen account ${account.email} has no stored password for HTTP login`,
      );
    }
    return account;
  }

  const email = process.env.QWEN_EMAIL?.trim();
  const password = process.env.QWEN_PASSWORD?.trim();
  if (!email || !password) {
    throw new AuthError(
      "Qwen credentials are not configured. Set QWEN_EMAIL/QWEN_PASSWORD or add accounts with npm run login.",
    );
  }

  return { id: "global", email, password };
}

export async function loginViaHttp(
  account: QwenAccount,
  options: { persist?: boolean } = {},
): Promise<AuthResult> {
  if (isAuthMockEnabled()) return defaultAuthResult(account.id || "global");

  const hashedPassword = crypto
    .createHash("sha256")
    .update(account.password)
    .digest("hex");

  const response = await fetch(`${config.qwen.baseUrl}/api/v2/auths/signin`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      source: "web",
      timezone: new Date().toString().split(" (")[0],
      "x-request-id": crypto.randomUUID(),
      "user-agent": config.auth.userAgent,
    },
    body: JSON.stringify({
      email: account.email,
      password: hashedPassword,
      login_type: "email",
    }),
  });

  const raw = await response.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  let cookie = extractCookieHeader(response.headers);
  const tokenFallback =
    data?.token ||
    data?.access_token ||
    data?.data?.token ||
    data?.data?.access_token;
  if (!cookie && typeof tokenFallback === "string") {
    cookie = `token=${tokenFallback}`;
  }

  if (!response.ok || data?.success === false || !cookie.includes("token=")) {
    const reason =
      data?.message ||
      data?.data?.details ||
      data?.error ||
      raw ||
      response.statusText;
    throw new AuthError(
      `Qwen HTTP login failed for ${account.email}: ${response.status} ${String(reason).slice(0, 300)}`,
    );
  }

  const result: AuthResult = {
    accountId: account.id || "global",
    cookie,
    userAgent: config.auth.userAgent,
    bxV: config.auth.bxV,
    bxUa: config.auth.bxUa,
    bxUmidtoken: config.auth.bxUmidtoken,
    userId: data?.data?.id || data?.id,
    expiresAt: getTokenExpiration(cookie),
  };

  authCache.set(result.accountId, { result, cachedAt: Date.now() });
  if (options.persist !== false) persistSession(result);

  return result;
}

async function getAuthSession(
  accountId?: string,
  options: { forceRefresh?: boolean } = {},
): Promise<AuthResult> {
  const key = accountKey(accountId);
  if (isAuthMockEnabled()) return defaultAuthResult(key);

  const cached = authCache.get(key);
  if (
    !options.forceRefresh &&
    cached &&
    isAuthResultFresh(cached.result, cached.cachedAt)
  ) {
    return cached.result;
  }

  const release = await getAuthMutex(key).acquire();
  try {
    const refreshed = authCache.get(key);
    if (
      !options.forceRefresh &&
      refreshed &&
      isAuthResultFresh(refreshed.result, refreshed.cachedAt)
    ) {
      return refreshed.result;
    }

    if (!options.forceRefresh) {
      const persisted = readPersistedSession(key);
      if (persisted) return persisted;
    }

    return await loginViaHttp(resolveCredentials(accountId), { persist: true });
  } finally {
    release();
  }
}

export async function initHttpAuth(forceRefresh = false): Promise<void> {
  if (isAuthMockEnabled()) return;
  await getAuthSession(undefined, { forceRefresh });
}

export async function initHttpAuthForAccount(
  account: QwenAccount,
  forceRefresh = false,
): Promise<void> {
  if (isAuthMockEnabled()) return;

  if (!forceRefresh) {
    const cached = authCache.get(account.id);
    if (cached && isAuthResultFresh(cached.result, cached.cachedAt)) return;
    const persisted = readPersistedSession(account.id);
    if (persisted) return;
  }

  await loginViaHttp(account, { persist: true });
}

export async function reauthenticateAccount(
  accountId?: string,
): Promise<AuthResult> {
  clearAccountAuthCache(accountKey(accountId), true);
  return getAuthSession(accountId, { forceRefresh: true });
}

export async function getCookies(accountId?: string): Promise<string> {
  return (await getAuthSession(accountId)).cookie;
}

export async function getBasicHeaders(accountId?: string): Promise<{
  cookie: string;
  userAgent: string;
  bxV: string;
  bxUa: string;
  bxUmidtoken: string;
}> {
  const result = await getAuthSession(accountId);
  return {
    cookie: result.cookie,
    userAgent: result.userAgent,
    bxV: result.bxV,
    bxUa: result.bxUa,
    bxUmidtoken: result.bxUmidtoken,
  };
}

export async function getQwenHeaders(
  forceNew = false,
  accountId?: string,
  _skipMutex = false,
): Promise<HeaderResult> {
  const result = await getAuthSession(accountId, { forceRefresh: forceNew });
  return {
    headers: authResultToHeaders(result),
    chatSessionId: "",
    parentMessageId: null,
  };
}

export function clearAccountAuthCache(
  accountId: string,
  deletePersisted = false,
): void {
  const key = accountKey(accountId === "global" ? undefined : accountId);
  authCache.delete(key);

  if (deletePersisted && !isAuthMockEnabled()) {
    try {
      getDatabase()
        .prepare("DELETE FROM qwen_auth_sessions WHERE account_id = ?")
        .run(key);
    } catch {}
  }
}

export function clearAuthCache(deletePersisted = false): void {
  authCache.clear();
  authMutexes.clear();

  if (deletePersisted && !isAuthMockEnabled()) {
    try {
      getDatabase().prepare("DELETE FROM qwen_auth_sessions").run();
    } catch {}
  }
}

export async function closeHttpAuth(): Promise<void> {
  clearAuthCache(false);
}

export { QWEN_WEB_VERSION };
