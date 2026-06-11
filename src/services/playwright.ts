/*
 * File: playwright.ts
 * Project: QwenBridge
 *
 * Playwright browser automation with stealth plugin for anti-bot evasion.
 * Captures real browser headers (bx-ua, bx-umidtoken) per account.
 */

import { chromium, BrowserContext, Page } from "playwright";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { QwenAccount } from "../core/accounts.ts";
import { config } from "../core/config.ts";
import { maskEmail } from "../core/logger.ts";
import { Mutex } from "../core/mutex.ts";

// Try to import playwright-extra and stealth, fallback to regular playwright
let chromiumWithStealth: typeof chromium | null = null;

try {
  const pwExtra = await import("playwright-extra");
  const stealth = await import("puppeteer-extra-plugin-stealth");

  if (pwExtra.chromium && stealth.default) {
    const plugin = stealth.default();
    pwExtra.chromium.use(plugin);
    chromiumWithStealth = pwExtra.chromium;
    console.log("[Playwright] Stealth plugin loaded");
  }
} catch {
  console.warn(
    "[Playwright] playwright-extra/stealth not available, using regular playwright",
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
const HEADER_CACHE_TTL = 50 * 60 * 1000; // 50 minutes
const COOKIE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cookieCaches = new Map<string, { cookie: string; timestamp: number }>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getStealthScript(): string {
  return `
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

    // languages
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });

    // hardware
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
    Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });

    // screen
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

    // permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);

    // WebGL - consistent with Windows/Intel
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Google Inc. (Intel)';
      if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.5)';
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
        `[Playwright] Missing bx-ua/bx-umidtoken for ${accountId}, triggering header interception...`,
      );
      try {
        await refreshHeadersInternal(accountId);
        const refreshedCache = getHeaderCache(accountId);
        bxUa = refreshedCache.headers["bx-ua"] || bxUa;
        bxUmidtoken = refreshedCache.headers["bx-umidtoken"] || bxUmidtoken;
        bxV = refreshedCache.headers["bx-v"] || bxV;
      } catch (err: any) {
        console.warn(
          `[Playwright] Failed to auto-recover headers for ${accountId}: ${err.message}`,
        );
      }
    }

    // Read cookie AFTER all refreshes (re-login may have updated it)
    const cookie = await getCookies(accountId);

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
      console.log(
        `[Playwright] Already initialized for ${maskEmail(account.email)}`,
      );
      return;
    }

    const profilePath = path.resolve("data", "qwen_profiles", account.id);
    const { engine, channel } = resolveBrowserEngine(browserType);

    console.log(
      `[Playwright] Launching ${browserType} for ${maskEmail(account.email)}...`,
    );

    // Use playwright-extra with stealth if available, otherwise regular chromium
    const engineToUse = chromiumWithStealth || engine;

    const acctContext = await engineToUse.launchPersistentContext(profilePath, {
      headless,
      channel,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-infobars",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1920,1080",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--metrics-recording-only",
        "--mute-audio",
      ],
    });

    try {
      // Comprehensive stealth scripts for anti-bot evasion
      await acctContext.addInitScript(getStealthScript());

      const acctPage = await acctContext.newPage();
      accountContexts.set(account.id, acctContext);
      accountPages.set(account.id, acctPage);

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

      // Navigate to Qwen home to validate session and populate cookies
      try {
        await acctPage.goto("https://chat.qwen.ai/", {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        const url = acctPage.url();
        if (url.includes("auth") || url.includes("login")) {
          if (account.email && account.password) {
            console.log(
              `[Playwright] Session expired for ${maskEmail(account.email)}, re-logging in...`,
            );
            await loginToQwen(account.id, account.email, account.password);
          } else {
            console.warn(
              `[Playwright] Session expired for account ${account.id} but no credentials available.`,
            );
          }
        } else {
          console.log(
            `[Playwright] Session validated for ${maskEmail(account.email)}.`,
          );
        }
      } catch (err: any) {
        console.warn(
          `[Playwright] Failed to validate session for ${maskEmail(account.email)}: ${err.message}`,
        );
      }

      // Capture headers by navigating and intercepting
      await captureHeaders(account.id);
    } catch (error) {
      accountPages.delete(account.id);
      accountContexts.delete(account.id);
      await acctContext.close().catch((closeError) => {
        if (!isPlaywrightAlreadyClosedError(closeError)) {
          console.warn(
            `[Playwright] Failed to close context after init error: ${closeError}`,
          );
        }
      });
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

  console.log(`[Playwright] Logging in ${maskEmail(email)}...`);

  // Try API login first
  const apiResult = await loginViaApi(page, email, password);
  if (apiResult) {
    console.log(`[Playwright] API login successful for ${maskEmail(email)}`);
    return true;
  }

  // Fallback to UI login
  console.log(
    `[Playwright] API login failed, trying UI login for ${maskEmail(email)}...`,
  );
  const uiResult = await loginViaUi(page, email, password);
  if (uiResult) {
    console.log(`[Playwright] UI login successful for ${maskEmail(email)}`);
    return true;
  }

  console.error(
    `[Playwright] All login methods failed for ${maskEmail(email)}`,
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
    console.warn(`[Playwright] API login error: ${err}`);
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
      await page.waitForSelector(emailSelector, { timeout: 10000 });
    } catch {
      if (!page.url().includes("/auth")) return true;
      throw new Error("Email input not found");
    }

    // Fill email
    console.log(`[Playwright] UI: Filling email...`);
    await page.fill(emailSelector, email);
    await page.keyboard.press("Enter");
    await sleep(1500);

    // Wait for password input
    const passwordSelector = 'input[type="password"]';
    await page.waitForSelector(passwordSelector, { timeout: 10000 });

    // Fill password
    console.log(`[Playwright] UI: Filling password...`);
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
    console.warn(`[Playwright] UI login error: ${err}`);
    return false;
  }
}

// ─── Header Capture ───────────────────────────────────────────────────────────

async function captureHeaders(accountId: string): Promise<void> {
  const page = accountPages.get(accountId);
  if (!page) return;

  const cache = getHeaderCache(accountId);

  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    const timeout = setTimeout(async () => {
      console.warn(`[Playwright] Header capture timeout for ${accountId}`);
      await page
        .unroute("**/api/v2/chat/completions*", routeHandler)
        .catch(() => {});
      done();
    }, 30000);

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

      console.log(`[Playwright] Headers captured for ${accountId}`);

      await route.abort("aborted").catch(() => {});
      await page
        .unroute("**/api/v2/chat/completions*", routeHandler)
        .catch(() => {});
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
          await sleep(1000);

          // Try to click send button
          const sendSelectors = [
            ".message-input-right-button-send .send-button",
            ".chat-prompt-send-button",
            "button.send-button",
          ];

          for (const selector of sendSelectors) {
            try {
              const btn = await page.$(selector);
              if (btn && (await btn.isVisible())) {
                await btn.click({ force: true, delay: 50 });
                break;
              }
            } catch {
              // Try next selector
            }
          }

          // Fallback to Enter key
          await page.keyboard.press("Enter");
        } catch (err) {
          console.warn(`[Playwright] Error triggering request: ${err}`);
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

  cache.refreshInProgress = true;
  try {
    // Check if session is expired before capturing headers
    const page = accountPages.get(accountId);
    if (page) {
      try {
        await page.goto("https://chat.qwen.ai/", {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        const url = page.url();
        if (url.includes("auth") || url.includes("login")) {
          console.log(
            `[Playwright] Session expired during refresh, re-logging in for ${accountId}...`,
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

async function resetPlaywrightProfile(accountId: string): Promise<void> {
  await closePlaywrightForAccount(accountId);
  const profilePath = path.resolve("data", "qwen_profiles", accountId);
  try {
    fs.rmSync(profilePath, { recursive: true, force: true });
  } catch (error) {
    if (!isPlaywrightProfileCorruptedError(error)) {
      console.warn(
        `[Playwright] Failed to delete profile for ${accountId}:`,
        (error as Error).message,
      );
    }
  }
}

const PROFILE_RESET_TIMEOUT_MS = 45_000;

export async function refreshHeadersWithProfileReset(
  accountId: string,
): Promise<void> {
  const release = await getAccountMutex(accountId).acquire();
  try {
    await resetPlaywrightProfile(accountId);
    const accounts = await import("../core/accounts.ts");
    const account = accounts.getAccountCredentials(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found during profile reset`);
    }

    await Promise.race([
      initPlaywrightForAccount(account),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Playwright re-initialization timed out after ${PROFILE_RESET_TIMEOUT_MS}ms`,
              ),
            ),
          PROFILE_RESET_TIMEOUT_MS,
        ),
      ),
    ]);
  } finally {
    release();
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

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
    const acctContext = accountContexts.get(accountId);
    if (!acctContext) return;

    try {
      await acctContext.close();
    } catch (error) {
      if (!isPlaywrightAlreadyClosedError(error)) {
        throw error;
      }
    } finally {
      accountContexts.delete(accountId);
      accountPages.delete(accountId);
      headerCaches.delete(accountId);
      cookieCaches.delete(accountId);
      accountMutexes.delete(accountId);
    }
  } finally {
    release();
  }
}

export async function closeAllPlaywright(): Promise<void> {
  const accountIds = Array.from(accountContexts.keys());
  for (const accountId of accountIds) {
    await closePlaywrightForAccount(accountId);
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
