"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { ComponentProps, ReactNode } from "react";
import { reportError } from "@/lib/feedback";

export type WorkspaceNavigationGuard = (
  href: string,
  resume: () => void,
) => boolean;

type WorkspaceNavigationGuardContextValue = {
  requestNavigation: (href: string, resume: () => void) => boolean;
  registerGuard: (guard: WorkspaceNavigationGuard) => () => void;
  openOrganization?: (orgId: string) => Promise<void>;
};

const WorkspaceNavigationGuardContext =
  createContext<WorkspaceNavigationGuardContextValue | null>(null);

const acceptNavigation: WorkspaceNavigationGuard = () => true;

export function WorkspaceNavigationGuardProvider({
  children,
  onAcceptedNavigation,
  onOpenOrganization,
}: {
  children: ReactNode;
  onAcceptedNavigation: () => void;
  onOpenOrganization?: (orgId: string) => Promise<void>;
}) {
  const guardRef = useRef<{ token: symbol; guard: WorkspaceNavigationGuard }>({
    token: Symbol("default-workspace-navigation-guard"),
    guard: acceptNavigation,
  });

  const value = useMemo<WorkspaceNavigationGuardContextValue>(
    () => ({
      openOrganization: onOpenOrganization,
      requestNavigation: (href, resume) => {
        let resumed = false;
        const guardedResume = () => {
          if (resumed) return;
          resumed = true;
          onAcceptedNavigation();
          resume();
        };
        const accepted = guardRef.current.guard(href, guardedResume);
        if (accepted) onAcceptedNavigation();
        return accepted;
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
    }),
    [onAcceptedNavigation, onOpenOrganization],
  );

  return (
    <WorkspaceNavigationGuardContext.Provider value={value}>
      {children}
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
          if (requestNavigation(href, resume)) resume();
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
