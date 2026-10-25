import {
  expect,
  expectNoHorizontalScroll,
  expectNoPageScroll,
  heldResponse,
  signedInAs,
  test,
  type Locator,
  type Page,
} from "./helpers/test";
import { fixtureId } from "./helpers/access-api";
import {
  mockManageBackupExports,
  mockManageBackups,
  readyBackupExport,
} from "./helpers/manage-backups";
import { mockManageSecurity } from "./helpers/manage-security";
import {
  cutTexts,
  smallTargets,
  tableCardGaps,
  toolbarLines,
} from "./helpers/layout";

// Who sees which Manage section, the section header, and the still page from
// 1280px. The navigation rule itself is owned by the isolated
// workspace-navigation spec; these journeys prove what a direct link shows.

const MEMBER = "00000000-0000-4000-8000-000000000301";
const ADMIN = "00000000-0000-4000-8000-000000000302";

function mainNavigation(page: Page) {
  return page.getByRole("navigation", { name: "Main navigation" });
}

/** Counts every Manage-private request the page sends. */
async function countManageRequests(page: Page) {
  const requests: string[] = [];
  await page.route(
    (url) =>
      /^\/api\/(audit-logs|security-events|backups|version|jobs)(\/|$)/.test(
        url.pathname,
      ),
    (route) => {
      requests.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 403, json: { detail: "Forbidden" } });
    },
  );
  return requests;
}

async function mockAudit(page: Page, count = 24) {
  const items = Array.from({ length: count }, (_, index) => ({
    id: fixtureId(5000 + index),
    created_at: `2026-09-${String(1 + (index % 28)).padStart(2, "0")}T09:00:00Z`,
    performed_by: fixtureId(5900),
    action: "update",
    entity_type: "record",
    entity_id: fixtureId(5100 + index),
    department_id: null,
    before: { status: "open" },
    after: { status: "closed" },
    request_id: null,
    request_method: "PATCH",
    request_path: null,
    actor_label: null,
    actor_name: "Mara Santos",
    target_label: `Quote Q-${1000 + index}`,
    note: null,
  }));
  await page.route("**/api/audit-logs**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/audit-logs/options")
      return route.fulfill({
        json: {
          entity_types: ["record"],
          actors: [
            {
              performed_by: fixtureId(5900),
              actor_label: null,
              actor_name: "Mara Santos",
            },
          ],
        },
      });
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const page = items.slice(offset, offset + limit);
    return route.fulfill({
      json: {
        items: page,
        pagination: {
          limit,
          offset,
          count: page.length,
          total: items.length,
          has_more: offset + limit < items.length,
        },
      },
    });
  });
}

type JobRow = {
  kind: string;
  subject_label: string;
  state: string;
  can_retry: boolean;
};
const reportRows: JobRow[] = Array.from({ length: 30 }, (_, index) => ({
  kind: "report",
  subject_label: `Weekly report ${index + 1}`,
  state: "succeeded",
  can_retry: false,
}));

async function mockJobs(page: Page, rows: readonly JobRow[] = reportRows) {
  const items = rows.map((row, index) => ({
    ...row,
    id: fixtureId(6000 + index),
    subject_link: null,
    scheduled_for: "2026-10-01T00:00:00Z",
    last_attempt_at: "2026-10-01T00:05:00Z",
    next_attempt_at: null,
    attempts: 1,
    failure_code: null,
    failure_label: null,
  }));
  await page.route("**/api/jobs**", (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const page = items.slice(offset, offset + limit);
    return route.fulfill({
      json: {
        items: page,
        pagination: {
          limit,
          offset,
          count: page.length,
          total: items.length,
          has_more: offset + limit < items.length,
        },
      },
    });
  });
}

/** Every section with its data, for an administrator who owns the installation. */
async function installEverySection(page: Page) {
  await mockManageBackups(page);
  await mockAudit(page);
  await mockJobs(page);
}

const sections = [
  { view: "organization", title: "Organization", ready: "Identity" },
  { view: "backup", title: "Backup", ready: "Back up now" },
  { view: "audit", title: "Audit", ready: "Quote Q-1000" },
  { view: "jobs", title: "Jobs", ready: "Weekly report 1" },
  { view: "updates", title: "Updates & licensing", ready: "Stable channel" },
] as const;

async function openSection(page: Page, section: (typeof sections)[number]) {
  await page.goto(`/manage?view=${section.view}`);
  await expect(
    page.getByRole("heading", { level: 1, name: section.title, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("main")
      .getByText(section.ready)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
}

test("a member who follows an Audit link sees that it is not available, with a way back and no request", async ({
  page,
}) => {
  await signedInAs(page, { id: MEMBER, role: "member" });
  const requests = await countManageRequests(page);
  await page.goto("/manage?view=audit");

  await expect(
    page.getByRole("heading", { level: 1, name: "Audit", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Audit is not available to your account.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: "Go to Organization" }),
  ).toHaveAttribute("href", "/manage?view=organization");
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  await expect(
    mainNavigation(page).locator('a[href^="/manage?view=audit"]'),
  ).toHaveCount(0);
  expect(requests).toEqual([]);

  // Organization links only to places this member can open.
  await page
    .getByRole("main")
    .getByRole("link", { name: "Go to Organization" })
    .click();
  await expect(
    page.getByText("Only an administrator can change these settings.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Related workspace areas" }),
  ).toHaveCount(0);
});

test("an administrator who does not own the installation sees that the owner manages Backup and Updates", async ({
  page,
}) => {
  await signedInAs(page, { id: ADMIN, role: "admin", operator: false });
  const requests = await countManageRequests(page);

  for (const [view, title, notice] of [
    ["backup", "Backup", "Backup is managed by the installation owner."],
    [
      "updates",
      "Updates & licensing",
      "Updates are managed by the installation owner.",
    ],
  ] as const) {
    await page.goto(`/manage?view=${view}`);
    await expect(
      page.getByRole("heading", { level: 1, name: title, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(notice, { exact: true })).toBeVisible();
    // The notice is the one line: no meta line names another person.
    await expect(
      page.getByRole("main").locator('header:has([data-slot="page-title"]) p'),
    ).toHaveCount(0);
    await expect(
      page.getByRole("main").getByRole("link", { name: "Go to Organization" }),
    ).toHaveAttribute("href", "/manage?view=organization");
    await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  }
  const manageLinks = mainNavigation(page).locator('a[href^="/manage"]');
  await expect(manageLinks.filter({ hasText: "Audit" })).toHaveCount(1);
  await expect(manageLinks.filter({ hasText: "Backup" })).toHaveCount(0);
  await expect(manageLinks.filter({ hasText: "Updates" })).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("a Backup refusal that names the installation owner shows the owner notice, not Retry", async ({
  page,
}) => {
  // The identity still says this administrator owns the installation; the
  // server, which decides, no longer agrees.
  await mockManageBackups(page);
  await page.route("**/api/backups/status", (route) =>
    route.fulfill({
      status: 403,
      json: {
        detail: {
          code: "operator_required",
          message: "Only the installation owner can change this setting",
        },
      },
    }),
  );
  await page.goto("/manage?view=backup");

  await expect(
    page.getByText("Backup is managed by the installation owner.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Back up now", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("The person who runs your server restores backups.", {
      exact: true,
    }),
  ).toHaveCount(0);
});

test("a Backup or Updates refusal inside the section hides the meta line beside it", async ({
  page,
}) => {
  const backup = await mockManageBackups(page);
  backup.statusReadStatus = 403;
  backup.historyReadStatus = 403;
  backup.versionReadStatus = 403;
  const header = page
    .getByRole("main")
    .locator('header:has([data-slot="page-title"])');
  await page.goto("/manage?view=backup");
  await expect(
    page.getByText("Only the installation owner can review backup status.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(header.locator("p")).toHaveCount(0);
  await page.goto("/manage?view=updates");
  await expect(
    page.getByText("Only the installation owner can review version status.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(header.locator("p")).toHaveCount(0);
});

test("each Manage section header is its title and one meta line, with no source chip", async ({
  page,
}) => {
  await installEverySection(page);
  for (const section of sections) {
    await openSection(page, section);
    const header = page
      .getByRole("main")
      .locator('header:has([data-slot="page-title"])');
    await expect(header.locator("p"), section.view).toHaveCount(1);
    await expect(page.getByRole("note"), section.view).toHaveCount(0);
    await expect(
      header.locator('[data-slot="badge"]'),
      section.view,
    ).toHaveCount(0);
  }
  // The Backup header link names where it goes.
  await openSection(page, sections[1]);
  await expect(
    page.getByRole("main").getByRole("link", { name: "Access security" }),
  ).toHaveAttribute("href", "/access?view=security");
});

test("Manage fields and buttons are 32px tall at 1440", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installEverySection(page);
  await openSection(page, sections[0]);
  const height = async (locator: ReturnType<Page["locator"]>) =>
    (await locator.boundingBox())?.height;
  expect(await height(page.getByLabel("Organization name"))).toBe(32);
  expect(
    await height(page.getByRole("button", { name: "Save settings" })),
  ).toBe(32);
  await openSection(page, sections[1]);
  expect(await height(page.getByRole("button", { name: "Back up now" }))).toBe(
    32,
  );
  expect(
    await height(page.getByRole("button", { name: "Edit schedule" })),
  ).toBe(32);
  await page.getByRole("button", { name: "Edit schedule" }).click();
  const dialog = page.getByRole("dialog", { name: "Backup schedule" });
  await expect(dialog).toBeVisible();
  expect(
    await height(dialog.getByRole("button", { name: "Close", exact: true })),
  ).toBe(32);
});

test("no Manage section scrolls the page at 1280 by 720", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installEverySection(page);
  for (const section of sections) {
    await openSection(page, section);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              document.documentElement.scrollHeight -
              document.documentElement.clientHeight,
          ),
        { message: section.view },
      )
      .toBe(0);
  }
  // A page of 25 jobs scrolls inside the list; the page and its footer stay.
  await openSection(page, sections[3]);
  await page.getByLabel("Rows per page", { exact: true }).selectOption("25");
  const jobs = page.getByRole("table", { name: "Jobs", exact: true });
  await expect(jobs.getByRole("row")).toHaveCount(26);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollHeight -
        document.documentElement.clientHeight,
    ),
  ).toBe(0);
  expect(
    await jobs.evaluate((table) => {
      const list = table.closest(".manage-scroll")!;
      return list.scrollHeight > list.clientHeight;
    }),
  ).toBe(true);
  await expect(
    page.getByRole("navigation", { name: "Jobs pages" }),
  ).toBeInViewport();
});

test("a short Activity list fills the Audit page with its pager at the bottom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockManageBackups(page);
  await mockAudit(page, 3);
  await mockJobs(page);
  await openSection(page, sections[2]);
  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  await expect(table.getByRole("row")).toHaveCount(4);
  const gaps = await tableCardGaps(
    page.getByRole("navigation", { name: "Activity pages", exact: true }),
  );
  expect(gaps.frame).toBeLessThanOrEqual(24);
  expect(gaps.pager).toBeLessThanOrEqual(1);
  await expectNoPageScroll(page);
});

test("the Activity table frame does not move when its rows arrive", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockManageBackups(page);
  await mockAudit(page, 3);
  await mockJobs(page);
  const gate = heldResponse();
  await page.route(/\/api\/audit-logs\?/, async (route) => {
    gate.enter();
    await gate.released;
    await route.fallback();
  });
  await page.goto("/manage?view=audit");
  await gate.entered;
  const loading = await page
    .locator('[data-slot="loading-region"][aria-busy="true"] .bg-card')
    .first()
    .boundingBox();
  gate.release();
  await expect(page.getByText("Quote Q-1000").first()).toBeVisible();
  const loaded = await page
    .locator('table[aria-label="Activity history table"]')
    .locator("xpath=ancestor::div[contains(@class,'bg-card')][1]")
    .boundingBox();
  expect(loaded?.y).toBeCloseTo(loading?.y ?? 0, 0);
  expect(loaded?.height).toBeCloseTo(loading?.height ?? 0, 0);
});

const phone = { width: 390, height: 844 };
const main = (page: Page) => page.getByRole("main");

test("on a phone the Organization targets are at least 44px", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await installEverySection(page);
  await openSection(page, sections[0]);
  expect(await smallTargets(main(page))).toEqual([]);
  await expectNoHorizontalScroll(page);
});

test("on a phone the Backup targets, its detail and its schedule dialog are at least 44px", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await installEverySection(page);
  await openSection(page, sections[1]);
  expect(await smallTargets(main(page))).toEqual([]);
  await page
    .getByRole("button", { name: "Inspect Backup 1", exact: true })
    .click();
  // The detail is its own screen with a 44px Back.
  await expect(
    page.getByRole("region", { name: "Selected backup", exact: true }),
  ).toBeVisible();
  expect(await smallTargets(main(page))).toEqual([]);
  await page.getByRole("button", { name: "Edit schedule" }).click();
  const schedule = page.getByRole("dialog", { name: "Backup schedule" });
  await expect(schedule).toBeVisible();
  expect(await smallTargets(schedule)).toEqual([]);
  await expectNoHorizontalScroll(page);
});

test("on a phone the Audit targets, its event sheet and its export dialog are at least 44px", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await installEverySection(page);
  await openSection(page, sections[2]);
  expect(await smallTargets(main(page))).toEqual([]);
  await main(page)
    .getByRole("list", { name: "Activity history", exact: true })
    .getByRole("button")
    .first()
    .click();
  const sheet = page.getByRole("dialog").filter({ hasText: "What changed" });
  await expect(sheet).toBeVisible();
  // A full-screen sheet with a named close.
  const sheetBox = await sheet.boundingBox();
  expect(Math.round(sheetBox?.width ?? 0)).toBe(phone.width);
  await expect(
    sheet.getByRole("button", { name: "Close event details", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  expect(await smallTargets(sheet)).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", { name: "Audit export preview" });
  await expect(preview).toBeVisible();
  expect(await smallTargets(preview)).toEqual([]);
  await expectNoHorizontalScroll(page);
});

test("on a phone the Jobs targets, the row menu and the Filters bottom sheet are at least 44px", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await mockManageBackups(page);
  await mockJobs(page, [
    {
      kind: "report",
      subject_label: "Weekly report 1",
      state: "failed",
      can_retry: true,
    },
    ...reportRows.slice(1),
  ]);
  await openSection(page, sections[3]);
  expect(await smallTargets(main(page))).toEqual([]);
  await page
    .getByRole("button", { name: "Actions for Weekly report 1", exact: true })
    .click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  expect(await smallTargets(menu)).toEqual([]);
  await page.keyboard.press("Escape");
  await main(page)
    .getByRole("button", { name: "Filters", exact: true })
    .click();
  // Below 768px Filters opens as a full-width sheet at the bottom.
  const sheet = page.getByRole("dialog", { name: "Filters", exact: true });
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(phone.width);
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(phone.height);
  expect(await smallTargets(sheet)).toEqual([]);
  await sheet
    .getByLabel("Job kind", { exact: true })
    .selectOption("report-run");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  // The chip and Clear all keep the 44px floor.
  await expect(
    main(page).getByRole("group", { name: "Active filters" }),
  ).toBeVisible();
  expect(await smallTargets(main(page))).toEqual([]);
  await expectNoHorizontalScroll(page);
});

test("on a phone the Updates targets are at least 44px", async ({ page }) => {
  await page.setViewportSize(phone);
  await installEverySection(page);
  await openSection(page, sections[4]);
  expect(await smallTargets(main(page))).toEqual([]);
  await expectNoHorizontalScroll(page);
});

test("on a phone the shell's Open navigation and Search workspace stay 44px wide on every section", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await installEverySection(page);
  for (const section of sections) {
    await openSection(page, section);
    for (const name of ["Open navigation", "Search workspace"]) {
      const box = await page
        .getByRole("button", { name, exact: true })
        .or(page.getByRole("link", { name, exact: true }))
        .boundingBox();
      expect(
        Math.round(Math.min(box?.width ?? 0, box?.height ?? 0)),
        `${section.view}: ${name}`,
      ).toBeGreaterThanOrEqual(44);
    }
  }
});

test("once the session is verified, no session check stays in the page", async ({
  page,
}) => {
  await installEverySection(page);
  await openSection(page, sections[0]);
  // Not only hidden: a closed curtain kept its status text for screen readers.
  await expect(page.getByText("Checking your session…")).toHaveCount(0);
});

test("on a phone the header is the title and meta line, then one row of quiet actions", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await installEverySection(page);
  for (const section of [sections[1], sections[2]]) {
    await openSection(page, section);
    const header = main(page).locator('header:has([data-slot="page-title"])');
    const title = header.locator('[data-slot="page-title"]');
    const actions = header.locator('[data-slot="page-actions"]');
    await expect(actions, section.view).toBeVisible();
    const [titleBox, actionsBox] = await Promise.all([
      title.boundingBox(),
      actions.boundingBox(),
    ]);
    // Row 2 sits under the title and meta line.
    expect(actionsBox!.y).toBeGreaterThan(titleBox!.y + titleBox!.height);
    expect(
      await actions.evaluate((row) => row.scrollWidth <= row.clientWidth),
      section.view,
    ).toBe(true);
    const middles = await actions
      .locator("button, a[href], [role=tab]")
      .evaluateAll((parts) =>
        parts.map((part) => {
          const box = part.getBoundingClientRect();
          return Math.round(box.y + box.height / 2);
        }),
      );
    expect(Math.max(...middles) - Math.min(...middles)).toBeLessThan(12);
  }
  // Backup's Access security is a quiet 44px button, not a block.
  await openSection(page, sections[1]);
  const security = main(page).getByRole("link", { name: "Access security" });
  await expect(security).toHaveAttribute("data-variant", "ghost");
  expect(Math.round((await security.boundingBox())?.height ?? 0)).toBe(44);
});

const longJobs: JobRow[] = [
  "Weekly capacity report",
  "Maintenance window reminder",
  "Department capacity review",
  "Customer account follow-up",
  "Quality follow-up meeting",
  "Quarterly staffing summary",
].map((subject_label, index) => ({
  kind: index % 2 ? "event-reminder" : "report-run",
  subject_label,
  state: "succeeded",
  can_retry: false,
}));

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
]) {
  test(`at ${viewport.width} by ${viewport.height} Jobs subjects read in full and Filters shares the quick-filter line`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockManageBackups(page);
    await mockJobs(page, longJobs);
    await page.goto("/manage?view=jobs");
    for (const job of longJobs) {
      const subject = main(page).getByText(job.subject_label, { exact: true });
      await expect(subject).toBeVisible();
      expect(
        await subject.evaluate((text) => text.scrollWidth <= text.clientWidth),
        job.subject_label,
      ).toBe(true);
    }
    expect(await cutTexts(main(page))).toEqual([]);
    const toolbar = main(page).getByRole("region", { name: "Jobs controls" });
    expect(await toolbarLines(toolbar)).toEqual([2]);
    const [states, filters] = await Promise.all([
      toolbar.getByRole("group", { name: "Job state" }).boundingBox(),
      toolbar
        .getByRole("button", { name: "Filters", exact: true })
        .boundingBox(),
    ]);
    expect(
      Math.abs(
        states!.y + states!.height / 2 - (filters!.y + filters!.height / 2),
      ),
    ).toBeLessThan(12);
    await expectNoHorizontalScroll(page);
  });

  test(`at ${viewport.width} by ${viewport.height} Audit and Backup rows read in full with no toolbar control alone on a line`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await installEverySection(page);
    await openSection(page, sections[2]);
    expect(await cutTexts(main(page))).toEqual([]);
    expect(
      await toolbarLines(
        main(page).getByRole("region", { name: "Search activity controls" }),
      ),
    ).toEqual([3]);
    await openSection(page, sections[1]);
    expect(await cutTexts(main(page))).toEqual([]);
    for (const line of await toolbarLines(
      main(page).getByRole("region", { name: "Search backups controls" }),
    ))
      expect(line).toBeGreaterThan(1);
    await expectNoHorizontalScroll(page);
  });
}

/**
 * Scrolls a dialog to each end and checks its close and footer buttons stay
 * in view. A form dialog opens on its first field and keeps Cancel beside
 * its action, so a phone has a "no" next to it.
 */
async function expectFramed(
  dialog: Locator,
  close: string,
  footer: readonly string[],
  firstField?: string,
) {
  await expect(dialog).toBeVisible();
  if (firstField)
    await expect(dialog.getByLabel(firstField, { exact: true })).toBeFocused();
  // On a phone a dialog fills the width inside the 16px page gutter.
  expect((await dialog.boundingBox())?.width).toBeGreaterThanOrEqual(
    phone.width - 32,
  );
  const closeButton = dialog.getByRole("button", { name: close, exact: true });
  for (const end of ["top", "bottom"] as const) {
    await dialog.evaluate((content, to) => {
      content.scrollTop = to === "top" ? 0 : content.scrollHeight;
    }, end);
    await expect(closeButton, `${close} at the ${end}`).toBeInViewport({
      ratio: 1,
    });
    for (const name of footer)
      await expect(
        dialog.getByRole("button", { name, exact: true }),
        `${name} at the ${end}`,
      ).toBeInViewport({ ratio: 1 });
  }
  // The named close replaces "Close preview".
  await expect(
    dialog.getByRole("button", { name: "Close preview", exact: true }),
  ).toHaveCount(0);
}

test("on a phone each Manage dialog has a named close and keeps its footer in view", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The configured browser origin is required.");
  await page.setViewportSize(phone);
  await mockManageSecurity(page);
  const exports = await mockManageBackupExports(page, baseURL);
  await mockAudit(page);
  await page.goto("/manage?view=backup");
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  const backUp = page.getByRole("dialog", { name: "Back up now" });
  await expectFramed(
    backUp,
    "Close without backing up",
    ["Cancel", "Back up now"],
    "Backup name",
  );
  await backUp
    .getByRole("button", { name: "Close without backing up", exact: true })
    .click();
  await expect(backUp).toBeHidden();

  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  const schedule = page.getByRole("dialog", { name: "Backup schedule" });
  await expectFramed(schedule, "Close backup schedule", ["Close"]);
  await page.keyboard.press("Escape");

  await page
    .getByRole("button", { name: "Inspect Backup 1", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Selected backup", exact: true })
    .getByRole("button", { name: "Prepare encrypted backup", exact: true })
    .click();
  const prepare = page.getByRole("dialog", {
    name: "Prepare encrypted backup",
  });
  await expectFramed(
    prepare,
    "Close export",
    ["Cancel", "Prepare encrypted backup"],
    "Passphrase",
  );
  await page.keyboard.press("Escape");

  const operation = readyBackupExport(exports.backups.runs[0]!.id);
  exports.operations.set(operation.id, operation);
  await page.goto(
    "/manage?view=backup&export=" + encodeURIComponent(operation.id),
  );
  await page
    .getByRole("region", { name: "Encrypted backup", exact: true })
    .getByRole("button", { name: "Confirm password", exact: true })
    .click();
  await expectFramed(
    page.getByRole("dialog", { name: "Confirm password" }),
    "Close without downloading",
    ["Cancel", "Confirm password"],
    "Current password",
  );
  await page.keyboard.press("Escape");

  await page.goto("/manage?view=audit");
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", { name: "Audit export preview" });
  await expect(
    preview.getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeEnabled();
  // The CSV preview makes this dialog long; the content is the one scroller.
  expect(
    await preview.evaluate(
      (content) => content.scrollHeight > content.clientHeight,
    ),
  ).toBe(true);
  await expectFramed(preview, "Close export", ["Download CSV"]);
});

test("at 1024 by 768 opening a backup brings its detail, under the list, into view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installEverySection(page);
  await openSection(page, sections[1]);
  await page
    .getByRole("button", { name: "Inspect Backup 4", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Selected backup", exact: true })
      .getByRole("heading", { name: "Backup 4", exact: true }),
  ).toBeInViewport();
});
