import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
import { expect, test, type Locator, type Page } from "../coverage";

test.use({ viewport: { width: 1440, height: 900 } });
type SandboxTheme = "light" | "dark";

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
  await page.route("**/bff/**", async (route) => {
    if (!(await fulfillWorkspaceRequest(route))) await route.continue();
  });
  await page.goto("/sandbox");
}

async function setSessionTheme(page: Page, theme: SandboxTheme): Promise<void> {
  await page.evaluate((nextTheme) => {
    window.localStorage.setItem("openslate-theme", nextTheme);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "openslate-theme",
        newValue: nextTheme,
      }),
    );
  }, theme);
}

function canvas(page: Page): Locator {
  return page.getByTestId("sandbox-canvas");
}

function structurePanel(page: Page): Locator {
  return page.getByTestId("sandbox-panel-left");
}

async function paletteItem(page: Page, id: string): Promise<Locator> {
  if (id === "palette-add-module") {
    return structurePanel(page)
      .getByTestId("inspector-outline-add-module")
      .last();
  }
  if (id === "palette-add-relationship") {
    return structurePanel(page).getByTestId("inspector-add-relationship");
  }
  if (id.startsWith("palette-add-field-")) {
    const selectedModule = structurePanel(page)
      .getByTestId("inspector-outline-module")
      .filter({ has: page.locator('[aria-current="true"]') });
    const scoped = selectedModule.getByTestId("inspector-outline-add-field");
    return (await scoped.count()) > 0
      ? scoped.first()
      : structurePanel(page).getByTestId("inspector-outline-add-field").last();
  }
  return structurePanel(page).getByTestId(id);
}

function inspectorKindForInput(inputTestId: string): string {
  if (inputTestId.includes("module")) return "module";
  if (inputTestId.includes("dept")) return "department";
  if (inputTestId.includes("link")) return "relationship";
  return "field";
}

async function openSelectedEdit(
  page: Page,
  inputTestId: string,
): Promise<Locator> {
  const dialog = page.getByTestId("dialog-edit-item");
  const input = dialog.getByTestId(inputTestId);
  if (!(await input.isVisible())) {
    if (await dialog.isVisible()) {
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    }
    const kind = inspectorKindForInput(inputTestId);
    const selected = structurePanel(page).locator(
      kind === "relationship"
        ? 'button[aria-label^="Select relationship "][aria-current="true"]'
        : `button[aria-label^="Select ${kind} "][aria-current="true"]`,
    );
    const selectedRow = selected.last().locator("xpath=..");
    const action = selectedRow.getByRole("button", {
      name: new RegExp(`^Edit ${kind} `),
    });
    if ((await action.count()) === 0) {
      await structurePanel(page)
        .locator(`button[aria-label^="Edit ${kind} "]`)
        .last()
        .click();
    } else {
      await action.click();
    }
  }
  await expect(input).toBeVisible();
  return input;
}

async function renameInspectorName(
  page: Page,
  inputTestId: string,
  name: string,
): Promise<void> {
  const input = await openSelectedEdit(page, inputTestId);
  await input.fill(name);
  await expect(input).toHaveValue(name);
  const dialog = page.getByTestId("dialog-edit-item");
  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
}

async function selectOutlineDepartment(
  page: Page,
  name: string,
): Promise<void> {
  await structurePanel(page)
    .getByRole("button", {
      name: "Select department " + name,
      exact: true,
    })
    .click();
}

async function selectOutlineModule(page: Page, name: string): Promise<void> {
  await structurePanel(page)
    .getByRole("button", {
      name: "Select module " + name,
      exact: true,
    })
    .click();
}

async function selectOutlineField(page: Page, name: string): Promise<void> {
  await structurePanel(page)
    .getByRole("button", {
      name: "Select field " + name,
      exact: true,
    })
    .click();
}

async function addDepartmentFromEmpty(
  page: Page,
  name = "Inventory",
): Promise<void> {
  await page.getByTestId("empty-add-department").click();
  await renameInspectorName(page, "inspector-dept-name", name);
}

async function addModuleFromPalette(
  page: Page,
  name: string,
  department?: string,
): Promise<void> {
  if (department !== undefined) {
    await selectOutlineDepartment(page, department);
  }
  await (await paletteItem(page, "palette-add-module")).click();
  await renameInspectorName(page, "inspector-module-name", name);
}

async function addModuleFromOutline(
  page: Page,
  department: string,
  name: string,
): Promise<void> {
  await structurePanel(page)
    .getByRole("button", {
      name: "Add module to " + department,
      exact: true,
    })
    .click();
  await renameInspectorName(page, "inspector-module-name", name);
}

async function buildSingleModule(
  page: Page,
  departmentName = "Inventory",
  moduleName = "Equipment",
): Promise<void> {
  await gotoSandbox(page);
  await addDepartmentFromEmpty(page, departmentName);
  await addModuleFromPalette(page, moduleName);
}

async function buildTwoModules(page: Page): Promise<void> {
  await buildSingleModule(page);
  await addModuleFromOutline(page, "Inventory", "Suppliers");
}

async function nodeBox(
  node: Locator,
): Promise<Awaited<ReturnType<Locator["boundingBox"]>>> {
  return node
    .locator("xpath=ancestor::*[@data-cell-id][1]")
    .locator("rect")
    .first()
    .boundingBox();
}

async function dragNodeToPoint(
  page: Page,
  node: Locator,
  target: { x: number; y: number },
): Promise<void> {
  const before = await nodeBox(node);
  if (before === null) throw new Error("Dragged node has no bounds");
  await page.mouse.move(
    before.x + before.width / 2,
    before.y + before.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.mouse.up();
}

function node(page: Page, label: string): Locator {
  return canvas(page).getByText(label, { exact: true });
}

test.describe("sandbox freeform layout and panel behavior", () => {
  test("creates, edits, and deletes hierarchy items from Structure rows", async ({
    page,
  }) => {
    await gotoSandbox(page);

    await structurePanel(page).getByTestId("inspector-add-department").click();
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Edit department New Department",
        exact: true,
      }),
    ).toBeVisible();
    await renameInspectorName(page, "inspector-dept-name", "Inventory");

    await structurePanel(page)
      .getByTestId("inspector-outline-add-module")
      .click();
    await renameInspectorName(page, "inspector-module-name", "Equipment");
    await structurePanel(page)
      .getByTestId("inspector-outline-add-field")
      .click();
    await renameInspectorName(page, "inspector-field-name", "Name");

    const edit = page.getByTestId("dialog-edit-item");
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Edit field Name",
        exact: true,
      }),
    ).toBeVisible();
    await selectOutlineField(page, "Name");
    await openSelectedEdit(page, "inspector-field-description");
    await edit.getByTestId("inspector-field-description").fill("Display name");
    await edit.getByRole("button", { name: "Done", exact: true }).click();

    await structurePanel(page)
      .getByRole("button", { name: "Delete field Name", exact: true })
      .click();
    await expect(page.getByTestId("dialog-delete-confirm")).toContainText(
      "Name",
    );
    await page.getByTestId("dialog-delete-confirm-button").click();
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select field Name",
        exact: true,
      }),
    ).toHaveCount(0);

    await structurePanel(page)
      .getByRole("button", { name: "Delete module Equipment", exact: true })
      .click();
    await page.getByTestId("dialog-delete-confirm-button").click();
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select module Equipment",
        exact: true,
      }),
    ).toHaveCount(0);

    await structurePanel(page)
      .getByRole("button", { name: "Delete department Inventory", exact: true })
      .click();
    await page.getByTestId("dialog-delete-confirm-button").click();
    await expect(structurePanel(page)).toContainText("No departments yet");
  });
});

test.describe("sandbox freeform creation and inspection", () => {
  test("creates a relationship through the dialog and rejects a duplicate", async ({
    page,
  }) => {
    await buildTwoModules(page);
    const addRelationship = structurePanel(page).getByTestId(
      "inspector-add-relationship",
    );
    await expect(addRelationship).toBeEnabled();
    await addRelationship.click();
    await expect(page.getByTestId("dialog-link")).toBeVisible();
    await page.getByTestId("dialog-link-label").fill("supplied by");
    await page.getByTestId("dialog-link-confirm").click();
    await structurePanel(page)
      .getByRole("button", {
        name: "Select relationship supplied by",
        exact: true,
      })
      .click();
    const edit = page.getByTestId("dialog-edit-item");
    await openSelectedEdit(page, "inspector-link-label");
    await expect(edit.getByTestId("inspector-link")).toBeVisible();
    await expect(edit.getByTestId("inspector-link-from")).toHaveText(
      "Equipment",
    );
    await expect(edit.getByTestId("inspector-link-to")).toHaveText("Suppliers");
    await expect(edit.getByTestId("inspector-link-type")).toBeDisabled();
    await edit.getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      canvas(page).getByText("supplied by", { exact: true }),
    ).toBeVisible();
    const line = canvas(page).locator('[data-sandbox-line="true"]');
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute("stroke-dasharray", "7 5");
    expect([null, "", "none"]).toContain(await line.getAttribute("marker-end"));
    await expect
      .poll(async () =>
        line.evaluate((element) => getComputedStyle(element).animationName),
      )
      .toBe("sandbox-relationship-flow");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(async () =>
        line.evaluate((element) => getComputedStyle(element).animationName),
      )
      .toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });

    await setSessionTheme(page, "dark");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(
      canvas(page).getByText("supplied by", { exact: true }),
    ).toBeVisible();
    await setSessionTheme(page, "light");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(
      canvas(page).getByText("supplied by", { exact: true }),
    ).toBeVisible();

    await addRelationship.click();
    await expect(page.getByTestId("dialog-link-confirm")).toBeDisabled();
    await expect(page.getByTestId("dialog-link").getByRole("alert")).toHaveText(
      "These modules are already connected.",
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });
});

test.describe("sandbox graph movement, drops, and mobile drawers", () => {
  test("uses exclusive mobile drawers with focus trapping, Escape dismissal, and restoration", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoSandbox(page);

    const structureTrigger = page.getByRole("button", {
      name: "Toggle structure",
      exact: true,
    });
    await structureTrigger.click();
    const structureDrawer = page.getByRole("dialog", {
      name: "Structure",
      exact: true,
    });
    await expect(structureDrawer).toBeVisible();
    await expect(
      structureDrawer.getByRole("button", {
        name: "Close structure",
        exact: true,
      }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(structureDrawer).toContainText("No departments yet");
    await page.keyboard.press("Escape");
    await expect(structureTrigger).toBeFocused();
    await expect(structureDrawer).toHaveCount(0);

    await structureTrigger.click();
    await expect(structureDrawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(structureTrigger).toBeFocused();

    const navigationTrigger = page.getByRole("button", {
      name: "Open navigation",
      exact: true,
    });
    await navigationTrigger.click();
    const navigationDrawer = page.locator("#mobile-navigation");
    await expect(
      navigationDrawer.getByRole("button", {
        name: "Close navigation",
        exact: true,
      }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(navigationTrigger).toBeFocused();
  });
});

test.describe("sandbox regression coverage", () => {
  test("reparents a dragged module with one undo operation and preserves edits", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await structurePanel(page).getByTestId("inspector-add-department").click();
    await renameInspectorName(page, "inspector-dept-name", "Sales");
    await selectOutlineModule(page, "Equipment");

    await page.getByTestId("toolbar-fit").click();
    const moduleLabel = node(page, "Equipment");
    const salesLabel = node(page, "Sales");
    await expect(moduleLabel).toBeVisible();
    await expect(salesLabel).toBeVisible();
    const salesBounds = await nodeBox(salesLabel);
    if (salesBounds === null) throw new Error("Sales frame has no bounds");
    await dragNodeToPoint(page, moduleLabel, {
      x: salesBounds.x + salesBounds.width / 2,
      y: salesBounds.y + 24,
    });
    const movedEdit = page.getByTestId("dialog-edit-item");
    await openSelectedEdit(page, "inspector-module-dept");
    await expect(
      movedEdit.getByTestId("inspector-module-dept").locator("option:checked"),
    ).toHaveText("Sales");
    await movedEdit.getByRole("button", { name: "Done", exact: true }).click();

    await page.getByTestId("toolbar-undo").click();
    await selectOutlineModule(page, "Equipment");
    const undoEdit = page.getByTestId("dialog-edit-item");
    await openSelectedEdit(page, "inspector-module-dept");
    await expect
      .poll(async () =>
        undoEdit
          .getByTestId("inspector-module-dept")
          .locator("option:checked")
          .textContent(),
      )
      .toBe("Inventory");
    await undoEdit.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByTestId("toolbar-redo").click();
    await selectOutlineModule(page, "Equipment");
    const redoEdit = page.getByTestId("dialog-edit-item");
    await openSelectedEdit(page, "inspector-module-dept");
    await expect
      .poll(async () =>
        redoEdit
          .getByTestId("inspector-module-dept")
          .locator("option:checked")
          .textContent(),
      )
      .toBe("Sales");
    await redoEdit.getByRole("button", { name: "Done", exact: true }).click();

    await renameInspectorName(page, "inspector-module-name", "Equipment v2");
    await selectOutlineModule(page, "Equipment v2");
    const finalEdit = page.getByTestId("dialog-edit-item");
    await openSelectedEdit(page, "inspector-module-dept");
    await expect(
      finalEdit.getByTestId("inspector-module-dept").locator("option:checked"),
    ).toHaveText("Sales");
    await finalEdit.getByRole("button", { name: "Done", exact: true }).click();
  });
});

test.describe("sandbox editing and dependency protection", () => {
  test("commits inline names, cancels drafts, and keeps field settings in sync", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await structurePanel(page)
      .getByRole("button", { name: "Select module Equipment", exact: true })
      .dblclick();
    const outlineName = page.getByRole("textbox", {
      name: "Edit module name",
      exact: true,
    });
    await outlineName.fill("Assets");
    await outlineName.press("Enter");
    await expect(node(page, "Assets")).toBeVisible();
    await structurePanel(page)
      .getByRole("button", { name: "Select module Assets", exact: true })
      .dblclick();
    await outlineName.fill("Discarded draft");
    await outlineName.press("Escape");
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select module Assets",
        exact: true,
      }),
    ).toBeVisible();
    await (await paletteItem(page, "palette-add-field-text")).click();
    await renameInspectorName(page, "inspector-field-name", "Quantity");
    await canvas(page)
      .getByRole("button", { name: "Quantity, Text, optional", exact: true })
      .dblclick({ position: { x: 30, y: 15 } });
    const canvasName = page.getByRole("textbox", {
      name: "Canvas name editor",
      exact: true,
    });
    await canvasName.fill("Stock count");
    await canvasName.press("Enter");
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select field Stock count",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "true");
    await canvas(page)
      .getByRole("button", { name: "Stock count, Text, optional", exact: true })
      .dblclick({ position: { x: 30, y: 15 } });
    await canvasName.fill("Cancelled count");
    await canvasName.press("Escape");
    await expect(node(page, "Stock count")).toBeVisible();
    await canvas(page)
      .getByRole("button", { name: "Stock count, Text, optional", exact: true })
      .dblclick({ position: { x: 245, y: 15 } });
    await page
      .getByRole("combobox", { name: "Canvas field type", exact: true })
      .selectOption("int");
    await openSelectedEdit(page, "inspector-field-name");
    const edit = page.getByTestId("dialog-edit-item");
    await expect(
      edit.getByRole("combobox", { name: "Field type", exact: true }),
    ).toHaveValue("int");
    await edit.getByRole("checkbox", { name: "Required", exact: true }).check();
    await edit
      .getByLabel("Description", { exact: true })
      .fill("Available units");
    await edit.getByRole("button", { name: "Done", exact: true }).click();
    await openSelectedEdit(page, "inspector-field-name");
    await expect(
      edit.getByRole("checkbox", { name: "Required", exact: true }),
    ).toBeChecked();
    await expect(edit.getByLabel("Description", { exact: true })).toHaveValue(
      "Available units",
    );
  });

  test("rejects a self relationship and removes dependent fields and links only after confirmation", async ({
    page,
  }) => {
    await buildTwoModules(page);
    await selectOutlineModule(page, "Equipment");
    await (await paletteItem(page, "palette-add-field-text")).click();
    await renameInspectorName(page, "inspector-field-name", "Asset tag");
    await structurePanel(page)
      .getByTestId("inspector-add-relationship")
      .click();
    const link = page.getByTestId("dialog-link");
    await link
      .getByTestId("dialog-link-target")
      .selectOption({ label: "Equipment" });
    await expect(link.getByRole("alert")).toBeVisible();
    await expect(link.getByTestId("dialog-link-confirm")).toBeDisabled();
    await link
      .getByTestId("dialog-link-target")
      .selectOption({ label: "Suppliers" });
    await link.getByTestId("dialog-link-label").fill("Supplied by");
    await link.getByTestId("dialog-link-confirm").click();
    await structurePanel(page)
      .getByRole("button", {
        name: "Edit relationship Supplied by",
        exact: true,
      })
      .click();
    await page.getByTestId("inspector-link-label").fill("Provided by");
    await page
      .getByTestId("dialog-edit-item")
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await expect(node(page, "Provided by")).toBeVisible();
    await structurePanel(page)
      .getByRole("button", { name: "Delete department Inventory", exact: true })
      .click();
    const confirmation = page.getByTestId("dialog-delete-confirm");
    await expect(confirmation).toContainText("2 modules, 1 field");
    await confirmation
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(node(page, "Provided by")).toBeVisible();
    await expect(node(page, "Asset tag")).toBeVisible();
    await structurePanel(page)
      .getByRole("button", { name: "Delete department Inventory", exact: true })
      .click();
    await confirmation.getByTestId("dialog-delete-confirm-button").click();
    await expect(structurePanel(page)).toContainText("No departments yet");
    await expect(
      canvas(page).locator('[data-sandbox-line="true"]'),
    ).toHaveCount(0);
    await expect(node(page, "Asset tag")).toHaveCount(0);
    await expect(
      structurePanel(page).getByTestId("inspector-add-relationship"),
    ).toBeDisabled();
  });

  test("resizes a department with keyboard precision and retains children through zoom and panel changes", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await selectOutlineDepartment(page, "Inventory");
    const department = node(page, "Inventory");
    const initial = await nodeBox(department);
    if (!initial) throw new Error("Department frame is missing");
    const grip = canvas(page).getByRole("button", {
      name: "Resize department",
      exact: true,
    });
    await grip.focus();
    await grip.press("ArrowRight");
    await expect
      .poll(async () => (await nodeBox(department))?.width ?? 0)
      .toBeGreaterThan(initial.width);
    await grip.press("Alt+ArrowDown");
    await expect
      .poll(async () => (await nodeBox(department))?.height ?? 0)
      .toBeGreaterThan(initial.height);
    const resized = await nodeBox(department);
    if (!resized) throw new Error("Resized department frame is missing");
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect
      .poll(async () => (await nodeBox(department))?.width ?? 0)
      .toBeGreaterThan(resized.width);
    await page.getByRole("button", { name: "Zoom out", exact: true }).click();
    await page
      .getByRole("button", { name: "Center canvas", exact: true })
      .click();
    await expect(structurePanel(page)).toBeVisible();
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(
      page.getByRole("dialog", { name: "Structure", exact: true }),
    ).not.toBeVisible();
    await page
      .getByRole("button", { name: "Toggle structure", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Structure", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Structure", exact: true }),
    ).not.toBeVisible();
    await page
      .getByRole("button", { name: "Fit to screen", exact: true })
      .click();
    await expect(node(page, "Equipment")).toBeVisible();
    await page
      .getByRole("button", { name: "Toggle structure", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog", { name: "Structure", exact: true })
        .getByRole("button", {
          name: "Select module Equipment",
          exact: true,
        }),
    ).toBeVisible();
  });

  test("keeps the canonical parent after a blank drop and undoes and redoes the move with keyboard shortcuts", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await page
      .getByRole("button", { name: "Fit to screen", exact: true })
      .click();
    const equipment = node(page, "Equipment");
    const before = await nodeBox(equipment);
    const bounds = await canvas(page).boundingBox();
    if (!before || !bounds)
      throw new Error("Canvas or module bounds are missing");
    await page.keyboard.down("Alt");
    await dragNodeToPoint(page, equipment, {
      x: bounds.x + bounds.width - 170,
      y: bounds.y + bounds.height - 110,
    });
    await page.keyboard.up("Alt");
    await expect
      .poll(async () => (await nodeBox(equipment))?.x ?? before.x)
      .not.toBe(before.x);
    const moved = await nodeBox(equipment);
    if (!moved) throw new Error("Moved module bounds are missing");
    await openSelectedEdit(page, "inspector-module-dept");
    const edit = page.getByTestId("dialog-edit-item");
    await expect(
      edit.getByTestId("inspector-module-dept").locator("option:checked"),
    ).toHaveText("Inventory");
    await edit.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Undo move", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(async () => (await nodeBox(equipment))?.x ?? 0)
      .toBeCloseTo(before.x, 0);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect
      .poll(async () => (await nodeBox(equipment))?.x ?? 0)
      .toBeCloseTo(moved.x, 0);
  });
});

test("creates hierarchy by dragging Structure controls onto canvas parents", async ({
  page,
}) => {
  await buildSingleModule(page);
  await structurePanel(page)
    .getByRole("button", { name: "Add department", exact: true })
    .dragTo(canvas(page), { targetPosition: { x: 750, y: 400 } });
  await renameInspectorName(page, "inspector-dept-name", "Sales");
  await page
    .getByRole("button", { name: "Fit to screen", exact: true })
    .click();
  await structurePanel(page)
    .getByRole("button", { name: "Add module to Inventory", exact: true })
    .dragTo(node(page, "Sales"));
  await renameInspectorName(page, "inspector-module-name", "Orders");
  const sales = structurePanel(page)
    .getByTestId("inspector-outline-department")
    .filter({
      has: page.getByRole("button", {
        name: "Select department Sales",
        exact: true,
      }),
    });
  await expect(
    sales.getByRole("button", { name: "Select module Orders", exact: true }),
  ).toBeVisible();
  await structurePanel(page)
    .getByRole("button", { name: "Add field to Equipment", exact: true })
    .dragTo(node(page, "Orders"));
  await renameInspectorName(page, "inspector-field-name", "Order reference");
  await expect(
    sales.getByRole("button", {
      name: "Select field Order reference",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    canvas(page).getByRole("button", {
      name: "Order reference, Text, optional",
      exact: true,
    }),
  ).toBeVisible();
});

test.describe("sandbox direct manipulation", () => {
  test("persists pointer-resized Structure width and supports keyboard and double-click reset", async ({
    page,
  }) => {
    await gotoSandbox(page);
    const separator = page.getByRole("separator", {
      name: "Resize Structure",
      exact: true,
    });
    await expect(separator).toHaveAttribute("aria-valuenow", "408");
    const bounds = await separator.boundingBox();
    if (!bounds) throw new Error("Structure separator bounds are missing");
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + 100, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(separator).toHaveAttribute("aria-valuenow", "488");
    await page.reload();
    await expect(separator).toHaveAttribute("aria-valuenow", "488");
    await separator.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", "472");
    await separator.press("Home");
    await expect(separator).toHaveAttribute("aria-valuenow", "408");
    await separator.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "424");
    await separator.dblclick();
    await expect(separator).toHaveAttribute("aria-valuenow", "408");
  });

  test("resizes a department by pointer without moving its child module", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await page
      .getByRole("button", { name: "Fit to screen", exact: true })
      .click();
    await selectOutlineDepartment(page, "Inventory");
    const department = node(page, "Inventory");
    const before = await nodeBox(department);
    const childBefore = await nodeBox(node(page, "Equipment"));
    const grip = canvas(page).getByRole("button", {
      name: "Resize department",
      exact: true,
    });
    const bounds = await grip.boundingBox();
    if (!before || !childBefore || !bounds)
      throw new Error("Department resize bounds are missing");
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.down();
    await page.keyboard.down("Alt");
    await page.mouse.move(
      bounds.x + bounds.width / 2 + 53,
      bounds.y + bounds.height / 2 + 37,
      { steps: 8 },
    );
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await expect
      .poll(async () => (await nodeBox(department))?.width ?? 0)
      .toBeGreaterThan(before.width);
    await expect
      .poll(async () => (await nodeBox(department))?.height ?? 0)
      .toBeGreaterThan(before.height);
    const childAfter = await nodeBox(node(page, "Equipment"));
    if (!childAfter)
      throw new Error("Child module bounds are missing after resize");
    expect(childAfter.x).toBeCloseTo(childBefore.x, 0);
    expect(childAfter.y).toBeCloseTo(childBefore.y, 0);
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select module Equipment",
        exact: true,
      }),
    ).toBeVisible();
  });

  test("edits department and module canvas headings with blank rejection, commit and cancellation", async ({
    page,
  }) => {
    await buildSingleModule(page);
    const editor = page.getByRole("textbox", {
      name: "Canvas name editor",
      exact: true,
    });
    await node(page, "Inventory").dblclick();
    await expect(editor).toHaveValue("Inventory");
    await editor.fill("   ");
    await editor.press("Enter");
    await expect(editor).toBeVisible();
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select department Inventory",
        exact: true,
      }),
    ).toBeVisible();
    await editor.fill("  Operations  ");
    await editor.press("Enter");
    await expect(node(page, "Operations")).toBeVisible();
    await node(page, "Equipment").dblclick();
    await expect(editor).toHaveValue("Equipment");
    await editor.fill("Assets");
    await editor.press("Tab");
    await expect(node(page, "Assets")).toBeVisible();
    await node(page, "Assets").dblclick();
    await editor.fill("Cancelled module");
    await editor.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select module Assets",
        exact: true,
      }),
    ).toBeVisible();
    await expect(node(page, "Cancelled module")).toHaveCount(0);
  });

  test("opens the selected department, module and field name editor with F2", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await (await paletteItem(page, "palette-add-field-text")).click();
    await renameInspectorName(page, "inspector-field-name", "Asset tag");
    const editor = page.getByRole("textbox", {
      name: "Canvas name editor",
      exact: true,
    });
    await node(page, "Inventory").click();
    await page.keyboard.press("F2");
    await expect(editor).toHaveValue("Inventory");
    await editor.press("Escape");
    await node(page, "Equipment").click();
    await page.keyboard.press("F2");
    await expect(editor).toHaveValue("Equipment");
    await editor.press("Escape");
    const field = canvas(page).getByRole("button", {
      name: "Asset tag, Text, optional",
      exact: true,
    });
    await field.focus();
    await field.press("Enter");
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select field Asset tag",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "true");
    await field.press("F2");
    await expect(editor).toHaveValue("Asset tag");
    await editor.fill("Serial number");
    await editor.press("Enter");
    await expect(
      canvas(page).getByRole("button", {
        name: "Serial number, Text, optional",
        exact: true,
      }),
    ).toBeVisible();
  });

  test("rejects a field dropped on a department and accepts a subsequent module drop", async ({
    page,
  }) => {
    await buildSingleModule(page);
    const addField = structurePanel(page).getByRole("button", {
      name: "Add field to Equipment",
      exact: true,
    });
    await addField.dragTo(node(page, "Inventory"));
    await expect(
      canvas(page).getByText("Fields can only be added inside a module.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByTestId("dialog-edit-item")).toHaveCount(0);
    await expect(
      structurePanel(page).getByTestId("inspector-outline-field"),
    ).toHaveCount(0);
    await addField.dragTo(node(page, "Equipment"));
    await renameInspectorName(page, "inspector-field-name", "Accepted field");
    await expect(
      canvas(page).getByText("Fields can only be added inside a module.", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select field Accepted field",
        exact: true,
      }),
    ).toBeVisible();
  });
});
