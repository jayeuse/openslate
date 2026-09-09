import { expect, test, type Locator, type Page } from "@playwright/test";

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

    const moduleLabel = node(page, "Equipment");
    const salesLabel = node(page, "Sales");
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
