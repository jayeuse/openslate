/**
 * Departments in the sidebar (docs/specs/openview-department-pages.md, DA2):
 * the departments a person can read, in Sandbox order, each with the modules
 * the person can read. A module is a page: the OpenView Views page for it.
 */
import { openViewKeys } from "@/components/systems/openview/adapters/openview-queries";

/** The departments read in Sandbox order (the catalog first page holds the modules). */
export const departmentNavigationKey = () =>
  [...openViewKeys.catalog, "department-navigation"] as const;

export type NavigationModule = { id: string; name: string };

export type NavigationDepartment = {
  id: string;
  name: string;
  /** The place in the Sandbox order, which sets the department's color. */
  index: number;
  modules: NavigationModule[];
};

/**
 * Groups readable modules under their departments. Departments come in the
 * order given (the Sandbox order) and keep that place as their color index,
 * so a department without readable modules still holds its place. Departments
 * without readable modules are left out; modules sort by name.
 */
export function departmentNavigation(
  departments: readonly { id: string; name: string }[],
  modules: readonly { id: string; name: string; departmentId: string }[],
): NavigationDepartment[] {
  const byDepartment = new Map<string, NavigationModule[]>();
  for (const entry of modules) {
    const list = byDepartment.get(entry.departmentId) ?? [];
    list.push({ id: entry.id, name: entry.name });
    byDepartment.set(entry.departmentId, list);
  }
  return departments
    .map((department, index) => ({
      id: department.id,
      name: department.name,
      index,
      modules: (byDepartment.get(department.id) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }))
    .filter((department) => department.modules.length > 0);
}

/** The page of one module. */
export function moduleHref(moduleId: string): string {
  return `/openview?section=views&module=${encodeURIComponent(moduleId)}`;
}

/** The module a URL shows as its page, or null on any other page. */
export function currentModuleId(
  pathname: string,
  searchParams: URLSearchParams,
): string | null {
  if (pathname !== "/openview") return null;
  const section = searchParams.get("section");
  if (section !== null && section !== "views") return null;
  return searchParams.get("module");
}

/** The department and module a module page shows, for the breadcrumb. */
export function moduleLocation(
  departments: readonly NavigationDepartment[],
  moduleId: string | null,
): { department: NavigationDepartment; module: NavigationModule } | null {
  if (!moduleId) return null;
  for (const department of departments) {
    const found = department.modules.find((entry) => entry.id === moduleId);
    if (found) return { department, module: found };
  }
  return null;
}
