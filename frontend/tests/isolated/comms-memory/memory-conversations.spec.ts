/** Accepted structural journeys through the real memory method families. */
import type { ConditionalOptions } from "@/components/systems/comms/contract/types";
import {
  test,
  expect,
  refuses,
  grant,
  secondOrganizationChannel,
  foreignOrg,
  absentId,
  now,
  workspace,
} from "./memory-family-fixture";

test("a real structural command enforces the current capability, then archives and restores", async ({
  make,
}) => {
  const f = make();
  const original = await f.actor.getConversation(f.channelId);
  await refuses(
    f,
    () => f.actor.archiveConversation(f.channelId, { if_match: original.etag }),
    403,
    "comms_capability_denied",
  );
  await grant(f, f.channelScope, "manageChannel");
  const check = await f.actor.getCapabilities(f.channelId);
  expect(check.manager_source).toBeNull();
  expect(check.capabilities.manageChannel.allowed).toBe(true);
  expect(check.capabilities.moderate.allowed).toBe(false);
  const current = await f.actor.getConversation(f.channelId);
  const archived = await f.actor.archiveConversation(f.channelId, {
    if_match: current.etag,
  });
  expect(archived.data.archived_at).toBe(new Date(now).toISOString());
  expect(
    (await f.actor.listConversations()).items.map((c) => c.id),
  ).not.toContain(f.channelId);
  expect(
    (await f.actor.listConversations({ archived: true })).items.map(
      (c) => c.id,
    ),
  ).toContain(f.channelId);
  const restored = await f.actor.restoreConversation(f.channelId, {
    if_match: archived.etag,
  });
  expect(restored.data.archived_at).toBeNull();
  expect((await f.actor.listConversations()).items.map((c) => c.id)).toContain(
    f.channelId,
  );
  expect(f.events.some(({ event }) => event.event === "structure")).toBe(true);
});

test("foreign resource IDs cannot be read, inspected or mutated through an org-local admin", async ({
  make,
}) => {
  const a = make();
  const b = make(undefined, foreignOrg);
  // Seed IDs intentionally repeat across worlds. Create genuinely foreign-only IDs.
  const category = await b.admin.createCategory({
    name: "B only",
    position: 1,
    department_id: null,
  });
  const channel = await b.admin.createChannel({
    name: "B channel",
    topic: "Private B",
    position: 0,
    category_id: category.data.id,
    scope: "organization",
  });
  const foreignBefore = structuredClone(b.store.exportSnapshot());
  await refuses(
    a,
    () => a.admin.getConversation(channel.data.id),
    404,
    "comms_not_found",
  );
  await refuses(
    a,
    () =>
      a.admin.updateChannel(
        channel.data.id,
        { topic: "Cross-org" },
        { if_match: channel.etag },
      ),
    404,
    "comms_not_found",
  );
  await refuses(
    a,
    () => a.admin.listMembers(channel.data.id),
    404,
    "comms_not_found",
  );
  await refuses(
    a,
    () => a.admin.getSettings({ kind: "channel", id: channel.data.id }),
    404,
    "comms_not_found",
  );
  await refuses(
    a,
    () => a.admin.getCategory(category.data.id),
    404,
    "comms_not_found",
  );
  expect(
    (await a.admin.listConversations()).items.map((c) => c.id),
  ).not.toContain(channel.data.id);
  expect((await b.admin.getConversation(channel.data.id)).data).toMatchObject({
    id: channel.data.id,
    org_id: foreignOrg,
    topic: "Private B",
  });
  expect(b.store.exportSnapshot()).toEqual(foreignBefore);
});

test("category changes and channel moves recompute inheritance; conditional patches are atomic", async ({
  make,
}) => {
  const f = make();
  const created = await f.admin.createCategory({
    name: "Destination",
    position: 2,
    department_id: null,
  });
  const renamed = await f.admin.updateCategory(
    created.data.id,
    {
      name: "A destination",
      position: 0,
      department_id: null,
    },
    { if_match: created.etag },
  );
  expect((await f.admin.getCategory(created.data.id)).data.name).toBe(
    "A destination",
  );
  expect(
    (await f.admin.listCategories({ search: "destination", limit: 1 }))
      .pagination.total,
  ).toBe(1);
  const targetScope = { kind: "category", id: renamed.data.id } as const;
  const settings = await f.admin.getSettings(targetScope);
  await f.admin.updateSettings(
    targetScope,
    { formatting: false },
    { if_match: settings.etag },
  );
  const source = await f.admin.getConversation(f.channelId);
  await refuses(
    f,
    () =>
      f.admin.updateChannel(
        f.channelId,
        { category_id: absentId, topic: "Must roll back" },
        { if_match: source.etag },
      ),
    404,
    "comms_not_found",
  );
  await refuses(
    f,
    () =>
      f.admin.updateChannel(
        f.channelId,
        { topic: "Missing condition" },
        {} as ConditionalOptions,
      ),
    428,
    "comms_precondition_required",
  );
  const contenders = [
    {
      category_id: renamed.data.id,
      name: "First",
      topic: "First complete patch",
    },
    {
      category_id: renamed.data.id,
      name: "Second",
      topic: "Second complete patch",
    },
  ];
  const outcomes = await Promise.allSettled(
    contenders.map((patch) =>
      f.admin.updateChannel(f.channelId, patch, { if_match: source.etag }),
    ),
  );
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const loser = outcomes.find((r) => r.status === "rejected");
  expect(loser).toMatchObject({
    status: "rejected",
    reason: { kind: "http", failure: { status: 412 } },
  });
  const winnerIndex = outcomes.findIndex((r) => r.status === "fulfilled");
  const moved = await f.admin.getConversation(f.channelId);
  expect(moved.data).toMatchObject(contenders[winnerIndex]);
  const inherited = await f.admin.getSettings(f.channelScope);
  expect(inherited.data.effective.formatting).toBe(false);
  expect(inherited.data.sources.formatting).toEqual(targetScope);
  // Explicit stale retry also proves no event/history/version side effect.
  await refuses(
    f,
    () =>
      f.admin.updateChannel(
        f.channelId,
        { topic: "Stale" },
        { if_match: source.etag },
      ),
    412,
    "comms_precondition_failed",
  );
});

test("direct find/create converges and rechecks blocks and current policy even for an existing pair", async ({
  make,
}) => {
  const f = make();
  const [left, right] = await Promise.all([
    f.actor.findOrCreateDirect({ recipient_id: f.peerId }),
    f.peer.findOrCreateDirect({ recipient_id: f.actorId }),
  ]);
  expect(left.data.id).toBe(right.data.id);
  expect(new Set(left.data.participant_ids)).toEqual(
    new Set([f.actorId, f.peerId]),
  );
  expect(
    (await f.actor.listConversations()).items.filter(
      (c) => c.kind === "direct",
    ),
  ).toHaveLength(1);
  await f.peer.blockDirect({ blocked_user_id: f.actorId });
  expect(
    (await f.peer.listDirectBlocks()).items.map((b) => b.blocked_user_id),
  ).toEqual([f.actorId]);
  expect(
    (await f.peer.listConversations()).items.map((c) => c.id),
  ).not.toContain(left.data.id);
  await refuses(
    f,
    () => f.actor.findOrCreateDirect({ recipient_id: f.peerId }),
    403,
  );
  expect((await f.peer.getConversation(f.channelId)).data.id).toBe(f.channelId);
  await f.peer.unblockDirect(f.actorId);
  expect((await f.peer.listDirectBlocks()).items).toEqual([]);
  expect(
    (await f.actor.findOrCreateDirect({ recipient_id: f.peerId })).data.id,
  ).toBe(left.data.id);
  let policy = await f.admin.getDirectPolicy();
  policy = await f.admin.setDirectPolicy(
    { dm_rule: "none" },
    { if_match: policy.etag },
  );
  await refuses(
    f,
    () => f.actor.findOrCreateDirect({ recipient_id: f.peerId }),
    403,
  );
  await f.admin.setDirectPolicy(
    { dm_rule: "shared-channel" },
    { if_match: policy.etag },
  );
  expect(
    (await f.actor.findOrCreateDirect({ recipient_id: f.peerId })).data.id,
  ).toBe(left.data.id);
});

test("direct creation refuses self and guest participants; shared-channel is narrower than shared conversation", async ({
  make,
}) => {
  const f = make();
  await refuses(
    f,
    () => f.actor.findOrCreateDirect({ recipient_id: f.actorId }),
    422,
  );
  await refuses(
    f,
    () => f.guest.findOrCreateDirect({ recipient_id: f.actorId }),
    403,
  );
  await refuses(
    f,
    () => f.actor.findOrCreateDirect({ recipient_id: f.guestId }),
    403,
  );
  // The only channel belongs to a department the peer has no role in. Their
  // existing direct still supplies D36 visibility, but is not a shared channel.
  const directId = "73000000-0000-4000-b000-000000000001";
  const scoped = make((seed) => {
    const department = Object.values(seed.initial.departments)[0];
    seed.initial.people[seed.context.user_id].department_levels = {
      [department.id]: "write",
    };
    seed.initial.conversations[seed.channel.id] = {
      ...seed.channel,
      category_id: null,
      scope: "department",
      department_id: department.id,
    };
    seed.initial.conversations[directId] = {
      id: directId,
      org_id: seed.context.org_id,
      created_at: seed.channel.created_at,
      updated_at: seed.channel.created_at,
      archived_at: null,
      creator_id: seed.context.user_id,
      kind: "direct",
    };
    seed.initial.members[directId] = Object.fromEntries(
      [seed.context.user_id, seed.peer.user_id].map((user_id) => [
        user_id,
        {
          user_id,
          member_role: "member" as const,
          joined_at: seed.channel.created_at,
        },
      ]),
    );
    seed.initial.high_water_seq[directId] = 0;
  });
  const existing = await scoped.actor.findOrCreateDirect({
    recipient_id: scoped.peerId,
  });
  expect(existing.data.id).toBe(directId);
  const policy = await scoped.admin.getDirectPolicy();
  await scoped.admin.setDirectPolicy(
    { dm_rule: "shared-channel" },
    { if_match: policy.etag },
  );
  await refuses(
    scoped,
    () => scoped.actor.findOrCreateDirect({ recipient_id: scoped.peerId }),
    403,
  );
  expect((await scoped.actor.getConversation(existing.data.id)).data.id).toBe(
    existing.data.id,
  );
});

test("group admission validates the participant set and removal cannot cross its lower bound", async ({
  make,
}) => {
  const f = make((seed) => {
    // Only this boundary case needs 51 people; all other journeys use four.
    for (let n = 1; n <= 48; n += 1) {
      const id = `73000000-0000-4000-a000-${n.toString(16).padStart(12, "0")}`;
      seed.initial.people[id] = { ...structuredClone(seed.peer), user_id: id };
      seed.initial.users[id] = structuredClone(
        seed.initial.users[seed.peer.user_id],
      );
    }
  });
  const active = Object.values(f.store.exportSnapshot().state.people)
    .filter((p) => p.role !== "guest")
    .map((p) => p.user_id);
  await refuses(
    f,
    () =>
      f.actor.createGroup({ participant_ids: [f.actorId, f.peerId, f.peerId] }),
    422,
  );
  await refuses(
    f,
    () => f.actor.createGroup({ participant_ids: active.slice(0, 51) }),
    422,
  );
  await refuses(
    f,
    () =>
      f.actor.createGroup({
        participant_ids: [f.actorId, f.peerId, f.guestId],
      }),
    403,
  );
  const maximum = await f.actor.createGroup({
    name: "Maximum",
    participant_ids: active.slice(0, 50),
  });
  expect(maximum.data.participant_ids).toHaveLength(50);
  expect(
    (await f.actor.listMembers(maximum.data.id, { limit: 100 })).pagination
      .total,
  ).toBe(50);
  let policy = await f.admin.getDirectPolicy();
  policy = await f.admin.setDirectPolicy(
    { dm_rule: "none" },
    { if_match: policy.etag },
  );
  await refuses(
    f,
    () =>
      f.actor.createGroup({
        participant_ids: [f.actorId, f.peerId, f.adminId],
      }),
    403,
  );
  await f.admin.setDirectPolicy(
    { dm_rule: "everyone" },
    { if_match: policy.etag },
  );
  await f.peer.blockDirect({ blocked_user_id: f.actorId });
  await refuses(
    f,
    () =>
      f.actor.createGroup({
        participant_ids: [f.actorId, f.peerId, f.adminId],
      }),
    403,
  );
  await f.peer.unblockDirect(f.actorId);
  const minimum = await f.actor.createGroup({
    name: "Minimum",
    participant_ids: [f.actorId, f.peerId, f.adminId],
  });
  expect(new Set(minimum.data.participant_ids)).toEqual(
    new Set([f.actorId, f.peerId, f.adminId]),
  );
  await refuses(
    f,
    () =>
      f.actor.removeMember(minimum.data.id, f.peerId, {
        if_match: minimum.etag,
      }),
    409,
  );
});

test("explicit manager rows do not grant workspace powers and removing one leaves the reader", async ({
  make,
}) => {
  const f = make();
  const room = await secondOrganizationChannel(f);
  await refuses(
    f,
    () =>
      f.actor.setMemberRole(
        room.data.id,
        f.actorId,
        { role: "manager" },
        { if_match: room.etag },
      ),
    403,
    "comms_capability_denied",
  );
  await f.admin.setMemberRole(
    room.data.id,
    f.actorId,
    { role: "manager" },
    { if_match: room.etag },
  );
  expect(
    (await f.actor.listMembers(room.data.id)).items.find(
      (m) => m.user_id === f.actorId,
    )?.member_role,
  ).toBe("manager");
  expect(
    (await f.actor.getCapabilities(room.data.id)).capabilities.manageWorkspace
      .allowed,
  ).toBe(false);
  const settings = await f.admin.getSettings(workspace);
  await refuses(
    f,
    () =>
      f.actor.updateSettings(
        workspace,
        { formatting: false },
        { if_match: settings.etag },
      ),
    403,
  );
  let current = await f.actor.getConversation(room.data.id);
  await f.actor.setMemberRole(
    room.data.id,
    f.peerId,
    { role: "manager" },
    { if_match: current.etag },
  );
  expect((await f.peer.getCapabilities(room.data.id)).manager_source).toBe(
    "membership_manager",
  );
  current = await f.actor.getConversation(room.data.id);
  await f.actor.removeMember(room.data.id, f.peerId, {
    if_match: current.etag,
  });
  // D44: a removed manager stays a reader through the channel's scope.
  expect((await f.peer.getConversation(room.data.id)).data).toMatchObject({
    level: "post",
    member_role: "member",
  });
  expect(
    (await f.actor.listMembers(room.data.id)).items.find(
      (m) => m.user_id === f.peerId,
    ),
  ).toMatchObject({ member_role: "member", level: "post" });
  expect(f.store.exportSnapshot().state.people[f.peerId].role).toBe("member");
});

test("duplicate requires source management plus destination creation and never copies content or jobs", async ({
  make,
}) => {
  const f = make((seed) => {
    // D44: a createChannel grant creates department channels only, in a
    // department where the actor holds a role.
    const department = Object.values(seed.initial.departments)[0];
    seed.initial.people[seed.context.user_id].department_levels = {
      [department.id]: "write",
    };
    seed.initial.conversations[seed.channel.id] = {
      ...seed.channel,
      scope: "department",
      department_id: department.id,
    };
    seed.initial.configuration[`channel:${seed.channel.id}`] = {
      settings: { formatting: false },
      capabilities: {
        scope: { kind: "channel", id: seed.channel.id },
        everyone: {},
        group_grants: [],
      },
    };
    const id = "73000000-0000-4000-b000-000000000001";
    seed.initial.schedules[id] = {
      id,
      org_id: seed.context.org_id,
      author_id: seed.admin.user_id,
      created_at: "2026-10-18T08:00:00Z",
      updated_at: "2026-10-18T08:00:00Z",
      request: {
        conversation_id: seed.channel.id,
        parent_id: null,
        client_key: "73000000-0000-4000-b000-000000000002",
        body: "Future original only",
        attachment_ids: [],
        record_ids: [],
        mention_user_ids: [],
        mentions_channel: false,
        mentions_here: false,
        reply_to_id: null,
        also_send_to_channel: false,
        send_at: "2026-10-20T08:00:00Z",
      },
      status: "pending",
      message_id: null,
      failure_code: null,
    };
    seed.initial.retention[`channel:${seed.channel.id}`] = {
      scope: { kind: "channel", id: seed.channel.id },
      message_days: 7,
      file_days: 7,
    };
  });
  const departmentId = Object.keys(
    f.store.exportSnapshot().state.departments,
  )[0];
  const target = await f.admin.createCategory({
    name: "Copies",
    position: 3,
    department_id: departmentId,
  });
  const targetScope = { kind: "category", id: target.data.id } as const;
  const request = { name: "Copy", category_id: target.data.id };
  const deniedCreate = {
    name: "Cannot create yet",
    topic: "",
    position: 0,
    scope: "department" as const,
    department_id: departmentId,
    category_id: target.data.id,
  };
  await refuses(
    f,
    () => f.actor.createChannel(deniedCreate),
    403,
    "comms_capability_denied",
  );
  await grant(f, targetScope, "createChannel");
  const created = await f.actor.createChannel(deniedCreate);
  expect(created.data.category_id).toBe(target.data.id);
  let source = await f.actor.getConversation(f.channelId);
  await refuses(
    f,
    () =>
      f.actor.duplicateChannel(f.channelId, request, { if_match: source.etag }),
    403,
    "comms_capability_denied",
  );
  await grant(f, f.channelScope, "manageChannel");
  source = await f.actor.getConversation(f.channelId);
  await refuses(
    f,
    () =>
      f.actor.duplicateChannel(
        f.channelId,
        { ...request, category_id: null },
        { if_match: source.etag },
      ),
    403,
    "comms_capability_denied",
  );
  expect(
    (await f.actor.getChannelCreationCheck(targetScope)).decision.allowed,
  ).toBe(true);
  expect(
    (await f.actor.getChannelCreationCheck(workspace)).decision.allowed,
  ).toBe(false);
  const settings = await f.actor.getSettings(f.channelScope);
  await f.actor.updateSettings(
    f.channelScope,
    { keywords: ["original"] },
    { if_match: settings.etag },
  );
  await refuses(
    f,
    () =>
      f.actor.duplicateChannel(f.channelId, request, { if_match: source.etag }),
    412,
    "comms_precondition_failed",
  );
  source = await f.actor.getConversation(f.channelId);
  const before = structuredClone(f.store.exportSnapshot().state);
  const copy = await f.actor.duplicateChannel(f.channelId, request, {
    if_match: source.etag,
  });
  expect(copy.data).toMatchObject({
    kind: "channel",
    scope: "department",
    department_id: departmentId,
    name: "Copy",
    category_id: target.data.id,
  });
  expect(copy.data.id).not.toBe(f.channelId);
  expect(copy.data.created_at).toBe(new Date(now).toISOString());
  const copyScope = { kind: "channel", id: copy.data.id } as const;
  expect((await f.actor.getSettings(copyScope)).data.overrides).toEqual({
    formatting: false,
    keywords: ["original"],
  });
  expect(
    (await f.actor.getCapabilityConfiguration(copyScope)).data.group_grants,
  ).toEqual([{ group_id: f.groupId, capability: "manageChannel" }]);
  const after = f.store.exportSnapshot().state;
  expect(after.messages).toEqual(before.messages);
  expect(after.threads).toEqual(before.threads);
  expect(after.schedules).toEqual(before.schedules);
  expect(after.exports).toEqual(before.exports);
  expect(after.retention).toEqual(before.retention);
  for (const [id, history] of Object.entries(before.history))
    expect(after.history[id]).toEqual(history);
  // A fresh creation history row is permitted; copying the source's historical
  // before/after state is not. Do not require an incidental choice to log create.
  const copyHistory = Object.values(after.history).filter(
    (h) => h.scope.kind === "channel" && h.scope.id === copy.data.id,
  );
  expect(copyHistory.length).toBeLessThanOrEqual(1);
  for (const history of copyHistory)
    expect(history.before.settings).toEqual({});
  expect(after.conversations[copy.data.id].creator_id).toBe(f.actorId);
  expect(after.high_water_seq[copy.data.id] ?? 0).toBe(0);
  expect((await f.actor.getConversation(f.channelId)).data).toEqual(
    source.data,
  );
});
