import { expect, test } from "../coverage";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
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

test("sample maintenance restores a selected backup and applies then rolls back an update locally", async ({
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
  await page.getByRole("button", { name: "Backup", exact: true }).click();
  await page.getByRole("button", { name: "Create sample backup" }).click();
  await expect(
    page.getByText("Manual snapshot", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restore Manual snapshot" }).click();
  await page.getByRole("button", { name: "Confirm sample restore" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Restored sample snapshot",
  );
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  await page.getByRole("button", { name: "Check for updates" }).click();
  await page.getByRole("button", { name: "Apply sample update" }).click();
  await page.getByRole("button", { name: "Confirm sample update" }).click();
  await expect(page.getByText("Current version · 1.5.0")).toBeVisible();
  await page.getByRole("button", { name: "Roll back update" }).click();
  await page.getByRole("button", { name: "Confirm sample rollback" }).click();
  await expect(page.getByText("Current version · 1.4.2")).toBeVisible();
  expect(mutations).toEqual([]);
});

test("sample organization settings persist and audit filters constrain export previews", async ({
  page,
}) => {
  await page.goto("/manage");
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Northstar Dispatch");
  await page.getByLabel("Currency", { exact: true }).selectOption("USD");
  await page.getByRole("button", { name: "Save sample settings" }).click();
  await page.reload();
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Northstar Dispatch");
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("USD");
  await page.getByRole("button", { name: "Audit", exact: true }).click();
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

test("sample security and licensing changes are reviewable local settings", async ({
  page,
}) => {
  await page.goto("/manage");
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await page
    .getByLabel("Two-factor authentication", { exact: true })
    .selectOption("Required for everyone");
  await page
    .getByLabel("Sample IP allow list", { exact: true })
    .fill("not-an-address");
  await page.getByRole("button", { name: "Save sample settings" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "example IPv4 addresses",
  );
  await page
    .getByLabel("Sample IP allow list", { exact: true })
    .fill("192.0.2.4");
  await page.getByRole("button", { name: "Save sample settings" }).click();
  await page
    .getByRole("button", { name: "End session · Eli", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm end sample session", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "End session · Eli", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Licensing", exact: true }).click();
  await page
    .getByLabel("Bundled dummy license key", { exact: true })
    .selectOption("SAMPLE-BUSINESS-2026");
  await page
    .getByRole("button", { name: "Activate sample license", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm sample activation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Business", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Renew sample license", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm sample renewal", exact: true })
    .click();
  await expect(
    page.getByText("Expires 2028-09-11", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await expect(
    page.getByLabel("Two-factor authentication", { exact: true }),
  ).toHaveValue("Required for everyone");
});
