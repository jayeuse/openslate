import { expect, test } from "../coverage";
import type { Page } from "@playwright/test";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
import { initialSandboxHistory } from "../../../src/components/sample/sandbox/model";

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

async function seedNavigationIssues(page: Page) {
  const history = structuredClone(initialSandboxHistory);
  for (const sandboxModule of history.present.modules.slice(0, 2))
    sandboxModule.fields.find(
      (field) => field.id === "sample-field-Status",
    )!.type = "Unsupported";
  history.present.modules.find(
    (item) => item.id === "sample-equipment",
  )!.department = "missing-department";
  history.present.relationships[0].cardinality = "Invalid";
  history.present.rules[0].name = "";
  await page.addInitScript(
    ({ key, value }) => {
      sessionStorage.setItem(key, JSON.stringify({ "sandbox.design": value }));
    },
    { key: SAMPLE_STORAGE_KEY, value: history },
  );
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const sample = JSON.parse(sessionStorage.getItem(key) ?? "{}") as {
          "sandbox.design"?: {
            present?: {
              modules?: Array<{
                fields?: Array<{ id: string; type: string }>;
              }>;
            };
          };
        };
        return sample["sandbox.design"]?.present?.modules
          ?.slice(0, 2)
          .map(
            (item) =>
              item.fields?.find((field) => field.id === "sample-field-Status")
                ?.type,
          );
      }, SAMPLE_STORAGE_KEY),
    )
    .toEqual(["Unsupported", "Unsupported"]);
}

test("validation issues route exact authoring targets and preserve the rule URL contract @extended", async ({
  page,
}) => {
  await seedNavigationIssues(page);
  await page
    .getByRole("button", { name: "Field type is unsupported", exact: true })
    .nth(1)
    .click();
  await expect(page).toHaveURL(
    /\/sandbox\?inspect=sample-field%3Asample-equipment%3Asample-field-Status/,
  );
  await expect(
    page.getByRole("complementary", { name: "Design inspector" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Equipment", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Status name", { exact: true })).toBeFocused();

  await page
    .getByRole("button", {
      name: "Relationship cardinality is invalid",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/sandbox\?inspect=sample-uses/);
  await expect(
    page.getByRole("dialog", { name: "Relationship settings" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Relationship name", { exact: true }),
  ).toBeFocused();
  await page
    .getByRole("dialog", { name: "Relationship settings" })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  await page
    .getByRole("button", {
      name: "Module department does not exist",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/sandbox\?inspect=sample-equipment/);
  await expect(
    page.getByRole("button", { name: "Rename module", exact: true }),
  ).toBeFocused();

  await page
    .getByRole("button", { name: "Name is required", exact: true })
    .click();
  await expect(page).toHaveURL(/\/sandbox\?rule=sample-urgent/);
  await expect(
    page.getByRole("tab", { name: "Automation", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("entity deletion names the target, reports retained-reference impact, restores focus, and stays one undo step @extended", async ({
  page,
}) => {
  const structure = page.getByRole("complementary", {
    name: "Organization structure",
  });
  const departmentRow = structure.getByRole("button", {
    name: "Select department Operations",
    exact: true,
  });
  await departmentRow.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete department", exact: true })
    .click();
  const departmentDialog = page.getByRole("alertdialog", {
    name: "Delete department Operations?",
  });
  await expect(departmentDialog).toContainText(
    "2 modules, 8 fields, 1 relationship, and 2 automation rule references",
  );
  await expect(departmentDialog).toContainText(
    "Automation rules are retained and may become invalid",
  );
  await departmentDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(departmentRow).toBeFocused();

  const fieldRow = structure.getByRole("button", {
    name: "Select field Priority",
    exact: true,
  });
  await fieldRow.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete field", exact: true })
    .click();
  const fieldDialog = page.getByRole("alertdialog", {
    name: "Delete field Priority?",
  });
  await expect(fieldDialog).toContainText("1 automation rule reference");
  await fieldDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(fieldRow).toBeFocused();

  await structure
    .getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete module", exact: true })
    .click();
  const moduleDialog = page.getByRole("alertdialog", {
    name: "Delete module Service requests?",
  });
  await expect(moduleDialog).toContainText(
    "4 fields, 1 relationship, and 2 automation rule references",
  );
  await moduleDialog
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(
    structure.getByRole("button", {
      name: "Select department Operations",
      exact: true,
    }),
  ).toBeFocused();
  await expect(page.getByText(/Tab-local draft/)).toContainText(
    "1 undo steps available",
  );
  await expect(
    structure.getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    structure.getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    }),
  ).toBeVisible();

  const relationshipDelete = structure.getByRole("button", {
    name: "Delete relationship Uses equipment",
    exact: true,
  });
  await relationshipDelete.click();
  await expect(
    page.getByRole("alertdialog", {
      name: "Delete relationship Uses equipment?",
    }),
  ).toContainText("Undo restores the complete change");
});

test("Clear Sandbox data offers one in-memory recovery while storage stays cleared @extended", async ({
  page,
}) => {
  await page.getByLabel("Create", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Department", exact: true }).click();
  await page
    .getByLabel("Department name", { exact: true })
    .fill("Recoverable department");
  await page
    .getByRole("button", { name: "Create department", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create checkpoint", exact: true })
    .click();
  await page
    .getByLabel("Checkpoint name", { exact: true })
    .fill("Recoverable checkpoint");
  await page
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
          { id: "recover-me", moduleId: "sample-requests", values: {} },
        ],
        users: [],
        trace: [],
        runs: [],
      };
      sessionStorage.setItem(sampleKey, JSON.stringify(sample));
      sessionStorage.setItem(
        viewKey,
        JSON.stringify({
          gridVisible: false,
          snapEnabled: false,
          structureWidth: 320,
          inspectorWidth: 450,
          structureCollapsed: false,
          inspectorCollapsed: false,
          mobilePane: "Structure",
        }),
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
  await expect(clear).toContainText("Recovery is available until reload");
  await clear
    .getByRole("button", { name: "Clear Sandbox data", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Undo clear" })).toBeVisible();
  expect(
    await page.evaluate(
      ({ sampleKey, viewKey }) => {
        const sample = JSON.parse(
          sessionStorage.getItem(sampleKey) ?? "{}",
        ) as Record<string, unknown>;
        return {
          unrelated: sample["unrelated-sample-marker"],
          design: "sandbox.design" in sample,
          versions: "sandbox.versions" in sample,
          simulation: "sandbox.simulation" in sample,
          view: sessionStorage.getItem(viewKey),
        };
      },
      { sampleKey: SAMPLE_STORAGE_KEY, viewKey: VIEW_PREFERENCES_KEY },
    ),
  ).toEqual({
    unrelated: "keep",
    design: false,
    versions: false,
    simulation: false,
    view: null,
  });

  await page.getByRole("button", { name: "Undo clear" }).click();
  await expect(
    page.getByRole("button", {
      name: "Select department Recoverable department",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/Tab-local draft/)).toContainText(
    "1 undo steps available",
  );
  await expect(page.getByRole("button", { name: "Undo clear" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await expect(
    page.getByRole("article", {
      name: "Recoverable checkpoint",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Simulation", exact: true }).click();
  await expect(
    page.getByText("No simulation records loaded.", { exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        ({ sampleKey, viewKey }) => {
          const sample = JSON.parse(
            sessionStorage.getItem(sampleKey) ?? "{}",
          ) as Record<string, unknown>;
          return {
            recordIds: (
              sample["sandbox.simulation"] as {
                records?: Array<{ id: string }>;
              }
            )?.records?.map((record) => record.id),
            view: JSON.parse(
              sessionStorage.getItem(viewKey) ?? "null",
            ) as unknown,
          };
        },
        { sampleKey: SAMPLE_STORAGE_KEY, viewKey: VIEW_PREFERENCES_KEY },
      ),
    )
    .toEqual({
      recordIds: ["recover-me"],
      view: {
        gridVisible: false,
        snapEnabled: false,
        structureWidth: 320,
        inspectorWidth: 450,
        structureCollapsed: false,
        inspectorCollapsed: false,
        mobilePane: "Structure",
      },
    });

  await page
    .getByRole("button", { name: "Clear Sandbox data", exact: true })
    .click();
  await page
    .getByRole("alertdialog", { name: "Clear Sandbox data?" })
    .getByRole("button", { name: "Clear Sandbox data", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Undo clear" })).toBeVisible();
  await page.getByLabel("Create", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Department", exact: true }).click();
  await page
    .getByLabel("Department name", { exact: true })
    .fill("New material change");
  await page
    .getByRole("button", { name: "Create department", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Undo clear" })).toHaveCount(0);
});

test("a view-preference change expires Clear Sandbox recovery @extended", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Clear Sandbox data", exact: true })
    .click();
  await page
    .getByRole("alertdialog", { name: "Clear Sandbox data?" })
    .getByRole("button", { name: "Clear Sandbox data", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Undo clear" })).toBeVisible();

  if ((page.viewportSize()?.width ?? 0) < 1280) {
    await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  } else {
    await page
      .getByRole("button", { name: "View canvas", exact: true })
      .click();
    await page.getByRole("menuitemcheckbox", { name: /Grid/ }).click();
  }

  await expect(page.getByRole("button", { name: "Undo clear" })).toHaveCount(0);
});

test("mobile command, dialog, workflow, and field controls meet touch sizing @extended", async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1280, "Mobile contract");
  const expectTouchHeight = async (locator: ReturnType<Page["getByRole"]>) => {
    const box = await locator.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  };

  await expectTouchHeight(
    page.getByRole("button", { name: "Create", exact: true }),
  );
  await page
    .getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    })
    .click({ button: "right" });
  await expectTouchHeight(
    page.getByRole("menuitem", { name: "Rename module", exact: true }),
  );
  await page.keyboard.press("Escape");

  await page
    .getByRole("button", { name: "Import or export", exact: true })
    .click();
  const checkboxLabel = page.locator("label").filter({
    hasText: "Include checkpoints and local releases",
  });
  await expectTouchHeight(checkboxLabel);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Reset design", exact: true }).click();
  const resetDialog = page.getByRole("alertdialog", {
    name: "Reset design?",
  });
  await expectTouchHeight(
    resetDialog.getByRole("button", { name: "Cancel reset", exact: true }),
  );
  await resetDialog
    .getByRole("button", { name: "Cancel reset", exact: true })
    .click();

  await page.getByRole("tab", { name: "Automation", exact: true }).click();
  await page.getByRole("button", { name: "Edit rule", exact: true }).click();
  await expectTouchHeight(page.getByLabel("Trigger", { exact: true }));
  await expectTouchHeight(
    page.getByRole("button", { name: "Save changes", exact: true }),
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("tab", { name: "Designer", exact: true }).click();
  await page.getByRole("tab", { name: "Structure", exact: true }).click();
  await page
    .getByRole("button", { name: "Select field Status", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Inspect selected", exact: true })
    .click();
  await expectTouchHeight(page.getByLabel("Status name", { exact: true }));
});

test("Structure bulk disclosure preserves search state and mobile controls meet touch sizing without overflow @extended", async ({
  page,
}) => {
  const structure = page.getByRole("complementary", {
    name: "Organization structure",
  });
  await structure
    .getByRole("button", { name: "Collapse all", exact: true })
    .click();
  await expect(
    structure.getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    }),
  ).toHaveCount(0);
  const search = structure.getByRole("searchbox", {
    name: "Search structure",
  });
  await search.fill("Status");
  await expect(
    structure.getByRole("button", {
      name: "Select field Status",
      exact: true,
    }),
  ).toHaveCount(3);
  await search.fill("");
  await expect(
    structure.getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    }),
  ).toHaveCount(0);
  await structure
    .getByRole("button", { name: "Expand all", exact: true })
    .click();
  await expect(
    structure.getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    }),
  ).toBeVisible();

  if ((page.viewportSize()?.width ?? 0) < 1280) {
    const targets = [
      structure.getByRole("button", {
        name: "Collapse department Operations",
      }),
      structure.getByRole("button", {
        name: "Select module Service requests",
      }),
      search,
      structure.getByRole("button", {
        name: "Add field to Service requests",
      }),
    ];
    for (const target of targets) {
      const box = await target.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
});

test("Canvas help documents every supported direct manipulation and keyboard path @extended", async ({
  page,
}) => {
  if ((page.viewportSize()?.width ?? 0) < 1280)
    await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  await page.getByRole("button", { name: "View canvas", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Canvas help", exact: true })
    .click();
  const help = page.getByRole("region", { name: "Canvas controls" });
  await expect(help).toContainText("Drag modules between departments");
  await expect(help).toContainText("relationship ports");
  await expect(help).toContainText("Undo and Redo");
  await expect(help).toContainText("Arrow keys to move it by the snap grid");
  await expect(help).toContainText("resize handle");
  await expect(help).toContainText("Hold Ctrl or Command");
  await expect(help).toContainText("Hold Alt or Option");
  await expect(help).toContainText("F2");
});
