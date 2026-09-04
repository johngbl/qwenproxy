/*
 * File: playwright.ts
 * Project: QwenProxy
 *
 * Playwright browser automation with stealth plugin for anti-bot evasion.
 * Captures real browser headers (bx-ua, bx-umidtoken) per account.
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import type { QwenAccount } from "../core/accounts.ts";
// Imported here rather than injected from session-keeper.ts: account-concurrency
// only depends on config/logger, so playwright -> account-concurrency stays
// acyclic, while the reverse direction would drag the browser layer into core.
import { hasActiveAccountLease } from "../core/account-concurrency.ts";
import { config } from "../core/config.ts";
import { maskEmail } from "../core/logger.ts";
import { Mutex } from "../core/mutex.ts";
import {
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import { getAccountsByPriority } from "../core/account-priority.ts";
import {
  clearFingerprintCache,
  getFingerprintProfile,
  type FingerprintProfile,
} from "./fingerprint.ts";
import { subtlePageActivity } from "./human-behavior.ts";
import { solveBaxiaCaptcha } from "./captcha-solver.ts";
import { qwenOrigin, qwenUrl } from "./qwen-url.ts";
import { setWafContextResetListener } from "../core/waf-isolation.ts";

// Try to import playwright-extra and stealth, fallback to regular playwright
let chromiumWithStealth: typeof chromium | null = null;

try {
  const pwExtra = await import("playwright-extra");
  const stealth = await import("puppeteer-extra-plugin-stealth");

  if (pwExtra.chromium && stealth.default) {
    const plugin = stealth.default();
    pwExtra.chromium.use(plugin);
    chromiumWithStealth = pwExtra.chromium;
  }
} catch {
  console.warn(
    "⚠️  [Playwright] playwright-extra/stealth not available, using regular playwright",
  );
}

export type BrowserType = "chromium" | "chrome" | "edge";

interface BrowserEngineConfig {
  engine: typeof chromium;
  channel?: string;
}

function resolveBrowserEngine(browserType: BrowserType): BrowserEngineConfig {
  switch (browserType) {
    case "chrome":
      return { engine: chromium, channel: "chrome" };
    case "edge":
      return { engine: chromium, channel: "msedge" };
    case "chromium":
    default:
      return { engine: chromium };
  }
}

/**
 * Chromium launch args tuned for multi-account proxy use.
 * Low-memory flags cap V8 old-space in renderer processes (fork-safe RAM fix).
 */
export function buildChromiumLaunchArgs(viewport: {
  width: number;
  height: number;
}): string[] {
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process,TranslateUI,Translate,OptimizationHints,MediaRouter",
    "--disable-infobars",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--enable-accelerated-2d-canvas",
    `--window-size=${viewport.width},${viewport.height}`,
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--disable-default-apps",
    "--disable-component-extensions-with-background-pages",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-gpu-shader-disk-cache",
  ];

  if (config.playwright.lowMemoryFlags) {
    const heapMb = config.playwright.jsHeapMb;
    args.push(
      `--js-flags=--max-old-space-size=${heapMb}`,
      "--renderer-process-limit=2",
      "--disk-cache-size=1",
      "--media-cache-size=1",
      "--disable-hang-monitor",
      "--disable-ipc-flooding-protection",
    );
  }

  return args;
}

// Per-account mutexes for browser access. maxHoldMs = 60s: a page operation
// legitimately takes a few seconds per step, but one exceeding 60s is a stuck
// browser op (closed context / WAF page swallow) and the account should return
// to the pool quickly (the 2026-08-22 log showed a lock held for 154s before
// the waiter's recovery path finally ran). The chat lock keeps its own longer
// hold budget (see acquireChatLock).
const ACCOUNT_MUTEX_MAX_HOLD_MS = 60_000;
const accountMutexes = new Map<string, Mutex>();

function getAccountMutex(accountId: string): Mutex {
  let mutex = accountMutexes.get(accountId);
  if (!mutex) {
    mutex = new Mutex(`playwright:${accountId.substring(0, 8)}`, ACCOUNT_MUTEX_MAX_HOLD_MS);
    accountMutexes.set(accountId, mutex);
  }
  return mutex;
}

async function recoverStuckAccountMutex(
  accountId: string,
  mutex: Mutex,
  key: string,
): Promise<void> {
  // A waiter timing out means the holder may be a browser operation that no
  // longer has a live promise (the logs showed locks held for hours). Closing
  // the context makes the old operation fail; replacing the mutex lets the
  // account be initialized again instead of remaining permanently wedged.
  if (accountMutexes.get(accountId) !== mutex) return;

  console.warn(
    `[Playwright] Recovering stuck account mutex | account=${accountId} | key=${key}`,
  );
  const context = accountContexts.get(accountId);
  if (context) {
    await closePlaywrightContextBestEffort(accountId, context);
  }
  cleanupPlaywrightAccountState(accountId);
  if (accountMutexes.get(accountId) === mutex) {
    accountMutexes.delete(accountId);
  }

  // A normal request can recover the browser on the next attempt. Avoid
  // recursively scheduling another reset when the reset/close path itself was
  // the operation that timed out.
  if (!key.startsWith("profile-reset:") && !key.startsWith("close:")) {
    schedulePlaywrightProfileReset(accountId);
  }
}

async function acquireAccountMutex(
  accountId: string,
  key: string,
  timeoutMs = PLAYWRIGHT_MUTEX_WAIT_MS,
  recoverOnTimeout = true,
): Promise<() => void> {
  const mutex = getAccountMutex(accountId);
  try {
    return await mutex.acquire(timeoutMs, key);
  } catch (error) {
    if (
      recoverOnTimeout &&
      error instanceof Error &&
      error.message.startsWith("Mutex[playwright:") &&
      error.message.includes("acquire timeout")
    ) {
      await recoverStuckAccountMutex(accountId, mutex, key);
    }
    throw error;
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

// Per-account browser contexts and pages
const accountContexts = new Map<string, BrowserContext>();
const accountPages = new Map<string, Page>();
const cachedUserAgents = new Map<string, string>();

// Header cache per account
interface AccountHeaderCache {
  headers: Record<string, string>;
  lastRefresh: number;
  refreshInProgress: boolean;
}

const headerCaches = new Map<string, AccountHeaderCache>();
// Real TTL measured from Qwen: auth token = 30 days, shortest cookie (acw_tc) = 24 min.
// 20 min is safe: under the 24-min acw_tc, and bx-ua expiry is handled by 403 retry.
const HEADER_CACHE_TTL = 20 * 60 * 1000; // 20 minutes
const HEADER_REFRESH_THRESHOLD = 0.8; // Background refresh at 80% of TTL (16 min)
const COOKIE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const cookieCaches = new Map<string, { cookie: string; timestamp: number }>();
const lastAccountActivity = new Map<string, number>();
const lastKeepAliveNavigation = new Map<string, number>();
const profileResetQueue = new Map<string, Promise<void>>();
let profileResetChain: Promise<void> = Promise.resolve();
let closingAllPlaywright = false;

type KillableProcess = {
  killed?: boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HEADER_CAPTURE_SETTLE_MS = 1500;
const PLAYWRIGHT_MUTEX_WAIT_MS = 60_000;
const ACCOUNT_PAGE_OPERATION_TIMEOUT_MS = config.timeouts.page;
/**
 * The session probe in front of a header refresh only answers "is this account
 * still logged in". Header capture navigates again right after, so paying the
 * full navigation timeout here doubles the stall of a WAF-blocked account for
 * no extra information.
 */
const SESSION_PROBE_NAVIGATION_TIMEOUT_MS = 15_000;
/** Grace period for the intercepted completion request after the send is triggered. */
const HEADER_CAPTURE_TRIGGER_GRACE_MS = 15_000;
/**
 * First-send grace is short: the page is cold and the bx SDK has not computed
 * its tokens yet, so a cold page almost never produces a request from the first
 * send. Fail it fast and let the retry loop reload + re-send against the warm
 * SDK instead of stalling the boot for the full 15s.
 */
const FIRST_TRIGGER_GRACE_MS = 3_000;
/**
 * Sends (the initial one plus re-triggers) header capture may spend on getting a
 * completion request that actually carries the bx headers. The in-page SDK can
 * fire one before it finished computing its token, and dropping the account on
 * that first unlucky request costs five minutes of cooldown; a couple of extra
 * sends cover it while still failing a page that never produces them.
 */
const HEADER_CAPTURE_TRIGGER_ATTEMPTS = 3;

/**
 * A challenge blocking the chat page makes the send button inert, so header
 * capture would wait out its whole timeout and report the account as broken.
 * Clearing the challenge first is what keeps that from cooling down a healthy
 * account for five minutes.
 */
async function clearVisibleChallenge(page: Page): Promise<void> {
  if (!config.captcha.enabled) return;
  // waitForMs 0: a single detection pass, so the common no-challenge case adds
  // no measurable cost to header capture.
  await solveBaxiaCaptcha(page, {
    waitForMs: 0,
    maxAttempts: config.captcha.maxAttempts,
    retryDelayMs: config.captcha.retryDelayMs,
    settleMs: config.captcha.settleMs,
  }).catch(() => false);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

function getBrowserProcess(context: BrowserContext): KillableProcess | null {
  const browser = context.browser();
  const maybeBrowser = browser as unknown as {
    process?: () => KillableProcess | null;
  };
  return maybeBrowser.process?.() ?? null;
}

function touchAccountActivity(accountId: string): void {
  lastAccountActivity.set(accountId, Date.now());
}

/**
 * A browser generation hands the renderer the upstream fetch and returns
 * immediately, so the account mutex is free and no page operation happens for
 * the whole stream (see createQwenBrowserResponse in qwen.ts). Mutex idleness
 * plus a stale timestamp therefore describes a mid-flight account exactly like
 * a parked one — the stream lease is the only state held end to end, so the
 * maintenance paths have to ask for it before touching the page.
 */
function isAccountServingStream(accountId: string): boolean {
  if (!hasActiveAccountLease(accountId)) return false;
  // Keep the idle clock honest while the stream runs: without this the account
  // would count as idle since the request started, and a 10-minute generation
  // would be collectable the instant its lease is released.
  touchAccountActivity(accountId);
  return true;
}

function getStealthScript(profile: FingerprintProfile): string {
  const profileJson = JSON.stringify(profile).replace(/</g, "\\u003c");
  return `
    (function() {
      const PROFILE = ${profileJson};

      function mulberry32(seed) {
        return function() {
          seed |= 0;
          seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }

      const canvasRng = mulberry32(PROFILE.canvasNoiseSeed);
      const audioRng = mulberry32(PROFILE.audioNoiseSeed);
      const webglRng = mulberry32(PROFILE.webglNoiseSeed);

      // --- Function.prototype.toString spoofing via WeakSet ---
      const nativeToString = Function.prototype.toString;
      const spoofedFunctions = new WeakSet();

      Function.prototype.toString = function() {
        if (spoofedFunctions.has(this)) {
          return 'function ' + (this.name || '') + '() { [native code] }';
        }
        return nativeToString.call(this);
      };
      spoofedFunctions.add(Function.prototype.toString);

      // --- Prototype-chain patching helper (harder to detect) ---
      function defineOnPrototype(obj, prop, value) {
        const proto = Object.getPrototypeOf(obj);
        if (!proto) return;
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (desc && desc.configurable) {
          const getter = typeof value === 'function' ? value : () => value;
          Object.defineProperty(proto, prop, {
            get: getter,
            configurable: true,
            enumerable: desc.enumerable !== false,
          });
          spoofedFunctions.add(getter);
        }
      }

      // --- navigator.webdriver ---
      try {
        const proto = Object.getPrototypeOf(navigator);
        const desc = Object.getOwnPropertyDescriptor(proto, 'webdriver');
        if (desc && desc.configurable) {
          Object.defineProperty(proto, 'webdriver', {
            get: () => undefined,
            configurable: true,
            enumerable: true,
          });
          spoofedFunctions.add(Object.getOwnPropertyDescriptor(proto, 'webdriver').get);
        }
      } catch(e) {}

      // iframe-based webdriver bypass
      try {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        document.documentElement.appendChild(iframe);
        const iframeNav = iframe.contentWindow.navigator;
        const cleanWebdriver = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(iframeNav), 'webdriver');
        if (cleanWebdriver && cleanWebdriver.get) {
          Object.defineProperty(Object.getPrototypeOf(iframeNav), 'webdriver', {
            get: () => undefined,
            configurable: true,
            enumerable: true,
          });
        }
        document.documentElement.removeChild(iframe);
      } catch(e) {}

      // --- Identity ---
      defineOnPrototype(navigator, 'userAgent', PROFILE.userAgent);
      defineOnPrototype(navigator, 'appVersion', PROFILE.appVersion);
      defineOnPrototype(navigator, 'platform', 'Win32');

      // --- userAgentData ---
      try {
        const userAgentData = {
          brands: PROFILE.brands,
          mobile: false,
          platform: 'Windows',
          getHighEntropyValues: async (hints) => {
            return {
              brands: PROFILE.fullVersionList,
              mobile: false,
              platform: 'Windows',
              platformVersion: PROFILE.platformVersion,
              architecture: PROFILE.architecture,
              bitness: PROFILE.bitness,
              model: '',
              uaFullVersion: PROFILE.chromeVersion,
              fullVersionList: PROFILE.fullVersionList,
              wow64: false,
            };
          },
          toJSON: () => ({
            brands: PROFILE.brands,
            mobile: false,
            platform: 'Windows',
          }),
        };
        defineOnPrototype(navigator, 'userAgentData', userAgentData);
      } catch(e) {}

      // --- Languages / hardware ---
      defineOnPrototype(navigator, 'languages', Object.freeze(PROFILE.languages));
      defineOnPrototype(navigator, 'language', PROFILE.locale);
      defineOnPrototype(navigator, 'hardwareConcurrency', PROFILE.hardwareConcurrency);
      defineOnPrototype(navigator, 'deviceMemory', PROFILE.deviceMemory);
      defineOnPrototype(navigator, 'maxTouchPoints', 0);
      defineOnPrototype(navigator, 'vendor', 'Google Inc.');
      defineOnPrototype(screen, 'colorDepth', PROFILE.colorDepth);
      defineOnPrototype(screen, 'pixelDepth', PROFILE.pixelDepth);

      // --- outerWidth/outerHeight (headless detection) ---
      try {
        if (window.outerWidth === 0 || window.outerHeight === 0) {
          Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth + PROFILE.outerWidthOffset });
          Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + PROFILE.outerHeightOffset });
        }
      } catch(e) {}

      // --- chrome object (realistic) ---
      window.chrome = {
        runtime: {
          onConnect: Object.create(null),
          onMessage: Object.create(null),
          sendMessage: function() {},
          connect: function() { return { onMessage: Object.create(null), postMessage: function() {} }; },
        },
        loadTimes: function() {
          return {
            requestTime: Date.now() / 1000,
            startLoadTime: Date.now() / 1000,
            commitLoadTime: Date.now() / 1000,
            finishDocumentLoadTime: Date.now() / 1000,
            finishLoadTime: Date.now() / 1000,
            firstPaintTime: Date.now() / 1000,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: false,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: 'http/1.1',
            wasAlternateProtocolAvailable: false,
            alternateProtocol: '',
          };
        },
        csi: function() {
          return {
            startE: Date.now(),
            onloadT: Date.now(),
            pageT: Math.random() * 1000,
            tran: 15,
          };
        },
        app: {
          isInstalled: false,
          getDetails: function() { return null; },
          getIsInstalled: function() { return false; },
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        },
      };

      // --- permissions ---
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: (typeof Notification !== 'undefined' ? Notification.permission : 'default'), onchange: null })
          : originalQuery(parameters);
      spoofedFunctions.add(window.navigator.permissions.query);

      // --- WebGL getParameter ---
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return PROFILE.webglVendor;
        if (parameter === 37446) return PROFILE.webglRenderer;
        return getParameter.apply(this, arguments);
      };
      spoofedFunctions.add(WebGLRenderingContext.prototype.getParameter);

      if (typeof WebGL2RenderingContext !== 'undefined') {
        const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) return PROFILE.webglVendor;
          if (parameter === 37446) return PROFILE.webglRenderer;
          return getParameter2.apply(this, arguments);
        };
        spoofedFunctions.add(WebGL2RenderingContext.prototype.getParameter);
      }

      // --- WebGL readPixels noise ---
      const _readPixels = WebGLRenderingContext.prototype.readPixels;
      WebGLRenderingContext.prototype.readPixels = function(x, y, width, height, format, type, pixels) {
        _readPixels.apply(this, arguments);
        if (pixels) {
          const maxPixels = Math.min(pixels.length, 10000);
          for (let i = 0; i < maxPixels; i++) {
            if (webglRng() < 0.03) {
              pixels[i] = Math.min(255, Math.max(0, pixels[i] + (webglRng() > 0.5 ? 1 : -1)));
            }
          }
        }
      };
      spoofedFunctions.add(WebGLRenderingContext.prototype.readPixels);

      if (typeof WebGL2RenderingContext !== 'undefined') {
        const _readPixels2 = WebGL2RenderingContext.prototype.readPixels;
        WebGL2RenderingContext.prototype.readPixels = function(x, y, width, height, format, type, pixels) {
          _readPixels2.apply(this, arguments);
          if (pixels) {
            const maxPixels = Math.min(pixels.length, 10000);
            for (let i = 0; i < maxPixels; i++) {
              if (webglRng() < 0.03) {
                pixels[i] = Math.min(255, Math.max(0, pixels[i] + (webglRng() > 0.5 ? 1 : -1)));
              }
            }
          }
        };
        spoofedFunctions.add(WebGL2RenderingContext.prototype.readPixels);
      }

      // --- navigator.connection ---
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false,
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
      });

      // --- Plugins / MimeTypes (realistic structure) ---
      (function() {
        function makeMime(desc, suffixes, type) {
          return { description: desc, suffixes: suffixes, type: type };
        }
        const pdfMime = makeMime('Portable Document Format', 'pdf', 'application/pdf');
        const pdfxMime = makeMime('Portable Document Format', 'pdf', 'text/pdf');
        const pdfPlugin = {
          name: 'PDF Viewer',
          description: 'Portable Document Format',
          filename: 'internal-pdf-viewer',
          length: 2,
          0: pdfMime,
          1: pdfxMime,
        };
        pdfMime.enabledPlugin = pdfPlugin;
        pdfxMime.enabledPlugin = pdfPlugin;

        const chromePdfMime = makeMime('Portable Document Format', 'pdf', 'application/pdf');
        const chromePdfMime2 = makeMime('Portable Document Format', 'pdf', 'text/pdf');
        const chromePdfPlugin = {
          name: 'Chrome PDF Viewer',
          description: 'Portable Document Format',
          filename: 'internal-pdf-viewer',
          length: 2,
          0: chromePdfMime,
          1: chromePdfMime2,
        };
        chromePdfMime.enabledPlugin = chromePdfPlugin;
        chromePdfMime2.enabledPlugin = chromePdfPlugin;

        const nativePlugin = {
          name: 'Native Client',
          description: '',
          filename: 'internal-nacl-plugin',
          length: 2,
          0: makeMime('Native Client Executable', '', 'application/x-nacl'),
          1: makeMime('Portable Native Client Executable', '', 'application/x-pnacl'),
        };
        nativePlugin[0].enabledPlugin = nativePlugin;
        nativePlugin[1].enabledPlugin = nativePlugin;

        const pluginsList = [pdfPlugin, chromePdfPlugin, nativePlugin];
        const mimeList = [pdfMime, pdfxMime, chromePdfMime, chromePdfMime2, nativePlugin[0], nativePlugin[1]];

        function makeNamedNodeMap(items, namedEntries) {
          const arr = [...items];
          for (const [k, v] of namedEntries) arr[k] = v;
          arr.item = function(i) { return this[i] || null; };
          arr.namedItem = function(name) { return this[name] || null; };
          arr.refresh = function() {};
          return arr;
        }

        const pluginEntries = pluginsList.map((p) => [p.name, p]);
        const mimeEntries = mimeList.map((m) => [m.type, m]);

        const pluginsArr = makeNamedNodeMap(pluginsList, pluginEntries);
        const mimeArr = makeNamedNodeMap(mimeList, mimeEntries);

        defineOnPrototype(navigator, 'plugins', pluginsArr);
        defineOnPrototype(navigator, 'mimeTypes', mimeArr);
      })();

      // --- Canvas fingerprint noise ---
      (function() {
        const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
        const _toBlob = HTMLCanvasElement.prototype.toBlob;
        const _getImageData = CanvasRenderingContext2D.prototype.getImageData;

        function addNoise(canvas) {
          try {
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            const style = ctx.fillStyle;
            ctx.fillStyle = 'rgba(255,255,255,0.01)';
            ctx.fillRect(0, 0, 1, 1);
            ctx.fillStyle = style;
          } catch(e) {}
        }

        HTMLCanvasElement.prototype.toDataURL = function(...args) {
          addNoise(this);
          return _toDataURL.apply(this, args);
        };
        spoofedFunctions.add(HTMLCanvasElement.prototype.toDataURL);

        HTMLCanvasElement.prototype.toBlob = function(...args) {
          addNoise(this);
          return _toBlob.apply(this, args);
        };
        spoofedFunctions.add(HTMLCanvasElement.prototype.toBlob);

        CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
          const imageData = _getImageData.apply(this, arguments);
          const data = imageData.data;
          const maxPixels = Math.min(data.length / 4, 2500);
          for (let i = 0; i < maxPixels * 4; i += 4) {
            if (canvasRng() < 0.05) {
              data[i] = Math.min(255, Math.max(0, data[i] + (canvasRng() > 0.5 ? 1 : -1)));
              data[i+1] = Math.min(255, Math.max(0, data[i+1] + (canvasRng() > 0.5 ? 1 : -1)));
              data[i+2] = Math.min(255, Math.max(0, data[i+2] + (canvasRng() > 0.5 ? 1 : -1)));
            }
          }
          return imageData;
        };
        spoofedFunctions.add(CanvasRenderingContext2D.prototype.getImageData);
      })();

      // --- Audio fingerprint noise ---
      (function() {
        if (typeof OfflineAudioContext === 'undefined') return;
        const _startRendering = OfflineAudioContext.prototype.startRendering;
        OfflineAudioContext.prototype.startRendering = function() {
          return _startRendering.apply(this, arguments).then(buffer => {
            try {
              for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
                const data = buffer.getChannelData(ch);
                for (let i = 0; i < Math.min(data.length, 100); i++) {
                  data[i] += (audioRng() - 0.5) * 1e-7;
                }
              }
            } catch(e) {}
            return buffer;
          });
        };
        spoofedFunctions.add(OfflineAudioContext.prototype.startRendering);
      })();

      // --- Remove ChromeDriver artifacts ---
      try {
        const keys = Object.keys(document);
        for (const key of keys) {
          if (key.startsWith('$cdc_') || key.startsWith('$wdc_')) {
            delete document[key];
          }
        }
      } catch(e) {}

      // --- Filter performance entries (hide addInitScript traces) ---
      try {
        if (window.performance && window.performance.getEntriesByType) {
          const originalGetEntries = window.performance.getEntriesByType.bind(window.performance);
          window.performance.getEntriesByType = function(type) {
            const entries = originalGetEntries(type);
            if (type === 'resource') {
              return entries.filter(e => !e.name.includes('__injectedScript') && !e.name.includes('addInitScript'));
            }
            return entries;
          };
          spoofedFunctions.add(window.performance.getEntriesByType);
        }
      } catch(e) {}
    })();
  `;
}

function getHeaderCache(accountId: string): AccountHeaderCache {
  let cache = headerCaches.get(accountId);
  if (!cache) {
    cache = {
      headers: {},
      lastRefresh: 0,
      refreshInProgress: false,
    };
    headerCaches.set(accountId, cache);
  }
  return cache;
}

/**
 * Headers the capture must produce before a request may reach Qwen. With
 * QWEN_SEND_BX_UA=false (default, matching the real client) only the
 * cookie/UA/bx-v trio is required; bx-ua/bx-umidtoken are captured but never
 * injected, so their absence must not gate the pipeline.
 */
function requiredAntiBotHeaderKeys(): string[] {
  return config.qwen.sendBxUa
    ? ["cookie", "user-agent", "bx-ua", "bx-umidtoken", "bx-v"]
    : ["cookie", "user-agent", "bx-v"];
}

export function hasRequiredQwenHeaders(
  headers: Record<string, string>,
): boolean {
  return requiredAntiBotHeaderKeys().every((key) => Boolean(headers[key]?.trim()));
}

/**
 * Validate that all required anti-bot headers are present before making a
 * request. Fails early instead of sending an incomplete request that will
 * certainly be blocked by the WAF.
 */
export function assertAntiBotHeaders(
  headers: Record<string, string>,
  label: string,
): void {
  const missing = requiredAntiBotHeaderKeys().filter(
    (key) => !headers[key]?.trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `${label} missing required browser anti-bot headers: ${missing.join(", ")}`,
    );
  }
}

/**
 * Lightweight cookie refresh: update only the cookie string without a full
 * header re-capture. Used when the header cache is still valid but cookies
 * may have rotated.
 */
async function tryLightweightCookieRefresh(
  accountId: string,
  cache: AccountHeaderCache,
): Promise<boolean> {
  const page = accountPages.get(accountId);
  if (!page || page.isClosed()) return false;

  if (!hasRequiredQwenHeaders(cache.headers)) return false;

  try {
    const cookies = await withTimeout(
      page.context().cookies(),
      config.timeouts.page,
      `Cookie refresh timed out for ${accountId}`,
    );
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    cookieCaches.set(accountId, { cookie: cookieStr, timestamp: Date.now() });
    return true;
  } catch {
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getCookies(accountId: string): Promise<string> {
  const now = Date.now();
  const cached = cookieCaches.get(accountId);
  if (cached && now - cached.timestamp < COOKIE_CACHE_TTL) {
    return cached.cookie;
  }

  const page = accountPages.get(accountId);
  if (!page) return "";

  const cookies = await withTimeout(
    page.context().cookies(),
    config.timeouts.page,
    `Cookie retrieval timed out for ${accountId}`,
  );
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  cookieCaches.set(accountId, { cookie: cookieStr, timestamp: now });
  return cookieStr;
}

export async function getBasicHeaders(accountId: string): Promise<{
  cookie: string;
  userAgent: string;
  bxV: string;
  bxUa: string;
  bxUmidtoken: string;
  secChUa: string;
  secChUaMobile: string;
  secChUaPlatform: string;
  version: string;
}> {
  const page = accountPages.get(accountId);
  if (!page) {
    throw new Error(`Playwright not initialized for account: ${accountId}`);
  }

  // Acquire mutex to prevent concurrent browser access
  const release = await acquireAccountMutex(
    accountId,
    `headers:${accountId.substring(0, 12)}`,
  );
  try {
    touchAccountActivity(accountId);
    // Get real user agent + client hints from the browser. They are constant
    // for the lifetime of the context, so they are fetched once and cached per
    // account to avoid CDP round-trips on every request. The client-hint
    // headers (sec-ch-ua / platform / mobile) are derived from the live
    // browser so the anti-bot fingerprint stays current instead of a hardcoded
    // Chrome version.
    let userAgent = cachedUserAgents.get(accountId) ?? "";
    let clientHints = {
      secChUa: "",
      secChUaMobile: "?0",
      secChUaPlatform: "",
      version: config.qwen.webVersion,
    };
    try {
      if (!userAgent) {
        const nav = await withTimeout(
          page.evaluate(() => {
            const ua = navigator.userAgent;
            const data = (navigator as unknown as {
              userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string; mobile?: boolean };
            }).userAgentData;
            let secChUa = "";
            let platform = "";
            let mobile = "?0";
            if (data?.brands && Array.isArray(data.brands)) {
              secChUa = data.brands
                .map((b) => `${JSON.stringify(b.brand)};v="${b.version}"`)
                .join(", ");
              platform = data.platform || "";
              mobile = data.mobile ? "?1" : "?0";
            }
            return { ua, secChUa, platform, mobile };
          }),
          config.timeouts.page,
          `User-agent lookup timed out for ${accountId}`,
        );
        userAgent = nav.ua;
        cachedUserAgents.set(accountId, userAgent);
        const hints = getHeaderCache(accountId).headers;
        clientHints = {
          secChUa: nav.secChUa,
          secChUaMobile: nav.mobile,
          secChUaPlatform: nav.platform ? JSON.stringify(nav.platform) : "",
          version: hints["version"] || config.qwen.webVersion,
        };
        if (nav.secChUa) hints["sec-ch-ua"] = nav.secChUa;
        hints["sec-ch-ua-mobile"] = nav.mobile;
        if (nav.platform) hints["sec-ch-ua-platform"] = nav.platform;
      } else {
        const hints = getHeaderCache(accountId).headers;
        clientHints = {
          secChUa: hints["sec-ch-ua"] || "",
          secChUaMobile: hints["sec-ch-ua-mobile"] || "?0",
          secChUaPlatform: hints["sec-ch-ua-platform"] || "",
          version: hints["version"] || config.qwen.webVersion,
        };
      }
    } catch {
      userAgent = config.auth.userAgent;
    }

    const cache = getHeaderCache(accountId);
    const hadUsableHeaders = hasRequiredQwenHeaders(cache.headers);

    // Fast path: if headers are still fresh, just refresh cookies lightly
    const headersAge = Date.now() - cache.lastRefresh;
    if (
      hadUsableHeaders &&
      headersAge < HEADER_CACHE_TTL * HEADER_REFRESH_THRESHOLD
    ) {
      await tryLightweightCookieRefresh(accountId, cache);
      markAccountHeadersReady(accountId);
      const bxUa = cache.headers["bx-ua"];
      const bxUmidtoken = cache.headers["bx-umidtoken"];
      const bxV = cache.headers["bx-v"] || "2.5.37";
      const cookie = await getCookies(accountId);
      return { cookie, userAgent, bxV, bxUa, bxUmidtoken, ...clientHints };
    }

    // Extended fast path: headers are stale but auth token is still valid.
    // Check if we can skip full recapture by verifying cookie validity.
    // This avoids expensive browser interaction when the 30-day token is fresh.
    if (hadUsableHeaders && headersAge > HEADER_CACHE_TTL) {
      // A single CDP cookies() snapshot feeds both validity checks and the
      // cookie string (previously 3 round-trips: 2 validators + lightweight
      // refresh).
      const cookieSnapshot = await getCookieSnapshot(accountId);
      if (
        cookieSnapshot &&
        isAuthTokenValidFrom(cookieSnapshot) &&
        isShortestCookieValidFrom(cookieSnapshot)
      ) {
        // Token is still valid - just refresh cookies, keep cached headers
        const cookie = cookieSnapshot
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
        cookieCaches.set(accountId, { cookie, timestamp: Date.now() });
        const bxUa = cache.headers["bx-ua"];
        const bxUmidtoken = cache.headers["bx-umidtoken"];
        const bxV = cache.headers["bx-v"] || "2.5.37";
        cache.lastRefresh = Date.now();
        markAccountHeadersReady(accountId);
        console.log(
          `🔄 [Playwright] Skipped header recapture for ${accountId} (token still valid, age: ${Math.round(headersAge / 60000)} min)`,
        );
        return { cookie, userAgent, bxV, bxUa, bxUmidtoken, ...clientHints };
      }
    }

    // Refresh headers if stale. A valid cached set remains usable when a
    // browser recapture transiently fails; a cold/partial cache must fail.
    if (headersAge > HEADER_CACHE_TTL && !cache.refreshInProgress) {
      try {
        await refreshHeadersInternal(accountId);
      } catch (error) {
        if (!hadUsableHeaders) throw error;
        console.warn(
          `⚠️  [Playwright] Header refresh failed for ${accountId}; retaining the previous valid cache: ${getErrorMessage(error)}`,
        );
      }
    } else if (
      hadUsableHeaders &&
      headersAge > HEADER_CACHE_TTL * HEADER_REFRESH_THRESHOLD &&
      !cache.refreshInProgress
    ) {
      // Background refresh at 70% TTL: keep headers fresh without blocking
      cache.refreshInProgress = true;
      refreshHeadersInternal(accountId)
        .catch((error) => {
          console.warn(
            `⚠️  [Playwright] Background header refresh failed for ${accountId}: ${getErrorMessage(error)}`,
          );
        })
        .finally(() => {
          cache.refreshInProgress = false;
        });
    }

    if (!hasRequiredQwenHeaders(cache.headers)) {
      console.log(
        `🔄 [Playwright] Missing required anti-bot headers for ${accountId}, triggering header interception...`,
      );
      try {
        await refreshHeadersInternal(accountId);
      } catch (error) {
        console.warn(
          `❌ [Playwright] Failed to auto-recover headers for ${accountId}: ${getErrorMessage(error)}`,
        );
      }
    }

    if (!hasRequiredQwenHeaders(cache.headers)) {
      throw new Error(
        `Required Qwen anti-fraud headers are unavailable for account: ${accountId}`,
      );
    }

    markAccountHeadersReady(accountId);
    const bxUa = cache.headers["bx-ua"];
    const bxUmidtoken = cache.headers["bx-umidtoken"];
    const bxV = cache.headers["bx-v"] || "2.5.37";

    // Read cookie AFTER all refreshes (re-login may have updated it)
    const cookie = await getCookies(accountId);

    return {
      cookie,
      userAgent,
      bxV,
      bxUa,
      bxUmidtoken,
      ...clientHints,
    };
  } finally {
    release();
  }
}

export async function initPlaywrightForAccount(
  account: QwenAccount,
  headless = true,
  browserType: BrowserType = "chromium",
): Promise<void> {
  if (accountPages.has(account.id)) {
    console.log(
      `[Playwright] Already initialized for ${maskEmail(account.email)}`,
    );
    return;
  }

  const release = await acquireAccountMutex(
    account.id,
    `init:${account.id.substring(0, 12)}`,
  );
  try {
    // Double-check after acquiring lock
    if (accountPages.has(account.id)) {
      return;
    }

    // If a context limit is configured, make room by closing idle contexts.
    await evictIdlePlaywrightContextsToLimit().catch(() => {});

    const profilePath = path.resolve("data", "qwen_profiles", account.id);
    const fingerprint = getFingerprintProfile(account.id);
    const { engine, channel } = resolveBrowserEngine(browserType);

    // Use playwright-extra with stealth if available, otherwise regular chromium
    const engineToUse = chromiumWithStealth || engine;

    const acctContext = await engineToUse.launchPersistentContext(profilePath, {
      headless,
      channel,
      userAgent: fingerprint.userAgent,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      viewport: fingerprint.viewport,
      screen: fingerprint.viewport,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      colorScheme: "light",
      extraHTTPHeaders: {
        "sec-ch-ua": fingerprint.secChUa,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
      ignoreDefaultArgs: ["--enable-automation", "--enable-blink-features"],
      args: buildChromiumLaunchArgs(fingerprint.viewport),
    });

    try {
      // Comprehensive stealth scripts for anti-bot evasion
      await acctContext.addInitScript(getStealthScript(fingerprint));

      // Persistent contexts may already contain an initial about:blank tab.
      // Reuse it instead of creating a second tab. Prefer a tab already on the
      // Qwen origin when one exists.
      const existingPages = acctContext.pages().filter((p) => !p.isClosed());
      const acctPage =
        existingPages.find((p) => p.url().startsWith(qwenOrigin())) ??
        existingPages[0] ??
        (await acctContext.newPage());

      // Close any extra blank tabs that may have been created by the browser
      // profile/startup, but keep the primary page selected above.
      for (const extraPage of existingPages.slice(1)) {
        if (extraPage !== acctPage && extraPage.url() === "about:blank") {
          await extraPage.close({ runBeforeUnload: false }).catch(() => {});
        }
      }

      acctPage.setDefaultTimeout(config.timeouts.page);
      acctPage.setDefaultNavigationTimeout(config.timeouts.navigation);
      accountContexts.set(account.id, acctContext);
      accountPages.set(account.id, acctPage);
      installContextDeathHandlers(account.id, acctContext, acctPage);
      touchAccountActivity(account.id);

      // Check if already logged in
      const cookies = await acctContext.cookies();
      const hasAuthCookie = cookies.some(
        (c) =>
          c.name.toLowerCase().includes("token") ||
          c.name.toLowerCase().includes("session"),
      );

      if (!hasAuthCookie && account.email && account.password) {
        await loginToQwen(account.id, account.email, account.password);
      }

      // Navigate to the stable chat page to validate the session and populate cookies.
      // Retry up to 2 times on transient timeouts before giving up.
      const maxValidationAttempts = 2;
      let validationError: Error | null = null;
      for (let vAttempt = 1; vAttempt <= maxValidationAttempts; vAttempt++) {
        try {
          await acctPage.goto(qwenUrl("/"), {
            waitUntil: "domcontentloaded",
            timeout: config.timeouts.navigation,
          });
          const url = acctPage.url();
          if (url.includes("auth") || url.includes("login")) {
            if (account.email && account.password) {
              console.warn(
                `⚠️  [Playwright] Session expired for ${maskEmail(account.email)}, re-authenticating...`,
              );
              await loginToQwen(account.id, account.email, account.password);
            } else {
              console.warn(
                `[Playwright] Session expired for account ${account.id} but no credentials available.`,
              );
            }
          }
          validationError = null;
          break;
        } catch (err: any) {
          validationError = err;
          if (vAttempt < maxValidationAttempts) {
            console.warn(
              `⚠️  [Playwright] Session validation attempt ${vAttempt}/${maxValidationAttempts} failed for ${maskEmail(account.email)}: ${err.message}, retrying...`,
            );
            await sleep(3000);
          }
        }
      }
      if (validationError) {
        console.warn(
          `❌ [Playwright] Failed to validate session for ${maskEmail(account.email)} after ${maxValidationAttempts} attempts: ${validationError.message}`,
        );
        throw validationError;
      }

      // Capture headers by navigating and intercepting
      await captureQwenHeaders(account.id);

      // Header capture may leave the UI on a generated chat page. Return the
      // primary tab to the canonical chat home.
      if (!acctPage.isClosed()) {
        try {
          const currentUrl = new URL(acctPage.url());
          if (currentUrl.origin !== qwenOrigin() || currentUrl.pathname !== "/") {
            await acctPage.goto(qwenUrl("/"), {
              waitUntil: "domcontentloaded",
              timeout: config.timeouts.navigation,
            });
          }
        } catch {
          // Non-fatal: the next normal operation will navigate back.
        }
      }

      touchAccountActivity(account.id);
    } catch (error) {
      await closePlaywrightContextBestEffort(account.id, acctContext);
      cleanupPlaywrightAccountState(account.id);
      throw error;
    }
  } finally {
    release();
  }
}

// ─── Standby Validation ──────────────────────────────────────────────────────

/**
 * Validate that an account can log in without keeping the browser open.
 * Opens browser, checks session, logs in if needed, then closes browser.
 * This is much lighter than full initPlaywrightForAccount (no header capture).
 */
export async function validateAccountLogin(
  account: QwenAccount,
  headless = true,
  browserType: BrowserType = "chromium",
): Promise<boolean> {
  if (accountPages.has(account.id)) {
    // Already initialized, no need to validate
    return true;
  }

  const release = await acquireAccountMutex(
    account.id,
    `validate:${account.id.substring(0, 12)}`,
  );
  try {
    if (accountPages.has(account.id)) return true;

    const profilePath = path.resolve("data", "qwen_profiles", account.id);
    const fingerprint = getFingerprintProfile(account.id);
    const { engine, channel } = resolveBrowserEngine(browserType);
    const engineToUse = chromiumWithStealth || engine;

    const acctContext = await engineToUse.launchPersistentContext(profilePath, {
      headless,
      channel,
      userAgent: fingerprint.userAgent,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      viewport: fingerprint.viewport,
      screen: fingerprint.viewport,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      colorScheme: "light",
      extraHTTPHeaders: {
        "sec-ch-ua": fingerprint.secChUa,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
      ignoreDefaultArgs: ["--enable-automation", "--enable-blink-features"],
      args: buildChromiumLaunchArgs(fingerprint.viewport),
    });

    try {
      await acctContext.addInitScript(getStealthScript(fingerprint));

      const existingPages = acctContext.pages().filter((p) => !p.isClosed());
      const acctPage =
        existingPages.find((p) => p.url().startsWith(qwenOrigin())) ??
        existingPages[0] ??
        (await acctContext.newPage());

      // Check if already logged in via cookies
      const cookies = await acctContext.cookies();
      const hasAuthCookie = cookies.some(
        (c) =>
          c.name.toLowerCase().includes("token") ||
          c.name.toLowerCase().includes("session"),
      );

      let loggedIn = hasAuthCookie;

      if (!loggedIn && account.email && account.password) {
        // Need to register page temporarily for login functions
        accountPages.set(account.id, acctPage);
        try {
          loggedIn = await loginToQwen(account.id, account.email, account.password);
        } finally {
          accountPages.delete(account.id);
        }
      } else if (hasAuthCookie) {
        // Validate session by navigating to chat page
        try {
          await acctPage.goto(qwenUrl("/"), {
            waitUntil: "domcontentloaded",
            timeout: config.timeouts.navigation,
          });
          const url = acctPage.url();
          if (url.includes("auth") || url.includes("login")) {
            loggedIn = false;
            if (account.email && account.password) {
              accountPages.set(account.id, acctPage);
              try {
                loggedIn = await loginToQwen(account.id, account.email, account.password);
              } finally {
                accountPages.delete(account.id);
              }
            }
          }
        } catch {
          loggedIn = false;
        }
      }

      return loggedIn;
    } finally {
      // Always close browser after validation
      await closePlaywrightContextBestEffort(account.id, acctContext);
      cleanupPlaywrightAccountState(account.id);
    }
  } finally {
    release();
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function loginToQwen(
  accountId: string,
  email: string,
  password: string,
): Promise<boolean> {
  const page = accountPages.get(accountId);
  if (!page) return false;

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Try API login first
    const apiResult = await loginViaApi(page, email, password);
    if (apiResult) {
      return true;
    }

    // Fallback to UI login
    const uiResult = await loginViaUi(page, email, password);
    if (uiResult) {
      return true;
    }

    if (attempt < maxAttempts) {
      const backoffMs = attempt * 5_000;
      console.warn(
        `⚠️  [Playwright] Login attempt ${attempt}/${maxAttempts} failed for ${maskEmail(email)}, retrying in ${backoffMs / 1000}s`,
      );
      await sleep(backoffMs);
    }
  }

  console.error(
    `❌ [Playwright] All login methods failed for ${maskEmail(email)}`,
  );
  return false;
}

async function loginViaApi(
  page: Page,
  email: string,
  password: string,
): Promise<boolean> {
  try {
    await page.goto(qwenUrl("/auth"), {
      waitUntil: "domcontentloaded",
      timeout: config.timeouts.navigation,
    });
    await sleep(2000);

    // Check if already logged in
    if (!page.url().includes("/auth")) {
      return true;
    }

    const hashedPassword = crypto
      .createHash("sha256")
      .update(password)
      .digest("hex");
    const signinUrl = qwenUrl("/api/v2/auths/signin");

    const result = await page.evaluate(
      async ({ email, password, signinUrl }) => {
        try {
          const response = await fetch(signinUrl,
            {
              method: "POST",
              signal: AbortSignal.timeout(10_000),
              headers: {
                accept: "application/json, text/plain, */*",
                "content-type": "application/json",
                source: "web",
                timezone: new Date().toString().split(" (")[0],
                "x-request-id": crypto.randomUUID(),
              },
              body: JSON.stringify({ email, password, login_type: "email" }),
            },
          );
          const data = await response.json();
          return { ok: response.ok, data };
        } catch (e: any) {
          return { ok: false, error: e.message };
        }
      },
      { email, password: hashedPassword, signinUrl },
    );

    if (result.ok) {
      await page.goto(qwenUrl("/"), {
        waitUntil: "domcontentloaded",
        timeout: config.timeouts.navigation,
      });
      return !page.url().includes("auth") && !page.url().includes("login");
    }

    return false;
  } catch (err) {
    console.warn(`⚠️  [Playwright] API login error: ${err}`);
    return false;
  }
}

async function loginViaUi(
  page: Page,
  email: string,
  password: string,
): Promise<boolean> {
  try {
    await page.goto(qwenUrl("/auth"), {
      waitUntil: "domcontentloaded",
      timeout: config.timeouts.navigation,
    });
    await sleep(2000);

    // Check if already logged in
    if (!page.url().includes("/auth")) {
      return true;
    }

    // Wait for email input
    const emailSelector = [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="Email" i]',
      'input[placeholder*="email" i]',
    ].join(", ");
    try {
      await page.waitForSelector(emailSelector, {
        timeout: config.timeouts.page,
      });
    } catch {
      if (!page.url().includes("/auth")) return true;
      console.warn(
        `⚠️  [Playwright] Email input not found on ${page.url()} (possible captcha or anti-bot challenge)`,
      );
      throw new Error("Email input not found");
    }

    // Fill email
    await page.fill(emailSelector, email);

    // The password field may already be visible (single-step form) or only
    // appear after submitting the email (two-step flow).
    const passwordSelector =
      'input[type="password"], input[name="password"]';
    const passwordAlreadyVisible = await page
      .locator(passwordSelector)
      .first()
      .isVisible()
      .catch(() => false);

    if (!passwordAlreadyVisible) {
      await page.keyboard.press("Enter");
      await page.waitForSelector(passwordSelector, {
        timeout: config.timeouts.page,
      });
    }
    await sleep(500);

    // Fill password
    await page.fill(passwordSelector, password);

    // Prefer clicking the submit button; fall back to pressing Enter.
    // The button starts disabled and only enables once both fields are filled.
    const submitSelector =
      'button[type="submit"].qwenchat-auth-pc-submit-button, button[type="submit"]';
    const submitButton = page.locator(submitSelector).first();
    try {
      await page.waitForSelector('button[type="submit"]:not([disabled])', {
        timeout: 5_000,
      });
      await submitButton.click();
    } catch {
      await page.keyboard.press("Enter");
    }
    await sleep(3000);

    // Check if login was successful
    const isLoggedIn =
      !page.url().includes("auth") && !page.url().includes("login");

    if (isLoggedIn) {
      await page.goto(qwenUrl("/"), {
        waitUntil: "domcontentloaded",
        timeout: config.timeouts.navigation,
      });
    }

    return isLoggedIn;
  } catch (err) {
    console.warn(`⚠️  [Playwright] UI login error: ${err}`);
    return false;
  }
}

// ─── Header Capture ───────────────────────────────────────────────────────────

/**
 * Capture a complete anti-fraud header set from a browser completion request.
 * The optional page and timeout make the capture path independently testable
 * without starting a real browser.
 */
export async function captureQwenHeaders(
  accountId: string,
  pageOverride?: Page,
  timeoutMs = config.timeouts.headers,
  triggerGraceMs = HEADER_CAPTURE_TRIGGER_GRACE_MS,
): Promise<void> {
  const page = pageOverride ?? accountPages.get(accountId);
  if (!page || page.isClosed()) {
    throw new Error(`Playwright page unavailable for header capture: ${accountId}`);
  }

  touchAccountActivity(accountId);
  const cache = getHeaderCache(accountId);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let routeRegistered = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let routeHandler: (route: any, request: any) => Promise<void>;
    let sawIncompleteHeaders = false;
    let headersCaptured = false;
    let retriggerRequested = false;
    let lastAttemptGraceTimedOut = false;
    let graceTimeoutCount = 0;
    let wakeTriggerLoop: (() => void) | undefined;
    const deadline = Date.now() + timeoutMs;
    const remainingBudgetMs = () => deadline - Date.now();

    const cleanupRoute = () => {
      if (!routeRegistered) return;
      void page
        .unroute("**/api/v2/chat/completions*", routeHandler)
        .catch(() => {});
    };

    const wakeTrigger = () => {
      const wake = wakeTriggerLoop;
      wakeTriggerLoop = undefined;
      wake?.();
    };

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      cleanupRoute();
      // A trigger loop parked between attempts has to be released, otherwise it
      // stays pending forever behind an already-settled capture.
      wakeTrigger();
      // When a trigger grace period expired (page fired no completion request),
      // log the OUTCOME so the operator can see whether the retry loop
      // recovered or the account is being rotated into cooldown — the bare
      // per-attempt warning leaves that dangling.
      if (graceTimeoutCount > 0) {
        if (headersCaptured) {
          console.log(
            `✅ [Playwright] Header capture recovered for ${accountId} after ${graceTimeoutCount} silent send(s)`,
          );
        } else {
          console.warn(
            `❌ [Playwright] Header capture failed for ${accountId} after ${graceTimeoutCount} silent send(s): ${error?.message ?? "no completion request"}`,
          );
        }
      }
      if (error) reject(error);
      else resolve();
    };

    const incompleteHeadersError = () =>
      new Error(
        `Header capture returned incomplete anti-fraud headers for ${accountId}`,
      );

    /**
     * Once a request has been intercepted without bx headers, that is the
     * diagnosis worth reporting: whatever ran out afterwards (budget, a failed
     * re-trigger) is only how the capture ran out of road. The wording is also
     * what the retry policy maps to an account-init cooldown.
     */
    const captureFailure = (fallback: Error) =>
      sawIncompleteHeaders ? incompleteHeadersError() : fallback;

    const armOverallDeadline = () => {
      if (settled) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(
        () => {
          console.warn(`⏱️  [Playwright] Header capture timeout for ${accountId}`);
          settle(
            captureFailure(new Error(`Header capture timed out for ${accountId}`)),
          );
        },
        Math.max(1, remainingBudgetMs()),
      );
    };

    // The send either produces the completion request within a second or two,
    // or the UI is blocked and never will. Waiting out the whole header budget
    // past this point only stalls the caller and, during account init, buys a
    // five-minute cooldown for nothing.
    const armTriggerGrace = (attempt: number) => {
      // A capture that already landed is only waiting out its settle delay, so
      // the send that produced it must not arm a deadline against it.
      if (settled || headersCaptured) return;
      if (timeout) clearTimeout(timeout);
      // The FIRST send types into a page whose bx SDK may not have computed its
      // tokens yet — a cold page almost never produces a request from the first
      // send, so waiting out the full 15s grace is pure stall. Fail it fast and
      // let the retry loop reload + re-send (warm SDK) instead. Never exceed the
      // caller-provided grace (tests inject tiny windows and expect them held).
      const firstSendGraceMs = Math.min(FIRST_TRIGGER_GRACE_MS, triggerGraceMs);
      timeout = setTimeout(
        () => {
          graceTimeoutCount++;
          console.warn(
            `⏱️  [Playwright] Header capture produced no completion request for ${accountId} (attempt ${graceTimeoutCount})`,
          );
          // The page is likely blocked by WAF/captcha or in a broken state.
          // Instead of settling immediately, trigger a retry with a page
          // reload so the next attempt starts from a fresh state.
          lastAttemptGraceTimedOut = true;
          retriggerRequested = true;
          wakeTrigger();
        },
        Math.max(
          1,
          Math.min(
            remainingBudgetMs(),
            attempt === 1 ? firstSendGraceMs : triggerGraceMs,
          ),
        ),
      );
    };

    routeHandler = async (route: any, request: any) => {
      if (settled) {
        // A route installed immediately before timeout must not poison future
        // browser traffic after the capture operation has completed.
        await route.continue().catch(() => {});
        return;
      }

      const reqHeaders = request.headers();
      // Capture the REAL browser request headers — including version and the
      // client-hint fingerprint — so the Node paths reuse exactly what the live
      // browser sends (anti-hardcoded: no stale Chrome/version literals).
      const capturedHeaders: Record<string, string> = {
        cookie: reqHeaders["cookie"] || "",
        "bx-ua": reqHeaders["bx-ua"] || "",
        "bx-umidtoken": reqHeaders["bx-umidtoken"] || "",
        "bx-v": reqHeaders["bx-v"] || "2.5.37",
        "user-agent": reqHeaders["user-agent"] || "",
        "x-request-id": reqHeaders["x-request-id"] || "",
        "version": reqHeaders["version"] || "",
        "sec-ch-ua": reqHeaders["sec-ch-ua"] || "",
        "sec-ch-ua-mobile": reqHeaders["sec-ch-ua-mobile"] || "?0",
        "sec-ch-ua-platform": reqHeaders["sec-ch-ua-platform"] || "",
      };

      // Extract chat_id and parent_id from POST body for session coherence
      try {
        const postData = typeof request.postData === "function" ? request.postData() : null;
        if (postData) {
          const payload = JSON.parse(postData);
          if (payload.chat_id) capturedHeaders["x-chat-id"] = payload.chat_id;
          if (payload.parent_id !== undefined)
            capturedHeaders["x-parent-id"] = payload.parent_id || "";
        }
      } catch {
        // Ignore parse errors or missing postData
      }

      if (!hasRequiredQwenHeaders(capturedHeaders)) {
        // Not evidence the page is broken: the SDK also fires completions
        // before it has computed its token. The request still must never reach
        // Qwen, but the capture keeps its route and spends another send —
        // failing here would throw away a budget that is still nearly full.
        sawIncompleteHeaders = true;
        await route.abort("aborted").catch(() => {});
        // Aborting kills the UI's send, so nothing will re-fire on its own.
        retriggerRequested = true;
        wakeTrigger();
        return;
      }

      headersCaptured = true;
      if (timeout) clearTimeout(timeout);
      cache.headers = capturedHeaders;
      cache.lastRefresh = Date.now();
      // The account now has a valid anti-bot header set — the rotation gate
      // (account-manager `markAccountHeadersReady`) may route requests to it.
      markAccountHeadersReady(accountId);
      // Header interception can set challenge/session cookies, so do not reuse
      // a cookie snapshot taken before this browser request.
      cookieCaches.delete(accountId);
      touchAccountActivity(accountId);

      await route.abort("aborted").catch(() => {});
      await sleep(HEADER_CAPTURE_SETTLE_MS);
      settle();
    };

    // Navigate to the stable chat page. Only the first attempt pays for this:
    // a re-trigger types into the page that is already loaded, and reloading
    // would throw away the bx SDK state that just finished warming up.
    const openChatPage = async () => {
      if (settled || page.isClosed()) return;
      await page.goto(qwenUrl("/"), {
        waitUntil: "domcontentloaded",
        timeout: Math.min(config.timeouts.navigation, timeoutMs),
      });
      if (settled || page.isClosed()) return;
      await sleep(2000);
    };

    /** Type the probe message and send it, then wait out the grace window. */
    const triggerSend = async (attempt: number) => {
      if (settled || page.isClosed()) return;
      await clearVisibleChallenge(page);
      if (settled || page.isClosed()) return;

      // Session-expiry fast path: if the page landed on the auth/login screen
      // (redirection after a dead session), typing into the chat input would
      // burn every trigger attempt on a textarea that does not exist. Re-login
      // immediately when credentials are available; otherwise fail fast with a
      // clear diagnosis instead of 3 pointless grace timeouts.
      const currentUrl = page.url();
      if (currentUrl.includes("/auth") || currentUrl.includes("/login")) {
        const { getAccountCredentials } = await import("../core/accounts.ts");
        const creds = getAccountCredentials(accountId);
        if (creds && creds.email && creds.password) {
          console.warn(
            `⚠️  [Playwright] Session expired during header capture for ${accountId}; re-authenticating...`,
          );
          const ok = await loginToQwen(accountId, creds.email, creds.password);
          if (!ok) {
            settle(
              new Error(
                `Header capture failed for ${accountId}: re-login after session expiry did not succeed`,
              ),
            );
            return;
          }
          // Re-login navigated away; reload the chat page so the send below
          // types into a live chat input (never leave the loop parked).
          await openChatPage();
          if (settled || page.isClosed()) return;
        } else {
          settle(
            new Error(
              `Header capture failed for ${accountId}: session expired and no credentials available for re-login`,
            ),
          );
          return;
        }
      }

      if (settled || page.isClosed()) return;

      // Prefer the Qwen-specific input selector first (stable against the DOM
      // picking a sibling textarea/contenteditable), then fall back to generic.
      // Mirrors upstream 5b3fd3e (robust account header capture).
      const inputSelector =
        'textarea.message-input-textarea:visible, textarea:visible, [contenteditable="true"]:visible';
      await page.focus(inputSelector);
      if (settled || page.isClosed()) return;
      await page.fill(inputSelector, "");
      if (settled || page.isClosed()) return;
      await page.type(inputSelector, "a", { delay: 100 });
      if (settled || page.isClosed()) return;
      await sleep(2000);
      if (settled || page.isClosed()) return;

      const sendSelectors = [
        ".message-input-right-button-send .send-button",
        ".chat-prompt-send-button",
        "button.send-button",
      ];

      let clicked = false;
      for (const selector of sendSelectors) {
        if (settled || page.isClosed()) return;
        try {
          const btn = await page.$(selector);
          if (btn && (await btn.isVisible())) {
            await page.evaluate((sel) => {
              const element = document.querySelector(sel) as HTMLElement;
              if (element) {
                element.focus();
                element.click();
              }
            }, selector);
            if (!settled && !page.isClosed()) {
              await btn.click({ force: true, delay: 50 }).catch(() => {});
            }
            clicked = true;
            break;
          }
        } catch {
          // Try the next selector.
        }
      }

      if (!clicked && !settled && !page.isClosed()) {
        await page.keyboard.press("Enter");
      }

      armTriggerGrace(attempt);
    };

    /** Park until the interception asks for another send, or the capture ends. */
    const waitForRetrigger = () =>
      new Promise<void>((wake) => {
        if (settled || retriggerRequested) {
          wake();
          return;
        }
        wakeTriggerLoop = wake;
      });

    const runTriggerLoop = async () => {
      for (
        let attempt = 1;
        attempt <= HEADER_CAPTURE_TRIGGER_ATTEMPTS;
        attempt++
      ) {
        retriggerRequested = false;
        // Driving a send is not the grace window: restore the overall budget
        // so the previous attempt's grace timer cannot expire mid-typing.
        armOverallDeadline();

        try {
          // Navigate on the first attempt, or reload when attempt 2+ produced
          // no request (indicating a stuck page/challenge that needs a fresh load).
          // Attempt 2 preserves the page from attempt 1 so the bx SDK that just
          // finished initializing in the background is not thrown away.
          if (attempt === 1 || (lastAttemptGraceTimedOut && attempt >= 3)) {
            lastAttemptGraceTimedOut = false;
            await openChatPage();
          }
          if (settled) return;
          await triggerSend(attempt);
        } catch (error) {
          console.warn(
            `❌ [Playwright] Error triggering header capture for ${accountId}: ${getErrorMessage(error)}`,
          );
          settle(
            captureFailure(
              error instanceof Error
                ? error
                : new Error(`Header capture failed for ${accountId}`),
            ),
          );
          return;
        }

        if (settled) return;
        await waitForRetrigger();
        if (settled) return;
        if (remainingBudgetMs() <= 0) break;
      }

      // Distinguish between "requests fired but lacked bx headers" and "no
      // request fired at all" so the caller gets an actionable diagnosis.
      settle(
        sawIncompleteHeaders
          ? incompleteHeadersError()
          : new Error(`Header capture timed out for ${accountId}`),
      );
    };

    armOverallDeadline();

    void page
      .route("**/api/v2/chat/completions*", routeHandler)
      .then(async () => {
        routeRegistered = true;
        if (settled) {
          cleanupRoute();
          return;
        }

        await runTriggerLoop();
      })
      .catch((error) => {
        console.warn(
          `[Playwright] Error registering header capture route: ${getErrorMessage(error)}`,
        );
        settle(
          error instanceof Error
            ? error
            : new Error(`Header capture route registration failed for ${accountId}`),
        );
      });
  });
}

type CookieSnapshot = Awaited<ReturnType<BrowserContext["cookies"]>>;

/**
 * Fetch the account context cookies once. The snapshot feeds every validity
 * check and the cookie string build, avoiding repeated CDP round-trips.
 */
async function getCookieSnapshot(
  accountId: string,
): Promise<CookieSnapshot | null> {
  const context = accountContexts.get(accountId);
  if (!context) return null;

  try {
    return await withTimeout(
      context.cookies(),
      config.timeouts.page,
      `Cookie snapshot timed out for ${accountId}`,
    );
  } catch {
    return null;
  }
}

/**
 * Check if the auth token cookie is still valid.
 * Used to skip unnecessary header recaptures when the token is still fresh.
 * Returns true if the token cookie exists and is not expired.
 */
function isAuthTokenValidFrom(cookies: CookieSnapshot): boolean {
  const tokenCookie = cookies.find(
    (c) =>
      c.name === "token" && (c.domain === ".qwen.ai" || c.domain === "qwen.ai"),
  );

  if (!tokenCookie) return false;

  // Session cookie (expires = -1) is valid as long as browser is open
  if (tokenCookie.expires === -1) return true;

  // Check if expired (with 5-min safety margin)
  const expiresAt = tokenCookie.expires * 1000;
  return expiresAt > Date.now() + 5 * 60 * 1000;
}

/**
 * Check if the shortest-lived cookie (acw_tc) is still valid.
 * This is the 24-min cookie that gates some requests.
 */
function isShortestCookieValidFrom(cookies: CookieSnapshot): boolean {
  const acwCookie = cookies.find(
    (c) => c.name === "acw_tc" && c.domain.includes("qwen.ai"),
  );

  if (!acwCookie) return true; // If missing, assume OK (will be refreshed by browser)

  if (acwCookie.expires === -1) return true;

  const expiresAt = acwCookie.expires * 1000;
  return expiresAt > Date.now() + 60 * 1000; // 1-min safety margin
}

async function refreshHeadersInternal(
  accountId: string,
  timeoutMs = config.timeouts.headers,
): Promise<void> {
  const cache = getHeaderCache(accountId);
  if (cache.refreshInProgress) return;

  touchAccountActivity(accountId);
  cache.refreshInProgress = true;
  const boundedTimeoutMs = Math.max(1_000, timeoutMs);
  try {
    // Check if session is expired before capturing headers
    const page = accountPages.get(accountId);
    if (page) {
      try {
        await page.goto(qwenUrl("/"), {
          waitUntil: "domcontentloaded",
          timeout: Math.min(
            config.timeouts.navigation,
            boundedTimeoutMs,
            SESSION_PROBE_NAVIGATION_TIMEOUT_MS,
          ),
        });
        const url = page.url();
        if (url.includes("auth") || url.includes("login")) {
          console.warn(
            `⚠️  [Playwright] Session expired during refresh for ${accountId}, re-authenticating...`,
          );
          const { getAccountCredentials } = await import("../core/accounts.ts");
          const creds = getAccountCredentials(accountId);
          if (creds && creds.email && creds.password) {
            await loginToQwen(accountId, creds.email, creds.password);
            // Invalidate cookie cache after re-login
            cookieCaches.delete(accountId);
          } else {
            console.warn(
              `[Playwright] No credentials available for re-login of ${accountId}`,
            );
          }
        }
      } catch (navErr) {
        console.warn(
          `[Playwright] Navigation check failed during refresh for ${accountId}:`,
          (navErr as Error).message,
        );
      }
    }

    await captureQwenHeaders(accountId, undefined, boundedTimeoutMs);

    // Best-effort restore: header capture can leave the tab on a chat page.
    const capturedPage = accountPages.get(accountId);
    if (capturedPage && !capturedPage.isClosed()) {
      try {
        const currentUrl = new URL(capturedPage.url());
        if (currentUrl.origin !== qwenOrigin() || currentUrl.pathname !== "/") {
          await capturedPage.goto(qwenUrl("/"), {
            waitUntil: "domcontentloaded",
            timeout: Math.min(config.timeouts.navigation, boundedTimeoutMs),
          });
        }
      } catch {
        // Non-fatal: the next normal operation will navigate back.
      }
    }
  } finally {
    touchAccountActivity(accountId);
    cache.refreshInProgress = false;
  }
}

export async function refreshHeaders(
  accountId: string,
  timeoutMs = config.timeouts.headers,
): Promise<void> {
  const boundedTimeoutMs = Math.max(1_000, timeoutMs);
  const release = await acquireAccountMutex(
    accountId,
    `refresh:${accountId.substring(0, 12)}`,
    boundedTimeoutMs,
  );
  try {
    await refreshHeadersInternal(accountId, timeoutMs);
  } finally {
    release();
  }
}

/**
 * Run work against the account Playwright page under the per-account mutex.
 * Used by captcha recovery so it cannot race header capture / login.
 */
export async function withAccountPage<T>(
  accountId: string,
  fn: (page: Page) => Promise<T>,
  timeoutMs = ACCOUNT_PAGE_OPERATION_TIMEOUT_MS,
  mutexTimeoutMs = PLAYWRIGHT_MUTEX_WAIT_MS,
  recoverOnTimeout = true,
): Promise<T> {
  const page = accountPages.get(accountId);
  if (!page || page.isClosed()) {
    throw new Error(`Playwright page unavailable for account: ${accountId}`);
  }
  const release = await acquireAccountMutex(
    accountId,
    `page:${accountId.substring(0, 12)}`,
    Math.max(1_000, mutexTimeoutMs),
    recoverOnTimeout,
  );
  try {
    touchAccountActivity(accountId);
    try {
      const result = await withTimeout(
        fn(page),
        Math.max(1_000, timeoutMs),
        `Playwright page operation timed out for ${accountId} after ${Math.max(1_000, timeoutMs)}ms`,
      );
      touchAccountActivity(accountId);
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.includes("Playwright page operation timed out")) {
        console.warn(
          `⏱️  [Playwright] Resetting account context after a stuck page operation: ${accountId}`,
        );
        const context = accountContexts.get(accountId);
        if (context) {
          await closePlaywrightContextBestEffort(accountId, context);
        }
        cleanupPlaywrightAccountState(accountId);
      }
      throw error;
    }
  } finally {
    release();
  }
}

function isPlaywrightProfileCorruptedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Browser has been closed") ||
    message.includes("Target closed") ||
    message.includes("Session closed") ||
    message.includes("Connection closed")
  );
}

async function resetPlaywrightProfileLocked(accountId: string): Promise<void> {
  await closePlaywrightForAccountLocked(accountId);
  const profilePath = path.resolve("data", "qwen_profiles", accountId);
  removePlaywrightProfile(profilePath);
}

/**
 * Best-effort removal of a Playwright profile directory.
 *
 * On Windows, `fs.rmSync` can fail with EPERM/EBUSY/Permission denied because
 * the browser process still holds a file lock on the directory. Instead of
 * letting that failure abort the profile-reset/re-init cycle (which used to
 * cascade into a 45s re-init timeout + 300s account cooldown), the locked
 * directory is renamed to a `.stale-*` sibling so a fresh profile can be
 * created on the next init. Never throws.
 *
 * @param rmSyncOverride test hook: replaces `fs.rmSync` to simulate a lock.
 */
export function removePlaywrightProfile(
  profilePath: string,
  rmSyncOverride?: (path: string, opts: { recursive: boolean; force: boolean }) => void,
): void {
  const doRemove =
    rmSyncOverride ??
    ((p: string, opts: { recursive: boolean; force: boolean }) =>
      fs.rmSync(p, opts));
  try {
    doRemove(profilePath, { recursive: true, force: true });
  } catch (error) {
    if (isPlaywrightProfileCorruptedError(error)) return;
    // EPERM / EBUSY: the OS still holds a file lock (Windows). Rename the
    // locked directory out of the way so re-init can create a fresh profile.
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    if (
      message.includes("EPERM") ||
      message.includes("EBUSY") ||
      message.includes("Permission denied")
    ) {
      try {
        const stalePath = `${profilePath}.stale-${Date.now()}`;
        fs.renameSync(profilePath, stalePath);
      } catch {
        // Best effort: re-init will either reuse or fail cleanly.
      }
      return;
    }
    console.warn(
      `[Playwright] Failed to delete profile at ${profilePath}:`,
      getErrorMessage(error),
    );
  }
}

/**
 * Safely prunes transient cache directories (V8 Code Cache, HTTP disk cache,
 * GPU shader cache) from a Playwright Chromium profile directory.
 *
 * Preserves 100% of session and authentication state:
 * - Cookies, Local Storage, IndexedDB, Preferences, Network state.
 *
 * Never throws.
 */
export function prunePlaywrightProfileCaches(profilePath: string): {
  freedBytes: number;
  freedFiles: number;
} {
  const transientDirNames = [
    "Code Cache",
    "Cache",
    "GPUCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
  ];

  let freedBytes = 0;
  let freedFiles = 0;

  try {
    const defaultDir = path.join(profilePath, "Default");
    if (!fs.existsSync(defaultDir)) {
      return { freedBytes, freedFiles };
    }

    for (const dirName of transientDirNames) {
      const targetDir = path.join(defaultDir, dirName);
      if (fs.existsSync(targetDir)) {
        try {
          const countAndRemove = (d: string) => {
            try {
              const entries = fs.readdirSync(d, { withFileTypes: true });
              for (const e of entries) {
                const full = path.join(d, e.name);
                if (e.isDirectory()) {
                  countAndRemove(full);
                } else if (e.isFile()) {
                  try {
                    freedBytes += fs.statSync(full).size;
                    freedFiles++;
                  } catch {}
                }
              }
            } catch {}
          };
          countAndRemove(targetDir);
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {
          // Best-effort: file lock might still linger temporarily
        }
      }
    }
  } catch {
    // Best-effort
  }

  return { freedBytes, freedFiles };
}

/**
 * Prunes transient caches across all profile directories in data/qwen_profiles.
 */
export function pruneAllPlaywrightProfiles(baseDir = path.resolve("data", "qwen_profiles")): {
  totalFreedBytes: number;
  totalFreedFiles: number;
  profilesCleaned: number;
} {
  let totalFreedBytes = 0;
  let totalFreedFiles = 0;
  let profilesCleaned = 0;

  try {
    if (!fs.existsSync(baseDir)) {
      return { totalFreedBytes, totalFreedFiles, profilesCleaned };
    }

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const profilePath = path.join(baseDir, entry.name);
        const { freedBytes, freedFiles } = prunePlaywrightProfileCaches(profilePath);
        if (freedFiles > 0) {
          totalFreedBytes += freedBytes;
          totalFreedFiles += freedFiles;
          profilesCleaned++;
        }
      }
    }
  } catch {}

  return { totalFreedBytes, totalFreedFiles, profilesCleaned };
}

const PROFILE_RESET_TIMEOUT_MS = Math.max(90_000, config.timeouts.headers);

export async function refreshHeadersWithProfileReset(
  accountId: string,
): Promise<void> {
  let account: QwenAccount | null = null;

  const release = await acquireAccountMutex(
    accountId,
    `profile-reset:${accountId.substring(0, 12)}`,
  );
  try {
    await resetPlaywrightProfileLocked(accountId);
    const accounts = await import("../core/accounts.ts");
    account = accounts.getAccountCredentials(accountId) ?? null;
    if (!account) {
      throw new Error(`Account ${accountId} not found during profile reset`);
    }
  } finally {
    release();
  }

  await withTimeout(
    initPlaywrightForAccount(account),
    PROFILE_RESET_TIMEOUT_MS,
    `Playwright re-initialization timed out after ${PROFILE_RESET_TIMEOUT_MS}ms`,
  ).catch(async (error) => {
    await closePlaywrightForAccount(accountId).catch(() => {});
    throw error;
  });
}

export function schedulePlaywrightProfileReset(accountId: string): void {
  if (closingAllPlaywright || profileResetQueue.has(accountId)) return;

  const resetPromise = profileResetChain
    .catch(() => {})
    .then(async () => {
      if (closingAllPlaywright) return;
      await refreshHeadersWithProfileReset(accountId);
    })
    .catch((error) => {
      console.warn(
        `[Playwright] Queued profile reset failed for ${accountId}: ${getErrorMessage(error)}`,
      );
    })
    .finally(() => {
      profileResetQueue.delete(accountId);
    });

  profileResetQueue.set(accountId, resetPromise);
  profileResetChain = resetPromise.then(
    () => undefined,
    () => undefined,
  );
}

// ─── Keep Alive ───────────────────────────────────────────────────────────────

export function getActivePlaywrightAccountIds(): string[] {
  return Array.from(accountPages.keys());
}

export function getIdlePlaywrightAccountIds(idleMs: number): string[] {
  const now = Date.now();
  return Array.from(accountPages.keys()).filter((accountId) => {
    if (isAccountServingStream(accountId)) return false;
    const mutex = accountMutexes.get(accountId);
    if (!mutex?.isIdle()) return false;
    const lastActivity = lastAccountActivity.get(accountId) ?? 0;
    return now - lastActivity >= idleMs;
  });
}

/**
 * Order context-eviction candidates so the MOST valuable contexts survive.
 * Pure ordering: unranked accounts first, then ranked accounts from LOWEST to
 * HIGHEST priority, then oldest activity. The priority file is kept in
 * "most recently successful first" order (markAccountSuccessful moves the
 * account to the top), so the accounts actually being used stay warm instead
 * of the last-created ones from the warmup (which previously made the FIRST
 * used account pay a ~12s context recreation).
 */
export function orderContextsForEviction(
  accountIds: string[],
  priorityRank: (id: string) => number | undefined,
  activity: (id: string) => number,
): string[] {
  return [...accountIds].sort((a, b) => {
    const rankA = priorityRank(a) ?? Number.MAX_SAFE_INTEGER;
    const rankB = priorityRank(b) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankB - rankA; // lowest priority first
    return (activity(a) ?? 0) - (activity(b) ?? 0); // oldest activity first
  });
}

function priorityOrderForEviction(accountIds: string[]): string[] {
  const ranked = getAccountsByPriority(accountIds.map((id) => ({ id })));
  const rank = new Map<string, number>();
  for (const [index, account] of ranked.entries()) {
    rank.set(account.id, index);
  }
  return orderContextsForEviction(
    accountIds,
    (id) => rank.get(id),
    (id) => lastAccountActivity.get(id) ?? 0,
  );
}

export async function closeIdlePlaywrightAccounts(
  idleMs: number,
): Promise<number> {
  if (idleMs <= 0) return 0;

  const maxActiveContexts = config.playwright.maxActiveContexts;

  // With an active-context limit, preserve at least that many warm contexts
  // so one account remains ready for immediate use.
  if (maxActiveContexts > 0 && accountPages.size <= maxActiveContexts) {
    return 0;
  }

  const candidates = priorityOrderForEviction(
    getIdlePlaywrightAccountIds(idleMs),
  ).map((accountId) => ({
    accountId,
    lastActivity: lastAccountActivity.get(accountId) ?? 0,
  }));

  let closed = 0;
  for (const candidate of candidates) {
    if (maxActiveContexts > 0 && accountPages.size <= maxActiveContexts) {
      break;
    }

    // Re-checked per account: closing the previous one is awaited, and a
    // request can have claimed this account in the meantime.
    if (isAccountServingStream(candidate.accountId)) continue;

    const mutex = accountMutexes.get(candidate.accountId);
    if (!mutex?.isIdle()) continue;

    await closePlaywrightForAccount(candidate.accountId).catch((error) => {
      console.warn(
        `[Playwright] Failed to close idle context for ${candidate.accountId}: ${getErrorMessage(error)}`,
      );
    });
    closed++;
  }
  return closed;
}

/**
 * Close idle browser contexts until the number of active contexts is within
 * PLAYWRIGHT_MAX_ACTIVE_CONTEXTS. Never closes a context whose account mutex
 * is busy, so active streams are preserved.
 */
export async function evictIdlePlaywrightContextsToLimit(): Promise<number> {
  const max = config.playwright.maxActiveContexts;
  if (max <= 0) return 0;
  if (accountPages.size <= max) return 0;

  const candidates = priorityOrderForEviction(
    Array.from(accountPages.keys()).filter((accountId) => {
      const mutex = accountMutexes.get(accountId);
      return mutex?.isIdle() && !isAccountServingStream(accountId);
    }),
  ).map((accountId) => ({
    accountId,
    mutex: accountMutexes.get(accountId),
    lastActivity: lastAccountActivity.get(accountId) ?? 0,
  }));

  let closed = 0;
  for (const candidate of candidates) {
    if (accountPages.size <= max) break;
    if (isAccountServingStream(candidate.accountId)) continue;
    const mutex = accountMutexes.get(candidate.accountId);
    if (!mutex?.isIdle()) continue;

    await closePlaywrightForAccount(candidate.accountId).catch((error) => {
      console.warn(
        `[Playwright] Failed to evict idle context for ${candidate.accountId}: ${getErrorMessage(error)}`,
      );
    });
    closed++;
  }

  return closed;
}

export async function keepAlivePlaywrightAccount(
  accountId: string,
): Promise<boolean> {
  // The keep-alive navigates the same page the renderer is streaming from, so
  // a mid-flight account must be skipped for the same reason it must not be
  // closed: the free mutex does not mean the page is free.
  if (isAccountServingStream(accountId)) return false;

  const mutex = accountMutexes.get(accountId);
  if (!mutex?.isIdle()) return false;

  const lastActivity = lastAccountActivity.get(accountId) ?? 0;
  if (Date.now() - lastActivity < config.sessionKeeper.idleMs) return false;

  const release = await mutex
    .acquire(2_000, `keepalive:${accountId.substring(0, 12)}`)
    .catch(() => null);
  if (!release) return false;

  try {
    const page = accountPages.get(accountId);
    if (!page || page.isClosed()) return false;

    const now = Date.now();
    const currentUrl = page.url();
    const lastNavigation = lastKeepAliveNavigation.get(accountId) ?? 0;
    const shouldNavigate =
      !currentUrl.startsWith(qwenOrigin()) ||
      now - lastNavigation > config.sessionKeeper.navigationIntervalMs;

    if (shouldNavigate) {
      await page.goto(qwenUrl("/"), {
        waitUntil: "domcontentloaded",
        timeout: Math.min(config.timeouts.navigation, 15_000),
      });
      lastKeepAliveNavigation.set(accountId, now);
    } else {
      await subtlePageActivity(page);
    }

    touchAccountActivity(accountId);
    return true;
  } finally {
    release();
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * A renderer crash ("page.evaluate: Target crashed") or browser death leaves
 * a zombie account entry: page.isClosed() can stay false while every page
 * operation fails, so the account would keep failing until something else
 * clears the maps. Forget the state (and best-effort close) on death so the
 * next use re-initializes cleanly — the same proven path as an evicted context.
 */
export function installContextDeathHandlers(
  accountId: string,
  context: BrowserContext,
  page: Page,
): void {
  const onDeath = (): void => {
    cleanupPlaywrightAccountState(accountId);
    void closePlaywrightContextBestEffort(accountId, context).catch(() => {});
  };
  context.on("close", onDeath);
  page.on("crash", onDeath);
}

function cleanupPlaywrightAccountState(accountId: string): void {
  accountContexts.delete(accountId);
  accountPages.delete(accountId);
  headerCaches.delete(accountId);
  cookieCaches.delete(accountId);
  lastAccountActivity.delete(accountId);
  lastKeepAliveNavigation.delete(accountId);
  clearFingerprintCache(accountId);
  // The account's context died/closed — its captured headers are stale or the
  // page is gone, so it must not be selected by the rotation gate until a
  // fresh capture succeeds again.
  unmarkAccountHeadersReady(accountId);
}

async function closePlaywrightContextBestEffort(
  accountId: string,
  context: BrowserContext,
): Promise<void> {
  const browserProcess = getBrowserProcess(context);

  try {
    const pages = context.pages();
    await Promise.all(
      pages.map((page) =>
        withTimeout(
          page.close({ runBeforeUnload: false }),
          2_000,
          `Timed out closing page for ${accountId}`,
        ).catch(() => {}),
      ),
    );

    await withTimeout(
      context.close(),
      config.playwright.contextCloseTimeoutMs,
      `Timed out closing Playwright context for ${accountId}`,
    );
  } catch (error) {
    if (!isPlaywrightAlreadyClosedError(error)) {
      console.warn(
        `[Playwright] Failed to close context for ${accountId}: ${getErrorMessage(error)}`,
      );
    }

    if (browserProcess && !browserProcess.killed) {
      try {
        browserProcess.kill("SIGKILL");
        console.warn(
          `[Playwright] Killed lingering browser process for ${accountId}`,
        );
      } catch (killError) {
        console.warn(
          `[Playwright] Failed to kill browser process for ${accountId}: ${getErrorMessage(killError)}`,
        );
      }
    }
  }
}

async function closePlaywrightForAccountLocked(
  accountId: string,
): Promise<void> {
  const acctContext = accountContexts.get(accountId);
  try {
    if (acctContext) {
      await closePlaywrightContextBestEffort(accountId, acctContext);
    }
  } finally {
    cleanupPlaywrightAccountState(accountId);
    try {
      const profilePath = path.resolve("data", "qwen_profiles", accountId);
      prunePlaywrightProfileCaches(profilePath);
    } catch {}
  }
}

/**
 * True for Playwright rejections that mean "the page/context/browser was
 * closed underneath the operation" — benign races against shutdown/eviction
 * that must not be logged as keep-alive failures.
 */
export function isPlaywrightAlreadyClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Browser has been closed") ||
    message.includes("Target closed")
  );
}

export async function closePlaywrightForAccount(
  accountId: string,
): Promise<void> {
  const release = await acquireAccountMutex(
    accountId,
    `close:${accountId.substring(0, 12)}`,
  );
  try {
    await closePlaywrightForAccountLocked(accountId);
  } finally {
    release();
  }
}

// WAF hard-block contingency: after the fingerprint seed rotates, close this
// account's context so the next use re-initializes with the fresh device
// identity (cookies/storage persist in the profile dir). Fire-and-forget — the
// quarantine is already applied; a failed close must not abort it.
setWafContextResetListener((accountId: string) => {
  if (!accountPages.has(accountId)) return;
  void closePlaywrightForAccount(accountId).catch((error: unknown) => {
    console.warn(
      `[Playwright] WAF context reset failed for ${accountId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
});

export async function closeAllPlaywright(): Promise<void> {
  closingAllPlaywright = true;
  try {
    const accountIds = Array.from(
      new Set([
        ...accountContexts.keys(),
        ...accountPages.keys(),
        ...headerCaches.keys(),
        ...cookieCaches.keys(),
        ...lastAccountActivity.keys(),
      ]),
    );
    for (const accountId of accountIds) {
      await closePlaywrightForAccount(accountId);
    }
  } finally {
    closingAllPlaywright = false;
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

export function isPlaywrightInitialized(accountId: string): boolean {
  return accountPages.has(accountId);
}

/**
 * Register an account as if it had been initialized, with a chosen last
 * activity timestamp. Lets the idle/keep-alive selection be exercised without
 * launching a browser; the mutex is materialized because an account without
 * one is never selected. For tests only.
 */
export function registerPlaywrightAccountForTests(
  accountId: string,
  page: Page,
  lastActivityAt: number,
): void {
  getAccountMutex(accountId);
  accountPages.set(accountId, page);
  lastAccountActivity.set(accountId, lastActivityAt);
}

// ─── Token TTL Diagnostics ───────────────────────────────────────────────────

export interface CookieDiagnostic {
  name: string;
  domain: string;
  category: "auth" | "anti-fraud" | "tracking" | "other";
  expiresAt: number | null; // epoch seconds, null = session cookie
  expiresInMin: number | null; // minutes until expiry, null = session
  isExpired: boolean;
  isSession: boolean;
}

export interface HeaderDiagnostic {
  accountId: string;
  hasHeaders: boolean;
  headerAgeMin: number;
  headersTtlMin: number;
  refreshThresholdMin: number;
  refreshInProgress: boolean;
}

function cookieCategory(name: string): CookieDiagnostic["category"] {
  const n = name.toLowerCase();
  if (n.includes("token") || n.includes("session") || n.includes("auth")) return "auth";
  if (n.includes("umid") || n.includes("baxia") || n.includes("_m_h5")) return "anti-fraud";
  if (n.includes("cna") || n.includes("isg") || n.includes("_uab_")) return "tracking";
  return "other";
}

/**
 * Get diagnostic info about cookie lifetimes and header cache state.
 * Useful for determining the real TTL of Qwen tokens.
 */
export async function getTokenDiagnostics(
  accountId?: string,
): Promise<{
  cookies: CookieDiagnostic[];
  headers: HeaderDiagnostic[];
  summary: {
    totalCookies: number;
    sessionCookies: number;
    shortestTtlMin: number | null;
    shortestTtlCookie: string | null;
  };
}> {
  const targetAccounts = accountId
    ? [accountId]
    : Array.from(accountContexts.keys());

  const allCookies: CookieDiagnostic[] = [];
  const headerDiags: HeaderDiagnostic[] = [];

  for (const accId of targetAccounts) {
    const context = accountContexts.get(accId);
    if (!context) continue;

    // Get cookies
    try {
      const cookies = await context.cookies();
      const now = Date.now();

      for (const cookie of cookies) {
        const isSession = cookie.expires === -1;
        const expiresAt = isSession ? null : cookie.expires;
        const expiresInMin = isSession
          ? null
          : Math.round((cookie.expires * 1000 - now) / 60000);

        allCookies.push({
          name: cookie.name,
          domain: cookie.domain.replace(/^\./, ""),
          category: cookieCategory(cookie.name),
          expiresAt,
          expiresInMin,
          isExpired: !isSession && cookie.expires * 1000 < now,
          isSession,
        });
      }
    } catch {
      // Context may be closing
    }

    // Get header cache info
    const cache = headerCaches.get(accId);
    if (cache) {
      const ageMin = Math.round((Date.now() - cache.lastRefresh) / 60000);
      headerDiags.push({
        accountId: accId,
        hasHeaders: !!cache.headers["bx-ua"],
        headerAgeMin: ageMin,
        headersTtlMin: Math.round(HEADER_CACHE_TTL / 60000),
        refreshThresholdMin: Math.round((HEADER_CACHE_TTL * HEADER_REFRESH_THRESHOLD) / 60000),
        refreshInProgress: cache.refreshInProgress,
      });
    }
  }

  // Find shortest TTL among persistent cookies
  const persistentCookies = allCookies.filter(c => !c.isSession && !c.isExpired);
  const shortest = persistentCookies.length > 0
    ? persistentCookies.reduce((min, c) =>
        (c.expiresInMin ?? Infinity) < (min.expiresInMin ?? Infinity) ? c : min
      )
    : null;

  return {
    cookies: allCookies.sort((a, b) => {
      if (a.isSession && !b.isSession) return 1;
      if (!a.isSession && b.isSession) return -1;
      return (a.expiresInMin ?? Infinity) - (b.expiresInMin ?? Infinity);
    }),
    headers: headerDiags,
    summary: {
      totalCookies: allCookies.length,
      sessionCookies: allCookies.filter(c => c.isSession).length,
      shortestTtlMin: shortest?.expiresInMin ?? null,
      shortestTtlCookie: shortest?.name ?? null,
    },
  };
}
