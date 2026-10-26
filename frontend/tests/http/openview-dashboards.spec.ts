import { expect, test } from "@playwright/test";
import { sendOpenViewEvent } from "./helpers/openview-event-source";
import {
  at,
  checksTable,
  dashboardWire,
  equipmentBar,
  equipmentNumber,
  homeUrl,
  ids,
  installDashboardApi,
  invoicesNumber,
  manager,
  reader,
  card,
  editLayout,
} from "./helpers/openview-dashboard-api";

// docs/specs/openview-dashboard.md, part B: the department dashboard.

test("each department's Dashboard row opens its home dashboard, read once per module", async ({
  page,
}) => {
  const api = await installDashboardApi(page, { identity: manager });
  await page.goto("/openview?section=dashboards");
  // The address names the first department, so the sidebar and the
  // breadcrumb follow it (BD1).
  await expect(page).toHaveURL(homeUrl);
  const group = page.getByRole("list", { name: "Field service pages" });
  await expect(group.getByRole("link")).toHaveText([
    "Dashboard",
    "Equipment",
    "Quality checks",
  ]);
  await expect(group.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("navigation", { name: "breadcrumb" })).toHaveText(
    /^Field service\s*Dashboard$/,
  );
  // Reports live on module pages, so the sidebar has no OpenView item
  // (EXIT-B1, DC9).
  await expect(page.getByRole("button", { name: "OpenView" })).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: /^(Dashboards|Charts|Reports)$/ }),
  ).toHaveCount(0);

  await expect(
    page.getByRole("heading", { level: 1, name: "Field service dashboard" }),
  ).toBeVisible();
  await expect(card(page, "Number of Equipment")).toContainText("12");
  await expect(card(page, "Equipment by Category")).toContainText("Repair");
  await expect(card(page, "Quality checks by Result")).toContainText(
    "1–2 of 2",
  );
  // One read per module (BD6): Equipment's two widgets share one batch.
  expect(
    api.batches.map((batch) => [batch.moduleIds.join(), batch.count]).sort(),
  ).toEqual(
    [
      [ids.equipment, 2],
      [ids.checks, 1],
    ].sort(),
  );
});

test("a widget on a module the viewer cannot read is a locked card while the others load", async ({
  page,
}) => {
  await installDashboardApi(page, {
    identity: reader,
    hidden: [ids.invoices],
    dashboards: [
      dashboardWire({
        widgets: [equipmentNumber(), invoicesNumber(), equipmentBar()],
      }),
    ],
  });
  await page.goto(homeUrl);
  const locked = card(page, "Number");
  await expect(locked).toContainText("No access to these records");
  await expect(locked).toContainText("Ask an administrator for access.");
  await expect(card(page, "Number of Equipment")).toContainText("12");
  await expect(card(page, "Equipment by Category")).toContainText("Repair");
  await expect(page.getByText("OpenView data is unavailable")).toHaveCount(0);
  // A reader sees the dashboard, with no layout controls (BD2).
  await expect(page.getByRole("button", { name: "Edit layout" })).toHaveCount(
    0,
  );
});

test("a source in a linked department names that department on its card", async ({
  page,
}) => {
  await installDashboardApi(page, {
    identity: manager,
    dashboards: [dashboardWire({ widgets: [invoicesNumber()] })],
  });
  await page.goto(homeUrl);
  const linked = card(page, "Number of Invoices");
  await expect(linked).toContainText("Finance");
  await expect(linked).toContainText("12");
});

test("a department without a dashboard offers its managers the presets and tells readers none exists", async ({
  page,
}) => {
  const api = await installDashboardApi(page, {
    identity: manager,
    dashboards: [],
  });
  await page.goto(homeUrl);
  await expect(
    page.getByRole("heading", { name: "Set up the Field service dashboard" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Overview" }).click();
  // The preset places empty spaces; each asks for its chart.
  await expect(page.getByRole("button", { name: "Add a number" })).toHaveCount(
    4,
  );
  await expect(
    page.getByRole("button", { name: "Add a bar chart" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add a bar chart" }).click();
  const builder = page.getByRole("dialog", { name: "Add a chart" });
  await expect(builder).toContainText("2 × 2 space");
  await expect(builder.getByRole("radio", { name: "Bar" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await builder.getByRole("button", { name: "Add to dashboard" }).click();
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Field service dashboard" }),
  ).toBeVisible();
  const created = api.writes.find((write) => write.method === "POST");
  expect(created?.body).toEqual({
    department_id: ids.department,
    name: "Field service dashboard",
    position: 0,
    refresh_cadence: "manual",
    widgets: [
      {
        widget_type: "chart",
        grid_column: 0,
        grid_row: 1,
        column_span: 2,
        row_span: 2,
        chart_id: null,
        config: {
          version: 1,
          chart_type: "bar",
          query: {
            mode: "groups",
            module_id: ids.equipment,
            definition: {
              version: 1,
              logic: "and",
              columns: [],
              filters: [],
              sort: [],
              deleted: "exclude",
              search: null,
              search_fields: [],
            },
            aggregation: "count",
            measure: null,
            dimension: { field_id: ids.category, expected_type: "select" },
          },
        },
      },
    ],
  });
});

test("a reader of a department without a dashboard sees that none exists", async ({
  page,
}) => {
  await installDashboardApi(page, { identity: reader, dashboards: [] });
  await page.goto(homeUrl);
  await expect(
    page.getByRole("heading", { name: "No dashboard yet" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Overview" })).toHaveCount(0);
});

test("a manager arranges the layout with the keyboard alone and saves one update with the revision", async ({
  page,
}) => {
  const api = await installDashboardApi(page, {
    identity: manager,
    dashboards: [
      dashboardWire({ widgets: [equipmentNumber(), equipmentBar()] }),
    ],
  });
  await page.goto(homeUrl);
  await editLayout(page);
  const handle = page.getByRole("button", {
    name: "Move or resize Number of Equipment",
  });
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("status").filter({ hasText: "Moved" }),
  ).toHaveText("Moved: column 2, row 1, 1 × 1.");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(
    page.getByRole("status").filter({ hasText: "Resized" }),
  ).toHaveText("Resized: column 2, row 1, 2 × 1.");
  // A number is one row high: the size rules stop the change and say why.
  await page.keyboard.press("Shift+ArrowDown");
  await expect(
    page.getByRole("status").filter({ hasText: "Not changed" }),
  ).toHaveText("Not changed: too large for a number.");
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByRole("toolbar", { name: "Edit layout" })).toHaveCount(
    0,
  );
  const save = api.writes.find((write) => write.method === "PATCH");
  expect(save?.body?.revision).toBe(3);
  expect(
    (save?.body?.widgets as Record<string, unknown>[]).map((item) => [
      item.widget_type,
      item.grid_column,
      item.grid_row,
      item.column_span,
      item.row_span,
    ]),
  ).toEqual([
    ["summary", 1, 0, 2, 1],
    ["chart", 0, 1, 2, 2],
  ]);
});

test("the widget menu lists every size with the reason it cannot be taken, and moves", async ({
  page,
}) => {
  const api = await installDashboardApi(page, {
    identity: manager,
    dashboards: [dashboardWire({ widgets: [equipmentBar(at(2, 1, 2, 2))] })],
  });
  await page.goto(homeUrl);
  await editLayout(page);
  await card(page, "Equipment by Category")
    .getByRole("button", { name: "Equipment by Category, actions" })
    .click();
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitemradio", { name: /^1 × 1/ }),
  ).toContainText("too small for a bar chart");
  await expect(
    menu.getByRole("menuitemradio", { name: /^1 × 1/ }),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(
    menu.getByRole("menuitemradio", { name: /^2 × 2/ }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    menu.getByRole("menuitem", { name: /^Move right/ }),
  ).toContainText("at the edge");
  await menu.getByRole("menuitem", { name: "Move left" }).click();
  await card(page, "Equipment by Category")
    .getByRole("button", { name: "Equipment by Category, actions" })
    .click();
  await page.getByRole("menuitemradio", { name: /^3 × 3/ }).click();
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByRole("toolbar", { name: "Edit layout" })).toHaveCount(
    0,
  );
  const saved = api.writes.at(-1)?.body?.widgets as Record<string, unknown>[];
  expect(saved[0]).toMatchObject({
    grid_column: 1,
    grid_row: 1,
    column_span: 3,
    row_span: 3,
  });
});

test("dragging a widget by pointer moves it to the cells under it", async ({
  page,
}) => {
  await page.clock.install();
  const api = await installDashboardApi(page, {
    identity: manager,
    dashboards: [dashboardWire({ widgets: [equipmentNumber()] })],
  });
  await page.goto(homeUrl);
  await editLayout(page);
  const handle = page.getByRole("button", {
    name: "Move or resize Number of Equipment",
  });
  const target = page.getByRole("button", {
    name: "Add a widget at column 3, row 2",
  });
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("The grid is not laid out");
  const cell = await card(page, "Number of Equipment").boundingBox();
  if (!cell) throw new Error("The card is not laid out");
  // Grab the handle and drop the card's corner on column 3, row 2.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 20, { steps: 4 });
  await page.mouse.move(
    from.x + from.width / 2 + (to.x - cell.x),
    from.y + from.height / 2 + (to.y - cell.y),
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Add a widget at column 3, row 2" }),
  ).toHaveCount(0);
  // The drop swallows clicks for 50ms (dnd-kit), as it does for a person.
  await page.clock.runFor(100);
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByRole("toolbar", { name: "Edit layout" })).toHaveCount(
    0,
  );
  expect(api.writes.at(-1)?.body?.widgets).toMatchObject([
    { grid_column: 2, grid_row: 1, column_span: 1, row_span: 1 },
  ]);
});

test("a layout refusal marks the widget it names, and a conflict keeps the edit and offers a reload", async ({
  page,
}) => {
  const api = await installDashboardApi(page, {
    identity: manager,
    dashboards: [
      dashboardWire({ widgets: [equipmentNumber(), equipmentBar()] }),
    ],
  });
  await page.goto(homeUrl);
  await editLayout(page);
  await page
    .getByRole("button", { name: "Move or resize Number of Equipment" })
    .focus();
  await page.keyboard.press("ArrowRight");
  api.nextSaveFailure = {
    status: 422,
    detail: {
      code: "dashboard_layout_invalid",
      message: "The dashboard layout does not fit the grid",
      errors: [
        { index: 1, code: "overlap", message: "This widget overlaps widget 1" },
      ],
    },
  };
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(
    card(page, "Equipment by Category").getByRole("alert"),
  ).toHaveText("This widget overlaps widget 1.");
  await expect(
    page.getByRole("toolbar", { name: "Edit layout" }),
  ).toBeVisible();

  api.nextSaveFailure = {
    status: 409,
    detail: { code: "stale_revision", current_revision: 4 },
  };
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(
    page.getByText(
      "Someone changed this dashboard while you were editing. Your layout is still here.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("toolbar", { name: "Edit layout" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Discard my changes and reload" })
    .click();
  await expect(page.getByRole("toolbar", { name: "Edit layout" })).toHaveCount(
    0,
  );
});

test("leaving with unsaved layout changes asks first", async ({ page }) => {
  await installDashboardApi(page, {
    identity: manager,
    dashboards: [dashboardWire({ widgets: [equipmentNumber()] })],
  });
  await page.goto(homeUrl);
  await editLayout(page);
  await page
    .getByRole("button", { name: "Move or resize Number of Equipment" })
    .focus();
  await page.keyboard.press("ArrowDown");
  await page
    .getByRole("list", { name: "Field service pages" })
    .getByRole("link", { name: "Equipment" })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: "Leave without saving the layout?",
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(homeUrl);
  await expect(
    page.getByRole("toolbar", { name: "Edit layout" }),
  ).toBeVisible();
});

test("a preset replaces the layout only after a confirmation", async ({
  page,
}) => {
  await installDashboardApi(page, { identity: manager });
  await page.goto(homeUrl);
  await editLayout(page);
  await page.getByRole("button", { name: "Presets" }).click();
  await page.getByRole("menuitem", { name: "Lists first" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Replace the layout with Lists first?",
  });
  await confirm.getByRole("button", { name: "Keep this layout" }).click();
  await expect(card(page, "Equipment by Category")).toBeVisible();
  await page.getByRole("button", { name: "Presets" }).click();
  await page.getByRole("menuitem", { name: "Lists first" }).click();
  await confirm.getByRole("button", { name: "Replace the layout" }).click();
  await expect(card(page, "Equipment by Category")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add a records list" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add a pie chart" }),
  ).toBeVisible();
});

test("a widget the grid migration could not place must be placed before the layout saves", async ({
  page,
}) => {
  const lost = equipmentNumber({
    grid_column: null,
    grid_row: null,
    column_span: null,
    row_span: null,
  });
  await installDashboardApi(page, {
    identity: manager,
    dashboards: [dashboardWire({ widgets: [equipmentBar(), lost] })],
  });
  await page.goto(homeUrl);
  await editLayout(page);
  const save = page.getByRole("button", { name: "Save layout" });
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await expect(save).toHaveAccessibleDescription(
    "Place or remove the widgets that are not on the grid",
  );
  await page
    .getByRole("region", { name: "Not on the grid" })
    .getByRole("button", { name: "Place it" })
    .click();
  await expect(
    page.getByRole("region", { name: "Not on the grid" }),
  ).toHaveCount(0);
  await expect(save).not.toHaveAttribute("aria-disabled", "true");
});

test("phones stack the widgets in reading order and keep the layout for larger screens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installDashboardApi(page, {
    identity: manager,
    dashboards: [
      dashboardWire({
        widgets: [
          checksTable(at(2, 1, 2, 2)),
          equipmentBar(at(0, 1, 2, 2)),
          equipmentNumber(at(0, 0, 1, 1)),
        ],
      }),
    ],
  });
  await page.goto(homeUrl);
  await expect(page.locator("#main-content article")).toHaveCount(3);
  await expect(
    page
      .locator("#main-content article")
      .evaluateAll((cards) =>
        cards.map((element) => element.getAttribute("aria-label")),
      ),
  ).resolves.toEqual([
    "Number of Equipment",
    "Equipment by Category",
    "Quality checks by Result",
  ]);
  const edit = page.getByRole("button", { name: "Edit layout" });
  await expect(edit).toHaveAttribute("aria-disabled", "true");
  await expect(edit).toHaveAccessibleDescription(
    "Edit the layout on a larger screen.",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBe(0);
});

test("settings rename the dashboard and set its refresh with the saved revision", async ({
  page,
}) => {
  const api = await installDashboardApi(page, { identity: manager });
  await page.goto(homeUrl);
  await page.getByRole("button", { name: "More dashboard actions" }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  const dialog = page.getByRole("dialog", { name: "Dashboard settings" });
  await dialog.getByLabel("Name").fill("Service floor");
  await dialog.getByLabel("Refresh").selectOption("one-minute");
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Service floor" }),
  ).toBeVisible();
  await expect(page.getByText(/· every minute$/)).toBeVisible();
  expect(api.writes.at(-1)?.body).toEqual({
    revision: 3,
    name: "Service floor",
    refresh_cadence: "one-minute",
  });
});

test("archiving the home dashboard hands the department to the next one, and it restores", async ({
  page,
}) => {
  const api = await installDashboardApi(page, {
    identity: manager,
    dashboards: [
      dashboardWire(),
      dashboardWire({
        id: ids.other,
        name: "Night shift",
        is_home: false,
        position: 1,
        widgets: [equipmentNumber()],
      }),
    ],
  });
  await page.goto(homeUrl);
  await page.getByRole("button", { name: "More dashboard actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Night shift" }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Archive this dashboard…" }).click();
  await page
    .getByRole("alertdialog", { name: "Archive Field service dashboard?" })
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Night shift" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More dashboard actions" }).click();
  await page.getByRole("menuitem", { name: "Archived dashboards…" }).click();
  await page
    .getByRole("dialog", { name: "Archived dashboards" })
    .getByRole("button", { name: "Restore Field service dashboard" })
    .click();
  await expect
    .poll(() => api.writes.map((write) => write.method))
    .toEqual(["DELETE", "POST"]);
  expect(api.writes[0]?.path).toBe(`/api/dashboards/${ids.home}`);
});

test("a refused OpenView read hides the dashboard and offers Retry", async ({
  page,
}) => {
  await installDashboardApi(page, { identity: manager });
  await page.route("**/api/records/aggregate-snapshots", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Forbidden" }),
    }),
  );
  await page.goto(homeUrl);
  await expect(
    page.getByText(
      "OpenView data is unavailable. Sign in or ask for access, then retry.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
});

test("record changes refresh only the widgets of their module, once per burst", async ({
  page,
}) => {
  await page.clock.install();
  const api = await installDashboardApi(page, { identity: reader });
  await page.goto(homeUrl);
  await expect(card(page, "Quality checks by Result")).toContainText("Repair");
  const before = api.batches.length;
  for (let count = 0; count < 3; count += 1)
    await sendOpenViewEvent(page, "invalidate", {
      entity: "records",
      module_id: ids.checks,
    });
  await page.clock.runFor(301);
  await expect
    .poll(() => api.batches.slice(before).map((batch) => batch.moduleIds))
    .toEqual([[ids.checks]]);
});

test("the cadence reads again on time and waits while the layout is being edited", async ({
  page,
}) => {
  await page.clock.install();
  const api = await installDashboardApi(page, {
    identity: manager,
    dashboards: [
      dashboardWire({
        refresh_cadence: "one-minute",
        widgets: [equipmentNumber()],
      }),
    ],
  });
  await page.goto(homeUrl);
  await expect(card(page, "Number of Equipment")).toContainText("12");
  expect(api.batches).toHaveLength(1);
  await page.clock.runFor(60_000);
  await expect.poll(() => api.batches.length).toBe(2);
  await editLayout(page);
  await page.clock.runFor(120_000);
  expect(api.batches).toHaveLength(2);
});

test("after archiving the only dashboard a manager restores it from the setup state, and readers see no restore", async ({
  page,
}) => {
  const api = await installDashboardApi(page, { identity: manager });
  await page.goto(homeUrl);
  await page.getByRole("button", { name: "More dashboard actions" }).click();
  await page.getByRole("menuitem", { name: "Archive this dashboard…" }).click();
  await page
    .getByRole("alertdialog", { name: "Archive Field service dashboard?" })
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Set up the Field service dashboard" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Archived dashboards…" }).click();
  await page
    .getByRole("dialog", { name: "Archived dashboards" })
    .getByRole("button", { name: "Restore Field service dashboard" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Field service dashboard" }),
  ).toBeVisible();
  await expect(card(page, "Number of Equipment")).toContainText("12");
  expect(api.writes.map((write) => [write.method, write.path])).toEqual([
    ["DELETE", `/api/dashboards/${ids.home}`],
    ["POST", `/api/dashboards/${ids.home}/restore`],
  ]);
});

test("a reader of a department whose dashboards are all archived is offered no restore", async ({
  page,
}) => {
  await installDashboardApi(page, {
    identity: reader,
    dashboards: [dashboardWire({ is_deleted: true })],
  });
  await page.goto(homeUrl);
  await expect(
    page.getByRole("heading", { name: "No dashboard yet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Archived dashboards…" }),
  ).toHaveCount(0);
});

test("cards, spaces and empty cells follow reading order, so a move changes the Tab order and the saved order", async ({
  page,
}) => {
  const api = await installDashboardApi(page, {
    identity: manager,
    dashboards: [
      dashboardWire({
        widgets: [
          equipmentNumber(at(0, 0, 1, 1)),
          invoicesNumber(at(1, 0, 1, 1)),
        ],
      }),
    ],
  });
  await page.goto(homeUrl);
  await editLayout(page);
  await page
    .getByRole("button", { name: "Move or resize Number of Equipment" })
    .focus();
  await page.keyboard.press("ArrowDown");
  // Row 1 now reads: an empty cell, Invoices, two empty cells; Equipment
  // has moved to row 2.
  await card(page, "Number of Invoices")
    .getByRole("button", { name: "Number of Invoices, actions" })
    .focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Add a widget at column 3, row 1" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByRole("toolbar", { name: "Edit layout" })).toHaveCount(
    0,
  );
  const saved = api.writes.at(-1)?.body?.widgets as {
    config: { query: { module_id: string } };
    grid_row: number;
  }[];
  expect(
    saved.map((item) => [item.config.query.module_id, item.grid_row]),
  ).toEqual([
    [ids.invoices, 0],
    [ids.equipment, 1],
  ]);
});

test("a widget whose read fails says so and reads again on Retry", async ({
  page,
}) => {
  await installDashboardApi(page, { identity: reader });
  let failChecks = true;
  await page.route("**/api/records/aggregate-snapshots", (route) => {
    const body = route.request().postDataJSON() as {
      queries: { module_id: string }[];
    };
    if (failChecks && body.queries[0]?.module_id === ids.checks) {
      failChecks = false;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Unavailable" }),
      });
    }
    return route.fallback();
  });
  await page.goto(homeUrl);
  const failed = card(page, "Quality checks by Result");
  await expect(failed.getByRole("alert")).toBeVisible();
  await expect(card(page, "Equipment by Category")).toContainText("Repair");
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(failed).toContainText("Repair");
  await expect(failed.getByRole("alert")).toHaveCount(0);
});
