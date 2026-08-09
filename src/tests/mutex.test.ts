import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";
// Short hold limit so stale-lock recovery can be tested without long waits.
process.env.MUTEX_MAX_HOLD_MS = "60";

const { Mutex } = await import("../core/mutex.ts");

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("Mutex: acquire and release", async () => {
  const m = new Mutex("t-basic");
  const release = await m.acquire();
  assert.strictEqual(m.state().locked, true);
  release();
  assert.strictEqual(m.state().locked, false);
});

test("Mutex: second acquire waits until release", async () => {
  const m = new Mutex("t-order");
  const r1 = await m.acquire(1000, "first");

  let acquired = false;
  const p = m.acquire(1000, "second").then((r) => {
    acquired = true;
    return r;
  });

  await tick(10);
  assert.strictEqual(acquired, false);
  r1();

  const r2 = await p;
  assert.strictEqual(acquired, true);
  r2();
  assert.strictEqual(m.isIdle(), true);
});

test("Mutex: withLock runs the callback and releases", async () => {
  const m = new Mutex("t-withlock");
  const result = await m.withLock(() => 42);
  assert.strictEqual(result, 42);
  assert.strictEqual(m.isIdle(), true);
});

test("Mutex: withLock releases even when the callback throws", async () => {
  const m = new Mutex("t-withlock-throw");
  await assert.rejects(() => m.withLock(() => {
    throw new Error("boom");
  }));
  assert.strictEqual(m.isIdle(), true);
});

test("Mutex: acquire times out when the lock is held too long", async () => {
  const m = new Mutex("t-timeout");
  const r1 = await m.acquire(1000, "holder");

  await assert.rejects(
    () => m.acquire(30, "waiter"),
    /acquire timeout after 30ms/,
  );

  r1();
});

test("Mutex: stale lock is force-released on the next acquire", async () => {
  const m = new Mutex("t-stale");
  const leaked = await m.acquire(1000, "leaked");
  assert.strictEqual(m.state().locked, true);

  // Wait past MUTEX_MAX_HOLD_MS (60ms in this suite) without releasing.
  await tick(80);

  // A new acquire must detect the stale lock and take it over.
  const fresh = await m.acquire(500, "fresh");
  assert.strictEqual(m.state().locked, true);
  assert.strictEqual(m.state().heldBy, "fresh");

  fresh();
  // Releasing the leaked handle afterwards is a safe no-op.
  leaked();
  assert.strictEqual(m.isIdle(), true);
});

test("Mutex: state reports holder and queue length", async () => {
  const m = new Mutex("t-state");
  const r1 = await m.acquire(1000, "a");
  const pending = m.acquire(1000, "b").then((r) => r);

  await tick(10);
  const st = m.state();
  assert.strictEqual(st.locked, true);
  assert.strictEqual(st.heldBy, "a");
  assert.strictEqual(st.queueLength, 1);
  assert.ok(st.heldForMs >= 0);

  r1();
  const r2 = await pending;
  r2();
  assert.strictEqual(m.isIdle(), true);
});

test("Mutex: release is idempotent", async () => {
  const m = new Mutex("t-idempotent");
  const release = await m.acquire();
  release();
  release(); // must not throw or double-release
  assert.strictEqual(m.isIdle(), true);
});
