import type { SetStateAction } from "react";

export type SampleSnapshot = Readonly<Record<string, unknown>>;
export type SampleDecoder = <T>(key: string, value: unknown, initial: T) => T;
export type SampleDraft = {
  read<T>(key: string, initial: T): T;
  update<T>(key: string, initial: T, action: SetStateAction<T>): void;
  remove(key: string): void;
  /** Return a domain rejection without publishing any staged changes. */
  reject<T>(result: T): never;
};
export type SampleOperationOptions = {
  signal?: AbortSignal;
  /** Include every owner read or written by a cross-feature operation. */
  keys?: readonly string[];
};
export class SampleOperationError extends Error {
  constructor(
    public kind: "aborted" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SampleOperationError";
  }
}

class RejectedTransaction {
  constructor(readonly result: unknown) {}
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export function createSampleRuntime(
  decode: SampleDecoder,
  initial: SampleSnapshot = {},
) {
  let snapshot = initial;
  let generation = 0;
  let resetRevision = 0;
  const keyGenerations = new Map<string, number>();
  const listeners = new Set<{
    keys?: readonly string[];
    listener: () => void;
  }>();
  const getSnapshot = () => snapshot;
  const read = <T>(key: string, fallback: T): T =>
    decode(key, snapshot[key], fallback);
  function subscribeKeys(
    keys: readonly string[] | undefined,
    listener: () => void,
  ) {
    const subscription = { keys, listener };
    listeners.add(subscription);
    return () => {
      listeners.delete(subscription);
    };
  }
  const subscribe = (listener: () => void) =>
    subscribeKeys(undefined, listener);

  function publish(
    next: SampleSnapshot,
    invalidated?: readonly string[] | true,
  ) {
    const changed = new Set(
      [...Object.keys(snapshot), ...Object.keys(next)].filter(
        (key) =>
          !Object.is(snapshot[key], next[key]) ||
          Object.hasOwn(snapshot, key) !== Object.hasOwn(next, key),
      ),
    );
    if (invalidated && invalidated !== true)
      for (const key of invalidated) changed.add(key);
    if (changed.size === 0 && !invalidated) return;
    snapshot = next;
    for (const { keys, listener } of listeners) {
      if (invalidated === true || !keys || keys.some((key) => changed.has(key)))
        listener();
    }
  }

  function commit<T>(recipe: (draft: SampleDraft) => T): T {
    const next = { ...snapshot };
    let result: T;
    try {
      result = recipe({
        // Each owner is copied only when touched. A rejected domain recipe must
        // not mutate nested values in the currently published snapshot.
        read: (key, fallback) =>
          structuredClone(decode(key, next[key], fallback)),
        update: (key, fallback, action) => {
          if (typeof action !== "function") {
            next[key] = structuredClone(action);
            return;
          }
          const original = decode(key, next[key], fallback);
          const value = structuredClone(original);
          const updated = (action as (previous: typeof value) => typeof value)(
            value,
          );
          // Preserve no-op functional updates without cloning the entire store.
          if (
            updated === value &&
            JSON.stringify(value) === JSON.stringify(original)
          )
            return;
          next[key] = structuredClone(updated);
        },
        remove: (key) => {
          delete next[key];
        },
        reject: (rejection) => {
          throw new RejectedTransaction(rejection);
        },
      });
    } catch (error) {
      // The caller supplies both the result and its type inside this transaction.
      if (error instanceof RejectedTransaction) return error.result as T;
      throw error;
    }
    if (isThenable(result)) {
      void Promise.resolve(result).catch(() => undefined);
      throw new Error("Sample transaction recipes must be synchronous.");
    }
    publish(next);
    return result;
  }

  function operationGuard(options: SampleOperationOptions) {
    const startGeneration = generation;
    const startResetRevision = resetRevision;
    const keyVersions = options.keys?.map(
      (key) => [key, keyGenerations.get(key) ?? 0] as const,
    );
    return () => {
      if (
        options.signal?.aborted ||
        generation !== startGeneration ||
        (keyVersions
          ? keyVersions.some(
              ([key, version]) => (keyGenerations.get(key) ?? 0) !== version,
            )
          : resetRevision !== startResetRevision)
      )
        throw new SampleOperationError(
          "aborted",
          "The workspace changed before this operation finished. Try again.",
        );
    };
  }

  return {
    getSnapshot,
    getServerSnapshot: () => initial,
    read,
    subscribe,
    subscribeKeys,
    commit,
    getGeneration: () => generation,
    reset(next: SampleSnapshot = {}) {
      generation++;
      resetRevision++;
      publish(next, true);
    },
    resetKeys(keys: readonly string[]) {
      resetRevision++;
      for (const key of keys)
        keyGenerations.set(key, (keyGenerations.get(key) ?? 0) + 1);
      const next = { ...snapshot };
      for (const key of keys) delete next[key];
      publish(next, keys);
    },
    async execute<T>(
      recipe: (draft: SampleDraft) => T,
      options: SampleOperationOptions = {},
    ): Promise<T> {
      const assertCurrent = operationGuard(options);
      await Promise.resolve();
      assertCurrent();
      return commit(recipe);
    },
    async load<T>(
      select: (source: Pick<SampleDraft, "read">) => T,
      options: SampleOperationOptions = {},
    ): Promise<T> {
      const assertCurrent = operationGuard(options);
      await Promise.resolve();
      assertCurrent();
      return select({ read });
    },
  };
}
export type SampleRuntime = ReturnType<typeof createSampleRuntime>;
