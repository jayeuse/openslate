"use client";

import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { ArrowUpRight, ShieldCheck } from "lucide-react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  GuardedWorkspaceLink,
  useWorkspaceNavigationGuard,
} from "@/components/workspace-navigation-guard";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";

import { useAccessController } from "./state/controller";
import {
  AccessDraftNavigationProvider,
  useAccessDraftNavigation,
} from "./state/draft-navigation";
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
  { id: "identities", label: "People & services" },
  { id: "roles", label: "Roles" },
  { id: "groups", label: "Groups" },
  { id: "rules", label: "Detailed rules" },
  { id: "simulator", label: "Check access" },
  { id: "reviews", label: "Access reviews" },
] as const;

const accessPanelClass = "min-h-0 flex-1 overflow-y-auto overscroll-contain";

type AccessView = (typeof accessViews)[number]["id"];
type PendingAccessNavigation = { href: string; resume: () => void };

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
  const userId = useVerifiedWorkspaceUserId();
  return (
    <Suspense fallback={<AccessFallback />}>
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
  const controller = useAccessController();
  const { hasUnsavedDraft, discardUnsavedDrafts } = useAccessDraftNavigation();
  const [requestedSubject, setRequestedSubject] = useState<AccessSubjectRef>();
  const [governanceDialog, setGovernanceDialog] =
    useState<GovernanceDialogTarget | null>(null);
  const [pendingNavigation, setPendingNavigation] =
    useState<PendingAccessNavigation | null>(null);
  const [navigationNotice, setNavigationNotice] = useState("");
  const commandPending = controller.isPending();
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

  const guardWorkspaceNavigation = useCallback(
    (href: string, resume: () => void) => {
      if (commandPending) {
        setNavigationNotice(
          "Finish the Access change before switching views or leaving this page.",
        );
        return false;
      }
      if (!hasUnsavedDraft) {
        setNavigationNotice("");
        return true;
      }
      if (
        typeof window !== "undefined" &&
        new URL(href, window.location.origin).href === window.location.href
      )
        return true;

      let resumed = false;
      setNavigationNotice("");
      setPendingNavigation({
        href,
        resume: () => {
          if (resumed) return;
          resumed = true;
          resume();
        },
      });
      return false;
    },
    [commandPending, hasUnsavedDraft],
  );

  useWorkspaceNavigationGuard(guardWorkspaceNavigation);

  useEffect(() => {
    if (!hasUnsavedDraft && !commandPending) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [commandPending, hasUnsavedDraft]);

  function accessViewHref(view: AccessView): string {
    const next = new URLSearchParams();
    next.set("view", view);
    if (view === "identities") {
      const user = searchParams.get("user");
      if (user) next.set("user", user);
    }
    return `${pathname}?${next.toString()}`;
  }

  function pushAccessView(
    view: AccessView,
    options?: { keepSubject?: boolean },
  ) {
    setNavigationNotice("");
    if (!options?.keepSubject) setRequestedSubject(undefined);
    router.push(accessViewHref(view) as Route);
  }

  function requestAccessNavigation(href: string, resume: () => void) {
    if (guardWorkspaceNavigation(href, resume)) resume();
  }

  function navigate(view: AccessView, options?: { keepSubject?: boolean }) {
    const href = accessViewHref(view);
    requestAccessNavigation(href, () => pushAccessView(view, options));
  }

  function navigateFromOverview(destination: AccessOverviewDestination) {
    if (
      destination === "defaults" ||
      destination === "import" ||
      destination === "export"
    ) {
      requestAccessNavigation(
        `${pathname}?view=overview&action=${destination}`,
        () => {
          setGovernanceDialog(destination);
        },
      );
      return;
    }
    navigate(destination);
  }

  function openRulesForGroup(groupId: string) {
    requestAccessNavigation(accessViewHref("rules"), () => {
      setRequestedSubject({ kind: "group", id: groupId });
      pushAccessView("rules", { keepSubject: true });
    });
  }

  function discardAndContinueNavigation() {
    if (commandPending) {
      setNavigationNotice(
        "Finish the Access change before switching views or leaving this page.",
      );
      return;
    }
    const transition = pendingNavigation;
    if (!transition) return;
    if (!discardUnsavedDrafts()) {
      setNavigationNotice(
        "The browser could not clear your saved Access draft. Keep editing or clear this site's browser data before leaving.",
      );
      return;
    }
    setPendingNavigation(null);
    transition.resume();
  }

  if (resource.status === "loading") return <AccessFallback />;
  if (resource.status === "error")
    return (
      <AccessReadError message={resource.error} onRetry={resource.reload} />
    );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 p-3 sm:px-5 sm:py-4">
      <header
        className={
          activeView === "overview"
            ? "flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
            : "flex shrink-0 items-start justify-between gap-3"
        }
      >
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {activeView === "overview" ? "Access overview" : "Access"}
          </h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            {activeView === "overview"
              ? "Manage who has access and what they can do."
              : "Manage identities, roles, groups, and access policies."}
          </p>
        </div>
        <Button
          asChild
          variant="outline"
          className={`min-h-11 shrink-0 px-3 ${activeView === "overview" ? "w-full sm:w-auto" : ""}`}
        >
          <GuardedWorkspaceLink href="/manage?view=security">
            <ShieldCheck aria-hidden="true" />
            Sign-in & security
            <ArrowUpRight aria-hidden="true" />
          </GuardedWorkspaceLink>
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
              onDialogChange={setGovernanceDialog}
            />
          </>
        ) : null}
      </div>

      {activeView !== "reviews" && (
        <GovernanceDialogs
          controller={controller}
          dialog={governanceDialog}
          onDialogChange={setGovernanceDialog}
          showLauncher={false}
        />
      )}

      <AlertDialog
        open={pendingNavigation !== null}
        onOpenChange={(open) => {
          if (!open && !commandPending) setPendingNavigation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved Access changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your Access draft has unsaved changes. Leaving this page will
              discard them.
            </AlertDialogDescription>
            {commandPending ? (
              <p role="status" className="text-muted-foreground text-sm">
                Finish the Access change before continuing.
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setPendingNavigation(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={commandPending}
              onClick={discardAndContinueNavigation}
            >
              Discard and continue
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
