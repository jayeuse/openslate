import { expect, test } from "@playwright/test";

test("shows the product foundation and API status", async ({ page }) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", service: "openslate-api" }),
    }),
  );

  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toContainText("Your business,");
  await expect(page.getByRole("status")).toHaveText(/API online/);
  await expect(page.getByRole("link", { name: /Explore the API/ })).toBeVisible();
});
