"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { ApiError } from "@/lib/api";
import { createCommsConfiguration } from "../domain/configuration-model";
import type {
  Bootstrap,
  CapabilityCheck,
  Member,
  Message,
  Settings,
} from "../contract/types";
import type { ConversationDetail } from "../adapters/conversation-detail";
import type { Presence } from "../domain/view-model";
import { useCommsClient } from "./client-context";
import {
  loadWorkspace,
  loadWorkspaceRecords,
  loadWorkspaceThreads,
  type WorkspaceThreads,
  withBootstrap,
  withDetails,
} from "./workspace-view";
import { useCommsRead, useCommsRefusals } from "./runtime";
import { useCommsMessageAuthors } from "./use-comms-message-authors";
type LoadedRead = Awaited<ReturnType<typeof loadWorkspace>>;
type CommsWorkspace = ReturnType<
  typeof withDetails<ReturnType<typeof withBootstrap<LoadedRead>>>
>;

const empty = {
  client: null,
  bootstrap: undefined as Bootstrap | undefined,
  presence: {} as Presence,
  configuration: createCommsConfiguration(),
  people: [],
  roles: [],
  categories: [],
  channels: [],
  messages: [],
  threads: [],
  directs: [],
  records: [],
  account: { presence: "Offline" },
  checks: {} as Record<string, CapabilityCheck>,
  members: {} as Record<string, Member[]>,
  effective: {} as Record<string, Settings>,
};

/** Cached details with a stamp that changes only when one of them changes. */
function cachedDetails(
  results: {
    data: (ConversationDetail & { readEpoch: number }) | undefined;
    dataUpdatedAt: number;
    isFetching: boolean;
  }[],
) {
  return {
    data: results.map((result) => result.data),
    updatedAt: results.map((result) => result.dataUpdatedAt),
    stamp: results.map((result) => result.dataUpdatedAt).join(","),
    // A shown conversation's members are being read again.
    refreshing: results.some(
      (result) => result.isFetching && result.data !== undefined,
    ),
  };
}

/** Every cached presence read, merged, with a stamp of their read times. */
function cachedPresence(
  results: { data: Presence | undefined; dataUpdatedAt: number }[],
) {
  return {
    data: results.map((result) => result.data),
    stamp: results.map((result) => result.dataUpdatedAt).join(","),
  };
}

const noMessages: Message[] = [];

export function useCommsWorkspace() {
  const binding = useCommsClient();
  const cache = useQueryClient();
  const acceptedRead = useRef<{ client: CommsWorkspace["client"] } | null>(
    null,
  );
  const [lastGood, setLastGood] = useState<CommsWorkspace>();
  const key = "workspace";
  const read = useCommsRead(key, (client, signal) =>
    loadWorkspace(client, signal),
  );
  // Threads and record links fill in after the frame; nothing waits for them.
  const threadsKey = "workspace-threads",
    recordsKey = "workspace-records";
  const readKey = (name: string) =>
    binding.scope ? [...binding.scope.keys.conversation(name), "read"] : [];
  const threadsData = () =>
    cache.getQueryData<WorkspaceThreads>(readKey(threadsKey));
  // A thread event re-reads the lists and only the roots it lacks; a repair
  // reads every root again. `fullRead` says which kind started last.
  const reuseRoots = useRef(false),
    fullRead = useRef(false);
  const threadRead = useCommsRead(threadsKey, (client, signal) => {
    const previous = reuseRoots.current ? threadsData() : undefined;
    reuseRoots.current = false;
    fullRead.current = !previous;
    return loadWorkspaceThreads(
      client,
      signal,
      new Map((previous?.roots ?? []).map((root) => [root.id, root])),
    );
  });
  // Record links wait for the first thread read: roots it holds are not
  // read twice.
  const recordRead = useCommsRead(
    recordsKey,
    (client, signal) =>
      loadWorkspaceRecords(
        client,
        signal,
        new Set(threadsData()?.roots.map((root) => root.id)),
      ),
    threadRead.status !== "loading",
  );
  // The sidebar, channels and direct names follow the live bootstrap query.
  const loaded = read.data;
  const bootstrap =
    loaded && binding.bootstrap && loaded.client === binding.client
      ? binding.bootstrap
      : loaded?.bootstrap;
  // Every conversation's detail is observed but never fetched from here: only
  // an open conversation (or a dialog) enables its read. Cached details of
  // conversations opened earlier still name their people.
  const rooms = useMemo(
    () =>
      (bootstrap?.conversations ?? []).map(({ conversation }) => ({
        id: conversation.id,
        channel: conversation.kind === "channel",
      })),
    [bootstrap],
  );
  const { scope, client } = binding;
  // The open conversation's detail starts with the bootstrap, not after the
  // frame read: the same choice navigation makes (the linked conversation,
  // else the first channel; views and deep links resolve later). History is
  // not prefetched: its window depends on the timeline's position.
  const query = useSearchParams();
  const linked = query.get("conversation");
  const implicit =
    !query.has("message") &&
    !query.has("thread") &&
    !query.has("settings") &&
    !query.has("view");
  const early = binding.bootstrap?.conversations.find(({ conversation }) =>
    linked
      ? conversation.id === linked
      : implicit && conversation.kind === "channel",
  )?.conversation;
  const earlyId = early?.id;
  const earlyChannel = early?.kind === "channel";
  useEffect(() => {
    if (!earlyId || !scope || !client || scope.signal.aborted) return;
    void cache.prefetchQuery(
      scope.detailOptions(earlyId, earlyChannel, client),
    );
  }, [cache, scope, client, earlyId, earlyChannel]);
  const details = useQueries({
    queries:
      scope && client
        ? rooms.map((room) => ({
            ...scope.detailOptions(room.id, room.channel, client),
            enabled: false,
          }))
        : [],
    combine: cachedDetails,
  });
  const detailStamp = `${rooms.map((room) => room.id).join(",")}|${details.stamp}`;
  const detailData = details.data;
  const detailMap = useMemo(
    () =>
      Object.fromEntries(
        rooms.flatMap((room, index) =>
          detailData[index] ? [[room.id, detailData[index]]] : [],
        ),
      ),
    // detailStamp changes exactly when a room or a cached detail changes.
    [detailStamp],
  );
  // Presence follows each cached detail read; it is observed here and read
  // only for the open conversation (`useConversationPresence`).
  const presenceRooms = rooms.flatMap((room, index) => {
    const detail = detailData[index];
    return detail
      ? [
          {
            id: room.id,
            readAt: details.updatedAt[index],
            userIds: detail.members.map((member) => member.user_id),
          },
        ]
      : [];
  });
  const presenceReads = useQueries({
    queries:
      scope && client
        ? presenceRooms.map((room) => ({
            ...scope.presenceOptions(
              room.id,
              room.readAt,
              room.userIds,
              client,
            ),
            enabled: false,
          }))
        : [],
    combine: cachedPresence,
  });
  const presenceData = presenceReads.data;
  const presence = useMemo(
    () => Object.assign({}, ...presenceData.filter(Boolean)) as Presence,
    // The stamp changes exactly when a presence read or patch lands.
    [presenceReads.stamp],
  );
  // Authors of thread roots and record links outside the loaded members are
  // named from their person cards, once any conversation's members are known.
  const heldRaw = useMemo(
    () => [...(threadRead.data?.roots ?? []), ...(recordRead.data ?? [])],
    [threadRead.data, recordRead.data],
  );
  const known = useMemo(
    () =>
      Object.values(detailMap).flatMap((detail) =>
        detail.members.map((member) => ({ id: member.user_id })),
      ),
    [detailMap],
  );
  const authors = useCommsMessageAuthors(
    known.length ? heldRaw : noMessages,
    known,
  );
  const projected = useMemo(
    () =>
      loaded &&
      bootstrap &&
      withDetails(
        withBootstrap(loaded, bootstrap),
        detailMap,
        presence,
        threadRead.data,
        recordRead.data,
        authors,
      ),
    [
      loaded,
      bootstrap,
      detailMap,
      presence,
      threadRead.data,
      recordRead.data,
      authors,
    ],
  );
  const resource = {
    ...read,
    data: projected,
    refreshing:
      read.refreshing ||
      threadRead.refreshing ||
      recordRead.refreshing ||
      details.refreshing,
    // A failed thread or record read keeps the frame and offers Try again.
    error: read.error || threadRead.error || recordRead.error,
    reload: () => {
      read.reload();
      threadRead.reload();
      recordRead.reload();
    },
  };
  useLayoutEffect(() => {
    if (resource.data) setLastGood(resource.data);
  }, [resource.data]);
  const data =
    binding.client && resource.data?.client === binding.client
      ? resource.data
      : undefined;
  useLayoutEffect(() => {
    // This result has passed the existing query scope's abort/refusal guards.
    acceptedRead.current = data ? { client: data.client } : null;
  }, [data]);
  // Typing names come from the open conversation's members, so typing is
  // shown only from a detail read that started after the last change.
  const detailsNow = useRef(detailMap);
  useLayoutEffect(() => {
    detailsNow.current = detailMap;
  }, [detailMap]);
  const invalidateTypingRead = useCallback(() => {
    binding.scope?.bumpTypingEpoch();
  }, [binding.scope]);
  const isTypingReadCurrent = useCallback(
    (conversationId: string) =>
      acceptedRead.current !== null &&
      acceptedRead.current.client === binding.client &&
      !!binding.scope &&
      !binding.scope.signal.aborted &&
      !binding.scope.isRefused(key) &&
      !binding.scope.isRefused(conversationId) &&
      detailsNow.current[conversationId]?.readEpoch ===
        binding.scope.typingEpoch(),
    [binding.client, binding.scope, key],
  );
  useEffect(() => {
    if (!loaded || !client || !scope || scope.signal.aborted) return;
    const cached = (kind: string) =>
      cache
        .getQueryCache()
        .findAll({ queryKey: scope.keys.all })
        .filter(
          (query) =>
            query.queryKey[5] === kind && query.state.data !== undefined,
        );
    // The read started last for each held message; numbers never repeat.
    const latest = new Map<string, number>();
    let reads = 0;
    return client.events.subscribe({
      on_event(event) {
        if (scope.signal.aborted) return;
        // A presence event carries the new state; it patches cached reads.
        if (
          event.event === "presence" &&
          event.topic === `org:${client.context.org_id}:presence`
        ) {
          for (const query of cached("presence")) {
            const current = query.state.data as Presence;
            if (!Object.hasOwn(current, event.payload.user_id)) continue;
            cache.setQueryData<Presence>(query.queryKey, {
              ...current,
              [event.payload.user_id]: event.payload.state,
            });
          }
          return;
        }
        if (event.event !== "message") return;
        // The bridge applies messages to history and the bootstrap counts.
        // Only a change to a message this workspace holds reads it again:
        // that one message, or the thread lists and their new roots.
        const { conversation_id: id, seq, kind } = event.payload;
        const detailKey = scope.keys.detail(id);
        const pinned = cache
          .getQueryData<ConversationDetail>(detailKey)
          ?.pins.some((message) => message.seq === seq);
        if (kind === "pin" || (kind !== "created" && pinned))
          void cache.invalidateQueries({ queryKey: detailKey, exact: true });
        if (kind === "thread") {
          // A full root read in flight (a repair's) is not replaced by a
          // reuse; a reuse in flight restarts as one.
          reuseRoots.current = !(
            fullRead.current &&
            cache.isFetching({ queryKey: readKey(threadsKey), exact: true })
          );
          void cache.invalidateQueries({
            queryKey: readKey(threadsKey),
            exact: true,
          });
          return;
        }
        if (kind === "created" || kind === "pin") return;
        const holds = (rows: readonly Message[] | undefined) =>
          !!rows?.some(
            (message) => message.conversation_id === id && message.seq === seq,
          );
        const inThreads = holds(threadsData()?.roots),
          inRecords = holds(cache.getQueryData<Message[]>(readKey(recordsKey)));
        if (!inThreads && !inRecords) return;
        const key = `${id}:${seq}`,
          read = ++reads;
        latest.set(key, read);
        void scope
          .read(
            id,
            (signal) => client.getMessageBySequence(id, seq, { signal }),
            undefined,
            false,
          )
          .then(({ data: message }) => {
            // Assumes the server answers reads in the order they were sent:
            // an older read that lands after a newer one is dropped.
            if (latest.get(key) !== read) return;
            latest.delete(key);
            const swap = (rows: readonly Message[]) =>
              rows.map((row) => (row.id === message.id ? message : row));
            if (inThreads)
              cache.setQueryData<WorkspaceThreads>(
                readKey(threadsKey),
                (current) =>
                  current && { ...current, roots: swap(current.roots) },
              );
            if (inRecords)
              cache.setQueryData<Message[]>(
                readKey(recordsKey),
                (current) => current && swap(current),
              );
          })
          .catch((error) => {
            // A purged message has no DTO: read every list that held it again.
            // Another failure leaves them to the next repair.
            if (error instanceof ApiError && error.status === 404)
              for (const name of [
                inThreads && threadsKey,
                inRecords && recordsKey,
              ])
                if (name)
                  void cache.invalidateQueries({
                    queryKey: readKey(name),
                    exact: true,
                  });
          });
      },
      on_connection() {},
      on_error() {},
    });
  }, [loaded, client, scope, cache]);
  const displayed = data ?? lastGood ?? empty;
  const people = useMemo(
    () =>
      displayed.people.map((person) => ({
        ...person,
        groupIds: binding.groups
          .filter((group) => group.memberIds.includes(person.id))
          .map((group) => group.id),
      })),
    [displayed.people, binding.groups],
  );
  return {
    commsResource: {
      ...resource,
      data,
      hydrated: data !== undefined || lastGood !== undefined,
      status: binding.error
        ? "error"
        : !binding.client
          ? "loading"
          : resource.status,
      error: binding.error || resource.error,
      reload: binding.error ? binding.reload : resource.reload,
    },
    // Retained only to preserve mounted drafts. The page conceals this tree
    // until the current binding has produced an authorized read model.
    workspace: {
      ...displayed,
      people,
      // Thread lists are still being read: no thread is known yet.
      threadsLoading: threadRead.status === "loading",
      invalidateTypingRead,
      isTypingReadCurrent,
    },
    client: binding.client,
  };
}

type WorkspaceView = ReturnType<typeof useCommsWorkspace>["workspace"];
const WorkspaceContext = createContext<WorkspaceView | null>(null);
export function CommsWorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceView;
  children: ReactNode;
}) {
  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
export function useCommsWorkspaceView() {
  const value = useContext(WorkspaceContext);
  const refusals = useCommsRefusals();
  const visible = useMemo(() => {
    if (!value || !refusals || !Object.values(refusals).some(Boolean))
      return value;
    const allowed = (id: string) => !refusals.bootstrap && !refusals[id];
    const conversations = value.bootstrap?.conversations.filter((row) =>
      allowed(row.conversation.id),
    );
    const members = Object.fromEntries(
      Object.entries(value.members).filter(([id]) => allowed(id)),
    );
    const people = new Set(
      Object.values(members).flatMap((rows) =>
        rows.map((person) => person.user_id),
      ),
    );
    const messages = value.messages.filter((message) =>
      allowed(message.conversation),
    );
    const records = new Set(
      messages.flatMap((message) =>
        message.recordId ? [message.recordId] : [],
      ),
    );
    return {
      ...value,
      bootstrap: value.bootstrap && {
        ...value.bootstrap,
        conversations: conversations ?? [],
      },
      channels: value.channels.filter((channel) => allowed(channel.id)),
      directs: value.directs.filter((direct) => allowed(direct.id)),
      messages,
      members,
      threads: value.threads.filter((thread) => allowed(thread.conversation)),
      checks: Object.fromEntries(
        Object.entries(value.checks).filter(([id]) => allowed(id)),
      ),
      effective: Object.fromEntries(
        Object.entries(value.effective).filter(([id]) => allowed(id)),
      ),
      people: value.people.filter((person) => people.has(person.id)),
      records: value.records.filter((record) => records.has(record.id)),
    };
  }, [value, refusals]);
  if (!value)
    throw new Error("OpenComms requires its client-resolved workspace");
  return visible!;
}
