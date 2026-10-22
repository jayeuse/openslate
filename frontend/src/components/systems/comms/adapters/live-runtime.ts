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
  const ready = createReadyHttpCommsClient(scope.context, scope.signal);
  // One read of an event's message serves both the open history and the
  // workspace's held lists: they ask for it at the same moment. Each message
  // event drops the entry first, so a later change never joins an older read.
  // The caller's signal is ignored on purpose: `scope.read` checks its
  // combined signal again after the load.
  const reading = new Map<
    string,
    ReturnType<typeof ready.getMessageBySequence>
  >();
  const http = {
    ...ready,
    getMessageBySequence(id: string, seq: number) {
      const key = `${id}:${seq}`;
      let read = reading.get(key);
      if (!read) {
        const own = ready.getMessageBySequence(id, seq, {
          signal: scope.signal,
        });
        // A newer event's read may hold the key by now; leave it.
        const done = () => {
          if (reading.get(key) === own) reading.delete(key);
        };
        own.then(done, done);
        reading.set(key, (read = own));
      }
      return read;
    },
  };
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
    // A conversation detail nobody shows is dropped, not kept stale: its
    // checks and members may have changed. A shown one is read again.
    // Presence is removed: a reset would restore an older read's states.
    const unshown = new Set(
      cache
        .getQueryCache()
        .findAll({ queryKey: scope.keys.all })
        .filter(
          (query) =>
            (query.queryKey[5] === "detail" ||
              query.queryKey[5] === "presence") &&
            !query.isActive(),
        ),
    );
    for (const query of unshown)
      if (query.queryKey[5] === "presence") cache.getQueryCache().remove(query);
    if (unshown.size)
      await cache.resetQueries({
        queryKey: scope.keys.all,
        predicate: (query) => unshown.has(query),
      });
    await cache.invalidateQueries({
      queryKey: scope.keys.all,
      predicate: (query) =>
        query.queryKey[5] === "read" ||
        query.queryKey[5] === "detail" ||
        // A people picker's union of members.
        query.queryKey[3] === "people",
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
      if (event.event === "message")
        reading.delete(`${event.payload.conversation_id}:${event.payload.seq}`);
      if (event.event === "grants" || event.event === "membership")
        releaseAllLocalAttachments();
      void bridge
        .event(event)
        .then(() => {
          if (["grants", "membership", "structure"].includes(event.event))
            return refresh();
          // The bridge applied a message, a read watermark or a notice to
          // history and the bootstrap counts. The workspace view reads again
          // only what such a change touches (a thread, a pin, a held message).
        })
        .catch(failure);
      observers.forEach((observer) => observer.on_event(event));
    },
    on_connection(state) {
      if (scope.signal.aborted) return;
      const recovered = state.state === "live" && connection.state !== "live";
      // Before the initial read completes there is no displayed snapshot to
      // repair. Late first connections and every reconnect still resynchronize
      // (the workspace read no longer grows with the conversations).
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
