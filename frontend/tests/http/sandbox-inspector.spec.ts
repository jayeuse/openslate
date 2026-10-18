import { expect, expectNoPageScroll, test } from "./helpers/test";
import {
  fieldRowTrigger,
  openAuthenticatedSandbox,
} from "./helpers/sandbox-api";
import {
  configuredSandboxDesign,
  overlappingSandboxDesign,
} from "../helpers/sandbox-fixtures";

// The Advanced Last Rule (DESIGN.md): Properties shows the essentials, keeps
// rare and lifecycle controls in one closed Advanced block, counts what is
// set inside it, and remembers the viewer's choice.
test("a module panel shows its essentials first and remembers Advanced", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  design.modules[0]!.titleFieldId = "sample-field-Title";
  await openAuthenticatedSandbox(page, design);
  await page.goto("/sandbox?module=sample-requests");
  const inspector = page.getByRole("complementary", {
    name: "Design inspector",
  });
  await expect(
    inspector.getByRole("heading", { name: "Service requests", level: 2 }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("heading", { name: "Fields 4", exact: true }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("heading", { name: "Relationships 1", exact: true }),
  ).toBeVisible();
  const advanced = inspector.getByRole("button", { name: /^Advanced/ });
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await expect(advanced).toHaveText("Advanced · 1 set");
  await expect(
    inspector.getByRole("button", { name: "Close module", exact: true }),
  ).toBeHidden();

  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(advanced).toHaveText("Advanced");
  await expect(
    inspector.getByLabel("Title field", { exact: true }),
  ).toHaveValue("sample-field-Title");
  await page.reload();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(
    inspector.getByRole("button", { name: "Close module", exact: true }),
  ).toBeVisible();

  await advanced.click();
  await page.reload();
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
});

test("Delete is reachable from Properties for a module and a field", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page);
  await page.goto("/sandbox?module=sample-requests");
  const inspector = page.getByRole("complementary", {
    name: "Design inspector",
  });
  await inspector.getByRole("button", { name: /^Advanced/ }).click();
  await inspector
    .getByRole("button", { name: "Delete module", exact: true })
    .click();
  const deletion = page.getByRole("alertdialog");
  await expect(deletion).toContainText("Service requests");
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deletion).toBeHidden();

  const field = inspector.getByRole("group", {
    name: "Priority field settings",
    exact: true,
  });
  await fieldRowTrigger(field, "Priority").click();
  await field.getByRole("button", { name: /^Advanced/ }).click();
  await field
    .getByRole("button", { name: "Delete field", exact: true })
    .click();
  await expect(deletion).toContainText("Priority");
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deletion).toBeHidden();
});

test("collapsing a field row keeps its unsaved edit and says so", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page);
  await page.goto("/sandbox?module=sample-requests");
  const field = page.getByRole("group", {
    name: "Priority field settings",
    exact: true,
  });
  await fieldRowTrigger(field, "Priority").click();
  await field
    .getByLabel("Priority field type", { exact: true })
    .selectOption("Long text");
  const header = field.getByRole("button", { name: /^Priority\b/ });
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(field.getByText("Unsaved", { exact: true })).toBeVisible();

  await header.click();
  await expect(
    field.getByLabel("Priority field type", { exact: true }),
  ).toHaveValue("Long text");
  await field.getByRole("button", { name: "Save field changes" }).click();
  await expect.poll(sandbox.documentWrites).toBe(1);
  await expect(header).toHaveAccessibleName("Priority Long text");
  await expect(field.getByText("Unsaved", { exact: true })).toBeHidden();
});

// On desktop, pages fill the viewport and never scroll; their panels do
// (DESIGN.md). Screen-reader text inside a panel once stretched the page past
// it. Phones and tablets scroll the page, so they are not checked here.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`the Build page does not scroll at ${viewport.width}px with everything open`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      for (const panel of ["module", "field"])
        window.localStorage.setItem(
          `openslate:advanced:sandbox.${panel}`,
          "open",
        );
    });
    await openAuthenticatedSandbox(page);
    await page.goto("/sandbox?module=sample-requests");
    const field = page.getByRole("group", {
      name: "Status field settings",
      exact: true,
    });
    await fieldRowTrigger(field, "Status").click();
    await expect(
      field.getByLabel("Status description", { exact: true }),
    ).toBeVisible();
    await expectNoPageScroll(page);

    for (const section of ["Triggers", "Test", "History"]) {
      await page.goto(`/sandbox?section=${section.toLowerCase()}`);
      await expect(
        page.getByRole("heading", { name: "Sandbox", level: 1 }),
      ).toBeVisible();
      await expectNoPageScroll(page);
    }
  });
}

// Phase 3 of the Sandbox follow-up pass: overlap notice (F2, O2).
test("overlapping frames show a notice that Auto-arrange clears and Undo brings back", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(
    page,
    overlappingSandboxDesign,
  );
  const notice = page
    .getByRole("status")
    .filter({ hasText: "Some departments or modules overlap." });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Auto-arrange" }).click();
  await expect(notice).toHaveCount(0);
  await expect.poll(sandbox.documentWrites).toBe(1);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
});
