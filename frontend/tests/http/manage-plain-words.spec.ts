import { expect, test, type Page } from "./helpers/test";
import { fixtureId } from "./helpers/access-api";
import { backupRun, mockManageBackups } from "./helpers/manage-backups";
import { sendOpenViewEvent } from "./helpers/openview-event-source";

// Phase 7 of docs/specs/manage-relayout.md: the words a Manage user sees are
// customer words. The glossary marks Binding, Operator, Reconciliation and
// Policy as internal (docs/architecture/21-glossary.md), so no rendered
// Manage state that once showed them may show them again. Each state below
// is one where an old word lived. Security events keep "Account policy
// change", the Access word (MD11), and are not opened here.

const INTERNAL =
  /\b(bindings?|operators?|reconcil\w*|polic(?:y|ies)|authentication|memberships?)\b/i;

/** The words the page shows now, dialogs and popovers included. */
async function shownWords(page: Page): Promise<string> {
  return page.locator("body").innerText();
}

/** The names that controls and regions carry for assistive technology. */
async function accessibleLabels(page: Page): Promise<string> {
  return page
    .locator("[aria-label]")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label")).join("\n"),
    );
}

async function expectCustomerWords(page: Page, state: string) {
  expect(await shownWords(page), state).not.toMatch(INTERNAL);
  expect(await accessibleLabels(page), `${state} (aria-label)`).not.toMatch(
    INTERNAL,
  );
}

function auditLog(index: number, entityType: string, target: string) {
  return {
    id: fixtureId(7000 + index),
    created_at: `2026-10-0${1 + index}T09:00:00Z`,
    performed_by: fixtureId(7900),
    action: "update",
    entity_type: entityType,
    entity_id: fixtureId(7100 + index),
    department_id: null,
    before: { status: "open" },
    after: { status: "closed" },
    request_id: null,
    request_method: "PATCH",
    request_path: null,
    actor_label: null,
    actor_name: "Mara Santos",
    target_label: target,
    note: null,
  };
}

async function mockAudit(page: Page) {
  const items = [
    auditLog(0, "sandbox_bindings", "Orders module"),
    auditLog(1, "sandbox_publications", "Harbor design"),
    auditLog(2, "memberships", "Jay Reyes"),
    auditLog(3, "backup_policies", "Nightly schedule"),
  ];
  await page.route("**/api/audit-logs**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/audit-logs/options")
      return route.fulfill({
        json: {
          entity_types: items.map((item) => item.entity_type),
          actors: [
            {
              performed_by: fixtureId(7900),
              actor_label: null,
              actor_name: "Mara Santos",
            },
          ],
        },
      });
    return route.fulfill({
      json: {
        items,
        pagination: {
          limit: 10,
          offset: 0,
          count: items.length,
          total: items.length,
          has_more: false,
        },
      },
    });
  });
}

async function mockJobs(page: Page) {
  const rows = [
    ["comms-export", "Harbor channel export", "failed", "copy_failed"],
    ["comms-scheduled-message", "Shift reminder", "pending", null],
    ["backup", "Nightly backup", "succeeded", null],
  ] as const;
  const items = rows.map(([kind, subject, state, failure], index) => ({
    id: fixtureId(7500 + index),
    kind,
    subject_label: subject,
    subject_link: null,
    state,
    can_retry: state === "failed",
    scheduled_for: "2026-10-01T00:00:00Z",
    last_attempt_at: "2026-10-01T00:05:00Z",
    next_attempt_at: state === "pending" ? "2026-10-02T00:00:00Z" : null,
    attempts: state === "pending" ? 0 : 1,
    failure_code: failure,
    failure_label: failure ? "The copy did not finish" : null,
  }));
  await page.route("**/api/jobs**", (route) =>
    route.fulfill({
      json: {
        items,
        pagination: {
          limit: 10,
          offset: 0,
          count: items.length,
          total: items.length,
          has_more: false,
        },
      },
    }),
  );
}

test("no Manage state shows an internal glossary word", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const backup = await mockManageBackups(page);
  backup.runner = {
    state: "recovery_required",
    last_seen_at: "2026-10-08T03:00:00Z",
  };
  backup.runs = [
    backupRun(1, {
      name: "Unfinished nightly",
      state: "failed",
      reconciled_at: null,
      failure_code: "restart_failed",
    }),
    backupRun(2, {
      name: "Scheduled nightly",
      provenance: "scheduled",
    }),
    backupRun(3, {
      name: "Slow restart",
      state: "failed",
      failure_code: "readiness_failed",
    }),
  ];
  backup.version = {
    ...backup.version,
    status: "stale",
    latest_version: "0.2.0",
    observed_at: "2026-10-01T00:00:00Z",
    failure_code: null,
  };
  await mockAudit(page);
  await mockJobs(page);

  await page.goto("/manage?view=organization");
  await expect(page.getByText("Identity", { exact: true })).toBeVisible();
  await expectCustomerWords(page, "Organization");

  // Backup: a service waiting for the owner, then each detail.
  // Each state waits on words it had before Phase 7, checks the shown words,
  // then names the new word, so the guard cannot pass on a half-drawn page.
  await page.goto("/manage?view=backup");
  await expect(page.getByTestId("backup-service-warning")).toBeVisible();
  await expectCustomerWords(page, "Backup status");
  await expect(
    page
      .getByRole("region", { name: "Backup status", exact: true })
      .getByText("Needs recovery on the server", { exact: true }),
  ).toBeVisible();
  const detail = page.getByRole("region", {
    name: "Selected backup",
    exact: true,
  });
  for (const [name, back] of [
    ["Unfinished nightly", "Needs recovery on the server"],
    ["Scheduled nightly", /^Recorded · /],
    ["Slow restart", /^Recorded · /],
  ] as const) {
    await page
      .getByRole("button", { name: `Inspect ${name}`, exact: true })
      .click();
    await expect(detail.getByRole("heading", { name })).toBeVisible();
    await expectCustomerWords(page, `Backup detail of ${name}`);
    await expect(
      detail.locator('dt:text-is("Server restart") + dd'),
    ).toHaveText(back);
  }
  await expect(detail.locator('dt:text-is("Source") + dd')).toHaveText(
    "Manual",
  );

  // The schedule dialog after an edit, then after a newer save elsewhere.
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  const schedule = page.getByRole("dialog", {
    name: "Backup schedule",
    exact: true,
  });
  await schedule
    .getByLabel("Backup schedule", { exact: true })
    .selectOption("weekly");
  await expect(
    schedule.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeVisible();
  await expectCustomerWords(page, "Schedule dialog after an edit");
  await expect(
    schedule.getByRole("button", { name: "Save schedule", exact: true }),
  ).toBeVisible();
  backup.policy = { ...backup.policy, revision: 2, schedule: "daily" };
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_policies" });
  await expect(schedule).toContainText("Your draft is still here.");
  await expectCustomerWords(page, "Schedule dialog after a newer save");
  await expect(schedule).toContainText(
    "The backup schedule changed. Your draft is still here.",
  );
  await schedule
    .getByRole("button", { name: "Close backup schedule", exact: true })
    .click();

  backup.runner = { state: "adoption_required", last_seen_at: null };
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_policies" });
  await expect(page.getByText(/Never checked in/)).toBeVisible();
  await expectCustomerWords(page, "Backup after a restore");
  await expect(page.getByTestId("backup-service-warning")).toHaveText(
    "The person who runs your server must confirm backups after the restore. New requests wait in the queue.",
  );

  // Audit: the rows and the Filters popover with every Area.
  await page.goto("/manage?view=audit");
  await expect(page.getByText("Orders module").first()).toBeVisible();
  await expectCustomerWords(page, "Audit rows");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("combobox", { name: "Area", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "Backup schedules · Manage" }),
  ).toBeVisible();
  await expectCustomerWords(page, "Audit Filters");
  await expect(
    page.getByRole("option", { name: "Live item links · Sandbox" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/manage?view=jobs");
  await expect(
    page.getByText("Harbor channel export", { exact: true }).first(),
  ).toBeVisible();
  await expectCustomerWords(page, "Jobs");
  await expect(
    page.getByText("OpenComms export", { exact: true }).first(),
  ).toBeVisible();

  await page.goto("/manage?view=updates");
  await expect(page.getByText("0.1.0 · Stable channel")).toBeVisible();
  await expectCustomerWords(page, "Updates");
  await expect(
    page.getByText("The release check is out of date", { exact: true }),
  ).toBeVisible();
});
