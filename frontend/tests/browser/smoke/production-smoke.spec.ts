import { expect, test } from "@playwright/test";
import {
  assertViewportContained,
  clickPrimaryNavigation,
  collectRuntimeFaults,
  installProductionMocks,
  PRIMARY_ROUTES,
} from "./production-smoke-fixtures";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installProductionMocks(page);
});

test("landing page reaches the production sign-in entry point", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Make the next action obvious.",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: /Open workspace/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
});

test("login recovers from a rejected authentication attempt", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/session/login", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 401,
        json: { detail: "Invalid email or password" },
      });
      return;
    }
    await route.fulfill({ json: { authenticated: true } });
  });

  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("operator@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic-password-for-login");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByText("Invalid email or password", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
    "operator@example.test",
  );

  await Promise.all([
    page.waitForURL(/\/openview$/),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Service requests", exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

test("primary workspace routes render their production landmarks", async ({
  page,
}) => {
  for (const route of PRIMARY_ROUTES) {
    await page.goto(route.path);
    await expect(page).toHaveURL(new RegExp(`${route.path}$`));
    await expect(
      page.getByRole("main").getByRole("heading", {
        name: route.heading,
        exact: true,
      }),
    ).toBeVisible();
  }
});

test("production deep links survive reload and client navigation", async ({
  page,
}) => {
  await page.goto("/manage?view=security");
  await expect(page).toHaveURL(/\/manage\?view=security$/);
  await expect(
    page.getByRole("heading", { name: "Security policies", exact: true }),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Security policies", exact: true }),
  ).toBeVisible();
  await clickPrimaryNavigation(page, "Access");
  await expect(page).toHaveURL(/\/access$/);
  await expect(
    page.getByRole("heading", { name: "Access", exact: true }),
  ).toBeVisible();
});

test("representative local settings mutation survives production reload", async ({
  page,
}) => {
  await page.goto("/manage");
  const organizationName = page.getByLabel("Organization name", {
    exact: true,
  });
  await organizationName.fill("Northstar Dispatch");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Settings saved.");

  await page.reload();
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Northstar Dispatch");
});

test("primary content stays contained at the production viewport", async ({
  page,
}) => {
  await page.goto("/manage");
  await expect(
    page.getByRole("heading", { name: "Manage", exact: true }),
  ).toBeVisible();
  await assertViewportContained(page);
});

test("production navigation has no fatal runtime or resource errors", async ({
  page,
}) => {
  const faults = collectRuntimeFaults(page);
  await page.goto("/openview");
  await expect(
    page.getByRole("heading", { name: "Service requests", exact: true }),
  ).toBeVisible();
  await clickPrimaryNavigation(page, "Access");
  await expect(
    page.getByRole("heading", { name: "Access", exact: true }),
  ).toBeVisible();
  expect(faults).toEqual([]);
});

test("private server environment values stay outside the browser boundary", async ({
  page,
}) => {
  await page.goto("/openview");
  await expect(
    page.getByRole("heading", { name: "Service requests", exact: true }),
  ).toBeVisible();

  const pageMarkup = await page.content();
  expect(pageMarkup).not.toMatch(
    /(?:BACKEND_URL|SUPABASE_SERVER_URL|DATABASE_URL|MIGRATION_DATABASE_URL|SUPABASE_SECRET_KEY|SECURITY_EVENT_SERVER_KEY|LOG_DIR)/,
  );
  const resources = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => /backend\.invalid|supabase\.invalid/i.test(name)),
  );
  expect(resources).toEqual([]);
});
