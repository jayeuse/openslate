import { expect, test } from "../coverage";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";

const VIEW_PREFERENCES_KEY = "openslate.sample.sandbox.view.v1";

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
  await page.addInitScript((key) => {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(
      key,
      JSON.stringify({
        gridVisible: "invalid",
        snapEnabled: false,
        structureWidth: -500,
        inspectorWidth: 99_999,
        structureCollapsed: "no",
        inspectorCollapsed: false,
        mobilePane: "unknown",
      }),
    );
  }, VIEW_PREFERENCES_KEY);
  await page.goto("/sandbox");
});

test("structure search and disclosure make large outlines navigable @extended", async ({
  page,
}) => {
  const structure = page.getByRole("complementary", {
    name: "Organization structure",
  });
  const search = structure.getByRole("searchbox", {
    name: "Search structure",
  });
  await expect(search).toBeVisible();

  const operationsDisclosure = structure.getByRole("button", {
    name: "Collapse department Operations",
  });
  await operationsDisclosure.click();
  await expect(
    structure.getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    structure.getByRole("button", { name: "Expand department Operations" }),
  ).toHaveAttribute("aria-expanded", "false");

  await search.fill("request number");
  await expect(
    structure.getByRole("button", {
      name: "Select field Request number",
      exact: true,
    }),
  ).toBeVisible();
  await search.fill("missing item");
  await expect(structure.getByText("No structure items match.")).toBeVisible();
});

test("view menu preferences normalize safely and persist for the tab @extended", async ({
  page,
}) => {
  if ((page.viewportSize()?.width ?? 0) < 1280)
    await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  const view = page.getByRole("button", { name: "View canvas", exact: true });
  await view.click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: /Grid/, exact: false }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("menuitemcheckbox", { name: /Snap/, exact: false }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByRole("menuitem", { name: "Reset zoom", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Canvas help", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Canvas controls", exact: true }),
  ).toBeVisible();
  await view.click();
  await page.getByRole("menuitemcheckbox", { name: /Grid/ }).click();
  await page.reload();

  await page.getByRole("button", { name: "View canvas", exact: true }).click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: /Grid/ }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByRole("menuitemcheckbox", { name: /Snap/ }),
  ).toHaveAttribute("aria-checked", "false");
  const stored = await page.evaluate(
    (key) => sessionStorage.getItem(key),
    VIEW_PREFERENCES_KEY,
  );
  expect(JSON.parse(stored ?? "{}")).toMatchObject({
    gridVisible: false,
    snapEnabled: false,
    structureWidth: 320,
    inspectorWidth: 480,
    structureCollapsed: false,
    inspectorCollapsed: false,
  });
});

test("restored Snap Off applies to the first pointer drag @extended", async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1280, "Desktop contract");
  await page.getByRole("button", { name: "Fit canvas", exact: true }).click();
  const cell = page
    .getByTestId("sandbox-canvas")
    .locator('[data-cell-id="sample-requests"]');
  const position = () =>
    cell.evaluate((element) => {
      const transform = element.getAttribute("transform") ?? "";
      const match = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(transform);
      if (!match) throw new Error(`Missing node translation: ${transform}`);
      return { x: Number(match[1]), y: Number(match[2]) };
    });
  const before = await position();
  await expect(page.getByTestId("sandbox-grid")).toHaveAttribute(
    "data-snap-size",
    "1",
  );
  const heading = cell.getByText("Service requests", { exact: true });
  const start = await heading.boundingBox();
  if (!start) throw new Error("Module geometry missing");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    start.x + start.width / 2 + 35,
    start.y + start.height / 2 + 29,
    { steps: 8 },
  );
  await page.mouse.up();

  await expect.poll(async () => (await position()).x).not.toBe(before.x);
  await expect.poll(async () => (await position()).y).not.toBe(before.y);
  await expect(page.getByTestId("sandbox-grid")).toHaveAttribute(
    "data-snap-size",
    "1",
  );
});

test("desktop panels keep readable minimum widths and only collapse the inspector explicitly @extended", async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1280, "Desktop contract");
  const structure = page.getByRole("complementary", {
    name: "Organization structure",
  });
  const inspector = page.getByRole("complementary", {
    name: "Design inspector",
  });
  const inspectorBefore = await inspector.boundingBox();
  if (!inspectorBefore) throw new Error("Inspector panel missing");
  const structureBefore = await structure.boundingBox();
  if (!structureBefore) throw new Error("Structure panel missing");
  expect(structureBefore.width).toBeGreaterThanOrEqual(319);
  expect(structureBefore.width).toBeLessThanOrEqual(321);

  const structureInstructions = structure.getByText(
    "Select an item for settings. Right-click or press Shift+F10 for actions. Double-click a name to rename it.",
    { exact: true },
  );
  const instructionLines = await structureInstructions.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()].filter((rect) => rect.width > 0).length;
  });
  expect(instructionLines).toBe(2);

  const inspectorActions = inspector.getByRole("group", {
    name: "Module actions",
    exact: true,
  });
  const actionButtons = [
    inspectorActions.getByRole("button", {
      name: "Rename module",
      exact: true,
    }),
    inspectorActions.getByRole("button", {
      name: "Close module",
      exact: true,
    }),
    inspectorActions.getByRole("button", {
      name: "Add module",
      exact: true,
    }),
  ];
  await expect(inspectorActions).toBeVisible();

  const inspectorHandle = page.getByRole("separator", {
    name: "Resize inspector",
  });
  await inspectorHandle.focus();
  await inspectorHandle.press("End");
  await expect
    .poll(async () => (await inspector.boundingBox())?.width ?? 0)
    .toBeLessThan(inspectorBefore.width);
  await expect
    .poll(async () => (await inspector.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(449);
  await expect(
    page.getByRole("button", { name: "Expand inspector", exact: true }),
  ).toHaveCount(0);
  const actionTops = await Promise.all(
    actionButtons.map(async (button) => (await button.boundingBox())?.y ?? -1),
  );
  expect(Math.max(...actionTops) - Math.min(...actionTops)).toBeLessThan(1);

  const structureHandle = page.getByRole("separator", {
    name: "Resize structure",
  });
  await structureHandle.focus();
  await structureHandle.press("End");
  await expect
    .poll(async () => (await structure.boundingBox())?.width ?? 0)
    .toBeGreaterThan(structureBefore.width);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.reload();
  await expect
    .poll(async () => (await structure.boundingBox())?.width ?? 0)
    .toBeGreaterThan(structureBefore.width);
  await expect
    .poll(async () => (await inspector.boundingBox())?.width ?? 0)
    .toBeLessThan(inspectorBefore.width);

  await page
    .getByRole("button", { name: "Collapse structure", exact: true })
    .click();
  await expect(structure).toHaveCount(0);
  await page
    .getByRole("button", { name: "Collapse inspector", exact: true })
    .click();
  await expect(inspector).toHaveCount(0);
  await page.reload();
  await expect(structure).toHaveCount(0);
  await expect(inspector).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Expand structure", exact: true }),
  ).toBeVisible();
  const expandInspector = page.getByRole("button", {
    name: "Expand inspector",
    exact: true,
  });
  await expect(expandInspector).toBeVisible();
  await expandInspector.click();
  await expect
    .poll(async () => (await inspector.boundingBox())?.width ?? 0)
    .toBeLessThan(inspectorBefore.width);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("mobile restores the last active designer pane @extended", async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1280, "Mobile contract");
  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  await expect(
    page.getByRole("tabpanel", { name: "Canvas", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Module design canvas")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Module design canvas")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Canvas", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tabpanel", { name: "Canvas", exact: true }),
  ).toBeVisible();
});

test("auto-arrange and reset layout each add one undoable history action @extended", async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1280, "Desktop contract");
  const history = page.getByText(/Tab-local draft/);
  await expect(history).toContainText("0 undo steps available");

  await page.getByRole("button", { name: "View canvas", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Auto-arrange", exact: true })
    .click();
  await expect(history).toContainText("1 undo steps available");

  await page.getByRole("button", { name: "View canvas", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Reset layout", exact: true })
    .click();
  await expect(history).toContainText("2 undo steps available");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(history).toContainText("1 undo steps available");
});
