import { expect, test, type Page } from "./helpers/test";
import { openAuthenticatedSandbox } from "./helpers/sandbox-api";

// Phase 4 of the Sandbox UI/UX pass (docs/specs/sandbox-ui-ux-pass.md):
// TRG-1 to TRG-5.

async function openTriggers(page: Page) {
  const sandbox = await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Trigger settings" }),
  ).toBeVisible();
  return sandbox;
}

test("a select condition offers option labels and stores the option ID", async ({
  page,
}) => {
  const sandbox = await openTriggers(page);
  const settings = page.getByRole("region", { name: "Trigger settings" });
  await page.getByLabel("Condition 1 field").selectOption({ label: "Status" });
  await settings
    .getByLabel("Value", { exact: true })
    .first()
    .selectOption({ label: "In progress" });
  await expect(
    page
      .getByRole("region", { name: "Flow preview" })
      .getByRole("button", { name: /^Condition 1\b/ }),
  ).toContainText("Status is In progress");

  await page.getByRole("button", { name: "Save triggers" }).click();
  await expect.poll(sandbox.documentWrites).toBe(1);
  await expect(page.getByText("Triggers saved", { exact: true })).toBeVisible();
  const document = sandbox.document();
  const condition = document.triggers[0]!.conditionGroup.conditions[0]!;
  const status = document.design.modules
    .flatMap((module) => module.fields)
    .find((field) => field.id === condition.field.fieldId);
  if (status?.config.kind !== "select")
    throw new Error("The condition field is not a select field");
  const inProgress = status.config.options.find(
    (option) => option.label === "In progress",
  );
  expect(condition.value).toEqual({ kind: "literal", value: inProgress!.id });
});

test("unsaved triggers show their count and hold Review and Publish", async ({
  page,
}) => {
  await openTriggers(page);
  await expect(page.getByText(/unsaved trigger/)).toHaveCount(0);
  await page.getByLabel("Trigger name").fill("Renamed trigger");
  await expect(page.getByText(/· 1 unsaved trigger change$/)).toBeVisible();
  const publish = page.getByRole("button", { name: "Review & Publish" });
  await expect(publish).toHaveAttribute("aria-disabled", "true");
  await expect(publish).toHaveAccessibleDescription(
    "Save trigger changes first.",
  );
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByText(/unsaved trigger/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save triggers" })).toHaveCount(
    0,
  );
  // Discard can be undone from its notice.
  await expect(
    page.getByText("Changes discarded", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Trigger name")).toHaveValue("Renamed trigger");
  await expect(page.getByText(/· 1 unsaved trigger change$/)).toBeVisible();
});

test("leaving with unsaved triggers asks Save, Discard, or Stay", async ({
  page,
}) => {
  const sandbox = await openTriggers(page);
  const build = page.getByRole("link", { name: "Build", exact: true });
  const dialog = page.getByRole("dialog", { name: "Unsaved trigger changes" });

  await page.getByLabel("Trigger name").fill("Stay with me");
  await build.click();
  await expect(dialog).toContainText("Discard removes 1 unsaved change.");
  await dialog.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/section=triggers/);
  await expect(page.getByLabel("Trigger name")).toHaveValue("Stay with me");

  await build.click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/section=build/);
  expect(sandbox.documentWrites()).toBe(1);
  expect(sandbox.document().triggers[0]!.name).toBe("Stay with me");

  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await page.getByLabel("Trigger name").fill("Not kept");
  await build.click();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page).toHaveURL(/section=build/);
  expect(sandbox.documentWrites()).toBe(1);
  expect(sandbox.document().triggers[0]!.name).toBe("Stay with me");
});

test("Back from Triggers keeps unsaved trigger edits", async ({ page }) => {
  const sandbox = await openTriggers(page);
  await page.getByLabel("Trigger name").fill("Kept on Back");
  await page.goBack();
  await expect(page).not.toHaveURL(/section=triggers/);
  // The edit is still waiting to be saved, not lost.
  await expect(page.locator("[data-sandbox-save-state]")).toHaveText(
    /· 1 unsaved trigger change$/,
  );
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await expect(page.getByLabel("Trigger name")).toHaveValue("Kept on Back");
  expect(sandbox.documentWrites()).toBe(0);
});

test("a reload offers to restore unsaved trigger edits", async ({ page }) => {
  const sandbox = await openTriggers(page);
  const name = page.getByLabel("Trigger name");
  await name.fill("Survives reload");
  page.on("dialog", (dialog) => void dialog.accept());
  await page.reload();
  const prompt = page
    .getByRole("status")
    .filter({ hasText: "Restore unsaved trigger changes?" });
  // Nothing can be typed over the kept edits while the prompt waits.
  await expect(name).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Trigger On" })).toBeDisabled();
  await prompt.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await expect(name).toBeEnabled();
  await expect(name).toHaveValue("Survives reload");
  await expect(page.locator("[data-sandbox-save-state]")).toHaveText(
    /· 1 unsaved trigger change$/,
  );

  // While the prompt waits, publishing waits too.
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Review & Publish" }),
  ).toHaveAccessibleDescription("Restore or discard trigger changes first.");
  // Discard can be undone from its notice: the prompt comes back.
  await prompt.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(name).toHaveValue("Urgent request alert");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(prompt).toBeVisible();
  await expect(name).toBeDisabled();
  // Discard again, then a reload offers nothing.
  await prompt.getByRole("button", { name: "Discard", exact: true }).click();
  await page.reload();
  await expect(name).toHaveValue("Urgent request alert");
  await expect(prompt).toHaveCount(0);
  expect(sandbox.documentWrites()).toBe(0);
});

test("Undo of a discarded prompt never replaces newer trigger edits", async ({
  page,
}) => {
  await openTriggers(page);
  const name = page.getByLabel("Trigger name");
  await name.fill("Older edit");
  page.on("dialog", (dialog) => void dialog.accept());
  await page.reload();
  const prompt = page
    .getByRole("status")
    .filter({ hasText: "Restore unsaved trigger changes?" });
  await prompt.getByRole("button", { name: "Discard", exact: true }).click();
  await name.fill("Newer edit");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  // The prompt is back, the newer edit stays, and Restore waits for it.
  await expect(prompt).toBeVisible();
  await expect(name).toHaveValue("Newer edit");
  await expect(
    prompt.getByRole("button", { name: "Restore", exact: true }),
  ).toHaveAccessibleDescription(
    "Save or discard your current trigger edits first.",
  );
  // The newer edit stays editable, so it can be resolved here.
  await expect(name).toBeEnabled();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(name).toBeDisabled();
  await expect(
    prompt.getByRole("button", { name: "Restore", exact: true }),
  ).toBeEnabled();
  // The kept edit is still stored: a reload offers it, and Restore applies it.
  await page.reload();
  await prompt.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(name).toHaveValue("Older edit");
});

test("unsaved triggers are marked, a step Save will refuse warns first, and Ctrl+S saves", async ({
  page,
}) => {
  const sandbox = await openTriggers(page);
  const list = page.getByRole("navigation", { name: "Trigger list" });
  const flow = page.getByRole("region", { name: "Flow preview" });
  await expect(list.getByText("Unsaved", { exact: true })).toHaveCount(0);

  // A required field with no value: the flow says so before Save.
  await page
    .getByLabel("Condition 1 field")
    .selectOption({ label: "Request number" });
  await expect(list.getByText("Unsaved", { exact: true })).toHaveCount(1);
  await expect(
    flow.getByRole("button", { name: /^Condition 1\b/ }),
  ).toContainText("Request number is required.");

  await page.getByLabel("Condition 1 field").selectOption({ label: "Title" });
  await expect(
    flow.getByRole("button", { name: /^Condition 1\b/ }),
  ).not.toContainText("is required");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(sandbox.documentWrites).toBe(1);
  await expect(list.getByText("Unsaved", { exact: true })).toHaveCount(0);
  // With nothing unsaved, the shortcut writes nothing.
  await page.keyboard.press("ControlOrMeta+s");
  expect(sandbox.documentWrites()).toBe(1);
});

test("a failed trigger save keeps the edits when the shared draft reloads", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, undefined, {
    saveFailure: "Sandbox storage is unavailable.",
  });
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await page.getByLabel("Trigger name").fill("Not lost");
  await page.getByRole("button", { name: "Save triggers" }).click();
  const reload = page.getByRole("button", { name: "Reload shared draft" });
  await reload.click();
  await expect(reload).toHaveCount(0);
  await expect(page.getByLabel("Trigger name")).toHaveValue("Not lost");
  await expect(page.locator("[data-sandbox-save-state]")).toHaveText(
    /· 1 unsaved trigger change$/,
  );
});

test("deleting a trigger can be undone from its notice", async ({ page }) => {
  const sandbox = await openTriggers(page);
  const list = page.getByRole("navigation", { name: "Trigger list" });
  const name = sandbox.document().triggers[0]!.name;
  await expect(list.getByRole("button", { name })).toBeVisible();

  await page.getByRole("button", { name: "Trigger options" }).click();
  await page.getByRole("menuitem", { name: "Delete trigger" }).click();
  await expect(list.getByRole("button", { name })).toHaveCount(0);
  // The only trigger is gone, so focus lands on New trigger, not the page.
  await expect(page.getByRole("button", { name: "New trigger" })).toBeFocused();
  const notice = page.getByText("Trigger deleted", { exact: true });
  await expect(notice).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(list.getByRole("button", { name })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(list.getByRole("button", { name })).toBeFocused();
  await expect(page.getByText(/unsaved trigger/)).toHaveCount(0);
  expect(sandbox.documentWrites()).toBe(0);
});

test("on a phone, choosing a trigger shows its detail first, with Back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sandbox = await openAuthenticatedSandbox(page);
  await page.goto("/sandbox?section=triggers");
  const list = page.getByRole("navigation", { name: "Trigger list" });
  const name = sandbox.document().triggers[0]!.name;
  await expect(list).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Trigger settings" }),
  ).toBeHidden();

  await list.getByRole("button", { name }).click();
  await expect(list).toBeHidden();
  await expect(page.getByRole("heading", { name, level: 2 })).toBeFocused();
  await expect(
    page.getByRole("region", { name: "Trigger summary" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Flow preview" })).toBeHidden();
  await expect(
    page.getByRole("region", { name: "Trigger settings" }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Back to Triggers", exact: true })
    .click();
  await expect(list.getByRole("button", { name })).toBeFocused();
});
