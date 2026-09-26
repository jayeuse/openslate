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
  await page
    .getByRole("link", { name: "Security & recovery", exact: true })
    .click();
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
  const options = page.getByRole("button", {
    name: "Manage options",
    exact: true,
  });
  await options.click();
  const reset = page.getByRole("menuitem", {
    name: "Reset Manage",
    exact: true,
  });
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
  await expect(options).toBeFocused();
  await options.click();
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
  await page
    .getByRole("button", { name: "Inspect Scheduled snapshot", exact: true })
    .click();
  const opener = page.getByRole("button", {
    name: "Snapshot actions",
    exact: true,
  });
  await opener.click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
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
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await expect(name).toHaveValue("Scheduled snapshot");
  await name.fill("Renamed journey snapshot");
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", {
      name: "Inspect Renamed journey snapshot",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Inspect Renamed journey snapshot",
      exact: true,
    }),
  ).toBeVisible();
});

test("Updates and licensing share one destination without bypassing confirmations", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && request.method() !== "GET")
      writes.push(request.url());
  });
  await page.goto("/manage?view=licensing");
  await expect(
    page.getByRole("heading", { level: 1, name: "Updates & licensing" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Updates & licensing", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("link", { name: "Licensing", exact: true }),
  ).toHaveCount(0);
  const software = page.getByRole("region", {
    name: "Software version",
    exact: true,
  });
  const license = page.getByRole("region", {
    name: "License & usage",
    exact: true,
  });
  await expect(software).toBeVisible();
  await expect(license).toBeVisible();
  await software
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await software
    .getByRole("button", { name: "Review update", exact: true })
    .click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("No software is installed.");
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(software.getByText("1.4.2", { exact: true })).toBeVisible();
  await software
    .getByRole("button", { name: "Review update", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Confirm update", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(software.getByText("1.5.0", { exact: true })).toBeVisible();

  await license.getByText("Activate license", { exact: true }).click();
  await license
    .getByRole("combobox", { name: "Bundled license key", exact: true })
    .selectOption("SAMPLE-BUSINESS-2026");
  await license.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(confirmation).toContainText(
    "No payment or license service will be contacted.",
  );
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(license.getByText("Team", { exact: true })).toBeVisible();
  await license.getByRole("button", { name: "Continue", exact: true }).click();
  await confirmation
    .getByRole("button", { name: "Confirm activation", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(license.getByText("Business", { exact: true })).toBeVisible();
  await page.reload();
  await expect(software.getByText("1.5.0", { exact: true })).toBeVisible();
  await expect(license.getByText("Business", { exact: true })).toBeVisible();
  await software
    .getByRole("button", { name: "Roll back update", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Confirm rollback", exact: true })
    .click();
  await expect(software.getByText("1.4.2", { exact: true })).toBeVisible();
  await page.goto("/manage?view=updates");
  await expect(license.getByText("Business", { exact: true })).toBeVisible();
  await expect(software).toBeVisible();
  await page.goto("/manage?view=audit");
  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .fill("Release");
  const activity = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  await expect(activity.getByText("Apply", { exact: true })).toBeVisible();
  await expect(activity.getByText("Rollback", { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});
