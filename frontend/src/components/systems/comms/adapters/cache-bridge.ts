import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import type { CommsClient } from "../contract/client";
import type {
  CommsEvent,
  HistoryPage,
  HistoryRequest,
  Message,
} from "../contract/types";
import { realtimeEventSchemaFor } from "../contract/schemas";
import { querySettled, type createCommsQueryScope } from "./comms-queries";
import {
  heartbeatPresenceResponseSchemaFor,
  type HttpHeartbeatResponse,
} from "./presence-contract";

type Scope = ReturnType<typeof createCommsQueryScope>;
type History = InfiniteData<HistoryPage, HistoryRequest>;
type Http = Pick<
  CommsClient,
  "getHistory" | "getReplies" | "getMessageBySequence"
>;

/** The receive path patches only already loaded histories on the account cache. */
export function createCommsCacheBridge(
  cache: QueryClient,
  scope: Scope,
  http: Http,
) {
  const events = realtimeEventSchemaFor(scope.context);
  const heartbeatSchema = heartbeatPresenceResponseSchemaFor(scope.context);
  // Ordering HTTP hydration with repairs prevents an older completion overwriting
  // a later event. Infinite-query paging retains its own cancellation boundary.
  let pending = Promise.resolve();
  function enqueue(action: () => Promise<void>) {
    const next = pending.then(() => {
      scope.signal.throwIfAborted();
      return action();
    });
    pending = next.catch(() => {});
    return next;
  }
  function windows(includeInactive = false) {
    return cache
      .getQueryCache()
      .findAll({ queryKey: scope.keys.all })
      .filter(
        (query) =>
          query.queryKey[5] === "history" &&
          (includeInactive || query.isActive()) &&
          query.state.data !== undefined,
      );
  }
  function knownSequences() {
    const heads = new Map<string, number>();
    for (const query of windows()) {
      const id = String(query.queryKey[4]);
      const head = Math.min(
        ...(query.state.data as History).pages.map(
          (p) => p.pagination.high_water_seq,
        ),
      );
      heads.set(id, Math.min(heads.get(id) ?? head, head));
    }
    return [...heads]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 100)
      .map(([conversation_id, high_water_seq]) => ({
        conversation_id,
        high_water_seq,
      }));
  }
  const load = (id: string, root: string | null, request: HistoryRequest) =>
    scope.read(id, (signal) =>
      root
        ? http.getReplies(id, root, request, { signal })
        : http.getHistory(id, request, { signal }),
    );

  function historyData(
    source: HistoryPage,
    input: Message[],
    head: number,
    older: boolean,
    newer: boolean,
  ): History {
    const unique = new Map(input.map((message) => [message.id, message]));
    const all = [...unique.values()].sort((a, b) => a.seq - b.seq);
    const items = all.slice(-100);
    const groups =
      items.length > 50 ? [items.slice(0, -50), items.slice(-50)] : [items];
    const pages = groups.map((rows, index) => ({
      ...source,
      items: rows,
      pagination: {
        limit: 50,
        count: rows.length,
        first_seq: rows[0]?.seq ?? null,
        last_seq: rows.at(-1)?.seq ?? null,
        high_water_seq: head,
        has_older: index > 0 || older || all.length > 100,
        has_newer: index < groups.length - 1 || newer,
      },
    }));
    return {
      pages,
      pageParams: pages.map((page) => ({
        limit: 50,
        ...(page.pagination.first_seq === null
          ? {}
          : { after_seq: page.pagination.first_seq - 1 }),
      })),
    };
  }

  async function repair(query: ReturnType<typeof windows>[number]) {
    await cache.cancelQueries({ queryKey: query.queryKey, exact: true });
    const before = cache.getQueryData<History>(query.queryKey);
    if (!before?.pages.length) return;
    const id = String(query.queryKey[4]);
    const root = query.queryKey[6] as string | null;
    let cursor = Math.min(
      ...before.pages.map((page) => page.pagination.high_water_seq),
    );
    let head = cursor;
    let tail: Message[] = [];
    for (;;) {
      const page = await load(id, root, { limit: 50, after_seq: cursor });
      head = page.pagination.high_water_seq;
      tail = [...tail, ...page.items].slice(-100);
      if (!page.pagination.has_newer) break;
      const next = page.pagination.last_seq;
      if (next === null || next <= cursor)
        throw new Error("History recovery did not advance");
      cursor = next;
    }
    // Re-read the loaded ranges as well: heads cannot reveal lost edits/deletes.
    const ranges: HistoryPage[] = [];
    for (const page of before.pages)
      ranges.push(
        await load(id, root, {
          limit: page.items.length || 50,
          ...(page.pagination.first_seq === null
            ? {}
            : { after_seq: page.pagination.first_seq - 1 }),
        }),
      );
    scope.signal.throwIfAborted();
    // A user may have paged while recovery was running; never replace that view.
    if (cache.getQueryData(query.queryKey) !== before || scope.isRefused(id))
      return;
    const latest =
      query.meta?.commsFollowLatest !== false &&
      !before.pages.at(-1)?.pagination.has_newer;
    const rows = ranges.flatMap((page) => page.items);
    const next = historyData(
      ranges[0],
      latest ? [...tail, ...rows] : rows,
      head,
      ranges[0].pagination.has_older,
      latest ? false : ranges.at(-1)!.pagination.has_newer,
    );
    cache.setQueryData<History>(query.queryKey, next);
  }
  async function recover(ids?: ReadonlySet<string>, includeInactive = false) {
    const results = await Promise.allSettled(
      windows(includeInactive)
        .filter((query) => !ids || ids.has(String(query.queryKey[4])))
        .map(repair),
    );
    // A failed history repair still permits refreshed visibility/unread metadata,
    // but it never consumes an observed bootstrap head as a fetched cursor.
    await cache.fetchQuery({ ...scope.bootstrapOptions(), staleTime: 0 });
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  async function accept(message: Message) {
    scope.signal.throwIfAborted();
    if (message.org_id !== scope.context.org_id)
      throw new Error("Message belongs to another organization");
    for (const query of windows(true)) {
      if (
        query.queryKey[4] !== message.conversation_id ||
        scope.isRefused(message.conversation_id)
      )
        continue;
      await cache.cancelQueries({ queryKey: query.queryKey, exact: true });
      scope.signal.throwIfAborted();
      if (scope.isRefused(message.conversation_id)) continue;
      cache.setQueryData<History>(query.queryKey, (data) => {
        if (!data?.pages.length) return data;
        const root = query.queryKey[6];
        const belongs = root
          ? message.parent_id === root
          : message.parent_id === null ||
            (message.state === "live" && message.also_send_to_channel);
        const rows = data.pages.flatMap((page) => page.items);
        const loaded = rows.some((item) => item.id === message.id);
        const latest =
          query.meta?.commsFollowLatest !== false &&
          !data.pages.at(-1)?.pagination.has_newer;
        if (!loaded && (!belongs || !latest)) return data;
        const next = rows.filter((item) => item.id !== message.id);
        if (belongs) next.push(message);
        // Hydrating one event does not prove the entire gap was fetched.
        return historyData(
          data.pages[0],
          next,
          Math.min(...data.pages.map((p) => p.pagination.high_water_seq)),
          data.pages[0].pagination.has_older,
          !latest,
        );
      });
    }
  }
  return {
    knownSequences,
    recover: () => enqueue(() => recover()),
    accept: (message: Message) => enqueue(() => accept(message)),
    async event(input: CommsEvent) {
      const event = events.parse(input);
      // The runtime repairs grants, membership and structure changes in its
      // one coalesced refresh, which recovers histories and the bootstrap.
      if (["grants", "membership", "structure"].includes(event.event)) return;
      await enqueue(async () => {
        if (event.event === "message") {
          const { conversation_id: id, seq, kind } = event.payload;
          // A first history read sent before this message may land after its
          // event. Wait for it, then judge the gap against what it loaded.
          await Promise.all(
            cache
              .getQueryCache()
              .findAll({ queryKey: scope.keys.conversation(id) })
              .filter(
                (query) =>
                  query.queryKey[5] === "history" &&
                  query.state.data === undefined &&
                  query.state.fetchStatus === "fetching",
              )
              .map((query) => querySettled(cache, query.queryKey)),
          );
          scope.signal.throwIfAborted();
          const open = windows(true).filter(
            (query) => query.queryKey[4] === id,
          );
          if (!open.length) {
            await cache.fetchQuery({
              ...scope.bootstrapOptions(),
              staleTime: 0,
            });
            return;
          }
          const head = Math.min(
            ...open.flatMap((query) =>
              (query.state.data as History).pages.map(
                (p) => p.pagination.high_water_seq,
              ),
            ),
          );
          if (seq > head) {
            await recover(new Set([id]), true);
            return;
          }
          try {
            const result = await scope.read(
              id,
              (signal) => http.getMessageBySequence(id, seq, { signal }),
              undefined,
              false,
            );
            await accept(result.data);
          } catch (error) {
            if (
              !(error instanceof ApiError) ||
              ![403, 404].includes(error.status)
            )
              throw error;
            // Permanently purged sequences have no DTO; history is authoritative.
            await recover(new Set([id]), true);
          }
          if (kind === "thread" || kind === "pin")
            await cache.fetchQuery({
              ...scope.bootstrapOptions(),
              staleTime: 0,
            });
        } else if (event.event === "read" || event.event === "notification")
          await cache.fetchQuery({ ...scope.bootstrapOptions(), staleTime: 0 });
      });
    },
    async heartbeat(input: HttpHeartbeatResponse) {
      const receipt = heartbeatSchema.parse(input);
      await enqueue(() =>
        recover(
          receipt.truncated
            ? undefined
            : new Set(receipt.changed.map((item) => item.conversation_id)),
        ),
      );
    },
  };
}
