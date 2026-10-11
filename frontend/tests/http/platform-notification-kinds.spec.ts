import { expect, signedInAs, test, type Page } from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userId = id(101),
  reportId = id(201),
  moduleId = id(202),
  backupId = id(203);
const recordId = id(204),
  acceptedId = id(205),
  versionId = id(206);
const when = "2026-10-06T12:00:00Z";

function notifications() {
  return [
    {
      kind: "report-run-failed",
      subject_type: "scheduled_work",
      subject_id: id(301),
      report_id: reportId,
      scheduled_for: when,
    },
    {
      kind: "backup-failed",
      subject_type: "backup_run",
      subject_id: backupId,
      scheduled_for: null,
    },
    {
      kind: "record-assigned",
      subject_type: "record",
      subject_id: recordId,
      module_id: moduleId,
      scheduled_for: null,
    },
    {
      kind: "invitation-accepted",
      subject_type: "user",
      subject_id: acceptedId,
      scheduled_for: null,
    },
    {
      kind: "sandbox-published",
      subject_type: "sandbox_version",
      subject_id: versionId,
      version_sequence: 8,
      scheduled_for: null,
    },
    {
      kind: "access-changed",
      subject_type: "user",
      subject_id: userId,
      scheduled_for: null,
    },
  ].map((item, index) => ({
    ...item,
    id: id(401 + index),
    status: "unread",
    created_at: when,
    read_at: null as string | null,
  }));
}

async function setup(page: Page) {
  await installOpenViewEventSource(page);
  await signedInAs(page, { id: userId, role: "admin" });
  const state = {
    items: notifications(),
    reportStatus: 200,
    backupStatus: 200,
    backupResponseId: backupId,
    commands: [] as string[],
    sourceReads: [] as string[],
  };
  await page.route("**/api/reports/**", async (route) => {
    state.sourceReads.push(new URL(route.request().url()).pathname);
    if (state.reportStatus !== 200)
      return route.fulfill({
        status: state.reportStatus,
        json: { detail: "Private report detail" },
      });
    await route.fulfill({
      json: {
        id: reportId,
        module_id: moduleId,
        name: "Monthly operations review",
        subtitle: null,
        revision: 1,
        recipe: {
          version: 1,
          fields: [{ field_id: id(501), expected_type: "text" }],
          filters: [],
          logic: "and",
          sorts: [],
          group_by: null,
          include_row_count: true,
        },
        is_deleted: false,
        created_at: when,
        updated_at: when,
      },
    });
  });
  await page.route("**/api/backups?**", async (route) => {
    const url = new URL(route.request().url());
    state.sourceReads.push(url.pathname + url.search);
    expect(url.searchParams.get("run_id")).toBe(backupId);
    if (state.backupStatus !== 200)
      return route.fulfill({
        status: state.backupStatus,
        json: { detail: "Private backup detail" },
      });
    await route.fulfill({
      json: {
        items: [
          {
            id: state.backupResponseId,
            name: "Nightly safety copy",
            provenance: "scheduled",
            installation: "current",
            state: "failed",
            requested_at: when,
            started_at: when,
            finished_at: when,
            reconciled_at: when,
            schedule: "daily",
            retention_days: 30,
            snapshot_id: null,
            manifest_sha256: null,
            verified_at: null,
            failure_code: "backup_failed",
            expired_at: null,
          },
        ],
        pagination: {
          limit: 1,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      },
    });
  });
  await page.route(
    /\/api\/(?:records|sandbox\/versions|users)\/[0-9a-f-]+$/,
    async (route) => {
      state.sourceReads.push(new URL(route.request().url()).pathname);
      await route.fulfill({
        status: 500,
        json: { detail: "Private body/email/snapshot must not be loaded" },
      });
    },
  );
  await page.route("**/api/notifications**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname.endsWith("unread-count"))
      return route.fulfill({
        json: {
          unread_count: state.items.filter((item) => item.status === "unread")
            .length,
        },
      });
    if (request.method() === "POST") {
      state.commands.push(url.pathname);
      const all = url.pathname.endsWith("read-all"),
        notificationId = url.pathname.split("/")[3];
      const selected = state.items.filter(
        (item) =>
          item.status === "unread" && (all || item.id === notificationId),
      );
      selected.forEach((item) => {
        item.status = "read";
        item.read_at = when;
      });
      return route.fulfill({
        json: all
          ? { updated_count: selected.length }
          : state.items.find((item) => item.id === notificationId),
      });
    }
    const limit = Number(url.searchParams.get("limit")),
      offset = Number(url.searchParams.get("offset"));
    const items =
      url.searchParams.get("status") === "unread"
        ? state.items.filter((item) => item.status === "unread")
        : state.items;
    const pageItems = items.slice(offset, offset + limit);
    return route.fulfill({
      json: {
        items: pageItems,
        pagination: {
          limit,
          offset,
          count: pageItems.length,
          total: items.length,
          has_more: offset + pageItems.length < items.length,
        },
      },
    });
  });
  return state;
}

const inbox = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });

test("six new kinds show exact current-source titles and destinations with only one scheduled date", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/platform?section=notifications");
  const region = inbox(page);
  for (const title of [
    "Monthly operations review",
    "Nightly safety copy",
    "Record assigned to you",
    "Invitation accepted",
    "Sandbox version 8 published",
    "Your access changed",
  ])
    await expect(region.getByText(title, { exact: true })).toBeVisible();
  await expect(
    region.getByRole("link", { name: "Open report" }),
  ).toHaveAttribute("href", `/openview?section=reports&report=${reportId}`);
  await expect(
    region.getByRole("link", { name: "Open backup history" }),
  ).toHaveAttribute("href", "/manage?view=backup");
  await expect(
    region.getByRole("link", { name: "Open record" }),
  ).toHaveAttribute(
    "href",
    `/openview?section=views&module=${moduleId}&record=${recordId}`,
  );
  await expect(
    region.getByRole("link", { name: "Open person" }),
  ).toHaveAttribute("href", `/access?view=people&user=${acceptedId}`);
  await expect(
    region.getByRole("link", { name: "Open version history" }),
  ).toHaveAttribute("href", "/sandbox?section=history");
  await expect(region.getByRole("link")).toHaveCount(5);
  await expect(region.getByText(/· Scheduled/)).toHaveCount(1);
  expect(
    state.sourceReads.some((path) =>
      /^\/api\/(records|sandbox\/versions|users)\//.test(path),
    ),
  ).toBe(false);
  await expect(region).not.toContainText(recordId);
  await expect(region).not.toContainText("Private body/email/snapshot");
});

test("new-kind mark-one and read-all reconcile confirmed unread state", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/platform?section=notifications");
  const region = inbox(page);
  await expect(
    region.getByText("Record assigned to you", { exact: true }),
  ).toBeVisible();
  const row = region
    .getByRole("listitem")
    .filter({ hasText: "Record assigned to you" });
  await row.getByRole("button", { name: "Mark as read", exact: true }).click();
  await expect(row.getByText("Read", { exact: true })).toBeVisible();
  await region
    .getByRole("button", { name: "Mark all as read", exact: true })
    .click();
  await expect(
    region.getByRole("button", { name: "Mark as read", exact: true }),
  ).toHaveCount(0);
  expect(state.commands).toEqual([
    `/api/notifications/${id(403)}/read`,
    "/api/notifications/read-all",
  ]);
});

test("source refusal and foreign Backup metadata expose no cached title or destination", async ({
  page,
}) => {
  const state = await setup(page);
  state.backupResponseId = id(999);
  state.reportStatus = 404;
  await page.goto("/platform?section=notifications");
  const region = inbox(page);
  // A refused source reads as lost access; a bad response can be retried.
  await expect(
    region.getByText("You no longer have access to this item."),
  ).toHaveCount(1);
  await expect(region.getByText("The title couldn’t be loaded.")).toHaveCount(
    1,
  );
  await expect(
    region.getByRole("button", { name: "Try again", exact: true }),
  ).toHaveCount(1);
  await expect(region.getByRole("link", { name: "Open report" })).toHaveCount(
    0,
  );
  await expect(
    region.getByRole("link", { name: "Open backup history" }),
  ).toHaveCount(0);
  await expect(region).not.toContainText("Nightly safety copy");
  await expect(region).not.toContainText("Private report detail");
  state.backupResponseId = backupId;
  state.reportStatus = 200;
  await region
    .getByRole("listitem")
    .filter({ hasText: "Backup failed" })
    .getByRole("button", { name: "Try again" })
    .click();
  await expect(
    region.getByText("Nightly safety copy", { exact: true }),
  ).toBeVisible();
  state.backupStatus = 403;
  state.items = state.items.filter((item) => item.kind !== "backup-failed");
  await sendOpenViewEvent(page, "resync");
  await expect(
    region.getByText("Nightly safety copy", { exact: true }),
  ).toHaveCount(0);
  await expect(
    region.getByRole("link", { name: "Open backup history" }),
  ).toHaveCount(0);
});
