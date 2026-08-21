import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function openHome(page: Page) {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", service: "openslate-api" }),
    }),
  );

  await page.goto("/");
}

test("shows the product foundation and API status", async ({ page }) => {
  await openHome(page);

  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Your business,",
  );
  await expect(page.getByRole("status")).toHaveText(/API online/);
  await expect(
    page.getByRole("link", { name: /Explore the API/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Explore the API/ }),
  ).toHaveAttribute("href", "/docs");
  await expect(
    page.getByRole("link", { name: /View OpenSlate repository/ }),
  ).toHaveAttribute("href", "https://github.com/jayeuse/openslate");
});

test("has no serious accessibility violations", async ({ page }) => {
  await openHome(page);

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("shows offline when the API returns an error", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ status: 503 }));
  await page.goto("/");

  await expect(page.getByRole("status")).toHaveText(/API offline/);
});

test("shows offline when the API response is invalid", async ({ page }) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ status: "healthy" }),
    }),
  );
  await page.goto("/");

  await expect(page.getByRole("status")).toHaveText(/API offline/);
});

test("shows checking while the health request is pending", async ({ page }) => {
  await page.route("**/api/health", async () => {
    await new Promise(() => undefined);
  });
  await page.goto("/");

  await expect(page.getByRole("status")).toHaveText(/Checking API/);
});

test("sets baseline security headers", async ({ page }) => {
  const response = await page.request.get("/");

  expect(response.ok()).toBe(true);
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["permissions-policy"]).toContain("camera=()");
  expect(response.headers()["content-security-policy-report-only"]).toContain(
    "default-src 'self'",
  );
});
