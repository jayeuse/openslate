"use client";

import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import {
  accessNavigationFor,
  type AccessNavigation,
} from "@/components/workspace-navigation";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";

import { authMeOptions } from "./adapters/access-queries";
import { AccessDraftNavigationProvider } from "./state/draft-navigation";

const accessViews = {
  overview: {
    title: "Access overview",
    description: "See who has access and where it needs attention.",
  },
  people: {
    title: "People",
    description: "Invite people, set their role, and review their sessions.",
  },
  groups: {
    title: "Groups",
    description: "Give groups read, write, or manage access to departments.",
  },
} as const;

type AccessView = keyof typeof accessViews;

function isAccessView(value: string | null): value is AccessView {
  return value !== null && Object.hasOwn(accessViews, value);
}

/** The tab a URL opens for this person. Managers only ever see Groups. */
function viewFor(
  access: Exclude<AccessNavigation, "none">,
  searchParams: URLSearchParams,
): AccessView {
  if (access === "groups") return "groups";
  const requested = searchParams.get("view");
  if (isAccessView(requested)) return requested;
  return searchParams.has("user") ? "people" : "overview";
}

export default function AccessPage() {
  const userId = useVerifiedWorkspaceUserId();
  return (
    <Suspense fallback={<AccessFrame title="Access" description="" />}>
      <AccessDraftNavigationProvider key={userId}>
        <AccessControlCenter />
      </AccessDraftNavigationProvider>
    </Suspense>
  );
}

function AccessControlCenter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const identity = useQuery(authMeOptions());
  const access = identity.data ? accessNavigationFor(identity.data) : null;
  const requestedView = searchParams.get("view");

  // A manager's links always name the Groups tab, so the sidebar and the
  // breadcrumb agree with what the page shows.
  useEffect(() => {
    if (access === "groups" && requestedView !== "groups")
      router.replace(`${pathname}?view=groups` as Route);
  }, [access, pathname, requestedView, router]);

  if (identity.isError)
    return (
      <AccessFrame title="Access" description="">
        <div role="alert" className="max-w-lg space-y-4 rounded-lg border p-6">
          <div>
            <h2 className="text-base font-semibold">
              Access data is unavailable
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Your permissions could not be loaded. Try again.
            </p>
          </div>
          <Button className="min-h-11" onClick={() => void identity.refetch()}>
            Retry
          </Button>
        </div>
      </AccessFrame>
    );

  if (access === "none")
    return (
      <AccessFrame title="Access" description="">
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Access is managed by administrators</EmptyTitle>
            <EmptyDescription>
              Ask an administrator or a department manager to change your
              groups.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </AccessFrame>
    );

  const view = access === null ? null : viewFor(access, searchParams);
  const copy = view === null ? null : accessViews[view];

  return (
    <AccessFrame
      title={copy?.title ?? "Access"}
      description={copy?.description ?? ""}
      showSecurityLink={access === "all"}
    >
      <LoadingRegion
        loading={identity.isPending}
        label="Loading Access…"
        skeleton={<Skeleton className="h-40 w-full" />}
      >
        {view === null ? null : <AccessPlaceholder view={view} />}
      </LoadingRegion>
    </AccessFrame>
  );
}

function AccessFrame({
  title,
  description,
  showSecurityLink = false,
  children,
}: {
  title: string;
  description: string;
  showSecurityLink?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 p-3 sm:px-5 sm:py-4">
      <header className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1
            data-slot="page-title"
            className="text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            {title}
          </h1>
          {description ? (
            <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
              {description}
            </p>
          ) : null}
        </div>
        {showSecurityLink ? (
          <Button
            asChild
            variant="outline"
            className="min-h-11 w-full shrink-0 px-3 sm:w-auto"
          >
            <GuardedWorkspaceLink href="/manage?view=security">
              <ShieldCheck aria-hidden="true" />
              Sign-in & security
              <ArrowUpRight aria-hidden="true" />
            </GuardedWorkspaceLink>
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {children}
      </div>
    </div>
  );
}

// Temporary: the Access screens are rebuilt on the groups model in the next
// sub-slices (3e-2 People, 3e-3 Groups and Overview).
function AccessPlaceholder({ view }: { view: AccessView }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>{accessViews[view].title}</EmptyTitle>
        <EmptyDescription>Rebuilt in the next step.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
