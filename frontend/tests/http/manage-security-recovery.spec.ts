import { expect, test } from "./helpers/test";
import { mockManageSecurity } from "./helpers/manage-security";
import { backupRun, mockManageBackups } from "./helpers/manage-backups";
import { sendOpenViewEvent } from "./helpers/openview-event-source";

// Retain the verified-session fixture shared by these cases before the move.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000001",
        setup_required: false,
      },
    }),
  );
});

test("Back up now queues real history, cancels without writes, and preserves policy drafts", async ({
  page,
}) => {
  const security = await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  await page.goto("/manage?view=backup");
  const table = page.getByRole("table", {
    name: "Backup history",
    exact: true,
  });
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  const policy = page.getByRole("dialog", {
    name: "Backup schedule",
    exact: true,
  });
  await policy
    .getByLabel("Backup schedule", { exact: true })
    .selectOption("weekly");
  await policy.getByRole("button", { name: "Close", exact: true }).click();

  const opener = page.getByRole("button", { name: "Back up now", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Back up now", exact: true });
  await dialog
    .getByLabel("Backup name", { exact: true })
    .fill("Cancelled backup");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(backup.queueRequests).toEqual([]);

  await opener.click();
  await dialog
    .getByLabel("Backup name", { exact: true })
    .fill("Working recovery point");
  await dialog
    .getByRole("button", { name: "Back up now", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await page
    .getByRole("button", {
      name: "Inspect Working recovery point",
      exact: true,
    })
    .click();
  const inspector = page.getByRole("region", {
    name: "Selected backup",
    exact: true,
  });
  await expect(inspector.getByText("Queued", { exact: true })).toBeVisible();
  await expect(inspector).toContainText("Not verified");
  await expect(
    inspector.getByRole("link", { name: "Restore procedure" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/jayeuse/openslate/blob/main/infra/supabase/RESTORE.md",
  );
  await expect(
    page.getByRole("button", {
      name: /Restore snapshot|Compare with current|Snapshot actions|Simulate scheduled backup/,
    }),
  ).toHaveCount(0);
  expect(backup.queueRequests).toHaveLength(1);
  expect(backup.queueRequests[0]?.name).toBe("Working recovery point");
  expect(backup.queueRequests[0]?.key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  expect(backup.runs[0]).toMatchObject({
    name: "Working recovery point",
    state: "queued",
    snapshot_id: null,
    verified_at: null,
  });
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await expect(
    policy.getByLabel("Backup schedule", { exact: true }),
  ).toHaveValue("weekly");
  expect(security.writes).toEqual([]);
  expect(security.policyReads).toBe(0);
  expect(backup.patches).toEqual([]);
  expect(backup.policy.schedule).toBe("disabled");
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Inspect Working recovery point",
      exact: true,
    }),
  ).toBeVisible();
});

test("Backup schedule saves revisioned real policy and keeps cancelled drafts without simulation", async ({
  page,
}) => {
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  await page.goto("/manage?view=backup");
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Backup schedule",
    exact: true,
  });
  const schedule = dialog.getByLabel("Backup schedule", { exact: true });
  const retention = dialog.getByLabel("Retention period", { exact: true });
  await expect(schedule).toHaveValue("disabled");
  await schedule.selectOption("weekly");
  await retention.selectOption("90");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  expect(backup.patches).toEqual([]);
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await expect(schedule).toHaveValue("weekly");
  await dialog
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(schedule).toHaveValue("disabled");
  await expect(retention).toHaveValue("30");
  await schedule.selectOption("weekly");
  await retention.selectOption("90");
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  expect(backup.patches).toEqual([
    { revision: 1, schedule: "weekly", retention_days: 90 },
  ]);
  await schedule.selectOption("daily");
  backup.policy.timezone = "UTC";
  await sendOpenViewEvent(page, "invalidate", { entity: "workspace_profiles" });
  await expect(dialog).toContainText("UTC");
  await expect(schedule).toHaveValue("daily");
  await expect(
    dialog.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Review latest policy", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(dialog).toContainText("UTC");
  await expect(dialog).toContainText(
    "Saving this schedule does not set up the backup service",
  );
  await expect(
    dialog.getByRole("button", {
      name: /Simulate|Preview retention candidates/,
    }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await expect(schedule).toHaveValue("weekly");
  await expect(retention).toHaveValue("90");
});

test("Backup server paging and filters clear selection without slicing the returned page", async ({
  page,
}) => {
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  backup.runs = backup.runs.map((run, index) => ({
    ...run,
    installation: index === 1 ? "previous" : "current",
    state: "queued",
    started_at: null,
    finished_at: null,
    reconciled_at: null,
    snapshot_id: null,
    manifest_sha256: null,
    verified_at: null,
  }));
  await page.goto("/manage?view=backup");
  const table = page.getByRole("table", {
    name: "Backup history",
    exact: true,
  });
  const inspector = page.getByRole("region", {
    name: "Selected backup",
    exact: true,
  });
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("Status", { exact: true }).selectOption("queued");
  await page.getByRole("button", { name: "More filters" }).click();
  await page
    .getByRole("button", { name: "Inspect Backup 1", exact: true })
    .click();
  await expect(inspector).toBeVisible();
  await page
    .getByRole("navigation", { name: "Backup pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Inspect Backup 6", exact: true }),
  ).toBeVisible();
  await expect(inspector).toHaveCount(0);
  expect(backup.historyReads.at(-1)?.get("offset")).toBe("4");
  backup.runs = backup.runs.map((run, index) =>
    index < 2 ? run : backupRun(index + 1),
  );
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_runs" });
  await expect(
    page.getByText("Showing 1–2 of 2", { exact: true }),
  ).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Inspect Backup 1", exact: true }),
  ).toBeVisible();
  await expect(inspector).toHaveCount(0);
  expect(backup.historyReads.at(-1)?.get("offset")).toBe("0");
  expect(backup.historyReads.at(-1)?.get("limit")).toBe("4");
  expect(backup.historyReads.at(-1)?.get("state")).toBe("queued");
  expect(backup.runs).toHaveLength(6);
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("Status", { exact: true }).selectOption("all");
  await page.getByRole("button", { name: "More filters" }).click();
  await page
    .getByRole("searchbox", { name: "Search backups" })
    .fill("Backup 6");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  expect(backup.historyReads.at(-1)?.get("offset")).toBe("0");
  await page.getByRole("searchbox", { name: "Search backups" }).fill("");
  await page.getByLabel("Rows per page", { exact: true }).selectOption("10");
  await expect(table.locator("tbody tr")).toHaveCount(6);
  await page
    .getByRole("button", { name: "Inspect Backup 2", exact: true })
    .click();
  await expect(inspector).toContainText("Previous installation");
  await page.getByLabel("Sort backups").selectOption("name");
  await expect(inspector).toHaveCount(0);
  await page.getByRole("button", { name: "More filters" }).click();
  await page
    .getByLabel("Installation", { exact: true })
    .selectOption("previous");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  expect(backup.historyReads.at(-1)?.get("installation")).toBe("previous");
  expect(backup.historyReads.at(-1)?.get("deleted")).toBe("exclude");
  expect(backup.historyReads.at(-1)?.has("schedule")).toBe(false);
});

test("Backup failure and denial never expose sample policy or cached history as accepted reads", async ({
  page,
}) => {
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  backup.statusReadStatus = 503;
  backup.historyReadStatus = 503;
  await page.goto("/manage?view=backup");
  await expect(
    page.getByText("Backup policy could not be loaded.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Backup history could not be loaded.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Back up now", exact: true }),
  ).toBeDisabled();
  backup.statusReadStatus = 200;
  backup.historyReadStatus = 200;
  await page
    .getByRole("button", { name: "Retry backup policy", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry backup history", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Inspect Backup 1", exact: true }),
  ).toBeVisible();
  backup.historyReadStatus = 403;
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_runs" });
  await expect(
    page.getByText("Only administrators can review backups.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect Backup 1", exact: true }),
  ).toHaveCount(0);
  backup.historyReadStatus = 200;
  await page
    .getByRole("button", { name: "Retry backup history", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Inspect Backup 1", exact: true }),
  ).toBeVisible();
  backup.malformedStatus = true;
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_policies" });
  await expect(
    page.getByText("Backup policy could not be loaded.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Back up now", exact: true }),
  ).toBeDisabled();
  expect(backup.patches).toEqual([]);
  expect(backup.queueRequests).toEqual([]);
});

test("Backup conflict retains a draft and queue retry reuses the accepted request after an uncertain outcome", async ({
  page,
}) => {
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  await page.goto("/manage?view=backup");
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  const policy = page.getByRole("dialog", {
    name: "Backup schedule",
    exact: true,
  });
  await policy
    .getByLabel("Backup schedule", { exact: true })
    .selectOption("daily");
  backup.policy.revision = 2;
  backup.policy.schedule = "weekly";
  backup.policy.retention_days = 90;
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_policies" });
  await expect(policy).toContainText(
    "Backup policy changed. Your draft is still here",
  );
  const passiveChange = policy
    .getByRole("status")
    .filter({ hasText: "Backup policy changed. Your draft is still here" });
  await expect(passiveChange).toHaveAttribute("data-variant", "warning");
  await expect(
    policy.getByLabel("Backup schedule", { exact: true }),
  ).toHaveValue("daily");
  await expect(
    policy.getByLabel("Retention period", { exact: true }),
  ).toHaveValue("30");
  await expect(
    policy.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
  expect(backup.patches).toEqual([]);
  await policy
    .getByRole("button", { name: "Review latest policy", exact: true })
    .click();
  await expect(
    policy.getByLabel("Retention period", { exact: true }),
  ).toHaveValue("90");
  await expect(
    policy.getByLabel("Backup schedule", { exact: true }),
  ).toHaveValue("daily");
  await policy
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    policy.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  await policy
    .getByLabel("Retention period", { exact: true })
    .selectOption("7");
  backup.policy.revision = 4;
  await policy
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(policy).toContainText(
    "Backup policy changed. Your draft is still here",
  );
  const failedSave = policy
    .getByRole("alert")
    .filter({ hasText: "Backup policy changed. Your draft is still here" });
  await expect(failedSave).toHaveAttribute("data-variant", "destructive");
  await expect(
    policy.getByLabel("Retention period", { exact: true }),
  ).toHaveValue("7");
  await expect(
    policy.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
  await policy
    .getByRole("button", { name: "Review latest policy", exact: true })
    .click();
  await policy
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    policy.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  expect(backup.patches).toEqual([
    { revision: 2, schedule: "daily" },
    { revision: 3, retention_days: 7 },
    { revision: 4, retention_days: 7 },
  ]);
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  backup.queueFailureAfterCommit = true;
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  const queue = page.getByRole("dialog", { name: "Back up now", exact: true });
  await queue
    .getByLabel("Backup name", { exact: true })
    .fill("One recovery point");
  await queue.getByRole("button", { name: "Back up now", exact: true }).click();
  await expect(queue).toContainText("could not be confirmed");
  await expect(queue.getByLabel("Backup name", { exact: true })).toHaveValue(
    "One recovery point",
  );
  await queue.getByRole("button", { name: "Back up now", exact: true }).click();
  await expect(queue).toBeHidden();
  expect(backup.queueRequests).toHaveLength(2);
  expect(backup.queueRequests[0]?.key).toBe(backup.queueRequests[1]?.key);
  expect(
    backup.runs.filter((run) => run.name === "One recovery point"),
  ).toHaveLength(1);
});

test("Backup pending submission blocks duplicate and route leave, then events refresh truthful recovery state", async ({
  page,
}) => {
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  let release!: () => void;
  backup.holdWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.goto("/manage?view=backup");
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Back up now", exact: true });
  await dialog.getByLabel("Backup name", { exact: true }).fill("Held request");
  const submit = dialog.getByRole("button", {
    name: "Back up now",
    exact: true,
  });
  await submit.click();
  await expect(
    dialog.getByRole("button", { name: "Queueing…", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  // The modal makes navigation inert; invoke the existing link to prove its
  // pending guard also rejects a navigation request behind that modal.
  await page.evaluate(() => {
    document
      .querySelector<HTMLAnchorElement>('a[href="/manage?view=organization"]')
      ?.click();
  });
  await expect(page).toHaveURL(/view=backup/);
  expect(backup.queueRequests).toHaveLength(1);
  release();
  await expect(dialog).toBeHidden();
  backup.runs[0] = {
    ...backup.runs[0]!,
    state: "failed",
    started_at: "2026-10-08T12:01:00Z",
    finished_at: "2026-10-08T12:04:00Z",
    failure_code: "restart_failed",
    snapshot_id: "b".repeat(64),
    manifest_sha256: "b".repeat(64),
    verified_at: "2026-10-08T12:03:00Z",
  };
  backup.runner.state = "recovery_required";
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_runs" });
  await expect(
    page.getByText("Operator recovery required", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect Held request", exact: true })
    .click();
  const inspector = page.getByRole("region", {
    name: "Selected backup",
    exact: true,
  });
  await expect(inspector).toContainText("Verified");
  await expect(inspector).toContainText("Not reconciled");
  await expect(inspector).toContainText("Services did not restart");
  await expect(inspector.getByText("Completed", { exact: true })).toHaveCount(
    0,
  );
});
