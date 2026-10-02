import { expect, test } from "./helpers/test";
import { alertDialogFixtureBundle } from "./helpers/alert-dialog-bundle";

// Current product flows control their own open prop and do not exercise this
// important generic primitive contract. Use its real DOM/trigger behavior.
test("an uncontrolled AlertDialog honors a caller-cancelled opening", async ({
  page,
}) => {
  await page.setContent('<div id="fixture"></div>');
  await page.addScriptTag({ content: await alertDialogFixtureBundle() });
  await page
    .getByRole("button", { name: "Open confirmation", exact: true })
    .click();
  await expect(
    page.getByRole("alertdialog", { name: "Caller-controlled cancellation" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Allow opening", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open confirmation", exact: true })
    .click();
  await expect(
    page.getByRole("alertdialog", { name: "Caller-controlled cancellation" }),
  ).toBeVisible();
});

test("an uncontrolled AlertDialog honors a caller-cancelled closing", async ({
  page,
}) => {
  await page.setContent('<div id="fixture"></div>');
  await page.evaluate(() => {
    document.body.dataset.initialOpen = "true";
  });
  await page.addScriptTag({ content: await alertDialogFixtureBundle() });
  const dialog = page.getByRole("alertdialog", {
    name: "Caller-controlled cancellation",
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close confirmation", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Allow closing", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await dialog
    .getByRole("button", { name: "Close confirmation", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
});
