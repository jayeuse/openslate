import { expect, signedInAs, test, type Page } from "./helpers/test";
import { fixtureId } from "./helpers/access-api";
import { mockManageBackups } from "./helpers/manage-backups";

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

async function mockJobs(page: Page) {
  const items = Array.from({ length: 30 }, (_, index) => ({
    kind: "report",
    id: fixtureId(6000 + index),
    subject_label: `Weekly report ${index + 1}`,
    subject_link: null,
    state: "succeeded",
    scheduled_for: "2026-10-01T00:00:00Z",
    last_attempt_at: "2026-10-01T00:05:00Z",
    next_attempt_at: null,
    attempts: 1,
    failure_code: null,
    failure_label: null,
    can_retry: false,
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
