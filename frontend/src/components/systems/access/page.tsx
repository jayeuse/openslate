"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ArrowUpRight, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";

import { useAccessController } from "./state/controller";
import {
  GovernanceDialogs,
  type GovernanceDialogTarget,
} from "./components/governance-dialogs";
import { GroupsView } from "./components/groups-view";
import { IdentitiesView } from "./components/identities-view";
import {
  OverviewView,
  type AccessOverviewDestination,
} from "./components/overview-view";
import type { AccessSubjectRef } from "./domain/policy";
import { ReviewsView } from "./components/reviews-view";
import { RolesView } from "./components/roles-view";
import { RulesView } from "./components/rules-view";
import { SimulatorView } from "./components/simulator-view";

const accessViews = [
  { id: "overview", label: "Overview" },
  { id: "identities", label: "Identities" },
  { id: "roles", label: "Roles" },
  { id: "groups", label: "Groups" },
  { id: "rules", label: "Access rules" },
  { id: "simulator", label: "Simulator" },
  { id: "reviews", label: "Reviews" },
] as const;

const accessPanelClass = "min-h-0 flex-1 overflow-y-auto overscroll-contain";

type AccessView = (typeof accessViews)[number]["id"];

function isAccessView(value: string | null): value is AccessView {
  return accessViews.some((view) => view.id === value);
}

function AccessFallback() {
  return (
    <div
      className="h-full space-y-5 overflow-hidden p-3 sm:px-5 sm:py-4"
      role="status"
      aria-label="Opening Access"
    >
      <div className="space-y-2">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-5 w-full max-w-xl" />
      </div>
      <Skeleton className="h-11 w-full" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-28 w-full" />
        ))}
      </div>
    </div>
  );
}

function AccessReadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-5" role="alert">
      <div className="w-full max-w-lg space-y-4 rounded-lg border p-6">
        <div>
          <h1 className="text-xl font-semibold">Access data is unavailable</h1>
          <p className="text-muted-foreground mt-2 text-sm">{message}</p>
        </div>
        <Button className="min-h-11" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

export default function SampleAccess() {
  return (
    <Suspense fallback={<AccessFallback />}>
      <AccessControlCenter />
    </Suspense>
  );
}

function AccessControlCenter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const controller = useAccessController();
  const [requestedSubject, setRequestedSubject] = useState<AccessSubjectRef>();
  const [governanceDialog, setGovernanceDialog] =
    useState<GovernanceDialogTarget | null>(null);
  const [navigationNotice, setNavigationNotice] = useState("");
  const resource = controller.resource;
  const readReady = resource.status === "ready";

  const requestedView = searchParams.get("view");
  const requestedUser = searchParams.get("user");
  const hasUserDeepLink =
    readReady &&
    requestedUser !== null &&
    [
      ...controller.state.identities,
      ...controller.state.deletedIdentities.map((item) => item.identity),
    ].some((identity) => identity.id === requestedUser);
  const activeView: AccessView = isAccessView(requestedView)
    ? requestedView
    : hasUserDeepLink
      ? "identities"
      : "overview";

  useEffect(() => {
    if (!readReady || requestedUser === null || hasUserDeepLink) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("user");
    const query = next.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}` as Route);
  }, [
    hasUserDeepLink,
    pathname,
    readReady,
    requestedUser,
    router,
    searchParams,
  ]);

  function blockNavigation(): boolean {
    if (!controller.isPending()) return false;
    setNavigationNotice(
      "Finish the Access change before switching views or leaving this page.",
    );
    return true;
  }

  useWorkspaceNavigationGuard(() => {
    if (controller.isPending()) {
      setNavigationNotice(
        "Finish the Access change before switching views or leaving this page.",
      );
      return false;
    }
    setNavigationNotice("");
    return true;
  });

  function navigate(view: AccessView, options?: { keepSubject?: boolean }) {
    if (blockNavigation()) return;
    setNavigationNotice("");
    if (!options?.keepSubject) setRequestedSubject(undefined);
    const next = new URLSearchParams();
    next.set("view", view);
    if (view === "identities") {
      const user = searchParams.get("user");
      if (user) next.set("user", user);
    }
    router.push(`${pathname}?${next.toString()}` as Route);
  }

  function navigateFromOverview(destination: AccessOverviewDestination) {
    if (blockNavigation()) return;
    if (
      destination === "defaults" ||
      destination === "import" ||
      destination === "export"
    ) {
      setGovernanceDialog(destination);
      return;
    }
    navigate(destination);
  }

  function openRulesForGroup(groupId: string) {
    if (blockNavigation()) return;
    setRequestedSubject({ kind: "group", id: groupId });
    navigate("rules", { keepSubject: true });
  }

  function setActiveGovernanceDialog(dialog: GovernanceDialogTarget | null) {
    if (dialog === null && blockNavigation()) return;
    setGovernanceDialog(dialog);
  }

  if (resource.status === "loading") return <AccessFallback />;
  if (resource.status === "error")
    return (
      <AccessReadError message={resource.error} onRetry={resource.reload} />
    );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 p-3 sm:px-5 sm:py-4">
      <header className="flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Access
          </h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            Manage identities, roles, groups, and access policies.
          </p>
        </div>
        <Button asChild variant="outline" className="min-h-11 shrink-0 px-3">
          <Link
            href="/manage?view=security"
            onClick={(event) => {
              if (blockNavigation()) event.preventDefault();
            }}
          >
            <ShieldCheck aria-hidden="true" />
            Manage security
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </Button>
      </header>

      {navigationNotice ? (
        <Alert role="status" variant="warning">
          {navigationNotice}
        </Alert>
      ) : null}
      {resource.refreshing || resource.error ? (
        <Alert role="status" variant="warning">
          <span>
            {resource.refreshing
              ? "Refreshing Access data…"
              : `Access data could not be refreshed. Showing the last available result. ${resource.error}`}
          </span>
          {!resource.refreshing && resource.error ? (
            <Button
              variant="outline"
              className="min-h-11"
              onClick={resource.reload}
            >
              Retry refresh
            </Button>
          ) : null}
        </Alert>
      ) : null}

      <div
        className={
          activeView === "reviews"
            ? `${accessPanelClass} grid gap-4 xl:grid-cols-2 xl:items-start`
            : accessPanelClass
        }
      >
        {activeView === "overview" ? (
          <OverviewView
            controller={controller}
            onNavigate={navigateFromOverview}
          />
        ) : null}
        {activeView === "identities" ? (
          <IdentitiesView controller={controller} />
        ) : null}
        {activeView === "roles" ? <RolesView controller={controller} /> : null}
        {activeView === "groups" ? (
          <GroupsView
            controller={controller}
            onOpenRulesForGroup={openRulesForGroup}
          />
        ) : null}
        {activeView === "rules" ? (
          <RulesView
            key={
              requestedSubject?.kind === "group"
                ? `rules-${requestedSubject.id}`
                : "rules"
            }
            controller={controller}
            initialSubject={requestedSubject}
          />
        ) : null}
        {activeView === "simulator" ? (
          <SimulatorView controller={controller} />
        ) : null}
        {activeView === "reviews" ? (
          <>
            <ReviewsView controller={controller} />
            <GovernanceDialogs
              controller={controller}
              dialog={governanceDialog}
              onDialogChange={setActiveGovernanceDialog}
            />
          </>
        ) : null}
      </div>

      {activeView !== "reviews" && (
        <GovernanceDialogs
          controller={controller}
          dialog={governanceDialog}
          onDialogChange={setActiveGovernanceDialog}
          showLauncher={false}
        />
      )}
    </div>
  );
}
