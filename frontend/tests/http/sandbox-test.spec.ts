import { expect, test, type Page } from "./helpers/test";
import { openAuthenticatedSandbox } from "./helpers/sandbox-api";
import {
  initialDesign,
  type Design,
} from "../../src/components/systems/sandbox/domain/model";
import { configuredSandboxDesign } from "../helpers/sandbox-fixtures";

// Phase 5 of the Sandbox UI/UX pass (docs/specs/sandbox-ui-ux-pass.md):
// TST-1 to TST-4.

function designWithManyFields(): Design {
  const design = structuredClone(configuredSandboxDesign);
  for (let index = 1; index <= 24; index++)
    design.modules[0]!.fields.push({
      id: `extra-${index}`,
      name: `Extra field ${index}`,
      type: "Text",
      required: false,
      value: "",
      options: "",
      closed: false,
    });
  return design;
}

async function openTest(page: Page, design: Design = designWithManyFields()) {
  await openAuthenticatedSandbox(page, design, {
    testRunEcho: {
      id: "00000000-0000-4000-8000-000000000031",
      createdAt: "2026-10-18T10:00:00Z",
      resultValues: (values) => values,
    },
  });
  await page.goto("/sandbox?section=test");
  return page.getByRole("region", { name: "Test setup", exact: true });
}

test("Run test stays in view while the setup scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const setup = await openTest(page);
  await setup.getByRole("button", { name: /^All \(/ }).click();
  await setup
    .getByLabel("Extra field 1", { exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Run test", exact: true }),
  ).toBeInViewport();
  await setup.getByRole("button", { name: "Show more fields" }).click();
  await setup
    .getByLabel("Extra field 20", { exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Run test", exact: true }),
  ).toBeInViewport();
});

test("editing an input marks the shown result stale at once", async ({
  page,
}) => {
  const setup = await openTest(page);
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  const outcome = page.getByRole("region", { name: "Test outcome" });
  await expect(
    outcome.getByRole("heading", { name: "Test result" }),
  ).toBeVisible();
  await expect(outcome.getByText("Inputs changed")).toHaveCount(0);
  await expect(
    outcome.getByText("Test only · live data unchanged"),
  ).toBeVisible();

  await setup.getByLabel("Request number", { exact: true }).fill("CHANGED-001");
  await expect(
    outcome.getByText("Inputs changed", { exact: true }),
  ).toBeVisible();
  await outcome.getByRole("button", { name: "Run again" }).click();
  await expect(outcome.getByText("Inputs changed")).toHaveCount(0);
});

test("on a phone, a run moves to the result and focuses it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const setup = await openTest(page);
  const view = page.getByRole("group", { name: "Test view" });
  await expect(view.getByRole("button", { name: "Setup" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("region", { name: "Test outcome" })).toBeHidden();
  await setup.getByRole("button", { name: "Run test", exact: true }).click();
  await expect(view.getByRole("button", { name: "Result" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(setup).toBeHidden();
  // The outcome headline takes focus, so the outcome is read first.
  await expect(page.getByRole("heading", { level: 4 }).first()).toBeFocused();
});

test("Run test without a module says why it is unavailable", async ({
  page,
}) => {
  await openTest(page, initialDesign);
  const run = page.getByRole("button", { name: "Run test", exact: true });
  await expect(run).toHaveAttribute("aria-disabled", "true");
  await expect(run).toHaveAccessibleDescription("Add a module first.");
});
