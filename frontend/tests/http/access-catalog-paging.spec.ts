import { expect, test } from "./helpers/test";
import { group, ids, listPage, mockAccessApi } from "./helpers/access-api";

const fixtureId = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const metadata = {
  created_at: "2026-01-10T09:00:00Z",
  updated_at: "2026-01-10T09:00:00Z",
  deleted_at: null,
  is_deleted: false,
  performed_by: ids.rosa,
};

test("access department and module search keeps unseen saved entries in the replacement", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const department = fixtureId(900);
  const selectedModule = fixtureId(901);
  const foundModule = fixtureId(902);
  const selectedDepartment = fixtureId(903);
  api.groups.set(
    ids.readers,
    group(
      ids.readers,
      "Finance readers",
      [],
      [
        {
          department_id: selectedDepartment,
          department_name: "Saved remote department",
          module_id: selectedModule,
          module_name: "Saved remote module",
          level: "read",
        },
      ],
    ),
  );
  const departments = [
    ...Array.from({ length: 30 }, (_, index) => ({
      id: fixtureId(500 + index),
      department_name: `A department ${index}`,
      ...metadata,
    })),
    { id: department, department_name: "Remote department", ...metadata },
    {
      id: selectedDepartment,
      department_name: "Saved remote department",
      ...metadata,
    },
  ];
  const modules = [
    ...Array.from({ length: 30 }, (_, index) => ({
      id: fixtureId(600 + index),
      department_id: department,
      module_name: `A module ${index}`,
      title_field_id: null,
      ...metadata,
    })),
    {
      id: foundModule,
      department_id: department,
      module_name: "Remote module",
      title_field_id: null,
      ...metadata,
    },
    {
      id: selectedModule,
      department_id: selectedDepartment,
      module_name: "Saved remote module",
      title_field_id: null,
      ...metadata,
    },
  ];
  const reads: URL[] = [];
  await page.route("**/api/departments**", (route) => {
    const url = new URL(route.request().url());
    reads.push(url);
    const id = url.pathname.split("/")[3];
    if (id)
      return route.fulfill({
        json: departments.find((item) => item.id === id),
      });
    return route.fulfill({
      json: listPage(
        departments.filter((item) =>
          item.department_name
            .toLowerCase()
            .includes((url.searchParams.get("search") ?? "").toLowerCase()),
        ),
        url,
      ),
    });
  });
  await page.route("**/api/modules**", (route) => {
    const url = new URL(route.request().url());
    reads.push(url);
    const id = url.pathname.split("/")[3];
    if (id)
      return route.fulfill({ json: modules.find((item) => item.id === id) });
    return route.fulfill({
      json: listPage(
        modules.filter(
          (item) =>
            (!url.searchParams.get("department_id") ||
              item.department_id === url.searchParams.get("department_id")) &&
            item.module_name
              .toLowerCase()
              .includes((url.searchParams.get("search") ?? "").toLowerCase()),
        ),
        url,
      ),
    });
  });
  await page.goto(`/access?view=groups&group=${ids.readers}`);
  const sheet = page.getByRole("dialog", {
    name: "Finance readers",
    exact: true,
  });
  await sheet.getByRole("tab", { name: "Access", exact: true }).click();
  await expect(
    sheet.getByRole("region", { name: "This group gives", exact: true }),
  ).toContainText("Saved remote module · Read");
  await sheet
    .getByRole("searchbox", { name: "Search departments", exact: true })
    .fill("Remote department");
  await sheet
    .getByLabel("Remote department level", { exact: true })
    .selectOption("write");
  await sheet
    .getByRole("button", { name: "Modules in Remote department", exact: true })
    .click();
  await sheet
    .getByRole("searchbox", {
      name: "Search modules in Remote department",
      exact: true,
    })
    .fill("Remote module");
  await sheet
    .getByLabel("Remote module level", { exact: true })
    .selectOption("read");
  await sheet.getByRole("button", { name: "Save access", exact: true }).click();
  await expect(
    sheet.getByRole("button", { name: "Save access", exact: true }),
  ).toBeDisabled();
  const saved = api.sent("PUT", `/api/access/groups/${ids.readers}/access`)[0]
    ?.body as { access: unknown[] };
  expect(saved.access).toEqual(
    expect.arrayContaining([
      {
        department_id: selectedDepartment,
        module_id: selectedModule,
        level: "read",
      },
      { department_id: department, module_id: null, level: "write" },
      { department_id: department, module_id: foundModule, level: "read" },
    ]),
  );
  expect(saved.access).toHaveLength(3);
  expect(
    reads
      .filter((url) => !url.pathname.split("/")[3])
      .every((url) => url.searchParams.get("offset") === "0"),
  ).toBe(true);
});

test("catalog search refusal survives cached keys until explicit Retry", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  let denied = true;
  api.on("GET", "/api/departments", (route) =>
    new URL(route.request().url()).searchParams.get("search") === "blocked" &&
    denied
      ? route.fulfill({ status: 403, json: { detail: "Forbidden" } })
      : "next",
  );
  await page.goto(`/access?view=groups&group=${ids.readers}&tab=access`);
  const sheet = page.getByRole("dialog", {
    name: "Finance readers",
    exact: true,
  });
  await expect(
    sheet.getByLabel("Inventory level", { exact: true }),
  ).toBeVisible();
  await sheet
    .getByRole("searchbox", { name: "Search departments", exact: true })
    .fill("blocked");
  await expect(sheet.getByRole("alert")).toContainText(
    "Options are unavailable",
  );
  await expect(sheet.getByLabel("Finance level", { exact: true })).toBeHidden();
  await sheet
    .getByRole("searchbox", { name: "Search departments", exact: true })
    .fill("");
  await expect(
    sheet.getByText("Loading departments…", { exact: true }),
  ).toBeHidden();
  await expect(sheet.getByLabel("Finance level", { exact: true })).toBeHidden();
  await expect(sheet.getByRole("alert")).toContainText(
    "Options are unavailable",
  );
  denied = false;
  await sheet
    .getByRole("button", { name: "Retry departments", exact: true })
    .click();
  await expect(
    sheet.getByLabel("Inventory level", { exact: true }),
  ).toBeVisible();
  expect(api.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
});

test("Access summary describes overrides without claiming module totals", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.goto(`/access?view=groups&group=${ids.readers}&tab=access`);
  const sheet = page.getByRole("dialog", {
    name: "Finance readers",
    exact: true,
  });
  const inventory = sheet
    .getByRole("list", { name: "Departments", exact: true })
    .getByRole("listitem")
    .filter({ has: page.getByText("Inventory", { exact: true }) });
  await expect(inventory).toContainText("No module overrides");
  await sheet
    .getByRole("button", { name: "Modules in Inventory", exact: true })
    .click();
  await expect(sheet.getByLabel("Prices level", { exact: true })).toBeVisible();
  await expect(inventory).toContainText("No module overrides");
  await sheet.getByLabel("Prices level", { exact: true }).selectOption("read");
  await expect(inventory).toContainText("1 module has its own level");
  await expect(inventory).not.toContainText("1 of");
  expect(api.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
});
