"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";

import {
  discardDraftsIn,
  everyDraft,
  type DraftScope,
  type RegisteredDraft,
} from "./draft-registry";
import { removeSingleSlotDrafts } from "./draft-journal-storage";

type DraftStateRef = { current: RegisteredDraft };
type DraftFlags = Pick<RegisteredDraft, "dirty" | "pending">;

type DraftRegistry = {
  register: (id: string, state: DraftStateRef) => () => void;
  update: (id: string, state: DraftStateRef) => void;
};

type DraftNavigation = {
  hasUnsavedDraft: boolean;
  hasPendingOperation: boolean;
  unsavedIn: (scope: DraftScope) => boolean;
  pendingIn: (scope: DraftScope) => boolean;
  /** Discards the drafts in `scope` (every draft when omitted). */
  discardUnsavedDrafts: (scope?: DraftScope) => boolean;
};

const DraftRegistryContext = createContext<DraftRegistry | null>(null);
const DraftNavigationContext = createContext<DraftNavigation | null>(null);
const AccessVerifyingContext = createContext(false);

/** Why a submit waits while the page checks the role again. */
export const verifyingReason = "Checking your access.";

/**
 * True while Access checks the signed-in role again after a window return.
 * The page content is inert then, but sheets and dialogs render in portals
 * outside it, so their submit buttons read this and wait.
 */
export function AccessVerifyingProvider({
  verifying,
  children,
}: {
  verifying: boolean;
  children: ReactNode;
}) {
  return (
    <AccessVerifyingContext.Provider value={verifying}>
      {children}
    </AccessVerifyingContext.Provider>
  );
}

export function useAccessVerifying(): boolean {
  return useContext(AccessVerifyingContext);
}

function flagsOf(draft: RegisteredDraft): DraftFlags {
  return { dirty: draft.dirty, pending: draft.pending };
}

function sameFlags(left: DraftFlags | undefined, right: DraftFlags) {
  return (
    left !== undefined &&
    left.dirty === right.dirty &&
    left.pending === right.pending
  );
}

export function AccessDraftNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const userId = useVerifiedWorkspaceUserId();
  // The earlier journal kept one person and one group draft per account;
  // per-target slots replaced it, so its records are removed.
  useEffect(() => removeSingleSlotDrafts(userId), [userId]);
  const drafts = useRef(new Map<string, DraftStateRef>());
  const [flags, setFlags] = useState<ReadonlyMap<string, DraftFlags>>(
    () => new Map(),
  );
  const publish = useCallback((id: string, next: DraftFlags | null) => {
    setFlags((current) => {
      if (next === null ? !current.has(id) : sameFlags(current.get(id), next))
        return current;
      const copy = new Map(current);
      if (next === null) copy.delete(id);
      else copy.set(id, next);
      return copy;
    });
  }, []);
  const update = useCallback(
    (id: string, state: DraftStateRef) => {
      if (drafts.current.get(id) !== state) return;
      publish(id, flagsOf(state.current));
    },
    [publish],
  );
  const register = useCallback(
    (id: string, state: DraftStateRef) => {
      drafts.current.set(id, state);
      publish(id, flagsOf(state.current));
      return () => {
        if (drafts.current.get(id) !== state) return;
        drafts.current.delete(id);
        publish(id, null);
      };
    },
    [publish],
  );
  const registry = useMemo(() => ({ register, update }), [register, update]);
  const discardUnsavedDrafts = useCallback(
    (scope: DraftScope = everyDraft) =>
      discardDraftsIn(
        [...drafts.current].map(([id, state]) => [id, state.current] as const),
        scope,
      ),
    [],
  );
  const navigation = useMemo<DraftNavigation>(() => {
    const entries = [...flags];
    const unsavedIn = (scope: DraftScope) =>
      entries.some(([id, draft]) => scope(id) && draft.dirty);
    const pendingIn = (scope: DraftScope) =>
      entries.some(([id, draft]) => scope(id) && draft.pending);
    return {
      hasUnsavedDraft: unsavedIn(everyDraft),
      hasPendingOperation: pendingIn(everyDraft),
      unsavedIn,
      pendingIn,
      discardUnsavedDrafts,
    };
  }, [flags, discardUnsavedDrafts]);

  return (
    <DraftRegistryContext.Provider value={registry}>
      <DraftNavigationContext.Provider value={navigation}>
        {children}
      </DraftNavigationContext.Provider>
    </DraftRegistryContext.Provider>
  );
}

export function useAccessDraftNavigation(): DraftNavigation {
  const navigation = useContext(DraftNavigationContext);
  if (!navigation) {
    throw new Error(
      "useAccessDraftNavigation must be used within AccessDraftNavigationProvider.",
    );
  }
  return navigation;
}

/**
 * Registers one editor's draft with the page guards. `dirty` edits can be
 * discarded; a `pending` save holds every guard until it ends.
 */
export function useAccessDraftRegistration(
  id: string,
  {
    dirty,
    discard,
    pending = false,
  }: {
    dirty: boolean;
    discard: () => boolean | void;
    pending?: boolean;
  },
) {
  const registry = useContext(DraftRegistryContext);
  if (!registry) {
    throw new Error(
      "useAccessDraftRegistration must be used within AccessDraftNavigationProvider.",
    );
  }

  const state = useRef<RegisteredDraft>({ dirty, discard, pending });

  useEffect(() => registry.register(id, state), [id, registry]);
  useEffect(() => {
    state.current = { dirty, discard, pending };
    registry.update(id, state);
  }, [dirty, discard, id, registry, pending]);
}
