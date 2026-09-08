import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  addDepartment as addDepartmentReducer,
  addLink as addLinkReducer,
  addModule as addModuleReducer,
  createEmptySandbox,
} from "../src/lib/sandbox/model";
import { canEmbed, canEnterStage, canConnect } from "../src/lib/sandbox/rules";

// Keep the workflow tests deterministic on desktop. Responsive coverage below
// overrides this for an actual mobile viewport.
test.use({ viewport: { width: 1440, height: 900 } });

/**
 * Sandbox prototype workflow tests.
 *
 * The prototype is intentionally local-only: every authenticated page in this
 * spec starts from the empty builder and builds state through the UI. Only the
 * shared session mocks are installed; the sandbox never calls `/bff/**`.
 */

async function gotoSandbox(page: Page): Promise<void> {
  await page.route("**/session/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true }),
    }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Authentication required" }),
    }),
  );
  await page.goto("/sandbox");
}

function canvas(page: Page) {
  return page.getByTestId("sandbox-canvas");
}

async function renameInspectorName(
  page: Page,
  inputTestId: string,
  name: string,
): Promise<void> {
  const input = page.getByTestId(inputTestId).last();
  await input.fill(name);
  await expect(input).toHaveValue(name);
}

async function buildSingleModule(page: Page): Promise<void> {
  await gotoSandbox(page);
  await page.getByTestId("empty-add-department").click();
  await renameInspectorName(page, "inspector-dept-name", "Inventory");
  await page.getByTestId("dept-continue-modules").click();
  await page.getByTestId("palette-add-module").click();
  await expect(page.getByTestId("inspector-module")).toBeVisible();
  await renameInspectorName(page, "inspector-module-name", "Equipment");
}

async function addTextField(page: Page, name: string): Promise<void> {
  await page.getByTestId("palette-add-field-text").click();
  await renameInspectorName(page, "inspector-field-name", name);
}

async function selectModuleHeader(page: Page, name: string): Promise<void> {
  const label = canvas(page).getByText(name, { exact: true });
  await expect(label).toBeVisible();
  const box = await label.boundingBox();
  if (box === null) {
    throw new Error(`${name} module label has no bounding box`);
  }
  await label.click();
}

async function selectOutlineDepartment(
  page: Page,
  name: string,
): Promise<void> {
  await inspectorOutline(page)
    .getByRole("button", { name: `Select department ${name}`, exact: true })
    .click();
}

async function selectOutlineModule(page: Page, name: string): Promise<void> {
  await inspectorOutline(page)
    .getByRole("button", { name: `Select module ${name}`, exact: true })
    .click();
}

async function selectOutlineField(page: Page, name: string): Promise<void> {
  await inspectorOutline(page)
    .getByRole("button", { name: `Select field ${name}`, exact: true })
    .click();
}

function inspectorOutline(page: Page): Locator {
  return page.getByTestId("inspector-outline").last();
}

async function doubleClickFieldCell(
  page: Page,
  fieldName: string,
  cell: "name" | "type",
): Promise<void> {
  // X6 keeps the row rect as the interactive target while the SVG text is
  // intentionally pointer-transparent. Click the correct half of that row so
  // the graph can resolve name versus type from its coordinates.
  const row = canvas(page).getByRole("button", {
    name: fieldName,
    exact: true,
  });
  const box = await row.boundingBox();
  if (box === null) {
    throw new Error(`${fieldName} field row has no bounds`);
  }
  const x = cell === "name" ? box.x + 24 : box.x + box.width - 24;
  await page.mouse.dblclick(x, box.y + box.height / 2);
}

async function buildTwoDepartmentsWithModule(
  page: Page,
  moduleName = "Module A",
): Promise<void> {
  await gotoSandbox(page);
  await page.getByTestId("empty-add-department").click();
  await renameInspectorName(page, "inspector-dept-name", "Department A");
  await page.getByTestId("dept-add-another").click();
  await renameInspectorName(page, "inspector-dept-name", "Department B");
  // Keep the module under Department A. The new creation flow uses the
  // selected department as its parent, so choose the intended parent once
  // instead of relying on the old department picker dialog.
  await selectOutlineDepartment(page, "Department A");
  await page.getByTestId("dept-continue-modules").click();
  await page.getByTestId("palette-add-module").click();
  await renameInspectorName(page, "inspector-module-name", moduleName);
}

async function dragNodeToPoint(
  page: Page,
  node: Locator,
  target: { x: number; y: number },
): Promise<void> {
  const before = await nodeBox(node);
  if (before === null) {
    throw new Error("Dragged node has no bounds");
  }
  const startX = before.x + before.width / 2;
  const startY = before.y + before.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.mouse.up();
}

async function nodeBox(node: Locator) {
  // Measure the X6 node body instead of the translated SVG group. The group
  // bounds include its centered title text, so renaming a node can change its
  // left edge even when the node itself has not moved.
  return node
    .locator("xpath=ancestor::*[@data-cell-id][1]")
    .locator("rect")
    .first()
    .boundingBox();
}

async function expectModuleParent(
  page: Page,
  departmentName: string,
): Promise<void> {
  await expect(page.getByTestId("inspector-module")).toBeVisible();
  await expect(
    page.getByTestId("inspector-module-dept").locator("option:checked"),
  ).toHaveText(departmentName);
}

test.describe("sandbox hierarchy rules", () => {
  test("only department accepts module and module accepts field", () => {
    expect(canEmbed("department", "module")).toBe(true);
    expect(canEmbed("module", "field")).toBe(true);
    expect(canEmbed("module", "module")).toBe(false);
    expect(canEmbed("field", "module")).toBe(false);
    expect(canEmbed("department", "field")).toBe(false);
  });

  test("stage gating follows the structure counts", () => {
    let state = createEmptySandbox();
    expect(canEnterStage("modules", state).ok).toBe(false);
    expect(canEnterStage("fields", state).ok).toBe(false);
    expect(canEnterStage("relationships", state).ok).toBe(false);

    state = addDepartmentReducer(state, "Inventory");
    expect(canEnterStage("modules", state).ok).toBe(true);
    expect(canEnterStage("fields", state).ok).toBe(false);

    state = addModuleReducer(state, state.departments[0].id, "Equipment");
    expect(canEnterStage("fields", state).ok).toBe(true);
    expect(canEnterStage("relationships", state).ok).toBe(false);

    state = addModuleReducer(state, state.departments[0].id, "Suppliers");
    expect(canEnterStage("relationships", state).ok).toBe(true);
  });

  test("rejects self-connections and duplicate connections", () => {
    let state = createEmptySandbox();
    state = addDepartmentReducer(state, "Inventory");
    const departmentId = state.departments[0].id;
    state = addModuleReducer(state, departmentId, "Equipment");
    state = addModuleReducer(state, departmentId, "Suppliers");
    const [equipment, suppliers] = state.modules;

    expect(canConnect(equipment.id, equipment.id, state).ok).toBe(false);
    expect(canConnect(equipment.id, "missing", state).ok).toBe(false);

    state = addLinkReducer(state, equipment.id, suppliers.id, "supplied by");
    expect(canConnect(equipment.id, suppliers.id, state).ok).toBe(false);
  });
});

test.describe("sandbox workflow", () => {
  test("builds departments, modules, fields, relationships, and reaches the automation preview", async ({
    page,
  }) => {
    await gotoSandbox(page);

    // Empty builder suggests the first action.
    await expect(
      page.getByRole("heading", { name: "Start with a department" }),
    ).toBeVisible();

    // Stage 1 — Departments.
    await page.getByTestId("empty-add-department").click();
    await expect(page.getByTestId("inspector-department")).toBeVisible();
    await renameInspectorName(page, "inspector-dept-name", "Inventory");
    await expect(
      canvas(page).getByText("Inventory", { exact: true }),
    ).toBeVisible();

    await page.getByTestId("dept-add-another").click();
    await renameInspectorName(page, "inspector-dept-name", "Sales");
    await page.getByTestId("dept-continue-modules").click();

    // Stage lock: Fields stays unavailable until a module exists.
    await expect(page.getByTestId("stage-step-fields")).toBeDisabled();

    // Stage 2 — Modules (two departments exist, so pick the parent).
    await expect(page.getByTestId("palette-add-module")).toBeVisible();
    // Clear the selected department to exercise the explicit parent chooser;
    // when a department or descendant is selected, creation uses that context
    // directly.
    await canvas(page).click({ position: { x: 700, y: 700 } });
    await page.getByTestId("palette-add-module").click();
    await expect(page.getByTestId("dialog-add-module")).toBeVisible();
    await page.getByTestId("dialog-add-module-confirm").click();
    await expect(page.getByTestId("inspector-module")).toBeVisible();
    await renameInspectorName(page, "inspector-module-name", "Equipment");

    // Stage 3 — Fields on Equipment.
    await page.getByTestId("stage-step-fields").click();
    await expect(
      canvas(page).getByText("Equipment", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("inspector-module-field-count")).toHaveText(
      "0 fields",
    );

    await page.getByTestId("palette-add-field-text").click();
    await expect(page.getByTestId("inspector-field")).toBeVisible();
    await renameInspectorName(page, "inspector-field-name", "Name");

    await page.getByTestId("palette-add-field-int").click();
    await renameInspectorName(page, "inspector-field-name", "Quantity");

    await page.getByTestId("palette-add-field-select").click();
    await renameInspectorName(page, "inspector-field-name", "Status");
    await page.getByTestId("inspector-field-required").check();
    await expect(page.getByTestId("inspector-field-required")).toBeChecked();

    // Module + Field loop: add Suppliers to Inventory.
    await page.getByTestId("loop-add-another-module").click();
    await selectOutlineModule(page, "Equipment");
    await page.getByTestId("palette-add-module").click();
    await expect(page.getByTestId("dialog-add-module")).toHaveCount(0);
    await renameInspectorName(page, "inspector-module-name", "Suppliers");

    await page.getByTestId("stage-step-fields").click();
    await page.getByTestId("palette-add-field-text").click();
    await renameInspectorName(page, "inspector-field-name", "Contact");

    // Loop again: add Orders to Sales (pick the other department).
    await page.getByTestId("loop-add-another-module").click();
    await selectOutlineDepartment(page, "Sales");
    await page.getByTestId("palette-add-module").click();
    await expect(page.getByTestId("dialog-add-module")).toHaveCount(0);
    await renameInspectorName(page, "inspector-module-name", "Orders");

    await page.getByTestId("stage-step-fields").click();
    await page.getByTestId("palette-add-field-text").click();
    await renameInspectorName(page, "inspector-field-name", "Order Number");
    await page.getByTestId("palette-add-field-text").click();
    await renameInspectorName(page, "inspector-field-name", "Customer");
    await page.getByTestId("palette-add-field-select").click();
    await renameInspectorName(page, "inspector-field-name", "Status");

    // Stage 4 — Relationships via the connect dialog.
    await page.getByTestId("loop-continue-relationships").click();

    await expect(page.getByTestId("palette-add-relationship")).toBeVisible();
    await expect(page.getByTestId("palette-add-relationship")).toBeEnabled();
    await page.getByTestId("palette-add-relationship").click();
    await expect(page.getByTestId("dialog-link")).toBeVisible();
    await page.getByTestId("dialog-link-label").fill("supplied by");
    await page.getByTestId("dialog-link-confirm").click();

    await expect(page.getByTestId("inspector-link")).toBeVisible();
    await expect(page.getByTestId("inspector-link-from")).toHaveValue(
      "Equipment",
    );
    await expect(page.getByTestId("inspector-link-to")).toHaveValue(
      "Suppliers",
    );
    await renameInspectorName(
      page,
      "inspector-link-label",
      "supplied by suppliers",
    );

    // The same pair is rejected before the user can submit a duplicate link.
    await page.getByTestId("palette-add-relationship").click();
    await expect(page.getByTestId("dialog-link")).toBeVisible();
    await expect(page.getByTestId("dialog-link-confirm")).toBeDisabled();
    await expect(page.getByTestId("dialog-link").getByRole("alert")).toHaveText(
      "These modules are already connected.",
    );
    await page.getByRole("button", { name: "Cancel" }).click();

    // Second pair, with an explicit target change.
    await page.getByTestId("palette-add-relationship").click();
    await page
      .getByTestId("dialog-link-target")
      .selectOption({ label: "Orders" });
    await page.getByTestId("dialog-link-confirm").click();
    await expect(page.getByTestId("inspector-link-to")).toHaveValue("Orders");

    // Stage 5 — Automation preview only.
    await page.getByTestId("rel-done").click();
    await expect(page.getByTestId("automation-banner")).toContainText(
      "Automation Preview",
    );
    await expect(
      page.getByTestId("inspector-automation-preview"),
    ).toContainText("not available yet");
    await expect(
      page.getByTestId("palette-automation-coming-soon"),
    ).toBeVisible();
    await expect(page.getByTestId("palette-add-automation")).toBeDisabled();
  });

  test("adds a module to the selected department without reopening a parent picker", async ({
    page,
  }) => {
    await gotoSandbox(page);
    await page.getByTestId("empty-add-department").click();
    await renameInspectorName(page, "inspector-dept-name", "Inventory");
    await page.getByTestId("dept-add-another").click();
    await renameInspectorName(page, "inspector-dept-name", "Sales");
    await page.getByTestId("dept-continue-modules").click();

    await page.getByTestId("palette-add-module").click();
    await expect(page.getByTestId("dialog-add-module")).toHaveCount(0);
    const outline = inspectorOutline(page);
    const sales = outline
      .getByTestId("inspector-outline-department")
      .filter({ hasText: "Sales" });
    await expect(sales.getByTestId("inspector-outline-module")).toHaveCount(1);
    await expect(
      sales
        .getByTestId("inspector-outline-module")
        .locator('[aria-current="true"]'),
    ).toHaveCount(1);
  });

  test("places a dragged department at the drop location", async ({ page }) => {
    await gotoSandbox(page);
    const target = canvas(page);
    const bounds = await target.boundingBox();
    if (!bounds) throw new Error("Canvas has no bounds");
    await page
      .locator('[data-kind="department"]')
      .first()
      .dragTo(target, { targetPosition: { x: 420, y: 320 } });
    await expect(page.getByTestId("inspector-department")).toBeVisible();
    const label = target.getByText("New Department", { exact: true });
    await expect(label).toBeVisible();
    const placed = await label.boundingBox();
    if (!placed) throw new Error("Dropped department has no bounds");
    expect(placed.x).toBeCloseTo(bounds.x + 432, 0);
    await renameInspectorName(
      page,
      "inspector-dept-name",
      "Dropped department",
    );
    const renamed = await target
      .getByText("Dropped department", { exact: true })
      .boundingBox();
    expect(renamed?.x).toBeCloseTo(placed.x, 0);
  });

  test("renders all nine fields in a module table", async ({ page }) => {
    await buildSingleModule(page);
    await page.getByTestId("stage-step-fields").click();

    for (let index = 1; index <= 9; index += 1) {
      await addTextField(page, `Field ${index}`);
    }

    await expect(
      canvas(page).getByText("Field 9", { exact: true }),
    ).toBeVisible();
  });

  test("preserves a dragged module position through rename, selection, and stage changes", async ({
    page,
  }) => {
    await buildSingleModule(page);

    const moduleLabel = canvas(page).getByText("Equipment", { exact: true });
    await expect(moduleLabel).toBeVisible();
    const before = await moduleLabel.boundingBox();
    if (before === null) {
      throw new Error("Equipment module label has no bounding box");
    }

    const startX = before.x + before.width / 2;
    const startY = before.y + before.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 10, startY + 8, { steps: 2 });
    // Moving a selected graph node exposes the active drag state immediately
    // so the user can see which object is being manipulated.
    await expect(canvas(page).locator('[data-feedback="moving"]')).toHaveCount(
      1,
    );
    await page.mouse.move(startX + 32, startY + 20, { steps: 5 });
    await page.mouse.up();

    const dragged = await moduleLabel.boundingBox();
    if (dragged === null) {
      throw new Error("Equipment module label disappeared after dragging");
    }
    expect(
      Math.abs(dragged.x - before.x) + Math.abs(dragged.y - before.y),
    ).toBeGreaterThan(4);

    await expect(page.getByTestId("toolbar-undo")).toBeEnabled();
    await page.getByTestId("toolbar-undo").click();
    await expect
      .poll(async () => (await moduleLabel.boundingBox())?.x)
      .toBeCloseTo(before.x, 0);
    await page.getByTestId("toolbar-redo").click();
    await expect
      .poll(async () => (await moduleLabel.boundingBox())?.x)
      .toBeCloseTo(dragged.x, 0);

    await renameInspectorName(
      page,
      "inspector-module-name",
      "Renamed Equipment",
    );
    await selectModuleHeader(page, "Renamed Equipment");
    await expect(page.getByTestId("inspector-module")).toBeVisible();

    await page.getByTestId("stage-step-fields").click();
    await page.getByTestId("stage-step-modules").click();

    const after = await canvas(page)
      .getByText("Renamed Equipment", { exact: true })
      .boundingBox();
    if (after === null) {
      throw new Error("Renamed Equipment module label has no bounding box");
    }
    expect(after.x + after.width / 2).toBeCloseTo(
      dragged.x + dragged.width / 2,
      0,
    );
    expect(after.y).toBeCloseTo(dragged.y, 0);
  });

  test("opens the field inspector when a table row is selected", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await page.getByTestId("stage-step-fields").click();
    await addTextField(page, "Name");

    await canvas(page).click({ position: { x: 700, y: 700 } });
    await expect(page.getByTestId("inspector-empty")).toBeVisible();
    await canvas(page)
      .getByRole("button", { name: "Name", exact: true })
      .click();

    await expect(page.getByTestId("inspector-field")).toBeVisible();
    await expect(page.getByTestId("inspector-field-name")).toHaveValue("Name");
  });

  test("syncs a moved module parent and position across undo, redo, and edits", async ({
    page,
  }) => {
    await buildTwoDepartmentsWithModule(page);

    const moduleLabel = canvas(page).getByText("Module A", { exact: true });
    const original = await nodeBox(moduleLabel);
    if (original === null) {
      throw new Error("Module A has no bounds before moving");
    }
    const departmentB = canvas(page).getByText("Department B", { exact: true });
    const departmentBounds = await departmentB.boundingBox();
    if (departmentBounds === null) {
      throw new Error("Department B has no bounds");
    }

    await dragNodeToPoint(page, moduleLabel, {
      x: departmentBounds.x + departmentBounds.width / 2,
      y: departmentBounds.y + 22,
    });
    await expectModuleParent(page, "Department B");

    const moved = await nodeBox(
      canvas(page).getByText("Module A", { exact: true }),
    );
    if (moved === null) {
      throw new Error("Module A has no bounds after moving");
    }
    expect(
      Math.abs(moved.x - original.x) + Math.abs(moved.y - original.y),
    ).toBeGreaterThan(4);

    await expect(page.getByTestId("toolbar-undo")).toBeEnabled();
    await page.getByTestId("toolbar-undo").click();
    await expectModuleParent(page, "Department A");
    await expect
      .poll(
        async () =>
          (await nodeBox(canvas(page).getByText("Module A", { exact: true })))
            ?.x,
      )
      .toBeCloseTo(original.x, 0);
    await expect
      .poll(
        async () =>
          (await nodeBox(canvas(page).getByText("Module A", { exact: true })))
            ?.y,
      )
      .toBeCloseTo(original.y, 0);

    await renameInspectorName(page, "inspector-module-name", "Module A Undo");
    await selectModuleHeader(page, "Module A Undo");
    await expectModuleParent(page, "Department A");
    const renamedAfterUndo = await nodeBox(
      canvas(page).getByText("Module A Undo", { exact: true }),
    );
    if (renamedAfterUndo === null) {
      throw new Error("Renamed module has no bounds after undo");
    }
    expect(renamedAfterUndo.x).toBeCloseTo(original.x, 0);
    expect(renamedAfterUndo.y).toBeCloseTo(original.y, 0);

    await expect(page.getByTestId("toolbar-redo")).toBeEnabled();
    await page.getByTestId("toolbar-redo").click();
    await expectModuleParent(page, "Department B");
    await renameInspectorName(page, "inspector-module-name", "Module A Redo");
    await selectModuleHeader(page, "Module A Redo");
    await expectModuleParent(page, "Department B");
    const renamedAfterRedo = await nodeBox(
      canvas(page).getByText("Module A Redo", { exact: true }),
    );
    if (renamedAfterRedo === null) {
      throw new Error("Renamed module has no bounds after redo");
    }
    expect(renamedAfterRedo.x).toBeCloseTo(moved.x, 0);
    expect(renamedAfterRedo.y).toBeCloseTo(moved.y, 0);
  });

  test("keeps a module parent and canvas position after a blank drop and edit", async ({
    page,
  }) => {
    await buildSingleModule(page);
    const moduleLabel = canvas(page).getByText("Equipment", { exact: true });
    const canvasBounds = await canvas(page).boundingBox();
    if (canvasBounds === null) {
      throw new Error("Canvas has no bounds");
    }

    await dragNodeToPoint(page, moduleLabel, {
      x: canvasBounds.x + canvasBounds.width - 120,
      y: canvasBounds.y + canvasBounds.height - 120,
    });
    await expectModuleParent(page, "Inventory");

    const blankDropPosition = await nodeBox(
      canvas(page).getByText("Equipment", { exact: true }),
    );
    if (blankDropPosition === null) {
      throw new Error("Equipment has no bounds after blank drop");
    }

    await renameInspectorName(
      page,
      "inspector-module-name",
      "Equipment Edited",
    );
    await selectModuleHeader(page, "Equipment Edited");
    await expectModuleParent(page, "Inventory");
    const editedPosition = await nodeBox(
      canvas(page).getByText("Equipment Edited", { exact: true }),
    );
    if (editedPosition === null) {
      throw new Error("Equipment has no bounds after blank-drop edit");
    }
    expect(editedPosition.x).toBeCloseTo(blankDropPosition.x, 0);
    expect(editedPosition.y).toBeCloseTo(blankDropPosition.y, 0);
  });

  test("keeps the full hierarchy mounted while creating and selecting children from the outline", async ({
    page,
  }) => {
    await buildSingleModule(page);

    const outline = inspectorOutline(page);
    await expect(outline).toBeVisible();
    await expect(
      outline.getByTestId("inspector-outline-department"),
    ).toHaveCount(1);
    await expect(outline.getByTestId("inspector-outline-module")).toHaveCount(
      1,
    );
    await expect(outline.getByTestId("inspector-outline-field")).toHaveCount(0);

    // Child creation is available from the structure itself. It does not
    // require returning to the department or module canvas node first.
    await outline
      .getByRole("button", { name: "Add module to Inventory", exact: true })
      .click();
    const inventory = outline
      .getByTestId("inspector-outline-department")
      .filter({ hasText: "Inventory" });
    await expect(inventory.getByTestId("inspector-outline-module")).toHaveCount(
      2,
    );
    await expect(
      inventory
        .getByTestId("inspector-outline-module")
        .locator('[aria-current="true"]'),
    ).toHaveCount(1);

    await outline
      .getByRole("button", { name: "Add field to Equipment", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Select field Text 1", exact: true }),
    ).toBeVisible();
    await expect(outline.getByTestId("inspector-outline-field")).toHaveCount(1);

    // The inspector remains the same structure view as selection moves among
    // the three levels, while the selected row and canvas receive feedback.
    await selectOutlineDepartment(page, "Inventory");
    await expect(outline).toBeVisible();
    await expect(
      outline.getByRole("button", {
        name: "Select department Inventory",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "true");
    await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(1);

    await selectOutlineModule(page, "Equipment");
    await expect(
      outline.getByRole("button", {
        name: "Select module Equipment",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "true");
    await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(2);

    await selectOutlineField(page, "Text 1");
    await expect(
      outline.getByRole("button", { name: "Select field Text 1", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(1);

    await canvas(page).click({ position: { x: 700, y: 700 } });
    await expect(outline).toBeVisible();
    await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(0);
  });

  test("renames graph nodes and changes a field type with inline editors", async ({
    page,
  }) => {
    await buildSingleModule(page);

    await canvas(page).getByText("Inventory", { exact: true }).dblclick();
    const departmentEditor = page.getByRole("textbox", {
      name: "Canvas name editor",
    });
    await expect(departmentEditor).toBeVisible();
    await departmentEditor.fill("Warehouse");
    await departmentEditor.press("Enter");
    await expect(
      canvas(page).getByText("Warehouse", { exact: true }),
    ).toBeVisible();

    await canvas(page).getByText("Equipment", { exact: true }).dblclick();
    const moduleEditor = page.getByRole("textbox", {
      name: "Canvas name editor",
    });
    await expect(moduleEditor).toBeVisible();
    await moduleEditor.fill("Stock");
    // A name edit also commits on blur, so the canvas remains the source of
    // truth when the user clicks away instead of pressing Enter.
    await canvas(page).click({ position: { x: 700, y: 700 } });
    await expect(
      canvas(page).getByText("Stock", { exact: true }),
    ).toBeVisible();

    await page.getByTestId("stage-step-fields").click();
    await page.getByTestId("palette-add-field-text").click();
    await expect(canvas(page).getByText("TEXT", { exact: true })).toBeVisible();

    await doubleClickFieldCell(page, "Text 1", "name");
    const fieldEditor = page.getByRole("textbox", {
      name: "Canvas name editor",
    });
    await expect(fieldEditor).toBeVisible();
    await fieldEditor.fill("SKU");
    await fieldEditor.press("Enter");
    await expect(canvas(page).getByText("SKU", { exact: true })).toBeVisible();

    await doubleClickFieldCell(page, "SKU", "type");
    const typeEditor = page.getByRole("combobox", {
      name: "Canvas field type",
    });
    await expect(typeEditor).toBeVisible();
    await typeEditor.selectOption("int");
    await expect(
      canvas(page).getByText("INTEGER", { exact: true }),
    ).toBeVisible();

    // Escape cancels an open type editor without changing the committed type.
    await doubleClickFieldCell(page, "SKU", "type");
    const cancelledTypeEditor = page.getByRole("combobox", {
      name: "Canvas field type",
    });
    await expect(cancelledTypeEditor).toBeVisible();
    await cancelledTypeEditor.press("Escape");
    await expect(cancelledTypeEditor).toHaveCount(0);
    await expect(
      canvas(page).getByText("INTEGER", { exact: true }),
    ).toBeVisible();

    await canvas(page).getByText("Stock", { exact: true }).dblclick();
    const cancelledEditor = page.getByRole("textbox", {
      name: "Canvas name editor",
    });
    await expect(cancelledEditor).toBeVisible();
    await cancelledEditor.fill("Discarded name");
    await cancelledEditor.press("Escape");
    await expect(cancelledEditor).toHaveCount(0);
    await expect(
      canvas(page).getByText("Stock", { exact: true }),
    ).toBeVisible();
    await expect(
      canvas(page).getByText("Discarded name", { exact: true }),
    ).toHaveCount(0);
  });
});

test.describe("sandbox mobile editor", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("adds a department from the mobile palette and edits it in the inspector panel", async ({
    page,
  }) => {
    await gotoSandbox(page);
    await page.getByRole("button", { name: "Toggle palette" }).click();
    await page.getByTestId("palette-add-department").last().click();
    await page
      .getByRole("button", { name: "Close palette" })
      .click({ position: { x: 380, y: 100 } });
    await page.getByRole("button", { name: "Toggle inspector" }).click();

    await expect(page.getByTestId("inspector-department").last()).toBeVisible();
    await renameInspectorName(page, "inspector-dept-name", "Mobile Inventory");
    await expect(
      canvas(page).getByText("Mobile Inventory", { exact: true }),
    ).toBeVisible();

    const widths = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(widths.documentWidth).toBeLessThanOrEqual(widths.viewportWidth);
  });
});
