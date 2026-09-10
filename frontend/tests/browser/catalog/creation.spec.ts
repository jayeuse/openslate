import { expect, test } from "../coverage";
import {
  baseEntity,
  DEPARTMENT_ID,
  SOURCE_MODULE_ID,
  makeState,
  moduleFixture,
} from "../helpers/relationships-data";
import {
  fulfill,
  installMocks,
  listResponse,
  requestBody,
} from "../helpers/relationships-fixtures";

test("department list recovers and filters archived departments without losing navigation", async ({
  page,
}) => {
  await installMocks(page, makeState());
  let available = false;
  const departments = [
    { ...baseEntity(DEPARTMENT_ID), department_name: "Operations" },
    {
      ...baseEntity("22222222-2222-4222-8222-222222222222", true),
      department_name: "Archived support",
    },
  ];
  const requests: URL[] = [];
  await page.route("**/bff/departments?*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (!available)
      return fulfill(route, 503, {
        detail: "Departments temporarily unavailable",
      });
    const search = url.searchParams.get("search") ?? "";
    const items = departments.filter(
      (item) =>
        item.department_name.toLowerCase().includes(search.toLowerCase()) &&
        (url.searchParams.get("deleted") !== "exclude" || !item.is_deleted),
    );
    await fulfill(route, 200, listResponse(items));
  });
  await page.goto("/departments");
  await expect(
    page.getByText("Departments temporarily unavailable", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Create your first department" }),
  ).toHaveCount(0);
  available = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Archived support", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Include archived", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Archived support", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Operations", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open department", exact: true }),
  ).toHaveAttribute("href", `/departments/${DEPARTMENT_ID}`);
  await page.getByLabel("Search departments", { exact: true }).fill("missing");
  await expect(
    page.getByRole("heading", { name: "No departments found", exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)?.searchParams.get("search")).toBe("missing");
  expect(requests.at(-1)?.searchParams.get("deleted")).toBe("exclude");
  await page.getByLabel("Search departments", { exact: true }).fill("");
  await page.getByRole("button", { name: "Active only", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Archived support", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "New department", exact: true }),
  ).toHaveAttribute("href", "/departments/new");
});

test("creating a department and its first module preserves rejected drafts and opens the created module", async ({
  page,
}) => {
  const state = makeState();
  state.modules = [];
  await installMocks(page, state);
  const department = {
    ...baseEntity(DEPARTMENT_ID),
    department_name: "Customer Operations",
  };
  let rejectDepartment = true;
  let rejectModule = true;
  await page.route("**/bff/departments?*", (route) =>
    fulfill(route, 200, listResponse([])),
  );
  await page.route(`**/bff/departments/${DEPARTMENT_ID}`, (route) =>
    fulfill(route, 200, department),
  );
  await page.route("**/bff/departments", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(requestBody(route.request())).toEqual({
      department_name: department.department_name,
    });
    await fulfill(
      route,
      rejectDepartment ? 409 : 201,
      rejectDepartment
        ? { detail: "Department name is unavailable" }
        : department,
    );
  });
  await page.route("**/bff/modules", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(requestBody(route.request())).toEqual({
      department_id: DEPARTMENT_ID,
      module_name: "Customer cases",
    });
    if (rejectModule)
      return fulfill(route, 409, { detail: "Module name is unavailable" });
    const moduleItem = moduleFixture(
      SOURCE_MODULE_ID,
      DEPARTMENT_ID,
      "Customer cases",
      false,
    );
    state.modules.push(moduleItem);
    await fulfill(route, 201, moduleItem);
  });
  await page.goto("/departments");
  await expect(
    page.getByRole("heading", {
      name: "Create your first department",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Create department", exact: true })
    .click();
  await expect(page).toHaveURL(/\/departments\/new$/);
  await page
    .getByLabel("Department name", { exact: true })
    .fill(department.department_name);
  await page
    .getByRole("button", { name: "Create department", exact: true })
    .click();
  await expect(
    page.getByText("Department name is unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Department name", { exact: true })).toHaveValue(
    department.department_name,
  );
  rejectDepartment = false;
  await page
    .getByRole("button", { name: "Create department", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/departments/${DEPARTMENT_ID}$`));
  await expect(
    page.getByRole("heading", {
      name: department.department_name,
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Module name", { exact: true }).fill("Customer cases");
  await page
    .getByRole("button", { name: "Create module", exact: true })
    .click();
  await expect(
    page.getByText("Module name is unavailable", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Module name", { exact: true })).toHaveValue(
    "Customer cases",
  );
  rejectModule = false;
  await page
    .getByRole("button", { name: "Create module", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Customer cases", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Module name", { exact: true })).toHaveValue("");
  await expect(page.getByText("1 active", { exact: true })).toBeVisible();
  await page
    .getByRole("link", { name: "Open Customer cases", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/departments/${DEPARTMENT_ID}/modules/${SOURCE_MODULE_ID}$`),
  );
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Customer cases",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Records blocked", { exact: true }),
  ).toBeVisible();
});
