import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Download,
  type Page,
  type Route,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const userId = "00000000-0000-4000-8000-000000000001";
const moduleId = "00000000-0000-4000-8000-000000000010";
const departmentId = "00000000-0000-4000-8000-000000000011";
const categoryFieldId = "00000000-0000-4000-8000-000000000012";
const amountFieldId = "00000000-0000-4000-8000-000000000013";
const dateFieldId = "00000000-0000-4000-8000-000000000014";
const integerFieldId = "00000000-0000-4000-8000-000000000015";

type AggregateItem = {
  key: string | null;
  label: string;
  value: string | number;
  record_count: number;
};

type AggregateBody = {
  module_id: string;
  mode: "groups" | "date_series";
  aggregation: "count" | "sum" | "average";
  definition: {
    version: 1;
    logic: "and" | "or";
    columns: { field_id: string; expected_type: string }[];
    filters: {
      field_id: string;
      expected_type: string;
      operator: string;
      value?: string | number | boolean | (string | number | boolean)[] | null;
    }[];
    sort: {
      field_id: string;
      expected_type: string;
      direction: "asc" | "desc";
    }[];
    deleted: "exclude" | "include" | "only";
    search: string | null;
    search_fields: { field_id: string; expected_type: string }[];
  };
  dimension?: { field_id: string; expected_type: string };
  date_field?: { field_id: string; expected_type: string };
  from_date?: string;
  to_date?: string;
  measure?: { field_id: string; expected_type: string };
};

type AggregateResponse = {
  items: AggregateItem[];
  pagination: {
    limit: number;
    offset: number;
    count: number;
    total: number;
    has_more: boolean;
  };
};

function snapshot(items: AggregateItem[]): AggregateResponse {
  return {
    items,
    pagination: {
      limit: Math.max(1, items.length),
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  };
}

function dailyItems(from: string, length: number): AggregateItem[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length }, (_, index) => {
    const key = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    return { key, label: key, value: String(index), record_count: index + 1 };
  });
}

async function installChartsApi(page: Page) {
  let aggregateHandler: () => AggregateResponse | null = () => snapshot([]);
  const requests: AggregateBody[] = [];
  await page.route("**/api/auth/session", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userId,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/views/data-sources**", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/views/data-sources") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            { id: moduleId, name: "Equipment", department_id: departmentId },
          ],
          pagination: {
            limit: 100,
            offset: 0,
            count: 1,
            total: 1,
            has_more: false,
          },
        }),
      });
    }
    if (url.pathname === `/api/views/data-sources/${moduleId}/fields`) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: categoryFieldId,
              module_id: moduleId,
              name: "Category",
              type: "select",
              required: false,
              position: 0,
              config: { options: ["In service", "Inspection due"] },
            },
            {
              id: amountFieldId,
              module_id: moduleId,
              name: "Amount",
              type: "decimal",
              required: false,
              position: 1,
              config: {},
            },
            {
              id: dateFieldId,
              module_id: moduleId,
              name: "Occurred on",
              type: "date",
              required: false,
              position: 2,
              config: {},
            },
            {
              id: integerFieldId,
              module_id: moduleId,
              name: "Unit count",
              type: "int",
              required: false,
              position: 3,
              config: {},
            },
          ],
          pagination: {
            limit: 100,
            offset: 0,
            count: 4,
            total: 4,
            has_more: false,
          },
        }),
      });
    }
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.route(
    "**/api/records/aggregate-snapshot",
    async (route: Route) => {
      const body = route.request().postDataJSON() as AggregateBody;
      requests.push(body);
      const response = aggregateHandler();
      if (response === null) {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "Aggregate snapshot temporarily failed.",
          }),
        });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(response),
      });
    },
  );
  return {
    requests,
    setAggregateHandler(handler: () => AggregateResponse | null) {
      aggregateHandler = handler;
    },
  };
}

async function readDownloadText(download: Download) {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("CSV download stream was unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function expectNoHorizontalOverflow(page: Page, viewportWidth: number) {
  const main = page.getByRole("main");
  await expect
    .poll(
      () =>
        main.evaluate((element) => element.scrollWidth - element.clientWidth),
      { message: `main content fits a ${viewportWidth}px viewport` },
    )
    .toBeLessThanOrEqual(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth), {
      message: `document content fits a ${viewportWidth}px viewport`,
    })
    .toBeLessThanOrEqual(viewportWidth);
}

test("live charts remain usable on mobile in dark mode with reduced motion", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const api = await installChartsApi(page);
  api.setAggregateHandler(() =>
    snapshot([
      {
        key: "in-service",
        label: "In service",
        value: "4.250000000000000001",
        record_count: 3,
      },
      {
        key: "inspection-due",
        label: "Inspection due",
        value: "1.75",
        record_count: 1,
      },
    ]),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.localStorage.setItem("openslate-theme", "dark");
  });
  await page.goto("/openview?section=charts");

  await expect(
    page.getByRole("heading", { name: "Live charts" }),
  ).toBeVisible();
  await page.getByLabel("Chart type").selectOption("pie");
  await page.getByRole("button", { name: "Apply chart" }).click();

  const preview = page.getByRole("img", { name: "Aggregate chart preview" });
  await expect(preview).toBeVisible();
  await expect(preview.locator(".recharts-sector")).toHaveCount(2);
  const table = page.getByRole("table", { name: "Complete aggregate data" });
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.getByRole("cell", { name: "In service" })).toBeVisible();
  await expect(
    table.getByRole("cell", { name: "4.250000000000000001" }),
  ).toBeVisible();

  expect(
    await page.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches,
    })),
  ).toEqual({ dark: true, reducedMotion: true });

  await expectNoHorizontalOverflow(page, 390);

  const mobileValueList = page.getByRole("list", {
    name: "Pie chart categories and values",
  });
  await expect(
    preview.locator(".recharts-pie-label-text").first(),
  ).toBeHidden();
  await expect(preview.locator(".recharts-legend-wrapper")).toBeHidden();
  await expect(mobileValueList).toBeVisible();
  await expect(mobileValueList.getByRole("listitem")).toHaveCount(2);
  await expect(mobileValueList.getByRole("listitem").nth(0)).toContainText(
    "In service",
  );
  await expect(mobileValueList.getByRole("listitem").nth(0)).toContainText(
    "4.250000000000000001",
  );
  await expect(mobileValueList.getByRole("listitem").nth(1)).toContainText(
    "Inspection due",
  );
  await expect(mobileValueList.getByRole("listitem").nth(1)).toContainText(
    "1.75",
  );

  await page.getByRole("button", { name: "Print complete table" }).focus();
  await page.keyboard.press("Shift+Tab");
  const downloadButton = page.getByRole("button", {
    name: "Download complete CSV",
  });
  await expect(downloadButton).toBeFocused();
  expect(
    await downloadButton.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        focusVisible: element.matches(":focus-visible"),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    }),
  ).toEqual({ focusVisible: true, outlineStyle: "solid", outlineWidth: "2px" });

  await page.setViewportSize({ width: 320, height: 844 });
  await expectNoHorizontalOverflow(page, 320);
  await expect(mobileValueList).toBeVisible();
  const tableScrollArea = page
    .locator('[data-slot="table-container"]')
    .filter({ has: table });
  await expect(tableScrollArea).toHaveCount(1);
  await expect
    .poll(() =>
      tableScrollArea.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    )
    .toBeGreaterThan(0);
  await tableScrollArea.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect
    .poll(() => tableScrollArea.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expectNoHorizontalOverflow(page, 1280);
  await expect(
    preview.locator(".recharts-pie-label-text").first(),
  ).toBeVisible();
  await expect(preview.locator(".recharts-legend-wrapper")).toBeVisible();
  await expect(mobileValueList).toBeHidden();

  expect(consoleErrors).toEqual([]);
});

test("mobile pie values keep a long returned decimal readable without page overflow", async ({
  page,
}) => {
  const returnedValue =
    "12345678901234567890123456789012345678901234567890.00000000000000000001";
  const api = await installChartsApi(page);
  api.setAggregateHandler(() =>
    snapshot([
      {
        key: "in-service",
        label: "In service",
        value: returnedValue,
        record_count: 3,
      },
    ]),
  );
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/openview?section=charts");

  await expect(
    page.getByRole("heading", { name: "Live charts" }),
  ).toBeVisible();
  await page.getByLabel("Chart type").selectOption("pie");
  await page.getByRole("button", { name: "Apply chart" }).click();

  const mobileValueList = page.getByRole("list", {
    name: "Pie chart categories and values",
  });
  await expect(mobileValueList).toBeVisible();
  await expect(mobileValueList.getByRole("listitem")).toContainText([
    `In service${returnedValue}`,
  ]);
  await expectNoHorizontalOverflow(page, 320);
});

test("live charts keep Top visual-only while table, CSV, and print retain all groups", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  const items = Array.from({ length: 105 }, (_, index) => ({
    key: `group-${index}`,
    label:
      index === 0
        ? "=SUM(1,1)"
        : `Bucket ${String(index + 1).padStart(3, "0")}`,
    value: index === 0 ? "999999999999999999.99" : String(105 - index),
    record_count: index + 1,
  }));
  api.setAggregateHandler(() => snapshot(items));
  await page.addInitScript(() => {
    window.print = () => {
      Reflect.set(
        window,
        "__printedRows",
        document.querySelectorAll("[data-print-row]").length,
      );
    };
  });
  await page.goto(`/openview?section=charts`);

  await expect(
    page.getByRole("heading", { name: "Live charts" }),
  ).toBeVisible();
  await page.getByLabel("Top groups in chart").selectOption("5");
  await page.getByRole("button", { name: "Apply chart" }).click();

  await expect(
    page.getByText("Showing top 5 of 105 groups in the chart."),
  ).toBeVisible();
  const table = page.getByRole("table", { name: "Complete aggregate data" });
  await expect(table.locator("tbody tr")).toHaveCount(25);
  await expect(page.getByText("1–25 of 105 aggregate groups")).toBeVisible();
  await expect(page.getByTestId("charts-print-row")).toHaveCount(105);
  expect(api.requests).toHaveLength(1);
  expect(api.requests[0]).not.toHaveProperty("top");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download complete CSV" }).click();
  const csv = await readDownloadText(await downloadPromise);
  expect(csv).toContain("'=SUM(1,1)");
  expect(csv).toContain("Bucket 105");
  expect(csv).toContain("999999999999999999.99");
  expect(csv.split("\r\n")).toHaveLength(106);

  await page.getByRole("button", { name: "Print complete table" }).click();
  expect(await page.evaluate(() => Reflect.get(window, "__printedRows"))).toBe(
    105,
  );
});

test("date-line charts require and preserve a complete chronological 366-day snapshot", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  api.setAggregateHandler(() => snapshot(dailyItems("2024-01-01", 366)));
  await page.goto("/openview?section=charts");

  await page.getByLabel("Chart type").selectOption("line");
  await expect(page.getByLabel("Date field")).toBeVisible();
  await expect(page.getByLabel("Top groups in chart")).toHaveCount(0);
  await page.getByLabel("Date field").selectOption(dateFieldId);
  await page.getByLabel("From date").fill("2024-01-01");
  await page.getByLabel("To date").fill("2024-12-31");
  await page.getByRole("button", { name: "Apply chart" }).click();

  await expect(
    page.getByRole("cell", { name: "2024-01-01" }).first(),
  ).toBeVisible();
  expect(api.requests[0]).toMatchObject({
    mode: "date_series",
    from_date: "2024-01-01",
    to_date: "2024-12-31",
    date_field: { field_id: dateFieldId, expected_type: "date" },
  });
  for (let pageNumber = 1; pageNumber < 15; pageNumber += 1) {
    await page.getByRole("button", { name: "Next data table page" }).click();
  }
  await expect(page.getByText("351–366 of 366 daily values")).toBeVisible();
  await expect(page.getByRole("cell", { name: "2024-12-31" })).toBeVisible();
  await expect(page.getByTestId("charts-print-row")).toHaveCount(366);
  await expect(
    page
      .getByRole("img", { name: "Aggregate chart preview" })
      .locator("circle"),
  ).toHaveCount(0);
});

test("categorical filters and numeric aggregation are sent with catalog UUIDs", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  await page.goto("/openview?section=charts");

  await page.getByLabel("Aggregation").selectOption("sum");
  await page.getByLabel("Measure").selectOption(amountFieldId);
  await page.getByRole("button", { name: "Add filter" }).click();
  await expect(page.getByText("Filter 1 field", { exact: true })).toBeVisible();
  await page.getByLabel("Filter 1 field").selectOption(categoryFieldId);
  await page.getByLabel("Filter 1 operator").selectOption("eq");
  await page.getByLabel("Filter 1 value").selectOption("In service");
  await page.getByRole("button", { name: "Apply chart" }).click();

  expect(api.requests).toHaveLength(1);
  expect(api.requests[0]).toMatchObject({
    module_id: moduleId,
    mode: "groups",
    aggregation: "sum",
    dimension: { field_id: categoryFieldId, expected_type: "select" },
    measure: { field_id: amountFieldId, expected_type: "decimal" },
    definition: {
      filters: [
        {
          field_id: categoryFieldId,
          expected_type: "select",
          operator: "eq",
          value: "In service",
        },
      ],
    },
  });
});

test("decimal filters preserve canonical precision in the aggregate request", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  const preciseDecimal = "9007199254740993.123456789012345678";
  await page.goto("/openview?section=charts");

  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByLabel("Filter 1 field").selectOption(amountFieldId);
  await page.getByLabel("Filter 1 operator").selectOption("gt");
  await page.getByLabel("Filter 1 value").fill(preciseDecimal);
  await page.getByRole("button", { name: "Apply chart" }).click();

  expect(api.requests).toHaveLength(1);
  expect(api.requests[0].definition.filters).toEqual([
    {
      field_id: amountFieldId,
      expected_type: "decimal",
      operator: "gt",
      value: preciseDecimal,
    },
  ]);
});

test("integer filters reject fractional values", async ({ page }) => {
  await installChartsApi(page);
  await page.goto("/openview?section=charts");

  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByLabel("Filter 1 field").selectOption(integerFieldId);
  await page.getByLabel("Filter 1 value").fill("4.5");
  await expect(
    page.getByRole("button", { name: "Apply chart" }),
  ).toBeDisabled();
  await page.getByLabel("Filter 1 value").fill("4");
  await expect(page.getByRole("button", { name: "Apply chart" })).toBeEnabled();
});

test("large categorical snapshots cap chart marks without truncating full data", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  const items = Array.from({ length: 10_000 }, (_, index) => ({
    key: `group-${index}`,
    label: `Bucket ${String(index + 1).padStart(5, "0")}`,
    value: String(10_000 - index),
    record_count: 1,
  }));
  api.setAggregateHandler(() => snapshot(items));
  await page.goto("/openview?section=charts");
  await page.getByRole("button", { name: "Apply chart" }).click();

  await expect(
    page.getByText("100 chart points", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Showing top 100 of 10000 groups in chart; complete table/CSV/print retained.",
    ),
  ).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Complete aggregate data" })
      .locator("tbody tr"),
  ).toHaveCount(25);
  await expect(page.getByTestId("charts-print-row")).toHaveCount(10_000);
  expect(api.requests).toHaveLength(1);
});

test("initial query errors show no fabricated data and retain a last-good snapshot on retry errors", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  let attempt = 0;
  api.setAggregateHandler(() => {
    attempt += 1;
    if (attempt === 2) {
      return snapshot([
        {
          key: "last-good",
          label: "Last good group",
          value: "10.500",
          record_count: 2,
        },
      ]);
    }
    return null;
  });
  await page.goto("/openview?section=charts");

  await page.getByRole("button", { name: "Apply chart" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "snapshot" }),
  ).toContainText("snapshot");
  await expect(
    page.getByRole("table", { name: "Complete aggregate data" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("No aggregate snapshot has been applied yet.", {
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Retry chart query" }).click();
  await expect(
    page.getByRole("cell", { name: "Last good group" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Apply chart" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "snapshot" }),
  ).toContainText("snapshot");
  await expect(
    page.getByRole("cell", { name: "Last good group" }),
  ).toBeVisible();
  await expect(
    page.getByText("Showing the last successful snapshot."),
  ).toBeVisible();
});

test("Charts, Dashboards and Reports use live routes", async ({ page }) => {
  const api = await installChartsApi(page);
  const dashboardReads: string[] = [];
  const reportReads: string[] = [];
  await page.route("**/api/reports**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    reportReads.push(pathname);
    if (pathname === "/api/reports" || pathname === "/api/reports/shared-runs")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [],
          pagination: {
            limit: 25,
            offset: 0,
            count: 0,
            total: 0,
            has_more: false,
          },
        }),
      });
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.route("**/api/dashboards**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    dashboardReads.push(pathname);
    if (pathname === "/api/dashboards/default")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ dashboard_id: null }),
      });
    if (pathname === "/api/dashboards")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [],
          pagination: {
            limit: 25,
            offset: 0,
            count: 0,
            total: 0,
            has_more: false,
          },
        }),
      });
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.goto("/openview?section=charts");

  await expect(
    page.getByRole("heading", { name: "Live charts" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Dashboards" }).click();
  await expect(page).toHaveURL(/section=dashboards/);
  await expect(
    page.getByRole("heading", { name: "Private dashboards" }),
  ).toBeVisible();
  await expect(
    page.getByText("No Dashboards yet. Create one to get started."),
  ).toBeVisible();
  await expect.poll(() => dashboardReads).toContain("/api/dashboards");
  await page.getByRole("link", { name: "Reports" }).click();
  await expect(page).toHaveURL(/section=reports/);
  await expect(
    page.getByRole("heading", { name: "Reports", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No saved Reports")).toBeVisible();
  await expect.poll(() => reportReads).toContain("/api/reports");
  await expect.poll(() => reportReads).toContain("/api/reports/shared-runs");
  expect(api.requests).toHaveLength(0);
});

test("live charts reflow at true 200% Chromium tab zoom", async ({
  baseURL,
}) => {
  if (typeof baseURL !== "string") {
    throw new Error("The configured Playwright baseURL is required");
  }

  const userDataDir = await mkdtemp(join(tmpdir(), "openslate-chart-zoom-"));
  const extensionDir = resolve(process.cwd(), "tests/helpers/zoom-extension");
  let context: BrowserContext | undefined;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    });

    const page = context.pages()[0] ?? (await context.newPage());
    const api = await installChartsApi(page);
    api.setAggregateHandler(() =>
      snapshot([
        {
          key: "in-service",
          label: "In service",
          value: "4.250000000000000001",
          record_count: 3,
        },
        {
          key: "inspection-due",
          label: "Inspection due",
          value: "1.75",
          record_count: 1,
        },
      ]),
    );

    await page.goto(new URL("/openview?section=charts", baseURL).toString());
    await expect(
      page.getByRole("heading", { name: "Live charts" }),
    ).toBeVisible();
    await page.getByLabel("Chart type").selectOption("pie");
    await page.getByRole("button", { name: "Apply chart" }).click();

    const preview = page.getByRole("img", {
      name: "Aggregate chart preview",
    });
    await expect(preview.locator(".recharts-sector")).toHaveCount(2);
    const table = page.getByRole("table", { name: "Complete aggregate data" });
    await expect(
      table.getByRole("cell", { name: "4.250000000000000001" }),
    ).toBeVisible();

    const originalLayoutWidth = await page.evaluate(() => window.innerWidth);
    expect(originalLayoutWidth).toBeGreaterThan(1000);

    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const zoomState = await serviceWorker.evaluate(async () => {
      type ZoomExtensionApi = {
        tabs: {
          query(options: {
            active: true;
            lastFocusedWindow: true;
          }): Promise<Array<{ id?: number }>>;
          setZoomSettings(
            tabId: number,
            settings: { mode: "automatic"; scope: "per-tab" },
          ): Promise<void>;
          setZoom(tabId: number, zoomFactor: number): Promise<void>;
          getZoom(tabId: number): Promise<number>;
          getZoomSettings(tabId: number): Promise<{
            mode: string;
            scope: string;
          }>;
        };
      };
      const extension = (
        globalThis as typeof globalThis & { chrome: ZoomExtensionApi }
      ).chrome;
      const [tab] = await extension.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (typeof tab?.id !== "number") {
        throw new Error("The active Chromium tab was unavailable");
      }

      await extension.tabs.setZoomSettings(tab.id, {
        mode: "automatic",
        scope: "per-tab",
      });
      await extension.tabs.setZoom(tab.id, 2);
      return {
        zoom: await extension.tabs.getZoom(tab.id),
        settings: await extension.tabs.getZoomSettings(tab.id),
      };
    });

    expect(zoomState).toEqual({
      zoom: 2,
      settings: expect.objectContaining({
        mode: "automatic",
        scope: "per-tab",
      }),
    });
    await expect
      .poll(() => page.evaluate(() => window.innerWidth))
      .toBeLessThan(originalLayoutWidth * 0.6);

    const zoomedLayoutWidth = await page.evaluate(() => window.innerWidth);
    expect(zoomedLayoutWidth).toBeGreaterThan(320);
    await expectNoHorizontalOverflow(page, zoomedLayoutWidth);
    await expect(preview.locator(".recharts-sector")).toHaveCount(2);
    await expect(table.getByRole("cell", { name: "In service" })).toBeVisible();
    await expect(
      table.getByRole("cell", { name: "4.250000000000000001" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Print complete table" }).focus();
    await page.keyboard.press("Shift+Tab");
    const downloadButton = page.getByRole("button", {
      name: "Download complete CSV",
    });
    await expect(downloadButton).toBeFocused();
    expect(
      await downloadButton.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return {
          focusVisible: element.matches(":focus-visible"),
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
        };
      }),
    ).toEqual({
      focusVisible: true,
      outlineStyle: "solid",
      outlineWidth: "2px",
    });
  } finally {
    try {
      await context?.close();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
});
