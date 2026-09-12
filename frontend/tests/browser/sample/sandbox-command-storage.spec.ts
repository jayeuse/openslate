import { expect, test } from "../coverage";
import type { Page } from "@playwright/test";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";

const SAMPLE_STORAGE_KEY = "openslate.sample.v1";
const VIEW_PREFERENCES_KEY = "openslate.sample.sandbox.view.v1";

test.beforeEach(async ({ page }) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: { detail: "Unavailable" } }),
  );
  await page.route("**/bff/**", async (route) => {
    if (!(await fulfillWorkspaceRequest(route)))
      await route.fulfill({ json: { items: [], has_more: false } });
  });
  await page.goto("/sandbox");
});

async function chooseGlobalCreate(page: Page, name: string) {
  await page.getByLabel("Create", { exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

async function cancelDesignerEditor(page: Page) {
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
}

function captureLiveWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/bff/") && request.method() !== "GET")
      writes.push(`${request.method()} ${request.url()}`);
  });
  return writes;
}

test("global Create repeatedly opens every existing creation surface with an always-visible validation summary", async ({
  page,
}) => {
  const liveWrites = captureLiveWrites(page);
  await expect(
    page.getByRole("status", { name: "Sandbox validation summary" }),
  ).toHaveText(/\d+ errors · \d+ warnings/);

  await chooseGlobalCreate(page, "Department");
  await expect(
    page.getByRole("heading", { name: "Create department" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Department name", { exact: true }),
  ).toBeFocused();
  await cancelDesignerEditor(page);

  await chooseGlobalCreate(page, "Department");
  await expect(
    page.getByLabel("Department name", { exact: true }),
  ).toBeFocused();
  await cancelDesignerEditor(page);

  await chooseGlobalCreate(page, "Module");
  await expect(
    page.getByRole("heading", { name: "Create module" }),
  ).toBeVisible();
  await expect(page.getByLabel("Module name", { exact: true })).toBeFocused();
  await expect(
    page
      .getByRole("complementary", { name: "Design inspector" })
      .getByRole("heading", { name: "Operations", exact: true }),
  ).toBeVisible();
  await cancelDesignerEditor(page);

  await chooseGlobalCreate(page, "Field");
  await expect(
    page.getByRole("heading", { name: "Create field" }),
  ).toBeVisible();
  await expect(page.getByLabel("Field name", { exact: true })).toBeFocused();
  await expect(
    page
      .getByRole("complementary", { name: "Design inspector" })
      .getByRole("heading", { name: "Service requests", exact: true }),
  ).toBeVisible();
  await cancelDesignerEditor(page);

  await chooseGlobalCreate(page, "Relationship");
  const relationship = page.getByRole("dialog", { name: "Connect modules" });
  await expect(relationship).toBeVisible();
  await expect(
    relationship.getByLabel("Relationship name", { exact: true }),
  ).toBeFocused();
  await relationship
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  await chooseGlobalCreate(page, "Automation rule");
  await expect(
    page.getByRole("form", { name: "Create automation rule" }),
  ).toBeVisible();
  await expect(page.getByLabel("Rule name", { exact: true })).toBeFocused();
  expect(liveWrites).toEqual([]);
});

test("Reset design is undoable and preserves versions, simulation, and view preferences", async ({
  page,
}) => {
  const liveWrites = captureLiveWrites(page);
  await chooseGlobalCreate(page, "Department");
  await page
    .getByLabel("Department name", { exact: true })
    .fill("Temporary operations");
  await page
    .getByRole("button", { name: "Create department", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create checkpoint", exact: true })
    .click();
  const checkpoint = page.getByRole("dialog", { name: "Create checkpoint" });
  await checkpoint
    .getByLabel("Checkpoint name", { exact: true })
    .fill("Keep this checkpoint");
  await checkpoint
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();

  await page.getByRole("tab", { name: "Simulation", exact: true }).click();
  await page
    .getByRole("button", { name: "Load sample records", exact: true })
    .click();
  await page.evaluate((key) => {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        gridVisible: false,
        snapEnabled: false,
        structureWidth: 320,
        inspectorWidth: 450,
        structureCollapsed: false,
        inspectorCollapsed: false,
        mobilePane: "Canvas",
      }),
    );
  }, VIEW_PREFERENCES_KEY);

  await page.getByRole("button", { name: "Reset design", exact: true }).click();
  const reset = page.getByRole("alertdialog", { name: "Reset design?" });
  await expect(reset).toContainText(
    "replaces only the current Design with the initial sample",
  );
  await expect(reset).toContainText(
    "Versions, Simulation data, and view preferences stay in this tab",
  );
  await reset
    .getByRole("button", { name: "Cancel reset", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reset design", exact: true }),
  ).toBeFocused();
  await page.getByRole("tab", { name: "Designer", exact: true }).click();
  if ((page.viewportSize()?.width ?? 0) < 1280)
    await page.getByRole("tab", { name: "Structure", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Select department Temporary operations",
      exact: true,
    }),
  ).toBeVisible();
  const preservedView = await page.evaluate(
    (key) => sessionStorage.getItem(key),
    VIEW_PREFERENCES_KEY,
  );

  await page.getByRole("button", { name: "Reset design", exact: true }).click();
  await reset
    .getByRole("button", { name: "Reset current design", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Select department Temporary operations",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("status").filter({ hasText: "Undo restores it" }),
  ).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(
        ({ sampleKey, viewKey }) => {
          const sample = JSON.parse(
            sessionStorage.getItem(sampleKey) ?? "{}",
          ) as Record<string, unknown>;
          return {
            versionCount: Array.isArray(sample["sandbox.versions"])
              ? sample["sandbox.versions"].length
              : 0,
            simulationRecords: Array.isArray(
              (
                sample["sandbox.simulation"] as
                  { records?: unknown[] } | undefined
              )?.records,
            )
              ? (sample["sandbox.simulation"] as { records: unknown[] }).records
                  .length
              : 0,
            view: sessionStorage.getItem(viewKey),
          };
        },
        { sampleKey: SAMPLE_STORAGE_KEY, viewKey: VIEW_PREFERENCES_KEY },
      ),
    )
    .toEqual({
      versionCount: 2,
      simulationRecords: 1,
      view: preservedView,
    });

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Select department Temporary operations",
      exact: true,
    }),
  ).toBeVisible();
  expect(liveWrites).toEqual([]);
});

test("Clear Sandbox data removes only Sandbox state and reloads defaults", async ({
  page,
}) => {
  const liveWrites = captureLiveWrites(page);
  await chooseGlobalCreate(page, "Department");
  await page
    .getByLabel("Department name", { exact: true })
    .fill("Discarded department");
  await page
    .getByRole("button", { name: "Create department", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create checkpoint", exact: true })
    .click();
  const checkpoint = page.getByRole("dialog", { name: "Create checkpoint" });
  await checkpoint
    .getByLabel("Checkpoint name", { exact: true })
    .fill("Discarded checkpoint");
  await checkpoint
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  await page.evaluate(
    ({ sampleKey, viewKey }) => {
      const sample = JSON.parse(
        sessionStorage.getItem(sampleKey) ?? "{}",
      ) as Record<string, unknown>;
      sample["unrelated-sample-marker"] = "keep";
      sample["sandbox.simulation"] = {
        records: [
          { id: "temporary-record", moduleId: "sample-requests", values: {} },
        ],
        users: [],
        trace: [],
        runs: [],
      };
      sessionStorage.setItem(sampleKey, JSON.stringify(sample));
      sessionStorage.setItem(
        viewKey,
        JSON.stringify({ gridVisible: false, mobilePane: "Canvas" }),
      );
    },
    { sampleKey: SAMPLE_STORAGE_KEY, viewKey: VIEW_PREFERENCES_KEY },
  );
  await page.reload();

  await page
    .getByRole("button", { name: "Clear Sandbox data", exact: true })
    .click();
  const clear = page.getByRole("alertdialog", {
    name: "Clear Sandbox data?",
  });
  await expect(clear).toContainText(
    "clears the Sandbox Design and undo history, Versions, Simulation data, and Sandbox view preferences in this tab",
  );
  await expect(clear).toContainText(
    "Other sample workspace areas are unchanged",
  );
  await clear
    .getByRole("button", { name: "Cancel clear", exact: true })
    .click();
  await expect(
    page
      .locator("#main-content")
      .getByRole("button", { name: "Clear Sandbox data", exact: true }),
  ).toBeFocused();

  await page
    .locator("#main-content")
    .getByRole("button", { name: "Clear Sandbox data", exact: true })
    .click();
  await clear
    .getByRole("button", { name: "Clear Sandbox data", exact: true })
    .click();

  await expect(
    page.getByRole("button", { name: "Select department Operations" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Select department Discarded department",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(
        ({ sampleKey, viewKey }) => {
          const sample = JSON.parse(
            sessionStorage.getItem(sampleKey) ?? "{}",
          ) as Record<string, unknown>;
          return {
            unrelated: sample["unrelated-sample-marker"],
            hasDesign: "sandbox.design" in sample,
            hasVersions: "sandbox.versions" in sample,
            hasSimulation: "sandbox.simulation" in sample,
            view: sessionStorage.getItem(viewKey),
          };
        },
        { sampleKey: SAMPLE_STORAGE_KEY, viewKey: VIEW_PREFERENCES_KEY },
      ),
    )
    .toEqual({
      unrelated: "keep",
      hasDesign: false,
      hasVersions: false,
      hasSimulation: false,
      view: null,
    });
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Starting structure", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Discarded checkpoint", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Simulation", exact: true }).click();
  await expect(
    page.getByText("No simulation records loaded.", { exact: true }),
  ).toBeVisible();
  expect(liveWrites).toEqual([]);
});
