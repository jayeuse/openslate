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

test("explains the external first administrator prerequisite", async ({
  page,
}) => {
  await page.goto("/setup");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Provision the administrator",
  );
  await expect(
    page.getByText("This is a deployment prerequisite"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Continue to sign in/ }),
  ).toHaveAttribute("href", "/login");
});

test("renders the login form with deployment guidance", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 2 })).toContainText(
    "Welcome back",
  );
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Read the setup guide/ }),
  ).toBeVisible();
});
