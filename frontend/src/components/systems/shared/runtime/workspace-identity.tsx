"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { clearAccessDraftStorageExcept } from "../../access/state/draft-journal-storage";
import {
  bindWorkspaceConnections,
  pauseWorkspaceConnections,
} from "../adapters/connection-set";

const VerifiedWorkspaceIdentityContext = createContext<string | null>(null);
const VerifiedWorkspaceOrganizationContext = createContext<string | null>(null);
const WorkspaceInteractionSuspendedContext = createContext(false);
const WorkspaceSignOutContext = createContext<(() => Promise<void>) | null>(
  null,
);
const WORKSPACE_SNAPSHOT_KEY = "openslate.sample.v2";
const sessionClearListeners = new Map<string, Set<() => void>>();

export function WorkspaceSignOutProvider({
  complete,
  children,
}: {
  complete: () => Promise<void>;
  children: ReactNode;
}) {
  return (
    <WorkspaceSignOutContext.Provider value={complete}>
      {children}
    </WorkspaceSignOutContext.Provider>
  );
}

export function useWorkspaceSignOut(): () => Promise<void> {
  const complete = useContext(WorkspaceSignOutContext);
  if (!complete)
    throw new Error("Sign-out completion requires the workspace shell");
  return complete;
}

export function VerifiedWorkspaceIdentityProvider({
  userId,
  organizationId = null,
  children,
  suspended = false,
}: {
  userId: string | null;
  /** The admitted organization, never the pending tab selection. */
  organizationId?: string | null;
  children: ReactNode;
  suspended?: boolean;
}) {
  useLayoutEffect(() => {
    const stop = bindWorkspaceConnections(userId, organizationId);
    const unregister = userId
      ? registerWorkspaceSessionClear(userId, stop)
      : () => {};
    return () => {
      unregister();
      stop();
    };
  }, [userId, organizationId]);
  useLayoutEffect(
    () => pauseWorkspaceConnections(suspended),
    [suspended, userId, organizationId],
  );
  return (
    <VerifiedWorkspaceIdentityContext.Provider value={userId}>
      <VerifiedWorkspaceOrganizationContext.Provider value={organizationId}>
        <WorkspaceInteractionSuspendedContext.Provider value={suspended}>
          {children}
        </WorkspaceInteractionSuspendedContext.Provider>
      </VerifiedWorkspaceOrganizationContext.Provider>
    </VerifiedWorkspaceIdentityContext.Provider>
  );
}

export function useWorkspaceInteractionSuspended(): boolean {
  return useContext(WorkspaceInteractionSuspendedContext);
}

export function useVerifiedWorkspaceUserId(): string {
  const userId = useContext(VerifiedWorkspaceIdentityContext);
  if (userId === null)
    throw new Error("Workspace state requires a verified identity");
  return userId;
}

export function useVerifiedWorkspaceOrganizationId(): string {
  const organizationId = useContext(VerifiedWorkspaceOrganizationContext);
  if (organizationId === null)
    throw new Error("Workspace state requires an admitted organization");
  return organizationId;
}

export function workspaceSessionSnapshotStorageKey(
  userId: string,
  organizationId: string,
): string {
  return `${WORKSPACE_SNAPSHOT_KEY}.${encodeURIComponent(userId)}.${encodeURIComponent(organizationId)}`;
}

export function registerWorkspaceSessionClear(
  userId: string,
  listener: () => void,
): () => void {
  const listeners = sessionClearListeners.get(userId) ?? new Set<() => void>();
  listeners.add(listener);
  sessionClearListeners.set(userId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) sessionClearListeners.delete(userId);
  };
}

export function clearVerifiedWorkspaceSessionSnapshot(
  userId: string | null,
): Promise<boolean> {
  // Capture mounted stores before the shell conceals/unmounts the workspace.
  // Defer cleanup so it can latch Signed out before any cleanup runs.
  const listeners =
    userId === null ? [] : [...(sessionClearListeners.get(userId) ?? [])];
  return Promise.resolve().then(async () => {
    let cleared = clearAccessDraftStorageExcept(null);
    if (userId === null) return cleared;
    const keys = new Set([`openslate.sample.v1.${encodeURIComponent(userId)}`]);
    try {
      const prefix = `${WORKSPACE_SNAPSHOT_KEY}.${encodeURIComponent(userId)}.`;
      for (let index = 0; index < sessionStorage.length; index++) {
        const key = sessionStorage.key(index);
        if (key?.startsWith(prefix)) keys.add(key);
      }
    } catch {
      cleared = false;
    }
    for (const key of keys) {
      try {
        sessionStorage.removeItem(key);
      } catch {
        cleared = false;
      }
    }
    for (const clear of listeners) {
      try {
        clear();
      } catch {
        cleared = false;
      }
    }
    try {
      const { clearCommsDraftTextStore } =
        await import("../../comms/state/draft-text");
      if (!clearCommsDraftTextStore(userId)) cleared = false;
    } catch {
      cleared = false;
    }
    return cleared;
  });
}

export function clearAccessDraftsForAccountChange(): boolean {
  return clearAccessDraftStorageExcept(null);
}

export function keepAccessDraftsForVerifiedWorkspaceUser(
  userId: string,
): boolean {
  return clearAccessDraftStorageExcept(userId);
}
