import { expect, test } from "@playwright/test";
import {
  chartWire,
  dashboardWire,
  editLayout,
  equipmentNumber,
  homeUrl,
  ids,
  installDashboardApi,
  manager,
} from "./helpers/openview-dashboard-api";

// Saved charts in the builder's "Use a saved chart instead" list
// (docs/specs/openview-dashboard.md, the capability map, BD13, BD20).

test("the old Charts address opens the first department's dashboard with the saved charts", async ({
  page,
}) => {
  const api = await installDashboardApi(page, {
    identity: manager,
    charts: [chartWire()],
    dashboards: [dashboardWire({ widgets: [equipmentNumber()] })],
  });
  await page.goto("/openview?section=charts");
  await expect(page).toHaveURL(homeUrl);
  const builder = page.getByRole("dialog", { name: "Add a chart" });
  const list = builder.getByRole("list", { name: "Saved charts" });
  await list
    .getByRole("button", { name: /^Equipment by category Equipment/ })
    .click();
  // Opening a saved chart shows its result and where it is used.
  await expect(builder.getByRole("region", { name: "Preview" })).toContainText(
    "Repair",
  );
  await expect(builder).toContainText("Not used on a dashboard yet.");
  await builder.getByRole("button", { name: "Add to dashboard" }).click();
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByRole("toolbar", { name: "Edit layout" })).toHaveCount(
    0,
  );
  const saved = api.writes.at(-1)?.body?.widgets as Record<string, unknown>[];
  expect(saved.at(-1)).toMatchObject({
    widget_type: "chart",
    chart_id: ids.chart,
    config: null,
  });
});

test("saved charts archive and restore from the builder's list", async ({
  page,
}) => {
  const api = await installDashboardApi(page, {
    identity: manager,
    charts: [chartWire()],
  });
  await page.goto(homeUrl);
  await editLayout(page);
  await page.getByRole("button", { name: "Add widget" }).click();
  const builder = page.getByRole("dialog", { name: "Add a chart" });
  await builder
    .getByRole("button", { name: "Use a saved chart instead" })
    .click();
  await builder
    .getByRole("button", { name: "Equipment by category, actions" })
    .click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(
    builder.getByRole("list", { name: "Saved charts" }),
  ).toContainText("No saved charts for this dashboard yet.");
  await builder.getByRole("checkbox", { name: "Archived charts" }).click();
  await builder
    .getByRole("button", { name: "Equipment by category, actions" })
    .click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await expect
    .poll(() => api.chartWrites.map((write) => write.method))
    .toEqual(["DELETE", "POST"]);
});
