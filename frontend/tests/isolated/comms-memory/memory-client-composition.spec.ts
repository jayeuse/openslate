/** PROMOTED / UNRUN — three full-client journeys, not method-presence enumeration. */
import {
  test,
  expect,
  id,
  foreignOrg,
  channelRequest,
  edit,
  send,
  refuses,
  observe,
} from "./memory-client-fixture";

test("J1 real family writes feed one complete readonly bootstrap with owned counts and preferences", async ({
  make,
}) => {
  const f = make({ role: "member", extraConversations: 50 });
  const foreign = make({ orgId: foreignOrg }); // Same user UUID, different org/owner/store.
  const foreignRoom = await foreign.client.createChannel(
    channelRequest(null, "Other organization only"),
  );
  const created = await f.client.createChannel(
    channelRequest(null, undefined, f.departmentId),
  );
  const room = await f.client.getConversation(f.channelId);
  await f.client.updateChannel(
    f.channelId,
    { topic: "One canonical topic" },
    { if_match: room.etag },
  );
  const member = await f.client.getMemberPreferences(f.channelId);
  await f.client.updateMemberPreferences(
    f.channelId,
    { starred: true, manual_unread: true },
    { if_match: member.etag },
  );
  const category = await f.client.getCategoryPreferences(f.categoryId);
  await f.client.setCategoryPreferences(
    f.categoryId,
    { collapsed: true, mute: { kind: "off" } },
    { if_match: category.etag },
  );
  const preferences = await f.client.getPersonalPreferences();
  await f.client.setPersonalPreferences(
    { ...preferences.data, density: "compact" },
    { if_match: preferences.etag },
  );
  expect(
    await f.client.sendMessage(
      f.channelId,
      send("Own message does not inflate unread", 1),
    ),
  ).toMatchObject({ status: 201, message: { seq: 3 } });
  expect(await f.client.markRead(f.channelId, { last_read_seq: 1 })).toEqual({
    conversation_id: f.channelId,
    last_read_seq: 1,
  });

  const before = f.runtime.exportSnapshot(),
    events = structuredClone(f.events),
    changes = f.changes();
  const bootstrap = await f.client.bootstrap();
  expect(bootstrap).toMatchObject({
    org_id: f.context.org_id,
    user_id: f.context.user_id,
  });
  // 1 original + 1 sibling + 50 empty seed rooms + 1 real creation; not page 1.
  expect(bootstrap.conversations).toHaveLength(53);
  expect(bootstrap.conversations.map((s) => s.conversation.id)).toEqual(
    expect.arrayContaining([f.channelId, f.otherId, id(1049), created.data.id]),
  );
  expect(bootstrap.conversations.map((s) => s.conversation.id)).not.toEqual(
    expect.arrayContaining([f.hiddenId]),
  );
  expect(bootstrap.conversations.map((s) => s.conversation.id)).not.toEqual(
    expect.arrayContaining([foreignRoom.data.id]),
  );
  expect(
    bootstrap.conversations.every(
      (s) => s.conversation.org_id === f.context.org_id,
    ),
  ).toBe(true);
  expect(bootstrap.categories).toEqual([
    {
      category: expect.objectContaining({
        id: f.categoryId,
        org_id: f.context.org_id,
      }),
      preferences: { collapsed: true, mute: { kind: "off" } },
    },
  ]);
  expect(
    bootstrap.conversations.find((s) => s.conversation.id === f.channelId),
  ).toMatchObject({
    conversation: { topic: "One canonical topic", level: "manage" },
    preferences: { starred: true, manual_unread: false },
    last_read_seq: 1,
    high_water_seq: 3,
    unread_count: 1,
    mention_count: 1,
    first_unread_seq: 2,
  });
  expect(
    bootstrap.conversations.find((s) => s.conversation.id === created.data.id),
  ).toMatchObject({
    last_read_seq: 0,
    high_water_seq: 0,
    unread_count: 0,
    mention_count: 0,
    first_unread_seq: null,
  });
  expect((await f.client.getPersonalPreferences()).data.density).toBe(
    "compact",
  );
  await expect(f.client.bootstrap()).resolves.toEqual(bootstrap);
  await refuses(
    f,
    () => f.client.getConversation(f.hiddenId),
    404,
    "comms_not_found",
  );
  await refuses(
    f,
    () => f.client.getConversation(foreignRoom.data.id),
    404,
    "comms_not_found",
  );
  expect(f.runtime.exportSnapshot()).toEqual(before);
  expect(f.events).toEqual(events);
  expect(f.changes()).toBe(changes);
  const sibling = await foreign.client.bootstrap();
  expect(sibling).toMatchObject({
    org_id: foreignOrg,
    user_id: f.context.user_id,
  });
  expect(sibling.conversations.map((s) => s.conversation.id)).toContain(
    foreignRoom.data.id,
  );
  expect(sibling.conversations.map((s) => s.conversation.id)).not.toContain(
    created.data.id,
  );
});

test("J2 targeted availability refuses real capability use without lying about admin or manager policy", async ({
  make,
}) => {
  // Two real sources, one journey; not a capability/role matrix or fake decisions.
  for (const role of ["admin", "member"] as const) {
    const f = make({ role });
    const source =
      role === "admin"
        ? { kind: "admin" }
        : { kind: "manager", reason: "membership_manager" };
    const original = await f.client.getCapabilities(f.channelId);
    expect(original.capabilities.react).toEqual({ allowed: true, source });
    const config = await f.client.getCapabilityConfiguration(f.channelScope);
    f.runtime.controls.denyCapability({
      scope: f.channelScope,
      capability: "react",
    });
    await refuses(
      f,
      () => f.client.getCapabilities(f.channelId),
      403,
      "comms_capability_denied",
    );
    await refuses(
      f,
      () => f.client.checkPerson(f.channelId, f.peerId),
      403,
      "comms_capability_denied",
    );
    await refuses(
      f,
      () => f.client.addReaction(f.channelId, f.rootId, { emoji: "👍" }),
      403,
      "comms_capability_denied",
    );
    expect(
      await f.client.sendMessage(
        f.channelId,
        send("Plaintext needs no reaction capability", 2),
      ),
    ).toMatchObject({ status: 201, message: { seq: 3 } });
    expect(
      (await f.client.getHistory(f.channelId)).items.map((m) => m.seq),
    ).toEqual([1, 3]);
    expect(
      (await f.client.getCapabilities(f.otherId)).capabilities.react,
    ).toEqual({ allowed: true, source });
    const other = await f.client.sendMessage(
      f.otherId,
      send("Unrelated target", 3),
    );
    await f.client.addReaction(f.otherId, other.message.id, { emoji: "👍" });
    f.runtime.controls.denyCapability(null);
    expect(await f.client.getCapabilities(f.channelId)).toEqual(original);
    await f.client.addReaction(f.channelId, f.rootId, { emoji: "👍" });
    expect(
      (await f.client.getMessage(f.channelId, f.rootId)).data,
    ).toMatchObject({
      reactions: [{ emoji: "👍", user_ids: [f.context.user_id] }],
    });
    expect(await f.client.getCapabilityConfiguration(f.channelScope)).toEqual(
      config,
    );
  }
  const f = make();
  const original = await f.client.getChannelCreationCheck(f.categoryScope);
  expect(original.decision).toEqual({
    allowed: true,
    source: { kind: "admin" },
  });
  f.runtime.controls.denyCapability({
    scope: f.categoryScope,
    capability: "createChannel",
  });
  await refuses(
    f,
    () => f.client.getChannelCreationCheck(f.categoryScope),
    403,
    "comms_capability_denied",
  );
  await refuses(
    f,
    () => f.client.createChannel(channelRequest(f.categoryId)),
    403,
    "comms_capability_denied",
  );
  expect(
    (await f.client.getChannelCreationCheck({ kind: "workspace" })).decision,
  ).toEqual({ allowed: true, source: { kind: "admin" } });
  expect(
    (await f.client.createChannel(channelRequest(null))).data.category_id,
  ).toBeNull();
  f.runtime.controls.denyCapability(null);
  expect(await f.client.getChannelCreationCheck(f.categoryScope)).toEqual(
    original,
  );
});

test("J4 dropped event transport leaves edits deletes and authoritative reads live without replay", async ({
  make,
}) => {
  const f = make();
  const sent = await f.client.sendMessage(
    f.channelId,
    send("Before the transport drop", 4),
  );
  const delivered = structuredClone(f.events);
  f.runtime.controls.setConnectionDropped(true);
  expect(f.connections.at(-1)).toEqual({ state: "offline" });
  const joinedOffline = observe(f.client);
  try {
    expect(joinedOffline.connections).toEqual([{ state: "offline" }]);
    await f.client.editMessage(
      f.channelId,
      sent.message.id,
      edit("Edited while disconnected"),
    );
    expect(
      (await f.client.getMessage(f.channelId, sent.message.id)).data,
    ).toMatchObject({ body: "Edited while disconnected", seq: 3 });
    const deleted = await f.client.deleteMessage(f.channelId, sent.message.id);
    expect(await f.client.getMessage(f.channelId, sent.message.id)).toEqual(
      deleted,
    );
    expect(deleted.data.state).toBe("deleted");
    expect(f.events).toEqual(delivered);
    expect(joinedOffline.events).toEqual([]);
    f.runtime.controls.setConnectionDropped(false);
    expect(f.connections.at(-1)).toEqual({ state: "live" });
    expect(joinedOffline.connections).toEqual([
      { state: "offline" },
      { state: "live" },
    ]);
    expect(f.events).toEqual(delivered); // No synthesized edit/delete backlog.
    expect(joinedOffline.events).toEqual([]);
    expect(await f.client.getMessage(f.channelId, sent.message.id)).toEqual(
      deleted,
    );
    const next = await f.client.sendMessage(
      f.channelId,
      send("Only new events resume", 5),
    );
    expect(next).toMatchObject({ status: 201, message: { seq: 4 } });
    expect(joinedOffline.events).toEqual([
      {
        private: true,
        topic: `org:${f.context.org_id}:conversation:${f.channelId}`,
        event: "message",
        payload: { conversation_id: f.channelId, seq: 4, kind: "created" },
      },
    ]);
    expect(f.events.slice(delivered.length)).toEqual(joinedOffline.events);
    expect(f.errors).toEqual([]);
    expect(joinedOffline.errors).toEqual([]);
  } finally {
    joinedOffline.stop();
  }
});
