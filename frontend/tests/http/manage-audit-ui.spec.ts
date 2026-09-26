import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000101",
        setup_required: false,
      },
    }),
  );
});

test("Audit filters reset paging, row size, empty recovery, and details stay accurate", async ({
  page,
}) => {
  await page.goto("/manage?view=audit");

  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(5);
  await expect(
    table.getByText("Example", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Showing 1–5 of 10", { exact: true }),
  ).toBeVisible();

  const pages = page.getByRole("navigation", { name: "Activity pages" });
  const currentPage = pages.locator('[aria-current="page"]');
  await pages.getByRole("button", { name: "Go to next page" }).click();
  await expect(currentPage).toHaveAttribute("aria-label", "Page 2 of 2");
  await expect(table.getByText("Tomas Yu", { exact: true })).toBeVisible();

  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .fill("Tomas Yu");
  await expect(table.getByText("Tomas Yu", { exact: true })).toBeVisible();
  await expect(currentPage).toHaveAttribute("aria-label", "Page 1 of 1");

  await page.getByRole("button", { name: "More filters" }).click();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(
    page.getByText("Showing 1–5 of 10", { exact: true }),
  ).toBeVisible();

  await pages.getByRole("button", { name: "Go to next page" }).click();
  await expect(currentPage).toHaveAttribute("aria-label", "Page 2 of 2");
  await page
    .getByRole("combobox", { name: "Rows per page" })
    .selectOption("10");
  await expect(currentPage).toHaveAttribute("aria-label", "Page 1 of 1");
  await expect(table.locator("tbody tr")).toHaveCount(10);

  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .fill("no matching activity");
  await expect(
    page.getByText("No audit entries match these filters", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Showing 0–0 of 0", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(table.locator("tbody tr")).toHaveCount(10);

  const detailTrigger = page.getByRole("button", {
    name: "View audit WO-1042",
    exact: true,
  });
  await detailTrigger.click();
  const details = page.getByRole("dialog", {
    name: "Audit entry detail",
    exact: true,
  });
  await expect(
    details.getByText("Status: Assigned", { exact: true }),
  ).toBeVisible();
  await expect(
    details.getByText("Status: In progress", { exact: true }),
  ).toBeVisible();
  await details
    .getByRole("button", { name: "Close detail", exact: true })
    .click();
  await expect(details).toBeHidden();
});

test("Audit export downloads every entry matching dates, across visible pages", async ({
  page,
}, testInfo) => {
  await page.goto("/manage?view=audit");

  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("From", { exact: true }).fill("2026-09-02");
  await page.getByLabel("To", { exact: true }).fill("2026-09-08");
  await expect(
    page.getByText("Showing 1–5 of 7", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(preview).toContainText("7 filtered entries");
  await expect(preview.getByLabel("CSV preview")).toContainText("Tomas Yu");
  await expect(preview.getByLabel("CSV preview")).toContainText("Example");

  const downloadStarted = page.waitForEvent("download");
  await preview
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toBe("openslate-audit.csv");
  const csvPath = testInfo.outputPath("audit-filtered.csv");
  await download.saveAs(csvPath);
  const csv = await readFile(csvPath, "utf8");
  expect(csv.trimEnd().split(/\r?\n/)).toHaveLength(8);
  expect(csv).toContain("Tomas Yu");
  await expect(
    page.getByText("Downloaded 7 filtered audit entries.", { exact: true }),
  ).toBeVisible();
});
