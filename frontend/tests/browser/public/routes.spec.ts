import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("shows the operational entry point", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Make the next action obvious",
  );
  await expect(
    page.getByRole("link", { name: /Open workspace/ }),
  ).toHaveAttribute("href", "/login");
  await expect(
    page.getByRole("link", { name: /First deployment/ }),
  ).toHaveAttribute("href", "/setup");
});

test("has no serious accessibility violations", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
