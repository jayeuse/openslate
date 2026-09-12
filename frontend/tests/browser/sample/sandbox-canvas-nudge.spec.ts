import { expect, test, type Locator, type Page } from "../coverage";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";

test.use({ viewport: { width: 1440, height: 900 } });

async function gotoSandbox(page: Page): Promise<void> {
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
}

function canvas(page: Page): Locator {
  return page.getByTestId("sandbox-canvas");
}

function node(page: Page, label: string): Locator {
  return canvas(page).getByText(label, { exact: true });
}

function cell(nodeLabel: Locator): Locator {
  return nodeLabel.locator("xpath=ancestor::*[@data-cell-id][1]");
}

async function translation(target: Locator): Promise<{ x: number; y: number }> {
  const transform = await target.getAttribute("transform");
  const match = transform?.match(/translate\(([-\d.]+),([-\d.]+)\)/);
  if (!match) throw new Error(`Cell translation is unavailable: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

function historyStatus(page: Page): Locator {
  return page.getByText(/^Tab-local draft · \d+ undo steps available$/);
}

test("selected module arrow nudges use snap or precision and each undo as one action", async ({
  page,
}) => {
  await gotoSandbox(page);
  const equipmentLabel = node(page, "Equipment");
  const equipment = cell(equipmentLabel);
  const initial = await translation(equipment);
  const baselineHistory = await historyStatus(page).textContent();
  if (!baselineHistory) throw new Error("History status is unavailable");

  await equipmentLabel.click();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => translation(equipment))
    .toEqual({
      x: initial.x + 24,
      y: initial.y,
    });
  await expect(historyStatus(page)).toHaveText(
    /^Tab-local draft · 1 undo steps available$/,
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => translation(equipment)).toEqual(initial);
  await expect(historyStatus(page)).toHaveText(baselineHistory);

  await equipmentLabel.click();
  await page.keyboard.press("Alt+ArrowDown");
  await expect
    .poll(() => translation(equipment))
    .toEqual({
      x: initial.x,
      y: initial.y + 1,
    });
  await expect(historyStatus(page)).toHaveText(
    /^Tab-local draft · 1 undo steps available$/,
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => translation(equipment)).toEqual(initial);

  await page.getByRole("button", { name: "View canvas" }).click();
  await page.getByRole("menuitemcheckbox", { name: /Snap/ }).click();
  await equipmentLabel.click();
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() => translation(equipment))
    .toEqual({
      x: initial.x - 1,
      y: initial.y,
    });
  await expect(historyStatus(page)).toHaveText(
    /^Tab-local draft · 1 undo steps available$/,
  );
});

test("selected department nudges but focused field rows do not move their module", async ({
  page,
}) => {
  await gotoSandbox(page);
  const operationsLabel = node(page, "Operations");
  const operations = cell(operationsLabel);
  const departmentInitial = await translation(operations);
  await operationsLabel.click();
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => translation(operations))
    .toEqual({
      x: departmentInitial.x,
      y: departmentInitial.y + 24,
    });
  await expect(historyStatus(page)).toHaveText(
    /^Tab-local draft · 1 undo steps available$/,
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => translation(operations)).toEqual(departmentInitial);

  const equipment = cell(node(page, "Equipment"));
  const moduleInitial = await translation(equipment);
  const field = canvas(page).getByRole("button", {
    name: "Asset tag, Text, required",
    exact: true,
  });
  await field.focus();
  await field.press("Enter");
  const baselineHistory = await historyStatus(page).textContent();
  if (!baselineHistory) throw new Error("History status is unavailable");
  await field.press("ArrowRight");
  await expect.poll(() => translation(equipment)).toEqual(moduleInitial);
  await expect(historyStatus(page)).toHaveText(baselineHistory);
});
