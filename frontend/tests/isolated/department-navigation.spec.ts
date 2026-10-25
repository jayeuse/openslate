import { expect, test } from "@playwright/test";

import {
  currentDashboardDepartmentId,
  currentModuleId,
  dashboardHref,
  departmentNavigation,
  moduleHref,
  moduleLocation,
} from "../../src/components/department-navigation-model";
import {
  currentNavigationKey,
  getWorkspaceNavigation,
  isWorkspaceNavigationGroupActive,
} from "../../src/components/workspace-navigation";

// docs/specs/openview-department-pages.md, DA2–DA8.

const departments = [
  { id: "sales", name: "Sales" },
  { id: "finance", name: "Finance" },
  { id: "inventory", name: "Inventory" },
];
const modules = [
  { id: "quotes", name: "Quotes", departmentId: "sales" },
  { id: "contacts", name: "Contacts", departmentId: "sales" },
  { id: "products", name: "Products", departmentId: "inventory" },
];

test("departments keep the Sandbox order and their color place, list readable modules by name, and drop departments with none", () => {
  expect(departmentNavigation(departments, modules)).toEqual([
    {
      id: "sales",
      name: "Sales",
      index: 0,
      modules: [
        { id: "contacts", name: "Contacts" },
        { id: "quotes", name: "Quotes" },
      ],
    },
    {
      id: "inventory",
      name: "Inventory",
      index: 2,
      modules: [{ id: "products", name: "Products" }],
    },
  ]);
  expect(departmentNavigation(departments, [])).toEqual([]);
});

test("a module page is the OpenView Views page for that module", () => {
  expect(moduleHref("quotes")).toBe("/openview?section=views&module=quotes");
  const params = (search: string) => new URLSearchParams(search);
  expect(
    currentModuleId("/openview", params("section=views&module=quotes")),
  ).toBe("quotes");
  expect(currentModuleId("/openview", params("module=quotes"))).toBe("quotes");
  expect(
    currentModuleId("/openview", params("section=dashboards&module=quotes")),
  ).toBeNull();
  expect(currentModuleId("/boards", params("module=quotes"))).toBeNull();
  const grouped = departmentNavigation(departments, modules);
  expect(moduleLocation(grouped, "products")).toEqual({
    department: grouped[1],
    module: { id: "products", name: "Products" },
  });
  expect(moduleLocation(grouped, "missing")).toBeNull();
});

test("the OpenView group keeps Reports only and is not current on a module page or a dashboard", () => {
  const onModule = new URLSearchParams("section=views&module=quotes");
  const openView = getWorkspaceNavigation("/openview", onModule, "all").find(
    (group) => group.id === "openview",
  );
  expect(openView?.items.map((item) => item.id)).toEqual(["reports"]);
  expect(openView?.href).toBe("/openview?section=reports&module=quotes");
  const onDashboard = new URLSearchParams(
    "section=dashboards&department=sales",
  );
  expect(
    isWorkspaceNavigationGroupActive(openView!, "/openview", onDashboard),
  ).toBe(false);
  expect(
    isWorkspaceNavigationGroupActive(openView!, "/openview", onModule),
  ).toBe(false);
  expect(
    isWorkspaceNavigationGroupActive(
      openView!,
      "/openview",
      new URLSearchParams("section=reports"),
    ),
  ).toBe(true);
  expect(currentNavigationKey("/openview", onModule)).toBe(
    "openview:module:quotes",
  );
  // Each department's dashboard is its own place, so the fill glides to it.
  expect(currentNavigationKey("/openview", onDashboard)).toBe(
    "openview:dashboard:sales",
  );
});

test("a department's Dashboard row opens its home dashboard and marks that department", () => {
  expect(dashboardHref("sales")).toBe(
    "/openview?section=dashboards&department=sales",
  );
  const params = (search: string) => new URLSearchParams(search);
  expect(
    currentDashboardDepartmentId(
      "/openview",
      params("section=dashboards&department=sales&dashboard=night"),
    ),
  ).toBe("sales");
  expect(
    currentDashboardDepartmentId(
      "/openview",
      params("section=views&module=quotes"),
    ),
  ).toBeNull();
  expect(
    currentDashboardDepartmentId("/boards", params("section=dashboards")),
  ).toBeNull();
});
