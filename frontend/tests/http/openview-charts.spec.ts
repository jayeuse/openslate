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
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";

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

async function installChartsApi(
  page: Page,
  options: { dateOnly?: boolean } = {},
) {
  let aggregateHandler: () => AggregateResponse | null = () => snapshot([]);
  const requests: AggregateBody[] = [];
  const preferenceRequests: Record<string, unknown>[] = [];
  let savedPreference: Record<string, unknown> | null = null;
  let failNextPreferenceWrite = false;
  let nextPreferenceBarrier: {
    wait: Promise<void>;
    signalStarted: () => void;
  } | null = null;
  let denyAggregates = false;
  let nextAggregateBarrier: {
    wait: Promise<void>;
    signalStarted: () => void;
  } | null = null;
  await installOpenViewEventSource(page);
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
  await page.route("**/api/charts/preferences", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ config: savedPreference }),
      });
    }
    const body = route.request().postDataJSON() as {
      config: Record<string, unknown>;
    };
    preferenceRequests.push(body.config);
    if (nextPreferenceBarrier) {
      const barrier = nextPreferenceBarrier;
      nextPreferenceBarrier = null;
      barrier.signalStarted();
      await barrier.wait;
    }
    if (failNextPreferenceWrite) {
      failNextPreferenceWrite = false;
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Settings could not be saved." }),
      });
    }
    savedPreference = body.config;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ config: savedPreference }),
    });
  });
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
          items: options.dateOnly
            ? [
                {
                  id: dateFieldId,
                  module_id: moduleId,
                  name: "Occurred on",
                  type: "date",
                  required: false,
                  position: 0,
                  config: {},
                },
              ]
            : [
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
            count: options.dateOnly ? 1 : 4,
            total: options.dateOnly ? 1 : 4,
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
      const barrier = nextAggregateBarrier;
      if (barrier) {
        nextAggregateBarrier = null;
        barrier.signalStarted();
        await barrier.wait;
      }
      if (denyAggregates) {
        return route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Forbidden" }),
        });
      }
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
    preferenceRequests,
    savedPreference: () => savedPreference,
    failNextPreferenceWrite() {
      failNextPreferenceWrite = true;
    },
    pauseNextPreferenceWrite() {
      let signalStarted: () => void = () => undefined;
      let release: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextPreferenceBarrier = { wait, signalStarted };
      return { started, release };
    },
    denyAggregates() {
      denyAggregates = true;
    },
    triggerInvalidation(entity: string) {
      return sendOpenViewEvent(page, "invalidate", { entity });
    },
    pauseNextAggregate() {
      let signalStarted: () => void = () => undefined;
      let release: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextAggregateBarrier = { wait, signalStarted };
      return { started, release };
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

async function openChartFilters(page: Page) {
  await page.getByRole("button", { name: /^Filters/ }).click();
}

async function openChartDateWindow(page: Page) {
  await page.getByRole("button", { name: "Date window" }).click();
}

async function openChartDisplayOptions(page: Page) {
  await page.getByRole("button", { name: /^Display options/ }).click();
}

async function openChartSettings(page: Page) {
  await page.getByRole("button", { name: "Chart settings" }).click();
}

test("live charts remain usable on mobile in dark mode with reduced motion", async ({
  page,
  browserName,
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

  await expect(page.getByRole("heading", { name: "Charts" })).toBeVisible();
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
  await page.keyboard.press(
    browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab",
  );
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

test("opening chart configuration panels does not load an aggregate until Apply", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  await page.goto("/openview?section=charts");
  await expect(page.getByRole("heading", { name: "Charts" })).toBeVisible();

  await openChartFilters(page);
  await expect(page.getByLabel("Chart filter logic")).toBeVisible();
  await expect.poll(() => api.requests.length).toBe(0);
  await page.keyboard.press("Escape");

  await openChartDateWindow(page);
  await expect(page.getByLabel("Chart date field")).toBeVisible();
  await expect.poll(() => api.requests.length).toBe(0);
  await page.keyboard.press("Escape");

  await openChartDisplayOptions(page);
  await expect(page.getByLabel("Top groups in chart")).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Show values" }),
  ).toBeVisible();
  await expect.poll(() => api.requests.length).toBe(0);
});

test("Apply uses the latest filter draft while the applied snapshot remains visible", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  api.setAggregateHandler(() =>
    snapshot([
      {
        key: "open",
        label: "Open",
        value: "2.500000000000000001",
        record_count: 2,
      },
    ]),
  );
  await page.goto("/openview?section=charts");
  await page.getByRole("button", { name: "Apply chart" }).click();

  const table = page.getByRole("table", { name: "Complete aggregate data" });
  await expect(
    table.getByRole("cell", { name: "2.500000000000000001" }),
  ).toBeVisible();
  const initialRequestCount = api.requests.length;

  await openChartFilters(page);
  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByLabel("Filter 1 field").selectOption(categoryFieldId);
  await page.getByLabel("Filter 1 value").selectOption("In service");
  await expect(page.getByText(/Unapplied chart settings/)).toBeVisible();
  await expect(
    table.getByRole("cell", { name: "2.500000000000000001" }),
  ).toBeVisible();
  await expect.poll(() => api.requests.length).toBe(initialRequestCount);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Apply chart" }).click();
  await expect.poll(() => api.requests.length).toBe(initialRequestCount + 1);
  expect(api.requests.at(-1)).toMatchObject({
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
  await expect(
    table.getByRole("cell", { name: "2.500000000000000001" }),
  ).toBeVisible();
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

  await expect(page.getByRole("heading", { name: "Charts" })).toBeVisible();
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

  await expect(page.getByRole("heading", { name: "Charts" })).toBeVisible();
  await openChartDisplayOptions(page);
  await page.getByLabel("Top groups in chart").selectOption("5");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Apply chart" }).click();

  await expect(
    page.getByText("Showing top 5 of 105 groups in the chart."),
  ).toBeVisible();
  const table = page.getByRole("table", { name: "Complete aggregate data" });
  await expect(table.locator("tbody tr")).toHaveCount(25);
  await expect(page.getByText("Showing 1–25 of 105")).toBeVisible();

  await page.getByRole("button", { name: "Go to next page" }).click();
  await expect(page.getByText("Showing 26–50 of 105")).toBeVisible();
  await page.getByLabel("Rows per page").selectOption("50");
  await expect(table.locator("tbody tr")).toHaveCount(50);
  await expect(page.getByText("Showing 1–50 of 105")).toBeVisible();
  expect(api.requests).toHaveLength(1);

  await expect(page.getByTestId("charts-print-row")).toHaveCount(105);
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
  await expect(page.getByLabel("Group by")).toBeVisible();
  await expect(page.getByLabel("Top groups in chart")).toHaveCount(0);
  await page.getByLabel("Group by").selectOption(dateFieldId);
  await openChartDateWindow(page);
  await page.getByLabel("From date").fill("2024-01-01");
  await page.getByLabel("To date").fill("2024-12-31");
  await page.keyboard.press("Escape");
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
    await page.getByRole("button", { name: "Go to next page" }).click();
  }
  await expect(page.getByText("Showing 351–366 of 366")).toBeVisible();
  await expect(page.getByRole("cell", { name: "2024-12-31" })).toBeVisible();
  await expect(page.getByTestId("charts-print-row")).toHaveCount(366);
  await expect(
    page
      .getByRole("img", { name: "Aggregate chart preview" })
      .locator("circle"),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "Dense line chart labels are hidden; complete values remain in the table and CSV.",
    ),
  ).toBeVisible();
});

test("categorical filters and numeric aggregation are sent with catalog UUIDs", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  await page.goto("/openview?section=charts");

  await page.getByLabel("Measure").selectOption("sum");
  await page.getByLabel("Numeric measure").selectOption(amountFieldId);
  await openChartFilters(page);
  await page.getByRole("button", { name: "Add filter" }).click();
  await expect(page.getByText("Filter 1 field", { exact: true })).toBeVisible();
  await page.getByLabel("Filter 1 field").selectOption(categoryFieldId);
  await page.getByLabel("Filter 1 operator").selectOption("eq");
  await page.getByLabel("Filter 1 value").selectOption("In service");
  await page.keyboard.press("Escape");
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

test("categorical Chart controls save, reload, reset, and reapply complete authorized settings", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  const groups = Array.from({ length: 6 }, (_, index) => ({
    key: `group-${index}`,
    label: `Group ${index + 1}`,
    value: String(10 - index),
    record_count: index + 1,
  }));
  api.setAggregateHandler(() => snapshot(groups));
  await page.goto("/openview?section=charts");

  await page.getByLabel("Chart type").selectOption("bar");
  await openChartFilters(page);
  await page.getByLabel("Chart filter logic").selectOption("or");
  await page.keyboard.press("Escape");

  await openChartDateWindow(page);
  await page.getByLabel("Chart date field").selectOption(dateFieldId);
  await page.getByLabel("Chart from date").fill("2026-09-01");
  await page.getByLabel("Chart to date").fill("2026-09-30");
  await page.keyboard.press("Escape");

  await openChartFilters(page);
  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByLabel("Filter 1 value").selectOption("In service");
  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByLabel("Filter 2 field").selectOption(amountFieldId);
  await page.getByLabel("Filter 2 operator").selectOption("gt");
  await page.getByLabel("Filter 2 value").fill("1");
  await page.keyboard.press("Escape");

  await openChartDisplayOptions(page);
  await page.getByLabel("Top groups in chart").selectOption("5");
  await page.getByRole("checkbox", { name: "Show legend" }).uncheck();
  await page.getByRole("checkbox", { name: "Show values" }).uncheck();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Apply chart" }).click();
  await expect(
    page.getByRole("table", { name: "Complete aggregate data" }),
  ).toBeVisible();
  expect(api.requests.at(-1)).toMatchObject({
    mode: "groups",
    definition: {
      logic: "or",
      filters: [{ value: "In service" }, { operator: "gt" }],
    },
    date_field: { field_id: dateFieldId, expected_type: "date" },
    from_date: "2026-09-01",
    to_date: "2026-09-30",
  });
  expect(api.requests.at(-1)).not.toHaveProperty("top");
  await expect(
    page
      .getByRole("table", { name: "Complete aggregate data" })
      .locator("tbody tr"),
  ).toHaveCount(6);

  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => api.preferenceRequests.length).toBe(1);
  expect(api.savedPreference()).toMatchObject({
    module_id: moduleId,
    chart_type: "bar",
    dimension_id: categoryFieldId,
    date_field_id: dateFieldId,
    filter_logic: "or",
    from_date: "2026-09-01",
    to_date: "2026-09-30",
    top: 5,
    show_legend: false,
    show_values: false,
  });
  await expect(
    page
      .getByRole("img", { name: "Aggregate chart preview" })
      .locator(".recharts-legend-wrapper"),
  ).toHaveCount(0);

  await page.reload();
  await openChartFilters(page);
  await expect(page.getByLabel("Chart filter logic")).toHaveValue("or");
  await expect(page.getByLabel("Filter 1 value")).toHaveValue("In service");
  await expect(page.getByLabel("Filter 2 value")).toHaveValue("1");
  await page.keyboard.press("Escape");

  await openChartDateWindow(page);
  await expect(page.getByLabel("Chart date field")).toHaveValue(dateFieldId);
  await expect(page.getByLabel("Chart from date")).toHaveValue("2026-09-01");
  await page.keyboard.press("Escape");

  await openChartDisplayOptions(page);
  await expect(page.getByLabel("Top groups in chart")).toHaveValue("5");
  await expect(
    page.getByRole("checkbox", { name: "Show legend" }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Show values" }),
  ).not.toBeChecked();

  await page.keyboard.press("Escape");
  await openChartSettings(page);
  await page.getByRole("menuitem", { name: "Reset settings" }).click();
  await expect.poll(() => api.preferenceRequests.length).toBe(2);
  expect(api.savedPreference()).toMatchObject({
    module_id: moduleId,
    chart_type: "bar",
    aggregation: "count",
    filter_logic: "and",
    filters: [],
    from_date: null,
    to_date: null,
    top: null,
    show_legend: true,
    show_values: true,
  });
});

test("Chart invalidations refresh the applied snapshot, preserve edits, and clear data on policy denial", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  api.setAggregateHandler(() =>
    snapshot([{ key: "open", label: "Open", value: "2", record_count: 2 }]),
  );
  await page.goto("/openview?section=charts");
  await page.getByRole("button", { name: "Apply chart" }).click();
  const initialRequestCount = api.requests.length;
  await page.getByLabel("Chart type").selectOption("pie");
  await api.triggerInvalidation("records");
  await expect.poll(() => api.requests.length).toBe(initialRequestCount + 1);
  await expect(page.getByLabel("Chart type")).toHaveValue("pie");
  await expect(
    page.getByRole("table", { name: "Complete aggregate data" }),
  ).toBeVisible();

  api.denyAggregates();
  await api.triggerInvalidation("records");
  await expect(
    page.getByRole("table", { name: "Complete aggregate data" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Chart type")).toHaveValue("pie");
  await expect(
    page.getByRole("alert").filter({ hasText: /access|permission|sign in/i }),
  ).toContainText(/access|permission|sign in/i);
});

test("repeated Chart Reset restores edited controls and a failed Reset keeps edits", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  await page.goto("/openview?section=charts");
  const reset = page.getByRole("menuitem", { name: "Reset settings" });

  await openChartSettings(page);
  await reset.click();
  await expect.poll(() => api.preferenceRequests.length).toBe(1);
  await openChartDisplayOptions(page);
  const top = page.getByLabel("Top groups in chart");
  const showValues = page.getByRole("checkbox", { name: "Show values" });
  await top.selectOption("5");
  await showValues.uncheck();
  await page.keyboard.press("Escape");
  await openChartSettings(page);
  await reset.click();
  await expect.poll(() => api.preferenceRequests.length).toBe(2);
  await openChartDisplayOptions(page);
  await expect(top).toHaveValue("");
  await expect(showValues).toBeChecked();
  await expect(page.getByRole("status")).toContainText(
    "Chart settings reset for this account.",
  );

  await top.selectOption("10");
  await showValues.uncheck();
  await page.keyboard.press("Escape");
  api.failNextPreferenceWrite();
  await openChartSettings(page);
  await reset.click();
  await expect.poll(() => api.preferenceRequests.length).toBe(3);
  await openChartDisplayOptions(page);
  await expect(top).toHaveValue("10");
  await expect(showValues).not.toBeChecked();
  await expect(
    page.getByRole("alert").filter({ hasText: "Settings could not be saved." }),
  ).toBeVisible();
});

test("saving Chart settings keeps a newer edit made while the request is pending", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  await page.goto("/openview?section=charts");
  await openChartDisplayOptions(page);
  const top = page.getByLabel("Top groups in chart");
  await top.selectOption("5");
  await page.keyboard.press("Escape");
  const pending = api.pauseNextPreferenceWrite();
  await page.getByRole("button", { name: "Save settings" }).click();
  await pending.started;
  await openChartDisplayOptions(page);
  await top.selectOption("10");
  await page.keyboard.press("Escape");
  pending.release();

  await expect(page.getByRole("status")).toContainText(
    "Chart settings saved for this account.",
  );
  await expect.poll(() => api.savedPreference()?.top).toBe(5);
  await openChartDisplayOptions(page);
  await expect(top).toHaveValue("10");
});

test("Show values renders all selected Top 50 groups, including groups beyond 20", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  api.setAggregateHandler(() =>
    snapshot(
      Array.from({ length: 30 }, (_, index) => ({
        key: `group-${index}`,
        label: `Group ${index + 1}`,
        value: String(index + 1),
        record_count: index + 1,
      })),
    ),
  );
  await page.goto("/openview?section=charts");
  await openChartDisplayOptions(page);
  await page.getByLabel("Top groups in chart").selectOption("50");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Apply chart" }).click();

  const preview = page.getByRole("img", { name: "Aggregate chart preview" });
  await expect(preview.locator(".recharts-label")).toHaveCount(30);
  await openChartDisplayOptions(page);
  await page.getByRole("checkbox", { name: "Show values" }).uncheck();
  await expect(preview.locator(".recharts-label")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Show values" }).check();
  await expect(preview.locator(".recharts-label")).toHaveCount(30);
});

test("date-only line Chart settings can be reset to a valid saved preference", async ({
  page,
}) => {
  const api = await installChartsApi(page, { dateOnly: true });
  await page.goto("/openview?section=charts");
  await page.getByLabel("Chart type").selectOption("line");
  await openChartDateWindow(page);
  await page.getByLabel("From date").fill("2026-09-01");
  await page.getByLabel("To date").fill("2026-09-30");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => api.preferenceRequests.length).toBe(1);

  await openChartSettings(page);
  await page.getByRole("menuitem", { name: "Reset settings" }).click();
  await expect.poll(() => api.preferenceRequests.length).toBe(2);
  expect(api.savedPreference()).toMatchObject({
    module_id: moduleId,
    chart_type: "line",
    dimension_id: null,
    date_field_id: dateFieldId,
    aggregation: "count",
    filter_logic: "and",
    filters: [],
    top: null,
    show_legend: true,
    show_values: true,
  });
  const reset = api.savedPreference()!;
  expect(Date.parse(String(reset.from_date))).not.toBeNaN();
  expect(Date.parse(String(reset.to_date))).not.toBeNaN();
  expect(Date.parse(String(reset.to_date))).toBeGreaterThanOrEqual(
    Date.parse(String(reset.from_date)),
  );
  await page.reload();
  await expect(page.getByLabel("Chart type")).toHaveValue("line");
  await expect(page.getByRole("button", { name: "Apply chart" })).toBeEnabled();
});

test("Chart invalidations are consumed once and a second event during refresh is not lost", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  api.setAggregateHandler(() =>
    snapshot([{ key: "open", label: "Open", value: "2", record_count: 2 }]),
  );
  await page.goto("/openview?section=charts");
  await page.getByRole("button", { name: "Apply chart" }).click();
  await expect(
    page.getByRole("table", { name: "Complete aggregate data" }),
  ).toBeVisible();

  const barrier = api.pauseNextAggregate();
  await api.triggerInvalidation("records");
  await barrier.started;
  await api.triggerInvalidation("records");
  barrier.release();
  await expect.poll(() => api.requests.length).toBe(3);
  await expect(page.getByRole("button", { name: "Apply chart" })).toBeEnabled();
  expect(api.requests).toHaveLength(3);
});

test("decimal filters preserve canonical precision in the aggregate request", async ({
  page,
}) => {
  const api = await installChartsApi(page);
  const preciseDecimal = "9007199254740993.123456789012345678";
  await page.goto("/openview?section=charts");

  await openChartFilters(page);
  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByLabel("Filter 1 field").selectOption(amountFieldId);
  await page.getByLabel("Filter 1 operator").selectOption("gt");
  await page.getByLabel("Filter 1 value").fill(preciseDecimal);
  await page.keyboard.press("Escape");
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

  await openChartFilters(page);
  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByLabel("Filter 1 field").selectOption(integerFieldId);
  await page.getByLabel("Filter 1 value").fill("4.5");
  await expect(
    page.getByRole("button", { name: "Apply chart" }),
  ).toBeDisabled();
  await page.getByLabel("Filter 1 value").fill("4");
  await page.keyboard.press("Escape");
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

  await expect(page.getByRole("heading", { name: "Charts" })).toBeVisible();
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
    await expect(page.getByRole("heading", { name: "Charts" })).toBeVisible();
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
