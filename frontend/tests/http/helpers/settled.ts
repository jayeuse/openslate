import { expect, type Locator } from "./test";

/**
 * Waits for an element's own enter transition: first its starting style goes,
 * then the transition that removal began runs out. A pointer press and its
 * release are separate events, so a target that moves between them loses the
 * click without an error, and Playwright checks only the press.
 */
async function entered(element: Locator): Promise<void> {
  await expect(element).not.toHaveAttribute("data-starting-style");
  await element.evaluate(async (node) => {
    await Promise.allSettled(node.getAnimations().map((item) => item.finished));
  });
}

/**
 * Returns a sheet once it has stopped sliding in. Playwright's stable check
 * can pass while the sheet waits offscreen before its slide starts, so a click
 * inside an unsettled sheet can miss a control that is already moving.
 */
export async function openedSheet(sheet: Locator): Promise<Locator> {
  await expect(sheet).toBeVisible();
  await entered(sheet);
  return sheet;
}

/**
 * Waits for the panel that `trigger` opened to reach its full height. Until
 * then the rows below it move down, so a press and its release can land on
 * different rows. Rows inside a sidebar panel stay still: `overflow-clip`
 * keeps the panel from scrolling, which app-shell.spec.ts proves without this
 * helper.
 */
export async function openedPanel(trigger: Locator): Promise<void> {
  await expect(trigger).toHaveAttribute("aria-controls", /.+/);
  const panel = await trigger.getAttribute("aria-controls");
  await entered(trigger.page().locator(`[id="${panel}"]`));
}
