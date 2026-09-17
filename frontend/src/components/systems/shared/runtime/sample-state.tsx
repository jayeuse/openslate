"use client";

import {
  createContext,
  Component,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  createSampleRuntime,
  type SampleDraft,
  type SampleRuntime,
} from "./sample-runtime";
import { Button } from "@/components/ui/button";
import { releaseAllLocalAttachments } from "./local-attachments";
import { clearCommsDraftTextStore } from "../../comms/state/draft-text";
import { useVerifiedWorkspaceUserId } from "./workspace-identity";
import {
  decodeStoredSandboxHistory,
  decodeStoredSandboxVersions,
} from "@/components/systems/sandbox/helpers/stored-history";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  registerWorkspaceSessionClear,
  workspaceSessionSnapshotStorageKey,
} from "./workspace-identity";

type Snapshot = Record<string, unknown>;
type RestoredSampleSessionSnapshot = {
  values: Snapshot;
  recovered: boolean;
};

function isSnapshot(value: unknown): value is Snapshot {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export type SampleTransactionDraft = SampleDraft;
export type SampleTransactionRecipe<T = void> = (
  transaction: SampleTransactionDraft,
) => T;
type SampleContextValue = {
  values: Snapshot;
  update: (key: string, action: (previous: unknown) => unknown) => void;
  transact: <T>(recipe: SampleTransactionRecipe<T>) => T;
  resetKeys: (keys: readonly string[]) => void;
  storageUnavailable: boolean;
  runtime: SampleRuntime;
};
const SampleContext = createContext<SampleContextValue | null>(null);
export function serializeSampleSessionSnapshot(
  userId: string,
  values: Snapshot,
): string {
  return JSON.stringify({ userId, values });
}

export function sampleSessionSnapshotStorageKey(userId: string): string {
  return workspaceSessionSnapshotStorageKey(userId);
}

export function restoreSampleSessionSnapshot(
  raw: string | null,
  userId: string,
): RestoredSampleSessionSnapshot {
  if (raw === null) return { values: {}, recovered: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isSnapshot(parsed) &&
      typeof parsed.userId === "string" &&
      parsed.userId === userId &&
      isSnapshot(parsed.values)
    )
      return {
        values: parsed.values,
        recovered: false,
      };
    // Legacy or differently owned data cannot be associated with this session.
    return { values: {}, recovered: false };
  } catch {
    return { values: {}, recovered: true };
  }
}

class SampleRecovery extends Component<
  { children: ReactNode; onReset: (opener: HTMLButtonElement) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <section role="alert" className="rounded-lg border p-6">
          <h1 className="text-xl font-semibold">
            Workspace data could not be opened
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Reset the saved workspace data to restore the default records.
          </p>
          <Button
            className="mt-4"
            onClick={(event) => this.props.onReset(event.currentTarget)}
          >
            Reset workspace data
          </Button>
        </section>
      );
    return this.props.children;
  }
}

// Stored content is only synthetic UI data. Reject incompatible values before
// they reach a screen; additions to defaults safely invalidate stale snapshots.
function compatible<T>(value: unknown, initial: T): value is T {
  if (initial === null) return value === null || typeof value === "object";
  if (Array.isArray(initial))
    return (
      Array.isArray(value) &&
      (initial.length === 0 ||
        value.every((entry) => compatible(entry, initial[0])))
    );
  if (typeof initial === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return false;
    return Object.entries(initial).every(
      ([key, entry]) =>
        key in value && compatible((value as Snapshot)[key], entry),
    );
  }
  return typeof value === typeof initial;
}

export function decodeSampleStoredValue<T>(
  key: string,
  value: unknown,
  initial: T,
): T {
  if (key === "sandbox.design")
    return decodeStoredSandboxHistory(value) === null ? initial : (value as T);
  if (key === "sandbox.versions") {
    const decoded = decodeStoredSandboxVersions(value);
    return decoded === null ? initial : (decoded as T);
  }
  return compatible(value, initial) ? value : initial;
}

export function applySampleTransaction(
  previous: Readonly<Snapshot>,
  recipe: SampleTransactionRecipe,
): Snapshot {
  const runtime = createSampleRuntime(decodeSampleStoredValue, previous);
  runtime.commit(recipe);
  return { ...runtime.getSnapshot() };
}

export function SampleProvider({ children }: { children: ReactNode }) {
  const userId = useVerifiedWorkspaceUserId();
  return (
    <SampleProviderForUser key={userId} userId={userId}>
      {children}
    </SampleProviderForUser>
  );
}

function SampleProviderForUser({
  children,
  userId,
}: {
  children: ReactNode;
  userId: string;
}) {
  const storageKey = sampleSessionSnapshotStorageKey(userId);
  const [runtime] = useState(() =>
    createSampleRuntime(decodeSampleStoredValue),
  );
  const values = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getServerSnapshot,
  );
  const [ready, setReady] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const persistenceSuspended = useRef(false);
  const resetOpener = useRef<HTMLButtonElement | null>(null);
  const clearOwnedSnapshot = useCallback(() => {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // Workspace reset remains available when browser storage is unavailable.
    }
  }, [storageKey]);
  function requestReset(opener: HTMLButtonElement) {
    resetOpener.current = opener;
    setConfirmReset(true);
  }
  useEffect(() => {
    const clear = () => {
      persistenceSuspended.current = true;
      runtime.reset();
    };
    return registerWorkspaceSessionClear(userId, clear);
  }, [runtime, userId]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      const restored = restoreSampleSessionSnapshot(raw, userId);
      runtime.reset(restored.values);
      setRecovered(restored.recovered);
    } catch {
      setStorageUnavailable(true);
    }
    setReady(true);
  }, [runtime, storageKey, userId]);
  useEffect(() => {
    if (!ready || persistenceSuspended.current) return;
    try {
      sessionStorage.setItem(
        storageKey,
        serializeSampleSessionSnapshot(userId, values),
      );
    } catch {
      setStorageUnavailable(true);
    }
  }, [ready, storageKey, userId, values]);
  const update = useCallback(
    (key: string, action: (previous: unknown) => unknown) => {
      runtime.commit((draft) => {
        draft.update<unknown>(
          key,
          undefined,
          action(structuredClone(runtime.getSnapshot()[key])),
        );
      });
    },
    [runtime],
  );
  const transact = runtime.commit;
  const resetKeys = runtime.resetKeys;
  return (
    <SampleContext.Provider
      value={{
        values,
        update,
        transact,
        resetKeys,
        storageUnavailable,
        runtime,
      }}
    >
      {storageUnavailable && (
        <p role="status" className="shrink-0 border-b px-4 py-2 text-sm">
          Changes cannot be saved in this browser.
        </p>
      )}
      {recovered && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-sm"
        >
          <p>
            Saved workspace data could not be restored. Default data has been
            loaded.
          </p>
          <Button
            variant="outline"
            onClick={(event) => requestReset(event.currentTarget)}
          >
            Reset workspace data
          </Button>
        </div>
      )}
      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent finalFocus={() => resetOpener.current}>
          <DialogTitle>Reset workspace data?</DialogTitle>
          <DialogDescription>
            This discards saved changes in this tab and restores the default
            records.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmReset(false)}>
              Cancel reset
            </Button>
            <Button
              onClick={() => {
                releaseAllLocalAttachments();
                clearCommsDraftTextStore(userId);
                clearOwnedSnapshot();
                runtime.reset();
                setGeneration((value) => value + 1);
                setRecovered(false);
                setConfirmReset(false);
              }}
            >
              Reset workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {ready ? (
        <SampleRecovery key={generation} onReset={requestReset}>
          {children}
        </SampleRecovery>
      ) : (
        <p role="status">Opening workspace…</p>
      )}
    </SampleContext.Provider>
  );
}

export function useSampleState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const context = useContext(SampleContext);
  if (!context) throw new Error("Sample state requires SampleProvider");
  const [defaults] = useState(() => initial);
  const { values, update } = context;
  const stored = values[key];
  const value = decodeSampleStoredValue(key, stored, defaults);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      update(key, (previous) => {
        const current = decodeSampleStoredValue(key, previous, defaults);
        return typeof action === "function"
          ? (action as (value: T) => T)(current)
          : action;
      });
    },
    [key, update, defaults],
  );
  return [value, setValue];
}

export function useSampleStorage(): Pick<
  SampleContextValue,
  "resetKeys" | "storageUnavailable"
> {
  const context = useContext(SampleContext);
  if (!context) throw new Error("Sample storage requires SampleProvider");
  return {
    resetKeys: context.resetKeys,
    storageUnavailable: context.storageUnavailable,
  };
}

export function useSampleTransaction(): SampleRuntime["commit"] {
  const context = useContext(SampleContext);
  if (!context) throw new Error("Sample transaction requires SampleProvider");
  return context.transact;
}

export function useSampleRuntime(): SampleRuntime {
  const context = useContext(SampleContext);
  if (!context) throw new Error("Sample runtime requires SampleProvider");
  return context.runtime;
}
