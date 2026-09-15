"use client";

import {
  createContext,
  Component,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Button } from "@/components/ui/button";
import { releaseAllLocalAttachments } from "./comms/local-attachments";
import {
  decodeStoredSandboxHistory,
  decodeStoredSandboxVersions,
} from "@/components/sample/sandbox/stored-history";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

const STORAGE_KEY = "openslate.sample.v1";
type Snapshot = Record<string, unknown>;
export type SampleTransactionDraft = {
  update<T>(key: string, initial: T, action: SetStateAction<T>): void;
};
export type SampleTransactionRecipe = (
  transaction: SampleTransactionDraft,
) => void;
type SampleContextValue = {
  values: Snapshot;
  update: (key: string, action: (previous: unknown) => unknown) => void;
  transact: (recipe: SampleTransactionRecipe) => void;
  resetKeys: (keys: readonly string[]) => void;
  storageUnavailable: boolean;
};
const SampleContext = createContext<SampleContextValue | null>(null);

export function clearSampleSessionSnapshot(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Signing out remains available when browser storage is unavailable.
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
  const next: Snapshot = { ...previous };
  recipe({
    update<T>(key: string, initial: T, action: SetStateAction<T>) {
      const current = decodeSampleStoredValue(key, next[key], initial);
      next[key] =
        typeof action === "function"
          ? (action as (value: T) => T)(current)
          : action;
    },
  });
  return next;
}

export function SampleProvider({ children }: { children: ReactNode }) {
  const [values, setValues] = useState<Snapshot>({});
  const [ready, setReady] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const resetOpener = useRef<HTMLButtonElement | null>(null);
  function requestReset(opener: HTMLButtonElement) {
    resetOpener.current = opener;
    setConfirmReset(true);
  }
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      try {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        )
          setValues(parsed as Snapshot);
        else setRecovered(true);
      } catch {
        setRecovered(true);
      }
    } catch {
      setStorageUnavailable(true);
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(values));
    } catch {
      setStorageUnavailable(true);
    }
  }, [ready, values]);
  const update = useCallback(
    (key: string, action: (previous: unknown) => unknown) => {
      setValues((previous) => ({ ...previous, [key]: action(previous[key]) }));
    },
    [],
  );
  const transact = useCallback((recipe: SampleTransactionRecipe) => {
    setValues((previous) => applySampleTransaction(previous, recipe));
  }, []);
  const resetKeys = useCallback((keys: readonly string[]) => {
    setValues((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([key]) => !keys.includes(key)),
      ),
    );
  }, []);
  return (
    <SampleContext.Provider
      value={{ values, update, transact, resetKeys, storageUnavailable }}
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
                setValues({});
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

export function useSampleTransaction(): (
  recipe: SampleTransactionRecipe,
) => void {
  const context = useContext(SampleContext);
  if (!context) throw new Error("Sample transaction requires SampleProvider");
  return context.transact;
}
