"use client";

import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ShieldCheck } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import {
  GuardedWorkspaceLink,
  useWorkspaceNavigationGuard,
} from "@/components/workspace-navigation-guard";
import {
  accessNavigationFor,
  type AccessNavigation,
} from "@/components/workspace-navigation";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";

import { authMeOptions } from "./adapters/access-queries";
import { DiscardChangesDialog } from "./components/people-fields";
import { GroupsView } from "./components/groups-view";
import { OverviewView } from "./components/overview-view";
import { SecurityView } from "./components/security-view";
import { PeopleView } from "./components/people-view";
import {
  AccessDraftNavigationProvider,
  useAccessDraftNavigation,
} from "./state/draft-navigation";

const accessViews = {
  security: {
    title: "Security",
    description:
      "Review account policy, sign-in sessions and recorded security events across your organization.",
  },
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
  const userId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const queryClient = useQueryClient();
  const [roleAwaitingVerification, setRoleAwaitingVerification] =
    useState(false);
  const verification = useRef(0);
  const [securityBusy, setSecurityBusy] = useState(false);
  const identity = useQuery({
    ...authMeOptions(),
    enabled: !suspended && !roleAwaitingVerification,
  });
  useLayoutEffect(() => {
    if (suspended) {
      verification.current += 1;
      setRoleAwaitingVerification(true);
    }
  }, [suspended]);
  useEffect(() => {
    if (suspended || !roleAwaitingVerification) return;
    const cycle = verification.current;
    let cancelled = false;
    void queryClient
      .cancelQueries({ queryKey: authMeOptions().queryKey, exact: true })
      .then(() => {
        if (cancelled) return null;
        return queryClient.fetchQuery({ ...authMeOptions(), staleTime: 0 });
      })
      .then((current) => {
        if (
          !cancelled &&
          cycle === verification.current &&
          current?.id === userId
        )
          setRoleAwaitingVerification(false);
      })
      .catch(() => {
        /* A failed fresh identity remains read-only until Retry. */
      });
    return () => {
      cancelled = true;
    };
  }, [suspended, roleAwaitingVerification, queryClient, userId]);
  const trustedIdentity =
    !suspended &&
    !roleAwaitingVerification &&
    !identity.isError &&
    identity.data?.id === userId
      ? identity.data
      : null;
  const access = trustedIdentity ? accessNavigationFor(trustedIdentity) : null;
  const requestedView = searchParams.get("view");
  const navigationBlock = useUnsavedDraftGuard(securityBusy);
  useEffect(() => {
    if (access === "groups" && requestedView !== "groups")
      router.replace(`${pathname}?view=groups` as Route);
  }, [access, pathname, requestedView, router]);
  const view =
    access === null || access === "none" ? null : viewFor(access, searchParams);
  const copy = view === null ? null : accessViews[view];
  const description =
    access === "groups"
      ? "Change who is in the groups you manage."
      : (copy?.description ?? "");
  const identityMismatch =
    !suspended &&
    !roleAwaitingVerification &&
    identity.data !== undefined &&
    identity.data.id !== userId;
  const body =
    identity.isError || identityMismatch ? (
      <div role="alert" className="max-w-lg space-y-4 rounded-lg border p-6">
        <div>
          <h2 className="text-base font-semibold">
            Access data is unavailable
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Your permissions could not be loaded. Try again.
          </p>
        </div>
        <Button
          className="min-h-11"
          onClick={async () => {
            const cycle = verification.current;
            const current = await identity.refetch();
            if (cycle === verification.current && current.data?.id === userId)
              setRoleAwaitingVerification(false);
          }}
        >
          Retry
        </Button>
      </div>
    ) : access === "none" ? (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Access is managed by administrators</EmptyTitle>
          <EmptyDescription>
            Ask an administrator or a department manager to change your groups.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      <LoadingRegion
        loading={identity.isPending || roleAwaitingVerification || suspended}
        label="Loading Access…"
        skeleton={<Skeleton className="h-40 w-full" />}
      >
        {view === "people" ? (
          <PeopleView />
        ) : view === "groups" ? (
          <GroupsView mode={access === "all" ? "admin" : "manager"} />
        ) : view === "overview" ? (
          <OverviewView />
        ) : null}
      </LoadingRegion>
    );
  return (
    <AccessFrame
      title={copy?.title ?? "Access"}
      description={description}
      showSecurityLink={access === "all" && view === "overview"}
    >
      {body}
      <SecurityView
        active={requestedView === "security"}
        admitted={access === "all"}
        onBusyChange={setSecurityBusy}
      />
      {navigationBlock}
    </AccessFrame>
  );
}

type PendingNavigation = { resume: () => void };

/**
 * Holds workspace navigation while an Access editor has unsaved changes and
 * asks before discarding them. A reload or tab close gets the browser's own
 * warning.
 */
function useUnsavedDraftGuard(securityBusy: boolean): ReactNode {
  const { hasUnsavedDraft, hasPendingOperation, discardUnsavedDrafts } =
    useAccessDraftNavigation();
  const [pending, setPending] = useState<PendingNavigation | null>(null);
  const [notice, setNotice] = useState("");

  const guard = useCallback(
    (href: string, resume: () => void) => {
      if (securityBusy || hasPendingOperation) {
        setNotice("Finish the current change before leaving this page.");
        return false;
      }
      if (!hasUnsavedDraft) return true;
      if (new URL(href, window.location.origin).href === window.location.href)
        return true;
      setNotice("");
      setPending({ resume });
      return false;
    },
    [hasUnsavedDraft, securityBusy, hasPendingOperation],
  );
  useWorkspaceNavigationGuard(guard);

  useEffect(() => {
    if (!hasUnsavedDraft && !securityBusy && !hasPendingOperation) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsavedDraft, securityBusy, hasPendingOperation]);

  return (
    <>
      {notice ? (
        <Alert role="status" variant="warning">
          {notice}
        </Alert>
      ) : null}
      <DiscardChangesDialog
        open={pending !== null}
        title="Discard unsaved changes?"
        description="You have changes in Access that are not saved. Leaving this page discards them."
        onKeep={() => setPending(null)}
        onDiscard={() => {
          const next = pending;
          if (!next) return;
          if (hasPendingOperation) {
            setNotice("Finish the current change before leaving this page.");
            setPending(null);
            return;
          }
          if (!discardUnsavedDrafts()) {
            setNotice(
              "Your draft could not be cleared from this browser. Keep editing, or try again.",
            );
            setPending(null);
            return;
          }
          setPending(null);
          next.resume();
        }}
      />
    </>
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
            <GuardedWorkspaceLink href="/access?view=security">
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
