import {
  infiniteQueryOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { commsContextSchema } from "../contract/schemas";
import type { CommsContext, HistoryRequest } from "../contract/types";
import type { CommsClient } from "../contract/client";
import { bootstrap, getHistory } from "./message-api";
import { getReplies } from "./threads-api";

/** One admitted lifetime on the existing account QueryClient, never a provider. */
export function createCommsQueryScope(
  client: QueryClient,
  input: CommsContext,
  source:
    | { kind: "live" }
    | {
        kind: "example-tools";
        client: Pick<
          CommsClient,
          "context" | "bootstrap" | "getHistory" | "getReplies"
        >;
      } = { kind: "live" },
) {
  const context = Object.freeze(commsContextSchema.parse(input));
  if (
    source.kind === "example-tools" &&
    (source.client.context.user_id !== context.user_id ||
      source.client.context.org_id !== context.org_id)
  )
    throw new Error("Example context mismatch");
  const namespace = source.kind === "live" ? "comms" : "comms-example-tools";
  const all = [namespace, context.user_id, context.org_id] as const;
  const refusals = [
    `${namespace}-refusal`,
    context.user_id,
    context.org_id,
  ] as const;
  const controller = new AbortController();
  const reads = new Map<
    string,
    { latestSuccess: number; deniedAt: number | null; refusedThrough: number }
  >();
  let sequence = 0;
  const keys = {
    all,
    bootstrap: [...all, "bootstrap"] as const,
    conversation: (id: string) => [...all, "conversation", id] as const,
    history: (id: string, root: string | null) =>
      [...all, "conversation", id, "history", root] as const,
    refusal: refusals,
  };
  async function read<T>(
    resource: string | undefined,
    load: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    // A purged message may be missing while its conversation remains readable.
    notFoundIsRefusal = true,
  ): Promise<T> {
    const combined = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    combined.throwIfAborted();
    const key = resource ?? "bootstrap";
    let state = reads.get(key);
    if (!state) {
      state = { latestSuccess: 0, deniedAt: null, refusedThrough: 0 };
      reads.set(key, state);
    }
    const startedAt = ++sequence;
    try {
      const result = await load(combined);
      combined.throwIfAborted();
      const bootstrapRefusal = reads.get("bootstrap")?.refusedThrough ?? 0;
      if (startedAt <= state.refusedThrough || startedAt <= bootstrapRefusal)
        throw new DOMException("A newer read refused this data", "AbortError");
      state.latestSuccess = Math.max(state.latestSuccess, startedAt);
      if (state.deniedAt !== null && startedAt > state.deniedAt) {
        state.deniedAt = null;
        client.setQueryData<Record<string, boolean>>(refusals, (current) => ({
          ...current,
          [key]: false,
        }));
      }
      return result;
    } catch (error) {
      combined.throwIfAborted();
      const status =
        error instanceof ApiError
          ? error.status
          : error instanceof Error &&
              "failure" in error &&
              typeof error.failure === "object" &&
              error.failure !== null &&
              "status" in error.failure
            ? Number(error.failure.status)
            : undefined;
      if (
        error instanceof Error &&
        status !== undefined &&
        (status === 401 ||
          status === 403 ||
          (status === 404 && notFoundIsRefusal))
      ) {
        // Recovery clears the visible latch, never the barrier against old bytes.
        state.refusedThrough = Math.max(state.refusedThrough, startedAt);
        if (state.latestSuccess > startedAt) throw error;
        state.deniedAt = Math.max(state.deniedAt ?? 0, startedAt);
        client.setQueryData<Record<string, boolean>>(refusals, (current) => ({
          ...current,
          [key]: true,
        }));
        const queryKey =
          resource === undefined ? all : keys.conversation(resource);
        for (const query of client.getQueryCache().findAll({ queryKey })) {
          query.setState({
            data: undefined,
            dataUpdatedAt: 0,
            error,
            errorUpdatedAt: Date.now(),
            status: "error",
            isInvalidated: true,
          });
        }
      }
      throw error;
    }
  }
  const isRefused = (id?: string) =>
    reads.get("bootstrap")?.deniedAt != null ||
    (id !== undefined && reads.get(id)?.deniedAt != null);
  return {
    context,
    kind: source.kind,
    signal: controller.signal,
    keys,
    read,
    isRefused,
    refusalOptions: (id?: string) =>
      queryOptions({
        queryKey: refusals,
        queryFn: async () =>
          Object.fromEntries(
            [...reads].map(([id, state]) => [id, state.deniedAt !== null]),
          ),
        select: (flags: Record<string, boolean>) =>
          flags.bootstrap === true || (id !== undefined && flags[id] === true),
        enabled: false,
        initialData: () =>
          Object.fromEntries(
            [...reads].map(([id, state]) => [id, state.deniedAt !== null]),
          ),
        // Refusal must not expire while a mounted/copied protected view still exists.
        gcTime: Infinity,
      }),
    bootstrapOptions: () =>
      queryOptions({
        queryKey: keys.bootstrap,
        queryFn: ({ signal }) =>
          read(
            undefined,
            (signal) =>
              source.kind === "example-tools"
                ? source.client.bootstrap({ signal })
                : bootstrap(context, { signal }),
            signal,
          ),
      }),
    historyOptions: (
      conversationId: string,
      threadRootId: string | null = null,
    ) =>
      infiniteQueryOptions({
        queryKey: keys.history(conversationId, threadRootId),
        initialPageParam: { limit: 50 } as HistoryRequest,
        queryFn: ({ pageParam, signal }) =>
          read(
            conversationId,
            (signal) =>
              source.kind === "example-tools"
                ? threadRootId
                  ? source.client.getReplies(
                      conversationId,
                      threadRootId,
                      pageParam,
                      { signal },
                    )
                  : source.client.getHistory(conversationId, pageParam, {
                      signal,
                    })
                : threadRootId
                  ? getReplies(
                      context,
                      conversationId,
                      threadRootId,
                      pageParam,
                      {
                        signal,
                      },
                    )
                  : getHistory(context, conversationId, pageParam, { signal }),
            signal,
          ),
        getPreviousPageParam: (page): HistoryRequest | undefined =>
          page.pagination.has_older && page.pagination.first_seq !== null
            ? { limit: 50, before_seq: page.pagination.first_seq }
            : undefined,
        getNextPageParam: (page): HistoryRequest | undefined =>
          page.pagination.has_newer && page.pagination.last_seq !== null
            ? { limit: 50, after_seq: page.pagination.last_seq }
            : undefined,
        maxPages: 2,
      }),
    dispose() {
      if (controller.signal.aborted) return;
      controller.abort();
      // Retired observer options may be rebound before React commits the new
      // admission. They must not reconstruct the previous lifetime's latch.
      reads.clear();
      void client.cancelQueries({ queryKey: all });
      client.removeQueries({ queryKey: all });
      client.removeQueries({ queryKey: refusals });
    },
  };
}
