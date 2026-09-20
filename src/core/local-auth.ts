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

export function persistApiKey(
  apiKey: string,
  envPath = getEnvFilePath(),
): void {
  try {
    const existing = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, "utf-8")
      : "";
    const assignment = /^([ \t]*)API_KEY[ \t]*=[ \t]*(.*)$/m.exec(existing);
    if (assignment?.[2].trim()) return;

    let updated: string;
    if (assignment) {
      const start = assignment.index;
      const end = start + assignment[0].length;
      updated =
        existing.slice(0, start) +
        `${assignment[1]}API_KEY=${apiKey}` +
        existing.slice(end);
    } else {
      const lineEnding = existing.includes("\r\n") ? "\r\n" : "\n";
      const prefix =
        existing.length === 0 || existing.endsWith("\n") ? "" : lineEnding;
      updated = `${existing}${prefix}API_KEY=${apiKey}${lineEnding}`;
    }

    fs.writeFileSync(
      envPath,
      updated,
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch (err) {
    console.warn(
      "⚠️  [Server] Generated API_KEY but could not persist it to .env:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function ensureRuntimeApiKey(host = "127.0.0.1"): string {
  const existing = getRuntimeApiKey();
  if (!isPlaceholderApiKey(existing)) return existing;
  if (isLoopbackHost(host)) return existing;
  if (isRunningUnderNodeTest()) return existing;

  const generated = `sk-qpx-${crypto.randomBytes(24).toString("base64url")}`;
  process.env.API_KEY = generated;
  persistApiKey(generated);
  console.warn(
    `🔐 [Server] Generated API_KEY and saved it to ${getEnvFilePath()}. Clients must send this Bearer token.`,
  );
  return generated;
}
