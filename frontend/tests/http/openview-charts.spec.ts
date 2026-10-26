import { expect, test } from "@playwright/test";
import {
  at,
  card,
  chartWire,
  dashboardWire,
  editLayout,
  equipmentBar,
  equipmentNumber,
  homeUrl,
  ids,
  installDashboardApi,
  invoicesNumber,
  manager,
} from "./helpers/openview-dashboard-api";

// The chart builder (docs/specs/openview-dashboard.md, BD10, BD11, BD21),
// which replaces the Charts page.

test("an empty cell opens the builder with its space, and kinds that do not fit say why", async ({
  page,
}) => {
  const api = await installDashboardApi(page, {
    identity: manager,
    dashboards: [
      dashboardWire({
        // Only column 4 of row 1 is free.
        widgets: [
          equipmentNumber(at(0, 0, 2, 1)),
          invoicesNumber(at(2, 0, 1, 1)),
          equipmentBar(at(0, 1, 4, 3)),
          equipmentNumber(at(0, 4, 2, 1)),
          equipmentNumber(at(2, 4, 2, 1)),
        ],
      }),
    ],
  });
  await page.goto(homeUrl);
  await editLayout(page);
  await page
    .getByRole("button", { name: "Add a widget at column 4, row 1" })
    .click();
  const builder = page.getByRole("dialog", { name: "Add a chart" });
  await expect(builder).toContainText("1 × 1 space");
  const bar = builder.getByRole("radio", { name: "Bar" });
  await expect(bar).toHaveAttribute("aria-disabled", "true");
  await expect(bar).toHaveAccessibleDescription(
    "A bar chart needs at least 2 × 2",
  );
  await expect(builder.getByRole("radio", { name: "Number" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // Show: a sum needs a number field.
  await builder.getByLabel("Show", { exact: true }).selectOption("sum");
  await builder.getByLabel("Of the field").selectOption({ label: "Amount" });
  await builder.getByRole("button", { name: "Update preview" }).click();
  await expect(builder.getByRole("region", { name: "Preview" })).toContainText(
    "12",
  );
  await expect(builder).toContainText(
    "People who cannot open Equipment see a locked card instead of this chart.",
  );
  await builder.getByRole("button", { name: "Add to dashboard" }).click();
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByRole("toolbar", { name: "Edit layout" })).toHaveCount(
    0,
  );
  const saved = api.writes.at(-1)?.body?.widgets as Record<string, unknown>[];
  // The layout saves in reading order: the new number is third on row 1.
  expect(saved[2]).toMatchObject({
    widget_type: "summary",
    grid_column: 3,
    grid_row: 0,
    column_span: 1,
    row_span: 1,
    config: {
      query: {
        aggregation: "sum",
        measure: { field_id: ids.amount, expected_type: "decimal" },
      },
    },
  });
});

test("the builder lists the department's modules, then the linked ones", async ({
  page,
}) => {
  await installDashboardApi(page, {
    identity: manager,
    dashboards: [dashboardWire({ widgets: [] })],
  });
  await page.goto(homeUrl);
  await editLayout(page);
  await page.getByRole("button", { name: "Add widget" }).click();
  const records = page
    .getByRole("dialog", { name: "Add a chart" })
    .getByLabel("Records");
  await expect(records.locator("optgroup")).toHaveText([
    /Equipment.*Quality checks/,
    /Finance › Invoices/,
  ]);
  await expect(records.locator("optgroup").nth(1)).toHaveAttribute(
    "label",
    "Linked departments",
  );
});

test("Edit chart on a saved chart uses a copy here unless it is changed everywhere", async ({
  page,
}) => {
  const api = await installDashboardApi(page, {
    identity: manager,
    charts: [chartWire()],
    dashboards: [
      dashboardWire({
        widgets: [
          {
            ...equipmentBar(),
            chart_id: ids.chart,
            config: null,
          },
        ],
      }),
    ],
  });
  await page.goto(homeUrl);
  await card(page, "Equipment by category")
    .getByRole("button", { name: "Equipment by category, actions" })
    .click();
  await page.getByRole("menuitem", { name: "Edit chart…" }).click();
  const builder = page.getByRole("dialog", { name: "Edit chart" });
  await expect(
    builder.getByRole("checkbox", {
      name: "Change “Equipment by category” everywhere",
    }),
  ).not.toBeChecked();
  await builder.getByRole("radio", { name: "Pie" }).click();
  await builder.getByRole("button", { name: "Apply changes" }).click();
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByRole("toolbar", { name: "Edit layout" })).toHaveCount(
    0,
  );
  expect(api.chartWrites).toEqual([]);
  expect(api.writes.at(-1)?.body?.widgets).toMatchObject([
    { widget_type: "chart", chart_id: null, config: { chart_type: "pie" } },
  ]);
});

test("Show as is one Tab stop chosen with the arrow keys, and a changed setup survives Escape until discarded", async ({
  page,
}) => {
  await installDashboardApi(page, {
    identity: manager,
    dashboards: [dashboardWire({ widgets: [] })],
  });
  await page.goto(homeUrl);
  await editLayout(page);
  await page.getByRole("button", { name: "Add widget" }).click();
  const builder = page.getByRole("dialog", { name: "Add a chart" });
  const bar = builder.getByRole("radio", { name: "Bar" });
  await expect(bar).toHaveAttribute("aria-checked", "true");
  await expect(builder.getByRole("radio", { name: "Line" })).toHaveAttribute(
    "tabindex",
    "-1",
  );
  await bar.focus();
  await page.keyboard.press("ArrowRight");
  const line = builder.getByRole("radio", { name: "Line" });
  await expect(line).toBeFocused();
  await expect(line).toHaveAttribute("aria-checked", "true");

  await page.keyboard.press("Escape");
  const confirm = page.getByRole("alertdialog", {
    name: "Discard this chart?",
  });
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  await expect(line).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await confirm.getByRole("button", { name: "Discard" }).click();
  await expect(builder).toHaveCount(0);
});
