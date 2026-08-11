import { EventEmitter } from "events";
import { config } from "./config.js";
import { getHeapUsageSnapshot, getRssUsageSnapshot } from "./memory-usage.js";

interface MetricPoint {
  value: number;
  timestamp: number;
  labels?: Record<string, string>;
}

type MetricType = "counter" | "gauge" | "histogram" | "summary";

interface MetricDefinition {
  name: string;
  type: MetricType;
  help: string;
  values: Map<string, MetricPoint>;
  histogramBuckets?: number[];
}

export class Metrics extends EventEmitter {
  private metrics: Map<string, MetricDefinition> = new Map();
  private collectionInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.registerDefaults();
  }

  private registerDefaults(): void {
    const defaults: Array<[string, MetricType, string]> = [
      // Core request metrics
      ["requests.total", "counter", "Total requests processed"],
      ["requests.errors", "counter", "Total request errors"],
      ["latency.request", "histogram", "Request latency (ms)"],

      // Stream metrics
      ["streams.active", "gauge", "Active SSE streams"],
      ["streams.errors", "counter", "Stream errors"],

      // CAPTCHA / anti-bot metrics
      ["captcha.challenges.detected", "counter", "Detected CAPTCHA challenges"],
      ["captcha.solves.succeeded", "counter", "Successful CAPTCHA solves"],
      ["captcha.solves.failed", "counter", "Failed CAPTCHA solves"],
      ["captcha.solve.duration", "histogram", "CAPTCHA solve duration (ms)"],

      // Memory metrics
      ["memory.heap.used", "gauge", "Heap memory used (bytes)"],
      ["memory.heap.total", "gauge", "Heap memory total (bytes)"],
      [
        "memory.heap.limit",
        "gauge",
        "V8 heap_size_limit used for RAM pressure (bytes)",
      ],
      [
        "memory.heap.usage_percent",
        "gauge",
        "Heap used percent vs heap_size_limit",
      ],
      ["memory.rss", "gauge", "Resident set size (bytes)"],
      [
        "memory.rss.usage_percent",
        "gauge",
        "RSS as percent of total system memory (RAM pressure signal)",
      ],

      // Cache metrics
      ["cache.set", "counter", "Cache set operations"],
      ["cache.hit", "counter", "Cache hits"],
      ["cache.miss", "counter", "Cache misses"],
      ["cache.deleted", "counter", "Cache deletions"],
      ["cache.flushed", "counter", "Cache flushes"],
      ["cache.value.size", "histogram", "Cache value size (bytes)"],
      ["cache.get.latency", "histogram", "Cache get latency (ms)"],
      ["cache.hit.ratio", "gauge", "Cache hit ratio (hits / (hits + misses))"],
      [
        "cache.compression.ratio",
        "histogram",
        "Compression ratio (original / compressed)",
      ],
      [
        "cache.compression.bytes.saved",
        "counter",
        "Total bytes saved by compression",
      ],
      [
        "cache.topic.invalidation",
        "counter",
        "Cache entries invalidated by topic change",
      ],
      [
        "cache.memory.usage.bytes",
        "gauge",
        "Estimated cache memory usage (bytes)",
      ],
      ["cache.entries.count", "gauge", "Current number of cache entries"],
      [
        "topic.change.detected",
        "counter",
        "Detected conversation topic changes",
      ],

      // Watchdog metrics
      [
        "watchdog.ram.status",
        "gauge",
        "Watchdog RAM status (0=ok, 1=warning, 2=critical)",
      ],
      [
        "watchdog.overall",
        "gauge",
        "Watchdog overall status (0=healthy, 1=degraded, 2=unhealthy)",
      ],
      ["watchdog.recovery.triggered", "counter", "Recovery attempts triggered"],
      ["watchdog.recovery.success", "counter", "Successful recoveries"],
      ["watchdog.recovery.failed", "counter", "Failed recoveries"],
    ];

    for (const [name, type, help] of defaults) {
      this.metrics.set(name, {
        name,
        type,
        help,
        values: new Map(),
        histogramBuckets:
          type === "histogram"
            ? [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
            : undefined,
      });
    }
  }

  increment(
    name: string,
    value: number = 1,
    labels?: Record<string, string>,
  ): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== "counter") return;

    const key = labels ? JSON.stringify(labels) : "default";
    // Mutate in place to avoid reallocating a MetricPoint on every increment.
    const point = metric.values.get(key);
    if (point) {
      point.value += value;
      point.timestamp = Date.now();
    } else {
      metric.values.set(key, { value, timestamp: Date.now(), labels });
    }
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== "gauge") return;

    const key = labels ? JSON.stringify(labels) : "default";
    const point = metric.values.get(key);
    if (point) {
      point.value = value;
      point.timestamp = Date.now();
    } else {
      metric.values.set(key, { value, timestamp: Date.now(), labels });
    }
  }

  histogram(
    name: string,
    value: number,
    labels?: Record<string, string>,
  ): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== "histogram") return;

    const key = labels ? JSON.stringify(labels) : "default";
    const existing = metric.values.get(key);
    // Reuse the stored aggregate object instead of re-wrapping it each call.
    let data: { count: number; sum: number; buckets: Map<number, number> };
    if (existing && typeof existing.value === "object" && existing.value !== null) {
      data = existing.value as { count: number; sum: number; buckets: Map<number, number> };
    } else {
      data = { count: 0, sum: 0, buckets: new Map<number, number>() };
    }

    data.count++;
    data.sum += value;
    const buckets = metric.histogramBuckets;
    if (buckets) {
      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        if (value <= bucket) {
          data.buckets.set(bucket, (data.buckets.get(bucket) || 0) + 1);
        } else if (!data.buckets.has(bucket)) {
          // Keep every bucket present for stable output, but skip redundant writes.
          data.buckets.set(bucket, 0);
        }
      }
    }

    if (existing) {
      existing.value = data as any;
      existing.timestamp = Date.now();
    } else {
      metric.values.set(key, { value: data as any, timestamp: Date.now(), labels });
    }
  }

  startCollection(): void {
    if (this.collectionInterval) return;

    this.collectionInterval = setInterval(() => {
      this.collectSystemMetrics();
    }, config.metrics.interval);
  }

  private collectSystemMetrics(): void {
    const heap = getHeapUsageSnapshot();
    const rss = getRssUsageSnapshot();
    this.gauge("memory.heap.used", heap.heapUsed);
    this.gauge("memory.heap.total", heap.heapTotal);
    this.gauge("memory.heap.limit", heap.heapSizeLimit);
    this.gauge("memory.heap.usage_percent", heap.usagePercent);
    this.gauge("memory.rss", heap.rss);
    this.gauge("memory.rss.usage_percent", rss.usagePercent);
  }

  get(name: string, labels?: Record<string, string>): MetricPoint | null {
    const metric = this.metrics.get(name);
    if (!metric) return null;
    const key = labels ? JSON.stringify(labels) : "default";
    return metric.values.get(key) || null;
  }

  formatPrometheus(): string {
    let output = "";
    for (const metric of this.metrics.values()) {
      output += `# HELP ${metric.name} ${metric.help}\n`;
      output += `# TYPE ${metric.name} ${metric.type}\n`;

      for (const point of metric.values.values()) {
        const labelPairs = point.labels
          ? Object.entries(point.labels).map(([k, v]) => `${k}="${v}"`)
          : [];
        const labelsStr = labelPairs.length ? `{${labelPairs.join(",")}}` : "";

        if (
          metric.type === "histogram" &&
          typeof point.value === "object" &&
          point.value !== null
        ) {
          // Histogram points store a {count, sum, buckets} aggregate; emitting
          // it raw produced "[object Object]" (invalid Prometheus exposition).
          const data = point.value as {
            count: number;
            sum: number;
            buckets: Map<number, number>;
          };
          const bucketPrefix = labelPairs.length
            ? `${labelPairs.join(",")},`
            : "";
          const sortedBuckets = [...data.buckets.keys()].sort((a, b) => a - b);
          for (const bucket of sortedBuckets) {
            output += `${metric.name}_bucket{${bucketPrefix}le="${bucket}"} ${data.buckets.get(bucket)} ${point.timestamp}\n`;
          }
          output += `${metric.name}_bucket{${bucketPrefix}le="+Inf"} ${data.count} ${point.timestamp}\n`;
          output += `${metric.name}_sum${labelsStr} ${data.sum} ${point.timestamp}\n`;
          output += `${metric.name}_count${labelsStr} ${data.count} ${point.timestamp}\n`;
          continue;
        }

        output += `${metric.name}${labelsStr} ${point.value} ${point.timestamp}\n`;
      }
    }
    return output;
  }

  reset(): void {
    for (const metric of this.metrics.values()) {
      metric.values.clear();
    }
    this.emit("reset", {});
  }

  stopCollection(): void {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = null;
    }
  }
}

export const metrics = new Metrics();
