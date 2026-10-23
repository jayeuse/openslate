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

import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
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
  useWorkspaceNavigationGuard,
  type WorkspaceNavigationExit,
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
import { AccessHeaderSlot } from "./components/access-header-actions";
import { DiscardChangesDialog } from "./components/people-fields";
import {
  abandonUncertainDrafts,
  accessDraftsHoldUncertainSave,
} from "./state/draft-journal-storage";
import { GroupsView } from "./components/groups-view";
import { blockedSectionNotice } from "./helpers/blocked-section";
import { OverviewView, useOverviewMeta } from "./components/overview-view";
import { SecurityView } from "./components/security-view";
import { PeopleView } from "./components/people-view";
import {
  AccessDraftNavigationProvider,
  AccessVerifyingProvider,
  useAccessDraftNavigation,
} from "./state/draft-navigation";

const accessViews = {
  security: {
    title: "Security",
    // Security events live in Manage › Audit; the page links there.
    description: "Account policy and sign-in sessions.",
  },
  overview: {
    title: "Access overview",
    // The Overview shows its group and department totals instead.
    description: "",
  },
  // The title and the controls say what People and Groups do.
  people: {
    title: "People",
    description: "",
  },
  groups: {
    title: "Groups",
    description: "",
  },
} as const;

type AccessView = keyof typeof accessViews;

/** Where a department manager's Access page always lands. */
const managerSearch = "view=groups";

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
  // A window return checks the session and the role again. Until that check
  // ends, the last trusted view stays mounted, so open forms, dialogs, tabs
  // and filters survive it. The page content is inert meanwhile; sheets and
  // dialogs render in portals outside it and disable their submit buttons
  // through AccessVerifyingProvider. Another account or organization
  // remounts the page in the shell.
  const verifying = suspended || roleAwaitingVerification;
  const [lastAccess, setLastAccess] = useState<AccessNavigation | null>(null);
  if (access !== null && access !== lastAccess) setLastAccess(access);
  const shownAccess =
    access ?? (verifying && !identity.isError ? lastAccess : null);
  const [blocked, setBlocked] = useState<{
    notice: string;
    from: string;
  } | null>(null);
  const requestedView = searchParams.get("view");
  // Any accepted workspace navigation clears the manager's section line,
  // also a click on the section they are already on.
  const clearBlocked = useCallback(() => setBlocked(null), []);
  const navigationBlock = useUnsavedDraftGuard(
    userId,
    securityBusy,
    clearBlocked,
  );
  useEffect(() => {
    if (access === "groups" && requestedView !== "groups")
      router.replace(`${pathname}?${managerSearch}` as Route);
  }, [access, pathname, requestedView, router]);
  // A manager's link to another section lands on Groups with one line that
  // names the section. The landing keeps it; the next navigation clears it.
  const search = searchParams.toString();
  const asked = access === "groups" ? blockedSectionNotice(searchParams) : null;
  if (asked !== null && blocked?.from !== search)
    setBlocked({ notice: asked, from: search });
  else if (
    asked === null &&
    blocked !== null &&
    search !== blocked.from &&
    search !== managerSearch
  )
    setBlocked(null);
  const view =
    shownAccess === null || shownAccess === "none"
      ? null
      : viewFor(shownAccess, searchParams);
  const copy = view === null ? null : accessViews[view];
  const overviewMeta = useOverviewMeta(view === "overview");
  const description =
    shownAccess === "groups"
      ? "Change who is in the groups you manage."
      : view === "overview"
        ? overviewMeta
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
    ) : shownAccess === "none" ? (
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
        loading={shownAccess === null}
        label="Loading Access…"
        skeleton={<Skeleton className="h-40 w-full" />}
        className={view === "security" ? undefined : "access-fill"}
      >
        <div
          inert={verifying}
          aria-busy={verifying}
          className={view === "security" ? undefined : "access-fill"}
        >
          {view === "groups" && blocked ? (
            <Alert className="mb-3 shrink-0">{blocked.notice}</Alert>
          ) : null}
          {view === "people" ? (
            <PeopleView />
          ) : view === "groups" ? (
            <GroupsView mode={shownAccess === "all" ? "admin" : "manager"} />
          ) : view === "overview" ? (
            <OverviewView />
          ) : null}
        </div>
      </LoadingRegion>
    );
  return (
    <AccessFrame
      title={copy?.title ?? "Access"}
      description={description}
      still={view !== null}
      verifying={verifying}
    >
      <AccessVerifyingProvider verifying={verifying}>
        {body}
      </AccessVerifyingProvider>
      <SecurityView
        active={requestedView === "security"}
        admitted={access === "all"}
        onBusyChange={setSecurityBusy}
      />
      {navigationBlock}
    </AccessFrame>
  );
}

type PendingNavigation = {
  resume: () => void;
  /** Saves that may have completed would be cleared by this exit. */
  unresolved: boolean;
};

const finishFirst = "Finish the current change before leaving this page.";
const discardFailed =
  "Your draft could not be cleared from this browser. Keep editing, or try again.";

/**
 * Holds workspace navigation while an Access editor has unsaved changes and
 * asks before discarding them. A reload or tab close gets the browser's own
 * warning. The shell asks about a save that may have completed before a
 * sign-out or an organization switch; when this page asks first, its
 * Discard forgets those saves too, so only one question shows.
 */
function useUnsavedDraftGuard(
  userId: string,
  securityBusy: boolean,
  onAccepted: () => void,
): ReactNode {
  const { hasUnsavedDraft, hasPendingOperation, discardUnsavedDrafts } =
    useAccessDraftNavigation();
  const [pending, setPending] = useState<PendingNavigation | null>(null);
  const [notice, setNotice] = useState("");
  const [discardError, setDiscardError] = useState("");
  // The wait notice ends with the change it waited for.
  if (notice === finishFirst && !securityBusy && !hasPendingOperation)
    setNotice("");

  const guard = useCallback(
    (href: string, resume: () => void, exit?: WorkspaceNavigationExit) => {
      if (securityBusy || hasPendingOperation) {
        setNotice(finishFirst);
        return false;
      }
      if (
        !hasUnsavedDraft ||
        new URL(href, window.location.origin).href === window.location.href
      ) {
        onAccepted();
        return true;
      }
      setNotice("");
      setDiscardError("");
      setPending({
        resume: () => {
          onAccepted();
          resume();
        },
        unresolved: exit !== undefined && accessDraftsHoldUncertainSave(userId),
      });
      return false;
    },
    [hasUnsavedDraft, securityBusy, hasPendingOperation, userId, onAccepted],
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
        error={discardError}
        onKeep={() => setPending(null)}
        onDiscard={() => {
          const next = pending;
          if (!next) return;
          if (hasPendingOperation) {
            setNotice(finishFirst);
            setPending(null);
            return;
          }
          if (
            !discardUnsavedDrafts() ||
            (next.unresolved && !abandonUncertainDrafts(userId))
          ) {
            setDiscardError(discardFailed);
            return;
          }
          setPending(null);
          next.resume();
        }}
      />
    </>
  );
}

/**
 * The Access page. `access-ui` scopes the slim controls (globals.css). A
 * still view (every view) never scrolls from 1280px: its body shrinks to
 * the viewport and only its panels or table scroll. Narrower screens scroll
 * the body. The title is the shared PageHeader; its margin is the gap.
 */
function AccessFrame({
  title,
  description,
  still = false,
  verifying = false,
  children,
}: {
  title: string;
  description: string;
  still?: boolean;
  /** Header actions wait, like the page content, while the role is checked. */
  verifying?: boolean;
  children?: ReactNode;
}) {
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  return (
    <div className="access-ui flex h-full min-h-0 min-w-0 flex-col p-3 sm:px-5 sm:py-4">
      <div className="shrink-0">
        <PageHeader
          title={title}
          description={description}
          actions={
            <div
              ref={setActions}
              inert={verifying}
              aria-busy={verifying || undefined}
              className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 empty:hidden sm:w-auto sm:justify-end"
            />
          }
        />
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain",
          still && "xl:flex xl:flex-col xl:gap-3 xl:overflow-hidden",
        )}
      >
        <AccessHeaderSlot value={actions}>{children}</AccessHeaderSlot>
      </div>
    </div>
  );
}
