"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { Route } from "next";
import {
  GuardedWorkspaceLink,
  useNavigationDirection,
} from "@/components/workspace-navigation-guard";
import {
  getWorkspaceLocation,
  workspaceDefaultNavigationKey,
} from "@/components/workspace-navigation";
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
  "/comms": "OpenComms",
  "/settings/appearance": "Appearance",
};

// Links in the header bar keep a 24px target.
const crumbTarget = "inline-flex min-h-6 items-center";

/**
 * Workspace › workspace › open section. Phones drop the Workspace root so the
 * crumbs that change stay readable.
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
  const location = getWorkspaceLocation(
    pathname,
    new URLSearchParams(searchParams.toString()),
    hash,
  );
  const current = location?.section ?? routeLabels[pathname] ?? "Workspace";
  // Crumbs animate the page in the direction of the place they open.
  const rootDirection = useNavigationDirection(
    workspaceDefaultNavigationKey("/openview"),
  );
  const workspaceDirection = useNavigationDirection(
    location ? workspaceDefaultNavigationKey(location.workspace.href) : null,
  );
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="max-sm:hidden">
          <BreadcrumbLink
            className={crumbTarget}
            render={
              <GuardedWorkspaceLink
                href={"/openview" as Route}
                transitionTypes={rootDirection ? [rootDirection] : undefined}
              />
            }
          >
            Workspace
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="max-sm:hidden" />
        {location ? (
          <>
            <BreadcrumbItem className="shrink-0">
              <BreadcrumbLink
                className={crumbTarget}
                render={
                  <GuardedWorkspaceLink
                    href={location.workspace.href as Route}
                    transitionTypes={
                      workspaceDirection ? [workspaceDirection] : undefined
                    }
                  />
                }
              >
                {location.workspace.label}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </>
        ) : null}
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="block min-h-6 truncate leading-6">
            {current}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
