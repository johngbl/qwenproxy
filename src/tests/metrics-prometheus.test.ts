import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

const { metrics } = await import("../core/metrics.ts");

test("formatPrometheus renders histograms as _bucket/_sum/_count series", () => {
  metrics.reset();
  metrics.histogram("latency.request", 12);
  metrics.histogram("latency.request", 300);

  const output = metrics.formatPrometheus();

  // Regression (upstream pedrofariasx/qwenproxy@328f7f4): the aggregate
  // {count, sum, buckets} object was interpolated raw, emitting
  // "[object Object]" — invalid Prometheus exposition.
  assert.ok(
    !output.includes("[object Object]"),
    "histogram must not serialize as [object Object]",
  );
  assert.match(output, /^# TYPE latency\.request histogram$/m);
  // Cumulative buckets: 12 falls in le>=25, 300 falls in le>=500.
  assert.match(output, /latency\.request_bucket\{le="5"\} 0 /m);
  assert.match(output, /latency\.request_bucket\{le="25"\} 1 /m);
  assert.match(output, /latency\.request_bucket\{le="250"\} 1 /m);
  assert.match(output, /latency\.request_bucket\{le="500"\} 2 /m);
  assert.match(output, /latency\.request_bucket\{le="\+Inf"\} 2 /m);
  assert.match(output, /latency\.request_sum 312 /m);
  assert.match(output, /latency\.request_count 2 /m);
});

test("formatPrometheus keeps plain counters/gauges unchanged", () => {
  metrics.reset();
  metrics.increment("requests.total");
  metrics.increment("requests.total");

  const output = metrics.formatPrometheus();
  assert.match(output, /^# TYPE requests\.total counter$/m);
  assert.match(output, /^requests\.total 2 /m);
});
