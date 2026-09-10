import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "../coverage";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";

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

test("sign in keeps a rejected draft, blocks duplicate submission, and enters the workspace on retry", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const responseReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempts: unknown[] = [];
  await page.route("**/session/login", async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      await responseReady;
      await route.fulfill({
        status: 401,
        json: { detail: "Invalid email or password" },
      });
    } else await route.fulfill({ json: { authenticated: true } });
  });
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/bff/**", async (route) => {
    if (!(await fulfillWorkspaceRequest(route)))
      await route.fulfill({
        json: { items: [], pagination: { has_more: false, total: 0 } },
      });
  });
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("operator@example.test");
  const password = "synthetic-password-for-login";
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Signing in…", exact: true }),
  ).toBeDisabled();
  expect(attempts).toEqual([{ email: "operator@example.test", password }]);
  release?.();
  await expect(
    page.getByRole("status").filter({ hasText: "Invalid email or password" }),
  ).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
    "operator@example.test",
  );
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
    password,
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  expect(attempts).toHaveLength(2);
});

test("sign in recovers after a malformed rejection response", async ({
  page,
}) => {
  await page.route("**/session/login", (route) =>
    route.fulfill({
      status: 502,
      contentType: "text/html",
      body: "Unavailable",
    }),
  );
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("operator@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic-password-for-login");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Sign in failed" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
});
