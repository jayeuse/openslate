"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { Route } from "next";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import {
  accessNavigationFor,
  getWorkspaceLocation,
} from "@/components/workspace-navigation";
import { cn } from "@/lib/utils";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import { useProfileView } from "@/components/profile/hooks/use-profile-view";
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
  const current = location?.section ?? routeLabels[pathname] ?? "Workspace";
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
 * profile, and "Profile" while it loads or when it is not available, so the
 * header never shows an id or names a hidden person.
 */
function ProfileCrumb() {
  const view = useProfileView();
  if (view.status !== "ready")
    return view.status === "loading" && view.own ? "Your profile" : "Profile";
  return view.own ? "Your profile" : view.profile.displayName;
}
