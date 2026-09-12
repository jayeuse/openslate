import { expect, test } from "../coverage";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";

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

test("structure row context menus expose entity actions without crowded action buttons", async ({
  page,
}) => {
  const structure = page.getByRole("complementary", {
    name: "Organization structure",
  });
  await structure
    .getByRole("button", { name: "Collapse department Operations" })
    .click();
  await expect(
    structure.getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    }),
  ).toHaveCount(0);

  await structure
    .getByRole("button", { name: "Jump to selection", exact: true })
    .click();
  const selected = structure.getByRole("button", {
    name: "Select module Service requests",
    exact: true,
  });
  await expect(selected).toBeVisible();
  await expect(selected).toBeFocused();

  await expect(
    structure.getByRole("button", { name: /^Actions for / }),
  ).toHaveCount(0);

  await selected.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "Rename module", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Close module", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Duplicate module", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Delete module", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(selected).toBeFocused();

  await selected.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Close module", exact: true })
    .click();
  await expect(selected).toContainText("Closed");
  await page.getByRole("button", { name: "Undo", exact: true }).click();

  await selected.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Rename module", exact: true })
    .click();
  const rename = structure.getByLabel("Edit module name", { exact: true });
  await expect(rename).toBeFocused();
  await rename.press("Escape");
});

test("department duplication deeply clones children with unique ids and copy names", async ({
  page,
}) => {
  const history = page.getByText(/Tab-local draft/);
  const structure = page.getByRole("complementary", {
    name: "Organization structure",
  });
  const duplicateOperations = async () => {
    await structure
      .getByRole("button", {
        name: "Select department Operations",
        exact: true,
      })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Duplicate department", exact: true })
      .click();
  };

  await duplicateOperations();
  await expect(history).toContainText("1 undo steps available");
  await expect(
    structure.getByRole("button", {
      name: "Select department Operations Copy",
      exact: true,
    }),
  ).toBeVisible();
  await duplicateOperations();
  await expect(history).toContainText("2 undo steps available");
  await expect(
    structure.getByRole("button", {
      name: "Select department Operations Copy 2",
      exact: true,
    }),
  ).toBeVisible();

  const snapshot = await page.evaluate(() => {
    const stored = JSON.parse(
      sessionStorage.getItem("openslate.sample.v1") ?? "{}",
    ) as Record<string, unknown>;
    const history = stored["sandbox.design"] as {
      present: {
        departments: Array<{ id: string; name: string }>;
        modules: Array<{
          id: string;
          department: string;
          fields: Array<{ id: string }>;
        }>;
        relationships: Array<{ source: string; target: string }>;
        rules: Array<{ id: string }>;
      };
    };
    return history.present;
  });
  const copiedDepartmentIds = new Set(
    snapshot.departments
      .filter((item) => item.name.startsWith("Operations Copy"))
      .map((item) => item.id),
  );
  const copiedModules = snapshot.modules.filter((item) =>
    copiedDepartmentIds.has(item.department),
  );
  const copiedIds = [
    ...copiedDepartmentIds,
    ...copiedModules.map((item) => item.id),
    ...copiedModules.flatMap((item) => item.fields.map((field) => field.id)),
  ];
  const originalIds = new Set([
    ...snapshot.departments
      .filter((item) => !copiedDepartmentIds.has(item.id))
      .map((item) => item.id),
    ...snapshot.modules
      .filter((item) => !copiedDepartmentIds.has(item.department))
      .flatMap((item) => [item.id, ...item.fields.map((field) => field.id)]),
  ]);
  expect(new Set(copiedIds).size).toBe(copiedIds.length);
  expect(copiedIds.every((id) => !originalIds.has(id))).toBe(true);
  const moduleIds = new Set(snapshot.modules.map((item) => item.id));
  expect(
    snapshot.relationships.every(
      (item) => moduleIds.has(item.source) && moduleIds.has(item.target),
    ),
  ).toBe(true);
  expect(snapshot.relationships).toHaveLength(1);
  expect(snapshot.rules).toHaveLength(1);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    structure.getByRole("button", {
      name: "Select department Operations Copy 2",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(history).toContainText("1 undo steps available");
});

test("module and field duplication clone field configuration in one undo step each", async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1280, "Desktop contract");
  const history = page.getByText(/Tab-local draft/);
  const structure = page.getByRole("complementary", {
    name: "Organization structure",
  });

  await structure
    .getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Duplicate module", exact: true })
    .click();
  await expect(history).toContainText("1 undo steps available");
  const copiedModule = structure
    .getByTestId("inspector-outline-module")
    .filter({
      has: page.getByRole("button", {
        name: "Select module Service requests Copy",
        exact: true,
      }),
    });
  await expect(
    copiedModule.getByRole("button", {
      name: "Select field Status",
      exact: true,
    }),
  ).toBeVisible();
  const moduleCloneIds = await page.evaluate(() => {
    const stored = JSON.parse(
      sessionStorage.getItem("openslate.sample.v1") ?? "{}",
    ) as Record<string, unknown>;
    const present = (
      stored["sandbox.design"] as {
        present: {
          modules: Array<{
            id: string;
            name: string;
            fields: Array<{ id: string }>;
          }>;
        };
      }
    ).present;
    const original = present.modules.find(
      (item) => item.name === "Service requests",
    );
    const copy = present.modules.find(
      (item) => item.name === "Service requests Copy",
    );
    return { original, copy };
  });
  expect(moduleCloneIds.copy?.id).not.toBe(moduleCloneIds.original?.id);
  expect(
    moduleCloneIds.copy?.fields.every(
      (field) =>
        !moduleCloneIds.original?.fields.some(
          (original) => original.id === field.id,
        ),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(copiedModule).toHaveCount(0);

  const originalModule = structure
    .getByTestId("inspector-outline-module")
    .filter({
      has: page.getByRole("button", {
        name: "Select module Service requests",
        exact: true,
      }),
    });
  await originalModule
    .getByRole("button", { name: "Select field Status", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Duplicate field", exact: true })
    .click();
  await expect(history).toContainText("1 undo steps available");
  await expect(
    originalModule.getByRole("button", {
      name: "Select field Status Copy",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Status Copy options", { exact: true }),
  ).toHaveValue("Open, In progress, Complete");
  const fieldIds = await page.evaluate(() => {
    const stored = JSON.parse(
      sessionStorage.getItem("openslate.sample.v1") ?? "{}",
    ) as Record<string, unknown>;
    const modules = (
      stored["sandbox.design"] as {
        present: {
          modules: Array<{
            name: string;
            fields: Array<{ id: string; name: string }>;
          }>;
        };
      }
    ).present.modules;
    return modules
      .find((item) => item.name === "Service requests")
      ?.fields.filter((item) => item.name.startsWith("Status"));
  });
  expect(fieldIds).toHaveLength(2);
  expect(new Set(fieldIds?.map((item) => item.id)).size).toBe(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    originalModule.getByRole("button", {
      name: "Select field Status Copy",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("Designer shortcuts have visible equivalents and ignore editable or dialog targets", async ({
  page,
}) => {
  const structure = page.getByRole("complementary", {
    name: "Organization structure",
  });
  const search = structure.getByRole("searchbox", { name: "Search structure" });
  await search.focus();
  await search.press("0");
  await expect(search).toHaveValue("0");
  await search.press("?");
  await expect(search).toHaveValue("0?");
  await expect(
    page.getByRole("heading", { name: "Canvas controls", exact: true }),
  ).toHaveCount(0);
  await search.press("Delete");
  await expect(
    page.getByRole("alertdialog", { name: /Delete sample/ }),
  ).toHaveCount(0);

  await search.fill("");
  await search.evaluate((element) => element.blur());
  await page.keyboard.press("?");
  await expect(
    page.getByRole("heading", { name: "Canvas controls", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("0");
  await expect(
    page.getByRole("status", { name: "Canvas action", exact: true }),
  ).toHaveText("Canvas fitted.");
  await page.keyboard.press("Delete");
  const dialog = page.getByRole("alertdialog", {
    name: "Delete module Service requests?",
  });
  await expect(dialog).toBeVisible();
  await dialog.press("Delete");
  await expect(dialog).toBeVisible();
});
