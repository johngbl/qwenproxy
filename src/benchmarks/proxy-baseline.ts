import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

interface BenchmarkConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  manageServer: boolean;
  prompt: string;
  warmup: number;
  samples: number;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

interface NumericSummary {
  min: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

interface EndpointSample {
  ok: boolean;
  status: number;
  totalMs: number;
  proxyMs: number | null;
  bytes: number;
  bodyPreview?: string;
  error?: string;
}

interface UsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface NonStreamSample {
  ok: boolean;
  status: number;
  totalMs: number;
  proxyMs: number | null;
  bytes: number;
  completionChars: number;
  usage: UsageSnapshot | null;
  tokensPerSecond: number | null;
  finishReason: string | null;
  error?: string;
}

interface StreamSample {
  ok: boolean;
  status: number;
  firstTokenMs: number | null;
  totalMs: number;
  proxyMs: number | null;
  bytes: number;
  events: number;
  completionChars: number;
  reasoningChars: number;
  usage: UsageSnapshot | null;
  tokensPerSecond: number | null;
  finishReason: string | null;
  error?: string;
}

interface SampleAggregate<TSample extends { ok: boolean; status: number }> {
  samples: TSample[];
  successRate: number;
  statusCounts: Record<string, number>;
}

interface NonStreamBenchmark extends SampleAggregate<NonStreamSample> {
  totalMs: NumericSummary;
  proxyMs: NumericSummary | null;
  tokensPerSecond: NumericSummary | null;
  proxySharePct: number | null;
}

interface StreamBenchmark extends SampleAggregate<StreamSample> {
  firstTokenMs: NumericSummary | null;
  totalMs: NumericSummary;
  proxyMs: NumericSummary | null;
  tokensPerSecond: NumericSummary | null;
  proxySharePct: number | null;
}

interface AccountBenchmarkContext {
  configuredAccounts: number;
  accountMode: "multi-account" | "global-session";
}

interface BenchmarkReport {
  generatedAt: string;
  environment: {
    node: string;
    platform: string;
    arch: string;
  };
  config: BenchmarkConfig;
  probes: {
    healthBefore: EndpointSample;
    healthAfter: EndpointSample;
    models: EndpointSample;
    availableModels: string[];
    modelListed: boolean;
    accounts: AccountBenchmarkContext;
  };
  warmup: {
    nonStreamRequests: number;
    streamRequests: number;
  };
  nonStream: NonStreamBenchmark;
  stream: StreamBenchmark;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_MODEL = "qwen3.6-plus";
const DEFAULT_PROMPT = "Responda apenas com OK.";
const DEFAULT_MANAGE_SERVER = true;
const DEFAULT_WARMUP = 2;
const DEFAULT_SAMPLES = 10;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_TOKENS = 32;
const DEFAULT_TEMPERATURE = 0;
const BENCH_RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
let benchRequestSequence = 0;

function nextBenchmarkConversationId(): string {
  benchRequestSequence++;
  return `bench-${BENCH_RUN_ID}-${benchRequestSequence}`;
}

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function parseIntArg(name: string, fallback: number): number {
  const raw = parseArg(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFloatArg(name: string, fallback: number): number {
  const raw = parseArg(name);
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBooleanLike(value: string, fallback: boolean): boolean {
  const lower = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) return true;
  if (["0", "false", "no", "off"].includes(lower)) return false;
  return fallback;
}

function parseBooleanArg(name: string, fallback: boolean): boolean {
  const raw = parseArg(name);
  return raw ? parseBooleanLike(raw, fallback) : fallback;
}

function buildConfig(): BenchmarkConfig {
  const envBaseUrl = process.env.PROXY_BASE_URL?.trim();
  const envApiKey =
    process.env.API_KEY?.trim() || process.env.BENCH_API_KEY?.trim() || "";
  const envModel = process.env.BENCH_MODEL?.trim();
  const envPrompt = process.env.BENCH_PROMPT?.trim();
  const envManageServer = process.env.BENCH_MANAGE_SERVER
    ? parseBooleanLike(process.env.BENCH_MANAGE_SERVER, DEFAULT_MANAGE_SERVER)
    : DEFAULT_MANAGE_SERVER;
  const envWarmup = process.env.BENCH_WARMUP
    ? Number.parseInt(process.env.BENCH_WARMUP, 10)
    : undefined;
  const envSamples = process.env.BENCH_SAMPLES
    ? Number.parseInt(process.env.BENCH_SAMPLES, 10)
    : undefined;
  const envTimeoutMs = process.env.BENCH_TIMEOUT_MS
    ? Number.parseInt(process.env.BENCH_TIMEOUT_MS, 10)
    : undefined;
  const envMaxTokens = process.env.BENCH_MAX_TOKENS
    ? Number.parseInt(process.env.BENCH_MAX_TOKENS, 10)
    : undefined;
  const envTemperature = process.env.BENCH_TEMPERATURE
    ? Number.parseFloat(process.env.BENCH_TEMPERATURE)
    : undefined;

  return {
    baseUrl: parseArg("base-url") || envBaseUrl || DEFAULT_BASE_URL,
    apiKey: parseArg("api-key") || envApiKey,
    model: parseArg("model") || envModel || DEFAULT_MODEL,
    manageServer: parseBooleanArg("manage-server", envManageServer),
    prompt: parseArg("prompt") || envPrompt || DEFAULT_PROMPT,
    warmup: parseIntArg(
      "warmup",
      envWarmup && envWarmup > 0 ? envWarmup : DEFAULT_WARMUP,
    ),
    samples: parseIntArg(
      "samples",
      envSamples && envSamples > 0 ? envSamples : DEFAULT_SAMPLES,
    ),
    timeoutMs: parseIntArg(
      "timeout-ms",
      envTimeoutMs && envTimeoutMs > 0 ? envTimeoutMs : DEFAULT_TIMEOUT_MS,
    ),
    maxTokens: parseIntArg(
      "max-tokens",
      envMaxTokens && envMaxTokens > 0 ? envMaxTokens : DEFAULT_MAX_TOKENS,
    ),
    temperature: parseFloatArg(
      "temperature",
      Number.isFinite(envTemperature)
        ? (envTemperature as number)
        : DEFAULT_TEMPERATURE,
    ),
  };
}

function createHeaders(
  apiKey: string,
  includeJson = false,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeJson) {
    headers["Content-Type"] = "application/json";
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function withTimeout(timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "-";
  return `${value.toFixed(2)} ms`;
}

function formatRate(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "-";
  return `${value.toFixed(2)} ${unit}`;
}

function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "-";
  return `${value.toFixed(2)}%`;
}

function summarize(values: number[]): NumericSummary {
  if (values.length === 0) {
    return { min: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const avg = sorted.reduce((acc, value) => acc + value, 0) / sorted.length;
  const percentile = (p: number): number => {
    if (sorted.length === 1) return sorted[0];
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * p) - 1),
    );
    return sorted[index];
  };

  return {
    min: round(sorted[0]),
    avg: round(avg),
    p50: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    max: round(sorted[sorted.length - 1]),
  };
}

function summarizeOptional(
  values: Array<number | null>,
): NumericSummary | null {
  const filtered = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  return filtered.length > 0 ? summarize(filtered) : null;
}

function parseXResponseTime(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const parsed = Number.parseFloat(headerValue.replace("ms", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function calculateSuccessRate(samples: Array<{ ok: boolean }>): number {
  if (samples.length === 0) return 0;
  const successCount = samples.filter((sample) => sample.ok).length;
  return round((successCount / samples.length) * 100);
}

function countStatuses(
  samples: Array<{ status: number }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sample of samples) {
    const key = String(sample.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function extractUsage(candidate: unknown): UsageSnapshot | null {
  if (!candidate || typeof candidate !== "object") return null;
  const usage = candidate as Record<string, unknown>;
  const promptTokens =
    typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
  const completionTokens =
    typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : null;
  const totalTokens =
    typeof usage.total_tokens === "number" ? usage.total_tokens : null;
  if (
    promptTokens === null ||
    completionTokens === null ||
    totalTokens === null
  ) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function calculateTokensPerSecond(
  totalMs: number,
  usage: UsageSnapshot | null,
): number | null {
  if (!usage || usage.completionTokens <= 0 || totalMs <= 0) return null;
  return round((usage.completionTokens / totalMs) * 1000);
}

function calculateProxySharePct(
  samples: Array<{ ok: boolean; totalMs: number; proxyMs: number | null }>,
): number | null {
  const valid = samples.filter(
    (sample): sample is { ok: true; totalMs: number; proxyMs: number } =>
      sample.ok && typeof sample.proxyMs === "number" && sample.totalMs > 0,
  );
  if (valid.length === 0) return null;
  const total = valid.reduce((acc, sample) => acc + sample.totalMs, 0);
  const proxy = valid.reduce((acc, sample) => acc + sample.proxyMs, 0);
  return total > 0 ? round((proxy / total) * 100) : null;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "0.0.0.0"
  );
}

function resolveServerTarget(config: BenchmarkConfig): {
  baseUrl: string;
  hostname: string;
  port: string;
  canManageLocally: boolean;
} {
  const parsed = new URL(normalizeBaseUrl(config.baseUrl));
  const hostname = parsed.hostname;
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return {
    baseUrl: `${parsed.protocol}//${hostname}:${port}`,
    hostname,
    port,
    canManageLocally: isLocalHostname(hostname),
  };
}

function buildChatBody(
  config: BenchmarkConfig,
  stream: boolean,
): Record<string, unknown> {
  return {
    model: config.model,
    stream,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    conversation_id: nextBenchmarkConversationId(),
    stream_options: stream ? { include_usage: true } : undefined,
    messages: [
      {
        role: "user",
        content: config.prompt,
      },
    ],
  };
}

async function timedTextRequest(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<EndpointSample> {
  const startedAt = performance.now();
  const { signal, cleanup } = withTimeout(timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      totalMs: round(performance.now() - startedAt),
      proxyMs: parseXResponseTime(response.headers.get("x-response-time")),
      bytes: Buffer.byteLength(text),
      bodyPreview: text.slice(0, 300),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      totalMs: round(performance.now() - startedAt),
      proxyMs: null,
      bytes: 0,
      error: message,
    };
  } finally {
    cleanup();
  }
}

async function fetchModelsProbe(
  config: BenchmarkConfig,
): Promise<{ sample: EndpointSample; models: string[] }> {
  const startedAt = performance.now();
  const { signal, cleanup } = withTimeout(config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/v1/models`, {
      method: "GET",
      headers: createHeaders(config.apiKey),
      signal,
    });
    const text = await response.text();
    let models: string[] = [];

    try {
      const parsed = JSON.parse(text) as { data?: Array<{ id?: string }> };
      models = Array.isArray(parsed.data)
        ? parsed.data
            .map((item) => item.id)
            .filter(
              (id): id is string => typeof id === "string" && id.length > 0,
            )
        : [];
    } catch {
      // Keep transport data even when the payload cannot be parsed.
    }

    return {
      sample: {
        ok: response.ok,
        status: response.status,
        totalMs: round(performance.now() - startedAt),
        proxyMs: parseXResponseTime(response.headers.get("x-response-time")),
        bytes: Buffer.byteLength(text),
        bodyPreview: text.slice(0, 300),
      },
      models,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      sample: {
        ok: false,
        status: 0,
        totalMs: round(performance.now() - startedAt),
        proxyMs: null,
        bytes: 0,
        error: message,
      },
      models: [],
    };
  } finally {
    cleanup();
  }
}

async function benchmarkNonStream(
  config: BenchmarkConfig,
): Promise<NonStreamSample> {
  const startedAt = performance.now();
  const { signal, cleanup } = withTimeout(config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: createHeaders(config.apiKey, true),
      body: JSON.stringify(buildChatBody(config, false)),
      signal,
    });

    const text = await response.text();
    const totalMs = round(performance.now() - startedAt);
    const proxyMs = parseXResponseTime(response.headers.get("x-response-time"));
    let completionChars = 0;
    let usage: UsageSnapshot | null = null;
    let finishReason: string | null = null;

    try {
      const parsed = JSON.parse(text) as {
        choices?: Array<{
          message?: { content?: string | null };
          finish_reason?: string | null;
        }>;
        usage?: unknown;
      };
      const firstChoice = Array.isArray(parsed.choices)
        ? parsed.choices[0]
        : undefined;
      completionChars =
        typeof firstChoice?.message?.content === "string"
          ? firstChoice.message.content.length
          : 0;
      finishReason =
        typeof firstChoice?.finish_reason === "string"
          ? firstChoice.finish_reason
          : null;
      usage = extractUsage(parsed.usage);
    } catch {
      // Transport timing is still valid even if the body parsing fails.
    }

    return {
      ok: response.ok,
      status: response.status,
      totalMs,
      proxyMs,
      bytes: Buffer.byteLength(text),
      completionChars,
      usage,
      tokensPerSecond: calculateTokensPerSecond(totalMs, usage),
      finishReason,
      error: response.ok ? undefined : text.slice(0, 300),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      totalMs: round(performance.now() - startedAt),
      proxyMs: null,
      bytes: 0,
      completionChars: 0,
      usage: null,
      tokensPerSecond: null,
      finishReason: null,
      error: message,
    };
  } finally {
    cleanup();
  }
}

async function benchmarkStream(config: BenchmarkConfig): Promise<StreamSample> {
  const startedAt = performance.now();
  const { signal, cleanup } = withTimeout(config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: createHeaders(config.apiKey, true),
      body: JSON.stringify(buildChatBody(config, true)),
      signal,
    });

    const proxyMs = parseXResponseTime(response.headers.get("x-response-time"));
    if (!response.body) {
      const elapsedMs = round(performance.now() - startedAt);
      return {
        ok: false,
        status: response.status,
        firstTokenMs: null,
        totalMs: elapsedMs,
        proxyMs,
        bytes: 0,
        events: 0,
        completionChars: 0,
        reasoningChars: 0,
        usage: null,
        tokensPerSecond: null,
        finishReason: null,
        error: "Response body is empty",
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;
    let events = 0;
    let completionChars = 0;
    let reasoningChars = 0;
    let firstTokenMs: number | null = null;
    let usage: UsageSnapshot | null = null;
    let finishReason: string | null = null;

    const processEvent = (eventBlock: string): void => {
      const lines = eventBlock
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean);

      const dataLines = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));
      if (dataLines.length === 0) return;

      const payload = dataLines.join("\n");
      events++;
      if (payload === "[DONE]") return;

      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: unknown[];
            };
            finish_reason?: string | null;
          }>;
          usage?: unknown;
        };

        const firstChoice = Array.isArray(parsed.choices)
          ? parsed.choices[0]
          : undefined;
        const delta = firstChoice?.delta;
        const content = typeof delta?.content === "string" ? delta.content : "";
        const reasoning =
          typeof delta?.reasoning_content === "string"
            ? delta.reasoning_content
            : "";
        const toolCalls = Array.isArray(delta?.tool_calls)
          ? delta.tool_calls
          : [];

        if (
          (content || reasoning || toolCalls.length > 0) &&
          firstTokenMs === null
        ) {
          firstTokenMs = round(performance.now() - startedAt);
        }
        if (content) completionChars += content.length;
        if (reasoning) reasoningChars += reasoning.length;
        if (typeof firstChoice?.finish_reason === "string") {
          finishReason = firstChoice.finish_reason;
        }
        const candidateUsage = extractUsage(parsed.usage);
        if (candidateUsage) {
          usage = candidateUsage;
        }
      } catch {
        // Ignore malformed SSE chunks for timing purposes.
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });

      let boundaryIndex = buffer.indexOf("\n\n");
      while (boundaryIndex !== -1) {
        const eventBlock = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        processEvent(eventBlock);
        boundaryIndex = buffer.indexOf("\n\n");
      }
    }

    if (buffer.trim()) {
      processEvent(buffer);
    }

    const totalMs = round(performance.now() - startedAt);
    return {
      ok: response.ok,
      status: response.status,
      firstTokenMs,
      totalMs,
      proxyMs,
      bytes: totalBytes,
      events,
      completionChars,
      reasoningChars,
      usage,
      tokensPerSecond: calculateTokensPerSecond(totalMs, usage),
      finishReason,
      error: response.ok
        ? undefined
        : "Streaming request returned non-OK status",
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      firstTokenMs: null,
      totalMs: round(performance.now() - startedAt),
      proxyMs: null,
      bytes: 0,
      events: 0,
      completionChars: 0,
      reasoningChars: 0,
      usage: null,
      tokensPerSecond: null,
      finishReason: null,
      error: message,
    };
  } finally {
    cleanup();
  }
}

function buildNonStreamBenchmark(
  samples: NonStreamSample[],
): NonStreamBenchmark {
  return {
    samples,
    successRate: calculateSuccessRate(samples),
    statusCounts: countStatuses(samples),
    totalMs: summarize(samples.map((sample) => sample.totalMs)),
    proxyMs: summarizeOptional(samples.map((sample) => sample.proxyMs)),
    tokensPerSecond: summarizeOptional(
      samples.map((sample) => sample.tokensPerSecond),
    ),
    proxySharePct: calculateProxySharePct(samples),
  };
}

function buildStreamBenchmark(samples: StreamSample[]): StreamBenchmark {
  return {
    samples,
    successRate: calculateSuccessRate(samples),
    statusCounts: countStatuses(samples),
    firstTokenMs: summarizeOptional(
      samples.map((sample) => sample.firstTokenMs),
    ),
    totalMs: summarize(samples.map((sample) => sample.totalMs)),
    proxyMs: summarizeOptional(samples.map((sample) => sample.proxyMs)),
    tokensPerSecond: summarizeOptional(
      samples.map((sample) => sample.tokensPerSecond),
    ),
    proxySharePct: calculateProxySharePct(samples),
  };
}

async function runWarmup(config: BenchmarkConfig): Promise<void> {
  if (config.warmup <= 0) return;
  console.log(
    `\nAquecendo o proxy (${config.warmup} non-stream + 1 stream)...`,
  );
  for (let i = 0; i < config.warmup; i++) {
    await benchmarkNonStream(config);
  }
  await benchmarkStream(config);
}

async function runSequentialSamples<T>(
  count: number,
  label: string,
  fn: () => Promise<T>,
): Promise<T[]> {
  const samples: T[] = [];
  for (let i = 0; i < count; i++) {
    console.log(`- ${label} ${i + 1}/${count}`);
    samples.push(await fn());
  }
  return samples;
}

function buildAccountBenchmarkContext(
  configuredAccounts: number,
): AccountBenchmarkContext {
  return {
    configuredAccounts,
    accountMode: configuredAccounts > 0 ? "multi-account" : "global-session",
  };
}

function printSummary(report: BenchmarkReport): void {
  const nonStreamProxy = report.nonStream.proxySharePct;
  const streamProxy = report.stream.proxySharePct;
  const upstreamDominant =
    (typeof nonStreamProxy === "number" && nonStreamProxy <= 15) ||
    (typeof streamProxy === "number" && streamProxy <= 15);

  console.log("\n=== Benchmark real do proxy ===");
  console.log(`Base URL: ${report.config.baseUrl}`);
  console.log(`Modelo: ${report.config.model}`);
  console.log(`Prompt fixo: ${report.config.prompt}`);
  console.log(
    `Warmup: ${report.config.warmup} | Samples: ${report.config.samples}`,
  );

  console.log("\nContexto de contas/sessões:");
  console.log(
    `- modo: ${report.probes.accounts.accountMode} | contas configuradas: ${report.probes.accounts.configuredAccounts}`,
  );

  console.log("\nSaúde do proxy:");
  console.log(
    `- /health antes: ${report.probes.healthBefore.ok ? "OK" : "FALHOU"} (${formatMs(report.probes.healthBefore.totalMs)})`,
  );
  console.log(
    `- /v1/models: ${report.probes.models.ok ? "OK" : "FALHOU"} (${formatMs(report.probes.models.totalMs)})`,
  );
  console.log(
    `- Modelo listado em /v1/models: ${report.probes.modelListed ? "sim" : "não"}`,
  );
  console.log(
    `- /health depois: ${report.probes.healthAfter.ok ? "OK" : "FALHOU"} (${formatMs(report.probes.healthAfter.totalMs)})`,
  );

  console.log("\nLatência non-stream:");
  console.log(
    `- p50 total: ${formatMs(report.nonStream.totalMs.p50)} | p95 total: ${formatMs(report.nonStream.totalMs.p95)} | sucesso: ${formatPct(report.nonStream.successRate)}`,
  );
  console.log(
    `- proxy p50: ${formatMs(report.nonStream.proxyMs?.p50 ?? null)} | proxy/total: ${formatPct(report.nonStream.proxySharePct)} | tokens/s médio: ${formatRate(report.nonStream.tokensPerSecond?.avg ?? null, "tok/s")}`,
  );

  console.log("\nLatência stream:");
  console.log(
    `- p50 primeiro token: ${formatMs(report.stream.firstTokenMs?.p50 ?? null)} | p95 primeiro token: ${formatMs(report.stream.firstTokenMs?.p95 ?? null)} | sucesso: ${formatPct(report.stream.successRate)}`,
  );
  console.log(
    `- p50 total: ${formatMs(report.stream.totalMs.p50)} | p95 total: ${formatMs(report.stream.totalMs.p95)} | proxy/total: ${formatPct(report.stream.proxySharePct)} | tokens/s médio: ${formatRate(report.stream.tokensPerSecond?.avg ?? null, "tok/s")}`,
  );

  console.log("\nLeitura rápida:");
  if (upstreamDominant) {
    console.log(
      "- O maior custo parece estar no upstream/Qwen, não no proxy local.",
    );
  } else {
    console.log(
      "- O proxy está representando uma fração relevante do tempo total; vale inspecionar o caminho interno.",
    );
  }
}

function saveJsonReport(report: BenchmarkReport): string {
  const outputDir = path.resolve("data", "benchmarks");
  fs.mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(outputDir, `proxy-real-${timestamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), "utf8");
  return filePath;
}

async function run(): Promise<void> {
  const config = buildConfig();
  const serverTarget = resolveServerTarget(config);
  const effectiveBaseUrl = serverTarget.baseUrl;
  let startedManagedServer = false;

  // Keep benchmark samples isolated from background summarization noise.
  // This must be set before importing modules that read core/config.ts.
  process.env.CONTEXT_SUMMARIZATION_ENABLED = "false";

  const { loadAccounts } = await import("../core/accounts.ts");
  const configuredAccounts = loadAccounts().length;
  const runtimeConfig: BenchmarkConfig = {
    ...config,
    baseUrl: effectiveBaseUrl,
  };
  const accountContext = buildAccountBenchmarkContext(configuredAccounts);

  console.log("=== QwenBridge Benchmark ===");
  console.log(
    JSON.stringify(
      {
        baseUrl: effectiveBaseUrl,
        model: config.model,
        manageServer: config.manageServer,
        configuredAccounts: accountContext.configuredAccounts,
        warmup: config.warmup,
        samples: config.samples,
        timeoutMs: config.timeoutMs,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        contextSummarization: "disabled",
        isolatedConversations: true,
        apiKeyConfigured: !!config.apiKey,
      },
      null,
      2,
    ),
  );

  if (config.manageServer) {
    if (!serverTarget.canManageLocally) {
      console.warn(
        `[benchmark] base-url ${effectiveBaseUrl} não é local; o benchmark não vai tentar subir o proxy automaticamente.`,
      );
    } else {
      process.env.HOST =
        serverTarget.hostname === "localhost"
          ? "127.0.0.1"
          : serverTarget.hostname;
      process.env.PORT = serverTarget.port;
      if (config.apiKey) {
        process.env.API_KEY = config.apiKey;
      }
      const { startServer } = await import("../api/server.js");
      console.log(`\nSubindo proxy local em ${effectiveBaseUrl}...`);
      await startServer({ installSignalHandlers: false });
      startedManagedServer = true;
    }
  }

  const healthBefore = await timedTextRequest(
    `${runtimeConfig.baseUrl}/health`,
    createHeaders(runtimeConfig.apiKey),
    runtimeConfig.timeoutMs,
  );

  const modelsProbe = await fetchModelsProbe(runtimeConfig);
  const modelListed = modelsProbe.models.includes(runtimeConfig.model);
  if (!modelListed) {
    console.warn(
      `\n[benchmark] Aviso: o modelo ${runtimeConfig.model} não apareceu em /v1/models.`,
    );
  }

  await runWarmup(runtimeConfig);

  console.log("\nExecutando amostras sequenciais...");
  const nonStreamSamples = await runSequentialSamples(
    runtimeConfig.samples,
    "Non-stream",
    () => benchmarkNonStream(runtimeConfig),
  );
  const streamSamples = await runSequentialSamples(
    runtimeConfig.samples,
    "Stream",
    () => benchmarkStream(runtimeConfig),
  );

  const healthAfter = await timedTextRequest(
    `${runtimeConfig.baseUrl}/health`,
    createHeaders(runtimeConfig.apiKey),
    runtimeConfig.timeoutMs,
  );

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    config: runtimeConfig,
    probes: {
      healthBefore,
      healthAfter,
      models: modelsProbe.sample,
      availableModels: modelsProbe.models,
      modelListed,
      accounts: accountContext,
    },
    warmup: {
      nonStreamRequests: runtimeConfig.warmup,
      streamRequests: 1,
    },
    nonStream: buildNonStreamBenchmark(nonStreamSamples),
    stream: buildStreamBenchmark(streamSamples),
  };

  printSummary(report);

  const jsonPath = saveJsonReport(report);
  console.log(`\nJSON salvo em: ${jsonPath}`);

  if (startedManagedServer) {
    console.log("Encerrando proxy gerenciado pelo benchmark...");
    const { stopServer } = await import("../api/server.js");
    await stopServer();
  }
}

run().catch(async (error: unknown) => {
  try {
    const { stopServer } = await import("../api/server.js");
    await stopServer();
  } catch {
    // Best effort cleanup.
  }
  console.error("[benchmark] Failed:", error);
  process.exit(1);
});
