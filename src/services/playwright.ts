/*
 * File: playwright.ts
 * Project: QwenBridge
 *
 * Playwright browser automation with stealth plugin for anti-bot evasion.
 * Captures real browser headers (bx-ua, bx-umidtoken) per account.
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import type { QwenAccount } from "../core/accounts.ts";
import { config } from "../core/config.ts";
import { maskEmail } from "../core/logger.ts";
import { Mutex } from "../core/mutex.ts";
import {
  clearFingerprintCache,
  getFingerprintProfile,
  type FingerprintProfile,
} from "./fingerprint.ts";
import { subtlePageActivity } from "./human-behavior.ts";
import { qwenOrigin, qwenUrl } from "./qwen-url.ts";

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
    "--disable-features=IsolateOrigins,site-per-process,TranslateUI",
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

// Per-account mutexes for browser access
const accountMutexes = new Map<string, Mutex>();

function getAccountMutex(accountId: string): Mutex {
  let mutex = accountMutexes.get(accountId);
  if (!mutex) {
    mutex = new Mutex(`playwright:${accountId.substring(0, 8)}`);
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
): Promise<() => void> {
  const mutex = getAccountMutex(accountId);
  try {
    return await mutex.acquire(timeoutMs, key);
  } catch (error) {
    if (
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

export function hasRequiredQwenHeaders(
  headers: Record<string, string>,
): boolean {
  return Boolean(headers["bx-ua"]?.trim() && headers["bx-umidtoken"]?.trim());
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
  const required = ["cookie", "user-agent", "bx-ua", "bx-umidtoken", "bx-v"];
  const missing = required.filter((key) => !headers[key]?.trim());
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
): Promise<boolean> {
  const page = accountPages.get(accountId);
  if (!page || page.isClosed()) return false;

  const cache = getHeaderCache(accountId);
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
    // Get real user agent from browser
    let userAgent = config.auth.userAgent;
    try {
      userAgent = await withTimeout(
        page.evaluate(() => navigator.userAgent),
        config.timeouts.page,
        `User-agent lookup timed out for ${accountId}`,
      );
    } catch {
      // Use default
    }

    const cache = getHeaderCache(accountId);
    const hadUsableHeaders = hasRequiredQwenHeaders(cache.headers);

    // Fast path: if headers are still fresh, just refresh cookies lightly
    const headersAge = Date.now() - cache.lastRefresh;
    if (
      hadUsableHeaders &&
      headersAge < HEADER_CACHE_TTL * HEADER_REFRESH_THRESHOLD
    ) {
      await tryLightweightCookieRefresh(accountId);
      const bxUa = cache.headers["bx-ua"];
      const bxUmidtoken = cache.headers["bx-umidtoken"];
      const bxV = cache.headers["bx-v"] || "2.5.36";
      const cookie = await getCookies(accountId);
      touchAccountActivity(accountId);
      return { cookie, userAgent, bxV, bxUa, bxUmidtoken };
    }

    // Extended fast path: headers are stale but auth token is still valid.
    // Check if we can skip full recapture by verifying cookie validity.
    // This avoids expensive browser interaction when the 30-day token is fresh.
    if (hadUsableHeaders && headersAge > HEADER_CACHE_TTL) {
      const [authValid, shortestValid] = await Promise.all([
        isAuthTokenValid(accountId),
        isShortestCookieValid(accountId),
      ]);

      if (authValid && shortestValid) {
        // Token is still valid - just refresh cookies, keep cached headers
        await tryLightweightCookieRefresh(accountId);
        const bxUa = cache.headers["bx-ua"];
        const bxUmidtoken = cache.headers["bx-umidtoken"];
        const bxV = cache.headers["bx-v"] || "2.5.36";
        const cookie = await getCookies(accountId);
        // Update lastRefresh to extend the cache
        cache.lastRefresh = Date.now();
        touchAccountActivity(accountId);
        console.log(
          `🔄 [Playwright] Skipped header recapture for ${accountId} (token still valid, age: ${Math.round(headersAge / 60000)} min)`,
        );
        return { cookie, userAgent, bxV, bxUa, bxUmidtoken };
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
        `🔄 [Playwright] Missing bx-ua/bx-umidtoken for ${accountId}, triggering header interception...`,
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

    const bxUa = cache.headers["bx-ua"];
    const bxUmidtoken = cache.headers["bx-umidtoken"];
    const bxV = cache.headers["bx-v"] || "2.5.36";

    // Read cookie AFTER all refreshes (re-login may have updated it)
    const cookie = await getCookies(accountId);

    touchAccountActivity(accountId);
    return {
      cookie,
      userAgent,
      bxV,
      bxUa,
      bxUmidtoken,
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
      touchAccountActivity(account.id);

      // Check if already logged in
      const cookies = await acctContext.cookies();
      const hasAuthCookie = cookies.some(
        (c) =>
          c.name.toLowerCase().includes("token") ||
          c.name.toLowerCase().includes("session"),
      );

      let didLogin = false;
      if (!hasAuthCookie && account.email && account.password) {
        await loginToQwen(account.id, account.email, account.password);
        didLogin = true;
      }

      // Navigate to the stable chat page to validate the session and populate cookies
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
            didLogin = true;
          } else {
            console.warn(
              `[Playwright] Session expired for account ${account.id} but no credentials available.`,
            );
          }
        }
      } catch (err: any) {
        console.warn(
          `❌ [Playwright] Failed to validate session for ${maskEmail(account.email)}: ${err.message}`,
        );
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

// ─── Login ────────────────────────────────────────────────────────────────────

async function loginToQwen(
  accountId: string,
  email: string,
  password: string,
): Promise<boolean> {
  const page = accountPages.get(accountId);
  if (!page) return false;

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
    const emailSelector = 'input[type="email"], input[placeholder*="Email"]';
    try {
      await page.waitForSelector(emailSelector, {
        timeout: config.timeouts.page,
      });
    } catch {
      if (!page.url().includes("/auth")) return true;
      throw new Error("Email input not found");
    }

    // Fill email
    await page.fill(emailSelector, email);
    await page.keyboard.press("Enter");
    await sleep(1500);

    // Wait for password input
    const passwordSelector = 'input[type="password"]';
    await page.waitForSelector(passwordSelector, {
      timeout: config.timeouts.page,
    });

    // Fill password
    await page.fill(passwordSelector, password);
    await page.keyboard.press("Enter");
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

    const cleanupRoute = () => {
      if (!routeRegistered) return;
      void page
        .unroute("**/api/v2/chat/completions*", routeHandler)
        .catch(() => {});
    };

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      cleanupRoute();
      if (error) reject(error);
      else resolve();
    };

    routeHandler = async (route: any, request: any) => {
      if (settled) {
        // A route installed immediately before timeout must not poison future
        // browser traffic after the capture operation has completed.
        await route.continue().catch(() => {});
        return;
      }

      const reqHeaders = request.headers();
      const capturedHeaders: Record<string, string> = {
        cookie: reqHeaders["cookie"] || "",
        "bx-ua": reqHeaders["bx-ua"] || "",
        "bx-umidtoken": reqHeaders["bx-umidtoken"] || "",
        "bx-v": reqHeaders["bx-v"] || "2.5.36",
        "user-agent": reqHeaders["user-agent"] || "",
        "x-request-id": reqHeaders["x-request-id"] || "",
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
        await route.abort("aborted").catch(() => {});
        settle(
          new Error(
            `Header capture returned incomplete anti-fraud headers for ${accountId}`,
          ),
        );
        return;
      }

      if (timeout) clearTimeout(timeout);
      cache.headers = capturedHeaders;
      cache.lastRefresh = Date.now();
      // Header interception can set challenge/session cookies, so do not reuse
      // a cookie snapshot taken before this browser request.
      cookieCaches.delete(accountId);
      touchAccountActivity(accountId);

      await route.abort("aborted").catch(() => {});
      await sleep(HEADER_CAPTURE_SETTLE_MS);
      settle();
    };

    timeout = setTimeout(() => {
      console.warn(`⏱️  [Playwright] Header capture timeout for ${accountId}`);
      settle(new Error(`Header capture timed out for ${accountId}`));
    }, timeoutMs);

    void page
      .route("**/api/v2/chat/completions*", routeHandler)
      .then(async () => {
        routeRegistered = true;
        if (settled) {
          cleanupRoute();
          return;
        }

        try {
          // Navigate to the stable chat page and trigger a request.
          await page.goto(qwenUrl("/"), {
            waitUntil: "domcontentloaded",
            timeout: Math.min(config.timeouts.navigation, timeoutMs),
          });
          if (settled) return;
          await sleep(2000);
          if (settled) return;

          const inputSelector =
            'textarea:visible, [contenteditable="true"]:visible';
          await page.focus(inputSelector);
          if (settled) return;
          await page.fill(inputSelector, "");
          if (settled) return;
          await page.type(inputSelector, "a", { delay: 100 });
          if (settled) return;
          await sleep(2000);
          if (settled) return;

          const sendSelectors = [
            ".message-input-right-button-send .send-button",
            ".chat-prompt-send-button",
            "button.send-button",
          ];

          let clicked = false;
          for (const selector of sendSelectors) {
            if (settled) return;
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
                if (!settled) {
                  await btn.click({ force: true, delay: 50 }).catch(() => {});
                }
                clicked = true;
                break;
              }
            } catch {
              // Try the next selector.
            }
          }

          if (!clicked && !settled) {
            await page.keyboard.press("Enter");
          }
        } catch (error) {
          console.warn(
            `❌ [Playwright] Error triggering header capture for ${accountId}: ${getErrorMessage(error)}`,
          );
          settle(
            error instanceof Error
              ? error
              : new Error(`Header capture failed for ${accountId}`),
          );
        }
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

/**
 * Check if the auth token cookie is still valid.
 * Used to skip unnecessary header recaptures when the token is still fresh.
 * Returns true if the token cookie exists and is not expired.
 */
async function isAuthTokenValid(accountId: string): Promise<boolean> {
  try {
    const context = accountContexts.get(accountId);
    if (!context) return false;

    const cookies = await context.cookies();
    const tokenCookie = cookies.find(
      (c) => c.name === "token" && (c.domain === ".qwen.ai" || c.domain === "qwen.ai"),
    );

    if (!tokenCookie) return false;

    // Session cookie (expires = -1) is valid as long as browser is open
    if (tokenCookie.expires === -1) return true;

    // Check if expired (with 5-min safety margin)
    const now = Date.now();
    const expiresAt = tokenCookie.expires * 1000;
    return expiresAt > now + 5 * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * Check if the shortest-lived cookie (acw_tc) is still valid.
 * This is the 24-min cookie that gates some requests.
 */
async function isShortestCookieValid(accountId: string): Promise<boolean> {
  try {
    const context = accountContexts.get(accountId);
    if (!context) return false;

    const cookies = await context.cookies();
    const acwCookie = cookies.find(
      (c) => c.name === "acw_tc" && c.domain.includes("qwen.ai"),
    );

    if (!acwCookie) return true; // If missing, assume OK (will be refreshed by browser)

    if (acwCookie.expires === -1) return true;

    const now = Date.now();
    const expiresAt = acwCookie.expires * 1000;
    return expiresAt > now + 60 * 1000; // 1-min safety margin
  } catch {
    return false;
  }
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
          timeout: Math.min(config.timeouts.navigation, boundedTimeoutMs),
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
): Promise<T> {
  const page = accountPages.get(accountId);
  if (!page || page.isClosed()) {
    throw new Error(`Playwright page unavailable for account: ${accountId}`);
  }
  const release = await acquireAccountMutex(
    accountId,
    `page:${accountId.substring(0, 12)}`,
    Math.max(1_000, mutexTimeoutMs),
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
  try {
    fs.rmSync(profilePath, { recursive: true, force: true });
  } catch (error) {
    if (!isPlaywrightProfileCorruptedError(error)) {
      console.warn(
        `[Playwright] Failed to delete profile for ${accountId}:`,
        getErrorMessage(error),
      );
    }
  }
}

const PROFILE_RESET_TIMEOUT_MS = 45_000;

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
    const mutex = accountMutexes.get(accountId);
    if (!mutex?.isIdle()) return false;
    const lastActivity = lastAccountActivity.get(accountId) ?? 0;
    return now - lastActivity >= idleMs;
  });
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

  const candidates = getIdlePlaywrightAccountIds(idleMs)
    .map((accountId) => ({
      accountId,
      lastActivity: lastAccountActivity.get(accountId) ?? 0,
    }))
    .sort((a, b) => a.lastActivity - b.lastActivity);

  let closed = 0;
  for (const candidate of candidates) {
    if (maxActiveContexts > 0 && accountPages.size <= maxActiveContexts) {
      break;
    }

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

  const candidates = Array.from(accountPages.keys())
    .map((accountId) => ({
      accountId,
      mutex: accountMutexes.get(accountId),
      lastActivity: lastAccountActivity.get(accountId) ?? 0,
    }))
    .filter((candidate) => candidate.mutex?.isIdle())
    .sort((a, b) => a.lastActivity - b.lastActivity);

  let closed = 0;
  for (const candidate of candidates) {
    if (accountPages.size <= max) break;
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

function cleanupPlaywrightAccountState(accountId: string): void {
  accountContexts.delete(accountId);
  accountPages.delete(accountId);
  headerCaches.delete(accountId);
  cookieCaches.delete(accountId);
  lastAccountActivity.delete(accountId);
  lastKeepAliveNavigation.delete(accountId);
  clearFingerprintCache(accountId);
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
  }
}

function isPlaywrightAlreadyClosedError(error: unknown): boolean {
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

export function getPlaywrightStatus(): Record<
  string,
  { initialized: boolean; hasHeaders: boolean }
> {
  const status: Record<string, { initialized: boolean; hasHeaders: boolean }> =
    {};
  for (const [accountId, cache] of headerCaches.entries()) {
    status[accountId] = {
      initialized: accountPages.has(accountId),
      hasHeaders: !!cache.headers["bx-ua"],
    };
  }
  return status;
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
