/** Accepted family fixture: real store, availability and typed method factories. */
import { expect, test as base } from "@playwright/test";
import type {
  CommsEvent,
  SettingsScope,
} from "@/components/systems/comms/contract/types";
import { createMemorySeed } from "@/components/systems/comms/memory/seed";
import { createMemoryStore } from "@/components/systems/comms/memory/store";
import { createMemoryAvailability } from "@/components/systems/comms/memory/availability";
import { createConversationOperations } from "@/components/systems/comms/memory/conversation-operations";
import { createConfigurationOperations } from "@/components/systems/comms/memory/configuration-operations";

export const owner = {
  org_id: "73000000-0000-4000-8000-000000000001",
  user_id: "73000000-0000-4000-8000-000000000002",
};
export const foreignOrg = "73000000-0000-4000-8000-000000000003";
export const absentId = "73000000-0000-4000-8000-000000000099";
export const now = Date.parse("2026-10-19T08:00:00Z");
export const workspace = { kind: "workspace" } as const;

export function seedFixture(orgId = owner.org_id) {
  const context = { ...owner, org_id: orgId };
  const initial = createMemorySeed(context, {
    role: "member",
    display_name: "Alex",
  });
  const channel = Object.values(initial.conversations).find(
    (c) => c.kind === "channel",
  );
  const category = Object.values(initial.categories)[0];
  const group = Object.values(initial.groups)[0];
  const admin = initial.people[channel?.creator_id ?? ""];
  const peer = Object.values(initial.people).find(
    (p) =>
      p.user_id !== context.user_id &&
      p.user_id !== admin?.user_id &&
      p.role === "member",
  );
  const guest = Object.values(initial.people).find((p) => p.role === "guest");
  if (!channel || !category || !group || !admin || !peer || !guest)
    throw new Error(
      "The accepted small seed must contain its channel, category and three peers",
    );
  admin.role = "admin";
  peer.display_name = "Alex"; // Same name, different domain identity.
  category.department_id = null; // No ordinary-department correction case here.
  for (const person of Object.values(initial.people)) {
    person.group_ids = person.user_id === context.user_id ? [group.id] : [];
    person.department_levels = {};
  }
  return { initial, context, channel, category, group, admin, peer, guest };
}
export type SeedFixture = ReturnType<typeof seedFixture>;

function createFamilyFixture(
  prepare?: (seed: SeedFixture) => void,
  orgId = owner.org_id,
  incarnation = 1,
) {
  const seed = seedFixture(orgId);
  prepare?.(seed); // Typed data preparation only, never an expected-policy calculator.
  let sequence = 1;
  const store = createMemoryStore({
    owner: seed.context,
    initial: seed.initial,
    clock: () => now,
    uuid: () =>
      `73000000-0000-4000-${(0x8000 + incarnation).toString(16)}-${(sequence++).toString(16).padStart(12, "0")}`,
  });
  const events: { user_id: string; event: CommsEvent }[] = [];
  function bind(userId: string) {
    const handle = store.bind({ ...seed.context, user_id: userId });
    const { authority } = createMemoryAvailability(handle.context);
    const binding = { handle, authority };
    handle.events.subscribe({
      on_event: (event) => {
        events.push({ user_id: userId, event: structuredClone(event) });
      },
      on_connection: () => {},
      on_error: () => {},
    });
    return {
      ...createConversationOperations(binding),
      ...createConfigurationOperations(binding),
    };
  }
  return {
    store,
    events,
    actor: bind(seed.context.user_id),
    admin: bind(seed.admin.user_id),
    peer: bind(seed.peer.user_id),
    guest: bind(seed.guest.user_id),
    context: seed.context,
    actorId: seed.context.user_id,
    adminId: seed.admin.user_id,
    peerId: seed.peer.user_id,
    guestId: seed.guest.user_id,
    channelId: seed.channel.id,
    categoryId: seed.category.id,
    groupId: seed.group.id,
    channelScope: { kind: "channel", id: seed.channel.id } as const,
    categoryScope: { kind: "category", id: seed.category.id } as const,
  };
}
export type FamilyFixture = ReturnType<typeof createFamilyFixture>;
export type Family = FamilyFixture["actor"];

export const test = base.extend<{
  make: (
    prepare?: (seed: SeedFixture) => void,
    orgId?: string,
  ) => FamilyFixture;
}>({
  make: async ({}, supply) => {
    const fixtures: FamilyFixture[] = [];
    await supply((prepare, orgId) => {
      const f = createFamilyFixture(prepare, orgId, fixtures.length + 1);
      fixtures.push(f);
      return f;
    });
    for (const f of fixtures) f.store.dispose();
  },
});
export { expect };

/** No canonical state/version/history change AND no success event on refusal. */
export async function refuses(
  f: FamilyFixture,
  action: () => Promise<unknown>,
  status: number,
  code?: string,
  message?: string,
) {
  const before = structuredClone(f.store.exportSnapshot());
  const events = structuredClone(f.events);
  const detail = {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
  await expect(action()).rejects.toMatchObject({
    kind: "http",
    failure: { status, ...(code || message ? { body: { detail } } : {}) },
  });
  expect(f.store.exportSnapshot()).toEqual(before);
  expect(f.events).toEqual(events);
}

export async function grant(
  f: FamilyFixture,
  scope: SettingsScope,
  capability: "manageChannel" | "createChannel",
) {
  const current = await f.admin.getCapabilityConfiguration(scope);
  return f.admin.setCapabilityConfiguration(
    {
      ...current.data,
      group_grants: [
        ...current.data.group_grants,
        { group_id: f.groupId, capability },
      ],
    },
    { if_match: current.etag },
  );
}

export async function privateChannel(f: FamilyFixture) {
  return f.admin.createChannel({
    name: "Private dispatch",
    topic: "Owned fixture",
    position: 1,
    category_id: f.categoryId,
    scope: "members",
    member_ids: [f.actorId, f.peerId],
  });
}
