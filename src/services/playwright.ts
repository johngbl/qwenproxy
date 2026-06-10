/*
 * File: playwright.ts
 * Project: QwenBridge
 *
 * Playwright browser automation with stealth plugin for anti-bot evasion.
 * Captures real browser headers (bx-ua, bx-umidtoken) per account.
 */

import { chromium, BrowserContext, Page } from "playwright";
import path from "path";
import crypto from "crypto";
import { QwenAccount } from "../core/accounts.ts";
import { config } from "../core/config.ts";
import { logger } from "../core/logger.ts";

// Try to import playwright-extra and stealth, fallback to regular playwright
let chromiumWithStealth: typeof chromium | null = null;

try {
  const pwExtra = await import("playwright-extra");
  const stealth = await import("puppeteer-extra-plugin-stealth");

  if (pwExtra.chromium && stealth.default) {
    const plugin = stealth.default();
    pwExtra.chromium.use(plugin);
    chromiumWithStealth = pwExtra.chromium;
    logger.info("[Playwright] Stealth plugin loaded");
  }
} catch {
  logger.warn(
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

// ─── Mutex ────────────────────────────────────────────────────────────────────

class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
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
    const cookie = await getCookies(accountId);
    const cache = getHeaderCache(accountId);

    // Get real user agent from browser
    let userAgent = config.auth.userAgent;
    try {
      userAgent = await page.evaluate(() => navigator.userAgent);
    } catch {
      // Use default
    }

    // Refresh headers if stale
    const headersAge = Date.now() - cache.lastRefresh;
    if (headersAge > HEADER_CACHE_TTL && !cache.refreshInProgress) {
      await refreshHeadersInternal(accountId);
    }

    return {
      cookie,
      userAgent,
      bxV: cache.headers["bx-v"] || "2.5.36",
      bxUa: cache.headers["bx-ua"] || "",
      bxUmidtoken: cache.headers["bx-umidtoken"] || "",
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
    console.log(`[Playwright] Already initialized for ${account.email}`);
    return;
  }

  const release = await getAccountMutex(account.id).acquire();
  try {
    // Double-check after acquiring lock
    if (accountPages.has(account.id)) {
      console.log(`[Playwright] Already initialized for ${account.email}`);
      return;
    }

    const profilePath = path.resolve("data", "qwen_profiles", account.id);
    const { engine, channel } = resolveBrowserEngine(browserType);

    console.log(
      `[Playwright] Launching ${browserType} for ${account.email}...`,
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
        "--no-sandbox",
      ],
    });

    // Additional stealth scripts
    await acctContext.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["zh-CN", "zh", "en"],
      });
    });

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

    // Capture headers by navigating and intercepting
    await captureHeaders(account.id);
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

  console.log(`[Playwright] Logging in ${email}...`);

  // Try API login first
  const apiResult = await loginViaApi(page, email, password);
  if (apiResult) {
    console.log(`[Playwright] API login successful for ${email}`);
    return true;
  }

  // Fallback to UI login
  console.log(`[Playwright] API login failed, trying UI login for ${email}...`);
  const uiResult = await loginViaUi(page, email, password);
  if (uiResult) {
    console.log(`[Playwright] UI login successful for ${email}`);
    return true;
  }

  console.error(`[Playwright] All login methods failed for ${email}`);
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
    const timeout = setTimeout(() => {
      console.warn(`[Playwright] Header capture timeout for ${accountId}`);
      resolve();
    }, 30000);

    const routeHandler = async (route: any, request: any) => {
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

      await route.abort("aborted");
      await page.unroute("**/api/v2/chat/completions*", routeHandler);
      resolve();
    };

    page.route("**/api/v2/chat/completions*", routeHandler).then(async () => {
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
        resolve();
      }
    });
  });
}

async function refreshHeadersInternal(accountId: string): Promise<void> {
  const cache = getHeaderCache(accountId);
  if (cache.refreshInProgress) return;

  cache.refreshInProgress = true;
  try {
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

// ─── Cleanup ──────────────────────────────────────────────────────────────────

export async function closePlaywrightForAccount(
  accountId: string,
): Promise<void> {
  const release = await getAccountMutex(accountId).acquire();
  try {
    const acctContext = accountContexts.get(accountId);
    if (acctContext) {
      await acctContext.close();
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
  for (const accountId of accountContexts.keys()) {
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
