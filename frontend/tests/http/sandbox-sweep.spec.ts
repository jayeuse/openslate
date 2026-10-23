import {
  expect,
  expectNoHorizontalScroll,
  test,
  type Page,
} from "./helpers/test";
import {
  expectPinnedDialog,
  historyVersionFixture,
  openAuthenticatedSandbox,
  openCheckpointDialog,
} from "./helpers/sandbox-api";
import { configuredSandboxDesign } from "../helpers/sandbox-fixtures";

// Phase 8 of the Sandbox UI/UX pass (docs/specs/sandbox-ui-ux-pass.md),
// SWP-1: at 390 px no Sandbox section or dialog scrolls sideways or cuts a
// control off at the screen edge.

const versions = [
  historyVersionFixture(2, "Before restoring the quarterly layout"),
  historyVersionFixture(1, "First draft"),
];

/** Every visible control lies inside the viewport horizontally. */
async function expectNoClippedControl(page: Page) {
  const clipped = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return [
      ...document.querySelectorAll<HTMLElement>(
        "button, a[href], input:not([type=hidden]), select, textarea, [role=switch], [role=checkbox], [role=tab]",
      ),
    ]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        if (element.closest(".sr-only, [aria-hidden=true]")) return false;
        // The canvas pans; its own controls may sit outside the viewport.
        if (element.closest(".react-flow__viewport")) return false;
        return rect.left < -1 || rect.right > width + 1;
      })
      .map(
        (element) =>
          element.getAttribute("aria-label") ??
          element.textContent?.trim().slice(0, 40) ??
          element.tagName,
      );
  });
  expect(clipped).toEqual([]);
}

async function expectFits(page: Page) {
  await expectNoHorizontalScroll(page);
  await expectNoClippedControl(page);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test("every Sandbox section fits a 390 px screen", async ({ page }) => {
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  await page.goto("/sandbox?module=sample-requests");
  for (const tab of ["Canvas", "Structure", "Properties"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expectFits(page);
  }
  for (const [section, title] of [
    ["triggers", "Triggers"],
    ["test", "Test"],
    ["history", "History"],
  ]) {
    await page.goto(`/sandbox?section=${section}`);
    await expect(
      page.getByRole("heading", { name: title, level: 1, exact: true }),
    ).toBeVisible();
    await expectFits(page);
  }
  // The trigger detail on a phone.
  await page.goto("/sandbox?section=triggers");
  await page
    .getByRole("navigation", { name: "Trigger list" })
    .getByRole("button")
    .first()
    .click();
  await expectFits(page);
});

test("every Sandbox dialog fits a 390 px screen", async ({ page }) => {
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    versions,
    hasUnpublishedChanges: true,
  });
  await page.goto("/sandbox?module=sample-requests");

  const checkpoint = await openCheckpointDialog(page);
  await expectFits(page);
  await checkpoint.getByRole("button", { name: "Cancel", exact: true }).click();

  const menu = page.getByRole("button", {
    name: "More Sandbox actions",
    exact: true,
  });
  for (const [item, title] of [
    ["Import or export", "Import or export"],
    ["Start from a template", "Organization templates"],
    ["Discard draft changes", "Discard draft changes?"],
  ] as const) {
    await menu.click();
    await page.getByRole("menuitem", { name: item, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: title });
    await expect(dialog).toBeVisible();
    await expectFits(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }

  await page.getByRole("button", { name: "Review & Publish" }).click();
  const review = page.getByRole("dialog", { name: "Review & Publish" });
  await expect(review).toBeVisible();
  await expectFits(page);
  await page.keyboard.press("Escape");

  // Delete confirmation from Properties (Advanced).
  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  const advanced = page
    .getByRole("complementary", { name: "Design inspector" })
    .getByRole("button", { name: /^Advanced/ });
  if ((await advanced.getAttribute("aria-expanded")) === "false")
    await advanced.click();
  await page
    .getByRole("button", { name: "Delete module", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expectFits(page);
});

// Every Sandbox dialog keeps its title, named close button, and footer in
// view, and on a phone the dialog is its only scroller (the Access dialog
// pattern in DESIGN.md).
test("every Sandbox dialog pins its header and footer and closes by name", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 560 });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    versions,
    hasUnpublishedChanges: true,
  });
  await page.goto("/sandbox?module=sample-requests");

  const checkpoint = await openCheckpointDialog(page);
  await expectPinnedDialog(
    checkpoint,
    "Close checkpoint",
    checkpoint.getByRole("button", { name: "Save checkpoint", exact: true }),
  );
  await checkpoint
    .getByRole("button", { name: "Close checkpoint", exact: true })
    .click();
  await expect(checkpoint).toBeHidden();

  const menu = page.getByRole("button", {
    name: "More Sandbox actions",
    exact: true,
  });
  for (const [item, title, close, action] of [
    [
      "Import or export",
      "Import or export",
      "Close import or export",
      "Cancel",
    ],
    [
      "Start from a template",
      "Organization templates",
      "Close organization templates",
      "Use Inventory & procurement",
    ],
    [
      "Discard draft changes",
      "Discard draft changes?",
      "Close without discarding",
      "Discard draft",
    ],
  ] as const) {
    await menu.click();
    await page.getByRole("menuitem", { name: item, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: title });
    await expectPinnedDialog(
      dialog,
      close,
      dialog.getByRole("button", { name: action, exact: true }),
    );
    await dialog.getByRole("button", { name: close, exact: true }).click();
    await expect(dialog).toBeHidden();
  }

  await page.getByRole("button", { name: "Review & Publish" }).click();
  const review = page.getByRole("dialog", { name: "Review & Publish" });
  await expect(review.getByRole("heading", { name: "Changes" })).toBeVisible();
  await expectPinnedDialog(
    review,
    "Close review",
    review.getByRole("button", { name: "Publish changes", exact: true }),
  );
  await review
    .getByRole("button", { name: "Close review", exact: true })
    .click();
  await expect(review).toBeHidden();

  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect modules", exact: true })
    .click();
  const connect = page.getByRole("dialog", { name: "Connect modules" });
  await expectPinnedDialog(
    connect,
    "Close connect modules",
    connect.getByRole("button", {
      name: "Create relationship",
      exact: true,
    }),
  );
  await connect
    .getByRole("button", { name: "Close connect modules", exact: true })
    .click();
  await expect(connect).toBeHidden();

  await page.goto("/sandbox?section=history");
  await page
    .getByRole("button", { name: "View First draft", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Restore version", exact: true })
    .click();
  const restore = page.getByRole("alertdialog", {
    name: "Restore First draft?",
  });
  await expectPinnedDialog(
    restore,
    "Close without restoring",
    restore.getByRole("button", { name: "Restore version", exact: true }),
  );
});
