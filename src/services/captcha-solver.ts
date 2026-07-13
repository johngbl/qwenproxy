/*
 * Browser-side recovery for Alibaba TMD / sufei-punish challenges on chat.qwen.ai.
 *
 * Based on local captures under network/captcha:
 * - punish page loads g.alicdn.com/bsop-static/sufei-punish
 * - widget target #nocaptcha
 * - endpoints /bx/_____tmd_____/punish and /bx/_____tmd_____/verify/
 * - success often sets x5sec cookie and restores normal chat page
 *
 * Strategy (optimized, non-blocking for other accounts):
 * 1) soft refresh of session headers
 * 2) detect punish/captcha UI in the account Playwright page
 * 3) attempt NoCaptcha slider drag when present
 * 4) wait for challenge clear + recapture bx-* headers
 * 5) fail closed so existing cooldown/profile-reset path can run
 */

import type { Frame, Page } from "playwright";
import { config } from "../core/config.ts";
import { humanDelay, sleep, subtlePageActivity } from "./human-behavior.ts";
import {
  isPlaywrightInitialized,
  refreshHeaders,
  withAccountPage,
} from "./playwright.ts";

export interface CaptchaSolveResult {
  success: boolean;
  method:
    | "disabled"
    | "skipped_recent"
    | "headers_only"
    | "slider"
    | "wait_cleared"
    | "failed";
  detail?: string;
  durationMs: number;
}

const SLIDER_SELECTORS = [
  "#nc_1_n1z",
  ".nc_iconfont.btn_slide",
  ".btn_slide",
  "#nc_1_n1t .nc_iconfont",
  ".nc-container .btn_slide",
  ".slidetounlock",
  ".nc_scale span",
  "#nocaptcha .btn_slide",
  '[class*="btn_slide"]',
  ".yidun_slider",
  ".yidun_slide_indicator",
];

const CHALLENGE_SELECTORS = [
  "#nocaptcha",
  "punish-component",
  "#captcha-loading",
  ".nc-container",
  ".nc_wrapper",
  "#baxia-punish",
  'iframe[src*="punish"]',
  'iframe[src*="_____tmd_____"]',
  'iframe[src*="nocaptcha"]',
  'iframe[src*="captcha"]',
];

const lastSolveAt = new Map<string, number>();
const inFlight = new Map<string, Promise<CaptchaSolveResult>>();

export function isCaptchaSolverEnabled(): boolean {
  return config.captchaSolver.enabled;
}

export function looksLikeAntiBotChallengeText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("fail_sys_user_validate") ||
    lower.includes("rgv587_error") ||
    lower.includes("_____tmd_____") ||
    lower.includes("x5secdata") ||
    lower.includes("punish") ||
    lower.includes("nocaptcha") ||
    lower.includes("captcha") ||
    lower.includes("security verification") ||
    lower.includes("verify you are human") ||
    lower.includes("human verification") ||
    lower.includes("denyfromx5")
  );
}

async function pageHasChallengeSignals(page: Page): Promise<{
  challenged: boolean;
  reason: string;
}> {
  if (page.isClosed()) {
    return { challenged: false, reason: "page_closed" };
  }

  const url = page.url();
  if (
    /_____tmd_____|\/bx\/|punish|x5secdata|captcha|nocaptcha/i.test(url)
  ) {
    return { challenged: true, reason: `url:${url.slice(0, 120)}` };
  }

  for (const selector of CHALLENGE_SELECTORS) {
    try {
      const el = await page.$(selector);
      if (el && (await el.isVisible().catch(() => false))) {
        return { challenged: true, reason: `selector:${selector}` };
      }
    } catch {
      // continue
    }
  }

  try {
    const bodySnippet = await page.evaluate(() => {
      const text = document.body?.innerText?.slice(0, 1500) || "";
      const html = document.documentElement?.innerHTML?.slice(0, 2500) || "";
      return `${text}\n${html}`;
    });
    if (looksLikeAntiBotChallengeText(bodySnippet)) {
      return { challenged: true, reason: "body_markers" };
    }
  } catch {
    // ignore
  }

  return { challenged: false, reason: "none" };
}

async function hasX5secCookie(page: Page): Promise<boolean> {
  try {
    const cookies = await page.context().cookies();
    return cookies.some((c) => c.name.toLowerCase().includes("x5sec"));
  } catch {
    return false;
  }
}

async function tryDragSlider(
  root: Page | Frame,
): Promise<{ ok: boolean; selector?: string }> {
  for (const selector of SLIDER_SELECTORS) {
    try {
      const handle = await root.$(selector);
      if (!handle) continue;
      const visible = await handle.isVisible().catch(() => false);
      if (!visible) continue;

      const box = await handle.boundingBox();
      if (!box) continue;

      const page = "page" in root && typeof (root as Frame).page === "function"
        ? (root as Frame).page()
        : (root as Page);

      const startX = box.x + Math.min(12, box.width / 2);
      const startY = box.y + box.height / 2;
      const distance = Math.max(260, Math.floor(box.width + 220));

      await page.mouse.move(startX, startY, {
        steps: 4 + Math.floor(Math.random() * 4),
      });
      await sleep(humanDelay(40, 120));
      await page.mouse.down();

      // Human-ish multi-step drag
      const steps = 18 + Math.floor(Math.random() * 10);
      for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        // Ease-out with light noise
        const eased = 1 - Math.pow(1 - progress, 2.2);
        const x = startX + distance * eased + (Math.random() - 0.5) * 2.2;
        const y = startY + (Math.random() - 0.5) * 3.5;
        await page.mouse.move(x, y, { steps: 1 });
        await sleep(8 + Math.floor(Math.random() * 18));
      }

      await page.mouse.up();
      await sleep(humanDelay(500, 1200));
      return { ok: true, selector };
    } catch {
      // try next selector
    }
  }
  return { ok: false };
}

async function attemptSliderOnPage(page: Page): Promise<{
  ok: boolean;
  selector?: string;
}> {
  const direct = await tryDragSlider(page);
  if (direct.ok) return direct;

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const framed = await tryDragSlider(frame);
    if (framed.ok) return framed;
  }
  return { ok: false };
}

async function waitForChallengeClear(
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const signal = await pageHasChallengeSignals(page);
    if (!signal.challenged) {
      // Prefer also seeing chat shell / non-punish host path
      const url = page.url();
      if (!/_____tmd_____|punish/i.test(url)) {
        return true;
      }
    }
    if (await hasX5secCookie(page)) {
      // Cookie alone is promising; give UI a moment to settle
      await sleep(400);
      const after = await pageHasChallengeSignals(page);
      if (!after.challenged) return true;
    }
    await sleep(350);
  }
  return false;
}

async function softSessionWarmup(page: Page): Promise<void> {
  await page
    .goto("https://chat.qwen.ai/", {
      waitUntil: "domcontentloaded",
      timeout: config.timeouts.navigation,
    })
    .catch(() => {});
  await sleep(humanDelay(400, 900));
  await subtlePageActivity(page).catch(() => {});
}

/**
 * Attempt to recover an account blocked by TMD/captcha using its Playwright page.
 * Single-flight per account; respects min interval between solves.
 */
export async function recoverAntiBotChallenge(
  accountId: string,
): Promise<CaptchaSolveResult> {
  const started = Date.now();

  if (!config.captchaSolver.enabled) {
    return {
      success: false,
      method: "disabled",
      detail: "CAPTCHA_SOLVER_ENABLED=false",
      durationMs: 0,
    };
  }

  if (!isPlaywrightInitialized(accountId)) {
    return {
      success: false,
      method: "failed",
      detail: "playwright_not_initialized",
      durationMs: Date.now() - started,
    };
  }

  const existing = inFlight.get(accountId);
  if (existing) return existing;

  const last = lastSolveAt.get(accountId) ?? 0;
  if (Date.now() - last < config.captchaSolver.minIntervalMs) {
    return {
      success: false,
      method: "skipped_recent",
      detail: `min_interval_${config.captchaSolver.minIntervalMs}ms`,
      durationMs: Date.now() - started,
    };
  }

  const promise = (async (): Promise<CaptchaSolveResult> => {
    lastSolveAt.set(accountId, Date.now());
    const budgetMs = config.captchaSolver.timeoutMs;
    const deadline = Date.now() + budgetMs;

    try {
      // Phase 1: warm page + capture fresh anti-fraud headers
      await withAccountPage(accountId, async (page) => {
        await softSessionWarmup(page);
      });
      await refreshHeaders(accountId);

      let signal = await withAccountPage(accountId, (page) =>
        pageHasChallengeSignals(page),
      );

      // Phase 2: if challenge not visible yet, force a tiny in-page completions
      // probe so Alibaba may render punish page / widgets.
      if (!signal.challenged && Date.now() < deadline) {
        await withAccountPage(accountId, async (page) => {
          await page
            .evaluate(async () => {
              try {
                await fetch("/api/v2/chat/completions", {
                  method: "POST",
                  credentials: "include",
                  headers: {
                    accept: "application/json, text/plain, */*",
                    "content-type": "application/json",
                    source: "web",
                  },
                  body: JSON.stringify({
                    stream: false,
                    model: "qwen3.5-flash",
                    messages: [{ role: "user", content: "ping" }],
                  }),
                });
              } catch {
                // ignore; we only care if a challenge UI appears
              }
            })
            .catch(() => {});
          await sleep(humanDelay(500, 1000));
        });
        signal = await withAccountPage(accountId, (page) =>
          pageHasChallengeSignals(page),
        );
      }

      if (!signal.challenged) {
        // Headers refresh alone is still valuable against stale bx tokens
        return {
          success: true,
          method: "headers_only",
          detail: "no_visible_challenge_after_refresh",
          durationMs: Date.now() - started,
        };
      }

      console.log(
        `🧩 [Captcha] Challenge detected for ${accountId} (${signal.reason}); attempting solve...`,
      );

      // Phase 3: slider attempts within remaining budget
      let sliderSelector: string | undefined;
      for (
        let attempt = 0;
        attempt < config.captchaSolver.maxSliderAttempts &&
        Date.now() < deadline;
        attempt++
      ) {
        const dragged = await withAccountPage(accountId, (page) =>
          attemptSliderOnPage(page),
        );
        if (dragged.ok) {
          sliderSelector = dragged.selector;
          break;
        }
        await sleep(humanDelay(250, 600));
      }

      const remaining = Math.max(800, deadline - Date.now());
      const cleared = await withAccountPage(accountId, (page) =>
        waitForChallengeClear(page, remaining),
      );

      await refreshHeaders(accountId);

      if (cleared) {
        console.log(
          `✅ [Captcha] Challenge cleared for ${accountId}${sliderSelector ? ` via ${sliderSelector}` : ""}`,
        );
        return {
          success: true,
          method: sliderSelector ? "slider" : "wait_cleared",
          detail: sliderSelector || signal.reason,
          durationMs: Date.now() - started,
        };
      }

      return {
        success: false,
        method: "failed",
        detail: `challenge_uncleared:${signal.reason}`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        method: "failed",
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  })();

  inFlight.set(accountId, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(accountId);
  }
}

/** Test helper — clear per-account solve throttles. */
export function resetCaptchaSolverStateForTests(): void {
  lastSolveAt.clear();
  inFlight.clear();
}
