import {
  authMeBody,
  defaultOrganization,
  expect,
  test,
  type Page,
} from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { pageOf } from "../helpers/pagination";
import { wireField } from "../helpers/wire";

const userA = "00000000-0000-4000-8000-000000000101";
const userB = "00000000-0000-4000-8000-000000000201";
const departmentId = "00000000-0000-4000-8000-000000000102";
const moduleId = "00000000-0000-4000-8000-000000000103";
const fieldId = "00000000-0000-4000-8000-000000000104";
const timestamp = "2026-09-24T00:00:00Z";

// Each person reads a different department's Report; the cache must not mix them.
function report(id: string, _readerId: string, name: string) {
  return {
    id,
    module_id: moduleId,
    name,
    subtitle: null,
    revision: 1,
    recipe: {
      version: 1,
      fields: [{ field_id: fieldId, expected_type: "text" }],
      filters: [],
      logic: "and",
      sorts: [],
      group_by: null,
      include_row_count: false,
    },
    is_deleted: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

const reportsByUser: Record<string, ReturnType<typeof report>[]> = {
  [userA]: [
    report("00000000-0000-4000-8000-000000000105", userA, "Alpha report"),
  ],
  [userB]: [
    report("00000000-0000-4000-8000-000000000205", userB, "Beta report"),
  ],
};

type Api = {
  /** GET /api/reports list reads, in order. */
  reportLists: string[];
  /** GET /api/views/data-sources catalog reads, in order. */
  catalogReads: string[];
  setUser(user: string): void;
  /** Holds Reports list responses until the returned release is called. */
  holdLists(): () => void;
  /** Refuses (403) Reports list reads while true. */
  denyLists(denied: boolean): void;
  /** Refuses (403) catalog reads while true. */
  denyCatalog(denied: boolean): void;
  /** Holds catalog reads until the returned release is called. */
  holdCatalog(): () => void;
  /** Makes the catalog's first page say more pages exist, and refuses them. */
  refuseLaterCatalogPages(): void;
  /**
   * Makes the catalog's first page say one more page exists and serves these
   * sources on it. The first page itself stays the same.
   */
  setLaterCatalogPage(sources: { id: string; name: string }[]): void;
  /** Makes the first field page say more pages exist, and refuses them. */
  refuseLaterFieldPages(): void;
  /** Holds field reads until the returned release is called. */
  holdFields(): () => void;
};

const forbidden = {
  status: 403,
  contentType: "application/json",
  body: JSON.stringify({ detail: "Forbidden" }),
};

// Mocks the reads behind Reports and Charts for one signed-in person at a
// time. Counts are per read path so a test can prove what a revisit or an
// invalidation requested.
async function installOpenViewApi(page: Page): Promise<Api> {
  let activeUser = userA;
  let listHold: Promise<void> | null = null;
  let listDenied = false;
  let catalogDenied = false;
  let catalogHold: Promise<void> | null = null;
  let laterPagesRefused = false;
  let laterPage: { id: string; name: string }[] | null = null;
  let laterFieldPagesRefused = false;
  let fieldHold: Promise<void> | null = null;
  const reportLists: string[] = [];
  const catalogReads: string[] = [];
  await installOpenViewEventSource(page);
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        organization_id: defaultOrganization.org_id,
        user_id: activeUser,
        default_organization_blocked: null,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        authMeBody({
          id: activeUser,
          default_organization_blocked: null,
          // An administrator manages every department, so Reports can be created.
          role: "admin",
          access: [],
        }),
      ),
    }),
  );
  // The sidebar's Departments section names the catalog's department.
  await page.route(
    (url) => url.pathname === "/api/departments",
    (route) =>
      route.fulfill({
        json: pageOf(
          [
            {
              id: departmentId,
              department_name: "Operations",
              created_at: "2026-09-01T00:00:00Z",
              updated_at: "2026-09-01T00:00:00Z",
              deleted_at: null,
              is_deleted: false,
              performed_by: null,
            },
          ],
          { limit: 100 },
        ),
      }),
  );
  await page.route("**/api/views/data-sources**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    // Fields need records.read like the catalog: they follow its refusal.
    if (path !== "/api/views/data-sources" && catalogDenied)
      return route.fulfill(forbidden);
    if (path === "/api/views/data-sources") {
      const offset = Number(
        new URL(route.request().url()).searchParams.get("offset") ?? 0,
      );
      if (offset > 0) {
        if (laterPagesRefused) return route.fulfill(forbidden);
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            pageOf(
              (laterPage ?? []).map((source) => ({
                ...source,
                department_id: departmentId,
                title_field_id: null,
              })),
              { limit: 100 },
            ),
          ),
        });
      }
      catalogReads.push(route.request().url());
      if (catalogHold) await catalogHold;
      if (catalogDenied) return route.fulfill(forbidden);
      if (laterPagesRefused || laterPage) {
        const first = pageOf(
          [
            {
              id: moduleId,
              name: "Assets",
              department_id: departmentId,
              title_field_id: null,
            },
          ],
          { limit: 100 },
        );
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ...first,
            pagination: { ...first.pagination, total: 2, has_more: true },
          }),
        });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageOf(
            [
              {
                id: moduleId,
                name: "Assets",
                department_id: departmentId,
                title_field_id: null,
              },
            ],
            { limit: 100 },
          ),
        ),
      });
    }
    const fieldOffset = Number(
      new URL(route.request().url()).searchParams.get("offset") ?? 0,
    );
    if (fieldOffset > 0) return route.fulfill(forbidden);
    if (fieldHold) await fieldHold;
    if (catalogDenied) return route.fulfill(forbidden);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        pageOf(
          [
            wireField({
              id: fieldId,
              module_id: moduleId,
              name: "Asset",
              type: "text",
              required: true,
              position: 0,
            }),
          ],
          { limit: 100, total: laterFieldPagesRefused ? 2 : 1 },
        ),
      ),
    });
  });
  await page.route("**/api/reports**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // A Report's history needs records.read, like the list.
    if (
      /^\/api\/reports\/[^/]+\/runs$/.test(path) &&
      request.method() === "GET"
    ) {
      if (listDenied) return route.fulfill(forbidden);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pageOf([], { limit: 25 })),
      });
    }
    if (path === "/api/reports" && request.method() === "GET") {
      reportLists.push(request.url());
      const user = activeUser;
      if (listHold) await listHold;
      if (listDenied) return route.fulfill(forbidden);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pageOf(reportsByUser[user] ?? [], { limit: 25 })),
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  return {
    reportLists,
    catalogReads,
    setUser(user) {
      activeUser = user;
    },
    denyLists(denied) {
      listDenied = denied;
    },
    denyCatalog(denied) {
      catalogDenied = denied;
    },
    refuseLaterCatalogPages() {
      laterPagesRefused = true;
    },
    setLaterCatalogPage(sources) {
      laterPage = sources;
    },
    refuseLaterFieldPages() {
      laterFieldPagesRefused = true;
    },
    holdFields() {
      let release: () => void = () => {};
      fieldHold = new Promise<void>((resolve) => {
        release = () => {
          fieldHold = null;
          resolve();
        };
      });
      return release;
    },
    holdCatalog() {
      let release: () => void = () => {};
      catalogHold = new Promise<void>((resolve) => {
        release = () => {
          catalogHold = null;
          resolve();
        };
      });
      return release;
    },
    holdLists() {
      let release: () => void = () => {};
      listHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

type LoadingProbe = {
  busyAt: number | null;
  statusAt: number | null;
};

// Records, in page time, when a loading region first reserves its space and
// when its skeleton label is first announced, so a test can prove the delay
// and prove that a fast or cached load never announces one.
async function installLoadingProbe(page: Page, label: string) {
  await page.addInitScript((statusLabel) => {
    const probe: LoadingProbe = { busyAt: null, statusAt: null };
    (window as Window & { __loadingProbe?: LoadingProbe }).__loadingProbe =
      probe;
    new MutationObserver(() => {
      const now = performance.now();
      if (
        probe.busyAt === null &&
        document.querySelector('[data-slot="loading-region"][aria-busy="true"]')
      )
        probe.busyAt = now;
      if (
        probe.statusAt === null &&
        [...document.querySelectorAll('[role="status"]')].some(
          (element) => element.textContent === statusLabel,
        )
      )
        probe.statusAt = now;
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-busy"],
    });
  }, label);
}

function readLoadingProbe(page: Page) {
  return page.evaluate(
    () =>
      (window as Window & { __loadingProbe?: LoadingProbe }).__loadingProbe ??
      null,
  );
}

function resetLoadingProbe(page: Page) {
  return page.evaluate(() => {
    const probe = (window as Window & { __loadingProbe?: LoadingProbe })
      .__loadingProbe;
    if (probe) {
      probe.busyAt = null;
      probe.statusAt = null;
    }
  });
}

// Counts invalidation streams the page opens across section changes.
async function countEventStreams(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__eventStreams", {
      configurable: true,
      get: () =>
        (
          window as Window & {
            __openViewStreamState?: () => { constructed: number };
          }
        ).__openViewStreamState?.().constructed ?? 0,
    });
  });
}

function sidebarLink(page: Page, name: string) {
  return page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name, exact: true });
}

/** Follows the Assets module link in the sidebar, opening its department. */
async function followAssetsLink(page: Page) {
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const link = sidebarLink(page, "Assets");
  if (!(await link.count()))
    await nav
      .getByRole("button", { name: "Operations", exact: true })
      .dispatchEvent("click");
  await link.dispatchEvent("click");
}

/** The Assets module page's Reports view (OpenView part C, DC1). */
const reportsPage = `/openview?section=views&module=${moduleId}&tab=reports`;
const reportRow = (page: Page, name: string) =>
  page
    .getByRole("list", { name: "Assets reports" })
    .getByRole("button", { name: new RegExp(`^${name}`) });
const reportsLink = (page: Page) =>
  page
    .getByRole("navigation", { name: "Assets page" })
    .getByRole("link", { name: /^Reports/ });
// A refusal hides every OpenView read (openview-access.ts), the module
// page's catalog with it. Its Retry reads the catalog again, and the Reports
// view, mounting again, reads its refused list once more.
const openViewDenial = (page: Page) =>
  page.getByText(
    "OpenView data is unavailable. Sign in or ask for access, then retry.",
  );
async function recoverReports(page: Page) {
  await page.getByRole("button", { name: "Retry catalog" }).click();
}

test("revisiting Reports within the cache window shows its list at once without a new request", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await installLoadingProbe(page, "Loading reports…");
  await countEventStreams(page);
  await page.goto(reportsPage);
  await expect(reportRow(page, "Alpha report")).toBeVisible();
  // The switch's count and the list are one cached read.
  expect(api.reportLists).toHaveLength(1);
  // Development Strict Mode may open and close a first stream on mount, so
  // the claim is that view changes open no further stream.
  const streamsAfterFirstLoad = await page.evaluate(
    () => (window as Window & { __eventStreams?: number }).__eventStreams,
  );
  expect(streamsAfterFirstLoad).toBeGreaterThan(0);

  await followAssetsLink(page);
  await expect(page).toHaveURL(/section=views&module=[^&]+$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Assets" }),
  ).toBeVisible();

  await resetLoadingProbe(page);
  await reportsLink(page).dispatchEvent("click");
  await expect(page).toHaveURL(/tab=reports/);
  await expect(reportRow(page, "Alpha report")).toBeVisible();
  // Client navigation keeps the cache (a page.goto would reload the tab).
  expect(api.reportLists).toHaveLength(1);
  const probe = await readLoadingProbe(page);
  expect(probe?.busyAt).toBeNull();
  expect(probe?.statusAt).toBeNull();
  // Both views shared the stream that was already open.
  expect(
    await page.evaluate(
      () => (window as Window & { __eventStreams?: number }).__eventStreams,
    ),
  ).toBe(streamsAfterFirstLoad);
});

test("a refused Reports refresh hides the reports it had cached", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto(reportsPage);
  const report = reportRow(page, "Alpha report");
  await expect(report).toBeVisible();

  api.denyLists(true);
  await sendOpenViewEvent(page, "resync");
  await expect(openViewDenial(page).first()).toBeVisible();
  await expect(report).toHaveCount(0);

  // A read started after the refusal, and authorized, restores the list.
  api.denyLists(false);
  await recoverReports(page);
  await expect(report).toBeVisible();
});

type CatalogDenialCase = {
  name: string;
  section: string;
  invalidation: Record<string, string>;
  denial: string;
  loading: string;
};

// Module-scoped changes carry their module (D10); the notice still applies.
const catalogDenialCases: CatalogDenialCase[] = [
  {
    name: "Views",
    section: "views",
    invalidation: { entity: "modules", module_id: moduleId },
    denial:
      "OpenView data is unavailable. Sign in or ask for access, then retry.",
    loading: "Loading OpenView catalog",
  },
];

for (const current of catalogDenialCases) {
  test(`a ${current.name} denial stays in force while its Retry is in flight`, async ({
    page,
  }) => {
    const api = await installOpenViewApi(page);
    await page.goto(`/openview?section=${current.section}`);
    const denial = page.getByText(current.denial);
    // The catalog shows as the module page's title (OD1).
    const source = page.getByRole("heading", { level: 1, name: "Assets" });
    await expect(source).toHaveCount(1);
    await sendOpenViewEvent(page, "resync");
    await expect.poll(() => api.catalogReads.length).toBe(2);

    api.denyCatalog(true);
    await sendOpenViewEvent(page, "invalidate", current.invalidation);
    await expect(denial.first()).toBeVisible();
    await expect(source).toHaveCount(0);

    api.denyCatalog(false);
    const release = api.holdCatalog();
    const reads = api.catalogReads.length;
    await page.getByRole("button", { name: "Retry catalog" }).click();
    await expect.poll(() => api.catalogReads.length).toBe(reads + 1);
    // Access is not confirmed yet, so the retained catalog stays hidden.
    await expect(
      page.getByRole("status").filter({ hasText: current.loading }),
    ).toBeVisible();
    await expect(source).toHaveCount(0);

    release();
    await expect(source).toHaveCount(1);
    await expect(denial).toHaveCount(0);
  });
}

test("a refused field page or refresh hides cached fields from the report dialog", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  api.refuseLaterFieldPages();
  await page.goto(reportsPage);
  await page.getByRole("button", { name: "New report" }).click();
  const dialog = page.getByRole("dialog", { name: "New report" });
  const field = dialog.getByRole("checkbox", { name: "Asset" });
  await expect(field).toHaveCount(1);
  await dialog.getByRole("button", { name: "Load more fields" }).click();
  await expect(field).toHaveCount(0);

  // The refusal belongs to the shared field reads: the dialog must read them
  // again before it may show any field.
  const release = api.holdFields();
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(field).toHaveCount(0);

  // An authorized read shows the field again.
  release();
  await expect(field).toHaveCount(1);

  // A refused refresh hides it from the open dialog too.
  api.denyCatalog(true);
  await sendOpenViewEvent(page, "resync");
  await expect(field).toHaveCount(0);
});

test("a refusal on a module page hides cached Reports until an authorized read", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto(reportsPage);
  const report = reportRow(page, "Alpha report");
  await expect(report).toBeVisible();
  await followAssetsLink(page);
  const title = page.getByRole("heading", { level: 1, name: "Assets" });
  await expect(title).toBeVisible();
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.catalogReads.length).toBeGreaterThan(1);

  api.denyCatalog(true);
  await sendOpenViewEvent(page, "invalidate", { entity: "modules" });
  await expect(title).toHaveCount(0);

  // The Reports list is still cached as a success, but access was refused.
  await page.goBack();
  await expect(page).toHaveURL(/tab=reports/);
  await expect(report).toHaveCount(0);

  api.denyCatalog(false);
  await page.getByRole("button", { name: "Retry catalog" }).click();
  await expect(report).toBeVisible();
  // The refused catalog also hid the sidebar's departments; the server's
  // next modules change reads it again and they return.
  await sendOpenViewEvent(page, "invalidate", { entity: "modules" });
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Operations", exact: true }),
  ).toBeVisible();
});

test("a cold read in flight during a later resync reads again", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  const release = api.holdLists();
  await page.goto(reportsPage);
  await expect.poll(() => api.reportLists.length).toBe(1);
  // The opening resync restarts the cold read once.
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.reportLists.length).toBe(2);
  // A later resync (a stream interruption) restarts it again.
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.reportLists.length).toBe(3);
  release();
  await expect(reportRow(page, "Alpha report")).toBeVisible();
});

test("a refusal hides an opened Report, not only the list", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto(reportsPage);
  const main = page.locator("#main-content");
  const opened = main.getByRole("heading", { level: 2, name: "Alpha report" });
  await expect(opened).toBeVisible();

  // records.read is revoked; the next read of the list or the copies is
  // refused, and the opened report goes with the list.
  api.denyLists(true);
  await sendOpenViewEvent(page, "resync");
  await expect(openViewDenial(page).first()).toBeVisible();
  await expect(main.getByText("Alpha report")).toHaveCount(0);

  // An authorized read restores the list and the opened report.
  api.denyLists(false);
  await recoverReports(page);
  await expect(opened).toBeVisible();
});

test("server invalidations still reload cached OpenView reads", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto(reportsPage);
  await expect(reportRow(page, "Alpha report")).toBeVisible();
  await expect.poll(() => api.catalogReads.length).toBe(1);
  expect(api.reportLists).toHaveLength(1);
  // The server opens every stream with a resync (the harness stream does not
  // send it itself). Reads that started before it may have missed a change,
  // so they read once more.
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.reportLists.length).toBe(2);
  await expect.poll(() => api.catalogReads.length).toBe(2);

  // A saved-view change does not touch the catalog or the Reports list.
  await sendOpenViewEvent(page, "invalidate", { entity: "saved_views" });
  // A catalog change reloads the data-source catalog only.
  await sendOpenViewEvent(page, "invalidate", { entity: "modules" });
  await expect.poll(() => api.catalogReads.length).toBe(3);
  expect(api.reportLists).toHaveLength(2);

  // A resync reloads every cached OpenView read in view.
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.reportLists.length).toBe(3);
  await expect.poll(() => api.catalogReads.length).toBe(4);
  await expect(reportRow(page, "Alpha report")).toBeVisible();
});

// The page's timers run on a paused clock, so the skeleton delay is exact.
async function pauseClock(page: Page) {
  await page.clock.install({ time: new Date("2026-09-27T09:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-27T09:00:01Z"));
}

test("a slow Reports list shows its skeleton only after the reserve delay", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  const release = api.holdLists();
  await pauseClock(page);
  await page.goto(reportsPage);

  // The view's frame renders once the module is known, outside the loading
  // region; the query cache hands results over on a zero-delay timer.
  const frame = page.getByRole("heading", { name: "Reports", exact: true });
  await expect
    .poll(
      async () => {
        await page.clock.runFor(1);
        return frame.count();
      },
      { intervals: [50] },
    )
    .toBe(1);
  // New report waits only for the signed-in identity, which the query cache
  // hands over on a zero-delay timer; the held list stays loading.
  const newReport = page.getByRole("button", { name: "New report" });
  await expect
    .poll(
      async () => {
        await page.clock.runFor(1);
        return newReport.count();
      },
      { intervals: [50] },
    )
    .toBe(1);
  await expect(
    page.locator('[data-slot="loading-region"][aria-busy="true"]'),
  ).toHaveCount(1);
  const label = page.getByRole("status").filter({
    hasText: "Loading reports…",
  });
  await page.clock.runFor(240);
  await expect(label).toHaveCount(0);
  await page.clock.runFor(100);
  await expect(label).toBeVisible();

  const listed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/reports",
  );
  release();
  await listed;
  const content = reportRow(page, "Alpha report");
  // Shown at 300ms, the skeleton stays until at least 600ms.
  await page.clock.runFor(100);
  await expect(label).toBeVisible();
  await expect(content).toHaveCount(0);
  await page.clock.runFor(200);
  await expect
    .poll(
      async () => {
        await page.clock.runFor(1);
        return content.count();
      },
      { intervals: [50] },
    )
    .toBe(1);
  await expect(label).toHaveCount(0);
});

test("a fast Reports list never announces a skeleton", async ({ page }) => {
  const api = await installOpenViewApi(page);
  const release = api.holdLists();
  await pauseClock(page);
  await page.goto(reportsPage);
  await expect(
    page.locator('[data-slot="loading-region"][aria-busy="true"]'),
  ).toHaveCount(1);
  await page.clock.runFor(200);
  release();
  // The query cache hands results over on a zero-delay timer.
  await expect
    .poll(
      async () => {
        await page.clock.runFor(1);
        return reportRow(page, "Alpha report").count();
      },
      { intervals: [50] },
    )
    .toBe(1);
  await page.clock.runFor(1_000);
  await expect(
    page.getByRole("status").filter({ hasText: "Loading reports…" }),
  ).toHaveCount(0);
});

test("a different account never sees the previous account's cached Reports", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto(reportsPage);
  await expect(reportRow(page, "Alpha report")).toBeVisible();
  expect(api.reportLists).toHaveLength(1);

  // The tab returns under another account; the session gate re-verifies.
  api.setUser(userB);
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));

  await expect(reportRow(page, "Beta report")).toBeVisible();
  await expect(reportRow(page, "Alpha report")).toHaveCount(0);
  // The new account read its own list instead of reusing the cached one.
  expect(api.reportLists).toHaveLength(2);
});
