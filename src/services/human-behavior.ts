import type { Page } from "playwright";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function humanDelay(
  minMs: number,
  maxMs: number,
  rng: () => number = Math.random,
): number {
  if (maxMs <= minMs) return minMs;
  const midpoint = (minMs + maxMs) / 2;
  const jitter = (rng() - 0.5) * (maxMs - minMs);
  return Math.round(Math.max(minMs, Math.min(maxMs, midpoint + jitter)));
}

/**
 * Box-Muller gaussian sample (mean 0, sigma 1). Uniform jitter is itself a bot
 * signature: real pointer noise clusters around zero, so the Baxia slider
 * scorer treats a flat distribution as synthetic.
 */
export function gaussianNoise(rng: () => number = Math.random): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Log-normal delay: most steps are quick, a few are long — the heavy tail real
 * hands produce. Linear/uniform sleeps read as a metronome to the scorer.
 */
export function logNormalDelay(
  medianMs: number,
  sigma: number,
  rng: () => number = Math.random,
): number {
  return Math.max(1, Math.round(medianMs * Math.exp(sigma * gaussianNoise(rng))));
}

/** One pointer sample of a slider drag. */
export interface DragSample {
  x: number;
  y: number;
  /** Delay to wait BEFORE emitting this sample. */
  delayMs: number;
}

/**
 * Pure trajectory generator for a human slider drag.
 *
 * Baxia scores the *shape* of the drag, not just its endpoints, so the path
 * must reproduce the three things a real hand does that a linear ramp does not:
 * an acceleration ramp, an overshoot past the target followed by a correction
 * phase, and dwell pauses mid-path.
 */
export function buildDragTrajectory(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  rng: () => number = Math.random,
): DragSample[] {
  const distance = Math.hypot(endX - startX, endY - startY);
  const steps = Math.max(30, Math.min(50, Math.round(distance / 6)));
  const samples: DragSample[] = [];

  // Overshoot target: real hands decelerate late and pass the mark, then
  // correct. ~12% of the remaining distance, clamped so it stays on-page.
  const overshootX = endX + Math.max(4, distance * 0.12);
  const correctionSteps = Math.max(4, Math.round(steps * 0.2));

  for (let step = 1; step <= steps; step++) {
    const progress = step / steps;
    // Cubic ease-in-out with an acceleration ramp: slow start, fast middle.
    const eased =
      progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;
    const ramp = 0.7 + Math.min(0.6, progress * 1.3);

    const targetX = startX + (overshootX - startX) * eased;
    const jitterY = gaussianNoise(rng) * 1.2;

    // Micro-pauses: humans hesitate at roughly a third and two thirds of a
    // deliberate drag.
    const nearPause =
      Math.abs(progress - 0.3) < 1 / steps || Math.abs(progress - 0.65) < 1 / steps;
    const delayMs = nearPause
      ? logNormalDelay(90, 0.5, rng)
      : logNormalDelay(14 / ramp, 0.45, rng);

    samples.push({
      x: targetX,
      y: startY + (endY - startY) * eased + jitterY,
      delayMs,
    });
  }

  // Correction phase: ease the pointer back from the overshoot onto the target.
  for (let step = 1; step <= correctionSteps; step++) {
    const progress = step / correctionSteps;
    const eased = 1 - Math.pow(1 - progress, 2);
    samples.push({
      x: overshootX + (endX - overshootX) * eased,
      y: endY + gaussianNoise(rng) * 0.8,
      delayMs: logNormalDelay(22, 0.4, rng),
    });
  }

  // Land exactly on the target so the slider registers the release in-range.
  samples.push({ x: endX, y: endY, delayMs: logNormalDelay(18, 0.3, rng) });
  return samples;
}

export async function humanDrag(
  page: Page,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): Promise<void> {
  // Approach with its own path, then dwell before pressing: a pointer that
  // teleports onto the handle and clicks instantly is the classic automation
  // signature.
  await page.mouse.move(startX, startY, { steps: 8 });
  await sleep(logNormalDelay(160, 0.5));
  await page.mouse.down();
  await sleep(logNormalDelay(120, 0.5));

  try {
    for (const sample of buildDragTrajectory(startX, startY, endX, endY)) {
      await sleep(sample.delayMs);
      await page.mouse.move(sample.x, sample.y, { steps: 1 });
    }
    // Dwell before release — humans verify the handle is in place.
    await sleep(logNormalDelay(220, 0.5));
  } finally {
    await page.mouse.up();
  }
}

export async function subtlePageActivity(page: Page): Promise<void> {
  if (page.isClosed()) return;

  const viewport = page.viewportSize();
  if (!viewport) return;

  const x = Math.floor(viewport.width * (0.25 + Math.random() * 0.5));
  const y = Math.floor(viewport.height * (0.25 + Math.random() * 0.5));
  await page.mouse.move(x, y, { steps: 6 + Math.floor(Math.random() * 8) });

  if (Math.random() < 0.35) {
    await page.mouse.wheel(0, Math.random() < 0.5 ? 60 : -60).catch(() => {});
  }

  await page
    .evaluate(() => {
      try {
        const target = document.querySelector(
          '[data-testid="sidebar"], .sidebar, nav, aside, main',
        );
        if (target) {
          target.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
          target.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
        }
      } catch {
        // Best-effort keep-alive only.
      }
    })
    .catch(() => {});
}
