import { expect, test } from "./helpers/test";
import {
  openAuthenticatedSandbox,
  openCheckpointDialog,
} from "./helpers/sandbox-api";
import { initialDesign } from "../../src/components/systems/sandbox/domain/model";
import { configuredSandboxDesign } from "../helpers/sandbox-fixtures";

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
  await templates.getByRole("button", { name: "Close", exact: true }).click();
  await expect(templates).toBeHidden();
});
