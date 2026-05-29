import { performance } from 'node:perf_hooks';

async function measurePlaywrightInit() {
  const start = performance.now();
  const { initPlaywright, getBasicHeaders } = await import('../services/playwright.ts');
  await initPlaywright();
  const initTime = performance.now() - start;
  
  const headerStart = performance.now();
  await getBasicHeaders();
  const headerTime = performance.now() - headerStart;
  
  return { initTime: initTime.toFixed(2), headerTime: headerTime.toFixed(2) };
}

async function measureNetworkLatency() {
  const { config } = await import('../core/config.ts');
  const start = performance.now();
  await fetch(`${config.qwen.baseUrl}/api/models`, {
    headers: { 'Accept': 'application/json' }
  }).catch(() => {});
  return { networkLatencyMs: (performance.now() - start).toFixed(2) };
}

async function runDiagnostic() {
  console.log('=== Bottleneck Diagnostic ===\n');
  
  try {
    const pw = await measurePlaywrightInit();
    console.log('Playwright:');
    console.log(`  Browser init: ${pw.initTime}ms`);
    console.log(`  Header fetch: ${pw.headerTime}ms`);
  } catch (e: any) {
    console.log(`Playwright: SKIP (${e.message})`);
  }
  
  try {
    const net = await measureNetworkLatency();
    console.log(`\nNetwork latency to Qwen: ${net.networkLatencyMs}ms`);
  } catch (e: any) {
    console.log(`Network: SKIP (${e.message})`);
  }
  
  console.log('\n=== Likely Bottlenecks ===');
  console.log('1. getQwenHeaders() UI interactions: 2000-5000ms per call');
  console.log('2. Global mutex (qwenChatMutex): serializes all chat requests');
  console.log('3. No header caching between requests: re-fetches PoW each time');
  console.log('4. Single browser context: no parallelism at browser level');
  console.log('\nRecommendations:');
  console.log('- Increase HEADERS_TTL in playwright.ts (currently 60min)');
  console.log('- Pre-fetch headers on startup, not per-request');
  console.log('- Consider request batching for concurrent users');
}

if (import.meta.main) {
  runDiagnostic().catch(console.error);
}
