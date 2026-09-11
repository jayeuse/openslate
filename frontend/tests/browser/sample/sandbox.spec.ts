import { expect, test } from "../coverage";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";

test.beforeEach(async ({ page }) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: { detail: "Unavailable" } }),
  );
  await page.route("**/bff/**", async (route) => {
    if (!(await fulfillWorkspaceRequest(route)))
      await route.fulfill({ json: { items: [], has_more: false } });
  });
  await page.goto("/sandbox");
});

test("designer changes undo, persist as a draft, and publish a sample version", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", { name: "Organization designer" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add department", exact: true })
    .click();
  await page
    .getByLabel("Department name", { exact: true })
    .fill("Field services");
  await page
    .getByRole("button", { name: "Create department", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Select department Field services" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Select department Field services" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Select department Field services" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Publish sample design" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm sample publish", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "published" }),
  ).toBeVisible();
});

test("simulation applies an enabled rule and preview respects the selected sample role", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Simulation", exact: true }).click();
  await page
    .getByRole("button", { name: "Load sample records", exact: true })
    .click();
  await page.getByRole("button", { name: "Run scenario", exact: true }).click();
  await expect(
    page.getByText("Sample notification: Urgent request needs attention.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reset simulation", exact: true })
    .click();
  await expect(
    page.getByText("No simulation records loaded.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByLabel("Preview role", { exact: true }).selectOption("Member");
  await expect(
    page.getByText("Member · Read only", { exact: true }),
  ).toBeVisible();
});

test("field lifecycle and cross-department connections stay undoable without live writes", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/bff/") && request.method() !== "GET")
      writes.push(request.url());
  });
  await page
    .getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await page.getByLabel("Field name", { exact: true }).fill("Service tier");
  await page.getByLabel("Field type", { exact: true }).selectOption("Select");
  await page
    .getByLabel("Select options (comma separated)", { exact: true })
    .fill("Standard, Priority");
  await page.getByLabel("Default value", { exact: true }).fill("Standard");
  await page.getByLabel("Required field", { exact: true }).check();
  await page.getByRole("button", { name: "Create field", exact: true }).click();
  const field = page.locator("details").filter({ hasText: "Service tier" });
  await field.locator("summary").click();
  await expect(field.getByLabel("Service tier default value")).toHaveValue(
    "Standard",
  );
  await field.getByRole("button", { name: "Close field", exact: true }).click();
  await expect(field.locator("summary")).toContainText("Closed");
  await field
    .getByRole("button", { name: "Reopen field", exact: true })
    .click();
  await expect(field.locator("summary")).toContainText("Select");
  await page
    .getByRole("button", { name: "Connect modules", exact: true })
    .click();
  await page
    .getByLabel("Relationship name", { exact: true })
    .fill("Requested by");
  await page
    .getByLabel("Target module", { exact: true })
    .selectOption("sample-customers");
  await page
    .getByLabel("Cardinality", { exact: true })
    .selectOption("Many-to-many");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Cross-department relationship" }),
  ).toContainText("Cross-department relationship");
  await page
    .getByRole("button", { name: "Create relationship", exact: true })
    .click();
  await expect(
    page
      .getByRole("complementary", { name: "Design inspector" })
      .getByText("Requested by", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page
      .getByRole("complementary", { name: "Design inspector" })
      .getByText("Requested by", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(
    page
      .getByRole("complementary", { name: "Design inspector" })
      .getByText("Requested by", { exact: true }),
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) < 1280)
    await page
      .getByRole("button", { name: "Back to structure", exact: true })
      .click();
  await page
    .getByRole("button", {
      name: "Edit relationship Requested by",
      exact: true,
    })
    .click();
  const relationshipDialog = page.getByRole("dialog", {
    name: "Relationship settings",
    exact: true,
  });
  await expect(relationshipDialog).toBeVisible();
  await expect(
    relationshipDialog.getByLabel("Relationship name", { exact: true }),
  ).toHaveValue("Requested by");
  await relationshipDialog
    .getByLabel("Relationship name", { exact: true })
    .fill("Customer link");
  await relationshipDialog
    .getByLabel("Target module", { exact: true })
    .selectOption("sample-equipment");
  await relationshipDialog
    .getByLabel("Cardinality", { exact: true })
    .selectOption("One-to-one");
  await relationshipDialog
    .getByRole("button", { name: "Save relationship", exact: true })
    .click();
  await expect(
    page
      .getByRole("complementary", { name: "Design inspector" })
      .getByText("Customer link", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("complementary", { name: "Design inspector" })
      .getByText("One-to-one → Equipment", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("complementary", { name: "Design inspector" })
      .getByText("Requested by", { exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("automation only updates and assigns matching records and disabling creation prevents another record", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Automation", exact: true }).click();
  await page.getByRole("button", { name: "Create rule", exact: true }).click();
  await page.getByLabel("Rule name", { exact: true }).fill("Create follow-up");
  await page.getByLabel("Condition", { exact: true }).selectOption("Always");
  await page
    .getByLabel("Action", { exact: true })
    .selectOption("Create a record");
  await page.getByRole("button", { name: "Save rule", exact: true }).click();
  for (const action of ["Update a field", "Assign a task"]) {
    await page
      .getByRole("button", { name: "Create rule", exact: true })
      .click();
    await page
      .getByLabel("Rule name", { exact: true })
      .fill(`Urgent: ${action}`);
    await page
      .getByLabel("Condition", { exact: true })
      .selectOption("Priority is urgent");
    await page.getByLabel("Action", { exact: true }).selectOption(action);
    await page.getByRole("button", { name: "Save rule", exact: true }).click();
  }
  await page.getByRole("button", { name: "Simulation", exact: true }).click();
  await page
    .getByRole("button", { name: "Load sample records", exact: true })
    .click();
  await page.getByRole("button", { name: "Run scenario", exact: true }).click();
  await expect(
    page.getByText("Automation follow-up", { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText("In progress · Sample operator")).toHaveCount(1);
  await expect(page.getByText("Open · Unassigned")).toBeVisible();
  await page.getByRole("button", { name: "Automation", exact: true }).click();
  const rule = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Create follow-up", exact: true }),
  });
  await rule.getByRole("button", { name: "Run history", exact: true }).click();
  await expect(
    rule.getByText("Sample follow-up record created.", { exact: true }),
  ).toBeVisible();
  await rule.getByRole("button", { name: "Disable", exact: true }).click();
  await page.getByRole("button", { name: "Simulation", exact: true }).click();
  await page.getByRole("button", { name: "Run scenario", exact: true }).click();
  await expect(
    page.getByText("Automation follow-up", { exact: true }),
  ).toHaveCount(1);
});

test("urgent rules skip normal-priority sample records", async ({ page }) => {
  await page.getByRole("button", { name: "Simulation", exact: true }).click();
  await page
    .getByRole("button", { name: "Load sample records", exact: true })
    .click();
  await page
    .getByLabel("Priority for Urgent generator inspection", { exact: true })
    .selectOption("Normal");
  await page.getByRole("button", { name: "Run scenario", exact: true }).click();
  await expect(
    page.getByText("Skipped: trigger or condition did not match.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Sample notification: Urgent request needs attention.", {
      exact: true,
    }),
  ).toHaveCount(0);
});

test("revoking module access in Access removes it from role preview", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByLabel("Preview role", { exact: true }).selectOption("Member");
  await expect(
    page.getByRole("heading", { name: "Service requests", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Equipment", exact: true }),
  ).toHaveCount(0);
  await page.goto("/access");
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Permission role", exact: true })
    .selectOption("sample-member");
  await page
    .getByRole("checkbox", { name: "Module · Service requests", exact: true })
    .uncheck();
  await page.goto("/sandbox");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByLabel("Preview role", { exact: true }).selectOption("Member");
  await expect(
    page.getByRole("heading", { name: "Service requests", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "This role has no readable modules. Grant department, module, and read access in Sample Access.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("mobile designer uses focused panes and desktop canvas fits every initial module", async ({
  page,
}) => {
  if ((page.viewportSize()?.width ?? 0) < 1280) {
    await expect(
      page.getByRole("navigation", { name: "Designer panes" }),
    ).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Organization structure" }),
    ).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Design inspector" }),
    ).toBeHidden();
    await page
      .getByRole("button", {
        name: "Select module Service requests",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("complementary", { name: "Organization structure" }),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Rename module", exact: true }),
    ).toBeInViewport();
    await page
      .getByRole("button", { name: "Back to structure", exact: true })
      .click();
    await page.getByRole("button", { name: "Canvas", exact: true }).click();
    await expect(
      page.getByLabel("Module design canvas", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Design inspector" }),
    ).toBeHidden();
  } else {
    await page.setViewportSize({ width: 1920, height: 1200 });
    const canvas = page.getByLabel("Module design canvas", { exact: true });
    await expect
      .poll(async () => {
        const box = await canvas.boundingBox();
        return box!.y + box!.height;
      })
      .toBeGreaterThan(1090);
    const bounds = await canvas.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThan(1160);
    for (const name of ["Organization structure", "Design inspector"]) {
      const panel = await page
        .getByRole("complementary", { name })
        .boundingBox();
      expect(
        Math.abs(panel!.y + panel!.height - bounds!.y - bounds!.height),
      ).toBeLessThan(2);
    }
    for (const id of [
      "sample-requests",
      "sample-equipment",
      "sample-customers",
    ]) {
      const card = canvas
        .locator(`[data-cell-id="${id}"]`)
        .locator("rect")
        .first();
      const box = await card.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        bounds!.x + bounds!.width,
      );
    }
  }
});

test("existing outline inline rename updates the sample module", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const outline = page.getByRole("complementary", {
    name: "Organization structure",
  });
  await outline
    .getByRole("button", { name: "Select module Equipment", exact: true })
    .dblclick();
  const editor = page.getByRole("textbox", {
    name: "Edit module name",
    exact: true,
  });
  await editor.fill("Assets");
  await editor.press("Enter");
  await expect(
    outline.getByRole("button", { name: "Select module Assets", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("sandbox-canvas")
      .locator('[data-cell-id="sample-equipment"]')
      .getByText("Assets", { exact: true }),
  ).toBeVisible();
});

test("canvas inline field rename preserves defaults options lifecycle and adjacent module fields", async ({
  page,
}) => {
  await page
    .getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    })
    .click();
  const details = page
    .locator("details")
    .filter({ has: page.locator("summary").filter({ hasText: "Status" }) });
  await details.locator("summary").click();
  await expect(
    details.getByLabel("Status description", { exact: true }),
  ).toBeVisible();
  await details
    .getByLabel("Status description", { exact: true })
    .fill("Dispatch progress");
  await details
    .getByLabel("Status default value", { exact: true })
    .fill("Open");
  await details
    .getByLabel("Status options", { exact: true })
    .fill("Open, Waiting, Closed");
  await details
    .getByRole("checkbox", { name: "Required", exact: true })
    .check();
  await details
    .getByRole("button", { name: "Close field", exact: true })
    .click();
  if ((page.viewportSize()?.width ?? 0) < 1280)
    await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.getByRole("button", { name: "Fit canvas", exact: true }).click();
  const source = page
    .getByTestId("sandbox-canvas")
    .locator('[data-cell-id="sample-requests"]');
  const statusRow = source.getByRole("button", {
    name: "Status, Select, required",
    exact: true,
  });
  const statusBox = await statusRow.boundingBox();
  if (!statusBox) throw new Error("Status row missing");
  await statusRow.dblclick({
    position: { x: Math.min(10, statusBox.width / 4), y: statusBox.height / 2 },
  });
  const editor = page.getByRole("textbox", {
    name: "Canvas name editor",
    exact: true,
  });
  await editor.fill("Request status");
  await editor.press("Enter");
  await expect(
    source.getByRole("button", {
      name: "Request status, Select, required",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("sandbox-canvas")
      .locator('[data-cell-id="sample-equipment"]')
      .getByRole("button", { name: "Status, Select, optional", exact: true }),
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) < 1280)
    await page.getByRole("button", { name: "Inspector", exact: true }).click();
  const renamed = page.locator("details").filter({
    has: page.locator("summary").filter({ hasText: "Request status" }),
  });
  await expect(renamed.locator("summary")).toContainText("Closed");
  await expect(
    renamed.getByLabel("Request status default value", { exact: true }),
  ).toHaveValue("Open");
  await expect(
    renamed.getByLabel("Request status options", { exact: true }),
  ).toHaveValue("Open, Waiting, Closed");
  await expect(
    renamed.getByLabel("Request status description", { exact: true }),
  ).toHaveValue("Dispatch progress");
  await expect(
    renamed.getByRole("checkbox", { name: "Required", exact: true }),
  ).toBeChecked();
});

test("dragged module geometry survives leaving Designer and top Undo restores it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const canvas = page.getByTestId("sandbox-canvas");
  await page.getByRole("button", { name: "Fit canvas", exact: true }).click();
  const frame = () =>
    canvas.locator('[data-cell-id="sample-requests"]').locator("rect").first();
  const before = await frame().boundingBox();
  const heading = canvas
    .locator('[data-cell-id="sample-requests"]')
    .getByText("Service requests", { exact: true });
  const start = await heading.boundingBox();
  if (!before || !start) throw new Error("Module geometry missing");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    start.x + start.width / 2 + 35,
    start.y + start.height / 2 + 30,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Math.abs((await frame().boundingBox())!.x - before.x))
    .toBeGreaterThan(15);
  const moved = await frame().boundingBox();
  await page.getByRole("button", { name: "Simulation", exact: true }).click();
  await page.getByRole("button", { name: "Designer", exact: true }).click();
  await page.getByRole("button", { name: "Fit canvas", exact: true }).click();
  await expect
    .poll(async () => Math.abs((await frame().boundingBox())!.x - moved!.x))
    .toBeLessThan(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Fit canvas", exact: true }).click();
  await expect
    .poll(async () => Math.abs((await frame().boundingBox())!.x - before.x))
    .toBeLessThan(2);
  await expect
    .poll(async () => Math.abs((await frame().boundingBox())!.y - before.y))
    .toBeLessThan(2);
});
