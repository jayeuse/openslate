import { expect, heldResponse, test } from "./helpers/test";
import { mockManageSecurity } from "./helpers/manage-security";
import { backupRun, mockManageBackups } from "./helpers/manage-backups";
import { sendOpenViewEvent } from "./helpers/openview-event-source";

test("Back up now queues real history, cancels without writes, and preserves policy drafts", async ({
  page,
}) => {
  const security = await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  await page.goto("/manage?view=backup");
  const rows = page
    .getByRole("list", { name: "Backup history", exact: true })
    .getByRole("listitem");
  await expect(rows).toHaveCount(6);
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
  const name = dialog.getByLabel("Backup name", { exact: true });
  await name.fill(" ");
  await dialog
    .getByRole("button", { name: "Back up now", exact: true })
    .click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(dialog).toContainText("Enter a backup name");
  expect(backup.queueRequests).toEqual([]);
  await name.fill("Cancelled backup");
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
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await expect(
    policy.getByLabel("Backup schedule", { exact: true }),
  ).toHaveValue("weekly");
  expect(security.writes).toEqual([]);
  expect(security.policyReads).toBe(0);
  expect(backup.patches).toEqual([]);
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Inspect Working recovery point",
      exact: true,
    }),
  ).toBeVisible();
});

test("Backup request name validation and cancel restore focus without any local snapshot mutation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  await page.goto("/manage?view=backup");
  const opener = page.getByRole("button", { name: "Back up now", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Back up now", exact: true });
  const name = dialog.getByLabel("Backup name", { exact: true });
  const submit = dialog.getByRole("button", {
    name: "Back up now",
    exact: true,
  });
  await name.fill(" ");
  await submit.click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(dialog).toContainText("Enter a backup name");
  expect(backup.queueRequests).toEqual([]);
  await name.fill("Preserved name");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(backup.queueRequests).toEqual([]);
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
  ).toHaveCount(0);
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
  backup.runs = Array.from({ length: 12 }, (_, index) =>
    backupRun(index + 1),
  ).map((run, index) => ({
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
  const rows = page
    .getByRole("list", { name: "Backup history", exact: true })
    .getByRole("listitem");
  const status = page.getByRole("group", { name: "Status", exact: true });
  const inspector = page.getByRole("region", {
    name: "Selected backup",
    exact: true,
  });
  await status.getByRole("button", { name: "Queued", exact: true }).click();
  // A full page of ten scrolls inside the list; its paging stays in view.
  await expect(rows).toHaveCount(10);
  await expect(
    page.getByRole("navigation", { name: "Backup pages" }),
  ).toBeInViewport();
  await page
    .getByRole("button", { name: "Inspect Backup 1", exact: true })
    .click();
  await expect(inspector).toBeVisible();
  await page
    .getByRole("navigation", { name: "Backup pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(rows).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Inspect Backup 12", exact: true }),
  ).toBeVisible();
  await expect(inspector).toHaveCount(0);
  expect(backup.historyReads.at(-1)?.get("offset")).toBe("10");
  backup.runs = backup.runs.map((run, index) =>
    index < 2 ? run : backupRun(index + 1),
  );
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_runs" });
  await expect(
    page.getByText("Showing 1–2 of 2", { exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Inspect Backup 1", exact: true }),
  ).toBeVisible();
  await expect(inspector).toHaveCount(0);
  expect(backup.historyReads.at(-1)?.get("offset")).toBe("0");
  expect(backup.historyReads.at(-1)?.get("limit")).toBe("10");
  expect(backup.historyReads.at(-1)?.get("state")).toBe("queued");
  await status.getByRole("button", { name: "All", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search backups" })
    .fill("Backup 6");
  await expect(rows).toHaveCount(1);
  expect(backup.historyReads.at(-1)?.get("offset")).toBe("0");
  await page.getByRole("searchbox", { name: "Search backups" }).fill("");
  await page.getByLabel("Rows per page", { exact: true }).selectOption("25");
  await expect(rows).toHaveCount(12);
  await page
    .getByRole("button", { name: "Inspect Backup 2", exact: true })
    .click();
  await expect(inspector).toContainText("Previous installation");
  await page.getByLabel("Sort backups").selectOption("name");
  await expect(inspector).toHaveCount(0);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page
    .getByLabel("Installation", { exact: true })
    .selectOption("previous");
  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(1);
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
    page.getByText("Backup status could not be loaded.", { exact: true }),
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
    .getByRole("button", { name: "Retry backup status", exact: true })
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
    page.getByText("Backup status could not be loaded.", { exact: true }),
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
  ).toHaveCount(0);
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
  ).toHaveCount(0);
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
  const held = heldResponse();
  backup.holdWrite = held.released;
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
  held.release();
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

// One run of each state the list shows: queued, running, completed and
// verified, completed without verification, and failed.
function mixedHistory(backup: Awaited<ReturnType<typeof mockManageBackups>>) {
  const notStarted = {
    started_at: null,
    finished_at: null,
    reconciled_at: null,
    snapshot_id: null,
    manifest_sha256: null,
    verified_at: null,
  };
  backup.runs = [
    backupRun(1, { name: "Queued request", state: "queued", ...notStarted }),
    backupRun(2, {
      name: "Running nightly",
      provenance: "scheduled",
      state: "running",
      finished_at: null,
      reconciled_at: null,
      snapshot_id: null,
      manifest_sha256: null,
      verified_at: null,
    }),
    backupRun(3, {
      name: "Verified nightly",
      provenance: "scheduled",
      snapshot_id: "a1b2c3d4" + "0".repeat(48) + "e5f6a7b8",
    }),
    backupRun(4, { name: "Unchecked copy", verified_at: null }),
    backupRun(5, {
      name: "Failed nightly",
      state: "failed",
      failure_code: "backup_failed",
      snapshot_id: null,
      manifest_sha256: null,
      verified_at: null,
    }),
  ];
}

test("Backup opens on one status panel of facts, with Back up now as the one primary action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  mixedHistory(backup);
  backup.policy.schedule = "daily";
  backup.runner.state = "available";
  backup.runner.last_seen_at = "2026-10-08T03:00:00Z";
  await page.goto("/manage?view=backup");
  const panel = page.getByRole("region", {
    name: "Backup status",
    exact: true,
  });
  await expect(panel.locator("dt")).toHaveText([
    "Schedule",
    "Last good backup",
    "Service",
    "Queue",
  ]);
  await expect(panel.locator("dd")).toHaveText([
    "On · Daily at 02:00 · Kept 30 days",
    "Oct 5, 2026, 10:05 AM · Verified",
    "Available · Checked in Oct 8, 2026, 11:00 AM",
    "1 queued · 1 running",
  ]);
  // The last good backup is one bounded read of the newest completed run.
  expect(backup.lastGoodReads.at(-1)?.get("installation")).toBe("current");
  expect(backup.lastGoodReads.at(-1)?.get("sort_order")).toBe("desc");
  await expect(panel.getByTestId("backup-service-warning")).toHaveCount(0);
  // Back up now is the section's one primary action; Edit schedule is quiet.
  const primary = page
    .getByRole("main")
    .locator('[data-slot="button"][data-variant="default"]');
  await expect(primary).toHaveText(["Back up now"]);
  await expect(
    panel.getByRole("button", { name: "Edit schedule", exact: true }),
  ).toHaveAttribute("data-variant", "ghost");

  // A service that stops checking in says so in one warning line.
  backup.runner.state = "stale";
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_policies" });
  await expect(panel.getByTestId("backup-service-warning")).toHaveText(
    "The backup service has not checked in recently.",
  );
  backup.runner.state = "recovery_required";
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_policies" });
  await expect(panel.getByTestId("backup-service-warning")).toHaveText(
    "The person who runs your server must fix the backup service. New requests wait in the queue.",
  );
});

test("Backup history lists 40px rows with a status word, status quick filters, and Filters chips", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  mixedHistory(backup);
  await page.goto("/manage?view=backup");
  const list = page.getByRole("list", { name: "Backup history", exact: true });
  const rows = list.getByRole("button");
  await expect(rows).toHaveCount(5);
  const described = [
    ["Inspect Queued request", "Queued · Oct 7, 2026, 10:00 AM"],
    ["Inspect Running nightly", "Running · Oct 6, 2026, 10:00 AM"],
    ["Inspect Verified nightly", "Verified · Oct 5, 2026, 10:00 AM"],
    ["Inspect Unchecked copy", "Completed · Oct 4, 2026, 10:00 AM"],
  ] as const;
  for (const [index, [name, description]] of described.entries()) {
    await expect(rows.nth(index)).toHaveAccessibleName(name);
    await expect(rows.nth(index)).toHaveAccessibleDescription(description);
  }
  expect((await rows.first().boundingBox())?.height).toBe(40);
  await expect(page.getByRole("button", { name: "More filters" })).toHaveCount(
    0,
  );

  const status = page.getByRole("group", { name: "Status", exact: true });
  await expect(status.getByRole("button")).toHaveText([
    "All",
    "Queued",
    "Running",
    "Completed",
    "Failed",
    "Interrupted",
  ]);
  await status.getByRole("button", { name: "Failed", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAccessibleName("Inspect Failed nightly");
  await expect(rows.first()).toHaveAccessibleDescription(
    "Failed · Oct 3, 2026, 10:00 AM",
  );
  expect(backup.historyReads.at(-1)?.get("state")).toBe("failed");
  await status.getByRole("button", { name: "All", exact: true }).click();
  await expect(rows).toHaveCount(5);

  // Source and Installation wait in the Filters popover and show as chips.
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page
    .getByLabel("Request source", { exact: true })
    .selectOption("scheduled");
  await page.keyboard.press("Escape");
  const chips = page.getByRole("group", { name: "Active filters" });
  await expect(chips).toContainText("Source: Scheduled");
  await expect(rows).toHaveCount(2);
  expect(backup.historyReads.at(-1)?.get("provenance")).toBe("scheduled");
  await chips
    .getByRole("button", { name: "Remove Source filter", exact: true })
    .click();
  await expect(chips).toHaveCount(0);
  await expect(rows).toHaveCount(5);
});

test("a backup's detail shows label-left facts, a short snapshot id with its full value and copy, and the export reason", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copiedSnapshot = text;
        },
      },
    }),
  );
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  mixedHistory(backup);
  await page.goto("/manage?view=backup");
  await page
    .getByRole("button", { name: "Inspect Verified nightly", exact: true })
    .click();
  const detail = page.getByRole("region", {
    name: "Selected backup",
    exact: true,
  });
  await expect(detail.locator("dt")).toHaveText([
    "Requested",
    "Source",
    "Schedule at request",
    "Started",
    "Finished",
    "Snapshot",
    "Verification",
    "Restart / reconciliation",
    "Restore",
  ]);
  await expect(
    detail.getByText("Daily at 02:00 · Kept 30 days", { exact: true }),
  ).toBeVisible();
  const snapshot = detail.getByText("a1b2c3d4…e5f6a7b8", { exact: true });
  await expect(snapshot).toHaveAttribute(
    "title",
    "a1b2c3d4" + "0".repeat(48) + "e5f6a7b8",
  );
  await detail
    .getByRole("button", { name: "Copy snapshot ID", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-copied-snapshot",
    "a1b2c3d4" + "0".repeat(48) + "e5f6a7b8",
  );
  await expect(detail.getByRole("status")).toHaveText("Snapshot ID copied");
  await expect(
    detail.getByRole("button", { name: "Prepare encrypted backup" }),
  ).toBeEnabled();

  await page
    .getByRole("button", { name: "Inspect Unchecked copy", exact: true })
    .click();
  const prepare = detail.getByRole("button", {
    name: "Prepare encrypted backup",
  });
  await expect(prepare).toBeDisabled();
  await expect(prepare).toHaveAccessibleDescription(
    "This backup is not verified yet.",
  );
  // The reason is also one visible line under the button.
  await expect(
    detail.getByText("This backup is not verified yet.", { exact: true }),
  ).toBeVisible();
});

test("the schedule dialog shows only Close at rest, and its Save bar after an edit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await expect(
    dialog.getByRole("button", { name: "Close backup schedule", exact: true }),
  ).toBeVisible();
  const footer = dialog.getByTestId("backup-schedule-footer");
  await expect(footer.getByRole("button")).toHaveText(["Close"]);
  // Label-left rows: each label sits beside its field.
  const label = dialog.getByText("Retention period", { exact: true });
  const field = dialog.getByLabel("Retention period", { exact: true });
  const labelBox = await label.boundingBox();
  const fieldBox = await field.boundingBox();
  expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(fieldBox!.x);
  expect(Math.abs(labelBox!.y - fieldBox!.y)).toBeLessThan(fieldBox!.height);

  await dialog
    .getByLabel("Backup schedule", { exact: true })
    .selectOption("weekly");
  await expect(footer.getByRole("button")).toHaveText([
    "Close",
    "Discard changes",
    "Save settings",
  ]);
  await expect(
    footer.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByLabel("Backup schedule", { exact: true })
    .selectOption("disabled");
  await expect(footer.getByRole("button")).toHaveText(["Close"]);
  expect(backup.patches).toEqual([]);

  // Close, the named close and Escape each return focus to Edit schedule.
  const edit = page.getByRole("button", { name: "Edit schedule", exact: true });
  for (const close of ["Close", "Close backup schedule", "Escape"]) {
    if (close === "Escape") await page.keyboard.press("Escape");
    else await dialog.getByRole("button", { name: close, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(edit, close).toBeFocused();
    if (close !== "Escape") await edit.click();
  }
});

test("after a refusal, Back up now and Edit schedule stay disabled and say why", async ({
  page,
}) => {
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  backup.statusReadStatus = 503;
  await page.goto("/manage?view=backup");
  const backUp = page.getByRole("button", { name: "Back up now", exact: true });
  const edit = page.getByRole("button", { name: "Edit schedule", exact: true });
  for (const action of [backUp, edit]) {
    await expect(action).toBeDisabled();
    await expect(action).toHaveAccessibleDescription(
      "Retry the backup status first.",
    );
  }
  backup.statusReadStatus = 200;
  await page
    .getByRole("button", { name: "Retry backup status", exact: true })
    .click();
  await expect(backUp).toBeEnabled();

  // A command refused for the installation owner disables both actions.
  await page.route(/\/api\/backups$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 403,
      json: {
        detail: {
          code: "operator_required",
          message: "Only the installation owner can change this setting",
        },
      },
    });
  });
  await backUp.click();
  const dialog = page.getByRole("dialog", { name: "Back up now", exact: true });
  await dialog
    .getByRole("button", { name: "Back up now", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Only the installation owner can do this.",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  // Focus returns to Back up now, which now says why it cannot act.
  await expect(backUp).toBeFocused();
  for (const action of [backUp, edit]) {
    await expect(action).toBeDisabled();
    await expect(action).toHaveAccessibleDescription(
      "Only the installation owner can do this.",
    );
  }

  // A fresh status read after Retry ends the owner refusal.
  backup.statusReadStatus = 503;
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_policies" });
  const retry = page.getByRole("button", {
    name: "Retry backup status",
    exact: true,
  });
  await expect(retry).toBeVisible();
  backup.statusReadStatus = 200;
  await retry.click();
  await expect(backUp).toBeEnabled();
  await expect(edit).toBeEnabled();
});

test("on a phone, Backup shows the list first, then one backup's detail with Back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  mixedHistory(backup);
  await page.goto("/manage?view=backup");
  const list = page.getByRole("list", { name: "Backup history", exact: true });
  const detail = page.getByRole("region", {
    name: "Selected backup",
    exact: true,
  });
  await expect(list).toBeVisible();
  await expect(detail).toBeHidden();
  const verified = page.getByRole("button", {
    name: "Inspect Verified nightly",
    exact: true,
  });
  expect((await verified.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await verified.click();
  await expect(detail).toBeVisible();
  await expect(list).toBeHidden();
  await expect(
    detail.getByRole("heading", { name: "Verified nightly", exact: true }),
  ).toBeFocused();
  await detail
    .getByRole("button", { name: "Back to History", exact: true })
    .click();
  await expect(list).toBeVisible();
  await expect(verified).toBeFocused();
});
