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
      .getByRole("button", { name: "Edit condition 1" }),
  ).toContainText("Status equals In progress");

  await page.getByRole("button", { name: "Save triggers" }).click();
  await expect.poll(sandbox.documentWrites).toBe(1);
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
  await expect(
    page.getByText("1 unsaved trigger change", { exact: true }),
  ).toBeVisible();
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
});

test("leaving with unsaved triggers asks Save, Discard, or Stay", async ({
  page,
}) => {
  const sandbox = await openTriggers(page);
  const build = page.getByRole("link", { name: "Build", exact: true });
  const dialog = page.getByRole("dialog", { name: "Unsaved trigger changes" });

  await page.getByLabel("Trigger name").fill("Stay with me");
  await build.click();
  await expect(dialog).toContainText("1 trigger change not saved yet.");
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

test("deleting a trigger can be undone from its notice", async ({ page }) => {
  const sandbox = await openTriggers(page);
  const list = page.getByRole("navigation", { name: "Trigger list" });
  const name = sandbox.document().triggers[0]!.name;
  await expect(list.getByRole("button", { name })).toBeVisible();

  await page.getByRole("button", { name: "Trigger options" }).click();
  await page.getByRole("menuitem", { name: "Delete trigger" }).click();
  await expect(list.getByRole("button", { name })).toHaveCount(0);
  const notice = page.getByText("Trigger deleted", { exact: true });
  await expect(notice).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(list.getByRole("button", { name })).toHaveAttribute(
    "aria-current",
    "true",
  );
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

  await page.getByRole("button", { name: "Triggers", exact: true }).click();
  await expect(list.getByRole("button", { name })).toBeFocused();
});
