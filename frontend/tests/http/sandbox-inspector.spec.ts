import { expect, expectNoPageScroll, test, type Page } from "./helpers/test";
import {
  fieldRowTrigger,
  openAuthenticatedSandbox,
} from "./helpers/sandbox-api";
import {
  configuredSandboxDesign,
  overlappingSandboxDesign,
} from "../helpers/sandbox-fixtures";

// The Advanced Last Rule (DESIGN.md): Properties shows the essentials, keeps
// rare and lifecycle controls in one closed Advanced block that names what it
// holds, and remembers the viewer's choice.
test("a module panel shows its essentials first and remembers Advanced", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  design.modules[0]!.titleFieldId = "sample-field-Title";
  await openAuthenticatedSandbox(page, design);
  await page.goto("/sandbox?module=sample-requests");
  const inspector = page.getByRole("complementary", {
    name: "Design inspector",
  });
  await expect(
    inspector.getByRole("heading", { name: "Service requests", level: 2 }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("heading", { name: "Fields 4", exact: true }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("heading", { name: "Relationships 1", exact: true }),
  ).toBeVisible();
  const advanced = inspector.getByRole("button", { name: /^Advanced/ });
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await expect(advanced).toHaveText(
    "Advanced · Department, Title field (set), Close, Delete",
  );
  await expect(
    inspector.getByRole("button", { name: "Close module", exact: true }),
  ).toBeHidden();

  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(advanced).toHaveText("Advanced");
  await expect(
    inspector.getByLabel("Title field", { exact: true }),
  ).toHaveValue("sample-field-Title");
  await page.reload();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(
    inspector.getByRole("button", { name: "Close module", exact: true }),
  ).toBeVisible();

  await advanced.click();
  await page.reload();
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
});

test("Delete is reachable from Properties for a module and a field", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page);
  await page.goto("/sandbox?module=sample-requests");
  const inspector = page.getByRole("complementary", {
    name: "Design inspector",
  });
  await inspector.getByRole("button", { name: /^Advanced/ }).click();
  await inspector
    .getByRole("button", { name: "Delete module", exact: true })
    .click();
  const deletion = page.getByRole("alertdialog");
  await expect(deletion).toContainText("Service requests");
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deletion).toBeHidden();

  const field = inspector.getByRole("group", {
    name: "Priority field settings",
    exact: true,
  });
  await fieldRowTrigger(field, "Priority").click();
  await field.getByRole("button", { name: /^Advanced/ }).click();
  await field
    .getByRole("button", { name: "Delete field", exact: true })
    .click();
  await expect(deletion).toContainText("Priority");
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deletion).toBeHidden();
});

test("collapsing a field row keeps its unsaved edit and says so", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page);
  await page.goto("/sandbox?module=sample-requests");
  const field = page.getByRole("group", {
    name: "Priority field settings",
    exact: true,
  });
  await fieldRowTrigger(field, "Priority").click();
  await field
    .getByLabel("Priority field type", { exact: true })
    .selectOption("Long text");
  const header = field.getByRole("button", { name: /^Priority\b/ });
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(field.getByText("Unsaved", { exact: true })).toBeVisible();

  await header.click();
  await expect(
    field.getByLabel("Priority field type", { exact: true }),
  ).toHaveValue("Long text");
  await field.getByRole("button", { name: "Save field changes" }).click();
  await expect.poll(sandbox.documentWrites).toBe(1);
  await expect(header).toHaveAccessibleName("Priority Long text");
  await expect(field.getByText("Unsaved", { exact: true })).toBeHidden();
});

// On desktop, pages fill the viewport and never scroll; their panels do
// (DESIGN.md). Screen-reader text inside a panel once stretched the page past
// it. Phones and tablets scroll the page, so they are not checked here.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`the Build page does not scroll at ${viewport.width}px with everything open`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      for (const panel of ["module", "field"])
        window.localStorage.setItem(
          `openslate:advanced:sandbox.${panel}`,
          "open",
        );
    });
    await openAuthenticatedSandbox(page);
    await page.goto("/sandbox?module=sample-requests");
    const field = page.getByRole("group", {
      name: "Status field settings",
      exact: true,
    });
    await fieldRowTrigger(field, "Status").click();
    await expect(
      field.getByLabel("Status description", { exact: true }),
    ).toBeVisible();
    await expectNoPageScroll(page);

    for (const section of ["Triggers", "Test", "History"]) {
      await page.goto(`/sandbox?section=${section.toLowerCase()}`);
      await expect(
        page.getByRole("heading", { name: section, level: 1, exact: true }),
      ).toBeVisible();
      await expectNoPageScroll(page);
    }
  });
}

// Phase 3 of the Sandbox follow-up pass: overlap notice (F2, O2).
test("overlapping frames show a notice that Auto-arrange clears and Undo brings back", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(
    page,
    overlappingSandboxDesign,
  );
  const notice = page
    .getByRole("status")
    .filter({ hasText: "Some departments or modules overlap." });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Auto-arrange" }).click();
  await expect(notice).toHaveCount(0);
  await expect.poll(sandbox.documentWrites).toBe(1);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
});

// Phase 4 of the Sandbox follow-up pass: Structure is a tree (T1, T2).
test("Structure is one Tab stop and works from the keyboard", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page);
  await page.goto("/sandbox?module=sample-requests");
  await page
    .getByRole("tablist", { name: "Workbench view" })
    .getByRole("tab", { name: "Structure" })
    .click();
  const tree = page.getByRole("tree", { name: "Structure" });
  const item = (name: string) =>
    tree.getByRole("treeitem", { name, exact: true });

  // One Tab stop, on the selected module.
  await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
  await expect(item("Service requests")).toHaveAttribute("tabindex", "0");
  await expect(item("Service requests")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await item("Service requests").focus();
  await page.keyboard.press("ArrowDown");
  await expect(item("Request number")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(item("Service requests")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(item("Service requests")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.keyboard.press("ArrowRight");
  await expect(item("Service requests")).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  // A letter jumps to the next name that starts with it; Enter selects.
  await page.keyboard.press("e");
  await expect(item("Equipment")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(item("Equipment")).toHaveAttribute("aria-selected", "true");
  await expect(item("Service requests")).toHaveAttribute(
    "aria-selected",
    "false",
  );

  await page.keyboard.press("End");
  await expect(item("Add module to Commercial")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(item("Operations")).toBeFocused();

  // F2 renames the focused item.
  await page.keyboard.press("F2");
  await expect(page.getByLabel("Edit department name")).toBeFocused();
  await page.keyboard.press("Escape");
});

// Build with nothing selected is a summary of the whole design: a fact line of
// counts, then what needs attention, each row with one action that opens the
// right place (docs/specs/sandbox-relayout.md S12).
test("with nothing selected, Properties summarizes the design and opens what needs attention", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const design = structuredClone(overlappingSandboxDesign);
  design.modules.push({
    id: "sample-empty",
    department: "sample-commercial",
    name: "Invoices",
    closed: false,
    fields: [],
    x: 384,
    y: 240,
  });
  design.rules.push({
    ...design.rules[0]!,
    id: "sample-quiet",
    name: "Quiet alert",
    enabled: false,
  });
  const sandbox = await openAuthenticatedSandbox(page, design, {
    hasUnpublishedChanges: true,
  });
  const inspector = page.getByRole("complementary", {
    name: "Design inspector",
  });
  await expect(
    inspector.getByRole("heading", { name: "Summary", level: 2 }),
  ).toBeVisible();
  await expect(
    inspector.getByText(
      "2 departments · 4 modules · 12 fields · 1 relationship · 2 triggers",
      { exact: true },
    ),
  ).toBeVisible();
  const attention = inspector.getByRole("region", { name: "Needs attention" });
  await expect(attention.getByRole("listitem")).toHaveText([
    /^Unpublished changes\s*Review$/,
    /^1 trigger is off\s*Show$/,
    /^1 module has no fields\s*Show$/,
    /^Departments or modules overlap\s*Auto-arrange$/,
    /^Urgent request alert: .+\s*Open trigger$/,
    /^Quiet alert: .+\s*Open trigger$/,
  ]);

  await attention
    .getByRole("button", { name: "Review: Unpublished changes" })
    .click();
  const review = page.getByRole("dialog", { name: "Review and publish" });
  await expect(review).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(review).toBeHidden();

  await attention
    .getByRole("button", {
      name: "Auto-arrange: Departments or modules overlap",
    })
    .click();
  await expect.poll(sandbox.documentWrites).toBe(1);
  await expect(attention.getByRole("listitem")).toHaveCount(5);

  await attention
    .getByRole("button", { name: "Show: 1 module has no fields" })
    .click();
  await expect(
    inspector.getByRole("heading", { name: "Invoices", level: 2 }),
  ).toBeVisible();

  await page.goto("/sandbox");
  await inspector
    .getByRole("region", { name: "Needs attention" })
    .getByRole("button", { name: "Show: 1 trigger is off" })
    .click();
  await expect(page).toHaveURL(/section=triggers/);
  const list = page.getByRole("navigation", { name: "Trigger list" });
  await expect(list.getByRole("button")).toHaveCount(1);
  await expect(list.getByRole("button")).toContainText("Off");
  await expect(
    page
      .getByRole("group", { name: "Status", exact: true })
      .getByRole("button", { pressed: true }),
  ).toHaveText("Off 1");

  await page.goto("/sandbox");
  await inspector
    .getByRole("region", { name: "Needs attention" })
    .getByRole("button", { name: /^Open trigger: Quiet alert/ })
    .click();
  await expect(page).toHaveURL(/rule=sample-quiet/);
  await expect(page.getByLabel("Trigger name")).toHaveValue("Quiet alert");
});

test("a design with nothing to attend to says All clear", async ({ page }) => {
  await openAuthenticatedSandbox(
    page,
    { ...configuredSandboxDesign, rules: [] },
    {
      hasUnpublishedChanges: false,
      publishedHash: "a".repeat(64),
    },
  );
  const attention = page
    .getByRole("complementary", { name: "Design inspector" })
    .getByRole("region", { name: "Needs attention" });
  await expect(attention.getByRole("listitem")).toHaveCount(0);
  await expect(attention).toContainText("All clear");
});

/** The design's frames, as screen boxes, and the canvas frame around them. */
async function canvasFrames(page: Page) {
  return page.evaluate(() => {
    const frame = document
      .querySelector('[data-skin="canvas-frame"]')!
      .getBoundingClientRect();
    const nodes = [
      ...document.querySelectorAll('[data-sandbox-node^="sample-"]'),
    ].map((node) => node.getBoundingClientRect());
    return nodes.every(
      (node) =>
        node.left >= frame.left - 1 &&
        node.right <= frame.right + 1 &&
        node.top >= frame.top - 1 &&
        node.bottom <= frame.bottom + 1,
    );
  });
}

// Build opens on the whole design, fitted, with nothing selected; a link that
// names an item keeps it, at 100% on its department (F8). The minimap shows
// only while part of the design is out of view (F14).
test("Build opens fitted with nothing selected, and a link keeps its selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = structuredClone(configuredSandboxDesign);
  wide.modules = wide.modules.map((item) =>
    item.id === "sample-customers" ? { ...item, x: 1000 } : item,
  );
  await openAuthenticatedSandbox(page, wide);
  const zoom = page.getByRole("status", { name: "Canvas zoom" });
  const minimap = page.locator(".sandbox-minimap");
  await expect(
    page
      .getByRole("tablist", { name: "Workbench view" })
      .getByRole("tab", { name: "Properties" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page
      .getByRole("complementary", { name: "Design inspector" })
      .getByRole("heading", { name: "Summary", level: 2 }),
  ).toBeVisible();
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
  await expect.poll(() => canvasFrames(page)).toBe(true);
  await expect(zoom).not.toHaveText("100%");
  await expect(minimap).toBeHidden();

  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(minimap).toBeVisible();
  await page.getByRole("button", { name: "Fit canvas", exact: true }).click();
  await expect(minimap).toBeHidden();

  await page.goto("/sandbox?module=sample-customers");
  await expect(
    page
      .getByRole("complementary", { name: "Design inspector" })
      .getByRole("heading", { name: "Customers", level: 2 }),
  ).toBeVisible();
  await expect(zoom).toHaveText("100%");
});

// Structure follows the canvas: a selection there expands and scrolls the
// tree to the item, and a selection in the tree selects on the canvas (F8).
test("Structure follows a selection on the canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuthenticatedSandbox(page);
  const tabs = page.getByRole("tablist", { name: "Workbench view" });
  await tabs.getByRole("tab", { name: "Structure" }).click();
  await page.getByRole("button", { name: "Collapse all" }).click();
  const tree = page.getByRole("tree", { name: "Structure" });
  await expect(
    tree.getByRole("treeitem", { name: "Customers", exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("region", { name: "Organization canvas" })
    .locator(
      '[data-sandbox-node="sample-customers"] [data-sandbox-part="header"]',
    )
    .first()
    .click();
  await tabs.getByRole("tab", { name: "Structure" }).click();
  const customers = tree.getByRole("treeitem", {
    name: "Customers",
    exact: true,
  });
  await expect(customers).toHaveAttribute("aria-selected", "true");
  await expect(customers).toBeInViewport();
  await expect(
    tree.getByRole("treeitem", { name: "Commercial", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");

  await tree.getByRole("treeitem", { name: "Operations", exact: true }).click();
  await expect(
    page
      .locator('[data-sandbox-node="sample-operations"] [data-selected="true"]')
      .first(),
  ).toBeVisible();
});

// One relationships list: each row carries its actions in a quiet menu, and
// Advanced no longer repeats the list (F7).
test("relationship rows carry their actions and the list shows once", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page);
  await page.goto("/sandbox?module=sample-requests");
  const inspector = page.getByRole("complementary", {
    name: "Design inspector",
  });
  await inspector.getByRole("button", { name: /^Advanced/ }).click();
  await expect(
    inspector.getByRole("group", { name: "Relationships" }),
  ).toHaveCount(0);
  await expect(
    inspector.getByText("Uses equipment", { exact: true }),
  ).toHaveCount(1);

  await inspector
    .getByRole("button", {
      name: "Actions for relationship Uses equipment, outgoing",
    })
    .click();
  await expect(
    page.getByRole("menuitem", {
      name: "Edit outgoing relationship Uses equipment",
    }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", {
      name: "Delete relationship Uses equipment, outgoing",
    })
    .click();
  const deletion = page.getByRole("alertdialog");
  await expect(deletion).toContainText("Uses equipment");
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deletion).toBeHidden();
});

// Icon buttons in the Structure search row name what they do on hover and
// focus, and the canvas commands people use often sit on the toolbar (F13).
test("Structure buttons are named and Fit and Auto-arrange are on the toolbar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuthenticatedSandbox(page);
  await page
    .getByRole("tablist", { name: "Workbench view" })
    .getByRole("tab", { name: "Structure" })
    .click();
  for (const name of ["Collapse all", "Jump to selection"]) {
    await page.getByRole("button", { name, exact: true }).hover();
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
      name === "Jump to selection" ? "Select an item first." : name,
    );
    await page.mouse.move(0, 0);
  }
  const toolbar = page.getByRole("toolbar", { name: "Canvas view controls" });
  await expect(
    toolbar.getByRole("button", { name: "Fit canvas", exact: true }),
  ).toBeVisible();
  await expect(
    toolbar.getByRole("button", { name: "Auto-arrange", exact: true }),
  ).toBeVisible();
});

// The canvas toolbar joins the slim controls from 1280 px; below, the 44 px
// floor stays (S16). The canvas itself keeps its look.
for (const [width, height] of [
  [1440, 32],
  [1024, 44],
] as const) {
  test(`canvas toolbar buttons are ${height} px at ${width} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openAuthenticatedSandbox(page);
    if (width < 1280) await page.getByRole("tab", { name: "Canvas" }).click();
    const toolbar = page.getByRole("toolbar", {
      name: "Canvas view controls",
    });
    for (const name of [
      "Zoom out",
      "Zoom in",
      "Fit canvas",
      "Auto-arrange",
      "View canvas",
    ])
      await expect(
        toolbar.getByRole("button", { name, exact: true }),
        name,
      ).toHaveCSS("height", `${height}px`);
    await expect(page.getByText("Key", { exact: true })).toHaveCSS(
      "height",
      `${height}px`,
    );
    // Every slim rule needs a slim-ui ancestor; the canvas has none.
    await expect(
      page.locator('.slim-ui [data-skin="canvas-frame"]'),
    ).toHaveCount(0);
  });
}

/** Configured design with a second trigger that is off. */
function designWithOffTrigger() {
  const design = structuredClone(configuredSandboxDesign);
  design.rules.push({
    ...design.rules[0]!,
    id: "sample-quiet",
    name: "Quiet alert",
    enabled: false,
  });
  return design;
}

// "Show" on the triggers that are off opens Triggers filtered Off once; the
// filter is not part of the page address, so it never sticks.
test("the Off filter from Build does not stick to later visits", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, designWithOffTrigger());
  await page
    .getByRole("region", { name: "Needs attention" })
    .getByRole("button", { name: "Show: 1 trigger is off" })
    .click();
  const status = page.getByRole("group", { name: "Status", exact: true });
  await expect(status.getByRole("button", { pressed: true })).toHaveText(
    "Off 1",
  );
  await status.getByRole("button", { name: /^All/ }).click();
  await page.getByRole("link", { name: "Build", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Build", level: 1, exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await expect(status.getByRole("button", { pressed: true })).toHaveText(
    "All 2",
  );
});

// An issue link opens its trigger even when the list is filtered to Off and
// that trigger is On.
test("opening a blocker for a trigger that is on shows its row under the Off filter", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, designWithOffTrigger());
  await page.goto("/sandbox?section=triggers&status=off");
  const list = page.getByRole("navigation", { name: "Trigger list" });
  await expect(list.getByRole("button")).toHaveCount(1);
  await page
    .getByRole("listitem")
    .filter({ hasText: "Urgent request alert:" })
    .getByRole("button", { name: "Open trigger", exact: true })
    .click();
  await expect(page.getByLabel("Trigger name")).toHaveValue(
    "Urgent request alert",
  );
  await expect(
    list.getByRole("button", { name: /Urgent request alert/ }),
  ).toHaveAttribute("aria-current", "true");
});

/** A design whose Customers table sits far to the right of Operations. */
function wideDesign() {
  const design = structuredClone(configuredSandboxDesign);
  design.modules = design.modules.map((item) =>
    item.id === "sample-customers" ? { ...item, x: 1000 } : item,
  );
  return design;
}

/** Whether a canvas node lies inside the canvas frame. */
function nodeInView(page: Page, id: string) {
  return page.evaluate((nodeId) => {
    const frame = document
      .querySelector('[data-skin="canvas-frame"]')!
      .getBoundingClientRect();
    const node = document
      .querySelector(`[data-sandbox-node="${nodeId}"]`)
      ?.getBoundingClientRect();
    return (
      node !== undefined &&
      node.left >= frame.left - 1 &&
      node.right <= frame.right + 1 &&
      node.top >= frame.top - 1 &&
      node.bottom <= frame.bottom + 1
    );
  }, id);
}

// A link to a field opens on its module, as a link to the module does.
test("a link to a field opens the canvas on its module", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuthenticatedSandbox(page, wideDesign(), {
    path: "/sandbox?inspect=sandbox-field:sample-customers:sample-field-Email",
  });
  await expect(page.getByRole("status", { name: "Canvas zoom" })).toHaveText(
    "100%",
  );
  await expect.poll(() => nodeInView(page, "sample-customers")).toBe(true);
});

// Show on a module with no fields selects it and brings it into view.
test("Show on a module with no fields brings it into view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const design = structuredClone(configuredSandboxDesign);
  design.modules.push({
    id: "sample-invoices",
    department: "sample-commercial",
    name: "Invoices",
    closed: false,
    fields: [],
    x: 3000,
    y: 0,
  });
  await openAuthenticatedSandbox(page, design);
  await expect.poll(() => nodeInView(page, "sample-invoices")).toBe(false);
  await page
    .getByRole("region", { name: "Needs attention" })
    .getByRole("button", { name: "Show: 1 module has no fields" })
    .click();
  await expect(
    page
      .getByRole("complementary", { name: "Design inspector" })
      .getByRole("heading", { name: "Invoices", level: 2 }),
  ).toBeVisible();
  await expect.poll(() => nodeInView(page, "sample-invoices")).toBe(true);
});
