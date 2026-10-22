/** Promoted before implementation; real future dependencies, UNRUN / UNTYPECHECKED. */
import { expect } from "@playwright/test";
import type * as C from "@/components/systems/comms/contract/types";
import {
  createMemorySeed,
  hideInNewDepartment,
  organizationChannel,
} from "../../support/comms-memory/memory/seed";
import type {
  MemoryCommsState,
  MemoryMessage,
} from "../../support/comms-memory/memory/model";
import { createMemoryStore } from "../../support/comms-memory/memory/store";
import type { MemoryHandle } from "../../support/comms-memory/memory/store-types";
import { createMemoryAvailability } from "../../support/comms-memory/memory/availability";
import { createMemoryFileResources } from "../../support/comms-memory/memory/files";
import { createOperationalResources } from "../../support/comms-memory/memory/operational-resources";
import {
  createMessageFamily,
  projectReadSummary,
} from "../../support/comms-memory/memory/messages";
type MessageFamily = ReturnType<typeof createMessageFamily>;
type MessageBinding = Parameters<typeof createMessageFamily>[0];

export const id = (n: number) =>
  `73000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const owner: C.CommsContext = { org_id: id(1), user_id: id(2) };
export const now = Date.parse("2026-10-19T04:00:00Z");
export const time = new Date(now).toISOString();
export const preferences: C.MemberPreferences = {
  notify: "all",
  mute: { kind: "off" },
  starred: false,
  hidden: false,
  manual_unread: false,
};

export function setup() {
  const initial = createMemorySeed(owner, {
    role: "member",
    display_name: "Reader",
  });
  // Without its category's department link the seed room is an organization channel.
  const channel = organizationChannel(Object.values(initial.conversations)[0]);
  if (channel.kind !== "channel")
    throw new Error("Fixture requires seed channel");
  initial.conversations[channel.id] = channel;
  // Every person keeps a row a case may copy into a direct message.
  initial.members[channel.id] = Object.fromEntries(
    Object.keys(initial.people).map((user_id) => [
      user_id,
      {
        user_id,
        member_role: "member" as const,
        joined_at: channel.created_at,
      },
    ]),
  );
  const root = Object.values(initial.messages).find(
    (m) => m.parent_id === null,
  )!;
  const reply = Object.values(initial.messages).find(
    (m) => m.parent_id !== null,
  )!;
  const record = Object.values(initial.records)[0];
  const guest = Object.values(initial.people).find((p) => p.role === "guest")!;
  const managerId = root.author_id; // Seed creator; not a name-derived identity.
  const peerId = reply.author_id;
  initial.categories[channel.category_id!].department_id = null;
  initial.messages = {};
  initial.threads = {};
  initial.high_water_seq[channel.id] = 0;
  initial.records[id(20)] = {
    ...structuredClone(record),
    id: id(20),
    title: "Second visit",
  };
  const hiddenId = id(21);
  initial.conversations[hiddenId] = {
    ...channel,
    id: hiddenId,
    name: "private",
  };
  hideInNewDepartment(initial, hiddenId, id(23));
  initial.members[hiddenId] = {};
  initial.high_water_seq[hiddenId] = 0;
  const otherChannelId = id(22);
  initial.conversations[otherChannelId] = {
    ...channel,
    id: otherChannelId,
    name: "other",
  };
  initial.members[otherChannelId] = structuredClone(
    initial.members[channel.id],
  );
  initial.high_water_seq[otherChannelId] = 0;
  return {
    initial,
    channelId: channel.id,
    hiddenId,
    otherChannelId,
    managerId,
    peerId,
    guestId: guest.user_id,
    recordId: record.id,
    secondRecordId: id(20),
    moduleId: record.module_id,
  };
}
export type Setup = ReturnType<typeof setup>;

/** Literal data builder only; no filtering, authorization, counts or command behavior. */
export function seedMessage(
  s: Setup,
  n: number,
  seq: number,
  patch: Partial<MemoryMessage> = {},
) {
  const message: MemoryMessage = {
    id: id(n),
    org_id: owner.org_id,
    conversation_id: s.channelId,
    seq,
    author_id: s.peerId,
    client_key: id(n + 10_000),
    created_at: time,
    parent_id: null,
    reply_to_id: null,
    also_send_to_channel: false,
    state: "live",
    body: `Entry ${seq}`,
    edited_at: null,
    pinned_at: null,
    pinned_by: null,
    attachment_ids: [],
    record_links: [],
    mention_user_ids: [],
    mentions_channel: false,
    mentions_here: false,
    reactions: [],
    link_previews: [],
    deleted_at: null,
    ...patch,
  };
  s.initial.messages[message.id] = message;
  s.initial.high_water_seq[message.conversation_id] = Math.max(
    s.initial.high_water_seq[message.conversation_id] ?? 0,
    seq,
  );
  return message;
}
export function seedThread(s: Setup, root: MemoryMessage, n = 900) {
  const thread = {
    id: id(n),
    org_id: owner.org_id,
    conversation_id: root.conversation_id,
    root_message_id: root.id,
    name: "",
    resolved: false,
    locked: false,
    archived: false,
    starter_id: root.author_id,
  };
  s.initial.threads[thread.id] = thread;
  return thread;
}

export function fixture(s = setup(), snapshot?: unknown, incarnation = 1) {
  let clock = now;
  const readClock = () => clock;
  let next = 1;
  const store = createMemoryStore({
    owner,
    initial: s.initial,
    snapshot,
    clock: readClock,
    uuid: () =>
      `73100000-0000-4000-${(0x8000 + incarnation).toString(16)}-${(next++).toString(16).padStart(12, "0")}`,
  });
  const files = createMemoryFileResources(store);
  const clients = new Map<string, MessageFamily>();
  const handles = new Map<string, MemoryHandle>();
  const bindings = new Map<string, MessageBinding>();
  const handle = (userId = owner.user_id) => {
    let result = handles.get(userId);
    if (!result) {
      result = store.bind({ ...owner, user_id: userId });
      handles.set(userId, result);
    }
    return result;
  };
  const ownerHandle = handle();
  const ownerBinding: MessageBinding = {
    handle: ownerHandle,
    authority: createMemoryAvailability(ownerHandle.context).authority,
  };
  bindings.set(owner.user_id, ownerBinding);
  const controls = createOperationalResources(store, {
    files,
    clock: readClock,
    ownerBinding,
  });
  const binding = (userId = owner.user_id) => {
    let result = bindings.get(userId);
    if (!result) {
      const bound = handle(userId);
      const dependencies = controls.sendDependenciesFor(bound);
      result = { handle: bound, authority: dependencies.authority };
      bindings.set(userId, result);
    }
    return result;
  };
  const as = (userId = owner.user_id) => {
    let client = clients.get(userId);
    if (!client) {
      const bound = binding(userId);
      const dependencies = controls.sendDependenciesFor(bound.handle);
      client = createMessageFamily(bound, dependencies);
      clients.set(userId, client);
    }
    return client;
  };
  return {
    ...s,
    store,
    files,
    controls,
    handle,
    binding,
    as,
    clock: readClock,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    summary: (conversationId = s.channelId, userId = owner.user_id) =>
      handle(userId).read((state, context) =>
        projectReadSummary(state, context, conversationId),
      ),
    close: () => {
      controls.dispose();
      files.dispose();
      store.dispose();
    },
  };
}
export type Fixture = ReturnType<typeof fixture>;

export function collect(f: Fixture, userId = owner.user_id) {
  const events: C.CommsEvent[] = [];
  const stop = f.handle(userId).events.subscribe({
    on_event: (event) => {
      events.push(event);
    },
    on_connection: () => {},
    on_error: () => {},
  });
  return { events, stop };
}
export function created(events: C.CommsEvent[]) {
  return events.flatMap((e) =>
    e.event === "message" && e.payload.kind === "created"
      ? [e.payload.seq]
      : [],
  );
}
export function edit(body: string): C.EditMessageRequest {
  return {
    body,
    mention_user_ids: [],
    mentions_channel: false,
    mentions_here: false,
  };
}
export async function httpFailure(
  promise: Promise<unknown>,
  status: number,
  code: string,
) {
  await expect(promise).rejects.toMatchObject({
    kind: "http",
    failure: { status, body: { detail: { code } } },
  });
}
/** Synthetic authority update, not an implementation of any conversation/client method. */
export async function changeAuthority(
  f: Fixture,
  change: (draft: MemoryCommsState) => void,
) {
  await f.handle(f.managerId).command({
    authorize(current, execution) {
      if (
        current.conversations[f.channelId].creator_id !==
        execution.context.user_id
      )
        throw new Error("Fixture authority changed unexpectedly");
    },
    apply(draft) {
      change(draft);
      return {
        kind: "commit",
        value: undefined,
        version_keys: [`conversation:${f.channelId}`],
        publications: [],
      };
    },
  });
}
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

/** Real local PNG bytes; these tests make no parser/antivirus guarantee. */
export function png() {
  return new Blob(
    [
      Uint8Array.from(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        ),
      ),
    ],
    { type: "image/png" },
  );
}
export async function upload(f: Fixture, filename = "pixel.png") {
  const bytes = png();
  const reserved = await f
    .as()
    .reserveAttachment(f.channelId, { filename, expected_size: bytes.size });
  return f.as().uploadAttachment(f.channelId, reserved.id, bytes);
}
