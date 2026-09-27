import { expect, test, type Page } from "@playwright/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";

const userA = "00000000-0000-4000-8000-000000000101";
const userB = "00000000-0000-4000-8000-000000000201";
const departmentId = "00000000-0000-4000-8000-000000000102";
const moduleId = "00000000-0000-4000-8000-000000000103";
const fieldId = "00000000-0000-4000-8000-000000000104";
const timestamp = "2026-09-24T00:00:00Z";

function pageOf<T>(items: T[], limit = 25) {
  return {
    items,
    pagination: {
      limit,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  };
}

function report(id: string, ownerId: string, name: string) {
  return {
    id,
    owner_id: ownerId,
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
    audience: { kind: "private", user_id: null },
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
  const reportLists: string[] = [];
  const catalogReads: string[] = [];
  await installOpenViewEventSource(page);
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: activeUser,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: activeUser,
        role: "member",
        access: [],
      }),
    }),
  );
  await page.route("**/api/charts/preferences", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ config: null }),
    }),
  );
  // Audience options need records.read like the catalog, so they follow
  // the catalog's refusal and hold.
  await page.route("**/api/views/audience-options**", async (route) => {
    if (catalogHold) await catalogHold;
    if (catalogDenied) return route.fulfill(forbidden);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(pageOf([], 100)),
    });
  });
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
              })),
              100,
            ),
          ),
        });
      }
      catalogReads.push(route.request().url());
      if (catalogHold) await catalogHold;
      if (catalogDenied) return route.fulfill(forbidden);
      if (laterPagesRefused || laterPage) {
        const first = pageOf(
          [{ id: moduleId, name: "Assets", department_id: departmentId }],
          100,
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
            [{ id: moduleId, name: "Assets", department_id: departmentId }],
            100,
          ),
        ),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        pageOf(
          [
            {
              id: fieldId,
              module_id: moduleId,
              name: "Asset",
              type: "text",
              required: true,
              position: 0,
              config: {},
            },
          ],
          100,
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
        body: JSON.stringify(pageOf([])),
      });
    }
    if (path === "/api/reports/shared-runs")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pageOf([])),
      });
    if (path === "/api/reports" && request.method() === "GET") {
      reportLists.push(request.url());
      const user = activeUser;
      if (listHold) await listHold;
      if (listDenied) return route.fulfill(forbidden);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pageOf(reportsByUser[user] ?? [])),
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
    const Harness = window.EventSource;
    const counted = window as Window & { __eventStreams?: number };
    counted.__eventStreams = 0;
    class CountedEventSource extends Harness {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        counted.__eventStreams = (counted.__eventStreams ?? 0) + 1;
      }
    }
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: CountedEventSource,
    });
  });
}

function sidebarLink(page: Page, name: string) {
  return page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name, exact: true });
}

test("revisiting Reports within the cache window shows its list at once without a new request", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await installLoadingProbe(page, "Loading Reports…");
  await countEventStreams(page);
  await page.goto("/openview?section=reports");
  await expect(
    page.getByRole("button", { name: "Alpha report" }),
  ).toBeVisible();
  expect(api.reportLists).toHaveLength(1);
  // Development Strict Mode may open and close a first stream on mount, so
  // the claim is that section changes open no further stream.
  const streamsAfterFirstLoad = await page.evaluate(
    () => (window as Window & { __eventStreams?: number }).__eventStreams,
  );

  await sidebarLink(page, "Charts").click();
  await expect(page).toHaveURL(/section=charts/);
  await expect(page.getByRole("heading", { name: "Charts" })).toBeVisible();

  await resetLoadingProbe(page);
  await sidebarLink(page, "Reports").click();
  await expect(page).toHaveURL(/section=reports/);
  await expect(
    page.getByRole("button", { name: "Alpha report" }),
  ).toBeVisible();
  // Client navigation keeps the cache (a page.goto would reload the tab).
  expect(api.reportLists).toHaveLength(1);
  const probe = await readLoadingProbe(page);
  expect(probe?.busyAt).toBeNull();
  expect(probe?.statusAt).toBeNull();
  // Both sections shared the stream that was already open.
  expect(
    await page.evaluate(
      () => (window as Window & { __eventStreams?: number }).__eventStreams,
    ),
  ).toBe(streamsAfterFirstLoad);
});

test("a Reports list prefetched before the stream connects refreshes once it connects", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  // Dashboards does not listen to the stream, so a hover there prefetches
  // Reports while no stream protects it.
  await page.goto("/openview?section=dashboards");
  await sidebarLink(page, "Reports").hover();
  await expect.poll(() => api.reportLists.length).toBe(1);

  await sidebarLink(page, "Reports").click();
  await expect(
    page.getByRole("button", { name: "Alpha report" }),
  ).toBeVisible();
  expect(api.reportLists).toHaveLength(1);

  // The server opens every stream with a resync; a change could have landed
  // between the prefetch and that moment, so the list refreshes once.
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.reportLists.length).toBe(2);
  await expect(
    page.getByRole("button", { name: "Alpha report" }),
  ).toBeVisible();
});

test("a refused Reports refresh hides the reports it had cached", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto("/openview?section=reports");
  const report = page.getByRole("button", { name: "Alpha report" });
  await expect(report).toBeVisible();

  api.denyLists(true);
  await page.getByRole("button", { name: "Refresh Reports" }).click();
  await expect.poll(() => api.reportLists.length).toBe(2);
  await expect(report).toHaveCount(0);
});

test("a Views denial stays in force while its Retry is in flight", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto("/openview?section=views");
  const denial = page.getByText(
    "OpenView data is unavailable. Sign in or ask for access, then retry.",
  );
  // The catalog shows as the data-source choice.
  const source = page.locator("option", { hasText: "Assets" });
  await expect(source).toHaveCount(1);
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.catalogReads.length).toBe(2);

  api.denyCatalog(true);
  await sendOpenViewEvent(page, "invalidate", { entity: "modules" });
  await expect(denial.first()).toBeVisible();
  await expect(source).toHaveCount(0);

  api.denyCatalog(false);
  const release = api.holdCatalog();
  const reads = api.catalogReads.length;
  await page.getByRole("button", { name: "Retry catalog" }).click();
  await expect.poll(() => api.catalogReads.length).toBe(reads + 1);
  // Access is not confirmed yet, so the retained catalog stays hidden.
  await expect(
    page.getByRole("status").filter({ hasText: "Loading OpenView catalog" }),
  ).toBeVisible();
  await expect(source).toHaveCount(0);

  release();
  await expect(source).toHaveCount(1);
  await expect(denial).toHaveCount(0);
});

test("a Charts denial stays in force while its catalog Retry is in flight", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto("/openview?section=charts");
  const source = page.locator("option", { hasText: "Assets" });
  await expect(source).toHaveCount(1);
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.catalogReads.length).toBe(2);

  api.denyCatalog(true);
  await sendOpenViewEvent(page, "invalidate", { entity: "modules" });
  await expect(source).toHaveCount(0);

  api.denyCatalog(false);
  const release = api.holdCatalog();
  const reads = api.catalogReads.length;
  await page.getByRole("button", { name: "Retry catalog" }).click();
  await expect.poll(() => api.catalogReads.length).toBe(reads + 1);
  // Access is not confirmed yet, so the retained catalog stays hidden.
  await expect(source).toHaveCount(0);

  release();
  await expect(source).toHaveCount(1);
});

test("a refused Charts catalog page stays in force while the catalog retries", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  api.refuseLaterCatalogPages();
  await page.goto("/openview?section=charts");
  const source = page.locator("option", { hasText: "Assets" });
  await expect(source).toHaveCount(1);

  await page.getByRole("button", { name: "Load more data sources" }).click();
  await expect(source).toHaveCount(0);

  const release = api.holdCatalog();
  const reads = api.catalogReads.length;
  await page.getByRole("button", { name: "Retry catalog" }).click();
  await expect.poll(() => api.catalogReads.length).toBe(reads + 1);
  // The first page has not read again yet, so its names stay hidden.
  await expect(source).toHaveCount(0);

  release();
  await expect(source).toHaveCount(1);
});

test("a refused catalog page in Charts hides cached data sources from a new Report recipe", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  api.refuseLaterCatalogPages();
  await page.goto("/openview?section=charts");
  const source = page.locator("option", { hasText: "Assets" });
  await expect(source).toHaveCount(1);
  await page.getByRole("button", { name: "Load more data sources" }).click();
  await expect(source).toHaveCount(0);

  // The refusal belongs to the shared catalog, not to Charts alone: Reports
  // must read the catalog again before it may show any data source.
  const release = api.holdCatalog();
  const reads = api.catalogReads.length;
  await sidebarLink(page, "Reports").click();
  await expect(page).toHaveURL(/section=reports/);
  await page.getByRole("button", { name: "New Report" }).click();
  await expect(page.locator("#report-source")).toBeVisible();
  await expect(source).toHaveCount(0);
  await expect.poll(() => api.catalogReads.length).toBeGreaterThan(reads);
  await expect(source).toHaveCount(0);

  // An authorized read shows the data source again.
  release();
  await expect(source).toHaveCount(1);
});

test("an invalidation drops loaded catalog pages even when the first page is unchanged", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  api.setLaterCatalogPage([
    { id: "00000000-0000-4000-8000-000000000106", name: "Equipment" },
  ]);
  await page.goto("/openview?section=charts");
  await expect(page.locator("option", { hasText: "Assets" })).toHaveCount(1);
  // The stream's opening resync reads the catalog once more.
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.catalogReads.length).toBe(2);

  await page.getByRole("button", { name: "Load more data sources" }).click();
  const equipment = page.locator("option", { hasText: "Equipment" });
  await expect(equipment).toHaveCount(1);

  // The second page changes; the first page reads back deep-equal.
  api.setLaterCatalogPage([
    { id: "00000000-0000-4000-8000-000000000107", name: "Vehicles" },
  ]);
  await sendOpenViewEvent(page, "invalidate", { entity: "modules" });
  await expect.poll(() => api.catalogReads.length).toBe(3);
  await expect(equipment).toHaveCount(0);
  await expect(page.locator("option", { hasText: "Assets" })).toHaveCount(1);

  await page.getByRole("button", { name: "Load more data sources" }).click();
  await expect(page.locator("option", { hasText: "Vehicles" })).toHaveCount(1);
  await expect(equipment).toHaveCount(0);
});

test("a refused catalog page outlasts a first-page read already in flight", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  api.refuseLaterCatalogPages();
  await page.goto("/openview?section=charts");
  const source = page.locator("option", { hasText: "Assets" });
  await expect(source).toHaveCount(1);
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.catalogReads.length).toBe(2);

  // A catalog change starts a first-page read that has not returned yet.
  const release = api.holdCatalog();
  await sendOpenViewEvent(page, "invalidate", { entity: "modules" });
  await expect.poll(() => api.catalogReads.length).toBe(3);

  // The next page is refused while that read is still out.
  await page.getByRole("button", { name: "Load more data sources" }).click();
  await expect(source).toHaveCount(0);

  // The older read started before the refusal, so it cannot clear it.
  release();
  await expect(
    page.getByRole("button", { name: "Retry catalog" }),
  ).toBeVisible();
  await expect(source).toHaveCount(0);

  // A read started after the refusal can.
  await page.getByRole("button", { name: "Retry catalog" }).click();
  await expect(source).toHaveCount(1);
});

test("a refused catalog refresh hides data sources from a new Report recipe", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto("/openview?section=reports");
  await expect(
    page.getByRole("button", { name: "Alpha report" }),
  ).toBeVisible();
  await expect.poll(() => api.catalogReads.length).toBe(1);

  api.denyCatalog(true);
  // The stream connects; the catalog reads again and is refused.
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.catalogReads.length).toBe(2);

  await page.getByRole("button", { name: "New Report" }).click();
  await expect(page.locator("option", { hasText: "Assets" })).toHaveCount(0);
});

test("a refused Reports list hides the other archive filter's cached list too", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto("/openview?section=reports");
  const report = page.getByRole("button", { name: "Alpha report" });
  const archived = page.getByRole("checkbox", { name: "Show archived" });
  await expect(report).toBeVisible();
  // Both archive-filter lists are cached.
  await archived.check();
  await expect(report).toBeVisible();
  await archived.uncheck();
  await expect(report).toBeVisible();

  api.denyLists(true);
  await page.getByRole("button", { name: "Refresh Reports" }).click();
  await expect(report).toHaveCount(0);
  await archived.check();
  await expect(report).toHaveCount(0);

  // A read started after the refusal, and authorized, restores the lists.
  api.denyLists(false);
  await page.getByRole("button", { name: "Refresh Reports" }).click();
  await expect(report).toBeVisible();
});

test("a refusal in Charts hides cached Reports until an authorized read", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto("/openview?section=reports");
  const report = page.getByRole("button", { name: "Alpha report" });
  await expect(report).toBeVisible();
  await sidebarLink(page, "Charts").click();
  await expect(page.locator("option", { hasText: "Assets" })).toHaveCount(1);
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.catalogReads.length).toBeGreaterThan(1);

  api.denyCatalog(true);
  await sendOpenViewEvent(page, "invalidate", { entity: "modules" });
  await expect(page.locator("option", { hasText: "Assets" })).toHaveCount(0);

  // The Reports list is still cached as a success, but access was refused.
  await sidebarLink(page, "Reports").click();
  await expect(page).toHaveURL(/section=reports/);
  await expect(report).toHaveCount(0);

  api.denyCatalog(false);
  await page.getByRole("button", { name: "Refresh Reports" }).click();
  await expect(report).toBeVisible();
});

test("a cold read in flight when the stream connects reads again", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  const release = api.holdLists();
  await page.goto("/openview?section=reports");
  await expect.poll(() => api.reportLists.length).toBe(1);
  // The stream connects while the first list read is still out.
  await sendOpenViewEvent(page, "resync");
  release();
  await expect.poll(() => api.reportLists.length).toBeGreaterThanOrEqual(2);
  await expect(
    page.getByRole("button", { name: "Alpha report" }),
  ).toBeVisible();
});

test("a cold read in flight during a later resync reads again", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  const release = api.holdLists();
  await page.goto("/openview?section=reports");
  await expect.poll(() => api.reportLists.length).toBe(1);
  // The opening resync restarts the cold read once.
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.reportLists.length).toBe(2);
  // A later resync (a stream interruption) restarts it again.
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => api.reportLists.length).toBe(3);
  release();
  await expect(
    page.getByRole("button", { name: "Alpha report" }),
  ).toBeVisible();
});

test("a refusal hides an opened Report, not only the list", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Alpha report" }).click();
  const main = page.locator("main");
  await expect(main.getByText("Alpha report")).not.toHaveCount(0);

  api.denyLists(true);
  await page.getByRole("button", { name: "Refresh Reports" }).click();
  await expect(
    page.getByText(
      "OpenView data is unavailable. Sign in or ask for access, then retry.",
    ),
  ).not.toHaveCount(0);
  await expect(main.getByText("Alpha report")).toHaveCount(0);
});

test("a refusal seen in Dashboards hides the cached Views catalog", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto("/openview?section=views");
  const source = page.locator("option", { hasText: "Assets" });
  await expect(source).toHaveCount(1);

  // Dashboards reads the catalog itself, without the cache, and is refused.
  api.denyCatalog(true);
  const reads = api.catalogReads.length;
  await sidebarLink(page, "Dashboards").click();
  await expect.poll(() => api.catalogReads.length).toBeGreaterThan(reads);

  // Back in Views the cached catalog reads again. While those reads are
  // out, the refusal Dashboards saw already hides the cached names.
  const release = api.holdCatalog();
  const before = api.catalogReads.length;
  await sidebarLink(page, "Views").click();
  await expect(page).toHaveURL(/section=views/);
  await expect.poll(() => api.catalogReads.length).toBeGreaterThan(before);
  await expect(source).toHaveCount(0);
  release();
  await expect(source).toHaveCount(0);

  // An authorized read started after the refusal restores them.
  api.denyCatalog(false);
  await page.getByRole("button", { name: "Retry catalog" }).click();
  await expect(source).toHaveCount(1);
});

test("a refused Report history read hides the opened Report and the list", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto("/openview?section=reports");
  const main = page.locator("main");
  await expect(
    page.getByRole("button", { name: "Alpha report" }),
  ).toBeVisible();

  // records.read is revoked; opening the Report reads its history first.
  api.denyLists(true);
  await page.getByRole("button", { name: "Alpha report" }).click();
  await expect(
    page.getByText(
      "OpenView data is unavailable. Sign in or ask for access, then retry.",
    ),
  ).not.toHaveCount(0);
  await expect(main.getByText("Alpha report")).toHaveCount(0);
});

test("server invalidations and Refresh still reload cached OpenView reads", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto("/openview?section=reports");
  await expect(
    page.getByRole("button", { name: "Alpha report" }),
  ).toBeVisible();
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

  await page.getByRole("button", { name: "Refresh Reports" }).click();
  await expect.poll(() => api.reportLists.length).toBe(4);
  await expect(
    page.getByRole("button", { name: "Alpha report" }),
  ).toBeVisible();
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
  await page.goto("/openview?section=reports");

  // The page frame renders at once, outside the loading region.
  await expect(
    page.getByRole("heading", { name: "Reports", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "New Report" })).toBeVisible();
  await expect(
    page.locator('[data-slot="loading-region"][aria-busy="true"]'),
  ).toHaveCount(1);
  const label = page.getByRole("status").filter({
    hasText: "Loading Reports…",
  });
  await page.clock.runFor(250);
  await expect(label).toHaveCount(0);
  await page.clock.runFor(100);
  await expect(label).toBeVisible();

  const listed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/reports",
  );
  release();
  await listed;
  const content = page.getByRole("button", { name: "Alpha report" });
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
  await page.goto("/openview?section=reports");
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
        return page.getByRole("button", { name: "Alpha report" }).count();
      },
      { intervals: [50] },
    )
    .toBe(1);
  await page.clock.runFor(1_000);
  await expect(
    page.getByRole("status").filter({ hasText: "Loading Reports…" }),
  ).toHaveCount(0);
});

test("a different account never sees the previous account's cached Reports", async ({
  page,
}) => {
  const api = await installOpenViewApi(page);
  await page.goto("/openview?section=reports");
  await expect(
    page.getByRole("button", { name: "Alpha report" }),
  ).toBeVisible();
  expect(api.reportLists).toHaveLength(1);

  // The tab returns under another account; the session gate re-verifies.
  api.setUser(userB);
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));

  await expect(page.getByRole("button", { name: "Beta report" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Alpha report" })).toHaveCount(
    0,
  );
  // The new account read its own list instead of reusing the cached one.
  expect(api.reportLists).toHaveLength(2);
});
