import {
  expect,
  signedInAs,
  test,
  type Locator,
  type Page,
  type Route,
} from "./helpers/test";
import { readFile } from "node:fs/promises";
import { profilePreferences } from "./helpers/profile-api";
import { pageOf, wirePagination } from "../helpers/pagination";
import { gate } from "./helpers/gate";
import { wireField } from "../helpers/wire";

const userId = "00000000-0000-4000-8000-000000000101";
const ownerId = "00000000-0000-4000-8000-000000000102";
const duplicateReportId = "00000000-0000-4000-8000-000000000109";
const moduleId = "00000000-0000-4000-8000-000000000103";
const fieldId = "00000000-0000-4000-8000-000000000104";
const reportId = "00000000-0000-4000-8000-000000000105";
const runId = "00000000-0000-4000-8000-000000000106";
const scheduleId = "00000000-0000-4000-8000-000000000107";
const timestamp = "2026-09-24T00:00:00Z";
// A second department whose only module the member can read, not manage.
const readOnlyDepartmentId = "00000000-0000-4000-8000-000000000110";
const readOnlyModuleId = "00000000-0000-4000-8000-000000000111";
const readOnlyReportId = "00000000-0000-4000-8000-000000000112";

const report = {
  id: reportId,
  module_id: moduleId,
  name: "Operations review",
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
type ReportFixture = Omit<typeof report, "subtitle"> & {
  subtitle: string | null;
};
const run = {
  id: runId,
  report_id: reportId,
  recipe_revision: 1,
  row_count: 1,
  headings: ["Asset"],
  created_at: timestamp,
};
const newRunId = "00000000-0000-4000-8000-000000000900";
const readOnlyReport = {
  ...report,
  id: readOnlyReportId,
  module_id: readOnlyModuleId,
  name: "Invoice review",
};

async function installReportsApi(
  page: Page,
  sharedOnly = false,
  initialReport: ReportFixture = report,
  options: {
    ownerRunCount?: number;
    sharedRunCount?: number;
    failOwnedSecondPage?: boolean;
    failSharedSecondPage?: boolean;
    distinctNewRun?: boolean;
    failFirstHistoryAfterRun?: boolean;
    /** The user's level on the Report department; the default manages it. */
    level?: "read" | "manage";
    savedSchedule?: boolean;
    lastRun?: {
      state: "pending" | "running" | "succeeded" | "failed" | "canceled";
      finished_at: string | null;
      failure_label: string | null;
    } | null;
    /** The account role; the default is a member. */
    role?: "admin" | "member";
    /** Add a module (and a Report on it) that the member can only read. */
    readOnlySource?: boolean;
  } = {},
) {
  let currentReport = initialReport;
  let copiedReport: Record<string, unknown> | null = null;
  let manualRuns = 0;
  let scheduleWrites = 0;
  let csvReads = 0;
  let reportCreates = 0;
  let reportUpdates = 0;
  const ownedRunPageRequests: Array<{ limit: number; offset: number }> = [];
  const sharedRunPageRequests: Array<{ limit: number; offset: number }> = [];
  let failOwnedSecondPage = options.failOwnedSecondPage ?? false;
  let failSharedSecondPage = options.failSharedSecondPage ?? false;
  let failFirstHistoryAfterRun = options.failFirstHistoryAfterRun ?? false;
  const newRun = {
    ...run,
    id: newRunId,
    recipe_revision: 99,
    created_at: "2026-09-26T00:00:00Z",
  };
  const createdReports: Array<{ request: unknown; response: unknown }> = [];
  const sharedRunCount = options.sharedRunCount ?? (sharedOnly ? 26 : 0);
  const sharedRuns = Array.from({ length: sharedRunCount }, (_, index) => ({
    ...run,
    id:
      index === 0
        ? run.id
        : `00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
    recipe_revision: index + 1,
    row_count: index + 1,
    created_at: index === 0 ? timestamp : "2026-09-25T00:00:00Z",
    report_name: "Shared operations review",
    status: "succeeded",
  }));
  await signedInAs(page, {
    id: userId,
    role: options.role ?? "member",
    access: [
      {
        department_id: ownerId,
        module_id: null,
        level: options.level ?? "manage",
      },
      ...(options.readOnlySource
        ? [
            {
              department_id: readOnlyDepartmentId,
              module_id: readOnlyModuleId,
              level: "read" as const,
            },
          ]
        : []),
    ],
  });
  await page.route("**/api/departments**", (route) =>
    route.fulfill({
      json: pageOf(
        [
          {
            id: ownerId,
            department_name: "Field operations",
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
          ...(options.readOnlySource
            ? [
                {
                  id: readOnlyDepartmentId,
                  department_name: "Finance",
                  created_at: timestamp,
                  updated_at: timestamp,
                  deleted_at: null,
                  is_deleted: false,
                  performed_by: null,
                },
              ]
            : []),
        ],
        { limit: 100 },
      ),
    }),
  );
  await page.route("**/api/views/data-sources**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/views/data-sources")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageOf(
            [
              {
                id: moduleId,
                name: "Assets",
                department_id: ownerId,
                title_field_id: null,
              },
              ...(options.readOnlySource
                ? [
                    {
                      id: readOnlyModuleId,
                      name: "Invoices",
                      department_id: readOnlyDepartmentId,
                      title_field_id: null,
                    },
                  ]
                : []),
            ],
            { limit: 100 },
          ),
        ),
      });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        pageOf(
          [
            wireField({
              id: fieldId,
              // Answer for the requested module: /api/views/data-sources/<id>/fields.
              module_id: path.split("/")[4],
              name: "Asset",
              type: "text",
              required: true,
              position: 0,
            }),
          ],
          { limit: 100 },
        ),
      ),
    });
  });
  await page.route("**/api/reports**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/reports" && method === "POST") {
      reportCreates += 1;
      const body = request.postDataJSON() as Record<string, unknown>;
      const created = {
        ...initialReport,
        id: duplicateReportId,
        module_id: body.module_id,
        name: body.name,
        subtitle: body.subtitle,
        recipe: body.recipe,
        revision: 1,
        is_deleted: false,
      };
      createdReports.push({ request: body, response: created });
      copiedReport = created;
      return route.fulfill({
        status: 201,
        headers: { Location: `/api/reports/${duplicateReportId}` },
        contentType: "application/json",
        body: JSON.stringify(created),
      });
    }
    if (path === `/api/reports/${reportId}` && method === "GET")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(currentReport),
      });
    if (path === `/api/reports/${readOnlyReportId}` && method === "GET")
      return route.fulfill({ json: readOnlyReport });
    if (
      path === `/api/reports/${duplicateReportId}` &&
      method === "GET" &&
      copiedReport
    )
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(copiedReport),
      });
    if (path === `/api/reports/${reportId}` && method === "PATCH") {
      reportUpdates += 1;
      const body = request.postDataJSON() as Record<string, unknown>;
      currentReport = {
        ...currentReport,
        module_id: body.module_id as string,
        name: body.name as string,
        subtitle: body.subtitle as string | null,
        recipe: body.recipe as typeof currentReport.recipe,
        revision: currentReport.revision + 1,
      };
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(currentReport),
      });
    }
    if (path === "/api/reports/shared-runs") {
      const url = new URL(request.url());
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      sharedRunPageRequests.push({ limit, offset });
      if (offset === 25 && failSharedSecondPage) {
        failSharedSecondPage = false;
        return route.fulfill({ status: 503, body: "{}" });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageOf(sharedRuns.slice(offset, offset + limit), {
            limit,
            offset,
            total: sharedRuns.length,
          }),
        ),
      });
    }
    if (path === "/api/reports" && method === "GET")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageOf(
            sharedOnly
              ? []
              : [
                  currentReport,
                  ...(copiedReport ? [copiedReport] : []),
                  ...(options.readOnlySource ? [readOnlyReport] : []),
                ],
            { limit: 25 },
          ),
        ),
      });
    if (path === `/api/reports/${reportId}/schedule` && method === "GET")
      return route.fulfill(
        options.savedSchedule
          ? {
              json: {
                id: scheduleId,
                report_id: reportId,
                revision: 1,
                enabled: true,
                cadence: "weekly",
                timezone_name: "Asia/Manila",
                local_time: "09:00",
                weekday: 0,
                month_day: null,
                next_due_at: "2026-09-28T01:00:00Z",
                last_run: options.lastRun ?? null,
                created_at: timestamp,
                updated_at: timestamp,
              },
            }
          : {
              status: 404,
              contentType: "application/json",
              body: JSON.stringify({ detail: "Report schedule not found" }),
            },
      );
    if (path === `/api/reports/${reportId}/schedule` && method === "POST") {
      scheduleWrites += 1;
      return route.fulfill({
        status: 201,
        headers: { Location: `/api/reports/${reportId}/schedule` },
        contentType: "application/json",
        body: JSON.stringify({
          id: scheduleId,
          report_id: reportId,
          revision: 1,
          enabled: true,
          cadence: "daily",
          timezone_name: "Asia/Manila",
          local_time: "09:00",
          weekday: null,
          month_day: null,
          next_due_at: "2026-09-25T01:00:00Z",
          last_run: null,
          created_at: timestamp,
          updated_at: timestamp,
        }),
      });
    }
    if (path === `/api/reports/${reportId}/runs` && method === "GET") {
      const url = new URL(request.url());
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      ownedRunPageRequests.push({ limit, offset });
      if (manualRuns > 0 && offset === 0 && failFirstHistoryAfterRun) {
        failFirstHistoryAfterRun = false;
        return route.fulfill({ status: 503, body: "{}" });
      }
      if (offset === 25 && failOwnedSecondPage) {
        failOwnedSecondPage = false;
        return route.fulfill({ status: 503, body: "{}" });
      }
      const ownerRuns = options.ownerRunCount
        ? [
            ...(manualRuns && options.distinctNewRun ? [newRun] : []),
            ...Array.from({ length: options.ownerRunCount }, (_, index) => ({
              ...run,
              id:
                index === 0
                  ? run.id
                  : `00000000-0000-4000-8000-${String(500 + index).padStart(12, "0")}`,
              recipe_revision: index + 1,
              row_count: index + 1,
            })),
          ]
        : manualRuns
          ? [run]
          : [];
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageOf(ownerRuns.slice(offset, offset + limit), {
            limit,
            offset,
            total: ownerRuns.length,
          }),
        ),
      });
    }
    if (path === `/api/reports/${reportId}/runs` && method === "POST") {
      manualRuns += 1;
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(options.distinctNewRun ? newRun : run),
      });
    }
    if (path === `/api/reports/${reportId}/runs/${runId}/csv`) {
      csvReads += 1;
      return route.fulfill({
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="report-${runId}.csv"`,
        },
        body: "Asset\r\nForklift\r\n",
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  return {
    counts: () => ({ manualRuns, scheduleWrites, csvReads }),
    reportCreates: () => reportCreates,
    reportUpdates: () => reportUpdates,
    createdReports: () => createdReports,
    runPageRequests: () => ({
      owned: [...ownedRunPageRequests],
      shared: [...sharedRunPageRequests],
    }),
  };
}

async function expectWithinMobileWidth(control: Locator) {
  await expect
    .poll(async () => {
      const bounds = await control.boundingBox();
      return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= 390;
    })
    .toBe(true);
}

test.describe("Reports in a non-UTC browser timezone", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("connected Reports let an owner run, schedule, and export a saved recipe", async ({
    page,
  }) => {
    const api = await installReportsApi(page);
    await page.goto("/openview?section=reports");
    await page.getByRole("button", { name: "Operations review" }).click();
    await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Saved outputs" }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: "Schedule" })).toBeVisible();
    await page.getByRole("button", { name: "Run now" }).click();
    await expect(page.getByText("Report run saved with 1 row.")).toBeVisible();
    await expect(page.getByText(/Recipe version 1/)).toBeVisible();
    await expect(
      page
        .getByRole("table", { name: "Saved outputs" })
        // The shared workspace fixture is en-PH in Asia/Manila (UTC+8).
        .getByText(/Sep 24, 2026.*8:00\sAM$/),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Schedule" }).click();
    await page.getByRole("checkbox", { name: "Enable scheduled runs" }).check();
    await page.getByLabel("Repeat").selectOption("weekly");
    await page.getByLabel("Weekday").selectOption("4");
    await page.getByRole("textbox", { name: "Timezone" }).fill("Asia/Manila");
    await page.getByLabel("Local time").fill("10:30");
    await page.getByRole("tab", { name: "Saved outputs" }).click();
    await page.getByRole("tab", { name: "Schedule" }).click();
    await expect(
      page.getByRole("checkbox", { name: "Enable scheduled runs" }),
    ).toBeChecked();
    await expect(page.getByLabel("Repeat")).toHaveValue("weekly");
    await expect(page.getByLabel("Weekday")).toHaveValue("4");
    await expect(page.getByLabel("Local time")).toHaveValue("10:30");
    await expect(page.getByRole("textbox", { name: "Timezone" })).toHaveValue(
      "Asia/Manila",
    );
    await page.getByRole("button", { name: "Create schedule" }).click();
    await expect(page.getByText("Schedule saved and enabled.")).toBeVisible();
    await page.getByRole("tab", { name: "Saved outputs" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /Download CSV/ }).click();
    expect((await download).suggestedFilename()).toBe(`report-${runId}.csv`);
    expect(api.counts()).toEqual({
      manualRuns: 1,
      scheduleWrites: 1,
      csvReads: 1,
    });
  });
});

test("Report metadata follows personal display while schedule inputs and frozen CSV remain unchanged", async ({
  page,
}, testInfo) => {
  await installReportsApi(page, false, report, {
    ownerRunCount: 1,
    savedSchedule: true,
    lastRun: {
      state: "succeeded",
      finished_at: "2026-09-24T00:00:00Z",
      failure_label: null,
    },
  });
  const scheduleWrites: unknown[] = [];
  const savedSchedule = {
    id: scheduleId,
    report_id: reportId,
    revision: 1,
    enabled: true,
    cadence: "weekly",
    timezone_name: "Asia/Manila",
    local_time: "09:00",
    weekday: 0,
    month_day: null,
    next_due_at: "2026-09-28T01:00:00Z",
    last_run: {
      state: "succeeded",
      finished_at: "2026-09-24T00:00:00Z",
      failure_label: null,
    },
    created_at: timestamp,
    updated_at: timestamp,
  };
  await page.route(`**/api/reports/${reportId}/schedule`, (route) => {
    if (route.request().method() === "PATCH") {
      const body: unknown = route.request().postDataJSON();
      scheduleWrites.push(body);
      if (typeof body !== "object" || body === null)
        throw new Error("Invalid schedule command");
      Object.assign(savedSchedule, body, { revision: 2 });
    }
    return route.fulfill({ json: savedSchedule });
  });
  await page.route(`**/api/users/${userId}/preferences`, (route) =>
    route.fulfill({
      json: profilePreferences(userId, {
        timezone: "America/Los_Angeles",
        date_format: "ymd",
        time_format: "24h",
        week_start: "sunday",
      }),
    }),
  );
  // One captured text column, matching the run's Asset heading and row count.
  // Date-like cell text is server-owned output, never personally reformatted.
  const snapshotCsv = '"Asset"\r\n"2026-09-24 08:00 · 2026-09-24"\r\n';
  await page.route(`**/api/reports/${reportId}/runs/${runId}`, (route) =>
    route.fulfill({ json: run }),
  );
  const outputRequests: { path: string; search: string; method: string }[] = [];
  await page.route(`**/api/reports/${reportId}/runs/${runId}/csv`, (route) => {
    const url = new URL(route.request().url());
    outputRequests.push({
      path: url.pathname,
      search: url.search,
      method: route.request().method(),
    });
    return route.fulfill({
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="report-${runId}.csv"`,
      },
      body: snapshotCsv,
    });
  });
  await page.goto(`/openview?section=reports&report=${reportId}&run=${runId}`);
  const selected = page.getByRole("region", {
    name: "Selected output",
    exact: true,
  });
  await expect(selected).toContainText("2026-09-23");
  await expect(selected).toContainText("17:00");
  await expect(selected).toContainText("Recipe version 1");
  await expect(selected).toContainText("1 row");
  await page.getByRole("tab", { name: "Schedule", exact: true }).click();
  const lastRun = page.getByRole("status", {
    name: "Last scheduled run",
    exact: true,
  });
  await expect(lastRun).toContainText("2026-09-23");
  await expect(lastRun).toContainText("17:00");
  await page
    .getByRole("checkbox", { name: "Enable scheduled runs", exact: true })
    .check();
  await page.getByLabel("Local time", { exact: true }).fill("10:30");
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue(
    "Asia/Manila",
  );
  await expect(page.getByLabel("Weekday", { exact: true })).toHaveValue("0");
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await expect(
    page.getByText("Schedule saved and enabled.", { exact: true }),
  ).toBeVisible();
  expect(scheduleWrites).toHaveLength(1);
  expect(scheduleWrites[0]).toMatchObject({
    enabled: true,
    cadence: "weekly",
    revision: 1,
    weekday: 0,
    local_time: "10:30",
    timezone_name: "Asia/Manila",
  });
  expect(savedSchedule).toMatchObject({
    revision: 2,
    weekday: 0,
    local_time: "10:30",
    timezone_name: "Asia/Manila",
  });
  const downloaded = page.waitForEvent("download");
  await selected.getByRole("button", { name: /Download CSV/ }).click();
  const download = await downloaded;
  const path = testInfo.outputPath("s21-frozen-report.csv");
  await download.saveAs(path);
  expect(await readFile(path, "utf8")).toBe(snapshotCsv);
  expect(outputRequests).toEqual([
    {
      path: `/api/reports/${reportId}/runs/${runId}/csv`,
      search: "",
      method: "GET",
    },
  ]);
});

test("connected Reports expose only authorized shared-run metadata to a reader", async ({
  page,
}) => {
  const api = await installReportsApi(page, true);
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Available outputs" }).click();
  const outputs = page.getByRole("dialog", { name: "Available outputs" });
  await expect(outputs).toBeVisible();
  await expect(
    outputs.getByRole("cell", { name: "Shared operations review" }).first(),
  ).toBeVisible();
  await expect(page.getByText("No saved Reports")).toBeVisible();
  const download = page.waitForEvent("download");
  await outputs
    .getByRole("button", { name: /Download CSV/ })
    .first()
    .click();
  expect((await download).suggestedFilename()).toBe(`report-${runId}.csv`);
  await outputs.getByRole("button", { name: "Go to next page" }).click();
  await expect(outputs.getByLabel("Page 2 of 2")).toBeVisible();
  await expect(
    outputs.getByRole("row").filter({ hasText: "26" }),
  ).toBeVisible();
  expect(api.counts()).toEqual({
    manualRuns: 0,
    scheduleWrites: 0,
    csvReads: 1,
  });
});

test("owned and shared output page sizes reset independently to the first page", async ({
  page,
}) => {
  const api = await installReportsApi(page, false, report, {
    ownerRunCount: 26,
    sharedRunCount: 26,
  });
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Operations review" }).click();

  const ownedOutputPanel = page.getByRole("tabpanel", {
    name: "Saved outputs",
  });
  const ownedOutputs = ownedOutputPanel.getByRole("table", {
    name: "Saved outputs",
  });
  const ownedPageSize = ownedOutputPanel.getByLabel("Rows per page");
  await expect(ownedPageSize).toHaveValue("25");
  await page
    .getByRole("navigation", { name: "Saved output pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(page.getByText("Showing 26–26 of 26")).toBeVisible();

  await ownedPageSize.selectOption("10");
  await expect(ownedPageSize).toHaveValue("10");
  await expect(ownedOutputs.getByRole("row")).toHaveCount(11);
  await expect(page.getByText("Showing 1–10 of 26")).toBeVisible();
  await expect(
    ownedOutputs.getByRole("cell", { name: "Recipe version 10" }),
  ).toBeVisible();
  expect(api.runPageRequests().owned).toContainEqual({ limit: 10, offset: 0 });

  await page.getByRole("button", { name: "Available outputs" }).click();
  const availableOutputs = page.getByRole("dialog", {
    name: "Available outputs",
  });
  const sharedPageSize = availableOutputs.getByLabel("Rows per page");
  const sharedTable = availableOutputs.getByRole("table", {
    name: "Available outputs",
  });
  await expect(sharedPageSize).toHaveValue("25");
  await availableOutputs
    .getByRole("navigation", { name: "Available output pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(availableOutputs.getByText("Showing 26–26 of 26")).toBeVisible();

  await sharedPageSize.selectOption("5");
  await expect(sharedPageSize).toHaveValue("5");
  await expect(sharedTable.getByRole("row")).toHaveCount(6);
  await expect(availableOutputs.getByText("Showing 1–5 of 26")).toBeVisible();
  await expect(
    sharedTable.getByRole("cell", { name: "Recipe version 5" }),
  ).toBeVisible();
  expect(api.runPageRequests().shared).toContainEqual({ limit: 5, offset: 0 });
  await expect(ownedPageSize).toHaveValue("10");
});

for (const list of [
  {
    name: "owned",
    sharedOnly: false,
    options: { ownerRunCount: 26, failOwnedSecondPage: true },
    pages: "Saved output pages",
    failure: "Report history could not be loaded",
    open: async (page: Page): Promise<Locator> => {
      await page.getByRole("button", { name: "Operations review" }).click();
      await expect(
        page.getByRole("table", { name: "Saved outputs" }),
      ).toBeVisible();
      return page.locator("body");
    },
  },
  {
    name: "available",
    sharedOnly: true,
    options: { failSharedSecondPage: true },
    pages: "Available output pages",
    failure: "Available runs could not be loaded",
    open: async (page: Page): Promise<Locator> => {
      await page.getByRole("button", { name: "Available outputs" }).click();
      return page.getByRole("dialog", { name: "Available outputs" });
    },
  },
]) {
  test(`failed ${list.name} output page does not relabel old results or leave their actions available`, async ({
    page,
  }) => {
    await installReportsApi(page, list.sharedOnly, report, list.options);
    await page.goto("/openview?section=reports");
    const outputs = await list.open(page);
    await expect(
      outputs.getByText("Recipe version 1", { exact: true }),
    ).toBeVisible();
    await outputs
      .getByRole("navigation", { name: list.pages })
      .getByRole("button", { name: "Go to next page" })
      .click();
    await expect(
      outputs.getByRole("alert").filter({ hasText: list.failure }),
    ).toBeVisible();
    await expect(
      outputs.getByText("Recipe version 1", { exact: true }),
    ).toHaveCount(0);
    await expect(
      outputs.getByRole("button", { name: /Download CSV/ }),
    ).toHaveCount(0);
    await expect(
      outputs.getByRole("button", { name: /Print output from/ }),
    ).toHaveCount(0);
    await outputs.getByRole("button", { name: "Retry" }).click();
    await expect(outputs.getByText("Recipe version 26")).toBeVisible();
  });
}

test("a confirmed new run caps the selected page size when history refresh fails", async ({
  page,
}) => {
  await installReportsApi(page, false, report, {
    ownerRunCount: 5,
    distinctNewRun: true,
    failFirstHistoryAfterRun: true,
  });
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Operations review" }).click();
  const outputs = page.getByRole("table", { name: "Saved outputs" });
  await page.getByLabel("Rows per page").selectOption("5");
  await expect(outputs.getByRole("row")).toHaveCount(6);
  await expect(
    outputs.getByRole("cell", { name: "Recipe version 5" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Run now" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Report history could not be loaded" }),
  ).toBeVisible();
  await expect(outputs.getByRole("row")).toHaveCount(6);
  await expect(
    outputs.getByRole("cell", { name: "Recipe version 99" }),
  ).toBeVisible();
  await expect(
    outputs.getByRole("cell", { name: "Recipe version 5" }),
  ).toHaveCount(0);
  await expect(page.getByText("Showing 1–5 of 6")).toBeVisible();

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(outputs.getByRole("row")).toHaveCount(6);
  await page
    .getByRole("navigation", { name: "Saved output pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(
    outputs.getByRole("cell", { name: "Recipe version 5" }),
  ).toBeVisible();
  await expect(page.getByText("Showing 6–6 of 6")).toBeVisible();
});

test("saved and available output actions fit a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installReportsApi(page, false, report, {
    ownerRunCount: 1,
    sharedRunCount: 1,
  });
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Operations review" }).click();
  const savedOutput = page
    .getByRole("list", { name: "Saved outputs" })
    .getByRole("listitem")
    .first();
  await expect(savedOutput.getByText("Recipe version")).toBeVisible();
  await expect(savedOutput.getByText("Rows")).toBeVisible();
  await expect(savedOutput.locator("time")).toBeVisible();
  await expectWithinMobileWidth(
    page.getByRole("button", { name: /Download CSV/ }),
  );
  await expectWithinMobileWidth(
    page.getByRole("button", { name: /Print output from/ }),
  );

  await page.getByRole("button", { name: "Available outputs" }).click();
  const outputs = page.getByRole("dialog", { name: "Available outputs" });
  const sharedOutput = outputs
    .getByRole("list", { name: "Available outputs" })
    .getByRole("listitem")
    .first();
  await expect(
    sharedOutput.getByText("Shared operations review"),
  ).toBeVisible();
  await expect(sharedOutput.getByText("Recipe version")).toBeVisible();
  await expect(sharedOutput.getByText("Rows")).toBeVisible();
  await expect(sharedOutput.locator("time")).toBeVisible();
  await expectWithinMobileWidth(
    outputs.getByRole("button", { name: /Download CSV/ }),
  );
  await expectWithinMobileWidth(
    outputs.getByRole("button", { name: /Print output from/ }),
  );
});

test("a module reader runs a Report but cannot change, copy or schedule it", async ({
  page,
}) => {
  const api = await installReportsApi(page, false, report, {
    level: "read",
    savedSchedule: true,
  });
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Operations review" }).click();

  await expect(page.getByRole("button", { name: "Run now" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "New Report" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit report" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Duplicate" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Report options" }),
  ).toHaveCount(0);
  await expect(page.getByText(/audience|owner/i)).toHaveCount(0);
  await page.getByRole("tab", { name: "Schedule" }).click();
  await expect(
    page.getByRole("checkbox", { name: "Enable scheduled runs" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Weekly on Monday at 9:00 AM (Asia/Manila)"),
  ).toBeVisible();
  await expect(
    page.getByText("Only a manager of this module changes the schedule."),
  ).toBeVisible();
  expect(api.counts().manualRuns).toBe(0);
});

test("a new Report offers only data sources the member manages", async ({
  page,
}) => {
  const api = await installReportsApi(page, false, report, {
    readOnlySource: true,
  });
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "New Report" }).click();

  const source = page.getByRole("combobox", { name: "Data source" });
  await expect(source.getByRole("option", { name: "Assets" })).toBeAttached();
  await expect(source.getByRole("option", { name: "Invoices" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close editor" }).click();

  // A template on a module the member only reads cannot become a new Report.
  await page
    .getByLabel("Start from saved Report")
    .selectOption(readOnlyReportId);
  await page.getByRole("button", { name: "Start from saved Report" }).click();
  await expect(page.getByRole("textbox", { name: "Report name" })).toHaveValue(
    "Copy of Invoice review",
  );
  await page.getByRole("button", { name: "Create Report" }).click();
  await expect(
    page.getByText("Choose a data source you manage for this Report"),
  ).toBeVisible();
  expect(api.reportCreates()).toBe(0);
});

test("an administrator's new Report offers every data source", async ({
  page,
}) => {
  await installReportsApi(page, false, report, {
    role: "admin",
    readOnlySource: true,
  });
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "New Report" }).click();

  const source = page.getByRole("combobox", { name: "Data source" });
  await expect(source.getByRole("option", { name: "Assets" })).toBeAttached();
  await expect(source.getByRole("option", { name: "Invoices" })).toBeAttached();
});

test("saved Report cards name the department of their module", async ({
  page,
}) => {
  await installReportsApi(page, false, report, { level: "read" });
  await page.route("**/api/departments**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: ownerId,
            department_name: "Field operations",
            created_at: "2026-09-23T00:00:00Z",
            updated_at: "2026-09-23T00:00:00Z",
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
        ],
        pagination: wirePagination({ limit: 100, count: 1, total: 1 }),
      },
    }),
  );
  await page.goto("/openview?section=reports");
  const card = page.getByRole("button", { name: /^Operations review/ });
  await expect(card).toContainText("Field operations");
  await expect(card).toHaveAccessibleName("Operations review Field operations");
});

for (const entry of [
  {
    title: "duplicating a saved Report",
    start: async (page: Page) => {
      await page.getByRole("button", { name: "Operations review" }).click();
      await page.getByRole("button", { name: "Duplicate" }).click();
    },
  },
  {
    title: "starting from a saved Report in the template chooser",
    start: async (page: Page) => {
      await page.getByLabel("Start from saved Report").selectOption(reportId);
      await page
        .getByRole("button", { name: "Start from saved Report" })
        .click();
    },
  },
]) {
  test(`${entry.title} creates a separate draft on its first Save`, async ({
    page,
  }) => {
    const api = await installReportsApi(page);
    await page.goto("/openview?section=reports");
    await entry.start(page);

    await expect(
      page.getByRole("textbox", { name: "Report name" }),
    ).toHaveValue("Copy of Operations review");
    await expect(
      page.getByText("Save to create a separate Report."),
    ).toBeVisible();
    expect(api.reportCreates()).toBe(0);
    expect(api.reportUpdates()).toBe(0);

    await page.getByRole("button", { name: "Create Report" }).click();
    await expect(
      page.locator("#main-content").getByText("Report created."),
    ).toBeVisible();
    expect(api.reportCreates()).toBe(1);
    expect(api.reportUpdates()).toBe(0);
    expect(api.createdReports()[0]?.request).toMatchObject({
      name: "Copy of Operations review",
      recipe: report.recipe,
    });
    expect(api.createdReports()[0]?.response).toMatchObject({
      id: duplicateReportId,
      name: "Copy of Operations review",
      recipe: report.recipe,
    });
    await page.reload();
    const original = page.getByRole("button", {
      name: "Operations review Field operations",
      exact: true,
    });
    const copy = page.getByRole("button", {
      name: "Copy of Operations review Field operations",
      exact: true,
    });
    await expect(original).toBeVisible();
    await expect(copy).toBeVisible();
    await original.click();
    await page.getByRole("button", { name: "Edit report" }).click();
    await expect(
      page.getByRole("textbox", { name: "Report name" }),
    ).toHaveValue("Operations review");
    await page.getByRole("button", { name: "Close editor" }).click();
    await copy.click();
    await page.getByRole("button", { name: "Edit report" }).click();
    await expect(
      page.getByRole("textbox", { name: "Report name" }),
    ).toHaveValue("Copy of Operations review");
  });
}

test("unsaved Report edits guard workspace navigation", async ({ page }) => {
  const api = await installReportsApi(page);
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Operations review" }).click();
  await page.getByRole("button", { name: "Edit report" }).click();
  const editor = page.getByRole("dialog", { name: "Edit report" });
  await editor
    .getByRole("textbox", { name: "Report name" })
    .fill("Unsaved review");
  await editor.getByRole("button", { name: "Close editor" }).click();
  await expect(
    page.locator("#main-content").getByText(/Unsaved changes/),
  ).toBeVisible();
  await page.getByRole("link", { name: "Search workspace" }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "Discard unsaved Report changes?",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(`/openview?section=reports&report=${reportId}`);
  await page.getByRole("button", { name: "Edit report" }).click();
  await expect(
    editor.getByRole("textbox", { name: "Report name" }),
  ).toHaveValue("Unsaved review");
  await editor.getByRole("button", { name: "Close editor" }).click();
  await page.getByRole("link", { name: "Search workspace" }).click();
  await dialog.getByRole("button", { name: "Discard and continue" }).click();
  await expect(page).toHaveURL("/platform");

  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Operations review" }).click();
  await page.getByRole("button", { name: "Edit report" }).click();
  await page
    .getByRole("dialog", { name: "Edit report" })
    .getByRole("textbox", { name: "Report name" })
    .fill("Saved review");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.locator("#main-content").getByText("Report saved."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Saved review" }),
  ).toBeVisible();
  expect(api.reportUpdates()).toBe(1);
});

test("Report recipes open on demand and preserve cross-tab drafts when closed", async ({
  page,
}) => {
  const api = await installReportsApi(page);
  await page.goto("/openview?section=reports");

  await expect(page.getByRole("button", { name: "New Report" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Report name" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "New Report" }).click();
  const editor = page.getByRole("dialog", { name: "New report" });
  await expect(editor).toBeVisible();
  for (const tab of ["Basics", "Columns", "Advanced"]) {
    await expect(editor.getByRole("tab", { name: tab })).toBeVisible();
  }
  await expect(
    editor.getByText("Reports use records from one source."),
  ).toBeVisible();

  await editor.getByLabel("Data source").selectOption(moduleId);
  await editor.getByLabel("Report name").fill("Quarterly review");
  await editor.getByRole("tab", { name: "Columns" }).click();
  await editor.getByRole("checkbox", { name: "Asset" }).check();
  await editor.getByRole("tab", { name: "Advanced" }).click();
  await expect(
    editor.getByRole("button", { name: "Add filter" }),
  ).toBeVisible();
  await expect(editor.getByRole("tab", { name: "Audience" })).toHaveCount(0);
  await editor.getByRole("tab", { name: "Basics" }).click();
  await editor.getByRole("button", { name: "Close editor" }).click();

  await expect(
    page.locator("#main-content").getByText(/Unsaved changes/),
  ).toBeVisible();
  expect(api.reportCreates()).toBe(0);
  await page.getByRole("button", { name: "Edit report" }).click();
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Report name")).toHaveValue(
    "Quarterly review",
  );
  await editor.getByRole("tab", { name: "Columns" }).click();
  await expect(editor.getByRole("checkbox", { name: "Asset" })).toBeChecked();
  await editor.getByRole("button", { name: "Create Report" }).click();

  await expect(editor).toBeHidden();
  await expect(
    page.locator("#main-content").getByText("Report created."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Quarterly review" }),
  ).toBeVisible();
  expect(api.reportCreates()).toBe(1);
  expect(api.createdReports()[0]?.request).toMatchObject({
    module_id: moduleId,
    name: "Quarterly review",
    recipe: { fields: [{ field_id: fieldId, expected_type: "text" }] },
  });
});

test("Report filters display Select labels, submit stable IDs, and use module-eligible people", async ({
  page,
}) => {
  const api = await installReportsApi(page);
  const selectFieldId = "00000000-0000-4000-8000-000000000112";
  const inServiceChoiceId = "00000000-0000-4000-8000-000000000113";
  const inspectionChoiceId = "00000000-0000-4000-8000-000000000114";
  const userFieldId = "00000000-0000-4000-8000-000000000115";
  const eligibleUserId = "00000000-0000-4000-8000-000000000116";
  const assignableUserRequests: string[] = [];
  const globalUserRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === `/api/modules/${moduleId}/assignable-users`)
      assignableUserRequests.push(path);
    if (
      (path === "/api/users" || path.startsWith("/api/users/")) &&
      !(
        path === `/api/users/${userId}/preferences` &&
        request.method() === "GET"
      )
    )
      globalUserRequests.push(path);
  });
  await page.route(`**/api/views/data-sources/${moduleId}/fields**`, (route) =>
    route.fulfill({
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
            wireField({
              id: selectFieldId,
              module_id: moduleId,
              name: "Status",
              type: "select",
              position: 1,
              config: {
                options: [
                  { id: inServiceChoiceId, label: "In service" },
                  { id: inspectionChoiceId, label: "Inspection due" },
                ],
              },
            }),
            wireField({
              id: userFieldId,
              module_id: moduleId,
              name: "Assignee",
              type: "user",
              position: 2,
              config: { kind: "user" },
            }),
          ],
          { limit: 100 },
        ),
      ),
    }),
  );
  await page.route(`**/api/modules/${moduleId}/assignable-users**`, (route) =>
    route.fulfill({
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

  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "New Report" }).click();
  const editor = page.getByRole("dialog", { name: "New report" });
  await editor.getByLabel("Data source").selectOption(moduleId);
  await editor.getByLabel("Report name").fill("Stable filters");
  await editor.getByRole("tab", { name: "Columns" }).click();
  await editor.getByRole("checkbox", { name: "Asset" }).check();
  await editor.getByRole("tab", { name: "Advanced" }).click();

  await editor.getByRole("button", { name: "Add filter" }).click();
  await editor
    .getByRole("combobox", { name: "Field" })
    .nth(0)
    .selectOption(selectFieldId);
  await editor
    .getByRole("combobox", { name: "Condition" })
    .nth(0)
    .selectOption("in");
  const choices = editor.getByRole("group", { name: "Value" });
  await choices.getByRole("checkbox", { name: "In service" }).check();
  await choices.getByRole("checkbox", { name: "Inspection due" }).check();

  await editor.getByRole("button", { name: "Add filter" }).click();
  await editor
    .getByRole("combobox", { name: "Field" })
    .nth(1)
    .selectOption(userFieldId);
  await expect.poll(() => assignableUserRequests.length).toBeGreaterThan(0);
  const personValue = editor.getByRole("combobox", { name: "Value" });
  await expect(
    personValue.getByRole("option", { name: "Alex Reader" }),
  ).toBeAttached();
  await personValue.selectOption(eligibleUserId);
  await expect(editor.getByText(eligibleUserId, { exact: true })).toHaveCount(
    0,
  );
  expect(globalUserRequests).toEqual([]);

  await editor.getByRole("button", { name: "Create Report" }).click();
  await expect(editor).toBeHidden();
  expect(api.createdReports()[0]?.request).toMatchObject({
    recipe: {
      filters: [
        {
          field_id: selectFieldId,
          expected_type: "select",
          operator: "in",
          value: [inServiceChoiceId, inspectionChoiceId],
        },
        {
          field_id: userFieldId,
          expected_type: "user",
          operator: "eq",
          value: eligibleUserId,
        },
      ],
    },
  });
});

test("Report CSV errors cannot impersonate browser-blocked print guidance", async ({
  page,
}) => {
  await installReportsApi(page, false, report, { ownerRunCount: 1 });
  const detail = "Your browser blocked private report database detail";
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Operations review" }).click();
  await page.evaluate(
    ({ detail, path }) => {
      const original = window.fetch;
      window.fetch = (input, init) =>
        new URL(
          input instanceof Request ? input.url : String(input),
          location.href,
        ).pathname === path
          ? Promise.reject(new Error(detail))
          : original(input, init);
    },
    { detail, path: `/api/reports/${reportId}/runs/${runId}/csv` },
  );
  await page
    .getByRole("button", { name: /Download CSV/ })
    .first()
    .click();
  const failure = page.getByRole("alert").filter({
    hasText: "The saved Report output could not be opened. Try again.",
  });
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute("data-variant", "destructive");
  await expect(page.getByText(detail, { exact: true })).toHaveCount(0);
});

test("Report printing preserves genuine blocked-popup guidance", async ({
  page,
}) => {
  const api = await installReportsApi(page, false, report, {
    ownerRunCount: 1,
  });
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Operations review" }).click();
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page
    .getByRole("button", { name: /Print output from/ })
    .first()
    .click();
  await expect(
    page.getByRole("alert").filter({
      hasText:
        "Your browser blocked the print window. Allow pop-ups and try again.",
    }),
  ).toBeVisible();
  expect(api.counts().csvReads).toBe(0);
});

test("notification URL opens the exact Report and run beyond the first catalog and history pages", async ({
  page,
}) => {
  const api = await installReportsApi(page, true, report, {
    ownerRunCount: 26,
  });
  const exactRun = {
    ...run,
    id: newRunId,
    recipe_revision: 99,
    row_count: 123,
    created_at: "2026-10-01T00:00:00Z",
  };
  await page.route(`**/api/reports/${reportId}/runs/${newRunId}`, (route) =>
    route.fulfill({ json: exactRun }),
  );
  await page.goto(
    `/openview?section=reports&report=${reportId}&run=${newRunId}`,
  );
  const selected = page.getByRole("region", { name: "Selected output" });
  await expect(
    selected.getByRole("heading", { name: "Operations review" }),
  ).toBeVisible();
  await expect(selected.getByText("Recipe version 99")).toBeVisible();
  await expect(selected.getByText("123 rows")).toBeVisible();
  expect(api.counts().csvReads).toBe(0);
  await expect(
    page.getByText("Showing 1–25 of 26", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(selected.getByText("Recipe version 99")).toBeVisible();
  expect(api.counts().csvReads).toBe(0);
});

// The navigation guard itself (Keep editing, Discard and continue) is owned by
// "unsaved Report edits guard workspace navigation".
test("Report-only links retain their exact selection and Back restores it after leaving a dirty recipe", async ({
  page,
}) => {
  await installReportsApi(page, true);
  await page.goto(`/openview?section=reports&report=${reportId}`);
  await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
  await page.getByRole("button", { name: "Edit report" }).click();
  await page
    .getByRole("textbox", { name: "Report name" })
    .fill("Unsaved operations review");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "Search workspace" }).click();
  await page
    .getByRole("alertdialog", { name: "Discard unsaved Report changes?" })
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(
    page.getByRole("searchbox", { name: "Search workspace" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`report=${reportId}`));
});

// The parse of an invalid or run-only link is owned by
// isolated/openview/url-state.spec.ts; `invalid` keeps the rendered alert.
for (const failure of ["missing", "wrong-parent", "invalid"] as const) {
  test(`a ${failure} Report target cannot select a default Report or wrong output`, async ({
    page,
  }) => {
    await installReportsApi(page);
    await page.route(`**/api/reports/${reportId}/runs/${newRunId}`, (route) =>
      route.fulfill(
        failure === "missing"
          ? { status: 404, json: { detail: "Private target detail" } }
          : { json: { ...run, id: newRunId, report_id: duplicateReportId } },
      ),
    );
    const query =
      failure === "invalid"
        ? "report=invalid"
        : `report=${reportId}&run=${newRunId}`;
    await page.goto(`/openview?section=reports&${query}`);
    await expect(
      page.getByText(
        failure === "invalid"
          ? "This Report link is invalid."
          : "Selected output could not be loaded. Try again.",
      ),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Selected output" })
        .getByRole("button", { name: /Download CSV/ }),
    ).toHaveCount(0);
    await expect(page.getByRole("main")).not.toContainText(
      "Private target detail",
    );
  });
}

test("a late old Report target cannot replace a newer URL selection", async ({
  page,
}) => {
  await installReportsApi(page, false, report, { readOnlySource: true });
  const target = gate();
  await page.route(`**/api/reports/${reportId}`, async (route) => {
    target.signalStarted();
    await target.wait;
    await route.fulfill({ json: report });
  });
  await page.goto(`/openview?section=reports&report=${reportId}`);
  await target.started;
  await page.getByRole("button", { name: "Invoice review" }).click();
  await expect(page).toHaveURL(new RegExp(`report=${readOnlyReportId}`));
  target.release();
  await expect(page.getByRole("button", { name: "Edit report" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "Invoice review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Operations review", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Report name" })).toHaveCount(
    0,
  );
});

test("an unavailable explicit Report clears the selection and supports a current-access retry", async ({
  page,
}) => {
  await installReportsApi(page, true);
  let refused = true;
  await page.route(`**/api/reports/${reportId}`, async (route) => {
    if (refused)
      return route.fulfill({
        status: 404,
        json: { detail: "Private target detail" },
      });
    return route.fallback();
  });
  await page.goto(`/openview?section=reports&report=${reportId}`);
  await expect(
    page.getByText("Selected Report could not be loaded. Try again."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(0);
  refused = false;
  await page.getByRole("button", { name: "Retry selected Report" }).click();
  await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText(
    "Private target detail",
  );
});

test("Reports navigation preserves existing module context without inventing an invalid Report selection", async ({
  page,
}) => {
  await installReportsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}`);
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Reports", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Select a Report", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("This Report link is invalid.")).toHaveCount(0);
});

test("reselecting the current Report does not skip its exact read after a same-account session check", async ({
  page,
}) => {
  await installReportsApi(page);
  await page.goto(`/openview?section=reports&report=${reportId}`);
  await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
  await page.getByRole("button", { name: "Operations review" }).click();
  let currentReads = 0;
  await page.route(`**/api/reports/${reportId}`, async (route) => {
    currentReads += 1;
    await route.fulfill({ status: 404, json: { detail: "Report not found" } });
  });
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect(
    page.getByText("Selected Report could not be loaded. Try again."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(0);
  expect(currentReads).toBeGreaterThan(0);
});

test("a notice keeps dirty Report edits on canceled navigation and closes only after accepted navigation", async ({
  page,
}) => {
  await installReportsApi(page);
  await page.route("**/api/notifications**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/notifications/unread-count")
      return route.fulfill({ json: { unread_count: 1 } });
    const notice = {
      id: scheduleId,
      kind: "report-run",
      subject_type: "report_run",
      subject_id: runId,
      report_id: reportId,
      run_id: runId,
      status: "unread",
      scheduled_for: timestamp,
      created_at: timestamp,
      read_at: null,
    };
    await route.fulfill({
      json: pageOf([notice], {
        limit: Number(url.searchParams.get("limit")),
        total: 1,
      }),
    });
  });
  await page.route(`**/api/reports/${reportId}/runs/${runId}`, (route) =>
    route.fulfill({ json: run }),
  );
  await page.goto(`/openview?section=reports&report=${reportId}`);
  await page.getByRole("button", { name: "Edit report" }).click();
  await page
    .getByRole("textbox", { name: "Report name" })
    .fill("Unsaved operations review");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Notifications, 1 unread" }).click();
  const popup = page.getByRole("dialog", {
    name: "Notifications",
    exact: true,
  });
  await popup.getByRole("link", { name: "Open report" }).click();
  const guard = page.getByRole("alertdialog", {
    name: "Discard unsaved Report changes?",
  });
  await guard.getByRole("button", { name: "Keep editing" }).click();
  await expect(popup).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Unsaved operations review",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(`/openview?section=reports&report=${reportId}`);
  await popup.getByRole("link", { name: "Open report" }).click();
  await guard.getByRole("button", { name: "Discard and continue" }).click();
  await expect(page).toHaveURL(
    `/openview?section=reports&report=${reportId}&run=${runId}`,
  );
  await expect(popup).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Selected output" })
      .getByRole("heading", { name: "Operations review" }),
  ).toBeVisible();
});

test("Reports review regression: Back from a pristine saved Report restores unselected Reports without creating a copy", async ({
  page,
}) => {
  const api = await installReportsApi(page);
  await page.goto("/openview?section=reports");
  await expect(
    page.getByText("Select a Report", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Operations review Field operations",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(`/openview?section=reports&report=${reportId}`);
  await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("/openview?section=reports");
  await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(0);
  await expect
    .soft(page.getByText("Select a Report", { exact: true }))
    .toBeVisible();

  // Exercise a stale recipe only if Back erroneously leaves it actionable.
  const edit = page.getByRole("button", { name: "Edit report", exact: true });
  const staleRecipeEditable = await edit.isVisible();
  if (staleRecipeEditable) {
    await edit.click();
    await expect(
      page.getByRole("textbox", { name: "Report name" }),
    ).toHaveValue("Operations review");
    await page
      .getByRole("textbox", { name: "Report name" })
      .fill("Operations review adjusted");
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/reports" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Create Report", exact: true })
      .click();
    await (await created).finished();
  }
  const observed = {
    staleRecipeEditable,
    reportCreates: api.reportCreates(),
    reportUpdates: api.reportUpdates(),
    createdReports: api.createdReports(),
    finalUrl: page.url(),
  };
  console.info("Reports Back regression observation", JSON.stringify(observed));
  await test.info().attach("reports-back-observation", {
    body: JSON.stringify(observed, null, 2),
    contentType: "application/json",
  });
  expect(api.reportCreates()).toBe(0);
  expect(api.reportUpdates()).toBe(0);
  await expect(
    page.getByRole("button", { name: "Edit report", exact: true }),
  ).toHaveCount(0);
});

for (const operation of ["template", "create"] as const) {
  test(`Reports review regression: a held old-account ${operation} result cannot navigate the new account away from Search`, async ({
    page,
  }) => {
    const api = await installReportsApi(page);
    const accountB = "00000000-0000-4000-8000-000000000901";
    let account = userId;
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        json: { authenticated: true, user_id: account, setup_required: false },
      }),
    );
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({ json: { id: account, role: "admin", access: [] } }),
    );
    let hold = false;
    const held = gate();
    const heldPath =
      operation === "template" ? `/api/reports/${reportId}` : "/api/reports";
    const heldMethod = operation === "template" ? "GET" : "POST";
    await page.route("**/api/reports**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const requestedAccount = account;
      if (
        hold &&
        requestedAccount === userId &&
        url.pathname === heldPath &&
        request.method() === heldMethod
      ) {
        hold = false;
        held.signalStarted();
        await held.wait;
        return route.fallback();
      }
      if (requestedAccount === accountB && request.method() === "GET") {
        if (url.pathname === "/api/reports")
          return route.fulfill({
            json: pageOf([], {
              limit: Number(url.searchParams.get("limit") ?? 25),
              offset: Number(url.searchParams.get("offset") ?? 0),
            }),
          });
        if (
          url.pathname === `/api/reports/${reportId}` ||
          url.pathname === `/api/reports/${duplicateReportId}`
        )
          return route.fulfill({
            status: 404,
            json: { detail: "Report not found" },
          });
      }
      return route.fallback();
    });
    await page.goto("/openview?section=reports");
    await page.getByLabel("Start from saved Report").selectOption(reportId);
    if (operation === "template") hold = true;
    await page
      .getByRole("button", { name: "Start from saved Report", exact: true })
      .click();
    if (operation === "create") {
      await expect(
        page.getByRole("textbox", { name: "Report name" }),
      ).toHaveValue("Copy of Operations review");
      hold = true;
      await page
        .getByRole("button", { name: "Create Report", exact: true })
        .click();
    }
    await held.started;
    try {
      account = accountB;
      await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
      await expect(
        page.getByText("No saved Reports", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "Search workspace", exact: true })
        .click();
      const search = page.getByRole("searchbox", {
        name: "Search workspace",
        exact: true,
      });
      await expect(search).toBeVisible();
      await expect(page).toHaveURL("/platform");
      const completed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === heldPath &&
          response.request().method() === heldMethod,
      );
      held.release();
      await (await completed).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const observed = {
        operation,
        account,
        urlAfterRelease: page.url(),
        reportCreates: api.reportCreates(),
      };
      console.info(
        "Reports late-action regression observation",
        JSON.stringify(observed),
      );
      await test.info().attach(`reports-late-${operation}-observation`, {
        body: JSON.stringify(observed, null, 2),
        contentType: "application/json",
      });
      await expect(page).toHaveURL("/platform");
      await expect(search).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Report name" }),
      ).toHaveCount(0);
    } finally {
      held.release();
    }
  });
}

for (const operation of ["new", "template"] as const) {
  test(`Reports correction preserves an intentional ${operation} draft through same-account verification`, async ({
    page,
  }) => {
    const api = await installReportsApi(page);
    let holdSession = false;
    const session = gate();
    await page.route("**/api/auth/session", async (route) => {
      if (holdSession) {
        holdSession = false;
        session.signalStarted();
        await session.wait;
      }
      return route.fulfill({
        json: { authenticated: true, user_id: userId, setup_required: false },
      });
    });
    await page.goto("/openview?section=reports");
    await page.getByRole("button", { name: "Operations review" }).click();
    await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
    if (operation === "new") {
      await page
        .getByRole("button", { name: "New Report", exact: true })
        .click();
      await page
        .getByLabel("Data source", { exact: true })
        .selectOption(moduleId);
      await page.getByRole("tab", { name: "Columns", exact: true }).click();
      await page.getByRole("checkbox", { name: "Asset", exact: true }).check();
      await page.getByRole("tab", { name: "Basics", exact: true }).click();
    } else {
      await page.getByLabel("Start from saved Report").selectOption(reportId);
      await page
        .getByRole("button", { name: "Start from saved Report", exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: "Report name" }),
      ).toHaveValue("Copy of Operations review");
    }
    const editor = page.getByRole("dialog", {
      name: "New report",
      exact: true,
    });
    const name = `Pause-safe ${operation} Report`;
    await editor.getByLabel("Report name", { exact: true }).fill(name);
    await expect(page).toHaveURL("/openview?section=reports");
    holdSession = true;
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await session.started;
    try {
      await expect(
        page.getByRole("dialog", { name: "Session verification" }),
      ).toBeVisible();
    } finally {
      session.release();
    }
    await expect(
      page.getByRole("dialog", { name: "Session verification" }),
    ).toBeHidden();
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("Report name", { exact: true })).toHaveValue(
      name,
    );
    await expect(editor.getByLabel("Data source", { exact: true })).toHaveValue(
      moduleId,
    );
    await editor.getByRole("tab", { name: "Columns", exact: true }).click();
    await expect(
      editor.getByRole("checkbox", { name: "Asset", exact: true }),
    ).toBeChecked();
    expect(api.reportCreates()).toBe(0);
    await editor
      .getByRole("button", { name: "Close editor", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL("/openview?section=reports");
  });
}

test("Reports correction: a held template cannot restore Reports after same-account SPA Back to Search", async ({
  page,
}) => {
  await installReportsApi(page);
  await page.goto("/openview?section=reports");
  await expect(
    page.getByRole("button", { name: "Operations review" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Search workspace", exact: true })
    .click();
  await expect(
    page.getByRole("searchbox", { name: "Search workspace", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Reports", exact: true })
    .click();
  await expect(page).toHaveURL("/openview?section=reports");
  const held = gate();
  await page.route(`**/api/reports/${reportId}`, async (route) => {
    held.signalStarted();
    await held.wait;
    return route.fallback();
  });
  await page.getByLabel("Start from saved Report").selectOption(reportId);
  await page
    .getByRole("button", { name: "Start from saved Report", exact: true })
    .click();
  await held.started;
  try {
    await page.goBack();
    await expect(page).toHaveURL("/platform");
    const search = page.getByRole("searchbox", {
      name: "Search workspace",
      exact: true,
    });
    await expect(search).toBeVisible();
    const completed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/reports/${reportId}`,
    );
    held.release();
    await (await completed).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page).toHaveURL("/platform");
    await expect(search).toBeVisible();
  } finally {
    held.release();
  }
});

async function installArchivedReportPurge(
  page: Page,
  role: "admin" | "member" = "admin",
  failure = false,
) {
  await installReportsApi(
    page,
    false,
    { ...report, is_deleted: true },
    { role },
  );
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        display_name: "OpenSlate",
        mark: "OS",
        logo_file_id: null,
        revision: 1,
        today: "2026-09-25",
        week_start: "monday",
        locale: "en-US",
        timezone: "UTC",
        purge_enabled: true,
      },
    }),
  );
  const impact = {
    target_type: "report",
    target_id: reportId,
    operation: "purge",
    actor_id: userId,
    rows: [],
    external_impacts: [],
    key_strips: [],
    blockers: [],
    impact_digest: "a".repeat(64),
  };
  let purges = 0;
  let removed = false;
  await page.route(`**/api/reports/${reportId}/purge**`, (route) => {
    if (route.request().url().endsWith("/preview"))
      return route.fulfill({
        json: {
          impact,
          token: "owned-report-preview",
          expires_at: "2026-09-26T00:00:00Z",
          confirmation_name: report.name,
          last_successful_backup_at: "2026-09-24T00:00:00Z",
        },
      });
    purges += 1;
    expect(route.request().postDataJSON()).toEqual({
      token: "owned-report-preview",
      confirmation_name: report.name,
      password: "synthetic-report-password",
    });
    if (failure)
      return route.fulfill({
        status: 404,
        json: {
          detail: {
            code: "challenge_not_found",
            message: "private report internals",
          },
        },
      });
    removed = true;
    return route.fulfill({ json: { impact, operation_id: null } });
  });
  await page.route(`**/api/reports/${reportId}`, (route) =>
    removed
      ? route.fulfill({ status: 404, json: { detail: "Report not found" } })
      : route.fallback(),
  );
  await page.route("**/api/reports?**", (route) =>
    removed
      ? route.fulfill({ json: pageOf([], { limit: 25 }) })
      : route.fallback(),
  );
  return {
    get purges() {
      return purges;
    },
  };
}

for (const failure of [false, true]) {
  test(`archived Report purge ${failure ? "keeps its target and offers a fresh review for an unavailable challenge" : "confirms exact name and clears only its deleted selection"}`, async ({
    page,
  }) => {
    const api = await installArchivedReportPurge(page, "admin", failure);
    await page.goto(`/openview?section=reports&report=${reportId}`);
    await page.getByRole("button", { name: "Report options" }).click();
    await page
      .getByRole("menuitem", { name: "Permanently delete Report", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Permanently delete Report?",
    });
    await expect(review.getByText(/Last successful backup:/)).toBeVisible();
    await review
      .getByLabel("Type the Report name")
      .fill(report.name.toLowerCase());
    await review
      .getByLabel("Administrator password")
      .fill("synthetic-report-password");
    await expect(
      review.getByRole("button", {
        name: "Confirm permanent deletion",
        exact: true,
      }),
    ).toBeDisabled();
    expect(api.purges).toBe(0);
    await review.getByLabel("Type the Report name").fill(report.name);
    await review
      .getByRole("button", { name: "Confirm permanent deletion", exact: true })
      .click();
    if (failure) {
      await expect(
        review.getByText("The review is unavailable. Request a new review."),
      ).toBeVisible();
      await expect(review.getByLabel("Administrator password")).toHaveCount(0);
      await review
        .getByRole("button", { name: "Review again", exact: true })
        .click();
      await expect(review.getByLabel("Administrator password")).toHaveValue("");
      await review.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Report options" }).click();
      await expect(
        page.getByRole("menuitem", { name: "Restore Report", exact: true }),
      ).toBeVisible();
    } else {
      await expect(review).toBeHidden();
      await expect(page).toHaveURL(/section=reports$/);
      await expect(
        page.getByText("Report permanently deleted.", { exact: true }),
      ).toBeVisible();
    }
    expect(api.purges).toBe(1);
    await expect(page.getByText("private report internals")).toHaveCount(0);
  });
}

test("member may restore an archived Report but cannot permanently delete it", async ({
  page,
}) => {
  const api = await installArchivedReportPurge(page, "member");
  await page.goto(`/openview?section=reports&report=${reportId}`);
  await page.getByRole("button", { name: "Report options" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Restore Report", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", {
      name: "Permanently delete Report",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(api.purges).toBe(0);
});

test.describe("Report last-run summary", () => {
  test.use({ timezoneId: "America/Los_Angeles" });
  for (const state of ["none", "failed", "running"] as const) {
    test(`${state} last run is server-authored, regional and preserves schedule policy`, async ({
      page,
    }) => {
      const reader = state === "failed";
      const api = await installReportsApi(page, false, report, {
        savedSchedule: true,
        level: reader ? "read" : "manage",
        lastRun:
          state === "none"
            ? null
            : {
                state,
                finished_at: state === "failed" ? timestamp : null,
                failure_label: state === "failed" ? "Source unavailable" : null,
              },
      });
      await page.goto("/openview?section=reports");
      await page
        .getByRole("button", {
          name: /^Operations review(?: Field operations)?$/,
        })
        .click();
      await page.getByRole("tab", { name: "Schedule", exact: true }).click();
      if (state === "none")
        await expect(
          page.getByText("Last run: No runs yet", { exact: true }),
        ).toBeVisible();
      else {
        const summary = page.getByRole("status", {
          name: "Last scheduled run",
          exact: true,
        });
        await expect(summary).toContainText(
          state === "failed" ? "Failed" : "Running",
        );
        if (state === "failed") {
          await expect(summary).toContainText(/Sep 24, 2026.*8:00\sAM/);
          await expect(summary).toContainText("Source unavailable");
          await expect(
            page.getByRole("button", { name: "Save schedule", exact: true }),
          ).toHaveCount(0);
        } else await expect(summary).toContainText("Finish time not recorded");
      }
      if (!reader) {
        await page.getByLabel("Local time").fill("16:25");
        await page
          .getByRole("tab", { name: "Saved outputs", exact: true })
          .click();
        await page.getByRole("tab", { name: "Schedule", exact: true }).click();
        await expect(page.getByLabel("Local time")).toHaveValue("16:25");
      }
      expect(api.counts().scheduleWrites).toBe(0);
    });
  }
});
