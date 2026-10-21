/** Accepted command journeys, not another resolver/schema matrix. */
import type { SettingsPatch } from "@/components/systems/comms/contract/types";
import {
  test,
  expect,
  refuses,
  grant,
  privateChannel,
  absentId,
  workspace,
} from "./memory-family-fixture";

test("settings commands retain explicit false zero and empty overrides until selected reset", async ({
  make,
}) => {
  const f = make();
  const shared = await f.admin.getSettings(workspace);
  await f.admin.updateSettings(
    workspace,
    {
      formatting: true,
      edit_window_minutes: 12,
      keywords: ["dispatch"],
    },
    { if_match: shared.etag },
  );
  const channel = await f.admin.getSettings(f.channelScope);
  let local = await f.admin.updateSettings(
    f.channelScope,
    {
      formatting: false,
      edit_window_minutes: 0,
      keywords: [],
      link_previews: true,
    },
    { if_match: channel.etag },
  );
  expect(local.data.overrides).toEqual({
    formatting: false,
    edit_window_minutes: 0,
    keywords: [],
    link_previews: true,
  });
  expect(
    (await f.actor.getSettings(f.channelScope)).data.effective,
  ).toMatchObject({
    formatting: false,
    edit_window_minutes: 0,
    keywords: [],
    link_previews: true,
  });
  local = await f.admin.resetSettings(
    f.channelScope,
    { keys: ["edit_window_minutes", "keywords"] },
    { if_match: local.etag },
  );
  expect(local.data.overrides).toEqual({
    formatting: false,
    link_previews: true,
  });
  expect(local.data.effective).toMatchObject({
    formatting: false,
    edit_window_minutes: 12,
    keywords: ["dispatch"],
    link_previews: true,
  });
  expect(local.data.sources.edit_window_minutes).toEqual(workspace);
  // Reset and updates write history in the SAME command, not a later tool writer.
  const histories = Object.values(
    f.store.exportSnapshot().state.history,
  ).filter((h) => h.scope.kind === "channel" && h.scope.id === f.channelId);
  expect(histories).toHaveLength(2);
  expect(
    histories.find((h) => h.before.settings.edit_window_minutes === 0),
  ).toMatchObject({
    actor_id: f.adminId,
    scope: f.channelScope,
    before: {
      settings: {
        formatting: false,
        edit_window_minutes: 0,
        keywords: [],
        link_previews: true,
      },
    },
    after: { settings: { formatting: false, link_previews: true } },
  });
});

test("strict method admission rejects a mixed invalid write without settings history or events", async ({
  make,
}) => {
  const f = make();
  const current = await f.admin.getSettings(f.channelScope);
  // One representative graph-invalid input and one forbidden key prove runtime
  // admission. Exhaustive quiet-hour/UUID/key matrices remain in S01/core.
  await refuses(
    f,
    () =>
      f.admin.updateSettings(
        f.channelScope,
        { formatting: false, default_member_ids: [absentId] },
        { if_match: current.etag },
      ),
    422,
    "comms_invalid_input",
  );
  const retentionBackdoor: SettingsPatch & { retention_days: number } = {
    formatting: false,
    retention_days: 7,
  };
  await refuses(
    f,
    () =>
      f.admin.updateSettings(f.channelScope, retentionBackdoor, {
        if_match: current.etag,
      }),
    422,
    "comms_invalid_input",
  );
  const accepted = await f.admin.updateSettings(
    f.channelScope,
    {
      formatting: false,
      default_member_ids: [f.peerId],
      quiet_hours_start: "22:00",
      quiet_hours_end: "06:00",
    },
    { if_match: current.etag },
  );
  expect(accepted.data.overrides).toEqual({
    formatting: false,
    default_member_ids: [f.peerId],
    quiet_hours_start: "22:00",
    quiet_hours_end: "06:00",
  });
  await refuses(
    f,
    () =>
      f.admin.resetSettings(
        f.channelScope,
        { keys: ["quiet_hours_start"] },
        { if_match: accepted.etag },
      ),
    422,
    "comms_invalid_input",
  );
  const reset = await f.admin.resetSettings(
    f.channelScope,
    { keys: ["quiet_hours_start", "quiet_hours_end"] },
    { if_match: accepted.etag },
  );
  expect(reset.data.overrides).toEqual({
    formatting: false,
    default_member_ids: [f.peerId],
  });
});

test("settings locks are admin-owned and a lower mixed patch cannot partially escape the lock", async ({
  make,
}) => {
  const f = make();
  await grant(f, f.channelScope, "manageChannel");
  let shared = await f.admin.getSettings(workspace);
  shared = await f.admin.updateSettings(
    workspace,
    { formatting: false },
    { if_match: shared.etag },
  );
  await refuses(
    f,
    () =>
      f.actor.setSettingsLocks(
        { keys: ["formatting"] },
        { if_match: shared.etag },
      ),
    403,
  );
  shared = await f.admin.setSettingsLocks(
    { keys: ["formatting"] },
    { if_match: shared.etag },
  );
  expect(shared.data.locked_keys).toEqual(["formatting"]);
  let local = await f.actor.getSettings(f.channelScope);
  await refuses(
    f,
    () =>
      f.actor.updateSettings(
        f.channelScope,
        { formatting: true, keywords: ["must not commit"] },
        { if_match: local.etag },
      ),
    403,
    "comms_capability_denied",
  );
  shared = await f.admin.setSettingsLocks(
    { keys: [] },
    { if_match: shared.etag },
  );
  expect(shared.data.locked_keys).toEqual([]);
  local = await f.actor.getSettings(f.channelScope);
  const accepted = await f.actor.updateSettings(
    f.channelScope,
    { formatting: true, keywords: ["allowed"] },
    { if_match: local.etag },
  );
  expect(accepted.data.effective).toMatchObject({
    formatting: true,
    keywords: ["allowed"],
  });
  expect(accepted.data.sources.formatting).toEqual(f.channelScope);
});

test("workspace settings and direct policy share one ETag and one atomic history transaction", async ({
  make,
}) => {
  const f = make();
  const settings = await f.admin.getSettings(workspace);
  const policy = await f.admin.getDirectPolicy();
  expect(policy.etag).toBe(settings.etag);
  await refuses(
    f,
    () =>
      f.actor.setDirectPolicy({ dm_rule: "none" }, { if_match: policy.etag }),
    403,
  );
  const changed = await f.admin.updateSettings(
    workspace,
    { formatting: false },
    { if_match: settings.etag },
  );
  await refuses(
    f,
    () =>
      f.admin.setDirectPolicy({ dm_rule: "none" }, { if_match: policy.etag }),
    412,
    "comms_precondition_failed",
  );
  // Method-level fault admission: not a repeat of store recipe mechanics. This
  // proves the settings writer and shared history cannot use separate commits.
  f.store.failNextCommit();
  await refuses(
    f,
    () =>
      f.admin.setDirectPolicy({ dm_rule: "none" }, { if_match: changed.etag }),
    503,
    "comms_unavailable",
  );
  const beforeCount = Object.keys(
    f.store.exportSnapshot().state.history,
  ).length;
  const observations: { rule: string; historyCount: number }[] = [];
  const stop = f.store.subscribe(() => {
    const state = f.store.exportSnapshot().state;
    observations.push({
      rule: state.dm_rule,
      historyCount: Object.keys(state.history).length,
    });
  });
  const accepted = await f.admin.setDirectPolicy(
    { dm_rule: "none" },
    { if_match: changed.etag },
  );
  stop();
  const latest = await f.admin.getSettings(workspace);
  expect(latest.etag).toBe(accepted.etag);
  expect(latest.data).toMatchObject({
    dm_rule: "none",
    effective: { formatting: false },
  });
  expect(observations).toEqual([
    { rule: "none", historyCount: beforeCount + 1 },
  ]);
  const added = Object.values(f.store.exportSnapshot().state.history).find(
    (h) => h.after.dm_rule === "none",
  );
  expect(added).toMatchObject({
    actor_id: f.adminId,
    org_id: f.context.org_id,
    scope: workspace,
    before: { dm_rule: "everyone", settings: { formatting: false } },
    after: { dm_rule: "none", settings: { formatting: false } },
  });
});

test("configuration writes use their named scope and checkPerson requires current manageChannel", async ({
  make,
}) => {
  const f = make();
  expect((await f.actor.checkPerson(f.channelId, f.actorId)).user_id).toBe(
    f.actorId,
  );
  await refuses(
    f,
    () => f.actor.checkPerson(f.channelId, f.peerId),
    403,
    "comms_capability_denied",
  );
  const initial = await f.admin.getSettings(f.channelScope);
  await refuses(
    f,
    () =>
      f.actor.updateSettings(
        f.channelScope,
        { formatting: false },
        { if_match: initial.etag },
      ),
    403,
    "comms_capability_denied",
  );
  await grant(f, f.channelScope, "manageChannel");
  const inspected = await f.actor.checkPerson(f.channelId, f.peerId);
  expect(inspected).toMatchObject({
    user_id: f.peerId,
    org_id: f.context.org_id,
    conversation_id: f.channelId,
    membership_role: "member",
  });
  expect(inspected.capabilities.manageChannel.allowed).toBe(false);
  await refuses(
    f,
    () => f.actor.checkPerson(f.channelId, absentId),
    404,
    "comms_not_found",
  );
  const category = await f.admin.getCapabilityConfiguration(f.categoryScope);
  await refuses(
    f,
    () =>
      f.actor.setCapabilityConfiguration(
        {
          ...category.data,
          group_grants: [{ group_id: f.groupId, capability: "createChannel" }],
        },
        { if_match: category.etag },
      ),
    403,
    "comms_capability_denied",
  );
  const local = await f.actor.getSettings(f.channelScope);
  const accepted = await f.actor.updateSettings(
    f.channelScope,
    { formatting: false },
    { if_match: local.etag },
  );
  expect(accepted.data.effective.formatting).toBe(false);
  const config = await f.admin.getCapabilityConfiguration(f.channelScope);
  await f.admin.setCapabilityConfiguration(
    { ...config.data, group_grants: [] },
    { if_match: config.etag },
  );
  await refuses(
    f,
    () => f.actor.checkPerson(f.channelId, f.peerId),
    403,
    "comms_capability_denied",
  );
});

test("capability commands replace local grants only and enforce workspace locks without promoting managers", async ({
  make,
}) => {
  const f = make();
  const shared = await f.admin.getCapabilityConfiguration(workspace);
  await f.admin.setCapabilityConfiguration(
    {
      ...shared.data,
      group_grants: [{ group_id: f.groupId, capability: "pin" }],
    },
    { if_match: shared.etag },
  );
  let local = await f.admin.getCapabilityConfiguration(f.channelScope);
  local = await f.admin.setCapabilityConfiguration(
    {
      ...local.data,
      group_grants: [{ group_id: f.groupId, capability: "manageChannel" }],
    },
    { if_match: local.etag },
  );
  expect(
    (await f.actor.getCapabilities(f.channelId)).manager_source,
  ).toBeNull();
  const locks = await f.admin.getCapabilityLocks();
  await refuses(
    f,
    () =>
      f.actor.setCapabilityLocks(
        { capabilities: ["manageChannel"] },
        { if_match: locks.etag },
      ),
    403,
  );
  const locked = await f.admin.setCapabilityLocks(
    { capabilities: ["manageChannel"] },
    { if_match: locks.etag },
  );
  const check = await f.actor.getCapabilities(f.channelId);
  expect(check.capabilities.manageChannel).toEqual({
    allowed: false,
    source: { kind: "workspace_lock", enabled: false },
  });
  const room = await f.actor.getConversation(f.channelId);
  await refuses(
    f,
    () => f.actor.archiveConversation(f.channelId, { if_match: room.etag }),
    403,
    "comms_capability_denied",
  );
  local = await f.admin.getCapabilityConfiguration(f.channelScope);
  await refuses(
    f,
    () =>
      f.admin.setCapabilityConfiguration(
        { ...local.data, group_grants: [] },
        { if_match: local.etag },
      ),
    403,
    "comms_capability_denied",
  );
  await f.admin.setCapabilityLocks(
    { capabilities: [] },
    { if_match: locked.etag },
  );
  local = await f.admin.getCapabilityConfiguration(f.channelScope);
  await f.admin.setCapabilityConfiguration(
    { ...local.data, group_grants: [] },
    { if_match: local.etag },
  );
  expect(
    (await f.actor.getCapabilities(f.channelId)).capabilities.pin,
  ).toMatchObject({
    allowed: true,
    source: { kind: "group_grant", scope: workspace, group_id: f.groupId },
  });
  expect(
    (await f.actor.getCapabilities(f.channelId)).capabilities.manageChannel
      .allowed,
  ).toBe(false);
  const history = Object.values(f.store.exportSnapshot().state.history);
  expect(history).toHaveLength(5); // Three grant writes, lock, unlock; no refused writes.
  expect(
    history.find((h) => h.after.capability_locks?.includes("manageChannel")),
  ).toMatchObject({
    actor_id: f.adminId,
    scope: workspace,
    before: { capability_locks: [] },
    after: { capability_locks: ["manageChannel"] },
  });
});

test("C6 personal conversation and category preferences are last-write-wins while isolated and revoked access stays refused", async ({
  make,
}) => {
  const f = make();
  const readBefore = structuredClone(
    f.store.exportSnapshot().state.users[f.actorId].last_read_seq,
  );
  const peerPersonal = await f.peer.getPersonalPreferences();
  const peerMember = await f.peer.getMemberPreferences(f.channelId);
  const peerCategory = await f.peer.getCategoryPreferences(f.categoryId);
  const personal = await f.actor.getPersonalPreferences();
  const saved = await f.actor.setPersonalPreferences({
    ...personal.data,
    density: "compact",
    notifications: { notification_sound: false },
  });
  expect(saved.data.density).toBe("compact");
  const member = await f.actor.getMemberPreferences(f.channelId);
  const changed = await f.actor.updateMemberPreferences(f.channelId, {
    starred: true,
    manual_unread: true,
    mute: { kind: "indefinite" },
  });
  expect(changed.data).toMatchObject({
    starred: true,
    manual_unread: true,
    mute: { kind: "indefinite" },
  });
  const category = await f.actor.getCategoryPreferences(f.categoryId);
  await f.actor.setCategoryPreferences(f.categoryId, {
    collapsed: true,
    mute: { kind: "off" },
  });
  expect(
    (await f.actor.getCategoryPreferences(f.categoryId)).data.collapsed,
  ).toBe(true);
  const lastPersonal = await f.actor.setPersonalPreferences(
    { ...saved.data, density: "comfortable" },
    { if_match: personal.etag },
  );
  expect((await f.actor.getPersonalPreferences()).data.density).toBe(
    "comfortable",
  );
  expect(lastPersonal.etag).not.toBe(saved.etag);
  const lastCategory = await f.actor.setCategoryPreferences(
    f.categoryId,
    { collapsed: false, mute: { kind: "indefinite" } },
    { if_match: category.etag },
  );
  expect((await f.actor.getCategoryPreferences(f.categoryId)).data).toEqual({
    collapsed: false,
    mute: { kind: "indefinite" },
  });
  expect(lastCategory.etag).not.toBe(category.etag);
  expect(await f.peer.getPersonalPreferences()).toEqual(peerPersonal);
  expect(await f.peer.getMemberPreferences(f.channelId)).toEqual(peerMember);
  expect(await f.peer.getCategoryPreferences(f.categoryId)).toEqual(
    peerCategory,
  );
  const lastMember = await f.actor.updateMemberPreferences(
    f.channelId,
    { starred: false },
    { if_match: member.etag },
  );
  expect((await f.actor.getMemberPreferences(f.channelId)).data).toMatchObject({
    starred: false,
    manual_unread: true,
    mute: { kind: "indefinite" },
  });
  expect(lastMember.etag).not.toBe(changed.etag);
  // No markRead/bootstrap arithmetic here: preferences do not advance reads.
  expect(f.store.exportSnapshot().state.users[f.actorId].last_read_seq).toEqual(
    readBefore,
  );
  const room = await privateChannel(f);
  await f.admin.removeMember(room.data.id, f.peerId, { if_match: room.etag });
  await refuses(
    f,
    () => f.peer.getMemberPreferences(room.data.id),
    404,
    "comms_not_found",
  );
  await refuses(
    f,
    () => f.peer.updateMemberPreferences(room.data.id, { starred: true }),
    404,
    "comms_not_found",
  );
});

test("ID27 capability self-removal commits its acknowledgement and history while read remains and inspection is denied", async ({
  make,
}) => {
  const f = make((seed) => {
    seed.initial.conversations[seed.channel.id] = {
      ...seed.channel,
      scope: "groups",
      access: [{ subject: "group", group_id: seed.group.id, level: "read" }],
    };
  });
  const granted = await grant(f, f.channelScope, "manageChannel");
  expect(await f.actor.getCapabilities(f.channelId)).toMatchObject({
    conversation_level: "read",
    manager_source: null,
    capabilities: {
      manageChannel: {
        allowed: true,
        source: {
          kind: "group_grant",
          scope: f.channelScope,
          group_id: f.groupId,
        },
      },
    },
  });
  const original = await f.actor.getConversation(f.channelId);
  const historyCount = Object.keys(
    f.store.exportSnapshot().state.history,
  ).length;
  const removed = await f.actor.setCapabilityConfiguration(
    { ...granted.data, group_grants: [] },
    { if_match: granted.etag },
  );
  expect(removed.data).toEqual({
    scope: f.channelScope,
    everyone: {},
    group_grants: [],
  });
  expect(removed.etag).not.toBe(granted.etag);
  expect(await f.actor.getCapabilityConfiguration(f.channelScope)).toEqual(
    removed,
  );
  const readable = await f.actor.getConversation(f.channelId);
  expect(readable.data).toMatchObject({ id: f.channelId, level: "read" });
  expect(readable.etag).not.toBe(original.etag);
  expect(await f.actor.getCapabilities(f.channelId)).toMatchObject({
    conversation_level: "read",
    manager_source: null,
    capabilities: { manageChannel: { allowed: false } },
  });
  const history = Object.values(f.store.exportSnapshot().state.history);
  expect(history).toHaveLength(historyCount + 1);
  expect(history.find((entry) => entry.actor_id === f.actorId)).toMatchObject({
    scope: f.channelScope,
    before: {
      capabilities: {
        group_grants: [{ group_id: f.groupId, capability: "manageChannel" }],
      },
    },
    after: { capabilities: { group_grants: [] } },
  });
  await refuses(
    f,
    () =>
      f.actor.setCapabilityConfiguration(granted.data, {
        if_match: removed.etag,
      }),
    403,
    "comms_capability_denied",
  );
  await refuses(
    f,
    () => f.actor.checkPerson(f.channelId, f.peerId),
    403,
    "comms_capability_denied",
  );
  expect(await f.actor.getConversation(f.channelId)).toEqual(readable);
  expect(await f.actor.getCapabilityConfiguration(f.channelScope)).toEqual(
    removed,
  );
});
