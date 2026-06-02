import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

type BenchmarkVariant = "standard" | "throughput_raw";

interface BenchmarkConfig {
  baseUrl: string;
  apiKey: string;
  models: string[];
  prompt: string;
  iterations: number;
  streamIterations: number;
  concurrencyLevels: number[];
  concurrencyRounds: number;
  timeoutMs: number;
  throughputRaw: boolean;
  compareJsonPath: string | null;
}

interface EndpointSample {
  ok: boolean;
  status: number;
  totalMs: number;
  bytes: number;
  xResponseTimeMs: number | null;
  error?: string;
  bodyPreview?: string;
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
  bytes: number;
  xResponseTimeMs: number | null;
  completionChars: number;
  usage: UsageSnapshot | null;
  tokensPerSecond: number | null;
  finishReason: string | null;
  error?: string;
}

interface StreamSample {
  ok: boolean;
  status: number;
  headersMs: number;
  firstChunkMs: number | null;
  firstDataEventMs: number | null;
  firstMeaningfulDeltaMs: number | null;
  totalMs: number;
  bytes: number;
  events: number;
  contentChars: number;
  reasoningChars: number;
  toolCallChunks: number;
  usage: UsageSnapshot | null;
  tokensPerSecond: number | null;
  finishReason: string | null;
  xResponseTimeMs: number | null;
  error?: string;
}

interface ConcurrencyRound {
  concurrency: number;
  wallMs: number;
  throughputRps: number;
  successCount: number;
  failureCount: number;
  requestTotalMs: number[];
  statuses: number[];
}

interface ConcurrencySummary {
  concurrency: number;
  rounds: ConcurrencyRound[];
  wallMs: NumericSummary;
  requestMs: NumericSummary;
  throughputRps: NumericSummary;
  successRate: number;
}

interface NumericSummary {
  min: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

interface ModelBenchmark {
  baseModel: string;
  requestedModel: string;
  effectiveModel: string;
  variant: BenchmarkVariant;
  nonStream: {
    samples: NonStreamSample[];
    totalMs: NumericSummary;
    tokensPerSecond: NumericSummary | null;
    successRate: number;
  };
  stream: {
    samples: StreamSample[];
    headersMs: NumericSummary;
    firstChunkMs: NumericSummary | null;
    firstDataEventMs: NumericSummary | null;
    firstMeaningfulDeltaMs: NumericSummary | null;
    totalMs: NumericSummary;
    tokensPerSecond: NumericSummary | null;
    successRate: number;
  };
  concurrency: ConcurrencySummary[];
}

interface BenchmarkReport {
  generatedAt: string;
  environment: {
    node: string;
    platform: string;
    arch: string;
  };
  config: BenchmarkConfig;
  healthBefore: EndpointSample;
  modelsEndpoint: EndpointSample[];
  availableModels: string[];
  modelBenchmarks: ModelBenchmark[];
  throughputBenchmarks: ModelBenchmark[];
  skippedThroughputModels: Array<{
    baseModel: string;
    effectiveModel: string;
    reason: string;
  }>;
  comparedAgainst?: {
    path: string;
    generatedAt?: string;
  };
  healthAfter: EndpointSample;
}

const DEFAULT_MODELS = ["qwen3.6-plus", "qwen3.7-plus", "qwen3.7-max"];
const DEFAULT_PROMPT =
  "Responda exatamente com a palavra OK. Não explique, não use markdown e não inclua raciocínio visível.";
const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_ITERATIONS = 3;
const DEFAULT_STREAM_ITERATIONS = 3;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_CONCURRENCY_LEVELS = [2];
const DEFAULT_CONCURRENCY_ROUNDS = 2;

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function parseBooleanArg(name: string, fallback: boolean): boolean {
  const raw = parseArg(name);
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  return fallback;
}

function parseIntArg(name: string, fallback: number): number {
  const raw = parseArg(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseListArg(name: string, fallback: string[]): string[] {
  const raw = parseArg(name);
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumberListArg(name: string, fallback: number[]): number[] {
  const raw = parseArg(name);
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  return parsed.length > 0 ? parsed : fallback;
}

function buildConfig(): BenchmarkConfig {
  const envBaseUrl = process.env.PROXY_BASE_URL?.trim();
  const envApiKey =
    process.env.API_KEY?.trim() || process.env.BENCH_API_KEY?.trim() || "";
  const envModels = process.env.BENCH_MODELS?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const envPrompt = process.env.BENCH_PROMPT?.trim();
  const envIterations = process.env.BENCH_ITERATIONS
    ? Number.parseInt(process.env.BENCH_ITERATIONS, 10)
    : undefined;
  const envStreamIterations = process.env.BENCH_STREAM_ITERATIONS
    ? Number.parseInt(process.env.BENCH_STREAM_ITERATIONS, 10)
    : undefined;
  const envConcurrency = process.env.BENCH_CONCURRENCY_LEVELS
    ? process.env.BENCH_CONCURRENCY_LEVELS.split(",")
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((item) => Number.isFinite(item) && item > 0)
    : undefined;
  const envConcurrencyRounds = process.env.BENCH_CONCURRENCY_ROUNDS
    ? Number.parseInt(process.env.BENCH_CONCURRENCY_ROUNDS, 10)
    : undefined;
  const envTimeout = process.env.BENCH_TIMEOUT_MS
    ? Number.parseInt(process.env.BENCH_TIMEOUT_MS, 10)
    : undefined;
  const envThroughputRaw = process.env.BENCH_THROUGHPUT_RAW
    ? parseBooleanLike(process.env.BENCH_THROUGHPUT_RAW, true)
    : true;
  const envCompareJsonPath = process.env.BENCH_COMPARE_JSON?.trim() || null;

  return {
    baseUrl: parseArg("base-url") || envBaseUrl || DEFAULT_BASE_URL,
    apiKey: parseArg("api-key") || envApiKey,
    models: parseListArg(
      "models",
      envModels && envModels.length > 0 ? envModels : DEFAULT_MODELS,
    ),
    prompt: parseArg("prompt") || envPrompt || DEFAULT_PROMPT,
    iterations: parseIntArg(
      "iterations",
      envIterations && envIterations > 0 ? envIterations : DEFAULT_ITERATIONS,
    ),
    streamIterations: parseIntArg(
      "stream-iterations",
      envStreamIterations && envStreamIterations > 0
        ? envStreamIterations
        : DEFAULT_STREAM_ITERATIONS,
    ),
    concurrencyLevels: parseNumberListArg(
      "concurrency",
      envConcurrency && envConcurrency.length > 0
        ? envConcurrency
        : DEFAULT_CONCURRENCY_LEVELS,
    ),
    concurrencyRounds: parseIntArg(
      "concurrency-rounds",
      envConcurrencyRounds && envConcurrencyRounds > 0
        ? envConcurrencyRounds
        : DEFAULT_CONCURRENCY_ROUNDS,
    ),
    timeoutMs: parseIntArg(
      "timeout-ms",
      envTimeout && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS,
    ),
    throughputRaw: parseBooleanArg("throughput-raw", envThroughputRaw),
    compareJsonPath: parseArg("compare-json") || envCompareJsonPath,
  };
}

function parseBooleanLike(value: string, fallback: boolean): boolean {
  const lower = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) return true;
  if (["0", "false", "no", "off"].includes(lower)) return false;
  return fallback;
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

function parseXResponseTime(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const parsed = Number.parseFloat(headerValue.replace("ms", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
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

function calculateSuccessRate<T extends { ok: boolean }>(samples: T[]): number {
  if (samples.length === 0) return 0;
  const successCount = samples.filter((sample) => sample.ok).length;
  return round((successCount / samples.length) * 100);
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
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function calculateTokensPerSecond(
  totalMs: number,
  usage: UsageSnapshot | null,
): number | null {
  if (!usage || usage.completionTokens <= 0 || totalMs <= 0) return null;
  return round((usage.completionTokens / totalMs) * 1000);
}

function calculateThroughputRps(successCount: number, wallMs: number): number {
  if (successCount <= 0 || wallMs <= 0) return 0;
  return round((successCount / wallMs) * 1000);
}

function stripNoThinkingSuffix(model: string): string {
  return model.endsWith("-no-thinking")
    ? model.slice(0, -"-no-thinking".length)
    : model;
}

function deriveThroughputModel(model: string): string {
  return model.endsWith("-no-thinking") ? model : `${model}-no-thinking`;
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "-";
  return value.toFixed(digits);
}

function formatPct(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "-"
    : `${formatNumber(value)}%`;
}

function formatDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
  betterWhenLower: boolean,
): string {
  if (
    current === null ||
    current === undefined ||
    previous === null ||
    previous === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  ) {
    return "-";
  }

  const delta = round(current - previous);
  const percentage = previous === 0 ? null : round((delta / previous) * 100);
  const improved = betterWhenLower ? delta < 0 : delta > 0;
  const emoji = delta === 0 ? "→" : improved ? "✅" : "⚠️";
  const sign = delta > 0 ? "+" : "";
  const pct =
    percentage === null ? "" : ` (${sign}${formatNumber(percentage)}%)`;
  return `${emoji} ${sign}${formatNumber(delta)}${pct}`;
}

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
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
      bytes: Buffer.byteLength(text),
      xResponseTimeMs: parseXResponseTime(
        response.headers.get("x-response-time"),
      ),
      bodyPreview: text.slice(0, 300),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      totalMs: round(performance.now() - startedAt),
      bytes: 0,
      xResponseTimeMs: null,
      error: message,
    };
  } finally {
    cleanup();
  }
}

async function fetchModelsList(
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
      // Keep the request sample even if the body is malformed.
    }

    return {
      sample: {
        ok: response.ok,
        status: response.status,
        totalMs: round(performance.now() - startedAt),
        bytes: Buffer.byteLength(text),
        xResponseTimeMs: parseXResponseTime(
          response.headers.get("x-response-time"),
        ),
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
        bytes: 0,
        xResponseTimeMs: null,
        error: message,
      },
      models: [],
    };
  } finally {
    cleanup();
  }
}

function buildChatBody(
  model: string,
  stream: boolean,
  prompt: string,
): Record<string, unknown> {
  return {
    model,
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  };
}

async function benchmarkNonStream(
  model: string,
  config: BenchmarkConfig,
): Promise<NonStreamSample> {
  const startedAt = performance.now();
  const { signal, cleanup } = withTimeout(config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: createHeaders(config.apiKey, true),
      body: JSON.stringify(buildChatBody(model, false, config.prompt)),
      signal,
    });

    const text = await response.text();
    const totalMs = round(performance.now() - startedAt);
    const xResponseTimeMs = parseXResponseTime(
      response.headers.get("x-response-time"),
    );
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
      // Keep raw transport timing even when body parse fails.
    }

    return {
      ok: response.ok,
      status: response.status,
      totalMs,
      bytes: Buffer.byteLength(text),
      xResponseTimeMs,
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
      bytes: 0,
      xResponseTimeMs: null,
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

async function benchmarkStream(
  model: string,
  config: BenchmarkConfig,
): Promise<StreamSample> {
  const startedAt = performance.now();
  const { signal, cleanup } = withTimeout(config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: createHeaders(config.apiKey, true),
      body: JSON.stringify(buildChatBody(model, true, config.prompt)),
      signal,
    });

    const headersMs = round(performance.now() - startedAt);
    const xResponseTimeMs = parseXResponseTime(
      response.headers.get("x-response-time"),
    );

    if (!response.body) {
      return {
        ok: false,
        status: response.status,
        headersMs,
        firstChunkMs: null,
        firstDataEventMs: null,
        firstMeaningfulDeltaMs: null,
        totalMs: headersMs,
        bytes: 0,
        events: 0,
        contentChars: 0,
        reasoningChars: 0,
        toolCallChunks: 0,
        usage: null,
        tokensPerSecond: null,
        finishReason: null,
        xResponseTimeMs,
        error: "Response body is empty",
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstChunkMs: number | null = null;
    let firstDataEventMs: number | null = null;
    let firstMeaningfulDeltaMs: number | null = null;
    let totalBytes = 0;
    let events = 0;
    let contentChars = 0;
    let reasoningChars = 0;
    let toolCallChunks = 0;
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

      if (firstDataEventMs === null) {
        firstDataEventMs = round(performance.now() - startedAt);
      }

      const payload = dataLines.join("\n");
      if (payload === "[DONE]") {
        events++;
        return;
      }

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

        events++;
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

        if (content) {
          contentChars += content.length;
        }
        if (reasoning) {
          reasoningChars += reasoning.length;
        }
        if (toolCalls.length > 0) {
          toolCallChunks += toolCalls.length;
        }
        if (
          (content || reasoning || toolCalls.length > 0) &&
          firstMeaningfulDeltaMs === null
        ) {
          firstMeaningfulDeltaMs = round(performance.now() - startedAt);
        }

        if (typeof firstChoice?.finish_reason === "string") {
          finishReason = firstChoice.finish_reason;
        }

        const candidateUsage = extractUsage(parsed.usage);
        if (candidateUsage) {
          usage = candidateUsage;
        }
      } catch {
        events++;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (firstChunkMs === null) {
        firstChunkMs = round(performance.now() - startedAt);
      }

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
      headersMs,
      firstChunkMs,
      firstDataEventMs,
      firstMeaningfulDeltaMs,
      totalMs,
      bytes: totalBytes,
      events,
      contentChars,
      reasoningChars,
      toolCallChunks,
      usage,
      tokensPerSecond: calculateTokensPerSecond(totalMs, usage),
      finishReason,
      xResponseTimeMs,
      error: response.ok
        ? undefined
        : "Streaming request returned non-OK status",
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const elapsedMs = round(performance.now() - startedAt);
    return {
      ok: false,
      status: 0,
      headersMs: elapsedMs,
      firstChunkMs: null,
      firstDataEventMs: null,
      firstMeaningfulDeltaMs: null,
      totalMs: elapsedMs,
      bytes: 0,
      events: 0,
      contentChars: 0,
      reasoningChars: 0,
      toolCallChunks: 0,
      usage: null,
      tokensPerSecond: null,
      finishReason: null,
      xResponseTimeMs: null,
      error: message,
    };
  } finally {
    cleanup();
  }
}

async function benchmarkConcurrency(
  model: string,
  concurrency: number,
  config: BenchmarkConfig,
): Promise<ConcurrencySummary> {
  const rounds: ConcurrencyRound[] = [];

  for (
    let roundIndex = 0;
    roundIndex < config.concurrencyRounds;
    roundIndex++
  ) {
    const startedAt = performance.now();
    const requests = Array.from({ length: concurrency }, () =>
      benchmarkNonStream(model, config),
    );
    const results = await Promise.all(requests);
    const wallMs = round(performance.now() - startedAt);
    const successCount = results.filter((result) => result.ok).length;

    rounds.push({
      concurrency,
      wallMs,
      throughputRps: calculateThroughputRps(successCount, wallMs),
      successCount,
      failureCount: results.filter((result) => !result.ok).length,
      requestTotalMs: results.map((result) => result.totalMs),
      statuses: results.map((result) => result.status),
    });
  }

  const allRequestDurations = rounds.flatMap((round) => round.requestTotalMs);
  const successCount = rounds.reduce(
    (acc, round) => acc + round.successCount,
    0,
  );
  const totalRequests = rounds.reduce(
    (acc, round) => acc + round.successCount + round.failureCount,
    0,
  );

  return {
    concurrency,
    rounds,
    wallMs: summarize(rounds.map((round) => round.wallMs)),
    requestMs: summarize(allRequestDurations),
    throughputRps: summarize(rounds.map((round) => round.throughputRps)),
    successRate:
      totalRequests > 0 ? round((successCount / totalRequests) * 100) : 0,
  };
}

async function benchmarkModel(
  model: string,
  config: BenchmarkConfig,
  variant: BenchmarkVariant,
  baseModel = stripNoThinkingSuffix(model),
): Promise<ModelBenchmark> {
  const effectiveModel = model;
  const label =
    variant === "throughput_raw"
      ? `${baseModel} -> ${effectiveModel} [throughput bruto]`
      : `${baseModel} [padrão]`;

  console.log(`\n=== Model: ${label} ===`);

  const nonStreamSamples: NonStreamSample[] = [];
  for (let i = 0; i < config.iterations; i++) {
    console.log(`- Non-stream ${i + 1}/${config.iterations}`);
    nonStreamSamples.push(await benchmarkNonStream(effectiveModel, config));
  }

  const streamSamples: StreamSample[] = [];
  for (let i = 0; i < config.streamIterations; i++) {
    console.log(`- Stream ${i + 1}/${config.streamIterations}`);
    streamSamples.push(await benchmarkStream(effectiveModel, config));
  }

  const concurrencyResults: ConcurrencySummary[] = [];
  for (const level of config.concurrencyLevels) {
    console.log(`- Concurrency x${level} (${config.concurrencyRounds} rounds)`);
    concurrencyResults.push(
      await benchmarkConcurrency(effectiveModel, level, config),
    );
  }

  return {
    baseModel,
    requestedModel: model,
    effectiveModel,
    variant,
    nonStream: {
      samples: nonStreamSamples,
      totalMs: summarize(nonStreamSamples.map((sample) => sample.totalMs)),
      tokensPerSecond: summarizeOptional(
        nonStreamSamples.map((sample) => sample.tokensPerSecond),
      ),
      successRate: calculateSuccessRate(nonStreamSamples),
    },
    stream: {
      samples: streamSamples,
      headersMs: summarize(streamSamples.map((sample) => sample.headersMs)),
      firstChunkMs: summarizeOptional(
        streamSamples.map((sample) => sample.firstChunkMs),
      ),
      firstDataEventMs: summarizeOptional(
        streamSamples.map((sample) => sample.firstDataEventMs),
      ),
      firstMeaningfulDeltaMs: summarizeOptional(
        streamSamples.map((sample) => sample.firstMeaningfulDeltaMs),
      ),
      totalMs: summarize(streamSamples.map((sample) => sample.totalMs)),
      tokensPerSecond: summarizeOptional(
        streamSamples.map((sample) => sample.tokensPerSecond),
      ),
      successRate: calculateSuccessRate(streamSamples),
    },
    concurrency: concurrencyResults,
  };
}

function lookupConcurrency(
  benchmark: ModelBenchmark,
  concurrency: number,
): ConcurrencySummary | undefined {
  return benchmark.concurrency.find((item) => item.concurrency === concurrency);
}

function printBenchmarkTable(
  title: string,
  benchmarks: ModelBenchmark[],
): void {
  if (benchmarks.length === 0) return;

  console.log(`\n=== ${title} ===`);
  console.table(
    benchmarks.map((benchmark) => ({
      base_model: benchmark.baseModel,
      model: benchmark.effectiveModel,
      variant: benchmark.variant,
      nonstream_avg_ms: benchmark.nonStream.totalMs.avg,
      nonstream_p95_ms: benchmark.nonStream.totalMs.p95,
      nonstream_tps_avg: benchmark.nonStream.tokensPerSecond?.avg ?? 0,
      stream_first_delta_avg_ms:
        benchmark.stream.firstMeaningfulDeltaMs?.avg ?? 0,
      stream_total_avg_ms: benchmark.stream.totalMs.avg,
      stream_p95_ms: benchmark.stream.totalMs.p95,
      stream_tps_avg: benchmark.stream.tokensPerSecond?.avg ?? 0,
      success_nonstream_pct: benchmark.nonStream.successRate,
      success_stream_pct: benchmark.stream.successRate,
    })),
  );
}

function printConcurrencyTable(
  title: string,
  benchmarks: ModelBenchmark[],
): void {
  if (benchmarks.length === 0) return;

  console.log(`\n=== ${title} ===`);
  console.table(
    benchmarks.flatMap((benchmark) =>
      benchmark.concurrency.map((item) => ({
        base_model: benchmark.baseModel,
        model: benchmark.effectiveModel,
        variant: benchmark.variant,
        concurrency: item.concurrency,
        wall_avg_ms: item.wallMs.avg,
        req_avg_ms: item.requestMs.avg,
        throughput_rps_avg: item.throughputRps.avg,
        success_pct: item.successRate,
      })),
    ),
  );
}

function printThroughputComparison(
  standardBenchmarks: ModelBenchmark[],
  throughputBenchmarks: ModelBenchmark[],
  concurrencyLevels: number[],
): void {
  if (throughputBenchmarks.length === 0) return;

  const rows = standardBenchmarks
    .map((standard) => {
      const raw = throughputBenchmarks.find(
        (item) => item.baseModel === standard.baseModel,
      );
      if (!raw) return null;

      const primaryConcurrency = concurrencyLevels[0] ?? 1;
      const standardConcurrency = lookupConcurrency(
        standard,
        primaryConcurrency,
      );
      const rawConcurrency = lookupConcurrency(raw, primaryConcurrency);

      return {
        base_model: standard.baseModel,
        standard_model: standard.effectiveModel,
        raw_model: raw.effectiveModel,
        nonstream_avg_ms_standard: standard.nonStream.totalMs.avg,
        nonstream_avg_ms_raw: raw.nonStream.totalMs.avg,
        nonstream_tps_standard: standard.nonStream.tokensPerSecond?.avg ?? 0,
        nonstream_tps_raw: raw.nonStream.tokensPerSecond?.avg ?? 0,
        stream_first_delta_standard:
          standard.stream.firstMeaningfulDeltaMs?.avg ?? 0,
        stream_first_delta_raw: raw.stream.firstMeaningfulDeltaMs?.avg ?? 0,
        stream_total_standard: standard.stream.totalMs.avg,
        stream_total_raw: raw.stream.totalMs.avg,
        stream_tps_standard: standard.stream.tokensPerSecond?.avg ?? 0,
        stream_tps_raw: raw.stream.tokensPerSecond?.avg ?? 0,
        concurrency_rps_standard: standardConcurrency?.throughputRps.avg ?? 0,
        concurrency_rps_raw: rawConcurrency?.throughputRps.avg ?? 0,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length === 0) return;

  console.log("\n=== Throughput bruto vs padrão ===");
  console.table(rows);
}

function escapeMdCell(value: unknown): string {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function markdownTable(
  headers: string[],
  rows: Array<Array<string | number>>,
): string {
  const head = `| ${headers.map(escapeMdCell).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((row) => `| ${row.map(escapeMdCell).join(" | ")} |`)
    .join("\n");
  return [head, sep, body].filter(Boolean).join("\n");
}

function summarizeRowsForMarkdown(
  benchmarks: ModelBenchmark[],
): Array<Array<string | number>> {
  return benchmarks.map((benchmark) => [
    benchmark.baseModel,
    benchmark.effectiveModel,
    benchmark.variant,
    formatNumber(benchmark.nonStream.totalMs.avg),
    formatNumber(benchmark.nonStream.totalMs.p95),
    formatNumber(benchmark.nonStream.tokensPerSecond?.avg ?? null),
    formatPct(benchmark.nonStream.successRate),
    formatNumber(benchmark.stream.firstMeaningfulDeltaMs?.avg ?? null),
    formatNumber(benchmark.stream.totalMs.avg),
    formatNumber(benchmark.stream.totalMs.p95),
    formatNumber(benchmark.stream.tokensPerSecond?.avg ?? null),
    formatPct(benchmark.stream.successRate),
  ]);
}

function concurrencyRowsForMarkdown(
  benchmarks: ModelBenchmark[],
): Array<Array<string | number>> {
  return benchmarks.flatMap((benchmark) =>
    benchmark.concurrency.map((item) => [
      benchmark.baseModel,
      benchmark.effectiveModel,
      benchmark.variant,
      item.concurrency,
      formatNumber(item.wallMs.avg),
      formatNumber(item.requestMs.avg),
      formatNumber(item.throughputRps.avg),
      formatPct(item.successRate),
    ]),
  );
}

function sameRunComparisonRows(
  standardBenchmarks: ModelBenchmark[],
  throughputBenchmarks: ModelBenchmark[],
  concurrencyLevels: number[],
): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [];

  for (const standard of standardBenchmarks) {
    const raw = throughputBenchmarks.find(
      (item) => item.baseModel === standard.baseModel,
    );
    if (!raw) continue;

    const primaryConcurrency = concurrencyLevels[0] ?? 1;
    const standardConcurrency = lookupConcurrency(standard, primaryConcurrency);
    const rawConcurrency = lookupConcurrency(raw, primaryConcurrency);

    rows.push([
      standard.baseModel,
      standard.effectiveModel,
      raw.effectiveModel,
      formatNumber(standard.nonStream.totalMs.avg),
      formatNumber(raw.nonStream.totalMs.avg),
      formatDelta(
        raw.nonStream.totalMs.avg,
        standard.nonStream.totalMs.avg,
        true,
      ),
      formatNumber(standard.nonStream.tokensPerSecond?.avg ?? null),
      formatNumber(raw.nonStream.tokensPerSecond?.avg ?? null),
      formatDelta(
        raw.nonStream.tokensPerSecond?.avg ?? null,
        standard.nonStream.tokensPerSecond?.avg ?? null,
        false,
      ),
      formatNumber(standard.stream.firstMeaningfulDeltaMs?.avg ?? null),
      formatNumber(raw.stream.firstMeaningfulDeltaMs?.avg ?? null),
      formatDelta(
        raw.stream.firstMeaningfulDeltaMs?.avg ?? null,
        standard.stream.firstMeaningfulDeltaMs?.avg ?? null,
        true,
      ),
      formatNumber(standard.stream.totalMs.avg),
      formatNumber(raw.stream.totalMs.avg),
      formatDelta(raw.stream.totalMs.avg, standard.stream.totalMs.avg, true),
      formatNumber(standard.stream.tokensPerSecond?.avg ?? null),
      formatNumber(raw.stream.tokensPerSecond?.avg ?? null),
      formatDelta(
        raw.stream.tokensPerSecond?.avg ?? null,
        standard.stream.tokensPerSecond?.avg ?? null,
        false,
      ),
      formatNumber(standardConcurrency?.throughputRps.avg ?? null),
      formatNumber(rawConcurrency?.throughputRps.avg ?? null),
      formatDelta(
        rawConcurrency?.throughputRps.avg ?? null,
        standardConcurrency?.throughputRps.avg ?? null,
        false,
      ),
    ]);
  }

  return rows;
}

function findMatchingBenchmark(
  collection: ModelBenchmark[],
  benchmark: ModelBenchmark,
): ModelBenchmark | undefined {
  return collection.find(
    (item) =>
      item.baseModel === benchmark.baseModel &&
      item.effectiveModel === benchmark.effectiveModel &&
      item.variant === benchmark.variant,
  );
}

function compareBenchmarksRows(
  current: ModelBenchmark[],
  previous: ModelBenchmark[],
  concurrencyLevels: number[],
): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [];

  for (const benchmark of current) {
    const previousBenchmark = findMatchingBenchmark(previous, benchmark);
    if (!previousBenchmark) continue;

    const primaryConcurrency = concurrencyLevels[0] ?? 1;
    const currentConcurrency = lookupConcurrency(benchmark, primaryConcurrency);
    const previousConcurrency = lookupConcurrency(
      previousBenchmark,
      primaryConcurrency,
    );

    rows.push([
      benchmark.baseModel,
      benchmark.effectiveModel,
      benchmark.variant,
      formatNumber(previousBenchmark.nonStream.totalMs.avg),
      formatNumber(benchmark.nonStream.totalMs.avg),
      formatDelta(
        benchmark.nonStream.totalMs.avg,
        previousBenchmark.nonStream.totalMs.avg,
        true,
      ),
      formatNumber(previousBenchmark.nonStream.tokensPerSecond?.avg ?? null),
      formatNumber(benchmark.nonStream.tokensPerSecond?.avg ?? null),
      formatDelta(
        benchmark.nonStream.tokensPerSecond?.avg ?? null,
        previousBenchmark.nonStream.tokensPerSecond?.avg ?? null,
        false,
      ),
      formatNumber(
        previousBenchmark.stream.firstMeaningfulDeltaMs?.avg ?? null,
      ),
      formatNumber(benchmark.stream.firstMeaningfulDeltaMs?.avg ?? null),
      formatDelta(
        benchmark.stream.firstMeaningfulDeltaMs?.avg ?? null,
        previousBenchmark.stream.firstMeaningfulDeltaMs?.avg ?? null,
        true,
      ),
      formatNumber(previousBenchmark.stream.totalMs.avg),
      formatNumber(benchmark.stream.totalMs.avg),
      formatDelta(
        benchmark.stream.totalMs.avg,
        previousBenchmark.stream.totalMs.avg,
        true,
      ),
      formatNumber(previousBenchmark.stream.tokensPerSecond?.avg ?? null),
      formatNumber(benchmark.stream.tokensPerSecond?.avg ?? null),
      formatDelta(
        benchmark.stream.tokensPerSecond?.avg ?? null,
        previousBenchmark.stream.tokensPerSecond?.avg ?? null,
        false,
      ),
      formatNumber(previousConcurrency?.throughputRps.avg ?? null),
      formatNumber(currentConcurrency?.throughputRps.avg ?? null),
      formatDelta(
        currentConcurrency?.throughputRps.avg ?? null,
        previousConcurrency?.throughputRps.avg ?? null,
        false,
      ),
    ]);
  }

  return rows;
}

function loadPreviousReport(
  compareJsonPath: string | null,
): BenchmarkReport | null {
  if (!compareJsonPath) return null;

  try {
    const resolved = path.resolve(compareJsonPath);
    const text = fs.readFileSync(resolved, "utf8");
    const parsed = JSON.parse(text) as BenchmarkReport;
    parsed.modelBenchmarks = asArray(parsed.modelBenchmarks);
    parsed.throughputBenchmarks = asArray(parsed.throughputBenchmarks);
    return parsed;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[benchmark] Não foi possível carregar compare-json: ${message}`,
    );
    return null;
  }
}

function buildMarkdown(
  report: BenchmarkReport,
  previousReport: BenchmarkReport | null,
): string {
  const lines: string[] = [];
  const primaryConcurrency = report.config.concurrencyLevels[0] ?? 1;

  lines.push("# QwenProxy Benchmark Report");
  lines.push("");
  lines.push(`- Gerado em: \`${report.generatedAt}\``);
  lines.push(`- Base URL: \`${report.config.baseUrl}\``);
  lines.push(`- Prompt: ${report.config.prompt}`);
  lines.push(
    `- Modelos padrão: ${report.config.models.map((model) => `\`${model}\``).join(", ")}`,
  );
  lines.push(
    `- Throughput bruto (-no-thinking): ${report.config.throughputRaw ? "habilitado" : "desabilitado"}`,
  );
  lines.push(`- Iterations: ${report.config.iterations}`);
  lines.push(`- Stream iterations: ${report.config.streamIterations}`);
  lines.push(
    `- Concurrency levels: ${report.config.concurrencyLevels.join(", ")}`,
  );
  lines.push(`- Concurrency rounds: ${report.config.concurrencyRounds}`);
  lines.push(`- Timeout: ${report.config.timeoutMs} ms`);
  if (report.comparedAgainst) {
    lines.push(`- Comparando com: \`${report.comparedAgainst.path}\``);
  }
  lines.push("");

  lines.push("## Endpoint baseline");
  lines.push("");
  lines.push(
    markdownTable(
      ["Sample", "Status", "Total ms", "Proxy ms", "Bytes", "OK"],
      report.modelsEndpoint.map((sample, index) => [
        index + 1,
        sample.status,
        formatNumber(sample.totalMs),
        formatNumber(sample.xResponseTimeMs),
        sample.bytes,
        sample.ok ? "yes" : "no",
      ]),
    ),
  );
  lines.push("");

  lines.push("## Resumo dos modelos padrão");
  lines.push("");
  lines.push(
    markdownTable(
      [
        "Base model",
        "Effective model",
        "Variant",
        "Non-stream avg ms",
        "Non-stream p95 ms",
        "Non-stream tok/s avg",
        "Non-stream success",
        "Stream first delta avg ms",
        "Stream total avg ms",
        "Stream p95 ms",
        "Stream tok/s avg",
        "Stream success",
      ],
      summarizeRowsForMarkdown(report.modelBenchmarks),
    ),
  );
  lines.push("");

  if (report.throughputBenchmarks.length > 0) {
    lines.push("## Throughput bruto (-no-thinking)");
    lines.push("");
    lines.push(
      markdownTable(
        [
          "Base model",
          "Effective model",
          "Variant",
          "Non-stream avg ms",
          "Non-stream p95 ms",
          "Non-stream tok/s avg",
          "Non-stream success",
          "Stream first delta avg ms",
          "Stream total avg ms",
          "Stream p95 ms",
          "Stream tok/s avg",
          "Stream success",
        ],
        summarizeRowsForMarkdown(report.throughputBenchmarks),
      ),
    );
    lines.push("");
  }

  if (report.skippedThroughputModels.length > 0) {
    lines.push("## Throughput bruto ignorado");
    lines.push("");
    lines.push(
      markdownTable(
        ["Base model", "Effective model", "Reason"],
        report.skippedThroughputModels.map((item) => [
          item.baseModel,
          item.effectiveModel,
          item.reason,
        ]),
      ),
    );
    lines.push("");
  }

  lines.push(`## Concorrência (nível primário x${primaryConcurrency})`);
  lines.push("");
  lines.push(
    markdownTable(
      [
        "Base model",
        "Effective model",
        "Variant",
        "Concurrency",
        "Wall avg ms",
        "Req avg ms",
        "Throughput RPS avg",
        "Success",
      ],
      concurrencyRowsForMarkdown([
        ...report.modelBenchmarks,
        ...report.throughputBenchmarks,
      ]),
    ),
  );
  lines.push("");

  if (report.throughputBenchmarks.length > 0) {
    const sameRunRows = sameRunComparisonRows(
      report.modelBenchmarks,
      report.throughputBenchmarks,
      report.config.concurrencyLevels,
    );
    if (sameRunRows.length > 0) {
      lines.push("## Comparação padrão vs throughput bruto");
      lines.push("");
      lines.push(
        markdownTable(
          [
            "Base model",
            "Standard model",
            "Raw model",
            "Non-stream avg std",
            "Non-stream avg raw",
            "Δ non-stream avg",
            "Tok/s std",
            "Tok/s raw",
            "Δ tok/s",
            "First delta std",
            "First delta raw",
            "Δ first delta",
            "Stream total std",
            "Stream total raw",
            "Δ stream total",
            "Stream tok/s std",
            "Stream tok/s raw",
            "Δ stream tok/s",
            `RPS std (x${primaryConcurrency})`,
            `RPS raw (x${primaryConcurrency})`,
            "Δ RPS",
          ],
          sameRunRows,
        ),
      );
      lines.push("");
    }
  }

  if (previousReport) {
    const previousStandardRows = compareBenchmarksRows(
      report.modelBenchmarks,
      asArray(previousReport.modelBenchmarks),
      report.config.concurrencyLevels,
    );
    if (previousStandardRows.length > 0) {
      lines.push("## Comparação com benchmark anterior (modelos padrão)");
      lines.push("");
      lines.push(
        markdownTable(
          [
            "Base model",
            "Effective model",
            "Variant",
            "Prev non-stream avg",
            "Curr non-stream avg",
            "Δ non-stream avg",
            "Prev tok/s",
            "Curr tok/s",
            "Δ tok/s",
            "Prev first delta",
            "Curr first delta",
            "Δ first delta",
            "Prev stream total",
            "Curr stream total",
            "Δ stream total",
            "Prev stream tok/s",
            "Curr stream tok/s",
            "Δ stream tok/s",
            `Prev RPS (x${primaryConcurrency})`,
            `Curr RPS (x${primaryConcurrency})`,
            "Δ RPS",
          ],
          previousStandardRows,
        ),
      );
      lines.push("");
    }

    const previousThroughputRows = compareBenchmarksRows(
      report.throughputBenchmarks,
      asArray(previousReport.throughputBenchmarks),
      report.config.concurrencyLevels,
    );
    if (previousThroughputRows.length > 0) {
      lines.push("## Comparação com benchmark anterior (throughput bruto)");
      lines.push("");
      lines.push(
        markdownTable(
          [
            "Base model",
            "Effective model",
            "Variant",
            "Prev non-stream avg",
            "Curr non-stream avg",
            "Δ non-stream avg",
            "Prev tok/s",
            "Curr tok/s",
            "Δ tok/s",
            "Prev first delta",
            "Curr first delta",
            "Δ first delta",
            "Prev stream total",
            "Curr stream total",
            "Δ stream total",
            "Prev stream tok/s",
            "Curr stream tok/s",
            "Δ stream tok/s",
            `Prev RPS (x${primaryConcurrency})`,
            `Curr RPS (x${primaryConcurrency})`,
            "Δ RPS",
          ],
          previousThroughputRows,
        ),
      );
      lines.push("");
    }
  }

  lines.push("## Health");
  lines.push("");
  lines.push(
    markdownTable(
      ["Moment", "Status", "Total ms", "Proxy ms", "Bytes", "OK", "Error"],
      [
        [
          "before",
          report.healthBefore.status,
          formatNumber(report.healthBefore.totalMs),
          formatNumber(report.healthBefore.xResponseTimeMs),
          report.healthBefore.bytes,
          report.healthBefore.ok ? "yes" : "no",
          report.healthBefore.error || "",
        ],
        [
          "after",
          report.healthAfter.status,
          formatNumber(report.healthAfter.totalMs),
          formatNumber(report.healthAfter.xResponseTimeMs),
          report.healthAfter.bytes,
          report.healthAfter.ok ? "yes" : "no",
          report.healthAfter.error || "",
        ],
      ],
    ),
  );
  lines.push("");

  return lines.join("\n");
}

function saveReportBundle(
  report: BenchmarkReport,
  markdown: string,
): { jsonPath: string; markdownPath: string } {
  const outputDir = path.resolve("data", "benchmarks");
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `proxy-baseline-${timestamp}`;
  const jsonPath = path.join(outputDir, `${baseName}.json`);
  const markdownPath = path.join(outputDir, `${baseName}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(markdownPath, markdown, "utf8");

  return { jsonPath, markdownPath };
}

async function run(): Promise<void> {
  const config = buildConfig();
  const previousReport = loadPreviousReport(config.compareJsonPath);

  console.log("=== QwenProxy Real Benchmark ===");
  console.log(
    JSON.stringify(
      {
        baseUrl: config.baseUrl,
        models: config.models,
        iterations: config.iterations,
        streamIterations: config.streamIterations,
        concurrencyLevels: config.concurrencyLevels,
        concurrencyRounds: config.concurrencyRounds,
        timeoutMs: config.timeoutMs,
        throughputRaw: config.throughputRaw,
        compareJsonPath: config.compareJsonPath,
        prompt: config.prompt,
        apiKeyConfigured: !!config.apiKey,
      },
      null,
      2,
    ),
  );

  const healthBefore = await timedTextRequest(
    `${config.baseUrl}/health`,
    createHeaders(config.apiKey),
    config.timeoutMs,
  );

  const modelsEndpoint: EndpointSample[] = [];
  let availableModels: string[] = [];
  for (let i = 0; i < 3; i++) {
    console.log(`\nWarm/models probe ${i + 1}/3`);
    const modelListResult = await fetchModelsList(config);
    modelsEndpoint.push(modelListResult.sample);
    if (availableModels.length === 0 && modelListResult.models.length > 0) {
      availableModels = modelListResult.models;
    }
  }

  const missingModels = config.models.filter(
    (model) => !availableModels.includes(model),
  );
  if (missingModels.length > 0) {
    console.warn(
      `\n[WARN] Modelos não encontrados no endpoint /v1/models: ${missingModels.join(", ")}`,
    );
  }

  const modelBenchmarks: ModelBenchmark[] = [];
  for (const model of config.models) {
    modelBenchmarks.push(await benchmarkModel(model, config, "standard"));
  }

  const throughputBenchmarks: ModelBenchmark[] = [];
  const skippedThroughputModels: BenchmarkReport["skippedThroughputModels"] =
    [];

  if (config.throughputRaw) {
    for (const model of config.models) {
      const baseModel = stripNoThinkingSuffix(model);
      const throughputModel = deriveThroughputModel(model);
      if (!availableModels.includes(throughputModel)) {
        skippedThroughputModels.push({
          baseModel,
          effectiveModel: throughputModel,
          reason: "Model not found in /v1/models",
        });
        continue;
      }
      throughputBenchmarks.push(
        await benchmarkModel(
          throughputModel,
          config,
          "throughput_raw",
          baseModel,
        ),
      );
    }
  }

  const healthAfter = await timedTextRequest(
    `${config.baseUrl}/health`,
    createHeaders(config.apiKey),
    config.timeoutMs,
  );

  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    config,
    healthBefore,
    modelsEndpoint,
    availableModels,
    modelBenchmarks,
    throughputBenchmarks,
    skippedThroughputModels,
    comparedAgainst:
      previousReport && config.compareJsonPath
        ? {
            path: path.resolve(config.compareJsonPath),
            generatedAt: previousReport.generatedAt,
          }
        : undefined,
    healthAfter,
  };

  console.log("\n=== Endpoint baseline ===");
  console.table(
    report.modelsEndpoint.map((sample, index) => ({
      sample: index + 1,
      status: sample.status,
      total_ms: sample.totalMs,
      proxy_ms: sample.xResponseTimeMs,
      bytes: sample.bytes,
      ok: sample.ok,
    })),
  );

  printBenchmarkTable("Model summary", report.modelBenchmarks);
  printConcurrencyTable("Concurrency summary", report.modelBenchmarks);
  printBenchmarkTable("Raw throughput summary", report.throughputBenchmarks);
  printConcurrencyTable(
    "Raw throughput concurrency summary",
    report.throughputBenchmarks,
  );
  printThroughputComparison(
    report.modelBenchmarks,
    report.throughputBenchmarks,
    report.config.concurrencyLevels,
  );

  const markdown = buildMarkdown(report, previousReport);
  const saved = saveReportBundle(report, markdown);

  console.log(`\nRelatório JSON salvo em: ${saved.jsonPath}`);
  console.log(`Relatório MD salvo em: ${saved.markdownPath}`);
}

run().catch((error: unknown) => {
  console.error("[benchmark] Failed:", error);
  process.exit(1);
});
