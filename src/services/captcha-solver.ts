import type { Locator, Page } from "patchright";
import { humanDrag, sleep } from "./human-behavior.ts";


export const BAXIA_DIALOG_SELECTOR = ".baxia-dialog";
export const BAXIA_CONTENT_SELECTOR = "#baxia-dialog-content";

const CAPTCHA_EVENT_EMOJI: Record<string, string> = {
  dialog_detected: "🛡️",
  challenge_opened: "🚪",
  challenge_reload: "🔄",
  recovery_skipped: "⏭️",
  iframe_found: "🖼️",
  challenge_detected: "🧩",
  challenge_not_found: "🔎",
  solve_started: "🛠️",
  slider_found: "🎚️",
  attempt_bounds_unavailable: "📍",
  attempt_geometry: "📐",
  attempt_not_solved: "⚠️",
  attempt_failed: "💥",
  slider_not_found: "❌",
  solve_succeeded: "✅",
  solve_failed: "❌",
  recovery_succeeded: "✅",
  recovery_not_solved: "⚠️",
  recovery_failed: "❌",
  aliyun_detected: "🧩",
  aliyun_offset_failed: "📐",
  aliyun_geometry: "📐",
  aliyun_solve_succeeded: "✅",
  aliyun_solve_failed: "❌",
};

const captchaDebugEnabled = process.env.CAPTCHA_DEBUG === "true";

function formatCaptchaLogValue(value: string | number | boolean): string {
  if (typeof value === "string") {
    return JSON.stringify(value.replace(/\s+/g, " ").slice(0, 160));
  }
  return String(value);
}

export function logBaxiaCaptcha(
  event: string,
  fields: Record<string, string | number | boolean> = {},
  important = false,
): void {
  if (!important && !captchaDebugEnabled) return;

  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${formatCaptchaLogValue(value)}`)
    .join(" ");
  const emoji = CAPTCHA_EVENT_EMOJI[event] ?? "ℹ️";
  const line = `${emoji} [Captcha] ${event}${suffix ? ` | ${suffix}` : ""}`;

  if (important) {
    console.warn(line);
  } else {
    console.log(line);
  }
}

const BAXIA_IFRAME_SELECTORS = [
  `${BAXIA_DIALOG_SELECTOR} ${BAXIA_CONTENT_SELECTOR} iframe`,
  `${BAXIA_CONTENT_SELECTOR} iframe`,
  "iframe#baxia-dialog-content",
  'iframe[src*="_____tmd_____/punish"]',
  'iframe[src*="nocaptcha"]',
] as const;

const BAXIA_DOCUMENT_SELECTORS = [
  "#nocaptcha",
  "#baxia-punish .nc-container",
  "#baxia-punish",
] as const;

/**
 * Kept as a public selector for callers that need to identify a Baxia iframe.
 * The current Baxia page may use #baxia-dialog-content as a container around
 * the iframe, while older versions used the id directly on the iframe.
 */
export const BAXIA_IFRAME_SELECTOR = BAXIA_IFRAME_SELECTORS.join(", ");

const BAXIA_SLIDER_SELECTOR =
  "#nc_1_n1z, .nc_1_n1z, .btn_slide, .nc_iconfont.btn_slide, span[id*=\"_n1z\"], .nc_wrapper .btn_slide, ._nc .btn_slide, .nc-container .btn_slide";
const BAXIA_TRACK_SELECTOR =
  "#nc_1_n1t, .nc_scale, span[id*=\"_n1t\"], .nc_wrapper .nc_scale, ._nc .nc_scale, .nc-container .nc_scale";
const BAXIA_SUCCESS_SELECTOR =
  ".btn_ok, .nc_ok, .nc_success, .nc_result, .nc_wrapper.nc-success, .nc_wrapper.success, [data-nc-lang=\"SUCCESS\"], [data-nc-lang=\"success\"], #nc-loading-circle";
const BAXIA_RELOAD_SELECTOR =
  "#nc_1_refresh1, .errloading a, .nc-container .errloading a, .btn_refresh, .clickCaptcha_text .btn_refresh, [data-nc-lang=\"REFRESH\"], a[id*=\"refresh\"]";
/**
 * A challenge served to a background fetch never renders anything: the WAF
 * answers the XHR with the punish document instead of the expected payload, so
 * the solver has no visible slider to drive. The body carries the challenge
 * URL, which the account page can open to make the same challenge visible.
 */
export function extractBaxiaChallengeUrl(
  body: string,
  baseUrl: string,
): string | null {
  if (!body) return null;

  // The URL arrives wrapped in JSON, an HTML attribute or a meta refresh, each
  // with its own escaping. Normalize before matching so one pattern covers all.
  const normalized = body
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");

  const candidates = normalized.match(
    /(?:https?:)?\/\/[^\s"'`\\<>()]*(?:_____tmd_____|x5secdata=)[^\s"'`\\<>()]*|\/[^\s"'`\\<>()]*(?:_____tmd_____|x5secdata=)[^\s"'`\\<>()]*/gi,
  );
  if (!candidates) return null;

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }

  for (const candidate of candidates) {
    let url: URL;
    try {
      url = new URL(candidate, base);
    } catch {
      continue;
    }
    // The body is attacker-influenced content. Only the Qwen origin itself may
    // be opened in the authenticated account page.
    if (url.protocol !== base.protocol || url.host !== base.host) continue;
    return url.toString();
  }
  return null;
}

export interface BaxiaSolverOptions {
  maxAttempts?: number;
  waitForMs?: number;
  retryDelayMs?: number;
  settleMs?: number;
  sliderTimeoutMs?: number;
}

interface BaxiaLocatorContext {
  locator(selector: string): Locator;
}

interface BaxiaChallengeTarget {
  /** Null means the NC document is the top-level document, not an iframe. */
  iframeSelector: string | null;
  locator: Locator;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_SETTLE_MS = 2_000;
const DEFAULT_SLIDER_TIMEOUT_MS = 8_000;

/**
 * Aliyun WAF jigsaw challenge used by the sign-in page. It is a separate
 * widget from the Baxia/TMD NC dialog: an embedded block (not an iframe) with
 * a background image, a transparent puzzle piece, and its own slider track.
 */
export const ALIYUN_WAF_CAPTCHA_SELECTOR = "#waf_nc_block";
export const ALIYUN_WAF_CAPTCHA_WIDGET = "#aliyunCaptcha-window-embed";
const ALIYUN_WAF_BLOCK_SELECTORS = [
  ALIYUN_WAF_CAPTCHA_SELECTOR,
  ALIYUN_WAF_CAPTCHA_WIDGET,
] as const;
const ALIYUN_PUZZLE_BACKGROUND_SELECTOR = "#aliyunCaptcha-img";
const ALIYUN_PUZZLE_PIECE_SELECTOR = "#aliyunCaptcha-puzzle";
const ALIYUN_PUZZLE_SLIDER_SELECTOR = "#aliyunCaptcha-sliding-slider";
const ALIYUN_PUZZLE_TRACK_SELECTOR = "#aliyunCaptcha-sliding-body";

interface AliyunPuzzleOffset {
  ok: boolean;
  offsetX?: number;
  naturalWidth?: number;
  reason?: string;
}

async function findVisibleLocatorWithin(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
): Promise<{ selector: string; locator: Locator } | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    const found = await findVisibleLocator(page, selectors);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(150, Math.max(1, deadline - Date.now())));
  }
}

async function waitForHidden(locator: Locator, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    if (!(await isVisible(locator))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Locate the hole in the background image by scoring the vertical edges of
 * the puzzle-piece silhouette against the background gradients. Returns the
 * horizontal offset in the image's natural coordinate space.
 */
async function computeAliyunPuzzleOffset(
  page: Page,
): Promise<AliyunPuzzleOffset> {
  return page.evaluate(async (): Promise<AliyunPuzzleOffset> => {
    const background = document.querySelector(
      "#aliyunCaptcha-img",
    ) as HTMLImageElement | null;
    const piece = document.querySelector(
      "#aliyunCaptcha-puzzle",
    ) as HTMLImageElement | null;
    if (!background || !piece) {
      return { ok: false, reason: "missing puzzle images" };
    }

    if (!background.complete || !piece.complete) {
      const loaded = await new Promise<boolean>((resolve) => {
        let settled = false;
        background.addEventListener(
          "load",
          () => {
            if (!settled && background.complete && piece.complete) {
              settled = true;
              resolve(true);
            }
          },
          { once: true },
        );
        piece.addEventListener(
          "load",
          () => {
            if (!settled && background.complete && piece.complete) {
              settled = true;
              resolve(true);
            }
          },
          { once: true },
        );
        background.addEventListener(
          "error",
          () => {
            if (!settled) {
              settled = true;
              resolve(false);
            }
          },
          { once: true },
        );
        piece.addEventListener(
          "error",
          () => {
            if (!settled) {
              settled = true;
              resolve(false);
            }
          },
          { once: true },
        );
        setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        }, 2_000);
      });
      if (!loaded && (!background.complete || !piece.complete)) {
        return { ok: false, reason: "puzzle image load error" };
      }
    }

    try {
      const width = background.naturalWidth;
      const height = background.naturalHeight;
      const pieceWidth = piece.naturalWidth;
      const pieceHeight = piece.naturalHeight;
      if (!width || !height || !pieceWidth || !pieceHeight) {
        return { ok: false, reason: "image dimensions unavailable" };
      }

      const backgroundCanvas = document.createElement("canvas");
      // The anti-fingerprinting getImageData noise must not touch the
      // solver's own canvas: a ±1 pixel shift corrupts edge scoring.
      backgroundCanvas.id = "captcha-solver-canvas";
      backgroundCanvas.width = width;
      backgroundCanvas.height = height;
      const backgroundContext = backgroundCanvas.getContext("2d");
      if (!backgroundContext) {
        return { ok: false, reason: "no background context" };
      }

      const pieceCanvas = document.createElement("canvas");
      pieceCanvas.id = "captcha-solver-canvas";
      pieceCanvas.width = pieceWidth;
      pieceCanvas.height = pieceHeight;
      const pieceContext = pieceCanvas.getContext("2d");
      if (!pieceContext) {
        return { ok: false, reason: "no piece context" };
      }

      try {
        backgroundContext.drawImage(background, 0, 0);
      } catch {
        return { ok: false, reason: "background canvas tainted" };
      }
      try {
        pieceContext.drawImage(piece, 0, 0);
      } catch {
        return { ok: false, reason: "puzzle canvas tainted" };
      }

      const backgroundData = backgroundContext.getImageData(
        0,
        0,
        width,
        height,
      ).data;
      const pieceData = pieceContext.getImageData(
        0,
        0,
        pieceWidth,
        pieceHeight,
      ).data;

      let pieceMinX = pieceWidth;
      let pieceMaxX = -1;
      let pieceMinY = pieceHeight;
      let pieceMaxY = -1;
      for (let y = 0; y < pieceHeight; y++) {
        for (let x = 0; x < pieceWidth; x++) {
          if (pieceData[(y * pieceWidth + x) * 4 + 3] > 100) {
            if (x < pieceMinX) pieceMinX = x;
            if (x > pieceMaxX) pieceMaxX = x;
            if (y < pieceMinY) pieceMinY = y;
            if (y > pieceMaxY) pieceMaxY = y;
          }
        }
      }
      const puzzleWidth = pieceMaxX - pieceMinX + 1;
      if (puzzleWidth <= 0) {
        return { ok: false, reason: "empty puzzle piece" };
      }

      const yStart = Math.max(1, Math.min(height - 2, pieceMinY + 5));
      const yEnd = Math.max(
        yStart,
        Math.min(height - 2, pieceMaxY - 5),
      );
      const columnGradients = new Float32Array(width);
      for (let x = 1; x < width - 1; x++) {
        let gradient = 0;
        for (let y = yStart; y <= yEnd; y++) {
          const left = (y * width + x - 1) * 4;
          const right = (y * width + x + 1) * 4;
          gradient +=
            Math.abs(backgroundData[right] - backgroundData[left]) +
            Math.abs(backgroundData[right + 1] - backgroundData[left + 1]) +
            Math.abs(backgroundData[right + 2] - backgroundData[left + 2]);
        }
        columnGradients[x] = gradient;
      }

      let bestX = 0;
      let bestScore = 0;
      const minCandidateX = 30;
      const maxCandidateX = width - puzzleWidth - 20;
      for (
        let candidateX = minCandidateX;
        candidateX <= maxCandidateX;
        candidateX++
      ) {
        let leftMax = 0;
        for (let dx = -2; dx <= 2; dx++) {
          const value = columnGradients[candidateX + pieceMinX + dx] || 0;
          if (value > leftMax) leftMax = value;
        }
        let rightMax = 0;
        for (let dx = -3; dx <= 1; dx++) {
          const value = columnGradients[candidateX + pieceMaxX + dx] || 0;
          if (value > rightMax) rightMax = value;
        }
        const score = Math.sqrt(leftMax * rightMax);
        if (score > bestScore) {
          bestScore = score;
          bestX = candidateX;
        }
      }

      if (bestScore <= 0) {
        return { ok: false, reason: "no matching hole edge" };
      }
      return {
        ok: true,
        offsetX: bestX - pieceMinX,
        naturalWidth: width,
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export interface AliyunWafSolverOptions {
  maxAttempts?: number;
  waitForMs?: number;
  retryDelayMs?: number;
  settleMs?: number;
  sliderTimeoutMs?: number;
}

/**
 * Solve the Aliyun WAF jigsaw challenge rendered on the sign-in page. The
 * widget is not inside an iframe and its puzzle geometry comes from the two
 * server-supplied images, so the solver locates the hole by image analysis
 * before driving the slider with the same human-like drag as Baxia.
 */
export async function solveAliyunWafCaptcha(
  page: Page,
  options: AliyunWafSolverOptions = {},
): Promise<boolean> {
  const waitForMs = Math.max(0, options.waitForMs ?? 0);
  const maxAttempts = Math.max(
    1,
    Math.min(5, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
  );
  const retryDelayMs = Math.max(
    0,
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
  );
  const settleMs = Math.max(0, options.settleMs ?? DEFAULT_SETTLE_MS);
  const sliderTimeoutMs = Math.max(
    500,
    options.sliderTimeoutMs ?? DEFAULT_SLIDER_TIMEOUT_MS,
  );

  const detected = await findVisibleLocatorWithin(
    page,
    ALIYUN_WAF_BLOCK_SELECTORS,
    waitForMs,
  );
  if (!detected) return false;

  // The same physical-pointer rule as Baxia: two solvers must never
  // interleave drag events on one browser.
  return withCaptchaMouseLock(async () => {
    const block = detected.locator;
    if (!(await isVisible(block))) return false;
    logBaxiaCaptcha("aliyun_detected", { selector: detected.selector });

    if (typeof page.evaluate === "function") {
      await page
        .evaluate(() => {
          try {
            if (document.exitPointerLock) document.exitPointerLock();
            window.focus();
          } catch {}
        })
        .catch(() => {});
    }

    let lastReason = "unknown";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const offset = await computeAliyunPuzzleOffset(page);
        if (
          !offset.ok ||
          typeof offset.offsetX !== "number" ||
          typeof offset.naturalWidth !== "number" ||
          offset.naturalWidth <= 0
        ) {
          lastReason = offset.reason || "offset_unavailable";
          logBaxiaCaptcha("aliyun_offset_failed", {
            attempt,
            reason: lastReason,
          });
        } else {
          const slider = page.locator(ALIYUN_PUZZLE_SLIDER_SELECTOR).first();
          const track = page.locator(ALIYUN_PUZZLE_TRACK_SELECTOR).first();
          await slider.waitFor({ state: "visible", timeout: sliderTimeoutMs });
          const [sliderBox, trackBox] = await Promise.all([
            slider.boundingBox(),
            track.boundingBox(),
          ]);
          if (!sliderBox || !trackBox || trackBox.width <= 0) {
            lastReason = "bounds_unavailable";
            logBaxiaCaptcha("aliyun_offset_failed", {
              attempt,
              reason: lastReason,
            });
          } else {
            const scale = trackBox.width / offset.naturalWidth;
            const dragDistance = Math.round(offset.offsetX * scale);
            logBaxiaCaptcha("aliyun_geometry", {
              attempt,
              offset: offset.offsetX,
              scale: Number(scale.toFixed(2)),
              distance: dragDistance,
            });
            if (dragDistance <= 0) {
              lastReason = "non_positive_distance";
            } else {
              const startX = sliderBox.x + sliderBox.width / 2;
              const startY = sliderBox.y + sliderBox.height / 2;
              await humanDrag(
                page,
                startX,
                startY,
                startX + dragDistance,
                startY,
              );
              if (await waitForHidden(block, settleMs)) {
                logBaxiaCaptcha(
                  "aliyun_solve_succeeded",
                  { attempt, distance: dragDistance },
                  true,
                );
                return true;
              }
              lastReason = "not_solved";
            }
          }
        }
      } catch (error) {
        lastReason =
          error instanceof Error ? error.name : "UnknownError";
        logBaxiaCaptcha("aliyun_offset_failed", {
          attempt,
          error: lastReason,
          detail: sanitizeCaptchaErrorDetail(error),
        });
      }

      if (attempt < maxAttempts && retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }

    logBaxiaCaptcha(
      "aliyun_solve_failed",
      { attempts: maxAttempts, reason: lastReason },
      true,
    );
    return false;
  });
}

/** Aliyun's widget lives only on the auth page and renders quickly; probing it
 * for the whole Baxia budget would leave the NC dialog unsolved. */
const ALIYUN_PROBE_MAX_WAIT_MS = 2_000;

/**
 * Solve whichever first-party challenge is currently rendered. Called by the
 * login flow (Aliyun jigsaw) and the chat helpers (Baxia NC).
 */
export async function solveVisibleCaptcha(
  page: Page,
  options: BaxiaSolverOptions = {},
): Promise<boolean> {
  if (typeof page.isClosed === "function" && page.isClosed()) return false;

  // Split the wait budget between the two solvers instead of letting the
  // Aliyun probe (absent on chat pages) consume all of it.
  const totalWaitMs = Math.max(0, options.waitForMs ?? 0);
  const aliyunWaitMs = Math.min(totalWaitMs, ALIYUN_PROBE_MAX_WAIT_MS);
  const startedAt = Date.now();
  if (
    await solveAliyunWafCaptcha(page, { ...options, waitForMs: aliyunWaitMs })
  ) {
    return true;
  }
  const remainingWaitMs = Math.max(
    0,
    totalWaitMs - (Date.now() - startedAt),
  );
  return solveBaxiaCaptcha(page, { ...options, waitForMs: remainingWaitMs });
}

async function isVisible(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

async function findVisibleLocator(
  page: Page,
  selectors: readonly string[],
): Promise<{ selector: string; locator: Locator } | null> {
  for (const selector of selectors) {
    const candidate = page.locator(selector).first();
    if (await isVisible(candidate)) {
      return { selector, locator: candidate };
    }
  }
  return null;
}

async function findVisibleIframe(
  page: Page,
): Promise<BaxiaChallengeTarget | null> {
  const iframe = await findVisibleLocator(page, BAXIA_IFRAME_SELECTORS);
  return iframe
    ? { iframeSelector: iframe.selector, locator: iframe.locator }
    : null;
}

async function findVisibleDocument(
  page: Page,
): Promise<BaxiaChallengeTarget | null> {
  const documentTarget = await findVisibleLocator(
    page,
    BAXIA_DOCUMENT_SELECTORS,
  );
  return documentTarget
    ? { iframeSelector: null, locator: documentTarget.locator }
    : null;
}

async function detectBaxiaChallenge(
  page: Page,
  timeoutMs: number,
): Promise<{
  dialogLocator: Locator;
  contentLocator: Locator;
  target: BaxiaChallengeTarget;
} | null> {
  const dialogLocator = page.locator(BAXIA_DIALOG_SELECTOR).first();
  const contentLocator = page.locator(BAXIA_CONTENT_SELECTOR).first();
  const topLevelRootLocator = page.locator("#baxia-punish").first();
  const deadline = Date.now() + timeoutMs;
  let dialogReported = false;

  while (true) {
    const dialogVisible = await isVisible(dialogLocator);
    const contentVisible = await isVisible(contentLocator);
    if ((dialogVisible || contentVisible) && !dialogReported) {
      logBaxiaCaptcha("dialog_detected");
      dialogReported = true;
    }

    const iframe = await findVisibleIframe(page);
    if (iframe) {
      logBaxiaCaptcha("iframe_found");
      return { dialogLocator, contentLocator, target: iframe };
    }

    const documentTarget = await findVisibleDocument(page);
    if (documentTarget) {
      logBaxiaCaptcha("challenge_detected", { scope: "top_level" });
      return {
        dialogLocator,
        // In this mode #baxia-punish/#nocaptcha is the challenge surface.
        contentLocator: (await isVisible(topLevelRootLocator))
          ? topLevelRootLocator
          : documentTarget.locator,
        target: documentTarget,
      };
    }

    if (Date.now() >= deadline) break;
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }

  if (dialogReported) {
    logBaxiaCaptcha("challenge_not_found", { scope: "dialog" });
  }
  return null;
}

async function hasSolvedState(
  challengeLocator: Locator,
  dialogLocator: Locator,
  contentLocator: Locator,
  frame: BaxiaLocatorContext,
): Promise<boolean> {
  const [challengeVisible, dialogVisible, contentVisible] = await Promise.all([
    isVisible(challengeLocator),
    isVisible(dialogLocator),
    isVisible(contentLocator),
  ]);

  // Baxia calls hide(true) on the outer dialog after it receives the success
  // message. Treat the challenge as solved only after its visible surfaces are
  // gone, which avoids refreshing headers while the postMessage is in flight.
  if (!challengeVisible && !dialogVisible && !contentVisible) return true;

  for (const selector of BAXIA_SUCCESS_SELECTOR.split(", ")) {
    if (await isVisible(frame.locator(selector.trim()))) return true;
  }
  return false;
}

async function waitForSolvedState(
  challengeLocator: Locator,
  dialogLocator: Locator,
  contentLocator: Locator,
  frame: BaxiaLocatorContext,
  timeoutMs: number,
): Promise<boolean> {
  if (await hasSolvedState(challengeLocator, dialogLocator, contentLocator, frame)) {
    return true;
  }
  if (timeoutMs <= 0) return false;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    if (
      await hasSolvedState(
        challengeLocator,
        dialogLocator,
        contentLocator,
        frame,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function sanitizeCaptchaErrorDetail(error: unknown): string {
  const message =
    error instanceof Error ? error.message || error.name : String(error);
  return message
    .replace(/https?:\/\/[^\s"'`<>]+/gi, "<url>")
    .replace(/\/[^\s"'`<>]*_____tmd_____[^\s"'`<>]*/gi, "<challenge-path>")
    .replace(/x5secdata=[^\s"'`<>]*/gi, "x5secdata=<redacted>")
    .replace(/data:image\/[^\s"'`<>]+/gi, "<image-data>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

// Global mouse lock: the NC slider drag is a physical pointer interaction —
// two concurrent solvers on the same browser would interleave mouse events.
let captchaMouseLock: Promise<void> = Promise.resolve();

async function withCaptchaMouseLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = captchaMouseLock;
  const { promise: gate, resolve } = Promise.withResolvers<void>();
  captchaMouseLock = gate;
  await previous;
  try {
    return await fn();
  } finally {
    resolve();
  }
}

/**
 * Solve a Baxia/TMD slider challenge already present in the account page.
 *
 * This adapter interacts only with the visible first-party NC challenge. It
 * supports both the usual iframe dialog and a challenge document rendered
 * directly in the page. It does not capture screenshots, HTML, cookies, or
 * challenge tokens.
 */
export async function solveBaxiaCaptcha(
  page: Page,
  options: BaxiaSolverOptions = {},
): Promise<boolean> {
  // One physical mouse per browser: with concurrent relay streams on one page
  // two watchers could interleave drag events and break each other's slider.
  // Serialize the whole solve (upstream captcha-solver uses the same lock).
  return await withCaptchaMouseLock(() => solveBaxiaCaptchaUnlocked(page, options));
}

async function solveBaxiaCaptchaUnlocked(
  page: Page,
  options: BaxiaSolverOptions = {},
): Promise<boolean> {
  const waitForMs = Math.max(0, options.waitForMs ?? 0);
  const maxAttempts = Math.max(
    1,
    Math.min(5, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
  );
  const retryDelayMs = Math.max(
    0,
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
  );
  const settleMs = Math.max(0, options.settleMs ?? DEFAULT_SETTLE_MS);
  const sliderTimeoutMs = Math.max(
    500,
    options.sliderTimeoutMs ?? DEFAULT_SLIDER_TIMEOUT_MS,
  );

  const detected = await detectBaxiaChallenge(page, waitForMs);
  if (!detected) return false;

  const scope = detected.target.iframeSelector ? "iframe" : "top_level";
  let lastGeometry: { track?: number; slider?: number; distance?: number } = {};
  let lastReason = "unknown";
  let lastStage = "detect";
  let lastDetail = "";

  logBaxiaCaptcha("solve_started", { scope });

  if (typeof page.evaluate === "function") {
    await page
      .evaluate(() => {
        try {
          if (document.exitPointerLock) document.exitPointerLock();
          window.focus();
        } catch {}
      })
      .catch(() => {});
  }

  // A frame selector is deliberately narrowed to the first matching iframe.
  // This matters when an old hidden Baxia iframe remains in the page after a
  // previous challenge. A null selector means the NC document is top-level.
  const frameSelector = detected.target.iframeSelector
    ? `${detected.target.iframeSelector} >> nth=0`
    : null;
  let sliderFoundReported = false;
  let sliderMissingReported = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let stage = "slider_wait";
    try {
      const frame: BaxiaLocatorContext = frameSelector
        ? page.frameLocator(frameSelector)
        : page;
      const slider = frame.locator(BAXIA_SLIDER_SELECTOR);

      // Check if Alibaba NoCaptcha entered the error300 / errloading state
      // (e.g. from an earlier rejected drag, network hiccup, or expired token).
      // If the reload link is visible, click it to trigger native noCaptcha.reset().
      const reloadLink = frame.locator(BAXIA_RELOAD_SELECTOR).first();
      if (await isVisible(reloadLink)) {
        logBaxiaCaptcha("challenge_reload", { attempt });
        await reloadLink.click({ force: true }).catch(() => {});
        await sleep(500);
      }

      await slider.waitFor({ state: "visible", timeout: sliderTimeoutMs });
      if (!sliderFoundReported) {
        logBaxiaCaptcha("slider_found");
        sliderFoundReported = true;
      }

      stage = "geometry";
      const sliderBox = await slider.boundingBox();
      if (!sliderBox) {
        lastReason = "bounds_unavailable";
        logBaxiaCaptcha("attempt_bounds_unavailable", { attempt });
      } else {
        const track = frame.locator(BAXIA_TRACK_SELECTOR);
        const trackBox = await track.boundingBox();
        const trackWidth = trackBox?.width ?? 300;
        const dragDistance = Math.max(0, trackWidth - sliderBox.width);
        lastGeometry = {
          track: Math.round(trackWidth),
          slider: Math.round(sliderBox.width),
          distance: Math.round(dragDistance),
        };
        logBaxiaCaptcha("attempt_geometry", {
          attempt,
          ...lastGeometry,
        });

        if (dragDistance > 0) {
          stage = "drag";
          await humanDrag(
            page,
            sliderBox.x + sliderBox.width / 2,
            sliderBox.y + sliderBox.height / 2,
            sliderBox.x + sliderBox.width / 2 + dragDistance,
            sliderBox.y + sliderBox.height / 2,
          );
        }
      }

      stage = "settle";
      if (
        await waitForSolvedState(
          detected.target.locator,
          detected.dialogLocator,
          detected.contentLocator,
          frame,
          settleMs,
        )
      ) {
        logBaxiaCaptcha(
          "solve_succeeded",
          {
            scope,
            attempt,
            ...lastGeometry,
          },
          true,
        );
        return true;
      }

      lastReason = "not_solved";
      logBaxiaCaptcha("attempt_not_solved", { attempt });
    } catch (error) {
      const errorKind = error instanceof Error ? error.name : "UnknownError";
      const detail = sanitizeCaptchaErrorDetail(error);
      if (!sliderFoundReported && !sliderMissingReported) {
        lastReason = "slider_not_found";
        logBaxiaCaptcha("slider_not_found", { attempt, stage, detail });
        sliderMissingReported = true;
      } else {
        lastReason = errorKind;
      }
      lastStage = stage;
      lastDetail = detail;
      // Include only a sanitized detail: full Playwright errors can contain
      // challenge URLs or page data that should not reach application logs.
      logBaxiaCaptcha("attempt_failed", {
        attempt,
        stage,
        error: errorKind,
        detail,
      });
    }

    if (attempt < maxAttempts && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  if (!sliderFoundReported && !sliderMissingReported) {
    lastReason = "slider_not_found";
    logBaxiaCaptcha("slider_not_found");
  }
  logBaxiaCaptcha(
    "solve_failed",
    {
      scope,
      attempts: maxAttempts,
      reason: lastReason,
      stage: lastStage,
      detail: lastDetail || lastReason,
    },
    true,
  );
  return false;
}

export interface BaxiaCaptchaWatcher {
  stop(): void;
  promise: Promise<boolean>;
}

/**
 * Watch for a challenge that appears while a browser fetch is still waiting
 * for response metadata. The watcher intentionally does not hold the account
 * page mutex: the browser-side fetch already returned from page.evaluate and
 * the page must remain interactive while the challenge is displayed.
 */
export function startBaxiaCaptchaWatcher(
  page: Page,
  timeoutMs: number,
  options: Omit<BaxiaSolverOptions, "waitForMs"> = {},
): BaxiaCaptchaWatcher {
  let stopped = false;
  const deadline = Date.now() + Math.max(0, timeoutMs);

  const promise = (async (): Promise<boolean> => {
    while (!stopped && Date.now() < deadline) {
      try {
        if (page.isClosed()) break;
        const solved = await solveBaxiaCaptcha(page, {
          ...options,
          waitForMs: 0,
        });
        if (solved) return true;
      } catch {
        // A page reset/close is handled by the owning browser request.
      }

      if (!stopped && Date.now() < deadline) {
        await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      }
    }
    return false;
  })();

  return {
    stop: () => {
      stopped = true;
    },
    promise,
  };
}
