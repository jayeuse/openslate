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
  const comparison = page.getByRole("region", { name: "Field comparison" });
  // Before the first run, only the outcome says what to do.
  await expect(comparison).toHaveCount(0);
  await setup.getByLabel("Request number", { exact: true }).fill("REQ-001");
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  await expect(comparison).toBeVisible();
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
  await setup.getByLabel("Request number", { exact: true }).fill("REQ-001");
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

// Sandbox relayout Phase 4 (docs/specs/sandbox-relayout.md S11, F3, F12,
// F15): a result shows only for the setup it was run with, the setup shows no
// error before a run, and Run test checks required values first.

const requestNumber = "sample-field-Request number";

function storedRun(
  moduleId: string,
  issues: { code: string; message: string; targetId: string | null }[] = [],
) {
  return {
    id: "00000000-0000-4000-8000-000000000051",
    createdAt: "2026-10-20T09:00:00Z",
    documentRevision: 1,
    input: { moduleId, values: {} },
    event: { kind: "record-created" },
    triggerIds: null,
    result: { values: {}, routes: [], triggerTraces: [], issues },
  };
}

test("a stored result for another module stays hidden until the setup matches it", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    testRuns: [storedRun("sample-equipment")],
  });
  await page.goto("/sandbox?section=test");
  const result = page.getByRole("region", { name: "Test outcome" });
  await expect(
    result.getByText("Run a test to see the result.", { exact: true }),
  ).toBeVisible();
  await expect(result.getByText("Test only · live data unchanged")).toHaveCount(
    0,
  );
  await page
    .getByRole("region", { name: "Test setup", exact: true })
    .getByLabel("Module", { exact: true })
    .selectOption("sample-equipment");
  await expect(
    result.getByText("Test only · live data unchanged"),
  ).toBeVisible();
});

test("the setup shows no error before a run and a failed run's error beside its field", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    testRuns: [
      storedRun("sample-requests", [
        {
          code: "value_required",
          message: "Enter a value for this required field.",
          targetId: requestNumber,
        },
      ]),
    ],
  });
  await page.route("**/api/sandbox/tests", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const request = route.request().postDataJSON() as {
      moduleId: string;
      values: Record<string, unknown>;
      event: unknown;
    };
    await route.fulfill({
      status: 201,
      json: {
        ...storedRun("sample-requests", [
          {
            code: "value_invalid",
            message: "Use letters and numbers only.",
            targetId: requestNumber,
          },
        ]),
        id: "00000000-0000-4000-8000-000000000052",
        input: { moduleId: request.moduleId, values: request.values },
        event: request.event,
      },
    });
  });
  await page.goto("/sandbox?section=test");
  const setup = page.getByRole("region", { name: "Test setup", exact: true });
  const number = setup.getByLabel("Request number", { exact: true });
  // The stored result matches the setup, so it shows; its issue stays in it.
  await expect(
    page.getByRole("heading", { name: "This test needs attention" }),
  ).toBeVisible();
  await expect(number).not.toHaveAttribute("aria-invalid");
  await expect(setup.getByText(/Last test/)).toHaveCount(0);

  await number.fill("R/1");
  await setup.getByRole("button", { name: "Run test", exact: true }).click();
  await expect(number).toHaveAttribute("aria-invalid", "true");
  await expect(number).toHaveAccessibleDescription(
    "Use letters and numbers only.",
  );
});

test("Run test stops at a missing required value, sends nothing, and focuses it", async ({
  page,
}) => {
  const setup = await openTest(page);
  const posts: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/sandbox/tests"
    )
      posts.push(request.url());
  });
  const number = setup.getByLabel("Request number", { exact: true });
  await expect(number).not.toHaveAttribute("aria-invalid");
  await setup.getByRole("button", { name: "Run test", exact: true }).click();
  await expect(number).toBeFocused();
  await expect(number).toHaveAttribute("aria-invalid", "true");
  await expect(number).toHaveAccessibleDescription(
    "Enter a value for this required field.",
  );
  await expect(
    page
      .getByRole("region", { name: "Test outcome" })
      .getByText("Run a test to see the result.", { exact: true }),
  ).toBeVisible();
  expect(posts).toEqual([]);

  await number.fill("R-1");
  await expect(number).not.toHaveAttribute("aria-invalid");
  await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/sandbox/tests",
    ),
    setup.getByRole("button", { name: "Run test", exact: true }).click(),
  ]);
});

test("a matching run shows its steps and its field comparison inside the result", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    testRunEcho: {
      id: "00000000-0000-4000-8000-000000000053",
      createdAt: "2026-10-24T10:00:00Z",
      resultValues: (values) => ({
        ...values,
        "sample-field-Status": "Complete",
      }),
    },
  });
  await page.goto("/sandbox?section=test");
  const setup = page.getByRole("region", { name: "Test setup", exact: true });
  await setup.getByLabel("Request number", { exact: true }).fill("R-1");
  await setup.getByRole("button", { name: "Run test", exact: true }).click();

  const result = page.getByRole("region", { name: "Test outcome" });
  await expect(
    result.getByRole("list", { name: "Steps" }).getByRole("listitem"),
  ).toHaveText([
    /^Input.*Service requests · An item is added/,
    /^Trigger outcomes.*No triggers ran/,
    /^Result.*Status changed/,
  ]);
  const comparison = result.getByRole("region", { name: "Field comparison" });
  await expect(
    comparison.getByRole("button", { name: "Changed (1)" }),
  ).toBeVisible();
  await expect(comparison.getByRole("row", { name: /Status/ })).toContainText(
    "Complete",
  );
  await expect(
    page.getByRole("separator", { name: "Resize field comparison" }),
  ).toHaveCount(0);
});

test("on a phone the Run test bar never covers a control that takes focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const setup = await openTest(page);
  await setup.getByRole("button", { name: /^All \(/ }).click();
  await setup.getByRole("button", { name: /^Advanced/ }).click();
  const run = setup.getByRole("button", { name: "Run test", exact: true });
  // Each control sits below the screen until focus scrolls it in.
  for (const control of [
    setup.getByLabel("Extra field 8", { exact: true }),
    setup.getByLabel("Triggers to run", { exact: true }),
  ]) {
    await setup.getByLabel("Module", { exact: true }).focus();
    await expect(control).not.toBeInViewport();
    await control.focus();
    await expect(run).toBeInViewport();
    const box = (await control.boundingBox())!;
    const bar = (await run.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
  }
  // At the end of the page the bar sits after the setup's last control.
  await page.mouse.wheel(0, 5000);
  const last = setup.getByLabel("Triggers to run", { exact: true });
  await expect(last).toBeInViewport();
  const box = (await last.boundingBox())!;
  const bar = (await run.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
});

test("Inputs changed stays when the setup asks another question and comes back", async ({
  page,
}) => {
  const setup = await openTest(page);
  const number = setup.getByLabel("Request number", { exact: true });
  const when = setup.getByLabel("When", { exact: true });
  const outcome = page.getByRole("region", { name: "Test outcome" });
  await number.fill("A-1");
  await setup.getByRole("button", { name: "Run test", exact: true }).click();
  await expect(
    outcome.getByText("Test only · live data unchanged"),
  ).toBeVisible();
  await number.fill("B-2");
  await expect(
    outcome.getByText("Inputs changed", { exact: true }),
  ).toBeVisible();
  const event = await when.inputValue();
  await when.selectOption("schedule");
  await expect(
    outcome.getByText("Run a test to see the result.", { exact: true }),
  ).toBeVisible();
  await when.selectOption(event);
  await expect(
    outcome.getByText("Inputs changed", { exact: true }),
  ).toBeVisible();
});

test("Run test finds and focuses a required field the search hides", async ({
  page,
}) => {
  const setup = await openTest(page);
  const number = setup.getByLabel("Request number", { exact: true });
  await setup.getByLabel("Find a field").fill("Extra field 1");
  await expect(number).toHaveCount(0);
  await setup.getByRole("button", { name: "Run test", exact: true }).click();
  await expect(number).toBeFocused();
  await expect(number).toHaveAccessibleDescription(
    "Enter a value for this required field.",
  );
});

test("on a phone, Test this instead returns to the setup it changed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    testRuns: [
      {
        ...storedRun("sample-requests"),
        result: {
          values: {},
          routes: [],
          triggerTraces: [
            {
              triggerId: "sample-urgent",
              label: "Urgent request alert",
              outcome: "Not triggered",
            },
          ],
          issues: [],
        },
      },
    ],
  });
  await page.goto("/sandbox?section=test");
  const view = page.getByRole("group", { name: "Test view" });
  await view.getByRole("button", { name: "Result" }).click();
  await page
    .getByRole("button", { name: "Test this instead: Urgent request alert" })
    .click();
  await expect(view.getByRole("button", { name: "Setup" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page
      .getByRole("region", { name: "Test setup", exact: true })
      .getByLabel("Module", { exact: true }),
  ).toBeFocused();
});
