"use client";

import { createContext, useContext, type ReactNode } from "react";
import { clearAccessDraftStorageExcept } from "../../access/state/draft-journal";

const VerifiedWorkspaceIdentityContext = createContext<string | null>(null);
const WORKSPACE_SNAPSHOT_KEY = "openslate.sample.v1";
const sessionClearListeners = new Map<string, Set<() => void>>();

export function VerifiedWorkspaceIdentityProvider({
  userId,
  children,
}: {
  userId: string | null;
  children: ReactNode;
}) {
  return (
    <VerifiedWorkspaceIdentityContext.Provider value={userId}>
      {children}
    </VerifiedWorkspaceIdentityContext.Provider>
  );
}

export function useVerifiedWorkspaceUserId(): string {
  const userId = useContext(VerifiedWorkspaceIdentityContext);
  if (userId === null)
    throw new Error("Workspace state requires a verified identity");
  return userId;
}

export function workspaceSessionSnapshotStorageKey(userId: string): string {
  return `${WORKSPACE_SNAPSHOT_KEY}.${encodeURIComponent(userId)}`;
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
): Promise<void> {
  // An account change or lost session must not leave another account's Access
  // form values in this tab, even when a reload lost the in-memory user ID.
  clearAccessDraftStorageExcept(null);
  if (userId === null) return Promise.resolve();
  try {
    sessionStorage.removeItem(workspaceSessionSnapshotStorageKey(userId));
  } catch {
    // Session cleanup remains available when browser storage is unavailable.
  }
  for (const clear of sessionClearListeners.get(userId) ?? []) clear();
  return import("../../comms/state/draft-text")
    .then(({ clearCommsDraftTextStore }) => clearCommsDraftTextStore(userId))
    .catch(() => undefined);
}

export function clearAccessDraftsForAccountChange(): boolean {
  return clearAccessDraftStorageExcept(null);
}

export function keepAccessDraftsForVerifiedWorkspaceUser(
  userId: string,
): boolean {
  return clearAccessDraftStorageExcept(userId);
}
