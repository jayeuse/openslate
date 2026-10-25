import { expect, test } from "@playwright/test";

import {
  currentModuleId,
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

test("the OpenView group keeps Dashboards, Charts and Reports and is not current on a module page", () => {
  const onModule = new URLSearchParams("section=views&module=quotes");
  const openView = getWorkspaceNavigation("/openview", onModule, "all").find(
    (group) => group.id === "openview",
  );
  expect(openView?.items.map((item) => item.id)).toEqual([
    "dashboards",
    "charts",
    "reports",
  ]);
  expect(openView?.href).toBe("/openview?section=dashboards&module=quotes");
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
  expect(currentNavigationKey("/openview", onModule)).toBe("module:quotes");
  expect(
    currentNavigationKey("/openview", new URLSearchParams("section=charts")),
  ).toBe("openview:charts");
});
