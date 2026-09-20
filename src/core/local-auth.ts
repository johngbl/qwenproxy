import crypto from "node:crypto";
import fs from "node:fs";
import { isRunningUnderNodeTest, getEnvFilePath } from "./paths.ts";

export const PLACEHOLDER_API_KEY = "sk-qwenproxy-local";

export function isPlaceholderApiKey(key?: string | null): boolean {
  const value = (key || "").trim();
  return value.length === 0 || value === PLACEHOLDER_API_KEY;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  );
}

export function isWildcardBind(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

export function getRuntimeApiKey(): string {
  return (process.env.API_KEY || "").trim();
}

export function localApiAuthHeaders(): Record<string, string> {
  const apiKey = getRuntimeApiKey();
  if (isPlaceholderApiKey(apiKey)) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

export function assertBindAllowed(host: string, apiKey: string): void {
  if (isLoopbackHost(host)) return;
  if (!isPlaceholderApiKey(apiKey)) return;
  throw new Error(
    `❌ [Server] HOST=${host} is reachable beyond loopback and requires a strong API_KEY.` +
      `\n   Bind 127.0.0.1 for local-only use, or set API_KEY before exposing ${host}.`,
  );
}

function persistApiKey(apiKey: string): void {
  const envPath = getEnvFilePath();
  try {
    const existing = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, "utf-8")
      : "";
    if (/(^|\n)API_KEY\s*=/.test(existing)) return;
    const prefix =
      existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(
      envPath,
      `${prefix}API_KEY=${apiKey}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch (err) {
    console.warn(
      "⚠️  [Server] Generated API_KEY but could not persist it to .env:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function ensureRuntimeApiKey(): string {
  const existing = getRuntimeApiKey();
  if (!isPlaceholderApiKey(existing)) return existing;
  if (isRunningUnderNodeTest()) return existing;

  const generated = `sk-qpx-${crypto.randomBytes(24).toString("base64url")}`;
  process.env.API_KEY = generated;
  persistApiKey(generated);
  console.warn(
    `🔐 [Server] Generated API_KEY and saved it to ${getEnvFilePath()}. Clients must send this Bearer token.`,
  );
  return generated;
}
