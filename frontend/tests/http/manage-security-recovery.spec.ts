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

test("Security and recovery keeps policy drafts and protects the current session", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && request.method() !== "GET")
      writes.push(request.url());
  });
  await page.goto("/manage?view=security");
  await expect(
    page.getByRole("heading", { level: 1, name: "Security & recovery" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Security & recovery", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("link", { name: "Backup", exact: true }),
  ).toHaveCount(0);
  const sessions = page.getByRole("table", { name: "Sessions", exact: true });
  await expect(sessions.locator("tbody tr")).toHaveCount(4);
  const pages = page.getByRole("navigation", { name: "Session pages" });
  await pages.getByRole("button", { name: "Go to next page" }).click();
  await expect(pages.locator('[aria-current="page"]')).toHaveAttribute(
    "aria-label",
    "Page 2 of 2",
  );
  await page
    .getByRole("searchbox", { name: "Search sessions", exact: true })
    .fill("Eli");
  await expect(pages.locator('[aria-current="page"]')).toHaveAttribute(
    "aria-label",
    "Page 1 of 1",
  );
  const endEli = page.getByRole("button", {
    name: "End session for Eli",
    exact: true,
  });
  await endEli.click();
  let confirmation = page.getByRole("alertdialog", {
    name: "End session",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(endEli).toBeVisible();
  await endEli.click();
  await confirmation
    .getByRole("button", { name: "Confirm end session", exact: true })
    .click();
  await expect(endEli).toHaveCount(0);
  await page
    .getByRole("searchbox", { name: "Search sessions", exact: true })
    .fill("");

  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  await policy
    .getByLabel("Session timeout", { exact: true })
    .selectOption("30 minutes");
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("tab", { name: /Snapshots/ }).click();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("30 minutes");
  await policy
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    policy.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  await policy
    .getByRole("button", { name: "Preview MFA setup", exact: true })
    .click();
  const mfa = page.getByRole("dialog", { name: "MFA enrollment", exact: true });
  await expect(mfa).toContainText("does not enroll a factor");
  await page.keyboard.press("Escape");
  await expect(mfa).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("30 minutes");
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("tab", { name: /Sessions/ }).click();
  await page
    .getByRole("button", { name: "End all remote sessions", exact: true })
    .click();
  confirmation = page.getByRole("alertdialog", {
    name: "End all remote sessions",
    exact: true,
  });
  await expect(confirmation).toContainText("no account will be signed out");
  await confirmation
    .getByRole("button", {
      name: "Confirm end all remote sessions",
      exact: true,
    })
    .click();
  await expect(sessions.locator("tbody tr")).toHaveCount(1);
  await expect(
    sessions.getByText("Current session", { exact: true }),
  ).toBeVisible();
  await expect(
    sessions.getByRole("button", { name: /End session/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "End all remote sessions", exact: true }),
  ).toBeDisabled();
  expect(writes).toEqual([]);
});

test("Snapshots preserve committed settings, restore acknowledgement, and all recovery utilities", async ({
  page,
}, testInfo) => {
  await page.goto("/manage?view=backup");
  await expect(
    page.getByRole("heading", { level: 1, name: "Security & recovery" }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: /Snapshots/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const table = page.getByRole("table", {
    name: "Configuration snapshots",
    exact: true,
  });
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  await policy
    .getByLabel("Session timeout", { exact: true })
    .selectOption("30 minutes");
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Create snapshot", exact: true })
    .click();
  const create = page.getByRole("dialog", {
    name: "Create snapshot",
    exact: true,
  });
  await create
    .getByLabel("Snapshot name", { exact: true })
    .fill("Working recovery point");
  await create
    .getByRole("button", { name: "Create snapshot", exact: true })
    .click();
  await expect(create).toBeHidden();
  await page
    .getByRole("button", {
      name: "Inspect Working recovery point",
      exact: true,
    })
    .click();
  const inspector = page.getByRole("region", {
    name: "Selected snapshot",
    exact: true,
  });
  await expect(
    inspector.getByText("60 minutes", { exact: true }),
  ).toBeVisible();
  await inspector
    .getByRole("button", { name: "Compare with current", exact: true })
    .click();
  const comparison = page.getByRole("dialog", { name: /Compare/ });
  await expect(comparison).toContainText("No saved settings will change.");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await policy
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    policy.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  await policy
    .getByLabel("Session timeout", { exact: true })
    .selectOption("15 minutes");
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await inspector
    .getByRole("button", { name: "Restore snapshot", exact: true })
    .click();
  const restore = page.getByRole("alertdialog", {
    name: "Restore configuration",
    exact: true,
  });
  const confirmRestore = restore.getByRole("button", {
    name: "Confirm restore",
    exact: true,
  });
  await expect(confirmRestore).toBeDisabled();
  await expect(
    restore.getByRole("table", { name: "Settings changes", exact: true }),
  ).toContainText("30 minutes");
  await restore.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("15 minutes");
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await inspector
    .getByRole("button", { name: "Restore snapshot", exact: true })
    .click();
  await restore
    .getByRole("checkbox", { name: "Discard affected unsaved drafts" })
    .check();
  await confirmRestore.click();
  await expect(restore).toBeHidden();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("60 minutes");
  await policy.getByRole("button", { name: "Close", exact: true }).click();

  await inspector
    .getByRole("button", { name: "Snapshot actions", exact: true })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download JSON", exact: true })
    .click();
  const download = await downloadPromise;
  const downloadedPath = testInfo.outputPath("manage-snapshot.json");
  await download.saveAs(downloadedPath);
  const downloaded = JSON.parse(await readFile(downloadedPath, "utf8"));
  expect(downloaded.format).toBe("openslate.manage.sample");
  expect(downloaded.snapshot.settings.timeout).toBe("60 minutes");
  await inspector
    .getByRole("button", { name: "Snapshot actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const deletion = page.getByRole("alertdialog", { name: /Delete/ });
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(inspector).toContainText("Working recovery point");
  await inspector
    .getByRole("button", { name: "Snapshot actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await deletion
    .getByRole("button", { name: "Delete Working recovery point", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Inspect Working recovery point",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(inspector).toHaveCount(0);
});

test("Schedule settings retain disabled simulation and non-destructive retention preview", async ({
  page,
}) => {
  await page.goto("/manage?view=security");
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  const schedule = page.getByRole("dialog", {
    name: "Snapshot schedule",
    exact: true,
  });
  await schedule
    .getByLabel("Backup schedule", { exact: true })
    .selectOption("Disabled");
  await schedule
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    schedule.getByRole("button", {
      name: "Simulate scheduled backup",
      exact: true,
    }),
  ).toBeDisabled();
  await schedule
    .getByLabel("Backup schedule", { exact: true })
    .selectOption("Daily at 02:00");
  await expect(
    schedule.getByRole("button", {
      name: "Simulate scheduled backup",
      exact: true,
    }),
  ).toBeDisabled();
  await schedule
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await schedule
    .getByRole("button", { name: "Simulate scheduled backup", exact: true })
    .click();
  await schedule
    .getByRole("button", { name: "Preview retention candidates", exact: true })
    .click();
  const preview = page.getByRole("dialog", {
    name: "Retention preview",
    exact: true,
  });
  await expect(preview).toContainText("never deletes snapshots automatically");
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await page.getByRole("tab", { name: /Snapshots/ }).click();
  await expect(
    page.getByRole("button", { name: /Inspect Scheduled snapshot ·/ }).first(),
  ).toBeVisible();
});

test("Changing snapshot browsing controls closes the selected snapshot", async ({
  page,
}) => {
  await page.goto("/manage?view=backup");
  const inspector = page.getByRole("region", {
    name: "Selected snapshot",
    exact: true,
  });
  const selectFirstSnapshot = async () => {
    await page
      .getByRole("button", { name: "Inspect Scheduled snapshot", exact: true })
      .click();
    await expect(inspector).toBeVisible();
  };

  await selectFirstSnapshot();
  await page.getByRole("searchbox", { name: "Search snapshots" }).fill("setup");
  await expect(inspector).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search snapshots" }).fill("");

  await selectFirstSnapshot();
  await page.getByLabel("Sort snapshots").selectOption("name");
  await expect(inspector).toHaveCount(0);
  await page.getByLabel("Sort snapshots").selectOption("newest");

  await selectFirstSnapshot();
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("Saved schedule").selectOption("disabled");
  await expect(inspector).toHaveCount(0);
  await page.getByLabel("Saved schedule").selectOption("all");

  await selectFirstSnapshot();
  const rowsPerPage = page
    .getByRole("tabpanel", { name: "Snapshots" })
    .getByLabel("Rows per page");
  await rowsPerPage.selectOption("10");
  await expect(inspector).toHaveCount(0);
  await rowsPerPage.selectOption("4");

  await selectFirstSnapshot();
  await page
    .getByRole("navigation", { name: "Snapshot pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(inspector).toHaveCount(0);
});

test("Renaming a snapshot keeps its saved schedule and schedule filter membership", async ({
  page,
}) => {
  await page.goto("/manage?view=backup");
  const table = page.getByRole("table", {
    name: "Configuration snapshots",
    exact: true,
  });
  await expect(
    table.getByRole("columnheader", { name: "Saved schedule" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("Saved schedule").selectOption("enabled");
  await page
    .getByRole("button", { name: "Inspect Scheduled snapshot", exact: true })
    .click();
  const inspector = page.getByRole("region", {
    name: "Selected snapshot",
    exact: true,
  });
  await expect(
    inspector.getByText("Daily at 02:00", { exact: true }),
  ).toBeVisible();
  await inspector.getByRole("button", { name: "Snapshot actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: "Rename snapshot" });
  await rename
    .getByRole("textbox", { name: "Snapshot name" })
    .fill("Daily checkpoint");
  await rename.getByRole("button", { name: "Rename snapshot" }).click();
  await expect(rename).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Inspect Daily checkpoint", exact: true }),
  ).toBeVisible();
  await expect(
    inspector.getByText("Daily at 02:00", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Saved schedule").selectOption("disabled");
  await expect(
    page.getByRole("button", { name: "Inspect Daily checkpoint", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Saved schedule").selectOption("enabled");
  await expect(
    page.getByRole("button", { name: "Inspect Daily checkpoint", exact: true }),
  ).toBeVisible();
});
