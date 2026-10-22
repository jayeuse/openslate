"use client";
import {
  subscribeSharedInvalidations,
  workspaceConnectionAvailable,
} from "./connection-set";

/** Opaque authorized change notices; never row snapshots. */
export type WorkspaceInvalidation =
  | { type: "resync" }
  | { type: "invalidate"; entity: string; moduleId?: string; boardId?: string };

/** Preserve the existing singleton facade and each subscriber's opening resync. */
export function subscribeWorkspaceInvalidations(
  onInvalidation: (event: WorkspaceInvalidation) => void,
  onConnected?: () => void,
): () => void {
  return subscribeSharedInvalidations(onInvalidation, onConnected);
}

export function isWorkspaceStreamAvailable(): boolean {
  return workspaceConnectionAvailable();
}
