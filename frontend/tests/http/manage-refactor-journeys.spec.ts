import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000101",
        setup_required: false,
      },
    }),
  );
});

test("Manage preserves section drafts, validates saves, and retains accepted settings after reload", async ({
  page,
}) => {
  await page.goto("/manage?view=organization");
  const name = page.getByRole("textbox", {
    name: "Organization name",
    exact: true,
  });
  await expect(name).toBeVisible();
  const original = await name.inputValue();
  await name.fill("Refactor journey workspace");
  await page.getByRole("link", { name: "Security", exact: true }).click();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(name).toHaveValue("Refactor journey workspace");
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(name).toHaveValue(original);
  await name.fill(" ");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveValue(" ");
  await name.fill("Accepted journey workspace");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(name).toHaveValue("Accepted journey workspace");
});

test("Manage reset cancellation retains drafts and confirmation requires draft acknowledgement", async ({
  page,
}) => {
  await page.goto("/manage?view=organization");
  const name = page.getByRole("textbox", {
    name: "Organization name",
    exact: true,
  });
  await expect(name).toBeVisible();
  const original = await name.inputValue();
  await name.fill("Keep this draft");
  const reset = page.getByRole("button", { name: "Reset Manage", exact: true });
  await reset.click();
  const dialog = page.getByRole("alertdialog");
  const confirm = dialog.getByRole("button", {
    name: "Reset Manage configuration",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(name).toHaveValue("Keep this draft");
  await expect(reset).toBeFocused();
  await reset.click();
  await dialog
    .getByRole("checkbox", { name: "Discard affected unsaved drafts" })
    .check();
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(name).toHaveValue(original);
});

test("Manage snapshot rename retains invalid input, restores focus on cancel, and persists an accepted name", async ({
  page,
}) => {
  await page.goto("/manage?view=backup");
  const opener = page.getByRole("button", {
    name: "Rename Scheduled snapshot",
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("dialog", {
    name: "Rename snapshot",
    exact: true,
  });
  const name = dialog.getByRole("textbox", {
    name: "Snapshot name",
    exact: true,
  });
  const submit = dialog.getByRole("button", {
    name: "Rename snapshot",
    exact: true,
  });
  await name.fill("");
  await expect(submit).toBeDisabled();
  await name.fill("After workspace setup");
  await submit.click();
  await expect(
    dialog.getByText("A snapshot already uses this name.", { exact: true }),
  ).toBeVisible();
  await expect(name).toHaveValue("After workspace setup");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(name).toHaveValue("Scheduled snapshot");
  await name.fill("Renamed journey snapshot");
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", {
      name: "Rename Renamed journey snapshot",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Rename Renamed journey snapshot",
      exact: true,
    }),
  ).toBeVisible();
});
