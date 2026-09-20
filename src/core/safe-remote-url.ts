import dns from "node:dns/promises";
import net from "node:net";

export class UnsafeRemoteUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeRemoteUrlError";
  }
}

export function isPrivateOrLocalIp(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(normalized) === 4) {
    const parts = normalized.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIP(normalized) === 6) {
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fe80:") || normalized.startsWith("ff")) return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("::ffff:")) {
      return isPrivateOrLocalIp(normalized.slice("::ffff:".length));
    }
    return false;
  }
  return true;
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.goog",
]);

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (net.isIP(host) && isPrivateOrLocalIp(host)) return true;
  return false;
}

export async function assertSafeRemoteMediaUrl(raw: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UnsafeRemoteUrlError("Remote media URL is not valid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeRemoteUrlError(`Blocked media URL protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeRemoteUrlError("Remote media URL must not include credentials");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(hostname)) {
    throw new UnsafeRemoteUrlError(`Blocked media URL host: ${hostname}`);
  }

  const lookupTarget = net.isIP(hostname) ? hostname : parsed.hostname;
  let records: Array<{ address: string }>;
  try {
    records = await dns.lookup(lookupTarget, { all: true });
  } catch {
    throw new UnsafeRemoteUrlError(`Could not resolve media URL host: ${hostname}`);
  }
  if (records.length === 0) {
    throw new UnsafeRemoteUrlError(`Could not resolve media URL host: ${hostname}`);
  }
  for (const record of records) {
    if (isPrivateOrLocalIp(record.address)) {
      throw new UnsafeRemoteUrlError(
        `Blocked media URL resolved to a private address (${record.address})`,
      );
    }
  }
  return parsed;
}

export async function readResponseWithByteCap(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Remote media too large: ${contentLength}`);
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Remote media too large: ${buffer.length}`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      try {
        await reader.cancel();
      } catch {}
      throw new Error(`Remote media too large: ${received}`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
