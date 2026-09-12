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

test("workflow tabs preserve manual keyboard activation and the current URL", async ({
  page,
}) => {
  const sections = page.getByRole("navigation", {
    name: "Sandbox sections",
    exact: true,
  });
  const designer = sections.getByRole("tab", {
    name: "Designer",
    exact: true,
  });
  const automation = sections.getByRole("tab", {
    name: "Automation",
    exact: true,
  });

  await expect(sections.getByRole("tablist")).toBeVisible();
  await expect(designer).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tabpanel", { name: "Designer", exact: true }),
  ).toBeVisible();
  await designer.focus();
  await designer.press("ArrowRight");
  await expect(automation).toBeFocused();
  await expect(designer).toHaveAttribute("aria-selected", "true");
  await expect(automation).toHaveAttribute("aria-selected", "false");

  await automation.press("Enter");
  await expect(automation).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tabpanel", { name: "Automation", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Automation rules", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/sandbox$/);
});

test("designer changes undo, persist in the tab, and create named local snapshots", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", { name: "Organization designer" }),
  ).toBeVisible();
  await expect(page.getByText("Local sandbox", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Saved in this tab", { exact: true }),
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
  await page
    .getByRole("button", { name: "Create checkpoint", exact: true })
    .click();
  const checkpoint = page.getByRole("dialog", {
    name: "Create checkpoint",
    exact: true,
  });
  await checkpoint
    .getByLabel("Checkpoint name", { exact: true })
    .fill("Field service draft");
  await checkpoint
    .getByLabel("Checkpoint note", { exact: true })
    .fill("Ready for local review");
  await checkpoint
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Select department Field services" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Field service draft", exact: true }),
  ).toContainText("Ready for local review");
  await page.getByRole("tab", { name: "Designer", exact: true }).click();
  await page
    .getByRole("button", { name: "Create local release", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Review local release", exact: true })
    .getByRole("button", { name: "Confirm local release", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Local release created" }),
  ).toBeVisible();
});

test("invalid field drafts stay editable without changing the saved design", async ({
  page,
}) => {
  await page
    .getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    })
    .click();
  if ((page.viewportSize()?.width ?? 0) < 1280)
    await page
      .getByRole("button", { name: "Inspect selected", exact: true })
      .click();
  const statusField = page.getByRole("region", {
    name: "Status field settings",
    exact: true,
  });
  const showStatusSettings = statusField.getByRole("button", {
    name: "Show Status settings",
    exact: true,
  });
  if (await showStatusSettings.isVisible()) await showStatusSettings.click();
  await statusField
    .getByLabel("Status default value", { exact: true })
    .fill("Archived");
  await statusField
    .getByRole("button", { name: "Save field changes", exact: true })
    .click();
  await expect(statusField.getByRole("alert")).toContainText(
    "Default value must match a select option",
  );
  await expect(
    statusField.getByLabel("Status default value", { exact: true }),
  ).toHaveValue("Archived");
  await expect(statusField).toContainText("Status");
  await expect(
    page.getByRole("button", { name: "Create local release", exact: true }),
  ).toBeEnabled();
});

test("JSON import is staged and reset is scoped to the sandbox", async ({
  page,
}) => {
  const imported = {
    kind: "openslate-sandbox",
    schemaVersion: 1,
    design: {
      departments: [
        {
          id: "imported-department",
          name: "Imported operations",
          closed: false,
        },
      ],
      modules: [],
      relationships: [],
      rules: [],
    },
  };
  await page
    .getByRole("button", { name: "Import or export", exact: true })
    .click();
  const portability = page.getByRole("dialog", {
    name: "Sandbox import and export",
    exact: true,
  });
  const includeVersions = portability.getByRole("checkbox", {
    name: "Include checkpoints and local releases",
    exact: true,
  });
  await expect(includeVersions).not.toBeChecked();
  await includeVersions.focus();
  await expect(includeVersions).toBeFocused();
  await page.keyboard.press("Space");
  await expect(includeVersions).toBeChecked();
  const downloadPromise = page.waitForEvent("download");
  await portability
    .getByRole("button", { name: "Export JSON", exact: true })
    .click();
  expect((await downloadPromise).suggestedFilename()).toBe(
    "openslate-sandbox.json",
  );
  await portability
    .getByLabel("Import sandbox JSON", { exact: true })
    .setInputFiles({
      name: "sandbox.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(imported)),
    });
  await expect(portability).toContainText("1 department");
  await portability
    .getByRole("button", { name: "Cancel import", exact: true })
    .click();
  await expect(
    portability.getByRole("button", { name: "Replace sandbox", exact: true }),
  ).toHaveCount(0);
  await portability.press("Escape");
  await expect(
    page.getByRole("button", { name: "Select department Operations" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Import or export", exact: true })
    .click();
  await portability
    .getByLabel("Import sandbox JSON", { exact: true })
    .setInputFiles({
      name: "sandbox.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(imported)),
    });
  await portability
    .getByRole("button", { name: "Replace sandbox", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Select department Imported operations" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Before import", exact: true }),
  ).toContainText("Automatic recovery checkpoint");
  await page.getByRole("tab", { name: "Designer", exact: true }).click();
  await page.addInitScript(() => {
    const key = "openslate.sample.v1";
    const stored = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<
      string,
      unknown
    >;
    stored["unrelated-sample-marker"] = "keep";
    sessionStorage.setItem(key, JSON.stringify(stored));
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Select department Imported operations" }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Clear Sandbox data", exact: true })
    .click();
  const clear = page.getByRole("alertdialog", {
    name: "Clear Sandbox data?",
    exact: true,
  });
  await clear
    .getByRole("button", { name: "Cancel clear", exact: true })
    .click();
  await expect(clear).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Select department Imported operations" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear Sandbox data", exact: true })
    .click();
  await clear
    .getByRole("button", { name: "Clear Sandbox data", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Select department Operations" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(sessionStorage.getItem("openslate.sample.v1") ?? "{}")[
            "unrelated-sample-marker"
          ],
      ),
    )
    .toBe("keep");
});

test("simulation applies an enabled rule and preview respects the selected sample role", async ({
  page,
}) => {
  await page.getByRole("tab", { name: "Simulation", exact: true }).click();
  await page
    .getByRole("button", { name: "Load sample records", exact: true })
    .click();
  await page.getByLabel("Priority", { exact: true }).fill("Urgent");
  await page
    .getByLabel("Rule selection", { exact: true })
    .selectOption({ label: "Urgent request alert" });
  await page
    .getByLabel("Simulation event", { exact: true })
    .selectOption("new-record");
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Execution trace" }),
  ).toContainText("Sample notification: Urgent request needs attention.");
  await page
    .getByRole("button", { name: "Reset simulation", exact: true })
    .click();
  await expect(
    page.getByText("No simulation records loaded.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
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
  if ((page.viewportSize()?.width ?? 0) < 1280)
    await page
      .getByRole("button", { name: "Inspect selected", exact: true })
      .click();
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await page.getByLabel("Field name", { exact: true }).fill("Service tier");
  await page.getByLabel("Field type", { exact: true }).selectOption("Select");
  await page
    .getByLabel("Select options (comma separated)", { exact: true })
    .fill("Standard, Priority");
  await page.getByLabel("Default value", { exact: true }).fill("Standard");
  await page
    .getByRole("checkbox", { name: "Required field", exact: true })
    .click();
  await page.getByRole("button", { name: "Create field", exact: true }).click();
  const field = page.getByRole("region", {
    name: "Service tier field settings",
    exact: true,
  });
  await field
    .getByRole("button", {
      name: "Show Service tier settings",
      exact: true,
    })
    .click();
  await expect(field.getByLabel("Service tier default value")).toHaveValue(
    "Standard",
  );
  await field.getByRole("button", { name: "Close field", exact: true }).click();
  await expect(field).toContainText("Closed");
  await field
    .getByRole("button", { name: "Reopen field", exact: true })
    .click();
  await expect(field).toContainText("Select");
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
    .getByLabel("Source module", { exact: true })
    .selectOption("sample-customers");
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
  await page.getByRole("tab", { name: "Automation", exact: true }).click();
  await page.getByRole("button", { name: "Create rule", exact: true }).click();
  let editor = page.getByRole("form", { name: "Create automation rule" });
  await editor
    .getByLabel("Rule name", { exact: true })
    .fill("Create follow-up");
  await editor.getByLabel("Condition", { exact: true }).selectOption("always");
  await editor
    .getByLabel("Action", { exact: true })
    .selectOption("create-record");
  await editor
    .getByLabel("Action field", { exact: true })
    .selectOption("sample-field-Status");
  await editor
    .getByLabel("Action value", { exact: true })
    .selectOption({ label: "Open" });
  await editor.getByRole("button", { name: "Save rule", exact: true }).click();
  for (const [name, action] of [
    ["Urgent update", "update-field"],
    ["Urgent assignment", "assign-task"],
  ] as const) {
    await page
      .getByRole("button", { name: "Create rule", exact: true })
      .click();
    editor = page.getByRole("form", { name: "Create automation rule" });
    await editor.getByLabel("Rule name", { exact: true }).fill(name);
    await editor
      .getByLabel("Condition", { exact: true })
      .selectOption("field-comparison");
    await editor
      .getByLabel("Condition field", { exact: true })
      .selectOption("sample-field-Priority");
    await editor.getByLabel("Condition value", { exact: true }).fill("Urgent");
    await editor.getByLabel("Action", { exact: true }).selectOption(action);
    if (action === "update-field") {
      await editor
        .getByLabel("Action field", { exact: true })
        .selectOption("sample-field-Status");
      await editor
        .getByLabel("Action value", { exact: true })
        .selectOption({ label: "In progress" });
    } else
      await editor
        .getByLabel("Assignee", { exact: true })
        .fill("Sample operator");
    await editor
      .getByRole("button", { name: "Save rule", exact: true })
      .click();
  }
  await page.getByRole("tab", { name: "Simulation", exact: true }).click();
  await page
    .getByRole("button", { name: "Load sample records", exact: true })
    .click();
  await page.getByLabel("Priority", { exact: true }).fill("Urgent");
  await page
    .getByLabel("Rule selection", { exact: true })
    .selectOption("all-enabled");
  await page
    .getByLabel("Simulation event", { exact: true })
    .selectOption("new-record");
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  const trace = page.getByRole("region", { name: "Execution trace" });
  for (const name of [
    "Create follow-up · Matched",
    "Urgent update · Matched",
    "Urgent assignment · Matched",
  ]) {
    await expect(trace.getByRole("group", { name, exact: true })).toBeVisible();
  }
  await expect(
    page.getByRole("region", { name: "After record" }),
  ).toContainText("Status: In progress");
  const recordCount = await page.evaluate(() => {
    const stored = JSON.parse(
      sessionStorage.getItem("openslate.sample.v1") ?? "{}",
    ) as Record<string, { records?: unknown[] }>;
    return stored["sandbox.simulation"]?.records?.length ?? 0;
  });
  await page.getByRole("tab", { name: "Automation", exact: true }).click();
  const rule = page.getByRole("article", { name: "Rule Create follow-up" });
  await rule.getByRole("button", { name: "Run history", exact: true }).click();
  await expect(rule).toContainText("Sample Service requests record prepared");
  await rule.getByRole("button", { name: "Disable", exact: true }).click();
  await page.getByRole("tab", { name: "Simulation", exact: true }).click();
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  await expect(trace).not.toContainText("Create follow-up");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = JSON.parse(
          sessionStorage.getItem("openslate.sample.v1") ?? "{}",
        ) as Record<string, { records?: unknown[] }>;
        return stored["sandbox.simulation"]?.records?.length ?? 0;
      }),
    )
    .toBe(recordCount);
});

test("urgent rules skip normal-priority sample records", async ({ page }) => {
  await page.getByRole("tab", { name: "Simulation", exact: true }).click();
  await page
    .getByRole("button", { name: "Load sample records", exact: true })
    .click();
  await page.getByLabel("Priority", { exact: true }).fill("Normal");
  await page
    .getByLabel("Rule selection", { exact: true })
    .selectOption({ label: "Urgent request alert" });
  await page
    .getByLabel("Simulation event", { exact: true })
    .selectOption("new-record");
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  const trace = page.getByRole("region", { name: "Execution trace" });
  await expect(
    trace.getByRole("group", {
      name: "Urgent request alert · Skipped",
      exact: true,
    }),
  ).toBeVisible();
  await expect(trace).toContainText("Trigger or condition did not match.");
  await expect(trace).not.toContainText(
    "Sample notification: Urgent request needs attention.",
  );
});

test("revoking module access in Access removes it from role preview", async ({
  page,
}) => {
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
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
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByLabel("Preview role", { exact: true }).selectOption("Member");
  await expect(
    page.getByRole("heading", { name: "Service requests", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("This role has no readable modules.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Grant department, module, and read access in Sample Access.",
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
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Inspect selected", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Rename module", exact: true }),
    ).toBeInViewport();
    await page
      .getByRole("button", { name: "Back to structure", exact: true })
      .click();
    await page.getByRole("tab", { name: "Canvas", exact: true }).click();
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
  if ((page.viewportSize()?.width ?? 0) < 1280)
    await page
      .getByRole("button", { name: "Inspect selected", exact: true })
      .click();
  const details = page.getByRole("region", { name: "Status field settings" });
  await details
    .getByRole("button", { name: "Show Status settings", exact: true })
    .click();
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
    .click();
  await details
    .getByRole("button", { name: "Save field changes", exact: true })
    .click();
  await details
    .getByRole("button", { name: "Close field", exact: true })
    .click();
  if ((page.viewportSize()?.width ?? 0) < 1280)
    await page.getByRole("tab", { name: "Canvas", exact: true }).click();
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
    await page.getByRole("tab", { name: "Inspector", exact: true }).click();
  const renamed = page.getByRole("region", {
    name: "Request status field settings",
  });
  await expect(renamed.getByText("Closed", { exact: true })).toBeVisible();
  const renamedDisclosure = renamed.getByRole("button", {
    name: /Request status settings$/,
  });
  if ((await renamedDisclosure.getAttribute("aria-expanded")) !== "true")
    await renamedDisclosure.click();
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
  const cell = () => canvas.locator('[data-cell-id="sample-requests"]');
  const position = () =>
    cell().evaluate((element) => {
      const transform = element.getAttribute("transform") ?? "";
      const match = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(transform);
      if (!match) throw new Error(`Missing node translation: ${transform}`);
      return { x: Number(match[1]), y: Number(match[2]) };
    });
  const before = await position();
  const heading = cell().getByText("Service requests", { exact: true });
  const start = await heading.boundingBox();
  if (!start) throw new Error("Module geometry missing");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    start.x + start.width / 2 + 35,
    start.y + start.height / 2 + 30,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Math.abs((await position()).x - before.x))
    .toBeGreaterThan(15);
  const moved = await position();
  await page.getByRole("tab", { name: "Simulation", exact: true }).click();
  await page.getByRole("tab", { name: "Designer", exact: true }).click();
  await page.getByRole("button", { name: "Fit canvas", exact: true }).click();
  await expect.poll(position).toEqual(moved);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Fit canvas", exact: true }).click();
  await expect.poll(position).toEqual(before);
});
