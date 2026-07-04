import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryCache } from "../cache/memory-cache.ts";

test("MemoryCache.scan: caches regex patterns (upstream a63f054)", async () => {
  const cache = new MemoryCache({ prefix: "test:" });
  await cache.connect();

  // Add some test data
  await cache.set("session:user1" as any, "data1", 60);
  await cache.set("session:user2" as any, "data2", 60);
  await cache.set("auth:token" as any, "token1", 60);

  // First scan compiles and caches regex
  const result1 = await cache.scan("session:*");
  assert.equal(result1.length, 2);

  // Second scan with same pattern should use cached regex
  const result2 = await cache.scan("session:*");
  assert.equal(result2.length, 2);

  // Different pattern should compile new regex
  const result3 = await cache.scan("auth:*");
  assert.equal(result3.length, 1);

  await cache.close();
});

test("MemoryCache.scan: handles multiple different patterns", async () => {
  const cache = new MemoryCache({ prefix: "test2:" });
  await cache.connect();

  await cache.set("user:1" as any, "data1", 60);
  await cache.set("user:2" as any, "data2", 60);
  await cache.set("post:1" as any, "data3", 60);

  const patterns = ["user:*", "post:*", "*1"];

  for (const pattern of patterns) {
    const result = await cache.scan(pattern);
    assert.ok(result.length > 0);
  }

  await cache.close();
});
