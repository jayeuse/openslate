import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  FIELD_TYPE_META,
  addDepartment,
  addLink,
  addModule,
  createEmptySandbox,
  type SandboxFieldType,
} from "../src/lib/sandbox/model";
import { canConnect, canEmbed } from "../src/lib/sandbox/rules";
import {
  MODULE_TABLE,
  MODULE_TABLE_COLORS,
  moduleTableAttrs,
  moduleTableHeight,
  moduleTableMarkup,
} from "../src/lib/sandbox/x6-adapter";

test.use({ viewport: { width: 1440, height: 900 } });

const PANEL_STORAGE_KEY = "openslate.sandbox.panel-widths.v1";
const LEFT_MIN = 408;
const CANVAS_MIN = 360;
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

function detailsPanel(page: Page): Locator {
  return page.getByTestId("sandbox-panel-right");
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

async function addField(
  page: Page,
  type: SandboxFieldType,
  name: string,
): Promise<void> {
  await (await paletteItem(page, "palette-add-field-" + type)).click();
  await renameInspectorName(page, "inspector-field-name", name);
  if (type !== "text") {
    const edit = page.getByTestId("dialog-edit-item");
    await openSelectedEdit(page, "inspector-field-type");
    await edit.getByTestId("inspector-field-type").selectOption(type);
    await edit.getByRole("button", { name: "Done", exact: true }).click();
  }
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

function departmentNode(page: Page, name: string): Locator {
  return node(page, name).locator("xpath=ancestor::*[@data-cell-id][1]");
}

function departmentBody(page: Page, name: string): Locator {
  return departmentNode(page, name).locator('[data-sandbox-body="true"]');
}

function departmentResizeGrip(page: Page, name: string): Locator {
  return departmentNode(page, name).getByRole("button", {
    name: "Resize department",
    exact: true,
  });
}

async function departmentSize(
  page: Page,
  name: string,
): Promise<{ width: number; height: number }> {
  const body = departmentBody(page, name);
  return {
    width: Number(await body.getAttribute("width")),
    height: Number(await body.getAttribute("height")),
  };
}

async function clickCanvasBlank(page: Page): Promise<void> {
  const bounds = await canvas(page).boundingBox();
  if (bounds === null) throw new Error("Canvas has no bounds");
  await page.mouse.click(
    bounds.x + Math.max(20, bounds.width - 20),
    bounds.y + 20,
  );
}

async function expectDialogFocusContainment(
  page: Page,
  dialog: Locator,
): Promise<void> {
  const controls = dialog.locator(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="radio"]',
  );
  await expect(controls.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(controls.last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(controls.first()).toBeFocused();
}

async function panelWidth(panel: Locator): Promise<number> {
  return panel.evaluate((element) => element.getBoundingClientRect().width);
}

test.describe("sandbox pure contracts", () => {
  test("allows only department > module > field containment", () => {
    expect(canEmbed("department", "module")).toBe(true);
    expect(canEmbed("module", "field")).toBe(true);
    expect(canEmbed("department", "field")).toBe(false);
    expect(canEmbed("module", "module")).toBe(false);
    expect(canEmbed("field", "module")).toBe(false);
  });

  test("rejects unknown, self, and duplicate directed module relationships", () => {
    let state = addDepartment(createEmptySandbox(), "Inventory");
    const departmentId = state.departments[0]!.id;
    state = addModule(state, departmentId, "Equipment");
    state = addModule(state, departmentId, "Suppliers");
    const [source, target] = state.modules;

    expect(canConnect(source!.id, source!.id, state)).toEqual({
      ok: false,
      reason: "A module cannot connect to itself.",
    });
    expect(canConnect(source!.id, "missing", state).ok).toBe(false);

    state = addLink(state, source!.id, target!.id, "supplied by");
    expect(canConnect(source!.id, target!.id, state)).toEqual({
      ok: false,
      reason: "These modules are already connected.",
    });
  });

  test("defines the compact module card and accessible field-row geometry", () => {
    expect(MODULE_TABLE).toMatchObject({
      width: 280,
      headerHeight: 40,
      rowHeight: 32,
    });
    expect(moduleTableHeight(0)).toBe(72);
    expect(moduleTableHeight(2)).toBe(104);
    expect(moduleTableMarkup(2)).toHaveLength(4 + 2 * 5);

    const attrs = moduleTableAttrs("Equipment", [
      {
        id: "field-id",
        moduleId: "module-id",
        name: "Name",
        type: "text",
        required: false,
        description: "",
      },
    ]);
    expect(attrs.body).toMatchObject({ rx: 8, ry: 8, width: 280 });
    expect(attrs.headerBar).toMatchObject({ height: 40, width: 280 });
    expect(attrs.row0).toMatchObject({
      height: 31,
      "aria-selected": "false",
    });
    expect(attrs.name0).toMatchObject({ x: 26 });
    expect(attrs.type0).toMatchObject({
      x: 270,
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
    });
    expect(attrs.row0!["aria-label"]).toBe("Name, Text, optional");
  });

  test("alternates field rows while selected rows keep their active fill", () => {
    const fields = [
      {
        id: "field-1",
        moduleId: "module-id",
        name: "Name",
        type: "text" as const,
        required: true,
        description: "",
      },
      {
        id: "field-2",
        moduleId: "module-id",
        name: "Quantity",
        type: "int" as const,
        required: false,
        description: "",
      },
      {
        id: "field-3",
        moduleId: "module-id",
        name: "Status",
        type: "select" as const,
        required: false,
        description: "",
      },
    ];
    const attrs = moduleTableAttrs("Equipment", fields, "field-3");

    expect(attrs.row0).toMatchObject({
      fill: MODULE_TABLE_COLORS.bodyFill,
      "aria-selected": "false",
    });
    expect(attrs.row1).toMatchObject({
      fill: MODULE_TABLE_COLORS.stripeFill,
      "aria-selected": "false",
    });
    expect(attrs.row2).toMatchObject({
      fill: MODULE_TABLE_COLORS.selectedRowFill,
      "aria-selected": "true",
    });
  });
});

test.describe("sandbox freeform layout and panel behavior", () => {
  test("renders Structure left with trailing add actions and no right inspector", async ({
    page,
  }) => {
    await gotoSandbox(page);

    await expect(structurePanel(page)).toBeVisible();
    await expect(structurePanel(page)).toHaveCSS("width", `${LEFT_MIN}px`);
    const guidance = structurePanel(page).getByText(
      "Select an item or use Edit for its settings. Double-click a name to rename it.",
      { exact: true },
    );
    await expect
      .poll(() =>
        guidance.evaluate((element) => {
          const lineHeight = Number.parseFloat(
            getComputedStyle(element).lineHeight,
          );
          return element.getBoundingClientRect().height / lineHeight;
        }),
      )
      .toBe(1);
    await expect(detailsPanel(page)).toHaveCount(0);
    await expect(
      structurePanel(page).getByText("Structure", { exact: true }),
    ).toBeVisible();
    await expect(
      structurePanel(page).getByTestId("inspector-add-department"),
    ).toBeVisible();
    await expect(
      structurePanel(page).getByTestId("inspector-add-relationship"),
    ).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.getByText("Continue", { exact: true })).toHaveCount(0);
    await expect(
      page.locator("main#main-content").getByText("Automation Preview", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.locator("main#main-content").getByText("Automation", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(page.getByTestId("sandbox-resize-right")).toHaveCount(0);
  });

  test("keeps prerequisites local to each Add action and uses the selected parent", async ({
    page,
  }) => {
    await gotoSandbox(page);

    await expect(
      structurePanel(page).getByTestId("inspector-outline-add-module"),
    ).toHaveCount(0);
    await expect(
      page.getByText("Add a department first.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      structurePanel(page).getByTestId("inspector-add-relationship"),
    ).toBeDisabled();
    await expect(
      page.getByText("Add two modules to connect them.", { exact: true }),
    ).toBeVisible();

    await addDepartmentFromEmpty(page);
    await addModuleFromPalette(page, "Equipment");
    await addField(page, "text", "Name");
    await selectOutlineModule(page, "Equipment");
    await addModuleFromPalette(page, "Suppliers");
    await expect(
      structurePanel(page)
        .getByTestId("inspector-outline-department")
        .filter({ hasText: "Inventory" })
        .getByTestId("inspector-outline-module"),
    ).toHaveCount(2);
    await expect(
      structurePanel(page).getByTestId("inspector-outline-add-field"),
    ).toHaveCount(2);
    await expect(
      structurePanel(page).getByTestId("inspector-add-relationship"),
    ).toBeEnabled();
  });

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

  test("supports left panel pointer and keyboard resizing, reset controls, and canvas limits", async ({
    page,
  }) => {
    await gotoSandbox(page);

    const left = structurePanel(page);
    const leftSeparator = page.getByTestId("sandbox-resize-left");
    await expect(leftSeparator).toHaveAttribute(
      "aria-valuemin",
      String(LEFT_MIN),
    );
    await expect(leftSeparator).toHaveAttribute(
      "aria-valuenow",
      String(LEFT_MIN),
    );
    await expect(page.getByTestId("sandbox-resize-right")).toHaveCount(0);

    await leftSeparator.focus();
    await page.keyboard.press("ArrowRight");
    await expect(leftSeparator).toHaveAttribute(
      "aria-valuenow",
      String(LEFT_MIN + 16),
    );
    await expect(left).toHaveCSS("width", `${LEFT_MIN + 16}px`);

    const pointerStart = await leftSeparator.boundingBox();
    if (pointerStart === null) throw new Error("Left separator has no bounds");
    await page.mouse.move(
      pointerStart.x + pointerStart.width / 2,
      pointerStart.y + 200,
    );
    await page.mouse.down();
    await page.mouse.move(
      pointerStart.x + pointerStart.width / 2 + 48,
      pointerStart.y + 200,
    );
    await page.mouse.up();
    await expect(leftSeparator).toHaveAttribute(
      "aria-valuenow",
      String(LEFT_MIN + 64),
    );

    await leftSeparator.focus();
    await page.keyboard.press("Home");
    await expect(leftSeparator).toHaveAttribute(
      "aria-valuenow",
      String(LEFT_MIN),
    );
    await leftSeparator.dblclick();
    await expect(leftSeparator).toHaveAttribute(
      "aria-valuenow",
      String(LEFT_MIN),
    );

    await page.setViewportSize({ width: 1160, height: 800 });
    await expect
      .poll(async () =>
        canvas(page).evaluate(
          (element) => element.getBoundingClientRect().width,
        ),
      )
      .toBeGreaterThanOrEqual(CANVAS_MIN);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(left).toBeVisible();
    await expect(leftSeparator).toHaveAttribute(
      "aria-valuenow",
      String(LEFT_MIN),
    );
  });

  test("persists preferred widths and restores them after a temporary clamp", async ({
    page,
  }) => {
    await page.addInitScript(
      ({ key }) => {
        localStorage.setItem(key, JSON.stringify({ left: 900 }));
      },
      { key: PANEL_STORAGE_KEY },
    );
    await gotoSandbox(page);

    const left = structurePanel(page);
    await expect(left).toHaveCSS("width", "900px");
    await expect
      .poll(async () =>
        page.evaluate((key) => localStorage.getItem(key), PANEL_STORAGE_KEY),
      )
      .toBe(JSON.stringify({ left: 900 }));

    await page.setViewportSize({ width: 1160, height: 800 });
    await expect.poll(async () => panelWidth(left)).toBeLessThan(900);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(left).toBeVisible();
    await expect(left).toHaveCSS("width", "900px");
  });

  test("keeps the saved preference stable when the left panel is explicitly resized after clamping", async ({
    page,
  }) => {
    await page.addInitScript(
      ({ key }) => {
        localStorage.setItem(key, JSON.stringify({ left: 900 }));
      },
      { key: PANEL_STORAGE_KEY },
    );
    await gotoSandbox(page);
    await page.setViewportSize({ width: 1160, height: 800 });

    const left = structurePanel(page);
    await expect.poll(async () => panelWidth(left)).toBeLessThan(900);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(left).toHaveCSS("width", "900px");
    await expect(page.getByTestId("sandbox-resize-left")).toHaveAttribute(
      "aria-valuenow",
      "900",
    );
    const leftBefore = await panelWidth(left);
    await page.getByTestId("sandbox-resize-left").focus();
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(async () => panelWidth(left))
      .toBeCloseTo(leftBefore - 16, 0);
    await expect
      .poll(async () =>
        page.evaluate((key) => localStorage.getItem(key), PANEL_STORAGE_KEY),
      )
      .toBe(JSON.stringify({ left: 884 }));
  });

  test("keeps graph selection, zoom, position, work, and undo history through resizing", async ({
    page,
  }) => {
    await buildSingleModule(page);

    const moduleLabel = node(page, "Equipment");
    const before = await nodeBox(moduleLabel);
    if (before === null) throw new Error("Module has no bounds before moving");
    const moduleCell = moduleLabel.locator(
      "xpath=ancestor::*[@data-cell-id][1]",
    );
    const beforeTransform = await moduleCell.getAttribute("transform");
    await page.mouse.move(
      before.x + before.width / 2,
      before.y + before.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(before.x + 40, before.y + 24, { steps: 6 });
    await page.mouse.up();
    const moved = await nodeBox(moduleLabel);
    if (moved === null) throw new Error("Module has no bounds after moving");
    const movedTransform = await moduleCell.getAttribute("transform");
    await expect(page.getByTestId("toolbar-undo")).toBeEnabled();

    await page.getByTestId("toolbar-zoom-in").click();
    const scale = await page
      .getByTestId("sandbox-grid")
      .getAttribute("data-scale");
    await selectOutlineModule(page, "Equipment");
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select module Equipment",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "true");

    await page.setViewportSize({ width: 1200, height: 800 });
    await expect(structurePanel(page)).toBeVisible();
    await expect(page.getByTestId("sandbox-grid")).toHaveAttribute(
      "data-scale",
      scale!,
    );
    await expect(page.getByTestId("toolbar-undo")).toBeEnabled();
    await expect(
      node(page, "Equipment").locator("xpath=ancestor::*[@data-cell-id][1]"),
    ).toHaveAttribute("transform", movedTransform!);

    await page.getByTestId("toolbar-undo").click();
    await expect
      .poll(async () =>
        node(page, "Equipment")
          .locator("xpath=ancestor::*[@data-cell-id][1]")
          .getAttribute("transform"),
      )
      .toBe(beforeTransform);
    await page.getByTestId("toolbar-redo").click();
    await expect
      .poll(async () =>
        node(page, "Equipment")
          .locator("xpath=ancestor::*[@data-cell-id][1]")
          .getAttribute("transform"),
      )
      .toBe(movedTransform);
  });
});

test.describe("sandbox freeform creation and inspection", () => {
  test("renders every existing field type with required and optional markers", async ({
    page,
  }) => {
    await buildSingleModule(page);
    const types = Object.keys(FIELD_TYPE_META) as SandboxFieldType[];

    for (const [index, type] of types.entries()) {
      await addField(page, type, "Field " + type);
      if (index === 0) {
        const edit = page.getByTestId("dialog-edit-item");
        await openSelectedEdit(page, "inspector-field-required");
        await edit.getByTestId("inspector-field-required").check();
        await expect(
          edit.getByTestId("inspector-field-required"),
        ).toBeChecked();
        await edit.getByRole("button", { name: "Done", exact: true }).click();
      }
    }

    for (const type of types) {
      await expect(
        canvas(page).getByRole("button", {
          name:
            "Field " +
            type +
            ", " +
            FIELD_TYPE_META[type].label +
            ", " +
            (type === types[0] ? "required" : "optional"),
          exact: true,
        }),
      ).toBeVisible();
    }
  });

  test("keeps the hierarchy mounted while selecting, renaming, editing, and deleting items", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await addField(page, "text", "Name");
    await selectOutlineField(page, "Name");
    const edit = page.getByTestId("dialog-edit-item");
    await openSelectedEdit(page, "inspector-field-name");
    await expect(edit.getByTestId("inspector-field-name")).toHaveValue("Name");
    await edit.getByTestId("inspector-field-description").focus();
    await edit.getByRole("button", { name: "Equipment", exact: true }).click();
    await expect(edit.getByTestId("inspector-module-name")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Edit field Name",
        exact: true,
      }),
    ).toBeFocused();
    await selectOutlineField(page, "Name");
    await openSelectedEdit(page, "inspector-field-name");
    await edit
      .getByTestId("inspector-field-description")
      .fill("Primary display name");
    await edit.getByTestId("inspector-field-type").selectOption("int");
    await expect(edit.getByTestId("inspector-field-type")).toHaveValue("int");
    await edit.getByTestId("inspector-field-required").check();
    await edit.getByRole("button", { name: "Done", exact: true }).click();
    await selectOutlineModule(page, "Equipment");
    await expect(
      structurePanel(page).getByTestId("inspector-outline-field"),
    ).toHaveCount(1);
    await selectOutlineField(page, "Name");
    await openSelectedEdit(page, "inspector-field-description");
    await expect(edit.getByTestId("inspector-field-description")).toHaveValue(
      "Primary display name",
    );
    await edit.getByTestId("inspector-delete").click();
    await expect(page.getByTestId("dialog-delete-confirm")).toContainText(
      "Name",
    );
    await page.getByTestId("dialog-delete-confirm-button").click();
    await expect(
      structurePanel(page).getByTestId("inspector-outline-field"),
    ).toHaveCount(0);
    await expect(page.getByTestId("dialog-edit-item")).toHaveCount(0);
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select module Equipment",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      structurePanel(page).getByTestId("inspector-outline-add-field"),
    ).toBeVisible();
  });

  test("preserves inline graph editing with Enter, blur, and Escape", async ({
    page,
  }) => {
    await buildSingleModule(page);

    await node(page, "Inventory").dblclick();
    const departmentEditor = page.getByRole("textbox", {
      name: "Canvas name editor",
    });
    await expect(departmentEditor).toBeVisible();
    await departmentEditor.fill("Warehouse");
    await departmentEditor.press("Enter");
    await expect(node(page, "Warehouse")).toBeVisible();

    await node(page, "Equipment").dblclick();
    const moduleEditor = page.getByRole("textbox", {
      name: "Canvas name editor",
    });
    await moduleEditor.fill("Stock");
    await clickCanvasBlank(page);
    await expect(node(page, "Stock")).toBeVisible();

    await structurePanel(page)
      .getByRole("button", { name: "Select module Stock", exact: true })
      .click();
    await structurePanel(page)
      .getByTestId("inspector-outline-module")
      .filter({ has: page.locator('[aria-current="true"]') })
      .getByTestId("inspector-outline-add-field")
      .click();
    await expect(node(page, "Text 1")).toBeVisible();
    const row = canvas(page).getByRole("button", {
      name: "Text 1, Text, optional",
      exact: true,
    });
    const rowBox = await row.boundingBox();
    if (rowBox === null) throw new Error("Field row has no bounds");
    await page.mouse.dblclick(rowBox.x + 30, rowBox.y + rowBox.height / 2);
    const fieldEditor = page.getByRole("textbox", {
      name: "Canvas name editor",
    });
    await fieldEditor.fill("SKU");
    await fieldEditor.press("Enter");
    await expect(node(page, "SKU")).toBeVisible();

    const skuRow = canvas(page).getByRole("button", {
      name: "SKU, Text, optional",
      exact: true,
    });
    const skuBox = await skuRow.boundingBox();
    if (skuBox === null) throw new Error("Renamed field row has no bounds");
    await page.mouse.dblclick(
      skuBox.x + skuBox.width - 24,
      skuBox.y + skuBox.height / 2,
    );
    const typeEditor = page.getByRole("combobox", {
      name: "Canvas field type",
    });
    await expect(typeEditor).toBeVisible();
    await typeEditor.selectOption("int");
    await expect(
      canvas(page).getByRole("button", {
        name: "SKU, Integer, optional",
        exact: true,
      }),
    ).toBeVisible();

    await canvas(page)
      .getByRole("button", {
        name: "SKU, Integer, optional",
        exact: true,
      })
      .dblclick();
    await expect(
      page.getByRole("textbox", { name: "Canvas name editor" }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Canvas name editor" })
      .fill("Discarded");
    await page.keyboard.press("Escape");
    await expect(node(page, "SKU")).toBeVisible();
    await expect(node(page, "Discarded")).toHaveCount(0);
  });

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
  test("snaps/free-places zoomed drops and explains rejected containment", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await page.getByTestId("toolbar-zoom-in").click();
    const grid = page.getByTestId("sandbox-grid");
    const scale = Number(await grid.getAttribute("data-scale"));
    const [tx, ty] = (await grid.getAttribute("data-translate"))!
      .split(",")
      .map(Number);
    const bounds = (await canvas(page).boundingBox())!;

    async function drop(
      kind: string,
      x: number,
      y: number,
      altKey = false,
    ): Promise<void> {
      const dataTransfer = await page.evaluateHandle((value) => {
        const data = new DataTransfer();
        data.setData("application/x-sandbox-kind", value);
        return data;
      }, kind);
      await canvas(page).dispatchEvent("drop", {
        dataTransfer,
        clientX: bounds.x + x * scale + tx,
        clientY: bounds.y + y * scale + ty,
        altKey,
      });
      await dataTransfer.dispose();
    }

    await drop("department", 313, 317);
    await renameInspectorName(page, "inspector-dept-name", "Snapped");
    const snapped = node(page, "Snapped").locator(
      "xpath=ancestor::*[@data-cell-id][1]",
    );
    await expect(snapped).toHaveAttribute("transform", "translate(312,312)");

    await drop("department", 337, 343, true);
    await renameInspectorName(page, "inspector-dept-name", "Free");
    const free = node(page, "Free").locator(
      "xpath=ancestor::*[@data-cell-id][1]",
    );
    const freeTransform = await free.getAttribute("transform");
    const [freeX, freeY] = freeTransform!
      .match(/translate\(([^)]+)\)/)![1]
      .split(/[ ,]+/)
      .map(Number);
    expect(Math.abs(freeX - 337)).toBeLessThan(1);
    expect(Math.abs(freeY - 343)).toBeLessThan(1);

    await drop("field", 350, 355);
    await expect(
      canvas(page).getByText("Fields can only be added inside a module.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      canvas(page).getByText("No fields yet", { exact: true }),
    ).toBeVisible();
  });

  test("moves departments with child offsets and keeps the frame fitting operation undoable", async ({
    page,
  }) => {
    await buildSingleModule(page);
    const department = node(page, "Inventory");
    const moduleLabel = node(page, "Equipment");
    const beforeDepartment = await nodeBox(department);
    const beforeModule = await nodeBox(moduleLabel);
    if (beforeDepartment === null || beforeModule === null) {
      throw new Error("Graph nodes have no bounds");
    }
    const beforeOffset = {
      x: beforeModule.x - beforeDepartment.x,
      y: beforeModule.y - beforeDepartment.y,
    };

    const departmentHeading = node(page, "Inventory");
    const departmentHeadingBox = await departmentHeading.boundingBox();
    if (departmentHeadingBox === null) {
      throw new Error("Department heading has no bounds");
    }
    await page.mouse.move(
      departmentHeadingBox.x + departmentHeadingBox.width / 2,
      departmentHeadingBox.y + departmentHeadingBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      beforeDepartment.x + beforeDepartment.width / 2 + 53,
      beforeDepartment.y + beforeDepartment.height / 2 + 39,
      { steps: 10 },
    );
    await page.mouse.up();
    const afterDepartment = await nodeBox(department);
    const afterModule = await nodeBox(moduleLabel);
    if (afterDepartment === null || afterModule === null) {
      throw new Error("Graph nodes have no bounds after move");
    }
    expect(afterModule.x - afterDepartment.x).toBeCloseTo(beforeOffset.x, 0);
    expect(afterModule.y - afterDepartment.y).toBeCloseTo(beforeOffset.y, 0);
    await expect(page.getByTestId("toolbar-undo")).toBeEnabled();
    await page.getByTestId("toolbar-undo").click();
    await expect
      .poll(async () => (await nodeBox(department))?.x)
      .toBeCloseTo(beforeDepartment.x, 0);
    await page.getByTestId("toolbar-redo").click();
    await expect
      .poll(async () => (await nodeBox(department))?.x)
      .toBeCloseTo(afterDepartment.x, 0);
  });

  test("resizes a selected department with graph-space keyboard steps and child bounds", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await selectOutlineDepartment(page, "Inventory");

    const grip = departmentResizeGrip(page, "Inventory");
    await expect(grip).toBeVisible();
    const initial = await departmentSize(page, "Inventory");
    const beforeChild = await nodeBox(node(page, "Equipment"));
    if (beforeChild === null) throw new Error("Module has no bounds");

    await grip.focus();
    await page.keyboard.down("Alt");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Alt");
    const offGrid = await departmentSize(page, "Inventory");
    expect(offGrid.width).toBe(initial.width + 1);

    await page.keyboard.press("ArrowRight");
    const stepped = await departmentSize(page, "Inventory");
    expect(stepped.width).toBe(offGrid.width + 24);
    await page.keyboard.press("ArrowDown");
    const steppedHeight = await departmentSize(page, "Inventory");
    expect(steppedHeight.height).toBe(offGrid.height + 24);

    for (let index = 0; index < 128; index += 1) {
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowUp");
    }
    const minimum = await departmentSize(page, "Inventory");
    expect(minimum.width).toBeGreaterThanOrEqual(336);
    expect(minimum.height).toBeGreaterThanOrEqual(144);
    const frameBox = await departmentBody(page, "Inventory").boundingBox();
    const afterChild = await nodeBox(node(page, "Equipment"));
    if (frameBox === null || afterChild === null) {
      throw new Error("Resized department or child has no bounds");
    }
    expect(frameBox.x).toBeLessThanOrEqual(afterChild.x + 1);
    expect(frameBox.y).toBeLessThanOrEqual(afterChild.y + 1);
    expect(frameBox.x + frameBox.width).toBeGreaterThanOrEqual(
      afterChild.x + afterChild.width - 1,
    );
    expect(frameBox.y + frameBox.height).toBeGreaterThanOrEqual(
      afterChild.y + afterChild.height - 1,
    );
    expect(afterChild.x).toBeCloseTo(beforeChild.x, 0);
    expect(afterChild.y).toBeCloseTo(beforeChild.y, 0);
  });

  test("snaps pointer frame resizing to 24 units and groups one gesture in history", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await selectOutlineDepartment(page, "Inventory");
    const body = departmentBody(page, "Inventory");
    const grip = departmentResizeGrip(page, "Inventory");
    const initial = await departmentSize(page, "Inventory");
    const beforeChild = await nodeBox(node(page, "Equipment"));
    const gripBox = await grip.boundingBox();
    if (beforeChild === null || gripBox === null) {
      throw new Error("Department resize source or child has no bounds");
    }

    await page.mouse.move(gripBox.x + 12, gripBox.y + 12);
    await page.mouse.down();
    await page.mouse.move(gripBox.x + 49, gripBox.y + 41, { steps: 8 });
    await expect(body).toHaveAttribute("data-sandbox-body", "true");
    await page.mouse.up();

    const resized = await departmentSize(page, "Inventory");
    expect(resized.width % 24).toBe(0);
    expect(resized.height % 24).toBe(0);
    expect(resized.width).toBeGreaterThan(initial.width);
    expect(resized.height).toBeGreaterThan(initial.height);
    const afterChild = await nodeBox(node(page, "Equipment"));
    if (afterChild === null)
      throw new Error("Child has no bounds after resize");
    expect(afterChild.x).toBeCloseTo(beforeChild.x, 0);
    expect(afterChild.y).toBeCloseTo(beforeChild.y, 0);

    await expect(page.getByTestId("toolbar-undo")).toBeEnabled();
    await page.getByTestId("toolbar-undo").click();
    await expect.poll(() => departmentSize(page, "Inventory")).toEqual(initial);
    await page.getByTestId("toolbar-redo").click();
    await expect.poll(() => departmentSize(page, "Inventory")).toEqual(resized);
  });

  test("supports touch frame resizing and retains manual size across selection and theme changes", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await selectOutlineDepartment(page, "Inventory");
    const grip = departmentResizeGrip(page, "Inventory");
    await expect(grip).toBeVisible();
    await expect
      .poll(() =>
        grip.evaluate((element) => getComputedStyle(element).touchAction),
      )
      .toBe("none");

    const initial = await departmentSize(page, "Inventory");
    const gripBox = await grip.boundingBox();
    if (gripBox === null) throw new Error("Resize grip has no bounds");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    const start = { x: gripBox.x + 12, y: gripBox.y + 12 };
    await cdp.send("Input.emulateTouchFromMouseEvent", {
      type: "mousePressed",
      x: start.x,
      y: start.y,
      button: "left",
    });
    await cdp.send("Input.emulateTouchFromMouseEvent", {
      type: "mouseMoved",
      x: start.x + 31,
      y: start.y + 29,
      button: "none",
    });
    await cdp.send("Input.emulateTouchFromMouseEvent", {
      type: "mouseReleased",
      x: start.x + 31,
      y: start.y + 29,
      button: "left",
    });

    await expect
      .poll(() => departmentSize(page, "Inventory"))
      .not.toEqual(initial);
    const manualSize = await departmentSize(page, "Inventory");
    expect(manualSize.width % 24).toBe(0);
    expect(manualSize.height % 24).toBe(0);

    await selectOutlineModule(page, "Equipment");
    await setSessionTheme(page, "dark");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await setSessionTheme(page, "light");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await selectOutlineDepartment(page, "Inventory");
    await expect
      .poll(() => departmentSize(page, "Inventory"))
      .toEqual(manualSize);
  });

  test("provides hierarchy spacing, striped fields, and pressed feedback for active controls", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await addField(page, "text", "Name");
    await addField(page, "int", "Quantity");
    await selectOutlineModule(page, "Equipment");

    const outline = structurePanel(page).getByTestId("inspector-outline");
    const departmentItem = outline.getByTestId("inspector-outline-department");
    const moduleItem = outline.getByTestId("inspector-outline-module");
    const departmentList = outline.locator("ul").first();
    const moduleList = departmentItem.locator("ul").first();
    const fieldList = moduleItem.locator("ul.sandbox-field-list");
    await expect(departmentList).toHaveCSS("row-gap", "12px");
    await expect(moduleList).toHaveCSS("row-gap", "8px");
    await expect(fieldList).toHaveCSS("row-gap", "4px");
    await expect(fieldList.locator("li").nth(1)).toHaveCSS(
      "background-color",
      "rgb(213, 221, 230)",
    );

    const departmentButton = departmentItem.getByRole("button", {
      name: "Select department Inventory",
      exact: true,
    });
    const departmentButtonBox = await departmentButton.boundingBox();
    if (departmentButtonBox === null) {
      throw new Error("Department outline button has no bounds");
    }
    await page.mouse.move(
      departmentButtonBox.x + departmentButtonBox.width / 2,
      departmentButtonBox.y + departmentButtonBox.height / 2,
    );
    await page.mouse.down();
    const activeStyles = await departmentButton.evaluate((element) => {
      const styles = getComputedStyle(element);
      return { boxShadow: styles.boxShadow, outlineStyle: styles.outlineStyle };
    });
    expect(activeStyles.boxShadow).not.toBe("none");
    expect(activeStyles.outlineStyle).toBe("solid");
    await page.mouse.up();

    await expect(
      page.locator("main#main-content").getByText("Automation", {
        exact: true,
      }),
    ).toHaveCount(0);

    const moduleCell = departmentNode(page, "Equipment");
    await moduleCell.evaluate((element) => {
      const target = element as Element & {
        __openslatePressedObservation?: {
          observed: boolean;
          observer: MutationObserver;
        };
      };
      const observation = {
        observed: false,
        observer: undefined as unknown as MutationObserver,
      };
      observation.observer = new MutationObserver((records) => {
        if (
          records.some(
            (record) =>
              record.attributeName === "data-sandbox-pressed" &&
              (element.getAttribute("data-sandbox-pressed") === "true" ||
                record.oldValue === "true"),
          )
        ) {
          observation.observed = true;
        }
      });
      target.__openslatePressedObservation = observation;
      observation.observer.observe(element, {
        attributes: true,
        attributeFilter: ["data-sandbox-pressed"],
        attributeOldValue: true,
      });
    });
    await node(page, "Equipment").click();
    await expect
      .poll(() =>
        moduleCell.evaluate((element) => {
          const target = element as Element & {
            __openslatePressedObservation?: { observed: boolean };
          };
          return target.__openslatePressedObservation?.observed ?? false;
        }),
      )
      .toBe(true);
    await moduleCell.evaluate((element) => {
      const target = element as Element & {
        __openslatePressedObservation?: {
          observer: MutationObserver;
        };
      };
      target.__openslatePressedObservation?.observer.disconnect();
      delete target.__openslatePressedObservation;
    });
    await expect(page.getByTestId("sandbox-grid")).toHaveAttribute(
      "data-grid-size",
      "24",
    );
    await expect(page.getByTestId("sandbox-grid")).toHaveAttribute(
      "data-grid-major-size",
      "120",
    );
  });

  test("reveals connection handles on hover/selection while retaining keyboard dialog creation", async ({
    page,
  }) => {
    await buildTwoModules(page);
    const moduleNode = node(page, "Equipment").locator(
      "xpath=ancestor::*[@data-cell-id][1]",
    );
    const ports = moduleNode.locator("circle");
    await expect(ports).toHaveCount(2);
    await expect(ports.first()).toHaveAttribute("opacity", "0");
    await moduleNode.hover();
    await expect(ports.first()).toHaveAttribute("opacity", "1");
    await selectOutlineModule(page, "Equipment");
    await expect(ports.first()).toHaveAttribute("opacity", "1");
    await structurePanel(page)
      .getByTestId("inspector-add-relationship")
      .click();
    await expect(page.getByTestId("dialog-link")).toBeVisible();
    await page.keyboard.press("Escape");
  });

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

  test("keeps mobile navigation and Structure sheets exclusive while preserving the graph", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await expect(node(page, "Equipment")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    const structureTrigger = page.getByRole("button", {
      name: "Toggle structure",
      exact: true,
    });
    const navigationTrigger = page.getByRole("button", {
      name: "Open navigation",
      exact: true,
    });
    await expect(structureTrigger).toBeVisible();
    await expect(navigationTrigger).toBeVisible();

    await structureTrigger.click();
    const structureSheet = page.getByRole("dialog", {
      name: "Structure",
      exact: true,
    });
    await expect(structureSheet).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(structureSheet).toContainText("Equipment");
    await page.keyboard.press("Escape");
    await expect(structureSheet).toHaveCount(0);

    await navigationTrigger.click();
    const navigationSheet = page.getByRole("dialog", {
      name: "OpenSlate navigation",
      exact: true,
    });
    await expect(navigationSheet).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(node(page, "Equipment")).toBeVisible();
    await page.getByRole("button", { name: "Close navigation" }).click();
    await expect(navigationSheet).toHaveCount(0);

    await structureTrigger.click();
    await expect(structureSheet).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(structureSheet).toContainText("Equipment");
    await page.keyboard.press("Escape");
    await expect(structureTrigger).toBeFocused();
    await expect(node(page, "Equipment")).toBeVisible();
  });

  test("contains sandbox dialogs, restores their launchers, and unwinds nested confirmation", async ({
    page,
  }) => {
    await buildSingleModule(page);
    await selectOutlineModule(page, "Equipment");

    const editAction = structurePanel(page).getByRole("button", {
      name: "Edit module Equipment",
      exact: true,
    });
    await editAction.click();
    const editDialog = page.getByTestId("dialog-edit-item");
    await expect(editDialog).toBeVisible();
    await expectDialogFocusContainment(page, editDialog);
    await page.keyboard.press("Escape");
    await expect(editDialog).toHaveCount(0);
    await expect(editAction).toBeFocused();

    await editAction.click();
    await expect(editDialog).toBeVisible();
    await editDialog.getByTestId("inspector-delete").click();
    const deleteDialog = page.getByTestId("dialog-delete-confirm");
    await expect(deleteDialog).toBeVisible();
    await expectDialogFocusContainment(page, deleteDialog);
    await page.keyboard.press("Escape");
    await expect(deleteDialog).toHaveCount(0);
    await expect(editDialog).toHaveCount(0);
    await expect(editAction).toBeFocused();

    await buildTwoModules(page);
    const relationshipAction = structurePanel(page).getByTestId(
      "inspector-add-relationship",
    );
    await relationshipAction.click();
    const relationshipDialog = page.getByTestId("dialog-link");
    await expect(relationshipDialog).toBeVisible();
    await expectDialogFocusContainment(page, relationshipDialog);
    await relationshipDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(relationshipDialog).toHaveCount(0);
    await expect(relationshipAction).toBeFocused();
  });
});

test.describe("sandbox regression coverage", () => {
  test("renders a dense nine-field module without losing the last row", async ({
    page,
  }) => {
    await buildSingleModule(page);
    const types = Object.keys(FIELD_TYPE_META) as SandboxFieldType[];
    for (let index = 1; index <= 9; index += 1) {
      await addField(
        page,
        types[(index - 1) % types.length]!,
        "Field " + index,
      );
    }
    await expect(
      canvas(page).getByRole("button", {
        name: "Field 9, " + FIELD_TYPE_META[types[1]!].label + ", optional",
        exact: true,
      }),
    ).toBeVisible();
  });

  test("keeps a module in its department after a blank canvas drop and supports reparenting", async ({
    page,
  }) => {
    await buildSingleModule(page);
    const moduleLabel = node(page, "Equipment");
    const canvasBounds = await canvas(page).boundingBox();
    if (canvasBounds === null) throw new Error("Canvas has no bounds");

    await dragNodeToPoint(page, moduleLabel, {
      x: canvasBounds.x + canvasBounds.width - 120,
      y: canvasBounds.y + canvasBounds.height - 120,
    });
    await selectOutlineModule(page, "Equipment");
    const firstEdit = page.getByTestId("dialog-edit-item");
    await openSelectedEdit(page, "inspector-module-dept");
    await expect(
      firstEdit.getByTestId("inspector-module-dept").locator("option:checked"),
    ).toHaveText("Inventory");
    await firstEdit.getByRole("button", { name: "Done", exact: true }).click();

    await structurePanel(page).getByTestId("inspector-add-department").click();
    await renameInspectorName(page, "inspector-dept-name", "Sales");
    await selectOutlineModule(page, "Equipment");
    const secondEdit = page.getByTestId("dialog-edit-item");
    await openSelectedEdit(page, "inspector-module-dept");
    await page
      .getByTestId("dialog-edit-item")
      .getByTestId("inspector-module-dept")
      .selectOption({ label: "Sales" });
    await expect(
      secondEdit.getByTestId("inspector-module-dept").locator("option:checked"),
    ).toHaveText("Sales");
    await secondEdit.getByRole("button", { name: "Done", exact: true }).click();
    await selectOutlineDepartment(page, "Inventory");
    await expect(
      structurePanel(page)
        .getByTestId("inspector-outline-department")
        .filter({ hasText: "Inventory" })
        .getByRole("button", { name: "Select module Equipment", exact: true }),
    ).toHaveCount(0);
    await expect(
      structurePanel(page)
        .getByTestId("inspector-outline-department")
        .filter({ hasText: "Sales" })
        .getByRole("button", { name: "Select module Equipment", exact: true }),
    ).toBeVisible();
  });

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

  test("shows valid palette drop feedback for native drag data before adding a field", async ({
    page,
  }) => {
    await buildSingleModule(page);
    const source = await paletteItem(page, "palette-add-field-text");
    const sourceBounds = await source.boundingBox();
    const target = node(page, "Equipment");
    const targetBounds = await target.boundingBox();
    if (sourceBounds === null || targetBounds === null) {
      throw new Error("Native field drag source or target has no bounds");
    }
    await page.mouse.move(sourceBounds.x + 40, sourceBounds.y + 20);
    await page.mouse.down();
    await page.mouse.move(sourceBounds.x + 25, sourceBounds.y + 20, {
      steps: 3,
    });
    await page.mouse.move(targetBounds.x + 60, targetBounds.y + 30, {
      steps: 15,
    });
    await expect(canvas(page).locator('[data-feedback="drop"]')).toHaveCount(1);
    await page.mouse.up();
    await expect(node(page, "Text 1")).toBeVisible();
  });

  test("shows native movement feedback while dragging and retains zoom/theme state", async ({
    page,
  }) => {
    await buildSingleModule(page);
    const moduleLabel = node(page, "Equipment");
    const before = await nodeBox(moduleLabel);
    if (before === null) throw new Error("Module has no bounds");
    await page.mouse.move(
      before.x + before.width / 2,
      before.y + before.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(before.x + 10, before.y + 8, { steps: 2 });
    await expect(canvas(page).locator('[data-feedback="moving"]')).toHaveCount(
      1,
    );
    await page.mouse.move(before.x + 32, before.y + 20, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId("toolbar-undo")).toBeEnabled();

    await page.getByTestId("toolbar-zoom-in").click();
    const zoomedTransform = await moduleLabel
      .locator("xpath=ancestor::*[@data-cell-id][1]")
      .getAttribute("transform");
    const zoomedScale = await page
      .getByTestId("sandbox-grid")
      .getAttribute("data-scale");
    await selectOutlineModule(page, "Equipment");
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select module Equipment",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "true");

    const sidebar = page.getByRole("complementary", {
      name: "Primary sidebar",
    });
    const sidebarWidth = async () => (await sidebar.boundingBox())?.width;
    await expect.poll(sidebarWidth).toBe(64);
    await sidebar.getByRole("button", { name: "Expand sidebar" }).click();
    await expect.poll(sidebarWidth).toBe(256);
    const separator = sidebar.getByRole("separator", {
      name: "Resize sidebar",
      exact: true,
    });
    await separator.focus();
    await page.keyboard.press("End");
    await expect.poll(sidebarWidth).toBe(400);
    await expect(
      node(page, "Equipment").locator("xpath=ancestor::*[@data-cell-id][1]"),
    ).toHaveAttribute("transform", zoomedTransform!);
    await expect(page.getByTestId("sandbox-grid")).toHaveAttribute(
      "data-scale",
      zoomedScale!,
    );
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select module Equipment",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "true");
    await page.getByTestId("toolbar-undo").click();
    await expect(page.getByTestId("toolbar-redo")).toBeEnabled();
    await page.getByTestId("toolbar-redo").click();
    await expect(
      node(page, "Equipment").locator("xpath=ancestor::*[@data-cell-id][1]"),
    ).toHaveAttribute("transform", zoomedTransform!);
    await separator.focus();
    await page.keyboard.press("Home");
    await expect.poll(sidebarWidth).toBe(256);
    await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect.poll(sidebarWidth).toBe(64);
    await expect(
      node(page, "Equipment").locator("xpath=ancestor::*[@data-cell-id][1]"),
    ).toHaveAttribute("transform", zoomedTransform!);
    await expect(page.getByTestId("sandbox-grid")).toHaveAttribute(
      "data-scale",
      zoomedScale!,
    );
    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select module Equipment",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "true");

    await setSessionTheme(page, "dark");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(
      node(page, "Equipment").locator("xpath=ancestor::*[@data-cell-id][1]"),
    ).toHaveAttribute("transform", zoomedTransform!);
    const edit = page.getByTestId("dialog-edit-item");
    await openSelectedEdit(page, "inspector-module-name");
    await expect(edit.getByTestId("inspector-module-name")).toHaveValue(
      "Equipment",
    );
    await edit.getByRole("button", { name: "Done", exact: true }).click();
    await setSessionTheme(page, "light");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(page.getByTestId("toolbar-undo")).toBeEnabled();
  });

  test("keeps long names accessible in the hierarchy and edit dialog", async ({
    page,
  }) => {
    const departmentName = "Operations and inventory coordination";
    const moduleName = "Equipment maintenance and replenishment";
    await gotoSandbox(page);
    await addDepartmentFromEmpty(page, departmentName);
    await addModuleFromPalette(page, moduleName);
    await selectOutlineModule(page, moduleName);

    await expect(
      structurePanel(page).getByRole("button", {
        name: "Select module " + moduleName,
        exact: true,
      }),
    ).toBeVisible();
    await openSelectedEdit(page, "inspector-module-name");
    await expect(
      page.getByTestId("dialog-edit-item").getByTestId("inspector-module-name"),
    ).toHaveValue(moduleName);
  });
});
