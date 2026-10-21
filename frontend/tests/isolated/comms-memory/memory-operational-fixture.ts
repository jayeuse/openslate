/** PROMOTED / UNRUN. Missing real family/resource exports are SETUP, not RED. */
import { expect, test as base } from "@playwright/test";
import type * as C from "@/components/systems/comms/contract/types";
import type {
  MemoryCommsState,
  MemoryMessage,
} from "../../support/comms-memory/memory/model";
import { createMemorySeed } from "../../support/comms-memory/memory/seed";
import { createMemoryStore } from "../../support/comms-memory/memory/store";
import {
  createMemoryAvailability,
  type MemoryClientBinding,
} from "../../support/comms-memory/memory/availability";
import { createConversationOperations } from "../../support/comms-memory/memory/conversation-operations";
import { createConfigurationOperations } from "../../support/comms-memory/memory/configuration-operations";
import { createMemoryFileResources } from "../../support/comms-memory/memory/files";
import { createMessageFamily } from "../../support/comms-memory/memory/messages";
import { createOperationalFamily } from "../../support/comms-memory/memory/operations";
import { createOperationalResources } from "../../support/comms-memory/memory/operational-resources";

export const id = (n: number) =>
  `75000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const now = Date.parse("2026-10-19T10:00:00Z");
export const iso = (milliseconds = now) => new Date(milliseconds).toISOString();

export function seed(offset = 0) {
  const context: C.CommsContext = {
    org_id: id(offset + 1),
    user_id: id(offset + 2),
  };
  const initial: MemoryCommsState = createMemorySeed(context, {
    role: "member",
    display_name: "Reporter",
  });
  const original = Object.values(initial.conversations)[0];
  const root = Object.values(initial.messages).find(
    (m) => m.parent_id === null,
  );
  const reply = Object.values(initial.messages).find(
    (m) => m.parent_id !== null,
  );
  const guest = Object.values(initial.people).find((p) => p.role === "guest");
  if (original.kind !== "channel" || !root || !reply || !guest)
    throw new Error("Expected accepted seed graph");
  const channelId = id(offset + 10),
    privateId = id(offset + 11),
    closedId = id(offset + 12);
  const managerId = root.author_id,
    peerId = reply.author_id,
    outsiderId = id(offset + 40);
  initial.categories[original.category_id!].department_id = null;
  for (const person of Object.values(initial.people))
    person.department_levels = {};
  initial.people[outsiderId] = {
    ...initial.people[context.user_id],
    user_id: outsiderId,
    display_name: "Unrelated person",
    group_ids: [],
    department_levels: {},
    readable_module_ids: [],
  };
  initial.users[outsiderId] = structuredClone(initial.users[context.user_id]);
  const channel = { ...original, id: channelId, scope: "members" as const };
  initial.conversations = {
    [channelId]: channel,
    [privateId]: { ...channel, id: privateId, name: "Request-only room" },
    [closedId]: { ...channel, id: closedId, name: "Invitation-only room" },
  };
  initial.members = {
    [channelId]: initial.members[original.id],
    [privateId]: {
      [managerId]: initial.members[original.id][managerId],
      [peerId]: initial.members[original.id][peerId],
    },
    [closedId]: { [managerId]: initial.members[original.id][managerId] },
  };
  for (const [cid, join_rule] of [
    [privateId, "request"],
    [closedId, "invite"],
  ] as const) {
    initial.configuration[`channel:${cid}`] = {
      settings: { join_rule },
      capabilities: {
        scope: { kind: "channel", id: cid },
        group_grants: [],
        everyone: {},
      },
    };
  }
  const rootMessage: MemoryMessage = {
    ...root,
    id: id(offset + 20),
    conversation_id: channelId,
    body: "Review this dispatch",
    record_links: [],
    created_at: iso(now - 60_000),
  };
  const replyMessage: MemoryMessage = {
    ...reply,
    id: id(offset + 21),
    conversation_id: channelId,
    parent_id: rootMessage.id,
    body: "Context must survive",
    created_at: iso(now - 60_000),
  };
  const threadId = id(offset + 22);
  initial.messages = {
    [rootMessage.id]: rootMessage,
    [replyMessage.id]: replyMessage,
  };
  initial.threads = {
    [threadId]: {
      id: threadId,
      org_id: context.org_id,
      conversation_id: channelId,
      root_message_id: rootMessage.id,
      starter_id: managerId,
      name: "Review context",
      resolved: false,
      locked: false,
      archived: false,
    },
  };
  initial.high_water_seq = { [channelId]: 2, [privateId]: 0, [closedId]: 0 };
  return {
    initial,
    context,
    channelId,
    privateId,
    closedId,
    managerId,
    peerId,
    guestId: guest.user_id,
    outsiderId,
    rootId: rootMessage.id,
    replyId: replyMessage.id,
    threadId,
  };
}
export type Seed = ReturnType<typeof seed>;
type Options = {
  offset?: number;
  prepare?: (data: Seed) => void;
  snapshot?: unknown;
  beforeScheduleSend?: (jobId: string, signal: AbortSignal) => Promise<void>;
};
type Family = ReturnType<typeof createConversationOperations> &
  ReturnType<typeof createConfigurationOperations> &
  ReturnType<typeof createMessageFamily> &
  ReturnType<typeof createOperationalFamily>;

function createFixture(options: Options = {}, incarnation = 1) {
  const data = seed(options.offset);
  options.prepare?.(data); // Typed initial data only. Never mutate this graph after bind.
  let clock = now,
    next = 1;
  const readClock = () => clock;
  const store = createMemoryStore({
    owner: data.context,
    initial: data.initial,
    snapshot: options.snapshot,
    clock: readClock,
    uuid: () =>
      `75100000-0000-4000-${(0x8000 + incarnation).toString(16)}-${(next++).toString(16).padStart(12, "0")}`,
  });
  const handles = new Map<string, ReturnType<typeof store.bind>>();
  const handle = (userId = data.context.user_id) => {
    let current = handles.get(userId);
    if (!current) {
      current = store.bind({ ...data.context, user_id: userId });
      handles.set(userId, current);
    }
    return current;
  };
  const ownerHandle = handle(data.context.user_id);
  const ownerAvailability = createMemoryAvailability(ownerHandle.context);
  const ownerBinding: MemoryClientBinding = {
    handle: ownerHandle,
    authority: ownerAvailability.authority,
  };
  const files = createMemoryFileResources(store);
  const controls = createOperationalResources(store, {
    files,
    clock: readClock,
    ownerBinding,
    beforeScheduleSend: options.beforeScheduleSend,
  });
  const bindings = new Map<string, MemoryClientBinding>();
  const binding = (userId = data.context.user_id) => {
    let bound = bindings.get(userId);
    if (!bound) {
      const boundHandle = handle(userId);
      const dependencies = controls.sendDependenciesFor(boundHandle);
      bound = { handle: boundHandle, authority: dependencies.authority };
      bindings.set(userId, bound);
    }
    return bound;
  };
  const clients = new Map<string, Family>();
  const as = (userId = data.context.user_id) => {
    let client = clients.get(userId);
    if (!client) {
      const bound = binding(userId);
      const dependencies = controls.sendDependenciesFor(bound.handle);
      client = {
        ...createConversationOperations(bound),
        ...createConfigurationOperations(bound),
        ...createMessageFamily(bound, dependencies),
        ...createOperationalFamily(bound, controls),
      };
      clients.set(userId, client);
    }
    return client;
  };
  const deliveries: { user_id: string; event: C.CommsEvent }[] = [];
  for (const userId of Object.keys(data.initial.people)) {
    handle(userId).events.subscribe({
      on_event: (event) => {
        deliveries.push({ user_id: userId, event: structuredClone(event) });
      },
      on_connection: () => {},
      on_error: () => {},
    });
  }
  return {
    ...data,
    store,
    files,
    controls,
    ownerBinding,
    authority: ownerBinding.authority,
    ownerAvailabilityControls: ownerAvailability.controls,
    as,
    handle,
    binding,
    deliveries,
    clock: readClock,
    advance: (ms: number) => {
      clock += ms;
    },
    events: (userId = data.context.user_id) =>
      deliveries.filter((d) => d.user_id === userId).map((d) => d.event),
    close: () => {
      controls.dispose();
      files.dispose();
      store.dispose();
    },
  };
}
export type Fixture = ReturnType<typeof createFixture>;
export const test = base.extend<{ make: (options?: Options) => Fixture }>({
  make: async ({}, provide) => {
    const fixtures: Fixture[] = [];
    try {
      await provide((options) => {
        const f = createFixture(options, fixtures.length + 1);
        fixtures.push(f);
        return f;
      });
    } finally {
      for (const f of fixtures) f.close();
    }
  },
});
export { expect };

export async function refuses(
  f: Fixture,
  action: () => Promise<unknown>,
  status: number,
  code: string,
) {
  const state = structuredClone(f.store.exportSnapshot()),
    events = structuredClone(f.deliveries);
  await expect(action()).rejects.toMatchObject({
    kind: "http",
    failure: { status, body: { detail: { code } } },
  });
  expect(f.store.exportSnapshot()).toEqual(state);
  expect(f.deliveries).toEqual(events);
}
export function created(f: Fixture, userId = f.managerId) {
  return f
    .events(userId)
    .filter((e) => e.event === "message" && e.payload.kind === "created");
}
export function schedule(
  f: Fixture,
  n: number,
  patch: Partial<C.ScheduleRequest> = {},
): C.ScheduleRequest {
  return {
    conversation_id: f.channelId,
    client_key: id(n),
    body: "Scheduled dispatch",
    send_at: iso(now + 60_000),
    ...patch,
  };
}
export async function settings(
  f: Fixture,
  patch: C.SettingsPatch,
  conversationId = f.channelId,
) {
  const actor = f.as(f.managerId),
    scope = { kind: "channel", id: conversationId } as const;
  const current = await actor.getSettings(scope);
  return actor.updateSettings(scope, patch, { if_match: current.etag });
}
export function barrier() {
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    release,
    reached,
    hold: async () => {
      entered();
      await waiting;
    },
  };
}
export async function upload(f: Fixture, userId = f.context.user_id) {
  const bytes = new Blob(
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
  const file = await f.as(userId).reserveAttachment(f.channelId, {
    filename: "dispatch.png",
    expected_size: bytes.size,
  });
  return f.as(userId).uploadAttachment(f.channelId, file.id, bytes);
}
