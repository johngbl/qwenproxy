import type { Page } from "playwright";
import { metrics } from "../core/metrics.ts";
import { config } from "../core/config.ts";
import { withAccountPage } from "./playwright.ts";
import { qwenUrl } from "./qwen-url.ts";
import {
  extractBaxiaChallengeUrl,
  logBaxiaCaptcha,
  solveBaxiaCaptcha,
} from "./captcha-solver.ts";

const CHALLENGE_NAVIGATION_TIMEOUT_MS = 20_000;
const CHALLENGE_PATH_MARKER = "_____tmd_____";

/**
 * A challenge that could not be solved seconds ago will not be solvable on the
 * immediate retry either. Without this window every attempt of the request
 * retry loop pays the full solver budget again, which is what turned a single
 * unsolved challenge into minutes of dead time.
 */
const FAILED_RECOVERY_BACKOFF_MS = 30_000;
const lastFailedRecoveryAt = new Map<string, number>();

/** Exported for tests: forget the per-account failed-recovery backoff. */
export function resetCaptchaRecoveryState(): void {
  lastFailedRecoveryAt.clear();
}

async function gotoBestEffort(page: Page, url: string): Promise<void> {
  // A WAF-blocked navigation can time out while still having rendered the
  // challenge, so a failure here must not abort the solve attempt.
  await page
    .goto(url, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(
        config.timeouts.navigation,
        CHALLENGE_NAVIGATION_TIMEOUT_MS,
      ),
    })
    .catch(() => undefined);
}

/**
 * Make the challenge visible in the account page and solve it.
 *
 * Exported so the recovery sequence can be exercised without a live browser.
 */
export async function solveChallengeOnPage(
  page: Page,
  challengeUrl: string | null,
  waitForMs = config.captcha.timeoutMs,
): Promise<boolean> {
  const solverOptions = {
    maxAttempts: config.captcha.maxAttempts,
    retryDelayMs: config.captcha.retryDelayMs,
    settleMs: config.captcha.settleMs,
  };

  // Qwen's own Baxia SDK sometimes renders the dialog for the background
  // fetch. When it did, solve it in place: navigating away would discard the
  // challenge the SDK is waiting on.
  if (await solveBaxiaCaptcha(page, { ...solverOptions, waitForMs: 0 })) {
    return true;
  }

  logBaxiaCaptcha(
    "challenge_opened",
    { source: challengeUrl ? "response_body" : "chat_reload" },
    true,
  );
  await gotoBestEffort(page, challengeUrl ?? qwenUrl("/"));

  try {
    return await solveBaxiaCaptcha(page, { ...solverOptions, waitForMs });
  } finally {
    // Never leave the account page parked on the punish document: a stale
    // challenge page makes the next detection pass find itself.
    if (page.url().includes(CHALLENGE_PATH_MARKER)) {
      await gotoBestEffort(page, qwenUrl("/"));
    }
  }
}

/**
 * Run the configured first-party challenge adapter without rotating accounts.
 * The account page mutex prevents a challenge solve from racing login, header
 * capture, settings sync, or another page mutation.
 *
 * `challengeBody` is the upstream response that was identified as a challenge.
 * The completion request runs as a background fetch, so the WAF answers it with
 * a punish document that is never rendered; opening that document in the page
 * is what gives the solver a slider to drive.
 */
export async function recoverBaxiaCaptcha(
  accountId: string | undefined,
  label: string,
  options: { challengeBody?: string } = {},
): Promise<boolean> {
  if (!config.captcha.enabled || !accountId) return false;

  const solver = "baxia";
  const startedAt = Date.now();

  const lastFailure = lastFailedRecoveryAt.get(accountId) ?? 0;
  if (startedAt - lastFailure < FAILED_RECOVERY_BACKOFF_MS) {
    logBaxiaCaptcha("recovery_skipped", { target: label }, true);
    return false;
  }

  metrics.increment("captcha.challenges.detected", 1, { solver });

  const challengeUrl = options.challengeBody
    ? extractBaxiaChallengeUrl(options.challengeBody, config.qwen.baseUrl)
    : null;

  // The slider itself waits up to 5s for each attempt. Keep the page
  // operation alive for the full bounded solver budget so a slow challenge
  // cannot be mistaken for a stuck browser and reset the account context.
  // Two navigations (open the challenge, return to the chat page) are part of
  // the recovery, so their budget belongs in the same total.
  const solverOperationTimeoutMs = Math.max(
    config.timeouts.page,
    config.captcha.timeoutMs +
      config.captcha.maxAttempts *
        (5_000 + config.captcha.retryDelayMs + config.captcha.settleMs) +
      2 * CHALLENGE_NAVIGATION_TIMEOUT_MS +
      5_000,
  );

  try {
    const solved = await withAccountPage(
      accountId,
      (page) => solveChallengeOnPage(page, challengeUrl),
      solverOperationTimeoutMs,
      Math.min(config.timeouts.page, 5_000),
    );

    metrics.histogram("captcha.solve.duration", Date.now() - startedAt, {
      solver,
    });

    if (solved) {
      lastFailedRecoveryAt.delete(accountId);
      metrics.increment("captcha.solves.succeeded", 1, { solver });
      logBaxiaCaptcha("recovery_succeeded", { target: label });
      return true;
    }

    lastFailedRecoveryAt.set(accountId, Date.now());
    metrics.increment("captcha.solves.failed", 1, { solver });
    logBaxiaCaptcha("recovery_not_solved", { target: label });
    return false;
  } catch (error) {
    lastFailedRecoveryAt.set(accountId, Date.now());
    metrics.increment("captcha.solves.failed", 1, { solver });
    const errorKind = error instanceof Error ? error.name : "UnknownError";
    logBaxiaCaptcha("recovery_failed", { target: label, error: errorKind });
    return false;
  }
}
