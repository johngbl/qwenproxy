/**
 * QwenProxy TUI - Proxy Data Provider & Live State Client
 */

import { config } from "../core/config.ts";
import { loadAccounts, type QwenAccount } from "../core/accounts.ts";
import {
  getAccountCooldownInfo,
  clearAllAccountCooldowns,
  clearAccountCooldown,
  isAccountHeadersReady,
} from "../core/account-manager.ts";
import { getAccountConcurrencySnapshot } from "../core/account-concurrency.ts";
import { getRssUsageSnapshot } from "../core/memory-usage.ts";
import type { ProxyStatusSnapshot } from "./types.ts";

export function maskAccountIdentifier(idOrEmail: string): string {
  if (!idOrEmail) return "unknown";
  if (idOrEmail.includes("@")) {
    const [user, domain] = idOrEmail.split("@");
    const visible = user.slice(0, 2);
    return `${visible}***@${domain}`;
  }

  if (idOrEmail.length > 8) {
    return `${idOrEmail.slice(0, 3)}***${idOrEmail.slice(-3)}`;
  }
  return idOrEmail;
}

export function formatUptime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const pad2 = (n: number) => n.toString().padStart(2, "0");
  if (hrs > 0) {
    return `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)}`;
  }
  return `${pad2(mins)}:${pad2(secs)}`;
}
let cachedAccounts: Array<{
  id: string;
  emailOrName: string;
  priority: number;
  cooldownUntil: number | null;
  onCooldown: boolean;
  remainingCooldownMs: number;
  headersReady: boolean;
}> = [];
let lastAccountsFetch = 0;
let isHealthCheckPending = false;
let lastOnlineState = false;
let lastOverallStatus = "offline";

export async function fetchProxyStatus(): Promise<ProxyStatusSnapshot> {
  const port = config.server?.port || 7936;
  const configuredHost = config.server?.host;
  const host = configuredHost && configuredHost !== "0.0.0.0" ? configuredHost : "127.0.0.1";
  const uptimeSeconds = Math.floor(process.uptime());

  // Fast non-blocking health probe
  if (!isHealthCheckPending) {
    isHealthCheckPending = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 350);
    fetch(`http://${host}:${port}/health`, { signal: controller.signal })
      .then(async (resp) => {
        clearTimeout(timeout);
        if (resp.ok) {
          lastOnlineState = true;
          const data = (await resp.json()) as any;
          lastOverallStatus = data.status || "healthy";
        } else {
          lastOnlineState = false;
        }
      })
      .catch(() => {
        clearTimeout(timeout);
        lastOnlineState = false;
      })
      .finally(() => {
        isHealthCheckPending = false;
      });
  }

  const now = Date.now();
  if (now - lastAccountsFetch > 3000 || cachedAccounts.length === 0) {
    lastAccountsFetch = now;
    let rawAccounts: QwenAccount[] = [];
    try {
      rawAccounts = loadAccounts();
    } catch {
      rawAccounts = [];
    }

    cachedAccounts = rawAccounts.map((acc) => {
      const cooldownInfo = getAccountCooldownInfo(acc.id);
      const onCooldown = Boolean(cooldownInfo?.onCooldown);
      const remainingCooldownMs = cooldownInfo?.remainingMs || 0;
      const headersReady = isAccountHeadersReady(acc.id);

      return {
        id: acc.id,
        emailOrName: maskAccountIdentifier(acc.email || acc.id),
        priority: 1,
        cooldownUntil: acc.cooldown_until || null,
        onCooldown,
        remainingCooldownMs,
        headersReady,
      };
    });
  }

  const accounts = cachedAccounts;
  const online = lastOnlineState;
  const overallStatus = lastOverallStatus;

  // Concurrency stats
  let activeStreams = 0;
  let waitingStreams = 0;
  try {
    const snapshot = getAccountConcurrencySnapshot();
    for (const item of snapshot) {
      activeStreams += item.active;
      waitingStreams += item.waiting;
    }
  } catch {}

  // RAM usage
  let rssMb = 0;
  let systemMemoryPct = 0;
  try {
    const rssSnap = getRssUsageSnapshot();
    rssMb = Math.round(rssSnap.rss / (1024 * 1024));
    systemMemoryPct = Math.round(rssSnap.usagePercent * 10) / 10;
  } catch {}

  return {
    online,
    port,
    host,
    overallStatus,
    uptimeSeconds,
    rssMb,
    systemMemoryPct,
    activeStreams,
    waitingStreams,
    accounts,
  };
}

export function resetAllCooldowns(): number {
  return clearAllAccountCooldowns();
}

export function resetAccountCooldownById(accountId: string): void {
  clearAccountCooldown(accountId);
}

export interface StreamChatOptions {
  model: string;
  reasoning_effort?: "low" | "medium" | "high";
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  onToken: (text: string) => void;
  onReasoning?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * Streams a chat completion response from the local proxy endpoint.
 */
export async function streamChatCompletions(
  options: StreamChatOptions,
): Promise<{ totalTimeMs: number; ttfbMs: number }> {
  const port = config.server?.port || 7936;
  const configuredHost = config.server?.host;
  const host = configuredHost && configuredHost !== "0.0.0.0" ? configuredHost : "127.0.0.1";
  const apiKey = config.apiKey || "sk-qwenproxy-local";

  const startTime = Date.now();
  let ttfbMs = 0;

  let resp: Response;
  try {
    resp = await fetch(`http://${host}:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        reasoning_effort: options.reasoning_effort,
        messages: options.messages,
        stream: true,
      }),
      signal: options.signal,
    });
  } catch (fetchErr: any) {
    if (fetchErr?.name === "AbortError" || options.signal?.aborted) {
      throw fetchErr;
    }
    throw new Error(
      `O servidor QwenProxy está iniciando ou indisponível (:7936). Verifique o status ou a aba [6] Logs.`,
    );
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${errText}`);
  }

  if (!resp.body) {
    throw new Error("No response body received from proxy");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (ttfbMs === 0) {
      ttfbMs = Date.now() - startTime;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.replace(/^data:\s*/, "").trim();
      if (dataStr === "[DONE]") break;

      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.reasoning_content && options.onReasoning) {
          options.onReasoning(delta.reasoning_content);
        }
        if (delta.content) {
          options.onToken(delta.content);
        }
      } catch {}
    }
  }

  return {
    totalTimeMs: Date.now() - startTime,
    ttfbMs: ttfbMs || Date.now() - startTime,
  };
}

/**
 * Fetches all live models dynamically from the running proxy /v1/models catalog.
 */
let cachedLiveModels: string[] | null = null;
let isFetchingLiveModels = false;

export async function fetchLiveModels(): Promise<string[]> {
  if (cachedLiveModels && cachedLiveModels.length > 0) {
    return cachedLiveModels;
  }

  const port = config.server?.port || 7936;
  const configuredHost = config.server?.host;
  const host = configuredHost && configuredHost !== "0.0.0.0" ? configuredHost : "127.0.0.1";
  const apiKey = config.apiKey || "sk-qwenproxy-local";

  if (!isFetchingLiveModels) {
    isFetchingLiveModels = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    fetch(`http://${host}:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
      .then(async (resp) => {
        clearTimeout(timeout);
        if (resp.ok) {
          const json = (await resp.json()) as any;
          if (Array.isArray(json?.data)) {
            const models = json.data
              .map((m: any) => m.id)
              .filter((id: any): id is string => typeof id === "string" && id.trim().length > 0)
              .filter(
                (id: string) =>
                  !id.endsWith("-fast") &&
                  !id.endsWith("-thinking") &&
                  !id.endsWith("-no-thinking"),
              );
            if (models.length > 0) {
              cachedLiveModels = Array.from(new Set(models));
            }
          }
        }
      })
      .catch(() => {
        clearTimeout(timeout);
      })
      .finally(() => {
        isFetchingLiveModels = false;
      });
  }

  return (
    cachedLiveModels || [
      "qwen3.8-max",
      "qwen3.7-plus",
      "qwen3.7-max",
      "z-image-turbo",
      "qwen-image-3.0-pro",
      "qwen-image-3.0",
      "wan2.7-image-pro",
      "wan2.7-image",
      "wan3.0-video",
      "wan2.7-t2v",
    ]
  );
}
