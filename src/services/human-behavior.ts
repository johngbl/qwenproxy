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
