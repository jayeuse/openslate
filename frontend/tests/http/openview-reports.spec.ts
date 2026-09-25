import { expect, test, type Page, type Route } from "@playwright/test";

const userId = "00000000-0000-4000-8000-000000000101";
const ownerId = "00000000-0000-4000-8000-000000000102";
const roleId = "00000000-0000-4000-8000-000000000108";
const duplicateReportId = "00000000-0000-4000-8000-000000000109";
const moduleId = "00000000-0000-4000-8000-000000000103";
const fieldId = "00000000-0000-4000-8000-000000000104";
const reportId = "00000000-0000-4000-8000-000000000105";
const runId = "00000000-0000-4000-8000-000000000106";
const scheduleId = "00000000-0000-4000-8000-000000000107";
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

const report = {
  id: reportId,
  owner_id: userId,
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
  audience: { kind: "private", role_id: null, user_id: null },
  is_deleted: false,
  created_at: timestamp,
  updated_at: timestamp,
};
type ReportFixture = Omit<typeof report, "audience"> & {
  audience: { kind: string; role_id: string | null; user_id: string | null };
};
const run = {
  id: runId,
  report_id: reportId,
  recipe_revision: 1,
  row_count: 1,
  headings: ["Asset"],
  created_at: timestamp,
};

async function installReportsApi(
  page: Page,
  sharedOnly = false,
  initialReport: ReportFixture = report,
) {
  const sourceReport = initialReport;
  let copiedReport: Record<string, unknown> | null = null;
  let manualRuns = 0;
  let scheduleWrites = 0;
  let csvReads = 0;
  let reportCreates = 0;
  let reportUpdates = 0;
  const createdReports: Array<{ request: unknown; response: unknown }> = [];
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
        role_id: roleId,
        role: "member",
        permissions: ["records.read", "records.write"],
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
        owner_id: userId,
        module_id: body.module_id,
        name: body.name,
        subtitle: body.subtitle,
        recipe: body.recipe,
        audience: body.audience ?? {
          kind: "private",
          role_id: null,
          user_id: null,
        },
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
        body: JSON.stringify(sourceReport),
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
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ...sourceReport, revision: 2 }),
      });
    }
    if (path === "/api/reports/shared-runs")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageOf(
            sharedOnly
              ? [
                  {
                    ...run,
                    report_name: "Shared operations review",
                    status: "succeeded",
                  },
                ]
              : [],
          ),
        ),
      });
    if (path === "/api/reports" && method === "GET")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageOf(
            sharedOnly
              ? []
              : copiedReport
                ? [sourceReport, copiedReport]
                : [sourceReport],
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
    if (path === `/api/reports/${reportId}/runs` && method === "GET")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pageOf(manualRuns ? [run] : [])),
      });
    if (path === `/api/reports/${reportId}/runs` && method === "POST") {
      manualRuns += 1;
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(run),
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
  };
}

test("connected Reports let an owner run, schedule, and export a saved recipe", async ({
  page,
}) => {
  const api = await installReportsApi(page);
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Operations review" }).click();
  await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("Report run saved with 1 row.")).toBeVisible();
  await expect(page.getByText("Recipe revision 1")).toBeVisible();
  await page.getByRole("checkbox", { name: "Enable scheduled runs" }).check();
  await page.getByRole("textbox", { name: "Timezone" }).fill("Asia/Manila");
  await page.getByRole("button", { name: "Create schedule" }).click();
  await expect(page.getByText("Schedule saved and enabled.")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV", exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`report-${runId}.csv`);
  expect(api.counts()).toEqual({
    manualRuns: 1,
    scheduleWrites: 1,
    csvReads: 1,
  });
});

test("connected Reports expose only authorized shared-run metadata to a reader", async ({
  page,
}) => {
  const api = await installReportsApi(page, true);
  await page.goto("/openview?section=reports");
  await expect(page.getByText("Shared operations review")).toBeVisible();
  await expect(page.getByText("No saved Reports")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV", exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`report-${runId}.csv`);
  expect(api.counts()).toEqual({
    manualRuns: 0,
    scheduleWrites: 0,
    csvReads: 1,
  });
});

test("excluded Report owner cannot run it while eligible scheduling stays available", async ({
  page,
}) => {
  const excluded = {
    ...report,
    audience: { kind: "user", role_id: null, user_id: ownerId },
  };
  const api = await installReportsApi(page, false, excluded);
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Operations review" }).click();

  await expect(page.getByRole("button", { name: "Run now" })).toBeDisabled();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "not included in this Report audience" }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Enable scheduled runs" }),
  ).toBeEnabled();
  expect(api.counts().manualRuns).toBe(0);
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
    page.getByText("Save to create a separate Report with the same audience."),
  ).toBeVisible();
  expect(api.reportCreates()).toBe(0);

  await page.getByRole("button", { name: "Create Report" }).click();
  await expect(page.getByText("Report created.")).toBeVisible();
  expect(api.reportCreates()).toBe(1);
  expect(api.reportUpdates()).toBe(0);
  expect(api.createdReports()[0]?.response).toMatchObject({
    id: duplicateReportId,
    owner_id: userId,
    name: "Copy of Operations review",
    audience: report.audience,
    recipe: report.recipe,
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Operations review", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "Report name" })).toHaveValue(
    "Operations review",
  );
  await page
    .getByRole("button", { name: "Copy of Operations review", exact: true })
    .click();
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
  await expect(page.getByText("Report created.")).toBeVisible();
  expect(api.reportCreates()).toBe(1);
  expect(api.reportUpdates()).toBe(0);
  expect(api.createdReports()[0]?.request).toMatchObject({
    name: "Copy of Operations review",
    audience: report.audience,
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
  await installReportsApi(page);
  await page.goto("/openview?section=reports");
  await page.getByRole("button", { name: "Operations review" }).click();
  await page
    .getByRole("textbox", { name: "Report name" })
    .fill("Unsaved review");
  await page.getByRole("link", { name: "Search workspace" }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "Discard unsaved Report changes?",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL("/openview?section=reports");
  await expect(page.getByRole("textbox", { name: "Report name" })).toHaveValue(
    "Unsaved review",
  );
  await page.getByRole("link", { name: "Search workspace" }).click();
  await dialog.getByRole("button", { name: "Discard and continue" }).click();
  await expect(page).toHaveURL("/platform");
});
