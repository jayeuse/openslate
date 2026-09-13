import type { Page, Route } from "@playwright/test";
import { installSessionMocks } from "../helpers/administration-fixtures";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";

export const PRIMARY_ROUTES = [
  { path: "/sandbox", heading: "Organization designer" },
  { path: "/boards", heading: "Boards" },
  { path: "/comms", heading: "OpenComms" },
  { path: "/access", heading: "Access" },
  { path: "/openview", heading: "Service requests" },
  { path: "/manage", heading: "Manage" },
] as const;

export async function installProductionMocks(page: Page): Promise<void> {
  await installSessionMocks(page);
  await page.route("**/bff/**", async (route: Route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    await route.fulfill({
      status: 404,
      json: { detail: "No live data in production smoke tests" },
    });
  });
}

export async function clickPrimaryNavigation(
  page: Page,
  label: string,
): Promise<void> {
  const mobileTrigger = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (await mobileTrigger.isVisible()) {
    await mobileTrigger.click();
    await page
      .locator("#mobile-navigation")
      .getByRole("link", { name: label, exact: true })
      .click();
    return;
  }
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: label, exact: true })
    .click();
}

export async function assertViewportContained(page: Page): Promise<void> {
  const bounds = await page.evaluate(() => {
    const main = document.querySelector("main");
    const mainBounds = main?.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      mainLeft: mainBounds?.left ?? 0,
      mainRight: mainBounds?.right ?? window.innerWidth,
    };
  });
  if (bounds.documentWidth > bounds.viewportWidth + 1)
    throw new Error(
      `The production page overflows horizontally: ${bounds.documentWidth}px > ${bounds.viewportWidth}px`,
    );
  if (bounds.mainLeft < -1 || bounds.mainRight > bounds.viewportWidth + 1)
    throw new Error(
      `The production main region is outside the viewport: ${bounds.mainLeft}px–${bounds.mainRight}px`,
    );
}

export function collectRuntimeFaults(page: Page): string[] {
  const faults: string[] = [];
  page.on("pageerror", (error) => faults.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") faults.push(`console: ${message.text()}`);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText;
    // Next.js cancels speculative RSC prefetches when a real navigation wins.
    // Those aborted requests are expected and are not unavailable resources.
    if (failure === "net::ERR_ABORTED") return;
    faults.push(
      `request: ${request.method()} ${request.url()} (${failure ?? "unknown failure"})`,
    );
  });
  return faults;
}
