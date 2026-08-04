import { metrics } from "../core/metrics.ts";
import { config } from "../core/config.ts";
import { withAccountPage } from "./playwright.ts";
import {
  logBaxiaCaptcha,
  solveBaxiaCaptcha,
} from "./captcha-solver.ts";

/**
 * Run the configured first-party challenge adapter without rotating accounts.
 * The account page mutex prevents a challenge solve from racing login, header
 * capture, settings sync, or another page mutation.
 */
export async function recoverBaxiaCaptcha(
  accountId: string | undefined,
  label: string,
): Promise<boolean> {
  if (!config.captcha.enabled || !accountId) return false;

  const solver = "baxia";
  const startedAt = Date.now();
  metrics.increment("captcha.challenges.detected", 1, { solver });

  // The slider itself waits up to 5s for each attempt. Keep the page
  // operation alive for the full bounded solver budget so a slow challenge
  // cannot be mistaken for a stuck browser and reset the account context.
  const solverOperationTimeoutMs = Math.max(
    config.timeouts.page,
    config.captcha.timeoutMs +
      config.captcha.maxAttempts *
        (5_000 + config.captcha.retryDelayMs + config.captcha.settleMs) +
      5_000,
  );

  try {
    const solved = await withAccountPage(
      accountId,
      (page) =>
        solveBaxiaCaptcha(page, {
          maxAttempts: config.captcha.maxAttempts,
          waitForMs: config.captcha.timeoutMs,
          retryDelayMs: config.captcha.retryDelayMs,
          settleMs: config.captcha.settleMs,
        }),
      solverOperationTimeoutMs,
      Math.min(config.timeouts.page, 5_000),
    );

    metrics.histogram("captcha.solve.duration", Date.now() - startedAt, {
      solver,
    });

    if (solved) {
      metrics.increment("captcha.solves.succeeded", 1, { solver });
      logBaxiaCaptcha("recovery_succeeded", { target: label });
      return true;
    }

    metrics.increment("captcha.solves.failed", 1, { solver });
    logBaxiaCaptcha("recovery_not_solved", { target: label });
    return false;
  } catch (error) {
    metrics.increment("captcha.solves.failed", 1, { solver });
    const errorKind = error instanceof Error ? error.name : "UnknownError";
    logBaxiaCaptcha("recovery_failed", { target: label, error: errorKind });
    return false;
  }
}
