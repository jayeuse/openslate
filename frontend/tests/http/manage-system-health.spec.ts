import type { Page } from "@playwright/test";

import { wireWorkspace } from "../helpers/wire";
import {
  answeredHeaders,
  appearanceUrl,
  expect,
  expectAnsweredReference,
  expectNoHorizontalScroll,
  expectNoPageScroll,
  heldResponse,
  serverBanner,
  signedInAs,
  test,
  type Locator,
  type SignedInIdentity,
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

/** Answers the periods read from `items`, by page, and records each page. */
async function installPeriods(page: Page, items = periods) {
  const pages: string[] = [];
  await page.route(
    (url) => url.pathname === "/api/system/health-periods",
    (route) => {
      const url = new URL(route.request().url());
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      pages.push(`${limit}:${offset}`);
      const shown = items.slice(offset, offset + limit);
      return route.fulfill({
        headers: { "Cache-Control": "no-store" },
        json: {
          items: shown,
          pagination: {
            limit,
            offset,
            count: shown.length,
            total: items.length,
            has_more: offset + shown.length < items.length,
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

// The still page (D23 to D34): from 1280px the page holds still and only the
// panes scroll; below it the blocks stack and the page scrolls. These journeys
// read the page's own geometry. Which block sits in which pane is owned by
// tests/isolated/manage/system-health-view.spec.ts.

const memberIdentity: SignedInIdentity = { id: adminId, role: "member" };
const adminIdentity: SignedInIdentity = {
  id: adminId,
  role: "admin",
  operator: false,
};
const ownerIdentity: SignedInIdentity = {
  id: ownerId,
  role: "admin",
  operator: true,
};

const allWorking = (organization: unknown, installation: unknown = null) => ({
  ...statusBody(organization, installation),
  parts: [
    { key: "data", status: "working" },
    { key: "signing_in", status: "working" },
    { key: "files", status: "working" },
    { key: "email", status: "working" },
  ],
});

// D28's data, in the fixture's en-PH region: a Late backup with the longest
// real line (SP-C5), and one worker with a line 2.
const longestBackupLine = "Last good backup on Nov 28 at 12:00 PM";
const d28Organization = {
  ...lateOrganization,
  backups: {
    state: "late",
    last_success_at: "2025-11-28T04:00:00Z",
    last_result: "interrupted",
  },
};
const oneWorkerNotSeen = {
  ...ownerInstallation,
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
    {
      key: "comms_jobs",
      state: "running",
      last_seen_at: "2026-11-02T10:41:00Z",
    },
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

const onePeriod = periods.slice(1, 2);
const desktop = { width: 1440, height: 900 };
const smallDesktop = { width: 1280, height: 720 };
const wideDesktop = { width: 1920, height: 1080 };
const tablet = { width: 1024, height: 768 };
const phone = { width: 390, height: 844 };

async function openHealth(
  page: Page,
  identity: SignedInIdentity,
  body: unknown,
  items: Period[] = onePeriod,
) {
  await page.clock.setFixedTime(now);
  await signedInAs(page, identity);
  await installStatus(page, { json: body });
  await installPeriods(page, items);
  await page.setViewportSize(desktop);
  await page.goto("/manage?view=health");
  await expect(
    page
      .getByRole("region", { name: "Parts of Slate Operations" })
      .getByRole("listitem")
      .first(),
  ).toBeVisible();
}

/** SP-C1, SP-C2 and SP-C3, each read from the page as one answer. */
const readFrame = (page: Page) =>
  page.evaluate(() => {
    const near = (first: number, second: number) =>
      Math.abs(first - second) <= 1;
    const box = (element: Element) => element.getBoundingClientRect();
    const section = document.querySelector(".manage-scroll")!;
    const band = box(
      document.querySelector('[aria-labelledby="system-health-headline"]')!,
    );
    const panes = [...document.querySelectorAll("[data-health-pane]")];
    return {
      sectionStill: section.scrollHeight === section.clientHeight,
      bandFillsTheSection:
        near(band.left, box(section).left) &&
        near(band.right, box(section).right),
      panesFillTheBand:
        panes.length > 1 &&
        near(box(panes[0]!).left, band.left) &&
        near(box(panes.at(-1)!).right, band.right),
      panesReachTheBottom: panes.every((pane) =>
        near(box(pane).bottom, box(section).bottom),
      ),
      lastCardsReachTheirPaneBottom: panes
        .filter((pane) => pane.scrollHeight === pane.clientHeight)
        .every((pane) =>
          near(box(pane.lastElementChild!).bottom, box(pane).bottom),
        ),
    };
  });

async function expectStillFrame(page: Page) {
  await expect
    .poll(() => readFrame(page))
    .toEqual({
      sectionStill: true,
      bandFillsTheSection: true,
      panesFillTheBand: true,
      panesReachTheBottom: true,
      lastCardsReachTheirPaneBottom: true,
    });
  await expectNoPageScroll(page);
}

/** SP-C11: each answer below 1280px. */
const readStack = (page: Page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    const section = document.querySelector(".manage-scroll")!;
    const width = section.getBoundingClientRect().width;
    return {
      pageScrolls: root.scrollHeight > root.clientHeight,
      panesScroll: [...document.querySelectorAll("[data-health-pane]")].some(
        (pane) => pane.scrollHeight > pane.clientHeight,
      ),
      cardsFillTheSection: [...section.querySelectorAll("section")].every(
        (card) => Math.abs(card.getBoundingClientRect().width - width) <= 1,
      ),
      blocks: [...section.querySelectorAll("h2")].map(
        (heading) => heading.textContent,
      ),
    };
  });

async function expectStackedPage(page: Page, blocks: string[]) {
  await expect
    .poll(() => readStack(page))
    .toEqual({
      pageScrolls: true,
      panesScroll: false,
      cardsFillTheSection: true,
      blocks,
    });
  await expectNoHorizontalScroll(page);
}

/** How far each pane scrolls down and sideways (SP-C5, SP-C8). */
const paneOverflow = (page: Page) =>
  page.evaluate(() => {
    const panes = [...document.querySelectorAll("[data-health-pane]")];
    return {
      down: panes.map((pane) => pane.scrollHeight - pane.clientHeight),
      across: panes.map((pane) => pane.scrollWidth - pane.clientWidth),
    };
  });

const paneAcross = async (page: Page) => (await paneOverflow(page)).across;

const termWidths = (block: Locator) =>
  block
    .getByRole("term")
    .evaluateAll((terms) =>
      terms.map((term) => term.getBoundingClientRect().width),
    );

/** Whether each term sits above its value, on one left edge (D27). */
const stackedRows = (block: Locator) =>
  block.getByRole("term").evaluateAll((terms) =>
    terms.map((term) => {
      const value = term.nextElementSibling!.getBoundingClientRect();
      const label = term.getBoundingClientRect();
      return label.left === value.left && label.bottom <= value.top;
    }),
  );

const partsBlock = (page: Page) =>
  page.getByRole("region", { name: "Parts of Slate Operations" });
const installationBlock = (page: Page) =>
  page.getByRole("region", { name: "Installation", exact: true });
const band = (page: Page) =>
  page.locator('[aria-labelledby="system-health-headline"]');

const paneHeight = (page: Page) =>
  page
    .locator('[data-health-pane="parts"]')
    .evaluate((pane) => pane.getBoundingClientRect().height);
const bandHeight = (page: Page) =>
  band(page).evaluate((card) => card.getBoundingClientRect().height);

test("SP-C1 to SP-C3, SP-C5, SP-C9 to SP-C11: the owner's page stays still from 1280px and stacks below it", async ({
  page,
}) => {
  await openHealth(
    page,
    ownerIdentity,
    allWorking(d28Organization, oneWorkerNotSeen),
  );
  await expectStillFrame(page);
  expect((await paneOverflow(page)).down).toEqual([0, 0, 0]);
  const backupLine = organizationBlock(page).getByText(longestBackupLine);
  await expect(backupLine).toBeVisible();
  await expect(organizationBlock(page)).toContainText(
    "Latest run: Interrupted",
  );
  expect((await backupLine.boundingBox())!.height).toBe(20);
  expect(await termWidths(partsBlock(page))).toEqual([120, 120, 120, 120]);
  expect(await termWidths(organizationBlock(page))).toEqual([
    120, 120, 120, 120,
  ]);
  expect(await termWidths(installationBlock(page))).toEqual([
    120, 120, 120, 120, 120, 120,
  ]);
  // SP-C9: the owner's version value takes one line beside a 96px label.
  const about = page.getByRole("region", { name: "About this system" });
  expect(await termWidths(about)).toEqual([96]);
  expect((await about.getByRole("definition").boundingBox())!.height).toBe(20);
  // SP-C10: the check line shares the headline's row, and the band stays low.
  const headline = await page
    .getByRole("heading", { name: "Slate Operations is working normally." })
    .boundingBox();
  const checkLine = await page.getByText(/^Checked at/).boundingBox();
  expect(checkLine!.y).toBeLessThan(headline!.y + headline!.height);
  expect(await bandHeight(page)).toBeLessThan(72);

  await page.setViewportSize(smallDesktop);
  await expectStillFrame(page);
  expect(await stackedRows(partsBlock(page))).toEqual([true, true, true, true]);

  await page.setViewportSize(wideDesktop);
  await expectStillFrame(page);
  expect(await termWidths(partsBlock(page))).toEqual([192, 192, 192, 192]);

  const blocks = [
    "Slate Operations is working normally.",
    "Parts of Slate Operations",
    "Your organization",
    "Installation",
    "About this system",
    "When something goes wrong",
  ];
  await page.setViewportSize(tablet);
  await expectStackedPage(page, blocks);
  expect(await termWidths(partsBlock(page))).toEqual([224, 224, 224, 224]);
  // D30: only block 6's text keeps the old line length.
  expect(
    await page
      .getByRole("region", { name: "When something goes wrong" })
      .getByRole("paragraph")
      .first()
      .evaluate((text) => text.getBoundingClientRect().width),
  ).toBe(640);

  await page.setViewportSize(phone);
  await expectStackedPage(page, blocks);
  expect(await stackedRows(partsBlock(page))).toEqual([true, true, true, true]);
});

test("SP-C1 to SP-C3, SP-C5, SP-C11: an admin's page stays still from 1280px and stacks below it", async ({
  page,
}) => {
  await openHealth(page, adminIdentity, allWorking(d28Organization));
  await expectStillFrame(page);
  expect((await paneOverflow(page)).down).toEqual([0, 0, 0]);
  for (const size of [smallDesktop, wideDesktop]) {
    await page.setViewportSize(size);
    await expectStillFrame(page);
  }
  for (const size of [tablet, phone]) {
    await page.setViewportSize(size);
    await expectStackedPage(page, [
      "Slate Operations is working normally.",
      "Parts of Slate Operations",
      "Your organization",
      "About this system",
      "When something goes wrong",
    ]);
  }
});

test("SP-C1 to SP-C3, SP-C5, SP-C9, SP-C11: a member's two panes stay still from 1280px and stack below it", async ({
  page,
}) => {
  await openHealth(page, memberIdentity, allWorking(null));
  await expectStillFrame(page);
  expect((await paneOverflow(page)).down).toEqual([0, 0]);
  expect(await termWidths(partsBlock(page))).toEqual([192, 192, 192, 192]);
  for (const size of [smallDesktop, wideDesktop]) {
    await page.setViewportSize(size);
    await expectStillFrame(page);
  }
  for (const size of [tablet, phone]) {
    await page.setViewportSize(size);
    await expectStackedPage(page, [
      "Slate Operations is working normally.",
      "Parts of Slate Operations",
      "About this system",
      "When something goes wrong",
    ]);
  }
});

test("SP-C6, SP-C12: Show older grows pane 1 alone, and the tab order stays", async ({
  page,
}) => {
  await openHealth(
    page,
    ownerIdentity,
    allWorking(d28Organization, oneWorkerNotSeen),
    periods,
  );
  await page.getByRole("button", { name: "Check again" }).focus();
  const stops: (string | null)[] = [];
  for (let stop = 0; stop < 6; stop += 1) {
    await page.keyboard.press("Tab");
    stops.push(
      await page.evaluate(() => document.activeElement?.textContent ?? null),
    );
  }
  expect(stops).toEqual([
    "Show older",
    "Open Backup",
    "Open Jobs",
    "Open Security in Access",
    "Updates & licensing",
    "Download support file",
  ]);
  expect(
    await page
      .locator(".manage-scroll section, [data-health-pane]")
      .evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).order),
      ),
  ).toEqual(["0", "0", "0", "0", "0", "0", "0", "0", "0"]);

  const places = () =>
    page.evaluate(() => {
      const root = document.documentElement;
      const section = document.querySelector(".manage-scroll")!;
      return {
        page: [root.scrollHeight, root.clientHeight, root.scrollTop],
        section: [section.scrollHeight, section.clientHeight],
        boxes: [
          section,
          document.querySelector('[aria-labelledby="system-health-headline"]')!,
          document.querySelector('[data-health-pane="details"]')!,
          document.querySelector('[data-health-pane="help"]')!,
        ].map((element) => element.getBoundingClientRect().toJSON() as unknown),
      };
    });
  const before = await places();
  await page.getByRole("button", { name: "Show older", exact: true }).click();
  const rows = partsBlock(page).getByRole("listitem");
  await expect(rows).toHaveCount(15);
  await expect(rows.nth(5)).toBeFocused();
  expect(await places()).toEqual(before);
  expect((await paneOverflow(page)).down[0]).toBeGreaterThan(0);
  const shown = await rows.nth(5).evaluate((row) => {
    const pane = row.closest("[data-health-pane]")!.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return box.top >= pane.top && box.bottom <= pane.bottom;
  });
  expect(shown).toBe(true);
});

test("SP-C7: the block 1 Alert and the server banner shorten the panes, and the page stays still", async ({
  page,
}) => {
  let failing = false;
  await openHealth(
    page,
    ownerIdentity,
    allWorking(d28Organization, oneWorkerNotSeen),
  );
  await page.route("**/api/system/status", (route) =>
    failing
      ? route.fulfill({
          status: 500,
          headers: answeredHeaders,
          json: { detail: "Status unavailable" },
        })
      : route.fallback(),
  );
  await page.route("**/api/system/diagnostics/installation", (route) =>
    route.abort(),
  );
  const sizes = [desktop, smallDesktop];
  const calm: { pane: number; band: number }[] = [];
  for (const size of sizes) {
    await page.setViewportSize(size);
    calm.push({ pane: await paneHeight(page), band: await bandHeight(page) });
  }

  failing = true;
  const checkAgain = page.getByRole("button", { name: "Check again" });
  await checkAgain.click();
  await expect(band(page).getByRole("alert")).toBeVisible();
  for (const [index, size] of sizes.entries()) {
    await page.setViewportSize(size);
    await expectStillFrame(page);
    const grown = (await bandHeight(page)) - calm[index]!.band;
    expect(grown).toBeGreaterThan(0);
    expect(await paneHeight(page)).toBe(calm[index]!.pane - grown);
  }

  failing = false;
  await checkAgain.click();
  await expect(band(page).getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Download support file" }).click();
  const banner = serverBanner(page);
  await expect(banner).toBeVisible();
  for (const [index, size] of sizes.entries()) {
    await page.setViewportSize(size);
    await expectStillFrame(page);
    const { height } = (await banner.boundingBox())!;
    expect(await paneHeight(page)).toBe(calm[index]!.pane - height);
  }
});

test("SP-C8: the longest line scrolls no pane sideways, also beside a 360px sidebar", async ({
  page,
}) => {
  await openHealth(
    page,
    ownerIdentity,
    allWorking(d28Organization, oneWorkerNotSeen),
  );
  await expect(organizationBlock(page)).toContainText(longestBackupLine);
  expect(await paneAcross(page)).toEqual([0, 0, 0]);
  await page.setViewportSize(smallDesktop);
  expect(await paneAcross(page)).toEqual([0, 0, 0]);

  await page.evaluate(() =>
    window.localStorage.setItem("slateops-sidebar-width", "360"),
  );
  await page.reload();
  await expect(partsBlock(page).getByRole("listitem")).toHaveCount(1);
  await expectStillFrame(page);
  expect(await paneAcross(page)).toEqual([0, 0, 0]);
  expect(await stackedRows(organizationBlock(page))).toEqual([
    true,
    true,
    true,
    true,
  ]);
});

test("D26: the band keeps its height when the first result replaces the skeleton", async ({
  page,
}) => {
  const held = heldResponse();
  await page.clock.setFixedTime(now);
  await signedInAs(page, memberIdentity);
  await page.route("**/api/system/status", async (route) => {
    held.enter();
    await held.released;
    await route.fulfill({ json: allWorking(null) });
  });
  await installPeriods(page, onePeriod);
  await page.setViewportSize(desktop);
  await page.goto("/manage?view=health");
  await held.entered;
  await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
  const loading = await bandHeight(page);
  held.release();
  await expect(
    page.getByRole("heading", {
      name: "Slate Operations is working normally.",
    }),
  ).toBeVisible();
  expect(await bandHeight(page)).toBe(loading);
});

test("SP-C13: the frame holds in every look, light and dark", async ({
  page,
}) => {
  let theme = "whiteboard";
  await page.route(appearanceUrl, (route) =>
    route.fulfill({ json: { theme } }),
  );
  // A saved light preference would outrank the emulated color scheme.
  await page.route(`**/api/users/${ownerId}/preferences`, (route) =>
    route.fulfill({
      headers: { "Cache-Control": "no-store" },
      json: {
        user_id: ownerId,
        theme: "system",
        appearance: { motion: "system", keyboard_shortcuts: true },
      },
    }),
  );
  // Manage holds the look of its own workspace read.
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: wireWorkspace({
        id: "00000000-0000-4000-8000-000000000102",
        locale: "en-PH",
        timezone: "Asia/Manila",
        currency: "PHP",
        today: "2026-10-06",
        purge_enabled: false,
        theme,
      }),
    }),
  );
  await openHealth(
    page,
    ownerIdentity,
    allWorking(d28Organization, oneWorkerNotSeen),
  );
  for (const look of ["whiteboard", "triplicate", "stockroom"]) {
    theme = look;
    for (const [colorScheme, dark] of [
      ["light", false],
      ["dark", true],
    ] as const) {
      await page.emulateMedia({ colorScheme });
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", look);
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.classList.contains("dark"),
          ),
        )
        .toBe(dark);
      await expect(partsBlock(page).getByRole("listitem")).toHaveCount(1);
      for (const size of [desktop, smallDesktop, wideDesktop]) {
        await page.setViewportSize(size);
        await expectStillFrame(page);
      }
    }
  }
});
