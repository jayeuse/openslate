"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentProps, ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  abandonUncertainDrafts,
  accessDraftsHoldUncertainSave,
} from "@/components/systems/access/state/draft-journal-storage";
import {
  organizationLinkExit,
  type WorkspaceNavigationExit,
} from "@/components/workspace-navigation";
import { reportError } from "@/lib/feedback";

export type { WorkspaceNavigationExit };

export type WorkspaceNavigationGuard = (
  href: string,
  resume: () => void,
  exit?: WorkspaceNavigationExit,
) => boolean;

type WorkspaceNavigationGuardContextValue = {
  requestNavigation: (
    href: string,
    resume: () => void,
    exit?: WorkspaceNavigationExit,
  ) => boolean;
  registerGuard: (guard: WorkspaceNavigationGuard) => () => void;
  openOrganization?: (orgId: string) => Promise<void>;
  /** The open organization, so a link can tell a switch from a visit. */
  organizationId: string | null;
};

const WorkspaceNavigationGuardContext =
  createContext<WorkspaceNavigationGuardContextValue | null>(null);

const acceptNavigation: WorkspaceNavigationGuard = () => true;

export function WorkspaceNavigationGuardProvider({
  children,
  onAcceptedNavigation,
  onOpenOrganization,
  userId = null,
  organizationId = null,
}: {
  children: ReactNode;
  onAcceptedNavigation: () => void;
  onOpenOrganization?: (orgId: string) => Promise<void>;
  /** The signed-in account whose saved Access drafts a sign-out or switch clears. */
  userId?: string | null;
  organizationId?: string | null;
}) {
  const guardRef = useRef<{ token: symbol; guard: WorkspaceNavigationGuard }>({
    token: Symbol("default-workspace-navigation-guard"),
    guard: acceptNavigation,
  });
  // A sign-out or an organization switch waiting on the question about an
  // Access save that may have completed.
  const [unresolvedExit, setUnresolvedExit] = useState<{
    proceed: () => void;
  } | null>(null);
  const [discardFailed, setDiscardFailed] = useState(false);

  const value = useMemo<WorkspaceNavigationGuardContextValue>(() => {
    // An Access save that may have completed stays in the tab's journal on
    // every page, and a sign-out or an organization switch clears that
    // journal. The shell asks, so the question comes whatever page is open.
    const asksFirst = (exit: WorkspaceNavigationExit | undefined) =>
      exit !== undefined &&
      userId !== null &&
      accessDraftsHoldUncertainSave(userId);
    return {
      openOrganization: onOpenOrganization,
      organizationId,
      requestNavigation: (href, resume, exit) => {
        let resumed = false;
        const finish = () => {
          if (resumed) return;
          resumed = true;
          onAcceptedNavigation();
          resume();
        };
        // The page asks about its open edits first; a page that discards
        // them also forgets the Access saves, so only one question shows.
        const afterPage = () => {
          if (!asksFirst(exit)) {
            finish();
            return;
          }
          setDiscardFailed(false);
          setUnresolvedExit({ proceed: finish });
        };
        if (!guardRef.current.guard(href, afterPage, exit)) return false;
        if (asksFirst(exit)) {
          setDiscardFailed(false);
          setUnresolvedExit({ proceed: finish });
          return false;
        }
        onAcceptedNavigation();
        return true;
      },
      registerGuard: (guard) => {
        const token = Symbol("workspace-navigation-guard");
        guardRef.current = { token, guard };
        return () => {
          if (guardRef.current.token !== token) return;
          guardRef.current = {
            token: Symbol("default-workspace-navigation-guard"),
            guard: acceptNavigation,
          };
        };
      },
    };
  }, [onAcceptedNavigation, onOpenOrganization, organizationId, userId]);

  return (
    <WorkspaceNavigationGuardContext.Provider value={value}>
      {children}
      <AlertDialog
        open={unresolvedExit !== null}
        onOpenChange={(open) => !open && setUnresolvedExit(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              A change in Access may not have been saved. Leaving this page
              discards it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {discardFailed ? (
            <p role="alert" className="text-destructive text-sm">
              Your draft could not be cleared from this browser. Keep editing,
              or try again.
            </p>
          ) : null}
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setUnresolvedExit(null)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              onClick={() => {
                const next = unresolvedExit;
                if (!next || userId === null) return;
                if (!abandonUncertainDrafts(userId)) {
                  setDiscardFailed(true);
                  return;
                }
                setUnresolvedExit(null);
                next.proceed();
              }}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </WorkspaceNavigationGuardContext.Provider>
  );
}

export function useWorkspaceNavigationGuard(guard: WorkspaceNavigationGuard) {
  const context = useContext(WorkspaceNavigationGuardContext);
  if (!context) {
    throw new Error(
      "useWorkspaceNavigationGuard must be used within WorkspaceNavigationGuardProvider.",
    );
  }

  useEffect(() => context.registerGuard(guard), [context, guard]);
}

export function useWorkspaceNavigationRequest() {
  const context = useContext(WorkspaceNavigationGuardContext);
  if (!context) {
    throw new Error(
      "useWorkspaceNavigationRequest must be used within WorkspaceNavigationGuardProvider.",
    );
  }
  return context.requestNavigation;
}

type GuardedWorkspaceLinkProps = Omit<
  ComponentProps<typeof Link>,
  "href" | "onNavigate"
> & {
  href: Route;
  onAcceptedNavigate?: () => void;
  /** Current-tab notification navigation only; native links keep their usual context. */
  organizationId?: string;
};

export function GuardedWorkspaceLink({
  href,
  onAcceptedNavigate,
  organizationId,
  ...props
}: GuardedWorkspaceLinkProps) {
  const router = useRouter();
  const requestNavigation = useWorkspaceNavigationRequest();
  const context = useContext(WorkspaceNavigationGuardContext);
  const active = useRef(true);
  const opening = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  return (
    <Link
      {...props}
      href={href}
      onNavigate={(event) => {
        if (organizationId) {
          event.preventDefault();
          const resume = () => {
            if (!active.current || opening.current) return;
            opening.current = true;
            void (async () => {
              try {
                if (!context?.openOrganization)
                  throw new Error("No organization boundary");
                await context.openOrganization(organizationId);
                onAcceptedNavigate?.();
                router.push(href);
              } catch {
                if (active.current)
                  reportError("Could not open the notification. Try again.");
              } finally {
                opening.current = false;
              }
            })();
          };
          const exit = organizationLinkExit(
            organizationId,
            context?.organizationId ?? null,
          );
          if (requestNavigation(href, resume, exit)) resume();
          return;
        }
        const resume = () => {
          onAcceptedNavigate?.();
          router.push(href);
        };
        const accepted = requestNavigation(href, resume);
        if (!accepted) {
          event.preventDefault();
          return;
        }
        onAcceptedNavigate?.();
      }}
    />
  );
}
