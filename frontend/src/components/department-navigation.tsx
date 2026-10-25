"use client";

import { useEffect } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { listOpenViewDepartments } from "@/components/systems/openview/adapters/departments-api";
import {
  catalogFirstPageOptions,
  openViewKeys,
} from "@/components/systems/openview/adapters/openview-queries";
import { subscribeWorkspaceInvalidations } from "@/components/systems/shared/adapters/invalidation-events";
import { useWorkspaceInteractionSuspended } from "@/components/systems/shared/runtime/workspace-identity";
import {
  departmentNavigation,
  departmentNavigationKey,
  isRefusal,
  type NavigationDepartment,
} from "@/components/department-navigation-model";

/** The departments in Sandbox order, which set each one's color. */
export const departmentNavigationOptions = () =>
  queryOptions({
    queryKey: departmentNavigationKey(),
    queryFn: ({ signal }) =>
      listOpenViewDepartments({ order: "created", signal }),
  });

/**
 * The departments and modules the person can read, grouped for the sidebar
 * (DA2, docs/specs/openview-department-pages.md). The module list is the
 * catalog's first page, shared with OpenView. While an OpenView section that
 * syncs its reads is open, that sync refreshes them; elsewhere this does.
 */
export function useDepartmentNavigation(
  pathname: string,
  searchParams: URLSearchParams,
): NavigationDepartment[] {
  const suspended = useWorkspaceInteractionSuspended();
  const queryClient = useQueryClient();
  const departments = useQuery({
    ...departmentNavigationOptions(),
    enabled: !suspended,
  });
  const modules = useQuery({
    ...catalogFirstPageOptions(),
    enabled: !suspended,
  });
  const openViewSyncs =
    pathname === "/openview" && searchParams.get("section") !== "dashboards";
  useEffect(() => {
    if (openViewSyncs) return;
    return subscribeWorkspaceInvalidations((event) => {
      if (
        event.type === "resync" ||
        event.entity === "departments" ||
        event.entity === "modules"
      )
        void queryClient.invalidateQueries({ queryKey: openViewKeys.catalog });
    });
  }, [openViewSyncs, queryClient]);
  if (
    !departments.data ||
    !modules.data ||
    isRefusal(departments.error) ||
    isRefusal(modules.error)
  )
    return [];
  return departmentNavigation(departments.data.items, modules.data.items);
}
