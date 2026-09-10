import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
import { expect, test } from "../coverage";
import {
  DEPARTMENT_ID,
  SOURCE_MODULE_ID,
  makeState,
  baseEntity,
} from "../helpers/relationships-data";
import { installMocks, fulfill } from "../helpers/relationships-fixtures";

test("retries an initial department detail error before rendering empty and mutation states", async ({
  page,
}) => {
  const departmentId = "11111111-1111-4111-8111-111111111111";
  const departmentName = "Operations";
  let departmentAttempts = 0;
  let allowDepartmentSuccess = false;
  const listResponse = {
    items: [],
    pagination: {
      limit: 100,
      offset: 0,
      count: 0,
      total: 0,
      has_more: false,
    },
  };

  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/bff/**", async (route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    const path = new URL(route.request().url()).pathname.replace(/^\/bff/, "");
    if (path === `/departments/${departmentId}`) {
      departmentAttempts += 1;
      if (!allowDepartmentSuccess) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "Department is temporarily unavailable",
          }),
        });
        return;
      }
      await route.fulfill({
        json: {
          id: departmentId,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          deleted_at: null,
          is_deleted: false,
          performed_by: null,
          department_name: departmentName,
        },
      });
      return;
    }
    if (path === "/modules") {
      await route.fulfill({ json: listResponse });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "Not found" } });
  });

  await page.goto(`/departments/${departmentId}`);
  await expect(page.getByRole("status")).toContainText(
    "Department is temporarily unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
  await expect(page.getByText("No modules yet", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Module name", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create module", exact: true }),
  ).toHaveCount(0);

  allowDepartmentSuccess = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: departmentName, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No modules yet. Use the form to create the first one.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Module name", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Department is temporarily unavailable" }),
  ).toHaveCount(0);
  expect(departmentAttempts).toBeGreaterThanOrEqual(2);
});

test("module detail retries a failed load before showing empty schema guidance and scoped links", async ({
  page,
}) => {
  const state = makeState();
  const moduleItem = state.modules.find(
    (item) => item.id === SOURCE_MODULE_ID,
  )!;
  moduleItem.is_schema_accepted = false;
  state.fields = [];
  await installMocks(page, state);
  let available = false;
  await page.route(`**/bff/modules/${SOURCE_MODULE_ID}`, async (route) => {
    if (available) return route.fallback();
    await fulfill(route, 503, { detail: "Module is temporarily unavailable" });
  });
  await page.goto(`/modules/${SOURCE_MODULE_ID}`);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Module is temporarily unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open schema builder" }),
  ).toHaveCount(0);
  available = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: moduleItem.module_name,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Add at least one field, then accept the schema before adding records.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Records blocked", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open schema builder", exact: true }),
  ).toHaveAttribute(
    "href",
    `/departments/${DEPARTMENT_ID}/modules/${SOURCE_MODULE_ID}/schema`,
  );
  await expect(
    page.getByRole("link", { name: "Open records", exact: true }),
  ).toHaveAttribute(
    "href",
    `/departments/${DEPARTMENT_ID}/modules/${SOURCE_MODULE_ID}/records`,
  );
  await expect(
    page.getByRole("link", { name: "Back", exact: true }),
  ).toHaveAttribute("href", `/departments/${DEPARTMENT_ID}`);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toHaveCount(0);
});

test("module detail becomes ready for records after accepting its populated schema", async ({
  page,
}) => {
  const state = makeState();
  state.modules.find(
    (item) => item.id === SOURCE_MODULE_ID,
  )!.is_schema_accepted = false;
  await installMocks(page, state);
  await page.goto(`/modules/${SOURCE_MODULE_ID}`);
  await expect(
    page.getByText("Accept the schema before adding records.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Open schema builder", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(
      `/departments/${DEPARTMENT_ID}/modules/${SOURCE_MODULE_ID}/schema$`,
    ),
  );
  await page
    .getByRole("button", { name: "Accept Schema", exact: true })
    .click();
  await expect(
    page.getByText("Schema is accepted", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back to module", exact: true }).click();
  await expect(
    page.getByText("Ready for records", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Schema accepted", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open records", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `/departments/${DEPARTMENT_ID}/modules/${SOURCE_MODULE_ID}/records$`,
    ),
  );
  await expect(
    page.getByRole("link", { name: "Add record", exact: true }),
  ).toHaveAttribute(
    "href",
    `/departments/${DEPARTMENT_ID}/modules/${SOURCE_MODULE_ID}/records/new`,
  );
});

test("a closed parent disables module schema changes while keeping record review available", async ({
  page,
}) => {
  const state = makeState();
  await installMocks(page, state);
  await page.route(`**/bff/departments/${DEPARTMENT_ID}`, (route) =>
    fulfill(route, 200, {
      ...baseEntity(DEPARTMENT_ID, true),
      department_name: "Operations",
    }),
  );
  await page.goto(`/modules/${SOURCE_MODULE_ID}`);
  await expect(
    page.getByRole("button", {
      name: "Schema changes disabled while closed",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "Open schema builder", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Open records", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `/departments/${DEPARTMENT_ID}/modules/${SOURCE_MODULE_ID}/records$`,
    ),
  );
  await expect(
    page.getByRole("button", { name: "Add record", exact: true }),
  ).toBeDisabled();
});
