import type { Page } from "@playwright/test";

import {
  answeredHeaders,
  expect,
  expectAnsweredReference,
  signedInAs,
  test,
} from "./helpers/test";

// Manage → System health, block 3 "Your organization" (docs/specs/
// system-health.md S3-C5, D8) and the reference words by role (D6-C1). The
// rules behind each line are owned by tests/isolated/manage/
// system-health-rules.spec.ts and system-health-view.spec.ts; these journeys
// prove the block comes from the one status read and the role reaches the
// page's references.

test.use({ trace: "off", screenshot: "off", video: "off" });

const adminId = "00000000-0000-4000-8000-000000000011";

const statusBody = (organization: unknown, installation: unknown = null) => ({
  parts: [
    { key: "data", status: "working" },
    { key: "signing_in", status: "working" },
    { key: "files", status: "working" },
    { key: "email", status: "set_up" },
  ],
  version: "0.1.0",
  checked_at: "2026-11-02T10:42:05Z",
  organization,
  installation,
});

const lateOrganization = {
  since: "2026-10-26T10:42:05Z",
  backups: {
    state: "late",
    last_success_at: "2026-10-30T06:00:00Z",
    last_result: "failed",
  },
  failed_jobs: 2,
  failed_sign_ins: 1,
  lockouts: 2,
  storage_used_bytes: 1_234_000_000,
};

/** Answers the status read and records every `/api` request the page makes. */
async function installStatus(
  page: Page,
  answer: { json: unknown } | { status: number },
) {
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requests.push(url.pathname);
  });
  await page.route("**/api/system/status", (route) =>
    "json" in answer
      ? route.fulfill({
          headers: { "Cache-Control": "no-store" },
          json: answer.json,
        })
      : route.fulfill({
          status: answer.status,
          headers: answeredHeaders,
          json: { detail: "Status unavailable" },
        }),
  );
  return requests;
}

const organizationBlock = (page: Page) =>
  page.getByRole("region", { name: "Your organization", exact: true });

test("S3-C5: an admin reads Your organization from the one status read", async ({
  page,
}) => {
  await signedInAs(page, { id: adminId, role: "admin", operator: false });
  const requests = await installStatus(page, {
    json: statusBody(lateOrganization),
  });
  await page.goto("/manage?view=health");
  const block = organizationBlock(page);
  await expect(block.getByRole("definition")).toHaveText([
    /^Late/,
    /^2 jobs failed in the last 7 days/,
    /^1 failed sign-in and 2 lockouts in the last 7 days/,
    "Files use 1.2 GBStorage limit: not set yet",
  ]);
  await expect(block).toContainText("Latest run: Failed");
  await expect(block).toContainText(
    "The person who runs your server manages backups.",
  );
  await expect(
    block.getByRole("link", { name: "Open Jobs", exact: true }),
  ).toHaveAttribute("href", "/manage?view=jobs");
  await expect(
    block.getByRole("link", { name: "Open Security in Access", exact: true }),
  ).toHaveAttribute("href", "/access?view=security");
  await expect(block.getByRole("link", { name: "Open Backup" })).toHaveCount(0);
  // Block 3 sits between the parts and About this system.
  await expect(page.getByRole("heading", { level: 2 })).toContainText([
    "Parts of Slate Operations",
    "Your organization",
    "About this system",
    "When something goes wrong",
  ]);
  // The block made no request of its own: one status read, and no read of
  // Jobs, Security events or Backup.
  expect(requests.filter((path) => path === "/api/system/status")).toEqual([
    "/api/system/status",
  ]);
  expect(
    requests.filter((path) =>
      /^\/api\/(jobs|security-events|backups|audit-logs)/.test(path),
    ),
  ).toEqual([]);
});

test("S3-C5: a member sees no organization block and makes no extra request", async ({
  page,
}) => {
  await signedInAs(page, { id: adminId, role: "member" });
  const requests = await installStatus(page, { json: statusBody(null) });
  await page.goto("/manage?view=health");
  await expect(
    page.getByRole("heading", { name: "About this system", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Slate Operations is working normally."),
  ).toBeVisible();
  await expect(organizationBlock(page)).toHaveCount(0);
  await expect(page.getByText("Your organization")).toHaveCount(0);
  expect(requests.filter((path) => path === "/api/system/status")).toEqual([
    "/api/system/status",
  ]);
  // D6-C1: a member gives references to the administrator.
  await expect(
    page.getByRole("region", { name: "When something goes wrong" }),
  ).toContainText("If it still does not load, tell your administrator.");
});

test("D6-C1: an admin's failed status read names the person who runs the server", async ({
  page,
}) => {
  await signedInAs(page, { id: adminId, role: "admin", operator: false });
  await installStatus(page, { status: 500 });
  await page.goto("/manage?view=health");
  const alert = page
    .getByRole("region", { name: "The status cannot be checked now." })
    .getByRole("alert");
  await expect(alert).toContainText(
    "The status could not be loaded. Try Check again in a minute.",
  );
  await expect(alert).toContainText(
    "Give this reference to the person who runs your server.",
  );
  await expectAnsweredReference(alert);
  await expect(
    page.getByRole("region", { name: "When something goes wrong" }),
  ).toContainText(
    "If it still does not load, tell the person who runs your server.",
  );
  // Before any result block 3 shows dashes and keeps its links (D8.6).
  const block = organizationBlock(page);
  await expect(block.getByRole("definition")).toHaveText([
    "—",
    /^—Open Jobs$/,
    /^—Open Security in Access$/,
    "—Storage limit: not set yet",
  ]);
});

// S5 and S6 (D14 to D19): the timeline's own read and its older pages, Slow,
// block 4 for the installation owner, file storage for admins, and the
// support file. The sentence and size rules are owned by
// tests/isolated/manage/system-health-rules.spec.ts.

const ownerId = "00000000-0000-4000-8000-000000000012";
const now = new Date("2026-11-02T10:45:00Z");

type Period = {
  part: string;
  kind: string;
  started_at: string;
  ended_at: string | null;
};

// One ongoing period, one from yesterday, then 13 older ones (15 in all).
const periods: Period[] = [
  {
    part: "email",
    kind: "not_working",
    started_at: "2026-11-02T10:30:00Z",
    ended_at: null,
  },
  {
    part: "files",
    kind: "slow",
    started_at: "2026-11-01T08:00:00Z",
    ended_at: "2026-11-01T08:12:00Z",
  },
  ...Array.from({ length: 13 }, (_, index) => {
    const day = String(20 - index).padStart(2, "0");
    return {
      part: "data",
      kind: "not_working",
      started_at: `2026-10-${day}T02:00:00Z`,
      ended_at: `2026-10-${day}T02:05:00Z`,
    };
  }),
];

/** Answers the periods read from `periods`, by page, and records each page. */
async function installPeriods(page: Page) {
  const pages: string[] = [];
  await page.route(
    (url) => url.pathname === "/api/system/health-periods",
    (route) => {
      const url = new URL(route.request().url());
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      pages.push(`${limit}:${offset}`);
      const items = periods.slice(offset, offset + limit);
      return route.fulfill({
        headers: { "Cache-Control": "no-store" },
        json: {
          items,
          pagination: {
            limit,
            offset,
            count: items.length,
            total: periods.length,
            has_more: offset + items.length < periods.length,
          },
          oldest_sample_at: "2026-10-03T11:00:00Z",
        },
      });
    },
  );
  return pages;
}

const slowSigningIn = {
  ...statusBody(null),
  parts: [
    { key: "data", status: "working" },
    { key: "signing_in", status: "slow" },
    { key: "files", status: "working" },
    { key: "email", status: "working" },
  ],
};

test("S5-C3, S5-C4, S6-C4: a member reads Slow and the last 30 days, and Show older adds 10", async ({
  page,
}) => {
  await page.clock.setFixedTime(now);
  await signedInAs(page, { id: adminId, role: "member" });
  const requests = await installStatus(page, { json: slowSigningIn });
  const pages = await installPeriods(page);
  await page.goto("/manage?view=health");
  await expect(
    page.getByRole("heading", {
      name: "Signing in is slow. Everything else works.",
    }),
  ).toBeVisible();
  const parts = page.getByRole("region", { name: "Parts of Slate Operations" });
  await expect(parts.getByRole("definition").nth(1)).toHaveText(
    "SlowSigning in may take longer than usual.",
  );
  const timeline = parts.getByRole("list", { name: "Last 30 days" });
  const rows = timeline.getByRole("listitem");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toHaveText(
    /^Email has not worked since .+ today\.Still going$/,
  );
  await expect(rows.nth(1)).toContainText(
    "Files and pictures were slow for 12 minutes yesterday.",
  );
  await parts.getByRole("button", { name: "Show older", exact: true }).click();
  await expect(rows).toHaveCount(15);
  // Focus moves to the first new row; nothing older remains.
  await expect(rows.nth(5)).toBeFocused();
  await expect(rows.nth(5)).toContainText(
    "Saving and loading your data did not work for 5 minutes on Oct 17.",
  );
  await expect(
    parts.getByRole("button", { name: "Show older", exact: true }),
  ).toHaveCount(0);
  expect(pages).toEqual(["5:0", "10:5"]);
  // S6-C4: a member gets no support file and no installation block.
  await expect(
    page.getByRole("button", { name: "Download support file" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Installation", exact: true }),
  ).toHaveCount(0);
  expect(requests.filter((path) => path.includes("diagnostics"))).toEqual([]);
});

const ownerInstallation = {
  database_bytes: 1_400_000_000,
  database_measured_at: "2026-11-02T10:41:00Z",
  workers: [
    {
      key: "record_triggers",
      state: "running",
      last_seen_at: "2026-11-02T10:41:30Z",
    },
    {
      key: "report_scheduling",
      state: "not_seen",
      last_seen_at: "2026-11-02T09:42:00Z",
    },
    { key: "comms_jobs", state: "never_seen", last_seen_at: null },
    {
      key: "provider_signout",
      state: "running",
      last_seen_at: "2026-11-02T10:40:59Z",
    },
    {
      key: "backup_runner",
      state: "running",
      last_seen_at: "2026-11-02T10:39:00Z",
    },
  ],
};

test("S5-C6, S6-C2: the installation owner reads Installation and downloads the installation file", async ({
  page,
}) => {
  await page.clock.setFixedTime(now);
  await signedInAs(page, { id: ownerId, role: "admin", operator: true });
  await installStatus(page, {
    json: statusBody(lateOrganization, ownerInstallation),
  });
  const downloads: string[] = [];
  await page.route("**/api/system/diagnostics/**", (route) => {
    downloads.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      body: '{"summary":{}}',
      headers: {
        ...answeredHeaders,
        "Content-Type": "application/json",
        "Content-Disposition":
          'attachment; filename="slateops-diagnostics-installation-20261102-1045Z.json"',
        "Cache-Control": "no-store",
      },
    });
  });
  await page.goto("/manage?view=health");
  const block = page.getByRole("region", { name: "Installation", exact: true });
  await expect(block.getByRole("term")).toHaveText([
    "Database size",
    "Record triggers",
    "Scheduled reports",
    "OpenComms jobs",
    "Sign-out cleanup",
    "Backup runner",
  ]);
  await expect(block.getByRole("definition")).toHaveText([
    "1.4 GB",
    "Running",
    /^Not seen since .+Its work waits until it runs again\.$/,
    "Not seen yetCheck that it runs on your server.",
    "Running",
    "Running",
  ]);
  await expect(page.getByRole("heading", { level: 2 })).toContainText([
    "Your organization",
    "Installation",
    "About this system",
  ]);
  const help = page.getByRole("region", { name: "When something goes wrong" });
  await expect(help).toContainText(
    "A support file helps whoever supports your installation find a problem.",
  );
  const button = help.getByRole("button", { name: "Download support file" });
  const downloaded = page.waitForEvent("download");
  await button.click();
  expect((await downloaded).suggestedFilename()).toBe(
    "slateops-diagnostics-installation-20261102-1045Z.json",
  );
  await expect(help.getByRole("status")).toHaveText("Support file downloaded.");
  await expect(button).toBeFocused();
  // The owner gets the installation file only, also as an admin (D19.2).
  expect(downloads).toEqual(["/api/system/diagnostics/installation"]);
});

test("S5-C7, S6-C3: an admin reads File storage, and a failed support file shows its reference", async ({
  page,
}) => {
  await signedInAs(page, { id: adminId, role: "admin", operator: false });
  await installStatus(page, { json: statusBody(lateOrganization) });
  let failing = true;
  await page.route("**/api/system/diagnostics/organization", (route) =>
    failing
      ? route.fulfill({
          status: 500,
          headers: answeredHeaders,
          json: { detail: "Internal Server Error" },
        })
      : route.fulfill({
          body: '{"summary":{}}',
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition":
              'attachment; filename="slateops-diagnostics-organization-20261102-1045Z.json"',
            "Cache-Control": "no-store",
          },
        }),
  );
  await page.goto("/manage?view=health");
  const organization = organizationBlock(page);
  await expect(organization.getByRole("definition").nth(3)).toHaveText(
    "Files use 1.2 GBStorage limit: not set yet",
  );
  await expect(
    page.getByRole("region", { name: "Installation", exact: true }),
  ).toHaveCount(0);
  const help = page.getByRole("region", { name: "When something goes wrong" });
  await help.getByRole("button", { name: "Download support file" }).click();
  const alert = help.getByRole("alert");
  await expect(alert).toContainText(
    "The support file could not be prepared. Try again in a minute.",
  );
  await expect(alert).toContainText(
    "Give this reference to the person who runs your server.",
  );
  await expectAnsweredReference(alert);
  // The next press closes the Alert.
  failing = false;
  const downloaded = page.waitForEvent("download");
  await help.getByRole("button", { name: "Download support file" }).click();
  expect((await downloaded).suggestedFilename()).toBe(
    "slateops-diagnostics-organization-20261102-1045Z.json",
  );
  await expect(alert).toHaveCount(0);
});
