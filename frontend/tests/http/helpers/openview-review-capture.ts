import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

type CaptureViewport = { width: number; height: number };
type CaptureOptions = {
  beforeScreenshot?: (page: Page, viewport: CaptureViewport) => Promise<void>;
};

/** Opt-in captures for the OpenView schema redesign review. */
export async function captureOpenViewReview(
  page: Page,
  name: string,
  options: CaptureOptions = {},
) {
  const directory = process.env.OPENVIEW_CAPTURE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const originalViewport = page.viewportSize();
  const originalScrollY = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await options.beforeScreenshot?.(page, viewport);
    await expect(
      page.locator('[data-slot="loading-region"][aria-busy="true"]'),
    ).toHaveCount(0);
    await page.screenshot({
      path: join(directory, `${name}-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
    });
  }
  if (originalViewport) await page.setViewportSize(originalViewport);
  await page.evaluate((y) => window.scrollTo(0, y), originalScrollY);
}
