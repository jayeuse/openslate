import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

type Fixture = Readonly<{
  runId: string;
  baseURL: string;
  admin: Readonly<{ email: string; password: string }>;
}>;

function fixture(): Fixture {
  const location = process.env.OPENSLATE_FULLSTACK_FIXTURE;
  const runId = process.env.OPENSLATE_FULLSTACK_RUN_ID;
  if (!location || !runId) throw new Error("full-stack fixture is unavailable");
  const value = JSON.parse(readFileSync(location, "utf8")) as Fixture;
  if (
    value.runId !== runId ||
    value.baseURL !== test.info().project.use.baseURL ||
    !value.admin.email ||
    !value.admin.password
  )
    throw new Error("full-stack fixture does not match this gateway run");
  return value;
}

async function signIn(page: Page) {
  const credentials = fixture().admin;
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/openview$/);
}

test("Access defaults and identity editor offer only controls their save paths support", async ({
  page,
}) => {
  await signIn(page);

  await page.goto("/access?view=overview");
  const configureDefaults = page.getByRole("button", {
    name: "Edit defaults",
  });
  await configureDefaults.focus();
  await page.keyboard.press("Enter");
  const defaultRole = page.getByLabel("Default role");
  await expect(
    defaultRole.locator("option").filter({ hasText: /^admin$/i }),
  ).toHaveCount(0);
  await expect(
    defaultRole.locator("option").filter({ hasText: /^member$/i }),
  ).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(configureDefaults).toBeFocused();
  await page.getByRole("link", { name: "People & services" }).click();
  await expect(page).toHaveURL(/\/access\?view=identities$/);
  await page.getByRole("button", { name: "Add identity" }).click();
  await page.getByRole("menuitem", { name: "Internal identity" }).click();
  await expect(
    page.getByText(
      "To change membership, close this editor and open Permissions.",
    ),
  ).toBeVisible();
});

test("Access current views and legacy links remain usable at 390px with truthful filters", async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const views = [
    ["overview", 1, "Access overview"],
    ["identities", 1, "People & services"],
    ["permissions", 1, "Permissions"],
    ["roles", 1, "Permissions"],
    ["groups", 1, "Permissions"],
    ["rules", 1, "Permissions"],
  ] as const;

  for (const [view, level, heading] of views) {
    await page.goto(`/access?view=${view}`);
    await expect(
      page.getByRole("heading", { level, name: heading }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }

  await page.goto("/access?view=simulator");
  await expect(
    page.getByRole("heading", { level: 1, name: "People & services" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.goto("/access?view=reviews");
  await expect(
    page.getByRole("heading", { level: 1, name: "Access overview" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.goto("/access?view=identities");
  const filters = page.getByRole("region", {
    name: "Search identities controls",
  });
  await filters.getByRole("button", { name: "More filters" }).click();
  const status = filters.getByLabel("Status");
  await expect(status.locator('option[value="deleted"]')).toHaveCount(0);
  await expect(status.locator('option[value="suspended"]')).toHaveCount(0);
  await expect(filters.getByLabel("Activity")).toHaveCount(0);
  await expect(filters.getByLabel("Group")).toBeVisible();
  await expect(filters.getByLabel("Expiry")).toBeVisible();
  await expect(
    filters.getByLabel("Sort").locator('option[value="activity"]'),
  ).toHaveCount(0);
});

test("duplicating Administrator persists its ten effective data grants", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/access?view=permissions&type=roles");
  const administrator = page.getByRole("row").filter({
    has: page.getByRole("button", { name: "Configure admin", exact: true }),
  });
  await administrator
    .getByRole("button", { name: "More actions for admin", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(page.getByText("Duplicated admin.")).toBeVisible();

  await page.reload();
  const persisted = await page.evaluate(async () => {
    const listResponse = await fetch("/api/roles?limit=100&offset=0", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!listResponse.ok)
      throw new Error(`Role list returned ${listResponse.status}`);
    const list = (await listResponse.json()) as {
      items: Array<{ id: string; role: string }>;
    };
    const copy = list.items.find((role) => role.role === "admin copy");
    if (!copy) throw new Error("Duplicated admin role was not persisted");
    const response = await fetch(`/api/roles/${copy.id}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(`Role reload returned ${response.status}`);
    return (await response.json()) as {
      role: string;
      permissions: Record<string, boolean>;
    };
  });
  expect(persisted.role).toBe("admin copy");
  expect(persisted.permissions).toEqual({
    "departments.read": true,
    "departments.write": true,
    "modules.read": true,
    "modules.write": true,
    "fields.read": true,
    "fields.write": true,
    "records.read": true,
    "records.write": true,
    "relationships.read": true,
    "relationships.write": true,
  });
});
