import { SampleOperationError } from "./sample-runtime";

export type SampleResourceState<T> =
  | { status: "loading"; data: undefined; refreshing: false; error: null }
  | { status: "error"; data: undefined; refreshing: false; error: string }
  | { status: "ready"; data: T; refreshing: boolean; error: string | null };

export function sampleOperationMessage(
  error: unknown,
  fallback: string,
): string {
  return error instanceof SampleOperationError ? error.message : fallback;
}

export function createSampleResource<T>() {
  let state: SampleResourceState<T> = {
    status: "loading",
    data: undefined,
    refreshing: false,
    error: null,
  };
  let sequence = 0;
  let controller: AbortController | undefined;
  const listeners = new Set<() => void>();
  function publish(next: SampleResourceState<T>) {
    state = next;
    for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load(loader: (signal: AbortSignal) => Promise<T>, retain: boolean) {
      controller?.abort();
      const current = ++sequence;
      const request = new AbortController();
      controller = request;
      const previous = retain && state.status === "ready" ? state : null;
      publish(
        previous
          ? { ...previous, refreshing: true, error: null }
          : {
              status: "loading",
              data: undefined,
              refreshing: false,
              error: null,
            },
      );
      try {
        const data = await loader(request.signal);
        if (current === sequence && !request.signal.aborted)
          publish({ status: "ready", data, refreshing: false, error: null });
      } catch (error) {
        if (current !== sequence || request.signal.aborted) return;
        const message = sampleOperationMessage(
          error,
          "Could not load this data. Try again.",
        );
        publish(
          previous
            ? { ...previous, refreshing: false, error: message }
            : {
                status: "error",
                data: undefined,
                refreshing: false,
                error: message,
              },
        );
      }
    },
    cancel() {
      sequence++;
      controller?.abort();
    },
  };
}

export function createSampleCommands() {
  const active = new Map<string, AbortController>();
  const listeners = new Set<() => void>();
  let pendingKeys: readonly string[] = [];
  function publish() {
    pendingKeys = [...active.keys()];
    for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => pendingKeys,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isPending(key?: string) {
      return key === undefined ? active.size > 0 : active.has(key);
    },
    async run<T>(
      key: string,
      task: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      if (active.has(key))
        throw new SampleOperationError(
          "conflict",
          "This change is already being saved. Please wait.",
        );
      const controller = new AbortController();
      active.set(key, controller);
      publish();
      try {
        return await task(controller.signal);
      } finally {
        // A cancelled older command must not clear a newer command's pending state.
        if (active.get(key) === controller) {
          active.delete(key);
          publish();
        }
      }
    },
    cancel() {
      for (const controller of active.values()) controller.abort();
      active.clear();
      publish();
    },
  };
}
