import {
  authMeBody,
  defaultOrganization,
  expect,
  heldResponse,
  settleReact,
  signedInAs,
  test,
  type Page,
} from "./helpers/test";
import { wireWorkspace } from "../helpers/wire";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { pageOf, wirePagination } from "../helpers/pagination";

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
    backupRunIds: [] as (string | null)[],
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
    state.backupRunIds.push(url.searchParams.get("run_id"));
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
        pagination: wirePagination({ limit: 1, count: 1, total: 1 }),
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
      json: pageOf(pageItems, { limit, offset, total: items.length }),
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
    region.getByRole("link", { name: "Open record" }),
  ).toHaveAttribute(
    "href",
    `/openview?section=views&module=${moduleId}&record=${recordId}`,
  );
  await expect(region.getByRole("link")).toHaveCount(5);
  await expect(region.getByText(/· Scheduled/)).toHaveCount(1);
  expect(
    state.sourceReads.some((path) =>
      /^\/api\/(records|sandbox\/versions|users)\//.test(path),
    ),
  ).toBe(false);
  await expect(region).not.toContainText(recordId);
  await expect(region).not.toContainText("Private body/email/snapshot");
  // Every Backup title read asks for this notice's run.
  expect([...new Set(state.backupRunIds)]).toEqual([backupId]);
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
  expect([...new Set(state.backupRunIds)]).toEqual([backupId]);
});

async function commsSetup(page: Page) {
  await installOpenViewEventSource(page);
  const first = { ...defaultOrganization, role: "admin" as const };
  const second = {
    org_id: id(702),
    name: "Second organization",
    slug: "second",
    role: "admin" as const,
  };
  const state = {
    organization: first as typeof first | typeof second,
    account: userId,
    metadataStatus: 200,
    metadataOrg: null as string | null,
    title: "Current dispatch channel",
    hold: null as
      | (ReturnType<typeof heldResponse> & {
          finished: ReturnType<typeof heldResponse>;
        })
      | null,
    foreignRow: false,
    sourceReads: [] as string[],
    selectedOrganizations: [] as string[],
  };
  const identity = () =>
    authMeBody({
      id: state.account,
      role: "admin",
      memberships: [first, second],
      current_organization: { ...state.organization, access: [] },
    });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: identity() }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: state.account,
        organization_id: state.organization.org_id,
        default_organization_blocked: null,
        setup_required: false,
      },
    }),
  );
  await page.route("**/api/auth/session/organization", (route) => {
    const selected = route.request().postDataJSON().org_id;
    state.selectedOrganizations.push(selected);
    state.organization = selected === first.org_id ? first : second;
    return route.fulfill({ json: identity() });
  });
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: wireWorkspace({
        id: state.organization.org_id,
        display_name: state.organization.name,
        locale: "en-US",
        timezone: "UTC",
        currency: "USD",
        today: "2026-10-20",
        purge_enabled: true,
      }),
    }),
  );
  await page.route("**/api/notifications**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("unread-count"))
      return route.fulfill({ json: { unread_count: 4 } });
    const rows = [
      "comms-mention",
      "comms-direct",
      "comms-thread-reply",
      "comms-keyword",
    ].map((kind, index) => ({
      id: id(710 + index),
      kind,
      org_id: state.foreignRow ? second.org_id : state.organization.org_id,
      subject_type: "comms_message",
      subject_id: id(720 + index),
      message_id: id(720 + index),
      conversation_id: id(730),
      status: "unread",
      scheduled_for: null,
      created_at: when,
      read_at: null,
    }));
    return route.fulfill({
      json: pageOf(rows, {
        limit: Number(url.searchParams.get("limit")),
        offset: 0,
      }),
    });
  });
  await page.route("**/api/comms/**", async (route) => {
    const url = new URL(route.request().url());
    state.sourceReads.push(url.pathname);
    if (url.pathname !== `/api/comms/conversations/${id(730)}`)
      return route.fulfill({
        status: 500,
        json: { detail: "Message bodies must not be fetched" },
      });
    const body = {
      id: id(730),
      org_id: state.metadataOrg ?? state.organization.org_id,
      kind: "channel",
      name: state.title,
      topic: "Private topic not notification content",
      scope: "organization",
      category_id: null,
      position: 0,
      member_count: 2,
      member_role: "member",
      level: "read",
      archived_at: null,
      created_at: when,
      updated_at: when,
    };
    const held = state.hold;
    if (held) {
      held.enter();
      await held.released;
    }
    await route.fulfill(
      state.metadataStatus === 200
        ? { json: body, headers: { ETag: '"conversation-1"' } }
        : {
            status: state.metadataStatus,
            json: { detail: "Private denial detail" },
          },
    );
    held?.finished.enter();
  });
  return state;
}

test("Comms inbox opens a current-organization message through the shell's unsaved-work guard", async ({
  page,
}) => {
  const state = await commsSetup(page);
  await page.goto("/platform?section=notifications");
  const region = inbox(page);
  await expect(
    region.getByText("Current dispatch channel", { exact: true }),
  ).toHaveCount(4);
  for (const label of [
    "Mention",
    "Direct message",
    "Thread reply",
    "Keyword match",
  ])
    await expect(region.getByText(label, { exact: true })).toBeVisible();
  await expect(region.getByText(/· Scheduled/)).toHaveCount(0);
  await expect(region).not.toContainText("Private topic");
  await expect(
    region.getByRole("link", { name: "Open message" }).first(),
  ).toHaveAttribute(
    "href",
    `/comms?conversation=${id(730)}&message=${id(720)}`,
  );
  await page
    .getByRole("button", { name: "Organization: OpenSlate", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /Second organization/ }).click();
  await expect(
    page.getByRole("button", {
      name: "Organization: Second organization",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Unsaved organization change");
  await page.getByRole("button", { name: "Notifications, 4 unread" }).click();
  const popup = page.getByRole("dialog", {
    name: "Notifications",
    exact: true,
  });
  await popup.getByRole("link", { name: "Open message" }).first().click();
  const guard = page.getByRole("alertdialog", {
    name: "Discard unsaved Manage changes?",
  });
  await expect(guard).toBeVisible();
  await expect(page).toHaveURL(/\/manage/);
  await guard
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/comms\\?conversation=${id(730)}&message=${id(720)}`),
  );
  await expect(
    page.getByRole("button", {
      name: "Organization: Second organization",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.selectedOrganizations).toEqual([id(702)]);
  expect([...new Set(state.sourceReads)]).toEqual([
    `/api/comms/conversations/${id(730)}`,
  ]);
});

test("Comms metadata failures hide cached titles and destinations and foreign inbox rows are refused", async ({
  page,
}) => {
  const state = await commsSetup(page);
  await page.goto("/platform?section=notifications");
  const region = inbox(page);
  await expect(region.getByText(state.title, { exact: true })).toHaveCount(4);
  state.metadataStatus = 404;
  await sendOpenViewEvent(page, "resync");
  await expect(
    region.getByText("You no longer have access to this item."),
  ).toHaveCount(4);
  await expect(region.getByRole("link", { name: "Open message" })).toHaveCount(
    0,
  );
  await expect(region).not.toContainText(state.title);
  await expect(region).not.toContainText("Private denial detail");
  state.metadataStatus = 503;
  await sendOpenViewEvent(page, "resync");
  await expect(region.getByText("The title couldn’t be loaded.")).toHaveCount(
    4,
  );
  state.metadataStatus = 200;
  await region
    .getByRole("button", { name: "Try again", exact: true })
    .first()
    .click();
  await expect(region.getByText(state.title, { exact: true })).toHaveCount(4);
  state.foreignRow = true;
  // Invalid refreshes preserve a last-good authorized page. A cold inbox
  // must refuse the foreign row altogether, not render or query its source.
  await page.reload();
  await expect(region.getByText(state.title, { exact: true })).toHaveCount(0);
  await expect(region.getByRole("link", { name: "Open message" })).toHaveCount(
    0,
  );
  await expect(region.getByRole("alert")).toBeVisible();
});

test("Comms metadata completed after organization and account changes cannot populate the new inbox", async ({
  page,
}) => {
  const state = await commsSetup(page);
  state.hold = { ...heldResponse(), finished: heldResponse() };
  const oldRead = state.hold;
  await page.goto("/platform?section=notifications");
  await oldRead.entered;
  state.hold = null;
  state.title = "Second organization channel";
  await page
    .getByRole("button", { name: "Organization: OpenSlate", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /Second organization/ }).click();
  await expect(
    page.getByRole("button", {
      name: "Organization: Second organization",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Notifications, 4 unread" }).click();
  await expect(
    page.getByText("Second organization channel", { exact: true }),
  ).toHaveCount(4);
  oldRead.release();
  await oldRead.finished.entered;
  await settleReact(page, 1);
  await expect(
    page.getByText("Current dispatch channel", { exact: true }),
  ).toHaveCount(0);
  state.hold = { ...heldResponse(), finished: heldResponse() };
  const oldAccountRead = state.hold;
  await sendOpenViewEvent(page, "resync");
  await oldAccountRead.entered;
  state.hold = null;
  state.account = id(799);
  state.title = "New account channel";
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await page.getByRole("button", { name: "Notifications, 4 unread" }).click();
  await expect(
    page.getByText("New account channel", { exact: true }),
  ).toHaveCount(4);
  oldAccountRead.release();
  await oldAccountRead.finished.entered;
  await settleReact(page, 1);
  await expect(
    page.getByText("Second organization channel", { exact: true }),
  ).toHaveCount(0);
});
