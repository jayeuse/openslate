import { expect, test } from "../coverage";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
import type { Page } from "../coverage";

async function openSection(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page
      .getByLabel("Manage section", { exact: true })
      .selectOption(name.toLowerCase());
  } else {
    await page.getByRole("tab", { name, exact: true }).click();
  }
}
test.beforeEach(async ({ page }) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: { detail: "Unavailable" } }),
  );
  await page.route("**/bff/**", async (route) => {
    if (!(await fulfillWorkspaceRequest(route)))
      await route.fulfill({ json: { items: [], has_more: false } });
  });
});

test("maintenance restores a selected backup and applies then rolls back an update locally", async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (/\/bff\/|\/session\//.test(request.url()) && request.method() !== "GET")
      mutations.push(request.url());
  });
  await page.goto("/manage");
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `/tmp/access-manage-manage-${test.info().project.name}.png`,
    fullPage: true,
  });
  await openSection(page, "Backup");
  await page.getByRole("button", { name: "Create backup" }).click();
  await expect(
    page.getByText("Manual snapshot", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restore Manual snapshot" }).click();
  await page.getByRole("button", { name: "Confirm restore" }).click();
  await expect(page.getByRole("status")).toContainText("Restored snapshot");
  await openSection(page, "Updates");
  await page.getByRole("button", { name: "Check for updates" }).click();
  await page.getByRole("button", { name: "Apply update" }).click();
  await page.getByRole("button", { name: "Confirm update" }).click();
  await expect(page.getByText("Current version · 1.5.0")).toBeVisible();
  await page.getByRole("button", { name: "Roll back update" }).click();
  await page.getByRole("button", { name: "Confirm rollback" }).click();
  await expect(page.getByText("Current version · 1.4.2")).toBeVisible();
  expect(mutations).toEqual([]);
});

test("organization settings persist and audit filters constrain export previews", async ({
  page,
}) => {
  await page.goto("/manage");
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Northstar Dispatch");
  await page.getByLabel("Currency", { exact: true }).selectOption("USD");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.reload();
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Northstar Dispatch");
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("USD");
  await openSection(page, "Audit");
  await page.getByLabel("Audit user").selectOption("Eli Cruz");
  await expect(
    page.getByRole("button", { name: "View audit EQ-0028" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View audit WO-1042" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Export audit preview" }).click();
  await expect(page.getByRole("dialog")).toContainText("EQ-0028");
  await expect(page.getByRole("dialog")).not.toContainText("WO-1042");
});

test("security and licensing changes are reviewable local settings", async ({
  page,
}) => {
  await page.goto("/manage");
  await openSection(page, "Security");
  await page
    .getByLabel("Two-factor authentication", { exact: true })
    .selectOption("Required for everyone");
  await page
    .getByLabel("IP allow list", { exact: true })
    .fill("not-an-address");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByRole("tabpanel", { name: "Security" }).getByRole("alert"),
  ).toContainText("documentation IPv4 addresses");
  await expect(
    page.getByLabel("IP allow list", { exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("IP allow list", { exact: true }).fill("192.0.2.4");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page
    .getByRole("button", { name: "End session · Eli", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm end session", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "End session · Eli", exact: true }),
  ).toHaveCount(0);
  await openSection(page, "Licensing");
  await page
    .getByLabel("Bundled license key", { exact: true })
    .selectOption("SAMPLE-BUSINESS-2026");
  await page
    .getByRole("button", { name: "Activate license", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm activation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Business", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Renew license", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm renewal", exact: true })
    .click();
  await expect(
    page.getByText("Expires 2028-09-11", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await openSection(page, "Security");
  await expect(
    page.getByLabel("Two-factor authentication", { exact: true }),
  ).toHaveValue("Required for everyone");
});
