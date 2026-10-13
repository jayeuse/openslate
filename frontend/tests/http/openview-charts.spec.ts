import { readFile } from "node:fs/promises";
import Papa from "papaparse";
import { expect, signedInSession, test, type Page } from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { pageOf, wirePagination } from "../helpers/pagination";
import { gate } from "./helpers/gate";

const moduleId = "00000000-0000-4000-8000-000000000110";
const departmentId = "00000000-0000-4000-8000-000000000111";
const selectFieldId = "00000000-0000-4000-8000-000000000112";
const userFieldId = "00000000-0000-4000-8000-000000000113";
const choiceId = "00000000-0000-4000-8000-000000000114";
const eligibleUserId = "00000000-0000-4000-8000-000000000115";
const userId = "00000000-0000-4000-8000-000000000101";

test("Charts filter on stable choice and eligible person IDs", async ({
  page,
}) => {
  const requestPaths: Array<{ path: string; method: string }> = [];
  let assignableUserRequests = 0;
  let aggregateBody: Record<string, unknown> | null = null;
  let aggregateRequests = 0;
  let groupLabel = "Alex Reader";
  page.on("request", (request) => {
    const url = new URL(request.url());
    requestPaths.push({ path: url.pathname, method: request.method() });
    if (
      url.pathname === `/api/modules/${moduleId}/assignable-users` &&
      request.method() === "GET"
    )
      assignableUserRequests += 1;
  });
  await installOpenViewEventSource(page);
  await signedInSession(page, userId);
  await page.route("**/api/views/data-sources**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/views/data-sources") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageOf(
            [
              {
                id: moduleId,
                name: "Service requests",
                department_id: departmentId,
                title_field_id: null,
              },
            ],
            { limit: 100 },
          ),
        ),
      });
    }
    if (pathname === `/api/views/data-sources/${moduleId}/fields`) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageOf(
            [
              {
                id: selectFieldId,
                module_id: moduleId,
                name: "Status",
                type: "select",
                required: false,
                position: 0,
                config: {
                  options: [{ id: choiceId, label: "Awaiting review" }],
                },
              },
              {
                id: userFieldId,
                module_id: moduleId,
                name: "Assignee",
                type: "user",
                required: false,
                position: 1,
                config: { kind: "user" },
              },
            ],
            { limit: 100 },
          ),
        ),
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.route(`**/api/modules/${moduleId}/assignable-users**`, (route) =>
    route.fulfill({
      headers: { "cache-control": "private, no-store" },
      contentType: "application/json",
      body: JSON.stringify(
        pageOf(
          [
            {
              id: eligibleUserId,
              display_name: "Alex Reader",
              username: "alex.reader",
            },
          ],
          { limit: 100 },
        ),
      ),
    }),
  );
  await page.route("**/api/records/aggregate-snapshot", async (route) => {
    aggregateRequests += 1;
    aggregateBody = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            key: eligibleUserId,
            label: groupLabel,
            value: 1,
            record_count: 1,
          },
        ],
        pagination: wirePagination({ limit: 1, count: 1, total: 1 }),
      }),
    });
  });

  await page.goto("/openview?section=charts&module=" + moduleId);
  await page.getByRole("button", { name: "Filters (0)" }).click();
  await page.getByLabel("Group by").selectOption(userFieldId);
  await page.getByRole("button", { name: "Add filter" }).click();
  await page
    .getByLabel("Filter 1 field", { exact: true })
    .selectOption(selectFieldId);
  const selectValue = page.getByLabel("Filter 1 value", { exact: true });
  await expect(
    selectValue.getByRole("option", { name: "Awaiting review" }),
  ).toBeAttached();
  await selectValue.selectOption(choiceId);

  await page.getByRole("button", { name: "Add filter" }).click();
  await page
    .getByLabel("Filter 2 field", { exact: true })
    .selectOption(userFieldId);
  await expect(
    page
      .getByLabel("Filter 2 operator", { exact: true })
      .getByRole("option", { name: "Is one of", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => assignableUserRequests).toBeGreaterThan(0);
  const personValue = page.getByLabel("Filter 2 value", { exact: true });
  await expect(
    personValue.getByRole("option", { name: "Alex Reader" }),
  ).toBeAttached();
  await expect(page.getByText(eligibleUserId, { exact: true })).toHaveCount(0);
  await personValue.selectOption(eligibleUserId);

  const aggregateRequest = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/records/aggregate-snapshot" &&
      request.method() === "POST",
  );
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await aggregateRequest;
  const capturedAggregateBody = (): Record<string, unknown> | null =>
    aggregateBody;
  await expect.poll(capturedAggregateBody).not.toBeNull();
  const submittedBody = capturedAggregateBody();
  if (!submittedBody) throw new Error("The chart query was not captured");
  const filters = (
    submittedBody.definition as {
      filters: Array<Record<string, unknown>>;
    }
  ).filters;
  expect(filters).toContainEqual({
    field_id: selectFieldId,
    expected_type: "select",
    operator: "eq",
    value: choiceId,
  });
  expect(filters).toContainEqual({
    field_id: userFieldId,
    expected_type: "user",
    operator: "eq",
    value: eligibleUserId,
  });
  expect(
    requestPaths.filter(
      ({ path, method }) =>
        /^\/api\/users(?:\/|$)/.test(path) &&
        !(path === `/api/users/${userId}/preferences` && method === "GET"),
    ),
  ).toEqual([]);
  const resultTable = page.getByRole("table", {
    name: "Complete aggregate data",
  });
  await expect(
    resultTable.getByRole("row").filter({ hasText: "Alex Reader" }),
  ).toBeVisible();

  const requestsBeforeRename = aggregateRequests;
  groupLabel = "Alex Reader updated";
  await sendOpenViewEvent(page, "invalidate", {
    entity: "users",
    module_id: moduleId,
  });
  await expect
    .poll(() => aggregateRequests)
    .toBeGreaterThan(requestsBeforeRename);
  await expect(
    resultTable.getByRole("row").filter({ hasText: "Alex Reader updated" }),
  ).toBeVisible();
  await expect(
    resultTable.getByRole("cell", { name: "Alex Reader", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Filters (2)" }).click();
});

const amountId = "00000000-0000-4000-8000-000000000116";
const dateId = "00000000-0000-4000-8000-000000000117";
const booleanId = "00000000-0000-4000-8000-000000000118";
const integerId = "00000000-0000-4000-8000-000000000119";
const savedChartId = "00000000-0000-4000-8000-000000000120";
const definition = {
  version: 1,
  columns: [],
  filters: [],
  sort: [],
  logic: "and",
  deleted: "exclude",
  search: null,
  search_fields: [],
};
const editorFields = [
  {
    id: selectFieldId,
    name: "Status",
    type: "select",
    config: { options: [{ id: choiceId, label: "Awaiting review" }] },
  },
  { id: userFieldId, name: "Assignee", type: "user", config: { kind: "user" } },
  { id: amountId, name: "Amount", type: "decimal", config: {} },
  { id: dateId, name: "Submitted", type: "date", config: {} },
  { id: booleanId, name: "Reviewed", type: "boolean", config: {} },
  { id: integerId, name: "Units", type: "int", config: {} },
];

async function editorCatalog(page: Page) {
  await installOpenViewEventSource(page);
  await signedInSession(page, userId);
  await page.route("**/api/views/data-sources**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json: pageOf<unknown>(
        path.endsWith("/fields")
          ? editorFields.map((field, position) => ({
              ...field,
              module_id: moduleId,
              required: false,
              position,
            }))
          : [
              {
                id: moduleId,
                name: "Service requests",
                department_id: departmentId,
                title_field_id: null,
              },
            ],
        { limit: 100 },
      ),
    });
  });
  await page.route(`**/api/modules/${moduleId}`, (route) =>
    route.fulfill({
      json: {
        id: moduleId,
        department_id: departmentId,
        module_name: "Service requests",
        title_field_id: null,
        is_deleted: false,
      },
    }),
  );
  await page.route("**/api/fields/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const field = editorFields.find((field) => field.id === id);
    return field
      ? route.fulfill({
          json: {
            ...field,
            module_id: moduleId,
            required: false,
            position: editorFields.indexOf(field),
            is_deleted: false,
          },
        })
      : route.fallback();
  });
}

function calendarSnapshot(keys: string[]) {
  return {
    items: keys.map((key) => ({ key, label: key, value: 1, record_count: 1 })),
    pagination: wirePagination({
      limit: keys.length,
      count: keys.length,
      total: keys.length,
    }),
  };
}

test("Top choices change only the preview and retain the complete wire query, table, CSV and print", async ({
  page,
}) => {
  await editorCatalog(page);
  const bodies: unknown[] = [];
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    bodies.push(route.request().postDataJSON());
    const items = Array.from({ length: 55 }, (_, index) => ({
      key: `group-${index + 1}`,
      label: `Group ${index + 1}`,
      value: 55 - index,
      record_count: 55 - index,
    }));
    return route.fulfill({
      json: {
        items,
        pagination: wirePagination({ limit: 55, count: 55, total: 55 }),
      },
    });
  });
  await page.goto("/openview?section=charts");
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  const table = page.getByRole("table", {
    name: "Complete aggregate data",
    exact: true,
  });
  await expect(
    table.getByRole("row", { name: "Group 1 55 55", exact: true }),
  ).toBeVisible();
  for (const top of ["5", "10", "20", "50"]) {
    await page.getByRole("button", { name: /Display options/ }).click();
    await page
      .getByLabel("Top groups in chart", { exact: true })
      .selectOption(top);
    await page.keyboard.press("Escape");
    await expect(
      page.getByText(`Showing top ${top} of 55 groups in the chart.`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(`${top} chart points · 55 total aggregate groups.`, {
        exact: false,
      }),
    ).toBeVisible();
  }
  expect(bodies).toEqual([
    {
      mode: "groups",
      module_id: moduleId,
      definition,
      aggregation: "count",
      dimension: { field_id: selectFieldId, expected_type: "select" },
    },
  ]);
  await page.getByLabel("Rows per page", { exact: true }).selectOption("50");
  await expect(table.getByRole("row")).toHaveCount(51);
  await page
    .getByRole("button", { name: "Go to next page", exact: true })
    .click();
  await expect(
    table.getByRole("row", { name: "Group 55 1 1", exact: true }),
  ).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Download complete CSV", exact: true })
      .click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error("No complete CSV download");
  const rows = Papa.parse<string[]>(await readFile(path, "utf8")).data;
  expect(rows).toHaveLength(56);
  expect(rows[0]).toEqual(["Group", "Value", "Record count"]);
  expect(rows[55]).toEqual(["Group 55", "1", "1"]);
  await page.emulateMedia({ media: "print" });
  const print = page.getByRole("table", {
    name: "Printable complete aggregate data",
    exact: true,
  });
  await expect(print.getByRole("row")).toHaveCount(56);
  await expect(
    print.getByRole("row", { name: "Group 55 1 1", exact: true }),
  ).toBeVisible();
  expect(bodies).toHaveLength(1);
});

test("six metrics retain typed user and boolean dimensions and count omits measure", async ({
  page,
}) => {
  await editorCatalog(page);
  const bodies: unknown[] = [];
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: calendarSnapshot(["Measured"]) });
  });
  await page.goto("/openview?section=charts");
  for (const metric of ["sum", "average", "min", "max", "distinct", "count"]) {
    await page.getByLabel("Measure", { exact: true }).selectOption(metric);
    await page
      .getByLabel("Group by", { exact: true })
      .selectOption(metric === "distinct" ? userFieldId : booleanId);
    if (metric !== "count")
      await page
        .getByLabel(
          metric === "distinct" ? "Measure field" : "Numeric measure",
          { exact: true },
        )
        .selectOption(metric === "distinct" ? selectFieldId : amountId);
    await page
      .getByRole("button", { name: "Apply chart", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Apply chart", exact: true }),
    ).toBeEnabled();
    expect(bodies.at(-1)).toEqual({
      mode: "groups",
      module_id: moduleId,
      definition,
      aggregation: metric,
      dimension: {
        field_id: metric === "distinct" ? userFieldId : booleanId,
        expected_type: metric === "distinct" ? "user" : "boolean",
      },
      ...(metric === "count"
        ? {}
        : {
            measure: {
              field_id: metric === "distinct" ? selectFieldId : amountId,
              expected_type: metric === "distinct" ? "select" : "decimal",
            },
          }),
    });
  }
  expect(bodies).toHaveLength(6);
});

test("five calendar buckets and period wording follow the last applied query while the draft is dirty", async ({
  page,
}) => {
  await editorCatalog(page);
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
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
    }),
  );
  const bodies: Record<string, unknown>[] = [];
  const cases = [
    {
      bucket: "day",
      period: "daily",
      unit: "day",
      keys: [
        "2026-10-07",
        "2026-10-08",
        "2026-10-09",
        "2026-10-10",
        "2026-10-11",
        "2026-10-12",
        "2026-10-13",
      ],
    },
    { bucket: "month", period: "monthly", unit: "month", keys: ["2026-10-01"] },
    {
      bucket: "week",
      period: "weekly",
      unit: "week",
      keys: ["2026-10-04", "2026-10-11"],
    },
    {
      bucket: "quarter",
      period: "quarterly",
      unit: "quarter",
      keys: ["2026-10-01"],
    },
    { bucket: "year", period: "yearly", unit: "year", keys: ["2026-01-01"] },
  ];
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    const current = cases.find((item) => item.bucket === body.bucket);
    if (!current) throw new Error("Unexpected calendar bucket");
    return route.fulfill({ json: calendarSnapshot(current.keys) });
  });
  await page.goto("/openview?section=charts");
  await page.getByLabel("Chart type", { exact: true }).selectOption("line");
  await page.getByRole("button", { name: "Date window", exact: true }).click();
  await page.getByLabel("From date", { exact: true }).fill("2026-10-07");
  await page.getByLabel("To date", { exact: true }).fill("2026-10-13");
  await page.keyboard.press("Escape");
  const bucket = page.getByLabel("Calendar bucket", { exact: true });
  await expect(bucket).toHaveValue("day");
  let previous: (typeof cases)[number] | null = null;
  for (const current of cases) {
    await bucket.selectOption(current.bucket);
    if (previous) {
      await expect(
        page.getByRole("note").filter({ hasText: "Unapplied chart settings" }),
      ).toBeVisible();
      await expect(
        page.getByText(
          `${previous.keys.length} chart points · ${previous.keys.length} total ${previous.period} values.`,
          { exact: false },
        ),
      ).toBeVisible();
      await page.emulateMedia({ media: "print" });
      await expect(
        page.getByText(
          `Complete aggregate snapshot: ${previous.keys.length} ${previous.period} values.`,
          { exact: true },
        ),
      ).toBeVisible();
      await page.emulateMedia({ media: "screen" });
      expect(bodies).toHaveLength(cases.indexOf(current));
    }
    await page
      .getByRole("button", { name: "Apply chart", exact: true })
      .click();
    await expect(
      page.getByText(
        `${current.keys.length} chart points · ${current.keys.length} total ${current.period} values.`,
        { exact: false },
      ),
    ).toBeVisible();
    await page.getByText("How to read this chart", { exact: true }).click();
    await expect(
      page.getByText(
        `Each point represents the selected measure for one ${current.unit} in the applied date window.`,
        { exact: false },
      ),
    ).toBeVisible();
    await page.getByText("How to read this chart", { exact: true }).click();
    expect(bodies.at(-1)).toEqual({
      mode: "date_series",
      module_id: moduleId,
      definition,
      aggregation: "count",
      date_field: { field_id: dateId, expected_type: "date" },
      from_date: "2026-10-07",
      to_date: "2026-10-13",
      bucket: current.bucket,
    });
    previous = current;
  }
  expect(bodies).toHaveLength(5);
});

// The bucket window rule (month and year series, more than 366 buckets,
// reversed or missing ends) and its saved-Chart admission are owned by
// isolated/openview/aggregate-buckets.spec.ts; this journey keeps one example.
test("a month series refuses more than 366 buckets and accepts a calendar window longer than 366 days", async ({
  page,
}) => {
  const keys = [
    "2025-12-01",
    "2026-01-01",
    "2026-02-01",
    "2026-03-01",
    "2026-04-01",
    "2026-05-01",
    "2026-06-01",
    "2026-07-01",
    "2026-08-01",
    "2026-09-01",
    "2026-10-01",
    "2026-11-01",
    "2026-12-01",
    "2027-01-01",
  ];
  await editorCatalog(page);
  const bodies: unknown[] = [];
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: calendarSnapshot(keys) });
  });
  await page.goto("/openview?section=charts");
  const apply = page.getByRole("button", { name: "Apply chart", exact: true });
  await page.getByLabel("Chart type", { exact: true }).selectOption("line");
  await page
    .getByLabel("Calendar bucket", { exact: true })
    .selectOption("month");
  await page.getByRole("button", { name: "Date window", exact: true }).click();
  await page.getByLabel("From date", { exact: true }).fill("1980-01-01");
  await page.getByLabel("To date", { exact: true }).fill("2010-07-01");
  await expect(apply).toBeDisabled();
  await expect(
    page.getByText(/Choose a range of 1–366 calendar buckets/).first(),
  ).toBeVisible();
  await page.getByLabel("From date", { exact: true }).fill("2025-12-15");
  await page.getByLabel("To date", { exact: true }).fill("2027-01-04");
  await page.keyboard.press("Escape");
  await apply.click();
  await expect(
    page
      .getByRole("table", { name: "Complete aggregate data", exact: true })
      .getByRole("row"),
  ).toHaveCount(keys.length + 1);
  expect(bodies).toEqual([
    {
      mode: "date_series",
      module_id: moduleId,
      definition,
      aggregation: "count",
      date_field: { field_id: dateId, expected_type: "date" },
      from_date: "2025-12-15",
      to_date: "2027-01-04",
      bucket: "month",
    },
  ]);
});

test("incomplete, reversed and over-limit grouped windows send nothing and keep the 366-day boundary", async ({
  page,
}) => {
  await editorCatalog(page);
  const bodies: unknown[] = [];
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: calendarSnapshot(["Measured"]) });
  });
  await page.goto("/openview?section=charts");
  const apply = page.getByRole("button", { name: "Apply chart", exact: true });
  await page.getByRole("button", { name: "Date window", exact: true }).click();
  await page
    .getByLabel("Chart date field", { exact: true })
    .selectOption(dateId);
  await expect(apply).toBeDisabled();
  await page.getByLabel("Chart from date", { exact: true }).fill("2024-01-01");
  await expect(apply).toBeDisabled();
  await page.getByLabel("Chart to date", { exact: true }).fill("2023-12-31");
  await expect(apply).toBeDisabled();
  await page.getByLabel("Chart to date", { exact: true }).fill("2025-01-01");
  await expect(apply).toBeDisabled();
  expect(bodies).toEqual([]);
  await page.getByLabel("Chart to date", { exact: true }).fill("2024-12-31");
  await page.keyboard.press("Escape");
  await apply.click();
  await expect(
    page.getByRole("table", { name: "Complete aggregate data", exact: true }),
  ).toBeVisible();
  expect(bodies).toEqual([
    {
      mode: "groups",
      module_id: moduleId,
      definition,
      aggregation: "count",
      dimension: { field_id: selectFieldId, expected_type: "select" },
      date_field: { field_id: dateId, expected_type: "date" },
      from_date: "2024-01-01",
      to_date: "2024-12-31",
    },
  ]);
});

test("incomplete numeric inputs and surviving filter rows stay controlled through metadata refresh", async ({
  page,
}) => {
  await editorCatalog(page);
  let fieldReads = 0;
  await page.route(
    `**/api/views/data-sources/${moduleId}/fields?*`,
    (route) => {
      fieldReads += 1;
      return route.fulfill({
        json: pageOf(
          editorFields.map((field, position) => ({
            ...field,
            module_id: moduleId,
            required: false,
            position,
          })),
          { limit: 100 },
        ),
      });
    },
  );
  const bodies: unknown[] = [];
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: calendarSnapshot(["Measured"]) });
  });
  await page.goto("/openview?section=charts");
  await page.getByRole("button", { name: "Filters (0)", exact: true }).click();
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  await page
    .getByLabel("Filter 1 field", { exact: true })
    .selectOption(amountId);
  await page.getByLabel("Filter 1 value", { exact: true }).fill("-");
  await expect(
    page.getByRole("button", { name: "Apply chart", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  await page
    .getByLabel("Filter 2 field", { exact: true })
    .selectOption(amountId);
  await page.getByLabel("Filter 2 value", { exact: true }).fill("1.2300");
  await sendOpenViewEvent(page, "invalidate", {
    entity: "fields",
    module_id: moduleId,
  });
  await expect.poll(() => fieldReads).toBeGreaterThan(1);
  await expect(page.getByLabel("Filter 1 value", { exact: true })).toHaveValue(
    "-",
  );
  await expect(page.getByLabel("Filter 2 value", { exact: true })).toHaveValue(
    "1.2300",
  );
  await page
    .getByRole("button", { name: "Remove filter 1", exact: true })
    .click();
  await expect(page.getByLabel("Filter 1 value", { exact: true })).toHaveValue(
    "1.2300",
  );
  await page.keyboard.press("Escape");
  expect(bodies).toEqual([]);
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Complete aggregate data", exact: true }),
  ).toBeVisible();
  expect(bodies).toEqual([
    {
      mode: "groups",
      module_id: moduleId,
      definition: {
        ...definition,
        filters: [
          {
            field_id: amountId,
            expected_type: "decimal",
            operator: "eq",
            value: "1.23",
          },
        ],
      },
      aggregation: "count",
      dimension: { field_id: selectFieldId, expected_type: "select" },
    },
  ]);
});

test("changed field metadata cannot silently substitute a different dimension", async ({
  page,
}) => {
  await editorCatalog(page);
  let changed = false;
  let fieldReads = 0;
  await page.route(
    `**/api/views/data-sources/${moduleId}/fields?*`,
    (route) => {
      fieldReads += 1;
      return route.fulfill({
        json: pageOf(
          editorFields.map((field, position) => ({
            ...field,
            type: changed && field.id === booleanId ? "int" : field.type,
            module_id: moduleId,
            required: false,
            position,
          })),
          { limit: 100 },
        ),
      });
    },
  );
  const bodies: unknown[] = [];
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: calendarSnapshot(["Measured"]) });
  });
  await page.goto("/openview?section=charts");
  await page.getByLabel("Group by", { exact: true }).selectOption(booleanId);
  changed = true;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "fields",
    module_id: moduleId,
  });
  await expect.poll(() => fieldReads).toBeGreaterThan(1);
  await expect(page.getByLabel("Group by", { exact: true })).toHaveValue(
    booleanId,
  );
  await expect(
    page.getByRole("button", { name: "Apply chart", exact: true }),
  ).toBeDisabled();
  expect(bodies).toEqual([]);
  await page
    .getByLabel("Group by", { exact: true })
    .selectOption(selectFieldId);
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Complete aggregate data", exact: true }),
  ).toBeVisible();
  expect(bodies).toEqual([
    {
      mode: "groups",
      module_id: moduleId,
      definition,
      aggregation: "count",
      dimension: { field_id: selectFieldId, expected_type: "select" },
    },
  ]);
});

function pickerChart(id = savedChartId, name = "Weekly intake") {
  return {
    id,
    name,
    department_id: departmentId,
    module_id: moduleId,
    chart_type: "bar",
    query: {
      mode: "groups",
      module_id: moduleId,
      definition,
      aggregation: "count",
      measure: null,
      dimension: { field_id: booleanId, expected_type: "boolean" },
    },
    revision: 1,
    is_deleted: false,
    created_at: "2026-10-09T00:00:00Z",
    updated_at: "2026-10-09T00:00:00Z",
  };
}

test("saved picker searches and loads later pages without replacing an off-page selection or inline draft", async ({
  page,
}) => {
  await editorCatalog(page);
  const lists: string[] = [];
  let detailReads = 0;
  await page.route("**/api/charts?*", (route) => {
    const url = new URL(route.request().url());
    lists.push(url.search);
    const offset = Number(url.searchParams.get("offset"));
    const searching = url.searchParams.get("search") === "Elsewhere";
    const items = searching
      ? []
      : offset
        ? [pickerChart()]
        : [pickerChart(userId, "First Chart")];
    return route.fulfill({
      json: {
        items,
        pagination: {
          limit: 25,
          offset,
          count: items.length,
          total: searching ? 0 : 2,
          has_more: !searching && offset === 0,
        },
      },
    });
  });
  await page.route(`**/api/charts/${savedChartId}`, (route) => {
    detailReads += 1;
    return route.fulfill({ json: pickerChart() });
  });
  const bodies: unknown[] = [];
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      json: calendarSnapshot(["Private selected value"]),
    });
  });
  await page.goto("/openview?section=charts");
  await page.getByLabel("Measure", { exact: true }).selectOption("min");
  await page
    .getByLabel("Numeric measure", { exact: true })
    .selectOption(amountId);
  await page.getByLabel("Chart source", { exact: true }).selectOption("saved");
  await page
    .getByRole("combobox", { name: "Saved Chart", exact: true })
    .click();
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await page
    .getByRole("option", { name: "Weekly intake", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply chart", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("combobox", { name: "Saved Chart", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("combobox").fill("Elsewhere");
  await expect
    .poll(() => lists.some((query) => query.includes("search=Elsewhere")))
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("Search…", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("combobox", { name: "Saved Chart", exact: true }),
  ).toContainText("Weekly intake");
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Complete aggregate data", exact: true }),
  ).toContainText("Private selected value");
  expect(bodies).toEqual([
    {
      mode: "groups",
      module_id: moduleId,
      definition,
      aggregation: "count",
      dimension: { field_id: booleanId, expected_type: "boolean" },
    },
  ]);
  expect(detailReads).toBeGreaterThanOrEqual(2);
  expect(lists.some((query) => query.includes("offset=1"))).toBe(true);
  await page.getByLabel("Chart source", { exact: true }).selectOption("inline");
  await expect(page.getByLabel("Measure", { exact: true })).toHaveValue("min");
  await expect(page.getByLabel("Numeric measure", { exact: true })).toHaveValue(
    amountId,
  );
});

test("saved picker refuses current source without using cached metadata or downstream data", async ({
  page,
}) => {
  await editorCatalog(page);
  let denied = false;
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({
      json: {
        ...pageOf([pickerChart()], { limit: 100 }),
        pagination: wirePagination({ limit: 25, count: 1, total: 1 }),
      },
    }),
  );
  await page.route(`**/api/charts/${savedChartId}`, (route) =>
    denied
      ? route.fulfill({ status: 404, json: { detail: "Private source error" } })
      : route.fulfill({ json: pickerChart() }),
  );
  const bodies: unknown[] = [];
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      json: calendarSnapshot(["Private selected value"]),
    });
  });
  await page.goto("/openview?section=charts");
  await page.getByLabel("Chart source", { exact: true }).selectOption("saved");
  await page
    .getByRole("combobox", { name: "Saved Chart", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Weekly intake", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(
    page.getByText("Private selected value", { exact: true }).first(),
  ).toBeVisible();
  denied = true;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "charts",
    module_id: moduleId,
  });
  await expect(
    page.getByText("Private selected value", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Private source error", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry saved Chart", exact: true }),
  ).toBeVisible();
  expect(bodies).toHaveLength(1);
});

test("saved picker list refusal withdraws cached names and applied data", async ({
  page,
}) => {
  await editorCatalog(page);
  let denied = false;
  await page.route("**/api/charts?*", (route) =>
    denied
      ? route.fulfill({ status: 403, json: { detail: "Private list error" } })
      : route.fulfill({
          json: {
            items: [pickerChart()],
            pagination: wirePagination({ limit: 25, count: 1, total: 1 }),
          },
        }),
  );
  await page.route(`**/api/charts/${savedChartId}`, (route) =>
    route.fulfill({ json: pickerChart() }),
  );
  await page.route("**/api/records/aggregate-snapshot", (route) =>
    route.fulfill({ json: calendarSnapshot(["Private applied value"]) }),
  );
  await page.goto("/openview?section=charts");
  await page.getByLabel("Chart source", { exact: true }).selectOption("saved");
  await page
    .getByRole("combobox", { name: "Saved Chart", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Weekly intake", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(
    page.getByText("Private applied value", { exact: true }).first(),
  ).toBeVisible();
  denied = true;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "charts",
    module_id: moduleId,
  });
  await expect(
    page.getByText("Private applied value", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Weekly intake", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Private list error", { exact: true }),
  ).toHaveCount(0);
});

test("saved picker manual source refusal hides selected metadata until an explicit retry", async ({
  page,
}) => {
  await editorCatalog(page);
  let refused = false;
  let reads = 0;
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({
      json: {
        items: [pickerChart()],
        pagination: wirePagination({ limit: 25, count: 1, total: 1 }),
      },
    }),
  );
  await page.route(`**/api/charts/${savedChartId}`, (route) => {
    reads += 1;
    return refused
      ? route.fulfill({
          status: 404,
          json: { detail: "Private source refusal" },
        })
      : route.fulfill({ json: pickerChart() });
  });
  let resultReads = 0;
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    resultReads += 1;
    return route.fulfill({
      json: calendarSnapshot(["Private applied result"]),
    });
  });
  await page.goto("/openview?section=charts");
  await page.getByLabel("Chart source", { exact: true }).selectOption("saved");
  await page
    .getByRole("combobox", { name: "Saved Chart", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Weekly intake", exact: true })
    .click();
  await expect.poll(() => reads).toBe(1);
  refused = true;
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  await expect(page.getByText("Weekly intake", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Private source refusal", { exact: true }),
  ).toHaveCount(0);
  expect(resultReads).toBe(0);
  refused = false;
  await page
    .getByRole("button", { name: "Retry saved Chart", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(
    page.getByText("Private applied result", { exact: true }).first(),
  ).toBeVisible();
  expect(resultReads).toBe(1);
});

test("a transient saved Chart list failure keeps the applied Chart and offers a list retry", async ({
  page,
}) => {
  await editorCatalog(page);
  let listFails = false;
  await page.route("**/api/charts?*", (route) =>
    listFails
      ? route.fulfill({ status: 503, json: { detail: "Unavailable" } })
      : route.fulfill({ json: pageOf([pickerChart()], { limit: 25 }) }),
  );
  await page.route(`**/api/charts/${savedChartId}`, (route) =>
    route.fulfill({ json: pickerChart() }),
  );
  await page.route("**/api/records/aggregate-snapshot", (route) =>
    route.fulfill({ json: calendarSnapshot(["Private applied result"]) }),
  );
  await page.goto("/openview?section=charts");
  await page.getByLabel("Chart source", { exact: true }).selectOption("saved");
  const picker = page.getByRole("combobox", {
    name: "Saved Chart",
    exact: true,
  });
  await picker.click();
  await page
    .getByRole("option", { name: "Weekly intake", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  const applied = page
    .getByText("Private applied result", { exact: true })
    .first();
  await expect(applied).toBeVisible();
  listFails = true;
  await picker.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  // The open picker focuses its search input.
  const failedSearch = page.waitForResponse(
    (response) =>
      response.url().includes("/api/charts?") &&
      response.url().includes("search=week") &&
      response.status() === 503,
  );
  await page.keyboard.type("week");
  await failedSearch;
  await expect(
    page.getByText("Saved Charts are unavailable. Retry the list.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(applied).toBeVisible();
  await expect(picker).toContainText("Weekly intake");
});

test("a refused saved Chart keeps the other Charts available as replacements", async ({
  page,
}) => {
  await editorCatalog(page);
  const replacementId = "00000000-0000-4000-8000-000000000121";
  let refused = false;
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({
      json: pageOf(
        [pickerChart(), pickerChart(replacementId, "Monthly intake")],
        { limit: 25 },
      ),
    }),
  );
  await page.route(`**/api/charts/${savedChartId}`, (route) =>
    refused
      ? route.fulfill({
          status: 404,
          json: { detail: "Private source refusal" },
        })
      : route.fulfill({ json: pickerChart() }),
  );
  await page.route(`**/api/charts/${replacementId}`, (route) =>
    route.fulfill({ json: pickerChart(replacementId, "Monthly intake") }),
  );
  await page.route("**/api/records/aggregate-snapshot", (route) =>
    route.fulfill({ json: calendarSnapshot(["Replacement result"]) }),
  );
  await page.goto("/openview?section=charts");
  await page.getByLabel("Chart source", { exact: true }).selectOption("saved");
  const picker = page.getByRole("combobox", {
    name: "Saved Chart",
    exact: true,
  });
  await picker.click();
  await page
    .getByRole("option", { name: "Weekly intake", exact: true })
    .click();
  refused = true;
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(page.getByText("Weekly intake", { exact: true })).toHaveCount(0);
  await picker.click();
  await expect(
    page.getByRole("option", { name: "Weekly intake", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("option", { name: "Monthly intake", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(
    page.getByText("Replacement result", { exact: true }).first(),
  ).toBeVisible();
});

for (const priorApply of [false, true]) {
  test(`picker refusal fences a held ${priorApply ? "different Chart" : "first Chart"} Apply without a transient private commit`, async ({
    page,
  }) => {
    await editorCatalog(page);
    let refused = false;
    let refusalReads = 0;
    await page.route("**/api/charts?*", (route) =>
      route.fulfill({
        json: {
          items: [pickerChart(userId, "Earlier Chart"), pickerChart()],
          pagination: wirePagination({ limit: 25, count: 2, total: 2 }),
        },
      }),
    );
    await page.route("**/api/charts/*", (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
      if (id === savedChartId && refused) {
        refusalReads += 1;
        return route.fulfill({
          status: 403,
          json: { detail: "Private detail refusal" },
        });
      }
      return route.fulfill({
        json: pickerChart(
          id,
          id === userId ? "Earlier Chart" : "Weekly intake",
        ),
      });
    });
    let hold = true;
    const aggregate = gate();
    const bodies: unknown[] = [];
    await page.route("**/api/records/aggregate-snapshot", async (route) => {
      bodies.push(route.request().postDataJSON());
      if (priorApply && bodies.length === 1)
        return route.fulfill({
          json: calendarSnapshot(["Earlier authorised result"]),
        });
      if (hold) {
        aggregate.signalStarted();
        await aggregate.wait;
        return route.fulfill({
          json: calendarSnapshot(["Private late aggregate"]),
        });
      }
      return route.fulfill({
        json: calendarSnapshot(["Fresh recovery result"]),
      });
    });
    await page.goto("/openview?section=charts");
    await page.getByLabel("Measure", { exact: true }).selectOption("min");
    await page
      .getByLabel("Numeric measure", { exact: true })
      .selectOption(amountId);
    await page
      .getByLabel("Chart source", { exact: true })
      .selectOption("saved");
    if (priorApply) {
      await page
        .getByRole("combobox", { name: "Saved Chart", exact: true })
        .click();
      await page
        .getByRole("option", { name: "Earlier Chart", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Apply chart", exact: true })
        .click();
      await expect(
        page.getByRole("table", {
          name: "Complete aggregate data",
          exact: true,
        }),
      ).toContainText("Earlier authorised result");
    }
    await page
      .getByRole("combobox", { name: "Saved Chart", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Weekly intake", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Apply chart", exact: true })
      .click();
    try {
      await aggregate.started;
      refused = true;
      await sendOpenViewEvent(page, "invalidate", {
        entity: "charts",
        module_id: moduleId,
      });
      await expect.poll(() => refusalReads).toBeGreaterThan(0);
      await expect(
        page.getByRole("button", { name: "Retry saved Chart", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Weekly intake", { exact: true }),
      ).toHaveCount(0);
      await page.evaluate(() => {
        document.documentElement.dataset.s27PrivateCommit = "false";
        new MutationObserver((changes) => {
          if (
            changes.some((change) =>
              [...change.addedNodes, change.target].some((node) =>
                node.textContent?.includes("Private late aggregate"),
              ),
            )
          )
            document.documentElement.dataset.s27PrivateCommit = "true";
        }).observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      });
      const late = page.waitForResponse("**/api/records/aggregate-snapshot");
      aggregate.release();
      await (await late).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(
        page.getByText("Private late aggregate", { exact: true }),
      ).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute(
        "data-s27-private-commit",
        "false",
      );
      await expect(
        page.getByRole("button", { name: "Apply chart", exact: true }),
      ).toBeDisabled();
      refused = false;
      hold = false;
      await page
        .getByRole("button", { name: "Retry saved Chart", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Apply chart", exact: true })
        .click();
      await expect(
        page.getByRole("table", {
          name: "Complete aggregate data",
          exact: true,
        }),
      ).toContainText("Fresh recovery result");
      await expect(page.locator("html")).toHaveAttribute(
        "data-s27-private-commit",
        "false",
      );
      expect(bodies).toHaveLength(priorApply ? 3 : 2);
      await page
        .getByLabel("Chart source", { exact: true })
        .selectOption("inline");
      await expect(page.getByLabel("Measure", { exact: true })).toHaveValue(
        "min",
      );
      await expect(
        page.getByLabel("Numeric measure", { exact: true }),
      ).toHaveValue(amountId);
    } finally {
      aggregate.release();
    }
  });
}

test("saved Chart result metadata belongs to its resolved module without replacing the inline draft", async ({
  page,
}) => {
  await editorCatalog(page);
  const resolvedModule = "00000000-0000-4000-8000-000000000131";
  const resolvedDimension = "00000000-0000-4000-8000-000000000132";
  const resolvedMeasure = "00000000-0000-4000-8000-000000000133";
  const query = {
    mode: "groups",
    module_id: resolvedModule,
    definition,
    aggregation: "sum",
    dimension: { field_id: resolvedDimension, expected_type: "text" },
    measure: { field_id: resolvedMeasure, expected_type: "decimal" },
  };
  const chart = { ...pickerChart(), module_id: resolvedModule, query };
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({
      json: {
        items: [chart],
        pagination: wirePagination({ limit: 25, count: 1, total: 1 }),
      },
    }),
  );
  await page.route(`**/api/charts/${savedChartId}`, (route) =>
    route.fulfill({ json: chart }),
  );
  const metadataReads: string[] = [];
  await page.route(`**/api/modules/${resolvedModule}`, (route) => {
    metadataReads.push("source");
    return route.fulfill({
      json: {
        id: resolvedModule,
        department_id: departmentId,
        module_name: "Resolved revenue source",
        title_field_id: null,
        is_deleted: false,
      },
    });
  });
  let metadataRefused = false;
  let metadataDenials = 0;
  for (const field of [
    { id: resolvedDimension, name: "Revenue segment", type: "text" },
    { id: resolvedMeasure, name: "Net revenue", type: "decimal" },
  ])
    await page.route(`**/api/fields/${field.id}`, (route) => {
      metadataReads.push(field.id);
      if (metadataRefused) {
        metadataDenials += 1;
        return route.fulfill({
          status: 403,
          json: { detail: "Private field detail" },
        });
      }
      return route.fulfill({
        json: {
          ...field,
          module_id: resolvedModule,
          required: false,
          position: 0,
          config: {},
          is_deleted: false,
        },
      });
    });
  const bodies: unknown[] = [];
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        items: [
          {
            key: "segment",
            label: "Enterprise",
            value: "12.500",
            record_count: 91,
          },
          { key: "empty", label: "Unpriced", value: null, record_count: 1 },
        ],
        pagination: wirePagination({ limit: 2, count: 2, total: 2 }),
      },
    });
  });
  await page.goto("/openview?section=charts");
  await page.getByLabel("Measure", { exact: true }).selectOption("min");
  await page
    .getByLabel("Numeric measure", { exact: true })
    .selectOption(amountId);
  await page.getByLabel("Chart source", { exact: true }).selectOption("saved");
  await page
    .getByRole("combobox", { name: "Saved Chart", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Weekly intake", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(
    page.getByText(
      "Resolved revenue source · Sum net revenue by Revenue segment",
      { exact: true },
    ),
  ).toBeVisible();
  const table = page.getByRole("table", {
    name: "Complete aggregate data",
    exact: true,
  });
  await expect(
    table.getByRole("columnheader", { name: "Net revenue", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("row", { name: "Enterprise 12.500 91", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("row", { name: "Unpriced — 1", exact: true }),
  ).toBeVisible();
  expect(bodies).toEqual([query]);
  expect(metadataReads.sort()).toEqual(
    ["source", resolvedDimension, resolvedMeasure].sort(),
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Download complete CSV", exact: true })
      .click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error("No complete CSV download");
  expect(Papa.parse<string[]>(await readFile(path, "utf8")).data).toEqual([
    ["Group", "Value", "Record count"],
    ["Enterprise", "12.500", "91"],
    ["Unpriced", "", "1"],
  ]);
  await page.emulateMedia({ media: "print" });
  await expect(
    page.getByRole("heading", {
      name: "Resolved revenue source — Revenue segment chart data",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("table", {
        name: "Printable complete aggregate data",
        exact: true,
      })
      .getByRole("columnheader", { name: "Net revenue", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Service requests.*chart data/ }),
  ).toHaveCount(0);
  await page.emulateMedia({ media: "screen" });
  metadataRefused = true;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "records",
    module_id: resolvedModule,
  });
  await expect.poll(() => metadataDenials).toBeGreaterThan(0);
  await expect(
    page.getByText(
      "Resolved revenue source · Sum net revenue by Revenue segment",
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(
    page.getByText("Private field detail", { exact: true }),
  ).toHaveCount(0);
  expect(bodies).toHaveLength(1);
  metadataRefused = false;
  // Detail Retry cannot clear the records-read latch: recover the refused
  // catalog explicitly, then check the retained Chart source afresh.
  await page
    .getByRole("combobox", { name: "Saved Chart", exact: true })
    .click();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("combobox", { name: "Search saved chart", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Retry saved Chart", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Saved Chart", exact: true }),
  ).toContainText("Weekly intake");
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(table).toContainText("Net revenue");
  await page.getByLabel("Chart source", { exact: true }).selectOption("inline");
  await expect(page.getByLabel("Data source", { exact: true })).toHaveValue(
    moduleId,
  );
  await expect(page.getByLabel("Measure", { exact: true })).toHaveValue("min");
  await expect(page.getByLabel("Numeric measure", { exact: true })).toHaveValue(
    amountId,
  );
});
