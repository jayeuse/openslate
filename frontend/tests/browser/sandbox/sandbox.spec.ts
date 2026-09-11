import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
import { expect, test, type Locator, type Page } from "../coverage";

test.use({ viewport: { width: 1440, height: 900 } });
async function gotoSandbox(page: Page, path = "/sandbox"): Promise<void> {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: { detail: "Authentication required" } }),
  );
  await page.route("**/bff/**", async (route) => {
    if (!(await fulfillWorkspaceRequest(route)))
      await route.fulfill({ json: { items: [], has_more: false } });
  });
  await page.goto(path);
}
function canvas(page: Page): Locator {
  return page.getByTestId("sandbox-canvas");
}
function node(page: Page, label: string): Locator {
  return canvas(page).getByText(label, { exact: true });
}
async function nodeBox(node: Locator) {
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
  if (!before) throw new Error("Dragged node has no bounds");
  await page.mouse.move(
    before.x + before.width / 2,
    before.y + before.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.mouse.up();
}

test("old Sandbox URL opens only the new sample Designer", async ({ page }) => {
  await gotoSandbox(page, "/sandbox");
  await expect(page).toHaveURL(/\/sandbox$/);
  await expect(
    page.getByRole("heading", { name: "Organization designer", exact: true }),
  ).toBeVisible();
});

test("shared canvas supports F2 names field types and cancelled edits in Designer", async ({
  page,
}) => {
  await gotoSandbox(page);
  const editor = page.getByRole("textbox", {
    name: "Canvas name editor",
    exact: true,
  });
  await node(page, "Operations").click();
  await page.keyboard.press("F2");
  await expect(editor).toHaveValue("Operations");
  await editor.fill("   ");
  await editor.press("Enter");
  await expect(editor).toBeVisible();
  await editor.press("Escape");
  await node(page, "Equipment").click();
  await page.keyboard.press("F2");
  await editor.fill("Assets");
  await editor.press("Enter");
  await expect(node(page, "Assets")).toBeVisible();
  await node(page, "Assets").click();
  await page.keyboard.press("F2");
  await editor.fill("Cancelled module");
  await editor.press("Escape");
  await expect(node(page, "Cancelled module")).toHaveCount(0);
  await expect(node(page, "Assets")).toBeVisible();
  const field = canvas(page).getByRole("button", {
    name: "Asset tag, Text, required",
    exact: true,
  });
  await field.focus();
  await field.press("Enter");
  await field.press("F2");
  await expect(editor).toHaveValue("Asset tag");
  await editor.fill("Serial number");
  await editor.press("Enter");
  const renamed = canvas(page).getByRole("button", {
    name: "Serial number, Text, required",
    exact: true,
  });
  await expect(renamed).toBeVisible();
  const box = await renamed.boundingBox();
  if (!box) throw new Error("Renamed field has no bounds");
  await renamed.dblclick({
    position: { x: box.width * 0.85, y: box.height / 2 },
  });
  await page
    .getByRole("combobox", { name: "Canvas field type", exact: true })
    .selectOption("int");
  await expect(
    canvas(page).getByRole("button", {
      name: "Serial number, Integer, required",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("complementary", { name: "Design inspector" })
      .getByLabel("Serial number field type", { exact: true }),
  ).toHaveValue("Integer");
});

test("outline palette rejects department field drops and adds a field to its target module", async ({
  page,
}) => {
  await gotoSandbox(page);
  const palette = page
    .getByRole("complementary", { name: "Organization structure" })
    .getByRole("button", { name: "Add field to Equipment", exact: true });
  await palette.dragTo(node(page, "Operations"));
  await expect(
    canvas(page).getByText("Fields can only be added inside a module.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    canvas(page).getByRole("button", {
      name: "Text field, Text, optional",
      exact: true,
    }),
  ).toHaveCount(0);
  await palette.dragTo(node(page, "Equipment"));
  await expect(
    canvas(page).getByText("Fields can only be added inside a module.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    canvas(page)
      .locator('[data-cell-id="sample-equipment"]')
      .getByRole("button", { name: "Text field, Text, optional", exact: true }),
  ).toBeVisible();
  await expect(
    canvas(page)
      .locator('[data-cell-id="sample-requests"]')
      .getByRole("button", { name: "Text field, Text, optional", exact: true }),
  ).toHaveCount(0);
});

test("roundtrips embedded Designer geometry through undo, redo, and remount", async ({
  page,
}) => {
  await gotoSandbox(page);
  await page.goto("/sandbox");
  await page.setViewportSize({ width: 1920, height: 1080 });
  const department = node(page, "Operations");
  await expect(department).toBeVisible();
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  await expect(undo).toBeDisabled();
  await department.click();
  // Compare graph-space dimensions: remounting intentionally fits the viewport
  // again, so screen pixels also reflect the current zoom scale.
  const frame = department
    .locator("xpath=ancestor::*[@data-cell-id][1]")
    .locator("rect")
    .first();
  const initialWidth = Number(await frame.getAttribute("width"));
  expect(initialWidth).toBeGreaterThan(0);
  const grip = canvas(page)
    .getByRole("button", { name: "Resize department", exact: true })
    .first();
  await grip.focus();
  await grip.press("ArrowRight");
  await expect
    .poll(async () => Number(await frame.getAttribute("width")))
    .toBeGreaterThan(initialWidth);
  const resizedWidth = await frame.getAttribute("width");
  if (!resizedWidth) throw new Error("Resized geometry is missing");
  await undo.click();
  await expect(frame).toHaveAttribute("width", String(initialWidth));
  await expect(undo).toBeDisabled();
  await redo.click();
  await expect(frame).toHaveAttribute("width", resizedWidth);
  await page.getByRole("button", { name: "Automation", exact: true }).click();
  await page.getByRole("button", { name: "Designer", exact: true }).click();
  await expect(frame).toHaveAttribute("width", resizedWidth);
});

test("undoes an embedded Designer reparent and its geometry in one action", async ({
  page,
}) => {
  await gotoSandbox(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/sandbox");
  const equipment = node(page, "Equipment");
  const commercial = node(page, "Commercial");
  await expect(equipment).toBeVisible();
  await expect(commercial).toBeVisible();
  const outlineDepartment = (name: string) =>
    page.getByTestId("inspector-outline-department").filter({
      has: page.getByRole("button", {
        name: `Select department ${name}`,
        exact: true,
      }),
    });
  const equipmentIn = (name: string) =>
    outlineDepartment(name).getByRole("button", {
      name: "Select module Equipment",
      exact: true,
    });
  await expect(equipmentIn("Operations")).toBeVisible();
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeDisabled();
  // Make an empty drop area beside Customers in the compact department frame.
  await commercial.click();
  const resizeGrip = canvas(page).getByRole("button", {
    name: "Resize department",
    exact: true,
  });
  await resizeGrip.focus();
  for (let step = 0; step < 15; step += 1) await resizeGrip.press("ArrowRight");
  await page.getByRole("button", { name: "Fit canvas", exact: true }).click();
  const historyStatus = page.getByText(
    /^Tab-local draft · \d+ undo steps available$/,
  );
  const baselineHistory = await historyStatus.textContent();
  if (!baselineHistory) throw new Error("Design history count is missing");
  const equipmentNode = equipment.locator(
    "xpath=ancestor::*[@data-cell-id][1]",
  );
  const originalPosition = await equipmentNode.getAttribute("transform");
  if (!originalPosition) throw new Error("Equipment graph position is missing");
  const target = await nodeBox(commercial);
  if (!target) throw new Error("Commercial department frame is missing");
  const equipmentBounds = await nodeBox(equipment);
  if (!equipmentBounds) throw new Error("Equipment frame is missing");
  await dragNodeToPoint(page, equipment, {
    x: target.x + target.width - equipmentBounds.width / 2 - 16,
    y: target.y + target.height - equipmentBounds.height / 2 - 16,
  });
  await expect(equipmentIn("Commercial")).toBeVisible();
  await expect(equipmentIn("Operations")).toHaveCount(0);
  await expect(equipmentNode).not.toHaveAttribute(
    "transform",
    originalPosition,
  );
  await undo.click();
  await expect(equipmentIn("Operations")).toBeVisible();
  await expect(equipmentIn("Commercial")).toHaveCount(0);
  await expect(equipmentNode).toHaveAttribute("transform", originalPosition);
  await expect(historyStatus).toHaveText(baselineHistory);
});

test("routes compact Designer relationships without Manhattan fallback warnings", async ({
  page,
}) => {
  const routingMessages: string[] = [];
  page.on("pageerror", (error) => routingMessages.push(error.message));
  page.on("console", (message) => {
    if (
      ["warning", "error"].includes(message.type()) &&
      /manhattan|orth instead/i.test(message.text())
    )
      routingMessages.push(message.text());
  });
  await gotoSandbox(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/sandbox");
  const connection = canvas(page)
    .locator(".x6-edge path[stroke-dasharray]")
    .first();
  await expect(connection).toBeAttached();
  await expect
    .poll(() =>
      connection.evaluate((path) => {
        const style = getComputedStyle(path);
        return (
          path instanceof SVGPathElement &&
          path.getTotalLength() > 0 &&
          style.stroke !== "none" &&
          Number.parseFloat(style.strokeWidth) > 0 &&
          style.display !== "none" &&
          style.visibility === "visible"
        );
      }),
    )
    .toBe(true);
  await expect(connection).toHaveAttribute("d", /^M.+L.+/);
  expect(routingMessages).toEqual([]);
  const equipment = node(page, "Equipment");
  const position = await nodeBox(equipment);
  if (!position) throw new Error("Equipment bounds missing");
  await dragNodeToPoint(page, equipment, {
    x: position.x + position.width / 2 + 60,
    y: position.y + position.height / 2 + 60,
  });
  await expect(connection).toHaveAttribute("d", /^M.+L.+/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(connection).toBeAttached();
  await expect
    .poll(() =>
      connection.evaluate((path) => {
        const style = getComputedStyle(path);
        return (
          path instanceof SVGPathElement &&
          path.getTotalLength() > 0 &&
          style.stroke !== "none" &&
          Number.parseFloat(style.strokeWidth) > 0 &&
          style.display !== "none" &&
          style.visibility === "visible"
        );
      }),
    )
    .toBe(true);
  const requests = await nodeBox(node(page, "Service requests"));
  if (!requests) throw new Error("Service requests bounds missing");
  await dragNodeToPoint(page, equipment, {
    x: requests.x + requests.width / 2 + 60,
    y: requests.y + requests.height / 2 + 30,
  });
  expect(routingMessages).toEqual([]);
  const overlapping = await nodeBox(equipment);
  if (!overlapping) throw new Error("Moved Equipment bounds missing");
  expect(overlapping.x).toBeLessThan(requests.x + requests.width);
  expect(overlapping.x + overlapping.width).toBeGreaterThan(requests.x);
  expect(overlapping.y).toBeLessThan(requests.y + requests.height);
  await expect(connection).toHaveAttribute("d", /^M.+L.+/);
  const route = await connection.getAttribute("d");
  const coordinates = (route?.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  expect(coordinates.length).toBeGreaterThanOrEqual(4);
  for (let index = 2; index < coordinates.length; index += 2) {
    expect(
      coordinates[index] === coordinates[index - 2] ||
        coordinates[index + 1] === coordinates[index - 1],
    ).toBe(true);
  }
  expect(routingMessages).toEqual([]);
});
