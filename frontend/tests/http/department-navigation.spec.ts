import type { Page } from "@playwright/test";
import { expect, signedInAs, test } from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";

// docs/specs/openview-department-pages.md, DA1–DA9: the Departments section of
// the sidebar. Module pages themselves are covered in openview-views-api.

const ids = {
  sales: "00000000-0000-4000-8000-0000000d0001",
  finance: "00000000-0000-4000-8000-0000000d0002",
  inventory: "00000000-0000-4000-8000-0000000d0003",
  contacts: "00000000-0000-4000-8000-0000000d0011",
  quotes: "00000000-0000-4000-8000-0000000d0012",
  products: "00000000-0000-4000-8000-0000000d0013",
  invoices: "00000000-0000-4000-8000-0000000d0014",
};
const timestamp = "2026-10-01T00:00:00Z";

function page<T>(items: T[], url: URL) {
  return {
    items,
    pagination: {
      limit: Number(url.searchParams.get("limit") ?? 100),
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  };
}

function department(id: string, name: string) {
  return {
    id,
    department_name: name,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  };
}

async function installCatalog(
  target: Page,
  modules: { id: string; name: string; department: string }[],
) {
  const state = { modules, refused: false, departmentQueries: [] as string[] };
  await target.route(
    (url) => url.pathname === "/api/departments",
    (route) => {
      const url = new URL(route.request().url());
      state.departmentQueries.push(url.search);
      return route.fulfill({
        // The server answers in Sandbox order when asked for created_at.
        json: page(
          [
            department(ids.sales, "Sales"),
            department(ids.finance, "Finance"),
            department(ids.inventory, "Inventory"),
          ],
          url,
        ),
      });
    },
  );
  await target.route(
    (url) => url.pathname === "/api/views/data-sources",
    (route) =>
      route.fulfill({
        ...(state.refused ? { status: 403 } : {}),
        json: page(
          state.modules.map((module) => ({
            id: module.id,
            name: module.name,
            department_id: module.department,
            title_field_id: null,
          })),
          new URL(route.request().url()),
        ),
      }),
  );
  return state;
}

const sidebar = (target: Page) =>
  target.getByRole("navigation", { name: "Main navigation" });

test("the sidebar lists readable departments in Sandbox order with their module pages, above the tools", async ({
  page: target,
}) => {
  const state = await installCatalog(target, [
    { id: ids.quotes, name: "Quotes", department: ids.sales },
    { id: ids.contacts, name: "Contacts", department: ids.sales },
    { id: ids.products, name: "Products", department: ids.inventory },
  ]);
  await target.goto("/platform?section=search");
  const nav = sidebar(target);
  const departments = nav.getByRole("list", { name: "Departments" });
  await expect(departments).toBeVisible();
  // Finance has no readable module, so it is not listed.
  await expect(
    departments.getByRole("button", { name: /^(Sales|Finance|Inventory)$/ }),
  ).toHaveText(["Sales", "Inventory"]);
  expect(
    state.departmentQueries.some((query) =>
      query.includes("sort_by=created_at"),
    ),
  ).toBe(true);
  await expect(nav.getByText("Tools", { exact: true })).toBeVisible();
  // No module page is open here, so every department starts closed.
  await expect(
    nav.getByRole("link", { name: "Contacts", exact: true }),
  ).toHaveCount(0);
  await departments.getByRole("button", { name: "Sales", exact: true }).click();
  const salesPages = nav.getByRole("list", { name: "Sales pages" });
  // The department's home dashboard comes first, then its module pages (BD1).
  await expect(salesPages.getByRole("link")).toHaveText([
    "Dashboard",
    "Contacts",
    "Quotes",
  ]);
  await expect(
    salesPages.getByRole("link", { name: "Dashboard", exact: true }),
  ).toHaveAttribute(
    "href",
    `/openview?section=dashboards&department=${ids.sales}`,
  );
  await expect(
    salesPages.getByRole("link", { name: "Quotes", exact: true }),
  ).toHaveAttribute("href", `/openview?section=views&module=${ids.quotes}`);
  // Reports live on module pages, so the sidebar has no OpenView item (DC9).
  await expect(
    nav.getByRole("button", { name: "OpenView", exact: true }),
  ).toHaveCount(0);
  await expect(
    nav.getByRole("link", { name: /^(Views|Dashboards|Charts|Reports)$/ }),
  ).toHaveCount(0);
});

test("an opened department stays open while the person moves between pages", async ({
  page: target,
}) => {
  await installCatalog(target, [
    { id: ids.products, name: "Products", department: ids.inventory },
  ]);
  await target.goto("/platform?section=search");
  const nav = sidebar(target);
  await nav.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(
    nav.getByRole("link", { name: "Products", exact: true }),
  ).toBeVisible();
  // Platform is the current group, so its sections are already listed.
  await nav.getByRole("link", { name: "Files", exact: true }).click();
  await expect(target).toHaveURL(/section=files/);
  await expect(
    nav.getByRole("link", { name: "Products", exact: true }),
  ).toBeVisible();
});

test("a module published in the Sandbox appears without a reload", async ({
  page: target,
}) => {
  await installOpenViewEventSource(target);
  const state = await installCatalog(target, [
    { id: ids.contacts, name: "Contacts", department: ids.sales },
  ]);
  await target.goto("/platform?section=search");
  const nav = sidebar(target);
  await expect(
    nav.getByRole("button", { name: "Sales", exact: true }),
  ).toBeVisible();
  await expect(
    nav.getByRole("button", { name: "Finance", exact: true }),
  ).toHaveCount(0);
  state.modules = [
    ...state.modules,
    { id: ids.invoices, name: "Invoices", department: ids.finance },
  ];
  await sendOpenViewEvent(target, "invalidate", { entity: "modules" });
  await expect(
    nav.getByRole("button", { name: "Finance", exact: true }),
  ).toBeVisible();
});

test("a refused catalog read hides the department and module names it held", async ({
  page: target,
}) => {
  await installOpenViewEventSource(target);
  const state = await installCatalog(target, [
    { id: ids.contacts, name: "Contacts", department: ids.sales },
  ]);
  await target.goto("/platform?section=search");
  const nav = sidebar(target);
  await expect(
    nav.getByRole("button", { name: "Sales", exact: true }),
  ).toBeVisible();
  state.refused = true;
  await sendOpenViewEvent(target, "invalidate", { entity: "modules" });
  await expect(nav.getByRole("list", { name: "Departments" })).toHaveCount(0);
  await expect(
    nav.getByRole("button", { name: "Sales", exact: true }),
  ).toHaveCount(0);
});

test("a person who reads no module sees no Departments section", async ({
  page: target,
}) => {
  await target.goto("/platform?section=search");
  const nav = sidebar(target);
  await expect(
    nav.getByRole("button", { name: "Platform", exact: true }),
  ).toBeVisible();
  await expect(nav.getByRole("list", { name: "Departments" })).toHaveCount(0);
  await expect(nav.getByText("Tools", { exact: true })).toHaveCount(0);
});

test("the collapsed rail shows one Departments button that opens the sidebar", async ({
  page: target,
}) => {
  await installCatalog(target, [
    { id: ids.contacts, name: "Contacts", department: ids.sales },
  ]);
  await target.goto("/platform?section=search");
  await target.getByRole("button", { name: "Collapse sidebar" }).click();
  const nav = sidebar(target);
  await expect(
    nav.getByRole("button", { name: "Sales", exact: true }),
  ).toHaveCount(0);
  await nav.getByRole("button", { name: "Departments", exact: true }).click();
  await expect(
    nav.getByRole("button", { name: "Sales", exact: true }),
  ).toBeVisible();
});

test("a module page with no readable module says why, and only an administrator is offered the Sandbox", async ({
  page: target,
}) => {
  // The fixture's catalog is empty: nothing this person can read.
  await target.goto("/openview?section=views");
  await expect(
    target.getByRole("heading", { level: 2, name: "Nothing published yet" }),
  ).toBeVisible();
  await expect(
    target.getByRole("link", { name: "Open Sandbox", exact: true }),
  ).toBeVisible();
  // With no module to name, the breadcrumb names the records landing.
  await expect(
    target
      .getByRole("navigation", { name: "breadcrumb" })
      .locator('[aria-current="page"]'),
  ).toHaveText("Records");

  await signedInAs(target, {
    id: "00000000-0000-4000-8000-0000000000aa",
    role: "member",
  });
  await target.reload();
  await expect(
    target.getByRole("heading", { level: 2, name: "No records to show yet" }),
  ).toBeVisible();
  await expect(target.getByText(/Access › Groups/)).toBeVisible();
  await expect(
    target.getByRole("link", { name: "Open Sandbox", exact: true }),
  ).toHaveCount(0);
});
