import { expect, test } from "@playwright/test";
import { createMemorySeed } from "../../support/comms-memory/memory/seed";
import {
  conversationAccess,
  eligiblePersonIds,
  canStartDirect,
} from "../../support/comms-memory/domain/access";
import { configure, policyFixture } from "./memory-fixture";
import {
  capabilityCheck,
  channelCreationCheck,
  inspectCapabilities,
  validateCapabilityConfiguration,
  scopeManagementDecision,
} from "../../support/comms-memory/domain/capabilities";
import { capabilityCheckSchema } from "@/components/systems/comms/contract/schemas";

export const context = {
  org_id: "71000000-0000-4000-8000-000000000001",
  user_id: "71000000-0000-4000-8000-000000000002",
};

test("seed identities are UUID-owned, deterministic and independent of display names", () => {
  const state = createMemorySeed(context, {
    role: "admin",
    display_name: "You",
  });
  const again = createMemorySeed(context, {
    role: "admin",
    display_name: "You",
  });
  expect(state).toEqual(again);
  const peers = Object.values(state.people).filter(
    (p) => p.user_id !== context.user_id,
  );
  expect(peers.length).toBeGreaterThanOrEqual(3);
  expect(new Set(peers.map((p) => p.user_id)).size).toBe(peers.length);
  const channel = Object.values(state.conversations).find(
    (c) => c.kind === "channel",
  )!;
  expect(conversationAccess(state, context, channel.id).level).toBe("manage");
  state.people[context.user_id].display_name = peers[0].display_name;
  expect(conversationAccess(state, context, channel.id).level).toBe("manage");
  expect(again.people[context.user_id].display_name).not.toBe(
    peers[0].display_name,
  );
  for (const entity of [
    ...Object.values(state.people),
    ...Object.values(state.conversations),
  ])
    expect(entity.org_id).toBe(context.org_id);
});

test("category configuration needs its own authority, never a child's manager or grant", () => {
  const f = policyFixture();
  const scope = { kind: "category", id: f.category.id } as const;
  f.world.members[f.channel.id][context.user_id].member_role = "manager";
  expect(scopeManagementDecision(f.world, context, scope).allowed).toBe(false);
  configure(f, {
    scope: { kind: "channel", id: f.channel.id },
    everyone: {},
    group_grants: [{ group_id: f.group.id, capability: "manageChannel" }],
  });
  expect(scopeManagementDecision(f.world, context, scope).allowed).toBe(false);
  configure(f, {
    scope,
    everyone: {},
    group_grants: [{ group_id: f.group.id, capability: "manageChannel" }],
  });
  expect(scopeManagementDecision(f.world, context, scope).allowed).toBe(true);
  expect(
    scopeManagementDecision(f.world, context, { kind: "workspace" }).allowed,
  ).toBe(false);
  f.world.capability_locks = ["manageChannel"];
  expect(scopeManagementDecision(f.world, context, scope).allowed).toBe(false);
  f.category.department_id = f.department.id;
  f.person.department_levels[f.department.id] = "manage";
  expect(scopeManagementDecision(f.world, context, scope).source).toEqual({
    kind: "manager",
    reason: "department_manager",
  });
  f.person.role = "guest";
  expect(scopeManagementDecision(f.world, context, scope).allowed).toBe(false);
});

test("seed roots, replies and thread identity share one canonical UUID graph", () => {
  const state = createMemorySeed(context, {
    role: "member",
    display_name: "You",
  });
  const messages = Object.values(state.messages);
  expect(messages.length).toBeGreaterThanOrEqual(2);
  const reply = messages.find((m) => m.parent_id !== null)!;
  const root = state.messages[reply.parent_id!];
  expect(root.parent_id).toBeNull();
  expect(reply.conversation_id).toBe(root.conversation_id);
  expect(
    Object.values(state.threads).find((t) => t.root_message_id === root.id)
      ?.conversation_id,
  ).toBe(root.conversation_id);
  expect(state.high_water_seq[root.conversation_id]).toBe(2);
  for (const m of messages) {
    expect(m.id).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    expect(state.people[m.author_id]?.org_id).toBe(context.org_id);
    expect(m).not.toHaveProperty("thread");
  }
});

test("runtime capability admission rejects foreign groups, wrong scopes and locked local changes", () => {
  const f = policyFixture();
  const scope = { kind: "channel", id: f.channel.id } as const;
  const before = structuredClone(f.world);
  const config = {
    scope,
    everyone: {},
    group_grants: [{ group_id: f.group.id, capability: "pin" }],
  };
  expect(validateCapabilityConfiguration(f.world, scope, config)).toEqual(
    config,
  );
  f.group.org_id = "71000000-0000-4000-8000-000000000099";
  expect(() => validateCapabilityConfiguration(f.world, scope, config)).toThrow(
    "refused",
  );
  f.group.org_id = f.world.org_id;
  expect(() =>
    validateCapabilityConfiguration(f.world, { kind: "workspace" }, config),
  ).toThrow("refused");
  f.world.capability_locks = ["pin"];
  expect(() => validateCapabilityConfiguration(f.world, scope, config)).toThrow(
    "refused",
  );
  f.world.capability_locks = [];
  expect(f.world).toEqual(before);
});

test("equal access and capability grants explain deterministically regardless of row order", () => {
  const f = policyFixture();
  const id = "71000000-0000-4000-8000-000000000099";
  f.world.groups[id] = { id, org_id: context.org_id, name: "Second" };
  f.person.group_ids.push(id);
  f.world.conversations[f.channel.id] = {
    ...f.channel,
    scope: "groups",
    access: [
      { subject: "group", group_id: f.group.id, level: "post" },
      { subject: "group", group_id: id, level: "read" },
    ],
  };
  const config = {
    scope: { kind: "workspace" as const },
    everyone: {},
    group_grants: [
      { group_id: f.group.id, capability: "pin" as const },
      { group_id: id, capability: "pin" as const },
    ],
  };
  configure(f, config);
  const first = capabilityCheck(f.world, context, f.channel.id);
  config.group_grants.reverse();
  const stored = f.world.conversations[f.channel.id];
  if (stored.kind === "channel" && stored.scope === "groups")
    stored.access.reverse();
  expect(capabilityCheck(f.world, context, f.channel.id)).toEqual(first);
  expect(first.conversation_level).toBe("post");
  expect(first.capabilities.pin.source).toMatchObject({
    kind: "group_grant",
    group_id: id,
  });
});

test("inspection cannot reveal foreign or inactive people and a capability grant never creates visibility", () => {
  const f = policyFixture();
  const { world, channel, group, peers } = f;
  expect(inspectCapabilities(world, context, channel.id).user_id).toBe(
    context.user_id,
  );
  expect(() =>
    inspectCapabilities(world, context, channel.id, peers[1].user_id),
  ).toThrow("refused");
  configure(f, {
    scope: { kind: "channel", id: channel.id },
    everyone: {},
    group_grants: [{ group_id: group.id, capability: "manageChannel" }],
  });
  expect(
    inspectCapabilities(world, context, channel.id, peers[1].user_id).user_id,
  ).toBe(peers[1].user_id);
  peers[1].active = false;
  expect(() =>
    inspectCapabilities(world, context, channel.id, peers[1].user_id),
  ).toThrow("refused");
  peers[1].active = true;
  peers[1].org_id = "71000000-0000-4000-8000-000000000003";
  expect(() =>
    inspectCapabilities(world, context, channel.id, peers[1].user_id),
  ).toThrow("refused");
  world.conversations[channel.id] = { ...channel, scope: "groups", access: [] };
  expect(
    capabilityCheck(world, context, channel.id).capabilities.manageChannel,
  ).toEqual({
    allowed: false,
    source: { kind: "access", reason: "no_read_access" },
  });
  expect(() => inspectCapabilities(world, context, channel.id)).toThrow(
    "refused",
  );
});

test("D36 eligibility follows shared readers; direct starts recheck guest, blocks and workspace rule", () => {
  const { world, channel, peers } = policyFixture();
  const peer = peers[1];
  expect(eligiblePersonIds(world, context)).toContain(peer.user_id);
  expect(canStartDirect(world, context, peer.user_id)).toBe(true);
  world.dm_rule = "none";
  expect(canStartDirect(world, context, peer.user_id)).toBe(false);
  world.dm_rule = "shared-channel";
  world.blocks[peer.user_id] = [
    { blocked_user_id: context.user_id, created_at: "2026-09-11T01:00:00Z" },
  ];
  expect(canStartDirect(world, context, peer.user_id)).toBe(false);
  world.blocks = {};
  peer.role = "guest";
  expect(canStartDirect(world, context, peer.user_id)).toBe(false);
  peer.role = "member";
  world.conversations[channel.id] = { ...channel, scope: "members" };
  delete world.members[channel.id][peer.user_id];
  expect(eligiblePersonIds(world, context)).not.toContain(peer.user_id);
  expect(canStartDirect(world, context, peer.user_id)).toBe(false);
  expect(canStartDirect(world, context, context.user_id)).toBe(false);
});

test("Everyone inheritance, additive reader grants and person-specific workspace locks share one explanation", () => {
  const f = policyFixture();
  const { world, channel, group, person, category } = f;
  world.conversations[channel.id] = {
    ...channel,
    scope: "groups",
    access: [{ subject: "everyone", level: "read" }],
  };
  configure(f, {
    scope: { kind: "workspace" },
    everyone: { reply: false, react: false },
    group_grants: [
      { group_id: group.id, capability: "reply" },
      { group_id: group.id, capability: "pin" },
    ],
  });
  configure(f, {
    scope: { kind: "category", id: category.id },
    everyone: { reply: false },
    group_grants: [],
  });
  configure(f, {
    scope: { kind: "channel", id: channel.id },
    everyone: { reply: false },
    group_grants: [{ group_id: group.id, capability: "manageChannel" }],
  });
  let check = capabilityCheck(world, context, channel.id);
  expect(check.capabilities.reply).toMatchObject({
    allowed: true,
    source: {
      kind: "group_grant",
      scope: { kind: "workspace" },
      group_id: group.id,
    },
  });
  expect(check.capabilities.manageChannel.allowed).toBe(true);
  expect(check.capabilities.moderate.allowed).toBe(false);
  expect(check.manager_source).toBeNull();
  world.capability_locks = ["reply", "pin", "manageChannel"];
  check = capabilityCheck(world, context, channel.id);
  expect(check.capabilities.pin).toEqual({
    allowed: true,
    source: { kind: "workspace_lock", enabled: true },
  });
  expect(check.capabilities.manageChannel).toEqual({
    allowed: false,
    source: { kind: "workspace_lock", enabled: false },
  });
  person.group_ids = [];
  expect(
    capabilityCheck(world, context, channel.id).capabilities.reply,
  ).toEqual({
    allowed: false,
    source: { kind: "workspace_lock", enabled: false },
  });
  world.conversations[channel.id] = channel;
  world.capability_locks = [];
  configure(f, {
    scope: { kind: "channel", id: channel.id },
    everyone: { react: true },
    group_grants: [],
  });
  check = capabilityCheck(world, context, channel.id);
  expect(check.capabilities.react).toMatchObject({
    allowed: true,
    source: { kind: "everyone", scope: { kind: "channel", id: channel.id } },
  });
  world.capability_locks = ["react"];
  expect(
    capabilityCheck(world, context, channel.id).capabilities.react.allowed,
  ).toBe(false);
  world.members[channel.id][context.user_id].member_role = "manager";
  expect(
    capabilityCheck(world, context, channel.id).capabilities.react.source,
  ).toEqual({ kind: "manager", reason: "membership_manager" });
});

test("creation follows the destination category and locks never manufacture a global grant", () => {
  const f = policyFixture();
  const { world, category, group, department, person } = f;
  configure(f, {
    scope: { kind: "category", id: category.id },
    everyone: {},
    group_grants: [{ group_id: group.id, capability: "createChannel" }],
  });
  const target = { kind: "category", id: category.id } as const;
  expect(channelCreationCheck(world, context, target).decision.allowed).toBe(
    true,
  );
  expect(
    channelCreationCheck(world, context, { kind: "workspace" }).decision
      .allowed,
  ).toBe(false);
  world.capability_locks = ["createChannel"];
  expect(channelCreationCheck(world, context, target).decision).toEqual({
    allowed: false,
    source: { kind: "workspace_lock", enabled: false },
  });
  category.department_id = department.id;
  person.department_levels[department.id] = "manage";
  world.capability_locks = [];
  expect(channelCreationCheck(world, context, target).decision.source).toEqual({
    kind: "department_manager",
    department_id: department.id,
    category_id: category.id,
  });
});

test("D27 defaults give posters five, managers eleven, admins thirteen and guests none", () => {
  const { world, person, channel } = policyFixture();
  const allowed = () =>
    Object.entries(capabilityCheck(world, context, channel.id).capabilities)
      .filter(([, d]) => d.allowed)
      .map(([key]) => key)
      .sort();
  expect(allowed()).toEqual([
    "attachFiles",
    "createThread",
    "linkRecords",
    "react",
    "reply",
  ]);
  world.members[channel.id][context.user_id].member_role = "manager";
  expect(allowed()).toHaveLength(11);
  expect(
    channelCreationCheck(world, context, { kind: "workspace" }).decision
      .allowed,
  ).toBe(false);
  expect(
    capabilityCheckSchema.safeParse(capabilityCheck(world, context, channel.id))
      .success,
  ).toBe(true);
  person.role = "guest";
  expect(allowed()).toEqual([]);
  expect(
    capabilityCheck(world, context, channel.id).capabilities.pin.source,
  ).toEqual({ kind: "guest_cap" });
  person.role = "admin";
  expect(allowed()).toHaveLength(13);
  expect(capabilityCheck(world, context, channel.id).access_source).toEqual({
    kind: "admin",
  });
});

test("access composes groups and department levels but never ordinary rows on group channels", () => {
  const f = policyFixture();
  const { world, channel, person, group, department, category } = f;
  category.department_id = department.id;
  person.department_levels[department.id] = "write";
  world.conversations[channel.id] = {
    ...channel,
    scope: "groups",
    access: [{ subject: "group", group_id: group.id, level: "read" }],
  };
  expect(conversationAccess(world, context, channel.id)).toMatchObject({
    level: "read",
    source: { kind: "group", group_id: group.id },
  });
  person.group_ids = [];
  expect(conversationAccess(world, context, channel.id).level).toBe("none");
  person.department_levels[department.id] = "manage";
  expect(conversationAccess(world, context, channel.id)).toMatchObject({
    level: "manage",
    manager_source: "department_manager",
  });
  world.conversations[channel.id] = {
    ...channel,
    scope: "department",
    department_id: department.id,
  };
  person.department_levels[department.id] = "read";
  expect(conversationAccess(world, context, channel.id)).toMatchObject({
    level: "read",
    source: { kind: "department", department_id: department.id },
    manager_source: null,
  });
  person.department_levels[department.id] = "write";
  expect(conversationAccess(world, context, channel.id).level).toBe("post");
  person.department_levels[department.id] = "manage";
  expect(conversationAccess(world, context, channel.id)).toMatchObject({
    level: "manage",
    manager_source: "department_manager",
  });
  person.role = "guest";
  expect(conversationAccess(world, context, channel.id)).toMatchObject({
    level: "read",
    manager_source: null,
  });
});

test("creator and explicit managers manage; direct and private membership loss hides content", () => {
  const { world, channel, person, category, department } = policyFixture();
  category.department_id = department.id;
  person.department_levels[department.id] = "write";
  world.conversations[channel.id] = {
    ...channel,
    scope: "members",
    creator_id: context.user_id,
  };
  expect(conversationAccess(world, context, channel.id)).toMatchObject({
    level: "manage",
    manager_source: "creator",
  });
  world.conversations[channel.id].creator_id = Object.keys(world.people)[1];
  world.members[channel.id][context.user_id].member_role = "manager";
  expect(conversationAccess(world, context, channel.id).manager_source).toBe(
    "membership_manager",
  );
  world.members[channel.id][context.user_id].member_role = "member";
  delete world.members[channel.id][context.user_id];
  expect(conversationAccess(world, context, channel.id).level).toBe("none");
  person.department_levels[department.id] = "manage";
  expect(conversationAccess(world, context, channel.id)).toMatchObject({
    level: "manage",
    manager_source: "department_manager",
  });
  const { id, org_id, created_at, updated_at, archived_at, creator_id } =
    world.conversations[channel.id];
  for (const kind of ["direct", "group"] as const) {
    world.conversations[id] =
      kind === "direct"
        ? { id, org_id, created_at, updated_at, archived_at, creator_id, kind }
        : {
            id,
            org_id,
            created_at,
            updated_at,
            archived_at,
            creator_id,
            kind,
            name: "Group",
          };
    expect(conversationAccess(world, context, id).level).toBe("none");
    person.role = "admin";
    expect(conversationAccess(world, context, id).level).toBe("manage");
    person.role = "member";
  }
});

test("foreign and inactive authority is refused instead of adopting a global admin", () => {
  const { world, channel, person } = policyFixture();
  person.role = "admin";
  expect(() =>
    conversationAccess(
      world,
      { ...context, org_id: "71000000-0000-4000-8000-000000000003" },
      channel.id,
    ),
  ).toThrow("refused");
  person.active = false;
  expect(() => conversationAccess(world, context, channel.id)).toThrow(
    "refused",
  );
  person.active = true;
  world.conversations[channel.id].org_id =
    "71000000-0000-4000-8000-000000000003";
  expect(() => conversationAccess(world, context, channel.id)).toThrow(
    "refused",
  );
});
