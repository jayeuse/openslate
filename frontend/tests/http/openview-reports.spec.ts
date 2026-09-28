import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "./helpers/test";

const userId = "00000000-0000-4000-8000-000000000101";
const ownerId = "00000000-0000-4000-8000-000000000102";
const duplicateReportId = "00000000-0000-4000-8000-000000000109";
const moduleId = "00000000-0000-4000-8000-000000000103";
const fieldId = "00000000-0000-4000-8000-000000000104";
const reportId = "00000000-0000-4000-8000-000000000105";
const runId = "00000000-0000-4000-8000-000000000106";
const scheduleId = "00000000-0000-4000-8000-000000000107";
const timestamp = "2026-09-24T00:00:00Z";

function pageOf<T>(items: T[], limit = 25, offset = 0, total = items.length) {
  return {
    items,
    pagination: {
      limit,
      offset,
      count: items.length,
      total,
      has_more: offset + items.length < total,
    },
  };
}

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
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userId,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: userId,
        role: "member",
        access: [
          {
            department_id: ownerId,
            module_id: null,
            level: options.level ?? "manage",
          },
        ],
      }),
    }),
  );
  await page.route("**/api/views/data-sources**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/views/data-sources")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageOf(
            [{ id: moduleId, name: "Assets", department_id: ownerId }],
            100,
          ),
        ),
      });
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
          pageOf(
            sharedRuns.slice(offset, offset + limit),
            limit,
            offset,
            sharedRuns.length,
          ),
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
              : copiedReport
                ? [currentReport, copiedReport]
                : [currentReport],
          ),
        ),
      });
    if (path === `/api/reports/${reportId}/schedule` && method === "GET")
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Report schedule not found" }),
      });
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
          pageOf(
            ownerRuns.slice(offset, offset + limit),
            limit,
            offset,
            ownerRuns.length,
          ),
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
        .getByText(/Sep 24, 2026.*12:00 AM UTC/),
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

test("failed owned output page does not relabel old results or leave their actions available", async ({
  page,
}) => {
  await installReportsApi(page, false, report, {
    ownerRunCount: 26,
    failOwnedSecondPage: true,
  });
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Operations review" }).click();
  await expect(
    page.getByRole("table", { name: "Saved outputs" }),
  ).toBeVisible();
  await expect(
    page.getByText("Recipe version 1", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Saved output pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Report history could not be loaded" }),
  ).toBeVisible();
  await expect(page.getByText("Recipe version 1", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: /Download CSV/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /Print output from/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Recipe version 26")).toBeVisible();
});

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

test("failed available output page does not relabel old results or leave their actions available", async ({
  page,
}) => {
  await installReportsApi(page, true, report, { failSharedSecondPage: true });
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Available outputs" }).click();
  const outputs = page.getByRole("dialog", { name: "Available outputs" });
  await expect(
    outputs.getByText("Recipe version 1", { exact: true }),
  ).toBeVisible();
  await outputs
    .getByRole("navigation", { name: "Available output pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(
    outputs
      .getByRole("alert")
      .filter({ hasText: "Available runs could not be loaded" }),
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
  const api = await installReportsApi(page, false, report, { level: "read" });
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
    page.getByText("Only a manager of this department changes the schedule."),
  ).toBeVisible();
  expect(api.counts().manualRuns).toBe(0);
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
        pagination: {
          limit: 100,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      },
    }),
  );
  await page.goto("/openview?section=reports");
  const card = page.getByRole("button", { name: /^Operations review/ });
  await expect(card).toContainText("Field operations");
  await expect(card).toHaveAccessibleName("Operations review Field operations");
});

test("duplicating a saved Report creates a separate draft on its first Save", async ({
  page,
}) => {
  const api = await installReportsApi(page);
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Operations review" }).click();
  await page.getByRole("button", { name: "Duplicate" }).click();

  await expect(page.getByRole("textbox", { name: "Report name" })).toHaveValue(
    "Copy of Operations review",
  );
  await expect(
    page.getByText("Save to create a separate Report."),
  ).toBeVisible();
  expect(api.reportCreates()).toBe(0);

  await page.getByRole("button", { name: "Create Report" }).click();
  await expect(
    page.locator("#main-content").getByText("Report created."),
  ).toBeVisible();
  expect(api.reportCreates()).toBe(1);
  expect(api.reportUpdates()).toBe(0);
  expect(api.createdReports()[0]?.response).toMatchObject({
    id: duplicateReportId,
    name: "Copy of Operations review",
    recipe: report.recipe,
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Operations review", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit report" }).click();
  await expect(page.getByRole("textbox", { name: "Report name" })).toHaveValue(
    "Operations review",
  );
  await page.getByRole("button", { name: "Close editor" }).click();
  await page
    .getByRole("button", { name: "Copy of Operations review", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit report" }).click();
  await expect(page.getByRole("textbox", { name: "Report name" })).toHaveValue(
    "Copy of Operations review",
  );
});

test("a saved Report can start an independent new Report through the template chooser", async ({
  page,
}) => {
  const api = await installReportsApi(page);
  await page.goto("/openview?section=reports");
  await page.getByLabel("Start from saved Report").selectOption(reportId);
  await page.getByRole("button", { name: "Start from saved Report" }).click();

  await expect(page.getByRole("textbox", { name: "Report name" })).toHaveValue(
    "Copy of Operations review",
  );
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
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Operations review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Copy of Operations review",
      exact: true,
    }),
  ).toBeVisible();
});

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
  await expect(page).toHaveURL("/openview?section=reports");
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

  await expect(editor).not.toBeVisible();
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
