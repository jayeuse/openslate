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

type DraftState = {
  dirty: boolean;
  pending?: boolean;
  discard: () => boolean | void;
};

type DraftStateRef = { current: DraftState };

type DraftRegistry = {
  register: (id: string, state: DraftStateRef) => () => void;
  update: (
    id: string,
    state: DraftStateRef,
    dirty: boolean,
    pending: boolean,
  ) => void;
};

type DraftNavigation = {
  hasUnsavedDraft: boolean;
  hasPendingOperation: boolean;
  discardUnsavedDrafts: () => boolean;
};

const DraftRegistryContext = createContext<DraftRegistry | null>(null);
const DraftNavigationContext = createContext<DraftNavigation | null>(null);

export function AccessDraftNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const drafts = useRef(new Map<string, DraftStateRef>());
  const [dirtyDraftIds, setDirtyDraftIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const update = useCallback(
    (id: string, state: DraftStateRef, dirty: boolean, pending: boolean) => {
      if (drafts.current.get(id) !== state) return;
      setPendingIds((current) => {
        if (current.has(id) === pending) return current;
        const next = new Set(current);
        if (pending) next.add(id);
        else next.delete(id);
        return next;
      });
      setDirtyDraftIds((current) => {
        if (current.has(id) === dirty) return current;
        const next = new Set(current);
        if (dirty) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [],
  );
  const register = useCallback((id: string, state: DraftStateRef) => {
    drafts.current.set(id, state);
    setPendingIds((current) => {
      const next = new Set(current);
      if (state.current.pending) next.add(id);
      else next.delete(id);
      return next;
    });
    setDirtyDraftIds((current) => {
      if (current.has(id) === state.current.dirty) return current;
      const next = new Set(current);
      if (state.current.dirty) next.add(id);
      else next.delete(id);
      return next;
    });
    return () => {
      if (drafts.current.get(id) !== state) return;
      drafts.current.delete(id);
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setDirtyDraftIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    };
  }, []);
  const registry = useMemo(() => ({ register, update }), [register, update]);
  const hasUnsavedDraft = dirtyDraftIds.size > 0;
  const hasPendingOperation = pendingIds.size > 0;
  const discardUnsavedDrafts = useCallback(() => {
    for (const draft of drafts.current.values()) {
      if (draft.current.pending) return false;
      if (draft.current.dirty && draft.current.discard() === false)
        return false;
    }
    return true;
  }, []);
  const navigation = useMemo(
    () => ({ hasUnsavedDraft, hasPendingOperation, discardUnsavedDrafts }),
    [discardUnsavedDrafts, hasUnsavedDraft, hasPendingOperation],
  );

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

export function useAccessDraftRegistration(
  id: string,
  dirty: boolean,
  discard: () => boolean | void,
  pending = false,
) {
  const registry = useContext(DraftRegistryContext);
  if (!registry) {
    throw new Error(
      "useAccessDraftRegistration must be used within AccessDraftNavigationProvider.",
    );
  }

  const state = useRef({ dirty, discard, pending });
  const previousDirty = useRef(dirty);
  const previousPending = useRef(pending);

  useEffect(() => registry.register(id, state), [id, registry]);
  useEffect(() => {
    state.current = { dirty, discard, pending };
    if (
      previousDirty.current !== dirty ||
      previousPending.current !== pending
    ) {
      previousDirty.current = dirty;
      previousPending.current = pending;
      registry.update(id, state, dirty, pending);
    }
  }, [dirty, discard, id, registry, state, pending]);
}
