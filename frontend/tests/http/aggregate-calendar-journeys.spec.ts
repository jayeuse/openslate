import { expect, signedInSession, test, type Page } from "./helpers/test";
import { installOpenViewEventSource } from "./helpers/openview-event-source";
import { boardId, installBoardApi } from "./helpers/boards-api";
import { pageOf } from "../helpers/pagination";
import { wireBucket } from "../helpers/wire";

const moduleId = "00000000-0000-4000-8000-000000000701";
const departmentId = "00000000-0000-4000-8000-000000000702";
const categoryId = "00000000-0000-4000-8000-000000000703";
const amountId = "00000000-0000-4000-8000-000000000704";
const dateId = "00000000-0000-4000-8000-000000000705";
const dashboardId = "00000000-0000-4000-8000-000000000706";
const timestamp = "2026-10-01T00:00:00Z";
const wireDefinition = {
  version: 1,
  columns: [],
  filters: [],
  sort: [],
  logic: "and",
  deleted: "exclude",
  search: null,
  search_fields: [],
};

function collection<T>(items: T[], limit = 100) {
  return pageOf(items, { limit });
}
function snapshot(keys: string[], values: (string | number | null)[]) {
  return collection(
    keys.map((key, index) =>
      wireBucket({
        key,
        value: values[index],
        record_count: values[index] === null ? 0 : 1,
      }),
    ),
    keys.length,
  );
}

async function catalog(page: Page) {
  await installOpenViewEventSource(page);
  await signedInSession(page, departmentId);
  await page.route("**/api/views/data-sources**", (route) => {
    const fields = [
      { id: categoryId, name: "Category", type: "text" },
      { id: amountId, name: "Amount", type: "decimal" },
      { id: dateId, name: "Date", type: "date" },
    ].map((field, position) => ({
      ...field,
      module_id: moduleId,
      position,
      required: false,
      config: {},
    }));
    return route.fulfill({
      json: collection<unknown>(
        new URL(route.request().url()).pathname.endsWith("/fields")
          ? fields
          : [
              {
                id: moduleId,
                name: "Metric source",
                department_id: departmentId,
                title_field_id: null,
              },
            ],
      ),
    });
  });
}

test("Charts expose numeric extrema and primitive Distinct while missing values stay absent from bar, pie and print", async ({
  page,
}) => {
  await catalog(page);
  const submitted: Record<string, unknown>[] = [];
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    submitted.push(body);
    const result =
      body.aggregation === "distinct"
        ? snapshot(["Measured"], [2])
        : snapshot(["Measured", "Missing"], ["1.2345678901234567", null]);
    if (body.aggregation === "distinct") result.items[0].record_count = 2;
    else result.items[1].record_count = 1;
    return route.fulfill({
      json: result,
    });
  });
  await page.goto("/openview?section=charts&module=" + moduleId);
  const aggregation = page.getByLabel("Measure", { exact: true });
  await expect(
    aggregation.getByRole("option", { name: "Distinct", exact: true }),
  ).toBeAttached();
  await aggregation.selectOption("distinct");
  await page
    .getByLabel("Measure field", { exact: true })
    .selectOption(categoryId);
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  const table = page.getByRole("table", {
    name: "Complete aggregate data",
    exact: true,
  });
  await expect(
    table.getByRole("row", { name: "Measured 2 2", exact: true }),
  ).toBeVisible();
  expect(submitted[0]).toMatchObject({
    aggregation: "distinct",
    measure: { field_id: categoryId, expected_type: "text" },
  });
  for (const metric of ["min", "max"]) {
    await aggregation.selectOption(metric);
    await page
      .getByLabel("Numeric measure", { exact: true })
      .selectOption(amountId);
    await page
      .getByRole("button", { name: "Apply chart", exact: true })
      .click();
    await expect(
      table.getByRole("row", { name: "Missing — 1", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".recharts-bar-rectangle")).toHaveCount(1);
  }
  await page.getByLabel("Chart type", { exact: true }).selectOption("pie");
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(page.locator(".recharts-pie-sector")).toHaveCount(1);
  await expect(
    page.getByRole("alert").filter({ hasText: "numeric range" }),
  ).toHaveCount(0);
  await page.emulateMedia({ media: "print" });
  await expect(
    page
      .getByRole("table", { name: "Printable complete aggregate data" })
      .getByRole("row", { name: "Missing — 1", exact: true }),
  ).toBeVisible();
  await page.emulateMedia({ media: "screen" });
});

test("Charts keep missing daily averages as line gaps and exact table values", async ({
  page,
}) => {
  await catalog(page);
  await page.route("**/api/records/aggregate-snapshot", (route) =>
    route.fulfill({
      json: snapshot(
        ["2026-10-01", "2026-10-02", "2026-10-03"],
        ["1.25", null, "3.75"],
      ),
    }),
  );
  await page.goto("/openview?section=charts&module=" + moduleId);
  await page.getByLabel("Chart type", { exact: true }).selectOption("line");
  await page.getByLabel("Measure", { exact: true }).selectOption("average");
  await page
    .getByLabel("Numeric measure", { exact: true })
    .selectOption(amountId);
  await page.getByRole("button", { name: "Date window", exact: true }).click();
  await page.getByLabel("From date", { exact: true }).fill("2026-10-01");
  await page.getByLabel("To date", { exact: true }).fill("2026-10-03");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(
    page
      .getByRole("table", { name: "Complete aggregate data", exact: true })
      .getByRole("row", { name: "2026-10-02 — 0", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".recharts-line-dot")).toHaveCount(2);
  // Geometry is the contract: the missing date keeps its x-position and splits the line.
  await expect
    .poll(
      async () =>
        (await page.locator(".recharts-line-curve").getAttribute("d"))?.match(
          /M/g,
        )?.length,
    )
    .toBe(2);
  await expect(
    page.getByRole("alert").filter({ hasText: "numeric range" }),
  ).toHaveCount(0);
});

async function storedCalendar(page: Page, bucket: "month" | "week") {
  await catalog(page);
  await page.route("**/api/departments**", (route) =>
    route.fulfill({
      json: collection([
        {
          id: departmentId,
          department_name: "Metric department",
          created_at: timestamp,
          updated_at: timestamp,
          deleted_at: null,
          is_deleted: false,
          performed_by: null,
        },
      ]),
    }),
  );
  const query = {
    mode: "date_series",
    module_id: moduleId,
    definition: wireDefinition,
    aggregation: "average",
    measure: { field_id: amountId, expected_type: "decimal" },
    date_field: { field_id: dateId, expected_type: "date" },
    from_date: bucket === "month" ? "2026-09-15" : "2026-10-07",
    to_date: bucket === "month" ? "2026-12-10" : "2026-10-13",
    bucket,
  };
  const saved = {
    id: dashboardId,
    department_id: departmentId,
    name: "Calendar metrics",
    position: 0,
    refresh_cadence: "manual",
    revision: 1,
    is_deleted: false,
    created_at: timestamp,
    updated_at: timestamp,
    widgets: [
      {
        id: categoryId,
        widget_type: "chart",
        position: 0,
        size: "M",
        chart_id: null,
        created_at: timestamp,
        updated_at: timestamp,
        config: { version: 1, chart_type: "line", query },
      },
    ],
  };
  await page.route("**/api/dashboards**", (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).pathname === "/api/dashboards"
          ? collection([saved], 25)
          : saved,
    }),
  );
  return query;
}

test("saved monthly Dashboard reloads containing calendar starts and preserves null without changing singular selected-widget reads", async ({
  page,
}) => {
  const query = await storedCalendar(page, "month");
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/records/aggregate-snapshots", (route) => {
    const body = route.request().postDataJSON() as {
      queries: Record<string, unknown>[];
    };
    requests.push(...body.queries);
    return route.fulfill({
      json: {
        items: body.queries.map(() =>
          snapshot(
            ["2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"],
            ["2.5", "4.25", null, "9.25"],
          ),
        ),
      },
    });
  });
  await page.goto("/openview?section=dashboards&dashboard=" + dashboardId);
  const table = page.getByRole("table").filter({ hasText: "2026-11-01" });
  await expect(
    table.getByRole("row", { name: "2026-11-01 — 0", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Showing all 4 months in chronological order.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    bucket: "month",
    from_date: query.from_date,
    to_date: query.to_date,
  });
  await page.reload();
  await expect(
    table.getByRole("row", { name: "2026-12-01 9.25 1", exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(2);
});

test("saved weekly Dashboard uses Sunday workspace starts and hides retained data when that calendar read is refused", async ({
  page,
}) => {
  await storedCalendar(page, "week");
  let refused = false;
  let requests = 0;
  await page.route("**/api/workspace", (route) =>
    route.fulfill(
      refused
        ? { status: 403, json: { detail: "Forbidden" } }
        : {
            json: {
              display_name: "OpenSlate",
              mark: "OS",
              logo_file_id: null,
              revision: 1,
              week_start: "sunday",
              timezone: "Asia/Manila",
              locale: "en-PH",
              today: "2026-10-09",
            },
          },
    ),
  );
  await page.route("**/api/records/aggregate-snapshots", (route) => {
    const body = route.request().postDataJSON() as { queries: unknown[] };
    requests += 1;
    return route.fulfill({
      json: {
        items: body.queries.map(() =>
          snapshot(["2026-10-04", "2026-10-11"], ["2.5", null]),
        ),
      },
    });
  });
  await page.goto("/openview?section=dashboards&dashboard=" + dashboardId);
  await expect(
    page
      .getByRole("table")
      .getByRole("row", { name: "2026-10-11 — 0", exact: true }),
  ).toBeVisible();
  refused = true;
  await page.getByRole("button", { name: "Refresh now", exact: true }).click();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  expect(requests).toBe(1);
});

test("Board overview keeps null date positions as separate SVG segments with exact missing labels", async ({
  page,
}) => {
  const keyWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("same key")) keyWarnings.push(message.text());
  });
  await installBoardApi(page, () => true);
  await catalog(page);
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        display_name: "OpenSlate",
        mark: "OS",
        logo_file_id: null,
        revision: 1,
        week_start: "monday",
        timezone: "Asia/Manila",
        locale: "en-PH",
        today: "2026-10-30",
      },
    }),
  );
  await page.route("**/api/boards/" + boardId + "/widgets**", (route) =>
    route.fulfill({
      json: {
        ...collection(
          [
            {
              id: categoryId,
              board_id: boardId,
              name: "Nullable trend",
              widget_type: "chart",
              module_id: moduleId,
              position: 0,
              size: "M",
              pinned: false,
              chart_id: null,
              created_at: timestamp,
              updated_at: timestamp,
              config: {
                version: 1,
                fields: [{ field_id: dateId, expected_type: "date" }],
                filters: [],
                logic: "and",
                metric: null,
                visualization: "line",
                refresh: "manual",
              },
            },
          ],
          12,
        ),
        board_revision: 1,
      },
    }),
  );
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    const keys = Array.from(
      { length: 30 },
      (_, index) => "2026-10-" + String(index + 1).padStart(2, "0"),
    );
    return route.fulfill({
      json: snapshot(
        keys,
        keys.map((_, index) => (index === 14 ? null : index + 1)),
      ),
    });
  });
  await page.goto("/boards?board=" + boardId + "&section=overview");
  const card = page
    .getByRole("heading", { name: "Nullable trend", exact: true })
    .locator("..")
    .locator("..");
  // The exact-values row shows the missing day; an axis tick may show its date
  // too, depending on the width the chart has for tick labels.
  await expect(card.getByText("2026-10-15—", { exact: true })).toBeVisible();
  // The shared renderer draws one path that restarts after the missing day.
  await expect
    .poll(
      async () =>
        (
          (await card.locator(".recharts-line-curve").getAttribute("d")) ?? ""
        ).split("M").length - 1,
    )
    .toBe(2);
  await expect(card.locator(".recharts-line-dot")).toHaveCount(29);
  await expect(
    card.getByText("Values too large to chart. Exact values remain below.", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(keyWarnings).toEqual([]);
});
