import { expect, test, type Locator } from "./helpers/test";
import { mockAccessApi } from "./helpers/access-api";
import {
  historyVersionFixture,
  openAuthenticatedSandbox,
  openCheckpointDialog,
} from "./helpers/sandbox-api";
import { initialDesign } from "../../src/components/systems/sandbox/domain/model";
import { configuredSandboxDesign } from "../helpers/sandbox-fixtures";

async function height(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element has no box");
  return Math.round(box.height);
}

/** A field's edges, fill and corners: the parts of the Slate field skin. */
function skin(field: Locator) {
  return field.evaluate((element) => {
    const style = getComputedStyle(element);
    return [
      style.borderTopColor,
      style.borderBottomColor,
      style.borderBottomWidth,
      style.backgroundColor,
      style.borderTopLeftRadius,
      style.borderBottomLeftRadius,
    ];
  });
}

// Phase 7 of the Sandbox UI/UX pass (docs/specs/sandbox-ui-ux-pass.md):
// HDR-1 to HDR-3, the menu order, and the close buttons (D3).

test("the save-state chip shows saving, then saved", async ({ page }) => {
  let release!: () => void;
  const saveDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openAuthenticatedSandbox(page, initialDesign, { saveDelay });
  const chip = page.locator("[data-sandbox-save-state]");
  await expect(chip).toHaveText("Nothing to publish yet · Saved");

  await page.getByRole("button", { name: "Add department" }).click();
  await page.getByLabel("Department name").fill("Finance");
  await page.getByRole("button", { name: "Create department" }).click();
  await expect(chip).toHaveText(/· Saving…$/);
  release();
  await expect(chip).toHaveText(/· Saved$/);
});

test("a failed save turns the chip to Not saved", async ({ page }) => {
  await openAuthenticatedSandbox(page, initialDesign, {
    saveFailure: "Sandbox storage is unavailable.",
  });
  await page.getByRole("button", { name: "Add department" }).click();
  await page.getByLabel("Department name").fill("Finance");
  await page.getByRole("button", { name: "Create department" }).click();
  await expect(page.locator("[data-sandbox-save-state]")).toHaveText(
    "Not saved",
  );
});

test("Review and Publish says why it is disabled", async ({ page }) => {
  await openAuthenticatedSandbox(page, initialDesign);
  const publish = page.getByRole("button", { name: "Review & Publish" });
  await expect(publish).toHaveAttribute("aria-disabled", "true");
  await expect(publish).toHaveAccessibleDescription("Nothing to publish yet.");
});

test("Undo and Redo are named icon buttons that say why they cannot act", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuthenticatedSandbox(page, initialDesign);
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  // Quiet icon buttons: the name is the label, not visible text.
  await expect(undo).toHaveText("");
  await expect(redo).toHaveText("");
  await expect(undo).toHaveAttribute("aria-disabled", "true");
  await expect(undo).toHaveAccessibleDescription("Nothing to undo.");
  await expect(redo).toHaveAttribute("aria-disabled", "true");
  await expect(redo).toHaveAccessibleDescription("Nothing to redo.");

  await page.getByRole("button", { name: "Add department" }).click();
  await page.getByLabel("Department name").fill("Finance");
  await page.getByRole("button", { name: "Create department" }).click();
  await expect(page.locator("[data-sandbox-save-state]")).toHaveText(
    /· Saved$/,
  );
  await expect(undo).toBeEnabled();
  await expect(undo).toHaveAccessibleDescription("");
  await undo.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
    "Undo",
  );
  await undo.click();
  await expect(redo).toBeEnabled();
  await expect(undo).toHaveAccessibleDescription("Nothing to undo.");
});

test("from 1280 px Sandbox fields and buttons use the slim controls of Access", async ({
  page,
}) => {
  await mockAccessApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuthenticatedSandbox(page, configuredSandboxDesign);
  await page.goto("/sandbox?section=triggers");
  const name = page.getByLabel("Trigger name", { exact: true });
  await expect(name).toBeVisible();
  await name.blur();
  await page.mouse.move(0, 0);
  expect(await height(name)).toBe(32);
  expect(
    await height(page.getByRole("button", { name: "Review & Publish" })),
  ).toBe(32);
  const sandboxField = await skin(name);

  await page.goto("/access?view=people");
  const sort = page.getByRole("combobox", { name: "Sort", exact: true });
  await expect(sort).toBeVisible();
  expect(await height(sort)).toBe(32);
  // The same Slate field: a sunken well, a clear top, and the 3:1 rule.
  expect(sandboxField).toEqual(await skin(sort));
});

test("a saved checkpoint is announced by a notice, not the page alert", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, configuredSandboxDesign);
  const dialog = await openCheckpointDialog(page);
  await dialog
    .getByLabel("Checkpoint name", { exact: true })
    .fill("Before the review");
  await dialog.getByRole("button", { name: "Save checkpoint" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Checkpoint saved", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("[data-sandbox-page]").getByText("Checkpoint saved"),
  ).toHaveCount(0);
});

test("the menu ends with Discard, and large dialogs close with X", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, configuredSandboxDesign);
  await page
    .getByRole("button", { name: "More Sandbox actions", exact: true })
    .click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Save checkpoint",
    "Start from a template",
    "Import or export",
    "Discard draft changes",
  ]);
  await page
    .getByRole("menuitem", { name: "Start from a template", exact: true })
    .click();
  const templates = page.getByRole("dialog", {
    name: "Organization templates",
  });
  await expect(templates).toBeVisible();
  await templates
    .getByRole("button", { name: "Close organization templates", exact: true })
    .click();
  await expect(templates).toBeHidden();
});

test("a trigger that cannot publish shows before the review and opens from it", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, configuredSandboxDesign);
  const blocker =
    "Urgent request alert: notification actions can't be published yet.";
  // No banner above the section: one quiet control under the title (S18).
  await expect(page.getByText(/items? needs? attention\./)).toHaveCount(0);
  const attention = page.getByRole("button", { name: "1 needs attention" });
  const list = page.getByRole("dialog", { name: "Needs attention" });
  // A keyboard open moves focus to the first row; Escape returns it.
  await attention.focus();
  await page.keyboard.press("Enter");
  const open = list
    .getByRole("listitem")
    .filter({ hasText: blocker })
    .getByRole("button", { name: "Open trigger", exact: true });
  await expect(open).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(attention).toBeFocused();
  // An outside click closes it too.
  await attention.click();
  await expect(open).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(list).toBeHidden();
  // The button names where it goes; the blocker describes it.
  await attention.click();
  await expect(open).toHaveAccessibleDescription(blocker);
  await open.click();
  await expect(list).toBeHidden();
  await expect(page).toHaveURL(/section=triggers/);
  await expect(page.getByLabel("Trigger name")).toHaveValue(
    "Urgent request alert",
  );

  await page.goto("/sandbox");
  await page.getByRole("button", { name: "Review & Publish" }).click();
  const review = page.getByRole("dialog", { name: "Review & Publish" });
  // The change list still loads, so the owner sees what is waiting.
  await expect(review.getByRole("heading", { name: "Changes" })).toBeVisible();
  await expect(
    review.getByRole("button", { name: "Publish changes" }),
  ).toBeDisabled();
  // The team line shows whenever a review is ready, blocked or not.
  await expect(
    review.getByText("Your team sees these changes as soon as you publish."),
  ).toBeVisible();
  await review
    .getByRole("listitem")
    .filter({ hasText: blocker })
    .getByRole("button", { name: "Open trigger" })
    .click();
  await expect(review).toBeHidden();
  await expect(page.getByLabel("Trigger name")).toHaveValue(
    "Urgent request alert",
  );
});

// On a phone the header is two rows (S13): the title with Review & Publish
// and the menu, then the save-state chip with the attention control. With
// the banner gone it takes about half of the space it took before content,
// and every target is 44 px.
test("on a phone the header is two rows with 44 px targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    versions: [historyVersionFixture(1, "First draft")],
  });
  const header = page.locator("[data-sandbox-page] > header");
  for (const title of ["Build", "Triggers", "Test", "History"]) {
    await page.goto(`/sandbox?section=${title.toLowerCase()}`);
    const heading = header.getByRole("heading", { level: 1, name: title });
    await expect(heading).toBeVisible();
    const [titleBox, publish, menu, chip, attention] = await Promise.all(
      [
        heading,
        header.getByRole("button", { name: "Review & Publish" }),
        header.getByRole("button", {
          name: "More Sandbox actions",
          exact: true,
        }),
        header.locator("[data-sandbox-save-state]"),
        header.getByRole("button", { name: "1 needs attention" }),
      ].map(async (part) => {
        const box = await part.boundingBox();
        if (!box) throw new Error("A header part has no box");
        return { ...box, middle: box.y + box.height / 2 };
      }),
    );
    // Row 1, left to right: title, Review & Publish, menu.
    for (const box of [publish!, menu!])
      expect(Math.abs(box.middle - titleBox!.middle)).toBeLessThan(12);
    expect(titleBox!.x).toBeLessThan(publish!.x);
    expect(publish!.x).toBeLessThan(menu!.x);
    // Row 2: the chip, then the attention control.
    expect(chip!.y).toBeGreaterThanOrEqual(publish!.y + publish!.height);
    expect(Math.abs(attention!.middle - chip!.middle)).toBeLessThan(12);
    expect(chip!.x).toBeLessThan(attention!.x);
    // Undo and Redo moved to the Build canvas toolbar.
    await expect(header.getByRole("button", { name: "Undo" })).toHaveCount(0);
    const targets = await header.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return Math.min(Math.round(box.width), Math.round(box.height));
      }),
    );
    expect(Math.min(...targets)).toBeGreaterThanOrEqual(44);
    expect(await height(header)).toBeLessThanOrEqual(100);
  }
});

test("on a phone Undo and Redo sit beside the Build pane tabs and say why they wait", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAuthenticatedSandbox(page, configuredSandboxDesign);
  const panes = page.getByRole("navigation", { name: "Designer panes" });
  const undo = panes.getByRole("button", { name: "Undo", exact: true });
  const redo = panes.getByRole("button", { name: "Redo", exact: true });
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toHaveCount(1);
  // On every pane: Canvas, Structure and Properties.
  for (const tab of ["Canvas", "Structure", "Properties"]) {
    await panes.getByRole("tab", { name: tab, exact: true }).click();
    await expect(undo).toHaveAccessibleDescription("Nothing to undo.");
    await expect(redo).toHaveAccessibleDescription("Nothing to redo.");
    for (const button of [undo, redo]) {
      await expect(button).toBeInViewport({ ratio: 1 });
      expect(await height(button)).toBeGreaterThanOrEqual(44);
    }
  }
  await panes.getByRole("tab", { name: "Canvas", exact: true }).click();
  const toolbar = page.getByRole("toolbar", { name: "Canvas view controls" });
  // Without Undo and Redo the canvas toolbar keeps one row on a phone.
  expect(await height(toolbar)).toBeLessThan(60);
  await toolbar.getByRole("button", { name: "Auto-arrange" }).click();
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(redo).toBeEnabled();
});

// Below 768px the canvas toolbar wraps instead of scrolling sideways.
test("from 640 to 767 px the canvas toolbar never scrolls sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await openAuthenticatedSandbox(page, configuredSandboxDesign);
  const toolbar = page.getByRole("toolbar", { name: "Canvas view controls" });
  await expect(toolbar).toBeVisible();
  expect(
    await toolbar.evaluate((element) => getComputedStyle(element).overflowX),
  ).toBe("visible");
});

test("template cards are one radio group that arrow keys move through", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, configuredSandboxDesign);
  await page
    .getByRole("button", { name: "More Sandbox actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Start from a template", exact: true })
    .click();
  const group = page.getByRole("radiogroup", { name: "Templates" });
  const first = group.getByRole("radio", { name: "Inventory & procurement" });
  await expect(first).toHaveAttribute("aria-checked", "true");
  await first.focus();
  await page.keyboard.press("ArrowRight");
  const second = group.getByRole("radio", {
    name: "Finance, accounting & sales",
  });
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("button", { name: "Use Finance, accounting & sales" }),
  ).toBeVisible();
});
