"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import type { CommsViewClient as CommsClient } from "../contract/client";
import { composerFailure, sendRefusal } from "../domain/composer-input";
import { useCommsClient } from "./client-context";

export function useCommsCommands() {
  const binding = useCommsClient();
  const cache = useQueryClient();
  const [pending] = useState(() => new Map<string, Promise<unknown>>());
  const lifetime = useRef<AbortController | null>(null);
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);
  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    pending.clear();
    setPendingKeys([]);
    return () => controller.abort();
  }, [binding.client, pending]);
  useEffect(() => {
    if (!pendingKeys.length) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [pendingKeys.length]);
  const run = useCallback(
    async <T>(
      key: string,
      action: (client: CommsClient, signal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const { client, scope, live } = binding;
      const local = lifetime.current;
      if (!client || !scope || !local)
        throw new Error("Organization is not admitted");
      const signal = AbortSignal.any([scope.signal, local.signal]);
      signal.throwIfAborted();
      const existing = pending.get(key);
      if (existing) return existing as Promise<T>;
      const task = Promise.resolve().then(async () => {
        try {
          signal.throwIfAborted();
          const result = await action(client, signal);
          signal.throwIfAborted();
          // Follow-up reads never turn an accepted command into a failed write.
          if (live) void live.refresh().catch(() => {});
          else {
            void cache.invalidateQueries({
              queryKey: scope.keys.bootstrap,
              exact: true,
            });
            void cache.invalidateQueries({
              queryKey: scope.keys.all,
              predicate: (query) => query.queryKey[5] === "read",
            });
          }
          return result;
        } finally {
          if (!local.signal.aborted) {
            pending.delete(key);
            setPendingKeys([...pending.keys()]);
          }
        }
      });
      pending.set(key, task);
      setPendingKeys([...pending.keys()]);
      return task;
    },
    [binding, cache, pending],
  );
  return {
    run,
    pendingKeys,
    isPending: (key?: string) => (key ? pending.has(key) : pending.size > 0),
  };
}
/** A stale preview must be previewed again, not merely reloaded. */
export const STALE_PREVIEW_MESSAGE =
  "Someone changed this after your preview. Preview the current state again.";
export function messageFromCommsError(
  error: unknown,
  fallback: string,
  conflict = "Someone changed this after you opened it. Your changes are still here. Load the latest version, then try again.",
): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    error.kind === "cancelled"
  )
    return "The workspace changed before this operation finished. Try again.";
  if (isCommsConflict(error)) return conflict;
  // D44 A8: the server refuses a channel its category cannot hold.
  const failure = composerFailure(error);
  if (
    failure?.status === 422 &&
    typeof failure.body.detail === "object" &&
    !Array.isArray(failure.body.detail) &&
    failure.body.detail.code === "comms_invalid"
  )
    return /categor/i.test(failure.body.detail.message)
      ? "This category is for another department's channels."
      : "Check the channel details and try again.";
  const refusal = sendRefusal(error);
  if (refusal?.code === "comms_rate_limited")
    return `Too many attempts. Try again in ${Math.max(1, refusal.seconds)}s.`;
  return fallback;
}
/** A 412 precondition failure: the version the user saw is no longer current. */
export function isCommsConflict(error: unknown): boolean {
  return failureStatus(error) === 412;
}
/** The HTTP status of a typed Comms refusal, when the error carries one. */
function failureStatus(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "failure" in error &&
    typeof error.failure === "object" &&
    error.failure !== null &&
    "status" in error.failure
    ? Number(error.failure.status)
    : undefined;
}

export function useCommsRefusals() {
  const { scope } = useCommsClient();
  const state = useQuery({
    ...(scope?.refusalOptions() ?? {
      queryKey: ["comms-refusal", "unadmitted", "unadmitted"] as const,
      queryFn: async (): Promise<Record<string, boolean>> => ({}),
      enabled: false,
    }),
    select: (flags: Record<string, boolean>) => flags,
  });
  return state.data;
}

export function useCommsRead<T>(
  key: string,
  load: (client: CommsClient, signal: AbortSignal) => Promise<T>,
  enabled = true,
) {
  const binding = useCommsClient();
  const scope = binding.scope;
  const result = useQuery({
    queryKey: scope
      ? [...scope.keys.conversation(key), "read"]
      : ["comms-unadmitted", key],
    enabled: enabled && !!binding.client && !!scope && !binding.error,
    queryFn: ({ signal }) => {
      if (!scope || !binding.client)
        throw new Error("Organization is not admitted");
      return scope.read(key, (signal) => load(binding.client!, signal), signal);
    },
  });
  const refusals = useCommsRefusals();
  const refused =
    refusals?.bootstrap || refusals?.[key] || scope?.isRefused(key);
  const error =
    binding.error ||
    (result.isError
      ? messageFromCommsError(
          result.error,
          "This data could not be loaded. Try again.",
        )
      : "");
  return {
    data: binding.client && !refused ? result.data : undefined,
    error,
    status: error
      ? ("error" as const)
      : !binding.client || result.isPending
        ? ("loading" as const)
        : ("ready" as const),
    refreshing: result.isFetching && !result.isPending,
    reload: () => {
      void result.refetch();
    },
  };
}
export function isCommsReadRefusal(error: unknown): boolean {
  if (error instanceof ApiError) return [401, 403, 404].includes(error.status);
  return [401, 403, 404].includes(failureStatus(error) ?? 0);
}
