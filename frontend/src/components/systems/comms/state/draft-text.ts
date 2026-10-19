"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";

export const COMMS_DRAFT_TEXT_PREFIX = "openslate.sample.draft-text.v2.";

export type CommsDraftTextSnapshot = {
  value: string;
  storageUnavailable: boolean;
  legacyPending: boolean;
  /** Increments only when the text value changes. */
  revision: number;
};

export type CommsDraftTextStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  readonly length?: number;
  key?: (index: number) => string | null;
};

export type CommsDraftTextCleanup = () => void | Promise<void>;

type DraftTextStore = {
  readonly storage?: CommsDraftTextStorage;
  readonly storageKey: string;
  getSnapshot: () => CommsDraftTextSnapshot;
  subscribe: (listener: () => void) => () => void;
  setValue: (action: SetStateAction<string>) => void;
  migrate: (cleanup?: CommsDraftTextCleanup) => () => void;
  clear: (
    expectedRevision?: number,
    cleanup?: CommsDraftTextCleanup,
  ) => Promise<boolean>;
  reset: () => void;
  applyStorageValue: (value: string | null) => void;
};

const entries = new Map<string, DraftTextStore>();
const knownComposerIds = new Set<string>();
const emptySnapshot: CommsDraftTextSnapshot = {
  value: "",
  storageUnavailable: false,
  legacyPending: false,
  revision: 0,
};

export function commsDraftTextKey(id: string): string {
  return `${COMMS_DRAFT_TEXT_PREFIX}${encodeURIComponent(id)}`;
}

export function ownedCommsDraftTextId(
  userId: string,
  composerId: string,
  organizationId: string,
): string {
  return `${userId}:${organizationId}:${composerId}`;
}

export function legacyCommsDraftTextKey(id: string): string {
  return `comms-draft-text-${id}`;
}

function browserSessionStorage(): CommsDraftTextStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
}

function readStoredValue(
  storage: CommsDraftTextStorage | undefined,
  key: string,
): { value: string | null; unavailable: boolean } {
  if (!storage)
    return { value: null, unavailable: typeof window !== "undefined" };
  try {
    return { value: storage.getItem(key), unavailable: false };
  } catch {
    return { value: null, unavailable: true };
  }
}

function writeStoredValue(
  storage: CommsDraftTextStorage | undefined,
  key: string,
  value: string,
): boolean {
  if (!storage) return typeof window === "undefined";
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStoredValue(
  storage: CommsDraftTextStorage | undefined,
  key: string,
): boolean {
  if (!storage) return typeof window === "undefined";
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function notify(listeners: Set<() => void>): void {
  for (const listener of listeners) listener();
}

function createCommsDraftTextStore(
  id: string,
  legacyValue: string,
  storage: CommsDraftTextStorage | undefined = browserSessionStorage(),
  afterFailedReset = false,
): DraftTextStore {
  const storageKey = commsDraftTextKey(id);
  // This generation must not adopt bytes that its predecessor could not erase.
  const stored = afterFailedReset
    ? { value: null, unavailable: true }
    : readStoredValue(storage, storageKey);
  function decode(raw: string | null): string | null {
    if (raw === null) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        value.id === id &&
        "value" in value &&
        typeof value.value === "string"
      )
        return value.value;
    } catch {
      // Unowned, swapped or malformed text is never adopted into this composer.
    }
    return null;
  }
  const encode = (value: string) => JSON.stringify({ id, value });
  const hasDedicatedValue = stored.value !== null;
  let snapshot: CommsDraftTextSnapshot = {
    value: hasDedicatedValue ? (decode(stored.value) ?? "") : legacyValue,
    storageUnavailable: stored.unavailable,
    legacyPending: !hasDedicatedValue && legacyValue.length > 0,
    revision: 0,
  };
  const listeners = new Set<() => void>();
  let lifecycle = 0;
  let retired = false;
  let cleanupSequence = 0;
  let pendingCleanup: { token: number; promise: Promise<boolean> } | undefined;

  function publish(
    patch: Partial<Omit<CommsDraftTextSnapshot, "revision">>,
    valueChanged = false,
  ): void {
    const next: CommsDraftTextSnapshot = {
      ...snapshot,
      ...patch,
      revision: snapshot.revision + (valueChanged ? 1 : 0),
    };
    if (
      next.value === snapshot.value &&
      next.storageUnavailable === snapshot.storageUnavailable &&
      next.legacyPending === snapshot.legacyPending &&
      next.revision === snapshot.revision
    )
      return;
    snapshot = next;
    notify(listeners);
  }

  function cleanupPromise(
    cleanup: CommsDraftTextCleanup | undefined,
  ): Promise<boolean> {
    if (!cleanup) return Promise.resolve(true);
    if (pendingCleanup) return pendingCleanup.promise;
    const token = ++cleanupSequence;
    const promise = Promise.resolve()
      .then(cleanup)
      .then(
        () => true,
        () => false,
      );
    pendingCleanup = { token, promise };
    void promise.then(() => {
      if (pendingCleanup?.token === token) pendingCleanup = undefined;
    });
    return promise;
  }

  function migrate(cleanup?: CommsDraftTextCleanup): () => void {
    if (retired || !snapshot.legacyPending) return () => undefined;
    if (!writeStoredValue(storage, storageKey, encode(snapshot.value))) {
      publish({ storageUnavailable: true });
      return () => undefined;
    }
    if (!cleanup) {
      publish({ legacyPending: false, storageUnavailable: false });
      return () => undefined;
    }

    const startLifecycle = lifecycle;
    let active = true;
    void cleanupPromise(cleanup).then((success) => {
      if (!active || lifecycle !== startLifecycle) return;
      if (success) publish({ legacyPending: false });
      else publish({ storageUnavailable: true });
    });
    return () => {
      active = false;
    };
  }

  async function clear(
    expectedRevision = snapshot.revision,
    cleanup?: CommsDraftTextCleanup,
  ): Promise<boolean> {
    if (retired || snapshot.revision !== expectedRevision) return false;
    const startLifecycle = lifecycle;
    const legacyCleared = await cleanupPromise(cleanup);
    if (lifecycle !== startLifecycle || snapshot.revision !== expectedRevision)
      return false;

    const removed = removeStoredValue(storage, storageKey);
    let markerWritten = true;
    if (!removed || !legacyCleared)
      markerWritten = writeStoredValue(storage, storageKey, encode(""));
    publish(
      {
        value: "",
        legacyPending: !legacyCleared,
        storageUnavailable: !removed || !legacyCleared || !markerWritten,
      },
      snapshot.value !== "",
    );
    return true;
  }

  function reset(): void {
    retired = true;
    lifecycle += 1;
    cleanupSequence += 1;
    pendingCleanup = undefined;
    const removed = removeStoredValue(storage, storageKey);
    publish(
      {
        value: "",
        legacyPending: false,
        storageUnavailable: !removed,
      },
      snapshot.value !== "",
    );
  }

  return {
    storage,
    storageKey,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setValue(action: SetStateAction<string>) {
      if (retired) return;
      const nextValue =
        typeof action === "function"
          ? (action as (previous: string) => string)(snapshot.value)
          : action;
      const stored = writeStoredValue(storage, storageKey, encode(nextValue));
      publish(
        {
          value: nextValue,
          storageUnavailable: !stored,
        },
        nextValue !== snapshot.value,
      );
    },
    migrate,
    clear,
    reset,
    applyStorageValue(value: string | null) {
      if (retired || afterFailedReset) return;
      const nextValue = decode(value) ?? "";
      publish(
        {
          value: nextValue,
          legacyPending: false,
          storageUnavailable: false,
        },
        nextValue !== snapshot.value,
      );
    },
  };
}

function entryFor(id: string, legacyValue: string): DraftTextStore {
  knownComposerIds.add(id);
  const existing = entries.get(id);
  if (existing) return existing;
  const entry = createCommsDraftTextStore(id, legacyValue);
  entries.set(id, entry);
  return entry;
}

export interface CommsDraftTextControls {
  storageUnavailable: boolean;
  legacyPending: boolean;
  revision: number;
  clear: (expectedRevision?: number) => Promise<boolean>;
}

/**
 * Subscribe to one composer text value without writing the whole sample
 * workspace snapshot on each keystroke.
 */
export function useCommsDraftText(
  id: string,
  legacyValue: string,
  onLegacyCleanup?: CommsDraftTextCleanup,
): [string, Dispatch<SetStateAction<string>>, CommsDraftTextControls] {
  const entry = entryFor(id, legacyValue);
  const cleanupRef = useRef<CommsDraftTextCleanup | undefined>(onLegacyCleanup);
  const migrationAttempted = useRef(false);
  useEffect(() => {
    cleanupRef.current = onLegacyCleanup;
  }, [onLegacyCleanup]);
  useEffect(() => {
    migrationAttempted.current = false;
  }, [id]);
  const subscribe = useCallback(
    (listener: () => void) => entry.subscribe(listener),
    [entry],
  );
  const getSnapshot = useCallback(() => entry.getSnapshot(), [entry]);
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => emptySnapshot,
  );

  useEffect(() => {
    if (!snapshot.legacyPending || migrationAttempted.current) return;
    migrationAttempted.current = true;
    return entry.migrate(cleanupRef.current);
  }, [entry, snapshot.legacyPending]);

  useEffect(() => {
    if (typeof window === "undefined" || !entry.storage) return;
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== entry.storage || event.key !== entry.storageKey)
        return;
      entry.applyStorageValue(event.newValue);
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [entry]);

  const setValue = useCallback<Dispatch<SetStateAction<string>>>(
    (action) => entry.setValue(action),
    [entry],
  );
  const clear = useCallback(
    (expectedRevision?: number) =>
      entry.clear(expectedRevision, cleanupRef.current),
    [entry],
  );

  return [
    snapshot.value,
    setValue,
    {
      storageUnavailable: snapshot.storageUnavailable,
      legacyPending: snapshot.legacyPending,
      revision: snapshot.revision,
      clear,
    },
  ];
}

/** Clear one account's dedicated draft values during logout/reset. */
export function clearCommsDraftTextStore(
  userId?: string,
  organizationId?: string,
): boolean {
  let cleared = true;
  const ownedIdPrefix =
    userId === undefined
      ? null
      : `${userId}:${organizationId === undefined ? "" : `${organizationId}:`}`;
  for (const [id, entry] of entries) {
    if (ownedIdPrefix !== null && !id.startsWith(ownedIdPrefix)) continue;
    try {
      entry.reset();
      if (entry.getSnapshot().storageUnavailable) {
        cleared = false;
        entries.set(id, createCommsDraftTextStore(id, "", entry.storage, true));
      } else entries.delete(id);
    } catch {
      cleared = false;
    }
  }
  const storage = browserSessionStorage();
  if (!storage && typeof window !== "undefined") cleared = false;
  if (storage?.key && storage.length !== undefined) {
    const keys: string[] = [];
    try {
      const ownedStoragePrefix =
        userId === undefined
          ? COMMS_DRAFT_TEXT_PREFIX
          : `${COMMS_DRAFT_TEXT_PREFIX}${encodeURIComponent(ownedIdPrefix!)}`;
      const legacyPrefix =
        userId === undefined
          ? "openslate.sample.draft-text.v1."
          : `openslate.sample.draft-text.v1.${encodeURIComponent(`${userId}:`)}`;
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (
          key?.startsWith(ownedStoragePrefix) ||
          key?.startsWith(legacyPrefix)
        )
          keys.push(key);
      }
    } catch {
      cleared = false;
    }
    for (const key of keys) {
      try {
        storage.removeItem(key);
      } catch {
        cleared = false;
      }
    }
  }
  if (userId === undefined) {
    entries.clear();
    knownComposerIds.clear();
  } else {
    for (const id of knownComposerIds)
      if (id.startsWith(ownedIdPrefix!)) knownComposerIds.delete(id);
  }
  return cleared;
}

/** @internal Test seam for the keyed store's non-React behavior. */
export { createCommsDraftTextStore };
