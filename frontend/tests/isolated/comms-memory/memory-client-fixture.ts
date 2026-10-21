/** PROMOTED / UNRUN. Future real owner import; not a success-shaped factory fake. */
import { expect, test as base } from "@playwright/test";
import type { CommsClient } from "@/components/systems/comms/contract/client";
import type * as C from "@/components/systems/comms/contract/types";
import { createMemoryCommsRuntime } from "../../support/comms-memory/memory-client";
import { seedFixture, now, foreignOrg } from "./memory-family-fixture";
import { png } from "./memory-message-fixture";
import { barrier } from "./memory-operational-fixture";

export { expect, barrier, png, now, foreignOrg };
export const marker = "CONFIRM LOCAL SAMPLE";
export const workspace = { kind: "workspace" } as const;
export const id = (n: number) =>
  `75000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
type RuntimeOptions = NonNullable<
  Parameters<typeof createMemoryCommsRuntime>[1]
>;
type Options = Pick<
  RuntimeOptions,
  "beforeScheduleSend" | "verifyConfirmation"
> & {
  role?: "admin" | "member";
  orgId?: string;
  extraConversations?: number;
  snapshot?: unknown;
};

export function observe(client: CommsClient) {
  const events: C.CommsEvent[] = [];
  const connections: C.ConnectionState[] = [];
  const errors: C.RuntimeFailure[] = [];
  const stop = client.events.subscribe({
    on_event: (event) => {
      events.push(structuredClone(event));
    },
    on_connection: (state) => {
      connections.push(structuredClone(state));
    },
    on_error: (error) => {
      errors.push(error);
    },
  });
  return { events, connections, errors, stop };
}

function fixture(options: Options = {}, incarnation = 1) {
  const s = seedFixture(options.orgId);
  s.initial.people[s.context.user_id].role = options.role ?? "admin";
  s.initial.members[s.channel.id][s.context.user_id].member_role = "manager";
  // A data-only current grant for J1 creation; no fixture permission evaluator.
  s.initial.configuration.workspace = {
    settings: {},
    capabilities: {
      scope: workspace,
      everyone: {},
      group_grants: [{ group_id: s.group.id, capability: "createChannel" }],
    },
  };
  const root = Object.values(s.initial.messages).find(
    (m) => m.parent_id === null,
  )!;
  const reply = Object.values(s.initial.messages).find(
    (m) => m.parent_id !== null,
  )!;
  reply.mention_user_ids = [s.context.user_id];
  const otherId = id(90),
    hiddenId = id(91);
  s.initial.conversations[otherId] = {
    ...s.channel,
    id: otherId,
    name: "Sibling room",
    position: 1,
  };
  s.initial.members[otherId] = structuredClone(s.initial.members[s.channel.id]);
  s.initial.high_water_seq[otherId] = 0;
  s.initial.conversations[hiddenId] = {
    ...s.channel,
    id: hiddenId,
    name: "Private sibling",
    scope: "members",
    position: 2,
  };
  s.initial.members[hiddenId] = {
    [s.peer.user_id]: {
      user_id: s.peer.user_id,
      member_role: "member",
      joined_at: root.created_at,
    },
  };
  s.initial.high_water_seq[hiddenId] = 0;
  for (let i = 0; i < (options.extraConversations ?? 0); i += 1) {
    const channelId = id(1000 + i);
    s.initial.conversations[channelId] = {
      ...s.channel,
      id: channelId,
      name: `Complete room ${i}`,
      position: i + 3,
    };
    s.initial.members[channelId] = structuredClone(
      s.initial.members[s.channel.id],
    );
    s.initial.high_water_seq[channelId] = 0;
  }
  let time = now,
    sequence = 1;
  const runtime = createMemoryCommsRuntime(
    { owner: s.context, initial: s.initial, snapshot: options.snapshot },
    {
      clock: () => time,
      uuid: () =>
        `75100000-0000-4000-${(0x8000 + incarnation).toString(16)}-${(sequence++).toString(16).padStart(12, "0")}`,
      ...(options.beforeScheduleSend
        ? { beforeScheduleSend: options.beforeScheduleSend }
        : {}),
      ...(options.verifyConfirmation
        ? { verifyConfirmation: options.verifyConfirmation }
        : {}),
    },
  );
  const observed = observe(runtime.client);
  let changes = 0;
  const stopChanges = runtime.subscribe(() => {
    changes += 1;
  });
  return {
    runtime,
    client: runtime.client,
    ...observed,
    context: s.context,
    channelId: s.channel.id,
    categoryId: s.category.id,
    rootId: root.id,
    replyId: reply.id,
    peerId: s.peer.user_id,
    otherId,
    hiddenId,
    channelScope: { kind: "channel", id: s.channel.id } as const,
    categoryScope: { kind: "category", id: s.category.id } as const,
    advance: (ms: number) => {
      time += ms;
    },
    changes: () => changes,
    close: () => {
      observed.stop();
      stopChanges();
      runtime.dispose();
    },
  };
}
export type Fixture = ReturnType<typeof fixture>;
export const test = base.extend<{ make: (options?: Options) => Fixture }>({
  make: async ({}, provide) => {
    const fixtures: Fixture[] = [];
    try {
      await provide((options) => {
        const f = fixture(options, fixtures.length + 1);
        fixtures.push(f);
        return f;
      });
    } finally {
      for (const f of fixtures) f.close();
    }
  },
});

export const send = (body: string, key: number): C.SendMessageRequest => ({
  body,
  client_key: id(key),
  attachment_ids: [],
  record_ids: [],
  mention_user_ids: [],
  mentions_channel: false,
  mentions_here: false,
  reply_to_id: null,
});
export const edit = (body: string): C.EditMessageRequest => ({
  body,
  mention_user_ids: [],
  mentions_channel: false,
  mentions_here: false,
});
export function channelRequest(
  categoryId: string | null,
  name = "Created through the client",
): C.ChannelRequest {
  return {
    name,
    topic: "Owned example",
    category_id: categoryId,
    position: 100,
    scope: "organization",
  };
}
export const schedule = (f: Fixture, key: number): C.ScheduleRequest => ({
  ...send("Scheduled from the full client", key),
  conversation_id: f.channelId,
  send_at: new Date(now + 60_000).toISOString(),
  parent_id: null,
  also_send_to_channel: false,
});
export async function upload(f: Fixture) {
  const bytes = png();
  const reserved = await f.client.reserveAttachment(f.channelId, {
    filename: "pixel.png",
    expected_size: bytes.size,
  });
  return f.client.uploadAttachment(f.channelId, reserved.id, bytes);
}
export async function refuses(
  f: Fixture,
  action: () => Promise<unknown>,
  status: number,
  code?: string,
) {
  const before = f.runtime.exportSnapshot(),
    events = structuredClone(f.events),
    changes = f.changes();
  await expect(action()).rejects.toMatchObject({
    kind: "http",
    failure: { status, ...(code ? { body: { detail: { code } } } : {}) },
  });
  expect(f.runtime.exportSnapshot()).toEqual(before);
  expect(f.events).toEqual(events);
  expect(f.changes()).toBe(changes);
}
export function result(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => ({ kind: "resolved", value }),
    (error: unknown) => error,
  );
}
// One event-loop checkpoint only after releasing an explicit held dependency.
export const afterRelease = () =>
  new Promise<void>((resolve) => setImmediate(resolve));
export const createdSequences = (events: C.CommsEvent[]) =>
  events.flatMap((e) =>
    e.event === "message" && e.payload.kind === "created"
      ? [e.payload.seq]
      : [],
  );

// Owner notifications remain observable while every browser client is retired.
export function scheduleCompletion(f: Fixture, scheduleId: string) {
  let resolve!: (job: C.Schedule) => void;
  const completed = new Promise<C.Schedule>((done) => {
    resolve = done;
  });
  const inspect = () => {
    const job = f.runtime.exportSnapshot().state.schedules[scheduleId];
    if (job && job.status !== "pending" && job.status !== "running")
      resolve(job);
  };
  const stop = f.runtime.subscribe(inspect);
  inspect();
  return { completed, stop };
}
