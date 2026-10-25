import { expect, test, type Page } from "./helpers/test";
import { readFile } from "node:fs/promises";
import { profilePreferences } from "./helpers/profile-api";
import {
  installModuleReportsApi,
  modulePage,
  reportIds,
  reportTimestamp,
  wireReport,
  wireRun,
  wireSchedule,
} from "./helpers/openview-reports-api";
import { wireView } from "../helpers/wire";

// OpenView part C (docs/specs/openview-reports-in-modules.md): a module's
// reports live on its module page. Records and Reports are the page's two
// views; a report reads as three steps (what it lists → when it runs → what
// you keep) with its latest copy under them.

const ids = reportIds;
const main = (page: Page) => page.locator("#main-content");
const reportsView = (page: Page) =>
  page.getByRole("navigation", { name: "Assets page" });
const reportRow = (page: Page, name = "Operations review") =>
  page
    .getByRole("list", { name: "Assets reports" })
    .getByRole("button", { name: new RegExp(`^${name}`) });
const steps = (page: Page) =>
  page.getByRole("list", { name: "How this report works" });
const copy = (page: Page) => page.getByRole("region", { name: /^Copy of / });

async function documentScrolls(page: Page) {
  return page.evaluate(
    () =>
      document.documentElement.scrollHeight > window.innerHeight + 1 ||
      document.documentElement.scrollWidth > window.innerWidth,
  );
}

test("a module page switches between Records and Reports and keeps its view in the address", async ({
  page,
}) => {
  await installModuleReportsApi(page);
  await page.goto(modulePage());
  const pages = reportsView(page);
  const records = pages.getByRole("link", { name: /^Records/ });
  const reports = pages.getByRole("link", { name: /^Reports/ });
  await expect(records).toHaveText("Records 1");
  await expect(records).toHaveAttribute("aria-current", "page");
  await expect(reports).toHaveText("Reports 1");
  await expect(
    main(page).getByText("Field operations · 1 record"),
  ).toBeVisible();

  await reports.click();
  await expect(page).toHaveURL(modulePage("reports"));
  await expect(reports).toHaveAttribute("aria-current", "page");
  await expect(
    main(page).getByText("Field operations · 1 report"),
  ).toBeVisible();
  // The Records controls belong to the Records view.
  await expect(
    page.getByRole("button", { name: "More view actions" }),
  ).toHaveCount(0);
  await expect(reportRow(page)).toBeVisible();

  await records.click();
  await expect(page).toHaveURL(modulePage());
  await expect(
    page.getByRole("button", { name: "More view actions" }),
  ).toBeVisible();
});

test("a report reads as three steps with its latest copy under them, and only its panels scroll", async ({
  page,
}) => {
  const api = await installModuleReportsApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(modulePage("reports"));
  const row = page
    .getByRole("list", { name: "Assets reports" })
    .getByRole("listitem")
    .filter({ hasText: "Operations review" });
  await expect(row).toContainText("Every Monday · 1 copy");
  await expect(row).toContainText("Scheduled");
  // The first report opens by itself; its row carries the selection.
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(row).toHaveAttribute("data-state", "selected");

  await expect(
    main(page).getByRole("heading", { level: 2, name: "Operations review" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Make a copy now" }),
  ).toBeVisible();
  await expect(steps(page).getByRole("listitem")).toHaveText([
    /^1 · What it listsAll assets1 column · Change$/,
    /^2 · When it runsEvery Monday at 9:00 AMNext: Mon, Sep 28 · Change$/,
    /^3 · What you keepA dated copy each time1 copy · latest Thu, Sep 24$/,
  ]);
  await expect(copy(page)).toContainText("Copy of Thu, Sep 24 at 8:00 AM");
  await expect(copy(page)).toContainText("1 row · as they were then");
  await expect(
    copy(page)
      .getByRole("table", { name: /^Copy of / })
      .getByRole("row"),
  ).toHaveText(["Asset", "Forklift"]);
  expect(api.state.csvReads).toBe(1);

  // EXIT-C4: the document never scrolls; the list and the copy do.
  expect(await documentScrolls(page)).toBe(false);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(copy(page)).toBeVisible();
  expect(await documentScrolls(page)).toBe(false);
});

test("Make a copy now makes one copy, shows it in place, and a retry reuses its key", async ({
  page,
}) => {
  const api = await installModuleReportsApi(page);
  await page.goto(modulePage("reports"));
  await expect(copy(page)).toContainText("Copy of Thu, Sep 24 at 8:00 AM");

  api.state.failNextRun = 503;
  const make = page.getByRole("button", { name: "Make a copy now" });
  await make.click();
  // The failure shows beside the action, in safe words.
  const failure = main(page).getByRole("alert");
  await expect(failure).toBeVisible();
  await expect(page.getByText("Private run failure detail")).toHaveCount(0);

  await make.click();
  await expect(copy(page)).toContainText("Copy of Sat, Sep 26 at 8:00 AM");
  await expect(copy(page)).toContainText("2 rows · as they were then");
  await expect(failure).toHaveCount(0);
  // One click made one copy: the retry sent the same request key.
  expect(api.state.runKeys).toHaveLength(2);
  expect(api.state.runKeys[1]).toBe(api.state.runKeys[0]);
  await expect(steps(page).getByRole("listitem").nth(2)).toContainText(
    "2 copies · latest Sat, Sep 26",
  );
  await expect(reportRow(page)).toContainText("Every Monday · 2 copies");
});

test("Older copies open the copy they name, and a link to an older copy opens it", async ({
  page,
}) => {
  const runs = Array.from({ length: 27 }, (_, index) =>
    wireRun({
      id: `00000000-0000-4000-8000-${String(600 + index).padStart(12, "0")}`,
      row_count: index + 1,
      created_at: `2026-09-${String(27 - index).padStart(2, "0")}T00:00:00Z`,
    }),
  );
  await installModuleReportsApi(page, { runs: { [ids.report]: runs } });
  await page.goto(modulePage("reports"));
  await expect(copy(page)).toContainText("Copy of Sun, Sep 27 at 8:00 AM");

  await page.getByRole("button", { name: "Older copies (26)" }).click();
  const choices = page.getByRole("menuitemradio");
  await expect(choices).toHaveCount(25);
  await expect(choices.first()).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: /^Sat, Sep 26/ }).click();
  await expect(page).toHaveURL(modulePage("reports", ids.report, runs[1]!.id));
  await expect(copy(page)).toContainText("Copy of Sat, Sep 26 at 8:00 AM");
  await expect(copy(page)).toContainText("2 rows · as they were then");

  // A link to a copy past the latest page reads that copy.
  await page.goto(modulePage("reports", ids.report, runs[26]!.id));
  await expect(copy(page)).toContainText("Copy of Tue, Sep 1 at 8:00 AM");
  await expect(copy(page)).toContainText("27 rows · as they were then");
});

const failedSchedule = wireSchedule({
  last_run: {
    state: "failed",
    finished_at: reportTimestamp,
    failure_label: "Source unavailable",
  },
});

for (const who of [
  { role: "member", level: "read", copies: true },
  { role: "guest", level: "read", copies: false },
] as const)
  test(`a ${who.role} reader sees the steps without Change and no manager tools`, async ({
    page,
  }) => {
    await installModuleReportsApi(page, {
      role: who.role,
      level: who.level,
      schedules: { [ids.report]: failedSchedule },
    });
    await page.goto(modulePage("reports"));
    await expect(steps(page)).toBeVisible();
    // Readers see the same three steps without Change, and no manager tools.
    await expect(steps(page).getByRole("button")).toHaveCount(0);
    await expect(steps(page).getByText("Change", { exact: true })).toHaveCount(
      0,
    );
    await expect(steps(page).getByRole("listitem").nth(1)).toContainText(
      "Last run failed · Source unavailable",
    );
    await expect(
      page.getByRole("button", { name: "More report actions" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New report" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: /^Show: / })).toHaveCount(0);
    const make = page.getByRole("button", { name: "Make a copy now" });
    if (who.copies) await expect(make).toBeEnabled();
    else {
      await expect(make).toHaveAttribute("aria-disabled", "true");
      await expect(make).toHaveAccessibleDescription(
        "Guests cannot make copies.",
      );
    }
    // Making a report from a view is a manager's action too.
    await reportsView(page)
      .getByRole("link", { name: /^Records/ })
      .click();
    await page.getByRole("button", { name: "More view actions" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Make a report from this view…" }),
    ).toHaveCount(0);
  });

test.describe("schedules in a non-UTC browser timezone", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("step 2 opens the schedule, and Save schedule waits for a change", async ({
    page,
  }) => {
    const api = await installModuleReportsApi(page, { schedules: {} });
    await page.goto(modulePage("reports"));
    await expect(steps(page).getByRole("listitem").nth(1)).toContainText(
      "When someone makes a copyNot scheduled",
    );
    await expect(reportRow(page)).toContainText(
      "When someone makes a copy · 1 copy",
    );
    const change = page.getByRole("button", { name: "Change when it runs" });
    await expect(change).toHaveAttribute("aria-expanded", "false");
    await change.click();
    await expect(change).toHaveAttribute("aria-expanded", "true");
    const schedule = page.getByRole("form", { name: "Schedule" });
    const save = schedule.getByRole("button", { name: "Save schedule" });
    await expect(save).toBeDisabled();
    await expect(schedule.getByText("No changes to save")).toBeVisible();
    // The copy gives its place to the schedule while step 2 is open.
    await expect(copy(page)).toHaveCount(0);

    await schedule.getByRole("button", { name: "Weekly" }).click();
    await schedule.getByLabel("Day").selectOption("3");
    await schedule.getByLabel("Time", { exact: true }).fill("10:30");
    // The report's time zone is a choice, not the browser's.
    await schedule.getByLabel("Time zone").selectOption("Asia/Manila");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(schedule.getByText("Schedule saved.")).toBeVisible();
    expect(api.state.scheduleWrites).toEqual([
      {
        enabled: true,
        cadence: "weekly",
        timezone_name: "Asia/Manila",
        local_time: "10:30",
        weekday: 3,
        month_day: null,
      },
    ]);
    await expect(save).toBeDisabled();
    await expect(steps(page).getByRole("listitem").nth(1)).toContainText(
      "Every Thursday at 10:30 AM",
    );
    await expect(reportRow(page)).toContainText("Every Thursday · 1 copy");

    // Off keeps the policy and stops the copies.
    await schedule.getByRole("button", { name: "Off" }).click();
    await save.click();
    await expect(schedule.getByText("Schedule turned off.")).toBeVisible();
    expect(api.state.scheduleWrites[1]).toMatchObject({
      revision: 1,
      enabled: false,
      cadence: "weekly",
      weekday: 3,
      local_time: "10:30",
    });
    await change.click();
    await expect(copy(page)).toBeVisible();
  });
});

test("copy dates follow personal display while the copy and its CSV stay as they were", async ({
  page,
}, testInfo) => {
  // Date-like cell text is server-owned output, never personally reformatted.
  const snapshot = '"Asset"\r\n"2026-09-24 08:00 · 2026-09-24"\r\n';
  const api = await installModuleReportsApi(page, { csv: snapshot });
  await page.route(`**/api/users/${ids.user}/preferences`, (route) =>
    route.fulfill({
      json: profilePreferences(ids.user, {
        timezone: "America/Los_Angeles",
        date_format: "ymd",
        time_format: "24h",
        week_start: "sunday",
      }),
    }),
  );
  await page.goto(modulePage("reports", ids.report, ids.run));
  await expect(copy(page)).toContainText("Copy of Wed, Sep 23 at 17:00");
  await expect(
    copy(page).getByRole("table", { name: /^Copy of / }),
  ).toContainText("2026-09-24 08:00 · 2026-09-24");
  const downloaded = page.waitForEvent("download");
  await copy(page)
    .getByRole("button", { name: /^Download CSV/ })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(`report-${ids.run}.csv`);
  const path = testInfo.outputPath("frozen-report.csv");
  await download.saveAs(path);
  expect(await readFile(path, "utf8")).toBe(snapshot);
  // The CSV is the one the copy showed; it is not read again.
  expect(api.state.csvReads).toBe(1);
});

for (const level of ["manage", "read"] as const)
  test(`an empty module teaches the three steps, with actions only for a manager (${level})`, async ({
    page,
  }) => {
    await installModuleReportsApi(page, { level, reports: [] });
    await page.goto(modulePage("reports"));
    await expect(
      page.getByRole("heading", { name: "Keep a dated copy of these assets" }),
    ).toBeVisible();
    await expect(
      main(page).getByText("Field operations · no reports yet"),
    ).toBeVisible();
    await expect(
      page
        .getByRole("list", { name: "How a report works" })
        .getByRole("listitem"),
    ).toHaveText([
      /What it listsThe assets you chooseStart from the view you are using/,
      /When it runsNow, or every day, week, or monthAt a time you pick/,
      /What you keepA dated copy each timePrint it or download it later/,
    ]);
    const fromView = page.getByRole("button", {
      name: "Make a report from the current view",
    });
    const scratch = page.getByRole("button", { name: "Start from scratch" });
    if (level === "manage") {
      await expect(fromView).toBeVisible();
      await scratch.click();
      const dialog = page.getByRole("dialog", { name: "New report" });
      await expect(dialog.getByLabel("Name")).toHaveValue("");
      // The module is the page's: there is no module picker.
      await expect(dialog.getByLabel("Data source")).toHaveCount(0);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
    } else {
      await expect(fromView).toHaveCount(0);
      await expect(scratch).toHaveCount(0);
      await expect(page.getByText("No reports for Assets yet.")).toBeVisible();
    }
  });

test("Make a report from this view fills the new report with the view's columns, filters and sort", async ({
  page,
}) => {
  const view = wireView({
    id: ids.view,
    module_id: ids.module,
    name: "Assets in service",
    definition: {
      version: 1,
      logic: "and",
      columns: [
        { field_id: ids.assetField, expected_type: "text" },
        { field_id: ids.statusField, expected_type: "select" },
      ],
      filters: [
        {
          field_id: ids.statusField,
          expected_type: "select",
          operator: "in",
          value: [ids.inService],
        },
      ],
      sort: [
        { field_id: ids.assetField, expected_type: "text", direction: "desc" },
      ],
      deleted: "exclude",
      search: null,
      search_fields: [],
    },
    presentation: {
      version: 1,
      layout: "table",
      column_field_ids: [ids.statusField, ids.assetField],
      pinned_field_ids: [],
      density: "comfortable",
      wrap: false,
      card_size: "comfortable",
      primary_field_id: null,
      secondary_field_id: null,
      date_field_id: null,
      group_by_field_id: null,
      date_range: "month",
      scale: null,
    },
    created_at: reportTimestamp,
    updated_at: reportTimestamp,
  });
  const api = await installModuleReportsApi(page, {
    reports: [],
    views: [view],
  });
  await page.goto(`${modulePage()}&view=${ids.view}`);
  await page.getByRole("button", { name: "More view actions" }).click();
  await page
    .getByRole("menuitem", { name: "Make a report from this view…" })
    .click();
  const dialog = page.getByRole("dialog", { name: "New report" });
  await expect(dialog.getByLabel("Name")).toHaveValue("Assets in service");
  await expect(dialog.getByRole("checkbox", { name: "Asset" })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Status" })).toBeChecked();
  await dialog.getByRole("button", { name: "Create report" }).click();
  await expect(dialog).toBeHidden();
  expect(api.state.creates).toEqual([
    {
      module_id: ids.module,
      name: "Assets in service",
      subtitle: null,
      recipe: {
        version: 1,
        fields: [
          { field_id: ids.statusField, expected_type: "select" },
          { field_id: ids.assetField, expected_type: "text" },
        ],
        filters: [
          {
            field_id: ids.statusField,
            expected_type: "select",
            operator: "in",
            value: [ids.inService],
          },
        ],
        logic: "and",
        sorts: [
          {
            field_id: ids.assetField,
            expected_type: "text",
            direction: "desc",
          },
        ],
        group_by: null,
        include_row_count: false,
      },
    },
  ]);
  // The new report opens in the Reports view.
  await expect(page).toHaveURL(
    `/openview?section=views&module=${ids.module}&tab=reports&view=${ids.view}&report=${ids.newReport}`,
  );
  await expect(
    main(page).getByRole("heading", { level: 2, name: "Assets in service" }),
  ).toBeVisible();
  await expect(steps(page).getByRole("listitem").first()).toContainText(
    "Assets that match 1 filter",
  );
});

test("editing a report saves its revision, and a conflict offers the latest", async ({
  page,
}) => {
  const api = await installModuleReportsApi(page);
  await page.goto(modulePage("reports"));
  await page.getByRole("button", { name: "Change what it lists" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit report" });
  await dialog.getByLabel("Name").fill("Weekly assets");
  await dialog.getByRole("checkbox", { name: "Status" }).check();
  await dialog.getByRole("checkbox", { name: "Include row count" }).check();
  await dialog.getByRole("button", { name: "Save report" }).click();
  await expect(dialog).toBeHidden();
  expect(api.state.updates[0]).toMatchObject({
    revision: 1,
    name: "Weekly assets",
    recipe: {
      fields: [
        { field_id: ids.assetField, expected_type: "text" },
        { field_id: ids.statusField, expected_type: "select" },
      ],
      include_row_count: true,
    },
  });
  await expect(reportRow(page, "Weekly assets")).toBeVisible();
  await expect(steps(page).getByRole("listitem").first()).toContainText(
    "2 columns · with the number of rows",
  );

  // Someone else saved in between: the dialog keeps the edit and offers the
  // latest report.
  api.state.conflictNextUpdate = true;
  await page.getByRole("button", { name: "Change what it lists" }).click();
  await dialog.getByLabel("Subtitle").fill("Mondays");
  await dialog.getByRole("button", { name: "Save report" }).click();
  await expect(
    dialog.getByRole("alert").filter({ hasText: /reload/i }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Subtitle")).toHaveValue("Mondays");
  page.once("dialog", (prompt) => void prompt.accept());
  await dialog.getByRole("button", { name: "Reload latest" }).click();
  await expect(dialog.getByLabel("Subtitle")).toHaveValue("");
  await dialog.getByLabel("Subtitle").fill("Mondays");
  await dialog.getByRole("button", { name: "Save report" }).click();
  await expect(dialog).toBeHidden();
  expect(api.state.updates.at(-1)).toMatchObject({
    revision: 3,
    subtitle: "Mondays",
  });
});

test("Report filters display Select labels, submit stable IDs, and use module-eligible people", async ({
  page,
}) => {
  const api = await installModuleReportsApi(page);
  const userFieldId = "00000000-0000-4000-8000-000000000130";
  const eligibleUserId = "00000000-0000-4000-8000-000000000131";
  const assignableUserRequests: string[] = [];
  const globalUserRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === `/api/modules/${ids.module}/assignable-users`)
      assignableUserRequests.push(path);
    if (
      (path === "/api/users" || path.startsWith("/api/users/")) &&
      !(
        path === `/api/users/${ids.user}/preferences` &&
        request.method() === "GET"
      )
    )
      globalUserRequests.push(path);
  });
  await page.route(
    `**/api/views/data-sources/${ids.module}/fields**`,
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: ids.assetField,
              module_id: ids.module,
              name: "Asset",
              type: "text",
              required: true,
              position: 0,
              config: {},
            },
            {
              id: ids.statusField,
              module_id: ids.module,
              name: "Status",
              type: "select",
              required: false,
              position: 1,
              config: {
                options: [
                  { id: ids.inService, label: "In service" },
                  { id: ids.inspectionDue, label: "Inspection due" },
                ],
              },
            },
            {
              id: userFieldId,
              module_id: ids.module,
              name: "Assignee",
              type: "user",
              required: false,
              position: 2,
              config: { kind: "user" },
            },
          ],
          pagination: {
            limit: 100,
            offset: 0,
            count: 3,
            total: 3,
            has_more: false,
          },
        },
      }),
  );
  await page.route(`**/api/modules/${ids.module}/assignable-users**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: eligibleUserId,
            display_name: "Alex Reader",
            username: "alex.reader",
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

  await page.goto(modulePage("reports"));
  await page.getByRole("button", { name: "New report" }).click();
  const editor = page.getByRole("dialog", { name: "New report" });
  await editor.getByLabel("Name").fill("Stable filters");
  await editor.getByRole("checkbox", { name: "Asset" }).check();
  await editor.getByRole("button", { name: "Add filter" }).click();
  await editor
    .getByRole("combobox", { name: "Field" })
    .nth(0)
    .selectOption(ids.statusField);
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

  await editor.getByRole("button", { name: "Create report" }).click();
  await expect(editor).toBeHidden();
  expect(api.state.creates[0]).toMatchObject({
    module_id: ids.module,
    recipe: {
      filters: [
        {
          field_id: ids.statusField,
          expected_type: "select",
          operator: "in",
          value: [ids.inService, ids.inspectionDue],
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

test("Duplicate opens a new report with the same recipe and creates a separate report", async ({
  page,
}) => {
  const api = await installModuleReportsApi(page);
  await page.goto(modulePage("reports"));
  await page.getByRole("button", { name: "More report actions" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  const dialog = page.getByRole("dialog", { name: "New report" });
  await expect(dialog.getByLabel("Name")).toHaveValue(
    "Copy of Operations review",
  );
  await expect(dialog.getByRole("checkbox", { name: "Asset" })).toBeChecked();
  await dialog.getByRole("button", { name: "Create report" }).click();
  await expect(dialog).toBeHidden();
  expect(api.state.updates).toEqual([]);
  expect(api.state.creates).toEqual([
    {
      module_id: ids.module,
      name: "Copy of Operations review",
      subtitle: null,
      recipe: wireReport().recipe,
    },
  ]);
  await expect(reportRow(page)).toBeVisible();
  await expect(reportRow(page, "Copy of Operations review")).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "Assets reports" })
      .getByRole("listitem")
      .filter({ hasText: "Copy of Operations review" }),
  ).toHaveAttribute("aria-current", "true");
});

test("archiving a report offers Undo, and the archived filter restores it", async ({
  page,
}) => {
  const api = await installModuleReportsApi(page, {
    reports: [
      wireReport(),
      wireReport({ id: ids.otherReport, name: "Spare parts" }),
    ],
  });
  await page.goto(modulePage("reports"));
  await page.getByRole("button", { name: "More report actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByText("Report archived.")).toBeVisible();
  await expect(reportRow(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(reportRow(page)).toBeVisible();
  expect(api.state.reports[0]).toMatchObject({
    is_deleted: false,
    revision: 3,
  });

  await page.getByRole("button", { name: "More report actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(reportRow(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Show: Active" }).click();
  await page.getByRole("menuitemradio", { name: "Archived" }).click();
  await reportRow(page).click();
  await expect(
    main(page).getByText("Restore this report to make or open its copies."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Make a copy now" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "More report actions" }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await expect(page.getByText("Report restored.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Show: Active" }),
  ).toBeVisible();
  await expect(reportRow(page)).toBeVisible();
});

async function installArchivedReportPurge(
  page: Page,
  role: "admin" | "member",
  failure = false,
) {
  const api = await installModuleReportsApi(page, {
    role,
    reports: [wireReport({ is_deleted: true })],
  });
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
    target_id: ids.report,
    operation: "purge",
    actor_id: ids.user,
    rows: [],
    external_impacts: [],
    key_strips: [],
    blockers: [],
    impact_digest: "a".repeat(64),
  };
  await page.route(`**/api/reports/${ids.report}/purge**`, (route) => {
    if (route.request().url().endsWith("/preview"))
      return route.fulfill({
        json: {
          impact,
          token: "owned-report-preview",
          expires_at: "2026-09-26T00:00:00Z",
          confirmation_name: "Operations review",
          last_successful_backup_at: "2026-09-24T00:00:00Z",
        },
      });
    api.state.purges += 1;
    expect(route.request().postDataJSON()).toEqual({
      token: "owned-report-preview",
      confirmation_name: "Operations review",
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
    api.state.reports = [];
    return route.fulfill({ json: { impact, operation_id: null } });
  });
  return api;
}

for (const failure of [false, true]) {
  test(`Delete forever ${failure ? "keeps the archived report and offers a fresh review for an unavailable challenge" : "confirms the exact name and leaves the module's Reports view"}`, async ({
    page,
  }) => {
    const api = await installArchivedReportPurge(page, "admin", failure);
    await page.goto(modulePage("reports", ids.report));
    await page.getByRole("button", { name: "More report actions" }).click();
    await page
      .getByRole("menuitem", { name: "Delete forever…", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Delete report forever?",
    });
    await expect(review.getByText(/Last successful backup:/)).toBeVisible();
    await review.getByLabel("Type the report name").fill("operations review");
    await review
      .getByLabel("Administrator password")
      .fill("synthetic-report-password");
    const confirm = review.getByRole("button", { name: "Delete forever" });
    await expect(confirm).toBeDisabled();
    expect(api.state.purges).toBe(0);
    await review.getByLabel("Type the report name").fill("Operations review");
    await confirm.click();
    if (failure) {
      await expect(
        review.getByText("The review is unavailable. Request a new review."),
      ).toBeVisible();
      await expect(review.getByLabel("Administrator password")).toHaveCount(0);
      await review.getByRole("button", { name: "Review again" }).click();
      await expect(review.getByLabel("Administrator password")).toHaveValue("");
      await review.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "More report actions" }).click();
      await expect(
        page.getByRole("menuitem", { name: "Restore", exact: true }),
      ).toBeVisible();
    } else {
      await expect(review).toBeHidden();
      await expect(page).toHaveURL(modulePage("reports"));
      await expect(page.getByText("Report deleted forever.")).toBeVisible();
    }
    expect(api.state.purges).toBe(1);
    await expect(page.getByText("private report internals")).toHaveCount(0);
  });
}

test("a manager who is not an administrator may restore an archived report but not delete it forever", async ({
  page,
}) => {
  const api = await installArchivedReportPurge(page, "member");
  await page.goto(modulePage("reports", ids.report));
  await page.getByRole("button", { name: "More report actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Restore", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Delete forever…" }),
  ).toHaveCount(0);
  expect(api.state.purges).toBe(0);
});

test("a copy that cannot be read and a blocked print window each say what went wrong", async ({
  page,
}) => {
  const api = await installModuleReportsApi(page);
  let failRead = true;
  await page.route(
    `**/api/reports/${ids.report}/runs/${ids.run}/csv`,
    (route) =>
      failRead
        ? route.fulfill({
            status: 500,
            json: {
              detail: "Your browser blocked private report database detail",
            },
          })
        : route.fallback(),
  );
  await page.goto(modulePage("reports"));
  const failure = copy(page).getByRole("alert");
  await expect(failure).toContainText(
    "The copy could not be opened. Try again.",
  );
  await expect(failure).toHaveAttribute("data-variant", "destructive");
  await expect(page.getByText(/private report database detail/)).toHaveCount(0);

  failRead = false;
  await failure.getByRole("button", { name: "Retry" }).click();
  await expect(
    copy(page).getByRole("table", { name: /^Copy of / }),
  ).toContainText("Forklift");
  const reads = api.state.csvReads;
  await page.evaluate(() => {
    window.open = () => null;
  });
  await copy(page).getByRole("button", { name: "Print" }).click();
  await expect(
    copy(page).getByRole("alert").filter({
      hasText:
        "Your browser blocked the print window. Allow pop-ups and try again.",
    }),
  ).toBeVisible();
  expect(api.state.csvReads).toBe(reads);
});

test("old report links open the report and its copy on the module page, or say the report is not available", async ({
  page,
}) => {
  const runs = Array.from({ length: 30 }, (_, index) =>
    wireRun({
      id: `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}`,
      created_at: `2026-09-${String(30 - index).padStart(2, "0")}T00:00:00Z`,
    }),
  );
  const api = await installModuleReportsApi(page, {
    otherModule: true,
    runs: { [ids.report]: runs, [ids.otherReport]: [] },
    reports: [
      wireReport(),
      wireReport({
        id: ids.otherReport,
        module_id: ids.otherModule,
        name: "Invoice review",
      }),
    ],
  });
  // A notification link names a copy past the latest page (DC8).
  await page.goto(
    `/openview?section=reports&report=${ids.report}&run=${runs[29]!.id}`,
  );
  await expect(page).toHaveURL(modulePage("reports", ids.report, runs[29]!.id));
  await expect(copy(page)).toContainText("Copy of Tue, Sep 1 at 8:00 AM");
  await expect(
    page
      .getByRole("list", { name: "Assets reports" })
      .getByRole("listitem")
      .filter({ hasText: "Operations review" }),
  ).toHaveAttribute("aria-current", "true");

  // A report of another module opens on that module's page.
  await page.goto(`/openview?section=reports&report=${ids.otherReport}`);
  await expect(page).toHaveURL(
    new RegExp(
      `module=${ids.otherModule}&tab=reports&report=${ids.otherReport}$`,
    ),
  );
  await expect(
    main(page).getByRole("heading", { level: 2, name: "Invoice review" }),
  ).toBeVisible();

  // A gone report lands on the first readable module with one line.
  await page.goto(`/openview?section=reports&report=${ids.goneReport}`);
  await expect(page).toHaveURL(modulePage("reports", ids.goneReport));
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "This report is not available." }),
  ).toBeVisible();
  expect(
    api.state.reportReads.filter((read) => read === ids.goneReport),
  ).not.toHaveLength(0);

  // The old Reports page address opens the first module's Reports view.
  await page.goto("/openview?section=reports");
  await expect(page).toHaveURL(modulePage("reports"));
  await expect(reportRow(page)).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the list and the report are separate screens, and a copy opens full screen", async ({
    page,
  }) => {
    await installModuleReportsApi(page);
    await page.goto(modulePage("reports"));
    // Records and Reports sit under the title.
    const title = page.getByRole("heading", { level: 1, name: "Assets" });
    const pages = reportsView(page);
    const titleBox = await title.boundingBox();
    const pagesBox = await pages.boundingBox();
    expect(pagesBox!.y).toBeGreaterThan(titleBox!.y + titleBox!.height);
    await expect(steps(page)).toBeHidden();

    await reportRow(page).click();
    await expect(page).toHaveURL(modulePage("reports", ids.report));
    await expect(reportRow(page)).toBeHidden();
    await expect(steps(page)).toBeVisible();
    await page.getByRole("button", { name: "Open copy" }).click();
    const full = page.getByRole("dialog", { name: "Operations review" });
    await expect(full.getByRole("table", { name: /^Copy of / })).toContainText(
      "Forklift",
    );
    // The sheet slides in, then covers the whole screen.
    await expect
      .poll(async () => {
        const box = await full.boundingBox();
        return box && [box.x, box.y, box.width, box.height];
      })
      .toEqual([0, 0, 390, 844]);
    await full.getByRole("button", { name: "Close copy" }).click();

    // EXIT-C5: every target is at least 44px and nothing scrolls sideways.
    const small = await page.evaluate(
      () =>
        [...document.querySelectorAll("#main-content :is(a, button)")]
          .map((element) => element.getBoundingClientRect())
          .filter(
            (rect) => rect.width > 0 && (rect.height < 44 || rect.width < 44),
          ).length,
    );
    expect(small).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    await page.getByRole("button", { name: "Back to reports" }).click();
    await expect(page).toHaveURL(modulePage("reports"));
    await expect(reportRow(page)).toBeVisible();
  });
});
