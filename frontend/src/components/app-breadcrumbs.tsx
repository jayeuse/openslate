"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { skipToken, useQuery } from "@tanstack/react-query";
import type { Route } from "next";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import {
  accessNavigationFor,
  getWorkspaceLocation,
} from "@/components/workspace-navigation";
import { cn } from "@/lib/utils";
import {
  authMeOptions,
  catalogFirstPageOptions,
} from "@/components/systems/openview/adapters/openview-queries";
import { departmentNavigationOptions } from "@/components/department-navigation";
import {
  currentDashboardDepartmentId,
  currentModuleId,
  departmentNavigation,
  isModulePage,
  isRefusal,
  moduleLocation,
} from "@/components/department-navigation-model";
import {
  useAdmittedWorkspaceScope,
  useVerifiedWorkspaceUserId,
} from "@/components/systems/shared/runtime/workspace-identity";
import { profileSelfKey } from "@/components/profile/adapters/profile-queries";
import type { ProfileSelf } from "@/components/profile/adapters/profile-api";
import { personProfileKey } from "@/components/profile/adapters/profile-view-keys";
import {
  boardsDetailKey,
  boardsLocation,
  boardsNavigationKey,
  boardsPlace,
  type BoardsPlace,
  type NavigationBoard,
} from "@/components/boards-navigation-model";
import type { PersonProfile } from "@/components/profile/adapters/profile-api";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

// Routes without sections in the sidebar name only themselves.
const routeLabels: Record<string, string> = {
  "/access": "Access",
  "/sandbox": "Sandbox",
  "/comms": "OpenComms",
  "/settings": "Account settings",
  "/settings/appearance": "Appearance",
};

// Profile and Account settings carry their whole title in the page heading,
// the row under the bar on phones (PD49): a person's name or "Account
// settings" would be cut beside the bar's 44px controls, so below 768px the
// bar names no page there.
const titledInPage = new Set(["/profile", "/settings"]);

// Links in the header bar keep a 24px target.
const crumbTarget = "inline-flex min-h-6 items-center";

/**
 * Workspace › workspace › open section. Phones show only the open section so
 * it never truncates at large text sizes; the sidebar names the workspace.
 */
export function AppBreadcrumbs() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Legacy Platform links pick their section by hash, as the sidebar does.
  const [hash, setHash] = useState("");
  useEffect(() => {
    const syncHash = () => setHash(window.location.hash);
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [pathname, searchParams]);
  const identity = useQuery(authMeOptions());
  const location = getWorkspaceLocation(
    pathname,
    new URLSearchParams(searchParams.toString()),
    hash,
    accessNavigationFor(identity.data),
  );
  // OpenView has no sidebar group now: without a module or department its
  // page is the records landing, or the dashboard landing.
  const openViewLabel =
    pathname === "/openview"
      ? isModulePage(pathname, new URLSearchParams(searchParams.toString()))
        ? "Records"
        : "Dashboard"
      : undefined;
  const current =
    location?.section ?? openViewLabel ?? routeLabels[pathname] ?? "Workspace";
  const moduleId = currentModuleId(
    pathname,
    new URLSearchParams(searchParams.toString()),
  );
  const dashboardDepartmentId = currentDashboardDepartmentId(
    pathname,
    new URLSearchParams(searchParams.toString()),
  );
  if (moduleId || dashboardDepartmentId)
    return (
      <ModuleCrumbs
        moduleId={moduleId}
        dashboardDepartmentId={dashboardDepartmentId}
      />
    );
  const boards = boardsPlace(
    pathname,
    new URLSearchParams(searchParams.toString()),
  );
  if (boards) return <BoardsCrumbs place={boards} />;
  return (
    <Breadcrumb
      className={cn("min-w-0", titledInPage.has(pathname) && "max-md:hidden")}
    >
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="max-sm:hidden">
          <BreadcrumbLink
            className={crumbTarget}
            render={<GuardedWorkspaceLink href={"/openview" as Route} />}
          >
            Workspace
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="max-sm:hidden" />
        {location ? (
          <>
            <BreadcrumbItem className="shrink-0 max-sm:hidden">
              <BreadcrumbLink
                className={crumbTarget}
                render={
                  <GuardedWorkspaceLink
                    href={location.workspace.href as Route}
                  />
                }
              >
                {location.workspace.label}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="max-sm:hidden" />
          </>
        ) : null}
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="block min-h-6 truncate leading-6">
            {pathname === "/profile" ? <ProfileCrumb /> : current}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * "Your profile" on the person's own profile, the person's name on another
 * profile, and "Profile" while it loads, when it is not available, or when
 * the read failed, so the header never shows an id or names a hidden person.
 *
 * It only reads the cache that the Profile view (`useProfileView`) fills, by
 * the same keys, so every page's header does not ship the profile read.
 */
function ProfileCrumb() {
  const person = useSearchParams().get("person")?.toLowerCase() || null;
  const viewerId = useVerifiedWorkspaceUserId();
  const scope = useAdmittedWorkspaceScope();
  const own = !person || person === viewerId.toLowerCase();
  const read = useQuery<PersonProfile | ProfileSelf>({
    // Without an organization the own profile comes from the account.
    queryKey: scope
      ? personProfileKey(viewerId, scope.org_id, own ? viewerId : person)
      : profileSelfKey(viewerId),
    queryFn: skipToken,
  });
  if (read.error) return "Profile";
  if (own) return "Your profile";
  return read.data && "displayName" in read.data
    ? read.data.displayName
    : "Profile";
}

/**
 * "Sales › Contacts" on a module page (DA8) and "Sales › Dashboard" on a
 * department dashboard (BD1). It reads the cache the sidebar fills, so the
 * header adds no read; it shows "Records" or "Dashboard" until that lands.
 * It observes with the real reads, disabled: a skipToken observer would leave
 * the shared queries without a read when they refresh.
 */
function ModuleCrumbs({
  moduleId,
  dashboardDepartmentId,
}: {
  moduleId: string | null;
  dashboardDepartmentId: string | null;
}) {
  const departments = useQuery({
    ...departmentNavigationOptions(),
    enabled: false,
  });
  const modules = useQuery({ ...catalogFirstPageOptions(), enabled: false });
  const readable =
    departments.data &&
    modules.data &&
    !isRefusal(departments.error) &&
    !isRefusal(modules.error)
      ? departmentNavigation(departments.data.items, modules.data.items)
      : null;
  const department = readable?.find(
    (entry) => entry.id === dashboardDepartmentId,
  );
  const place = department
    ? { department, module: { name: "Dashboard" } }
    : readable
      ? moduleLocation(readable, moduleId)
      : null;
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {place ? (
          <>
            <BreadcrumbItem className="shrink-0 max-sm:hidden">
              {place.department.name}
            </BreadcrumbItem>
            <BreadcrumbSeparator className="max-sm:hidden" />
          </>
        ) : null}
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="block min-h-6 truncate leading-6">
            {place?.module.name ??
              (dashboardDepartmentId ? "Dashboard" : "Records")}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * "Sales › Announcements", "Boards › Company", "Boards › <project>" and
 * "Boards › All boards" (BR4). Names come from the caches the sidebar and
 * the Boards page fill, so the header adds no read.
 */
function BoardsCrumbs({ place }: { place: BoardsPlace }) {
  const departments = useQuery({
    ...departmentNavigationOptions(),
    enabled: false,
  });
  const list = useQuery<{ items: NavigationBoard[] }>({
    queryKey: boardsNavigationKey(),
    queryFn: skipToken,
  });
  const open = useQuery<NavigationBoard>({
    queryKey: boardsDetailKey(place.kind === "board" ? place.boardId : ""),
    queryFn: skipToken,
  });
  const location = boardsLocation(
    place,
    [
      ...(isRefusal(list.error) ? [] : (list.data?.items ?? [])),
      ...(place.kind === "board" && open.data ? [open.data] : []),
    ],
    isRefusal(departments.error) ? [] : (departments.data?.items ?? []),
  );
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {location.parent ? (
          <>
            <BreadcrumbItem className="shrink-0 max-sm:hidden">
              {location.parent}
            </BreadcrumbItem>
            <BreadcrumbSeparator className="max-sm:hidden" />
          </>
        ) : null}
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="block min-h-6 truncate leading-6">
            {location.current}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
