import type { QueryClient } from "@tanstack/react-query";
import type {
  CommsContext,
  ConnectionState,
  EventObserver,
  Message,
  RequestOptions,
  SendResult,
} from "../contract/types";
import { createReadyHttpCommsClient } from "./http-client";
import { createCommsQueryScope } from "./comms-queries";
import { createCommsCacheBridge } from "./cache-bridge";
import { subscribeSharedRealtime } from "../../shared/adapters/connection-set";
import { createCommsOutbox } from "./outbox";
import { releaseAllLocalAttachments } from "../../shared/runtime/local-attachments";

/** One admitted cache/outbox lifetime subscribing to the shared connection set. */
export function createLiveCommsRuntime(
  cache: QueryClient,
  context: CommsContext,
) {
  const scope = createCommsQueryScope(cache, context);
  const http = createReadyHttpCommsClient(scope.context, scope.signal);
  const bridge = createCommsCacheBridge(cache, scope, http);
  const outbox = createCommsOutbox(http, scope.signal);
  const observers = new Set<EventObserver>();
  const lastTyping = new Map<string, number>();
  let connection: ConnectionState = { state: "connecting" };
  let connectedOnce = false,
    receivedHeartbeat = false;
  const hasReadModel = () =>
    cache
      .getQueryCache()
      .findAll({ queryKey: scope.keys.all })
      .some(
        (query) =>
          query.queryKey[5] === "read" &&
          String(query.queryKey[4]).startsWith("workspace") &&
          query.state.data !== undefined,
      );
  const refreshReads = async () => {
    scope.signal.throwIfAborted();
    await cache.invalidateQueries({
      queryKey: scope.keys.all,
      predicate: (query) => query.queryKey[5] === "read",
    });
  };
  // One read repair at a time. A change seen while a repair runs is folded
  // into one more repair, and a change seen while a command is still writing
  // waits for that command: its own structure and grants events then cost no
  // second bootstrap or workspace read (and no restarted one).
  let changes = 0,
    repaired = 0,
    holds = 0;
  let repairing: Promise<void> | undefined;
  const repair = () =>
    (repairing ??= (async () => {
      try {
        do {
          repaired = changes;
          await bridge.recover();
          await refreshReads();
        } while (changes > repaired && holds === 0);
      } finally {
        repairing = undefined;
      }
    })());
  /** Repairs the read model after a change, now or when the running commands finish. */
  const refresh = () => {
    changes += 1;
    return holds ? Promise.resolve() : repair();
  };
  const failure = () => {
    if (!scope.signal.aborted)
      observers.forEach((observer) => observer.on_error({ kind: "network" }));
  };
  const observer: EventObserver = {
    on_event(event) {
      if (event.event === "grants" || event.event === "membership")
        releaseAllLocalAttachments();
      void bridge
        .event(event)
        .then(() => {
          if (["grants", "membership", "structure"].includes(event.event))
            return refresh();
          if (!["typing", "presence"].includes(event.event))
            return refreshReads();
        })
        .catch(failure);
      observers.forEach((observer) => observer.on_event(event));
    },
    on_connection(state) {
      if (scope.signal.aborted) return;
      const recovered = state.state === "live" && connection.state !== "live";
      // Before the initial read completes there is no displayed snapshot to
      // repair. Late first connections and every reconnect still resynchronize.
      const repair = recovered && (connectedOnce || hasReadModel());
      connection = state;
      if (state.state === "live") connectedOnce = true;
      observers.forEach((observer) => observer.on_connection(state));
      if (repair) void refresh().catch(failure);
    },
    on_error(error) {
      if (!scope.signal.aborted)
        observers.forEach((observer) => observer.on_error(error));
    },
  };
  let stopRealtime: (() => void) | undefined;
  scope.signal.addEventListener(
    "abort",
    () => {
      stopRealtime?.();
      lastTyping.clear();
      releaseAllLocalAttachments();
      observers.clear();
    },
    { once: true },
  );
  async function accepted(result: SendResult) {
    await bridge.accept(result.message).catch(failure);
    scope.signal.throwIfAborted();
    // The write receipt is authoritative even when later read repair fails.
    void refresh().catch(failure);
    return result;
  }
  const client = {
    ...http,
    sendTyping: async (id: string, options: RequestOptions = {}) => {
      scope.signal.throwIfAborted();
      options.signal?.throwIfAborted();
      const now = Date.now();
      if (now - (lastTyping.get(id) ?? -Infinity) < 10_000) return;
      lastTyping.set(id, now);
      await http.sendTyping(id, options);
    },
    bootstrap: async (options: RequestOptions = {}) => {
      const signal = options.signal
        ? AbortSignal.any([scope.signal, options.signal])
        : scope.signal;
      signal.throwIfAborted();
      const result = await cache.fetchQuery(scope.bootstrapOptions());
      signal.throwIfAborted();
      return result;
    },
    events: {
      subscribe(observer: EventObserver, options: RequestOptions = {}) {
        scope.signal.throwIfAborted();
        options.signal?.throwIfAborted();
        observers.add(observer);
        observer.on_connection(connection);
        const stop = () => {
          observers.delete(observer);
          options.signal?.removeEventListener("abort", stop);
        };
        options.signal?.addEventListener("abort", stop, { once: true });
        return stop;
      },
    },
    sendMessage: async (...args: Parameters<typeof http.sendMessage>) =>
      accepted(await outbox.sendMessage(...args)),
    sendReply: async (...args: Parameters<typeof http.sendReply>) =>
      accepted(await outbox.sendReply(...args)),
    heartbeatPresence: async (
      ...args: Parameters<typeof http.heartbeatPresence>
    ) => {
      const receipt = await http.heartbeatPresence(...args);
      await bridge.heartbeat(receipt);
      return receipt;
    },
  };
  return {
    client,
    scope,
    bridge,
    outbox,
    start: async () => {
      scope.signal.throwIfAborted();
      stopRealtime?.();
      stopRealtime = subscribeSharedRealtime(
        scope.context,
        observer,
        (receipt) => {
          const repair = receivedHeartbeat || hasReadModel();
          receivedHeartbeat = true;
          if (repair) void bridge.heartbeat(receipt).catch(failure);
        },
      );
    },
    refresh,
    /**
     * Holds event-driven repairs while a command writes; the returned release
     * (safe to call twice) repairs once for every change seen meanwhile.
     */
    hold() {
      holds += 1;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        holds -= 1;
        if (!holds && changes > repaired && !scope.signal.aborted)
          void repair().catch(failure);
      };
    },
    /** The repair now running, if any: join it without asking for another. */
    settled: () => repairing ?? Promise.resolve(),
    applyMessage: (message: Message) => bridge.accept(message),
    dispose: () => scope.dispose(),
  };
}
export type LiveCommsRuntime = ReturnType<typeof createLiveCommsRuntime>;
