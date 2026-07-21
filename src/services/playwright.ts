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
    "--disable-gpu",
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
    mutex = new Mutex();
    accountMutexes.set(accountId, mutex);
  }
  return mutex;
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
const HEADER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes (matches Alibaba token lifetime)
const COOKIE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
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
    const __qwenFingerprint = ${profileJson};

    // navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete navigator.__proto__.webdriver;

    // chrome object
    window.chrome = {
      runtime: {
        onMessage: { addListener: function() {} },
        sendMessage: function() {},
      },
      loadTimes: function() { return {}; },
      csi: function() { return {}; },
      app: {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      },
    };

    // plugins - realistic set
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        plugins.length = 3;
        return plugins;
      },
    });

    // mimeTypes
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => {
        const types = [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        ];
        types.length = 2;
        return types;
      },
    });

    // identity
    Object.defineProperty(navigator, 'userAgent', { get: () => __qwenFingerprint.userAgent });
    Object.defineProperty(navigator, 'appVersion', { get: () => __qwenFingerprint.appVersion });

    // languages
    Object.defineProperty(navigator, 'languages', { get: () => __qwenFingerprint.languages });
    Object.defineProperty(navigator, 'language', { get: () => __qwenFingerprint.locale });

    // hardware
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => __qwenFingerprint.hardwareConcurrency });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => __qwenFingerprint.deviceMemory });
    Object.defineProperty(navigator, 'platform', { get: () => __qwenFingerprint.platform });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
    Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });

    if ('userAgentData' in navigator) {
      Object.defineProperty(navigator, 'userAgentData', {
        get: () => ({
          brands: __qwenFingerprint.brands,
          mobile: false,
          platform: 'Windows',
          getHighEntropyValues: async (hints) => {
            const values = {
              architecture: 'x86',
              bitness: '64',
              brands: __qwenFingerprint.brands,
              fullVersionList: __qwenFingerprint.fullVersionList,
              mobile: false,
              model: '',
              platform: 'Windows',
              platformVersion: __qwenFingerprint.platformVersion,
              uaFullVersion: __qwenFingerprint.chromeVersion,
              wow64: false,
            };
            return hints.reduce((acc, hint) => {
              if (hint in values) acc[hint] = values[hint];
              return acc;
            }, {});
          },
          toJSON: () => ({
            brands: __qwenFingerprint.brands,
            mobile: false,
            platform: 'Windows',
          }),
        }),
      });
    }

    // screen
    Object.defineProperty(screen, 'colorDepth', { get: () => __qwenFingerprint.colorDepth });
    Object.defineProperty(screen, 'pixelDepth', { get: () => __qwenFingerprint.pixelDepth });

    // permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);

    // WebGL - consistent per account
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return __qwenFingerprint.webglVendor;
      if (parameter === 37446) return __qwenFingerprint.webglRenderer;
      return getParameter.apply(this, arguments);
    };

    // connection
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
      }),
    });

    // toString patching - prevent detection of overridden functions
    const nativeToString = Function.prototype.toString;
    const customFunctions = new Map();
    customFunctions.set(navigator.permissions.query, 'function query() { [native code] }');
    customFunctions.set(WebGLRenderingContext.prototype.getParameter, 'function getParameter() { [native code] }');
    Function.prototype.toString = function() {
      return customFunctions.get(this) || nativeToString.call(this);
    };
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

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getCookies(accountId: string): Promise<string> {
  const now = Date.now();
  const cached = cookieCaches.get(accountId);
  if (cached && now - cached.timestamp < COOKIE_CACHE_TTL) {
    return cached.cookie;
  }

  const page = accountPages.get(accountId);
  if (!page) return "";

  const cookies = await page.context().cookies();
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
  const release = await getAccountMutex(accountId).acquire();
  try {
    touchAccountActivity(accountId);
    // Get real user agent from browser
    let userAgent = config.auth.userAgent;
    try {
      userAgent = await page.evaluate(() => navigator.userAgent);
    } catch {
      // Use default
    }

    const cache = getHeaderCache(accountId);

    // Refresh headers if stale
    const headersAge = Date.now() - cache.lastRefresh;
    if (headersAge > HEADER_CACHE_TTL && !cache.refreshInProgress) {
      await refreshHeadersInternal(accountId);
    }

    let bxUa = cache.headers["bx-ua"] || "";
    let bxUmidtoken = cache.headers["bx-umidtoken"] || "";
    let bxV = cache.headers["bx-v"] || "2.5.36";

    // Auto-recover missing anti-fraud headers by triggering full header interception
    if (!bxUa || !bxUmidtoken) {
      console.log(
        `🔄 [Playwright] Missing bx-ua/bx-umidtoken for ${accountId}, triggering header interception...`,
      );
      try {
        await refreshHeadersInternal(accountId);
        const refreshedCache = getHeaderCache(accountId);
        bxUa = refreshedCache.headers["bx-ua"] || bxUa;
        bxUmidtoken = refreshedCache.headers["bx-umidtoken"] || bxUmidtoken;
        bxV = refreshedCache.headers["bx-v"] || bxV;
      } catch (err: any) {
        console.warn(
          `❌ [Playwright] Failed to auto-recover headers for ${accountId}: ${err.message}`,
        );
      }
    }

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

  const release = await getAccountMutex(account.id).acquire();
  try {
    // Double-check after acquiring lock
    if (accountPages.has(account.id)) {
      return;
    }

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
      extraHTTPHeaders: {
        "sec-ch-ua": fingerprint.secChUa,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
      ignoreDefaultArgs: ["--enable-automation"],
      args: buildChromiumLaunchArgs(fingerprint.viewport),
    });

    try {
      // Comprehensive stealth scripts for anti-bot evasion
      await acctContext.addInitScript(getStealthScript(fingerprint));

      const acctPage = await acctContext.newPage();
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

      // Navigate to Qwen home to validate session and populate cookies
      try {
        await acctPage.goto("https://chat.qwen.ai/", {
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
      await captureHeaders(account.id);
      touchAccountActivity(account.id);

      if (didLogin) {
        console.log(`✅ [Playwright] Login successful for ${maskEmail(account.email)}`);
      }
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
    await page.goto("https://chat.qwen.ai/auth", {
      waitUntil: "domcontentloaded",
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

    const result = await page.evaluate(
      async ({ email, password }) => {
        try {
          const response = await fetch(
            "https://chat.qwen.ai/api/v2/auths/signin",
            {
              method: "POST",
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
      { email, password: hashedPassword },
    );

    if (result.ok) {
      await page.goto("https://chat.qwen.ai/", {
        waitUntil: "domcontentloaded",
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
    await page.goto("https://chat.qwen.ai/auth", {
      waitUntil: "domcontentloaded",
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
      await page.goto("https://chat.qwen.ai/", {
        waitUntil: "domcontentloaded",
      });
    }

    return isLoggedIn;
  } catch (err) {
    console.warn(`⚠️  [Playwright] UI login error: ${err}`);
    return false;
  }
}

// ─── Header Capture ───────────────────────────────────────────────────────────

async function captureHeaders(accountId: string): Promise<void> {
  const page = accountPages.get(accountId);
  if (!page) return;

  touchAccountActivity(accountId);
  const cache = getHeaderCache(accountId);

  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    const timeout = setTimeout(async () => {
      console.warn(`⏱️  [Playwright] Header capture timeout for ${accountId}`);
      await page
        .unroute("**/api/v2/chat/completions*", routeHandler)
        .catch(() => {});
      done();
    }, config.timeouts.headers);

    const routeHandler = async (route: any, request: any) => {
      if (resolved) {
        await route.abort("aborted").catch(() => {});
        return;
      }
      clearTimeout(timeout);

      const reqHeaders = request.headers();
      cache.headers = {
        cookie: reqHeaders["cookie"] || "",
        "bx-ua": reqHeaders["bx-ua"] || "",
        "bx-umidtoken": reqHeaders["bx-umidtoken"] || "",
        "bx-v": reqHeaders["bx-v"] || "2.5.36",
        "user-agent": reqHeaders["user-agent"] || "",
      };
      cache.lastRefresh = Date.now();
      touchAccountActivity(accountId);

      await route.abort("aborted").catch(() => {});
      await page
        .unroute("**/api/v2/chat/completions*", routeHandler)
        .catch(() => {});
      await sleep(HEADER_CAPTURE_SETTLE_MS);
      done();
    };

    page
      .route("**/api/v2/chat/completions*", routeHandler)
      .then(async () => {
        // Navigate to Qwen and trigger a request
        await page.goto("https://chat.qwen.ai/", {
          waitUntil: "domcontentloaded",
        });
        await sleep(2000);

        // Type something and send to trigger header capture
        const inputSelector =
          'textarea:visible, [contenteditable="true"]:visible';
        try {
          await page.focus(inputSelector);
          await page.fill(inputSelector, "");
          await page.type(inputSelector, "a", { delay: 100 });
          await sleep(2000);

          // Try to click send button
          const sendSelectors = [
            ".message-input-right-button-send .send-button",
            ".chat-prompt-send-button",
            "button.send-button",
          ];

          let clicked = false;
          for (const selector of sendSelectors) {
            try {
              const btn = await page.$(selector);
              if (btn && (await btn.isVisible())) {
                // DOM click first (more faithful to real user interaction)
                await page.evaluate((sel) => {
                  const element = document.querySelector(sel) as HTMLElement;
                  if (element) {
                    element.focus();
                    element.click();
                  }
                }, selector);

                await btn.click({ force: true, delay: 50 }).catch(() => {});
                clicked = true;
                break;
              }
            } catch {
              // Try next selector
            }
          }

          if (!clicked) {
            // Fallback to Enter key
            await page.keyboard.press("Enter");
          }
        } catch (err) {
          console.warn(`❌ [Playwright] Error triggering request: ${err}`);
          clearTimeout(timeout);
          await page
            .unroute("**/api/v2/chat/completions*", routeHandler)
            .catch(() => {});
          done();
        }
      })
      .catch(async (err) => {
        console.warn(
          `[Playwright] Error registering header capture route: ${err}`,
        );
        clearTimeout(timeout);
        done();
      });
  });
}

async function refreshHeadersInternal(accountId: string): Promise<void> {
  const cache = getHeaderCache(accountId);
  if (cache.refreshInProgress) return;

  touchAccountActivity(accountId);
  cache.refreshInProgress = true;
  try {
    // Check if session is expired before capturing headers
    const page = accountPages.get(accountId);
    if (page) {
      try {
        await page.goto("https://chat.qwen.ai/", {
          waitUntil: "domcontentloaded",
          timeout: config.timeouts.navigation,
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

    await captureHeaders(accountId);
  } finally {
    touchAccountActivity(accountId);
    cache.refreshInProgress = false;
  }
}

export async function refreshHeaders(accountId: string): Promise<void> {
  const release = await getAccountMutex(accountId).acquire();
  try {
    await refreshHeadersInternal(accountId);
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
): Promise<T> {
  const page = accountPages.get(accountId);
  if (!page || page.isClosed()) {
    throw new Error(`Playwright page unavailable for account: ${accountId}`);
  }
  const release = await getAccountMutex(accountId).acquire();
  try {
    touchAccountActivity(accountId);
    const result = await fn(page);
    touchAccountActivity(accountId);
    return result;
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

  const release = await getAccountMutex(accountId).acquire();
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
  const accountIds = getIdlePlaywrightAccountIds(idleMs);
  let closed = 0;
  for (const accountId of accountIds) {
    const mutex = accountMutexes.get(accountId);
    if (!mutex?.isIdle()) continue;
    await closePlaywrightForAccount(accountId).catch((error) => {
      console.warn(
        `[Playwright] Failed to close idle context for ${accountId}: ${getErrorMessage(error)}`,
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

  const release = await mutex.acquire(2_000).catch(() => null);
  if (!release) return false;

  try {
    const page = accountPages.get(accountId);
    if (!page || page.isClosed()) return false;

    const now = Date.now();
    const currentUrl = page.url();
    const lastNavigation = lastKeepAliveNavigation.get(accountId) ?? 0;
    const shouldNavigate =
      !currentUrl.includes("chat.qwen.ai") ||
      now - lastNavigation > config.sessionKeeper.navigationIntervalMs;

    if (shouldNavigate) {
      await page.goto(config.qwen.baseUrl, {
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
  const release = await getAccountMutex(accountId).acquire();
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
