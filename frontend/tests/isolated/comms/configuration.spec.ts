import { expect, test } from "@playwright/test";
import {
  createCommsConfiguration,
  emptyCommsScope,
  normalizeCommsConfiguration,
  resolveCommsPermission,
  resolveCommsSettings,
} from "../../../src/components/systems/comms/domain/configuration";
import {
  CHANNELS,
  CATEGORIES,
} from "../../../src/components/systems/comms/domain/model";
import { initialPeople } from "../../../src/components/systems/shared/data/sample-people";
const person = initialPeople[0];
const channel = CHANNELS[0];
test("channel values override inherited settings unless workspace locked", () => {
  const c = createCommsConfiguration();
  c.workspace.settings.slowModeSeconds = 10;
  c.categories[channel.categoryId] = {
    ...emptyCommsScope(),
    settings: { slowModeSeconds: 20 },
  };
  c.channels[channel.id] = {
    ...emptyCommsScope(),
    settings: { slowModeSeconds: 30 },
  };
  expect(
    resolveCommsSettings(c, channel, CATEGORIES).values.slowModeSeconds,
  ).toBe(30);
  c.lockedSettings = ["slowModeSeconds"];
  expect(
    resolveCommsSettings(c, channel, CATEGORIES).values.slowModeSeconds,
  ).toBe(10);
});
test("permissions apply scope and subject precedence, visibility prerequisite and workspace locks", () => {
  const c = createCommsConfiguration();
  c.workspace.permissions.everyone = { post: "deny" };
  c.channels[channel.id] = {
    settings: {},
    permissions: {
      [`role:${person.role}`]: { post: "allow" },
      [`person:${person.id}`]: { post: "deny" },
    },
  };
  expect(
    resolveCommsPermission(
      c,
      { person, channel, categories: CATEGORIES },
      "post",
    ).allowed,
  ).toBe(false);
  c.channels[channel.id].permissions[`person:${person.id}`].post = "inherit";
  expect(
    resolveCommsPermission(
      c,
      { person, channel, categories: CATEGORIES },
      "post",
    ).allowed,
  ).toBe(true);
  c.lockedPermissions = ["post"];
  expect(resolveCommsPermission(c, { person, channel }, "post").allowed).toBe(
    false,
  );
  c.lockedPermissions = [];
  c.channels[channel.id].permissions.everyone = { viewChannel: "deny" };
  expect(resolveCommsPermission(c, { person, channel }, "post").allowed).toBe(
    false,
  );
});
test("legacy restricted posting still permits replies; active owner is protected but inactive identities fail closed", () => {
  const c = createCommsConfiguration();
  const restricted = {
    ...channel,
    inherit: false,
    posting: "roles" as const,
    postRoles: [],
  };
  expect(
    resolveCommsPermission(c, { person, channel: restricted }, "post").allowed,
  ).toBe(false);
  expect(
    resolveCommsPermission(c, { person, channel: restricted }, "reply").allowed,
  ).toBe(true);
  const eli = initialPeople[1];
  expect(
    resolveCommsPermission(
      c,
      { person: eli, channel: restricted },
      "managePermissions",
    ).allowed,
  ).toBe(true);
  expect(
    resolveCommsPermission(
      c,
      { person: { ...eli, active: false }, channel },
      "viewChannel",
    ).allowed,
  ).toBe(false);
  expect(resolveCommsPermission(c, { channel }, "viewChannel").allowed).toBe(
    false,
  );
});
test("normalization preserves custom scope values and repairs invalid fields independently", () => {
  const c = normalizeCommsConfiguration({
    version: 1,
    workspace: {
      settings: { slowModeSeconds: -3, formatting: false },
      permissions: {},
    },
    channels: {
      custom: {
        settings: { mode: "thread-first", maxFileSizeMb: 7 },
        permissions: { everyone: { post: "deny" } },
      },
    },
  });
  expect(c.workspace.settings.formatting).toBe(false);
  expect(c.workspace.settings.slowModeSeconds).toBeUndefined();
  expect(c.channels.custom.settings.mode).toBe("thread-first");
  expect(c.channels.custom.permissions.everyone.post).toBe("deny");
  expect(normalizeCommsConfiguration(c)).toEqual(c);
});

test("pinning defaults to managers while protected owner retains access", () => {
  const c = createCommsConfiguration();
  const member = { ...initialPeople[1], id: "ordinary-member" };
  expect(
    resolveCommsPermission(c, { person: member, channel }, "pin").allowed,
  ).toBe(false);
  expect(
    resolveCommsPermission(c, { person: initialPeople[1], channel }, "pin")
      .allowed,
  ).toBe(true);
  expect(
    resolveCommsPermission(c, { person: initialPeople[0], channel }, "pin")
      .allowed,
  ).toBe(true);
});

test("local legacy restrictions survive workspace allows but local overrides and locks take precedence", () => {
  const c = createCommsConfiguration();
  const member = { ...initialPeople[1], id: "ordinary" };
  c.workspace.permissions.everyone = { viewChannel: "allow", post: "allow" };
  const category = {
    ...CATEGORIES[0],
    access: "roles" as const,
    roles: [],
    posting: "roles" as const,
    postRoles: [],
  };
  const context = { person: member, channel, categories: [category] };
  expect(resolveCommsPermission(c, context, "viewChannel").allowed).toBe(false);
  c.categories[category.id] = {
    settings: {},
    permissions: { everyone: { viewChannel: "inherit", post: "allow" } },
  };
  expect(resolveCommsPermission(c, context, "viewChannel").allowed).toBe(true);
  expect(resolveCommsPermission(c, context, "post").allowed).toBe(true);
  const privateChannel = {
    ...channel,
    inherit: false,
    access: "roles" as const,
    roles: [],
  };
  expect(
    resolveCommsPermission(
      c,
      { ...context, channel: privateChannel },
      "viewChannel",
    ).allowed,
  ).toBe(false);
  c.lockedPermissions = ["viewChannel"];
  expect(
    resolveCommsPermission(
      c,
      { ...context, channel: privateChannel },
      "viewChannel",
    ).allowed,
  ).toBe(true);
});
test("channel moderators do not acquire workspace management or channel creation by default", () => {
  const c = createCommsConfiguration();
  const member = { ...initialPeople[1], id: "moderator" };
  c.channels[channel.id] = {
    settings: { moderatorIds: [member.id] },
    permissions: {},
  };
  expect(
    resolveCommsPermission(c, { person: member, channel }, "manageChannel")
      .allowed,
  ).toBe(true);
  expect(
    resolveCommsPermission(c, { person: member, channel }, "manageWorkspace")
      .allowed,
  ).toBe(false);
  expect(
    resolveCommsPermission(c, { person: member, channel }, "createChannel")
      .allowed,
  ).toBe(false);
});
test("normalization retains valid revisions beside damaged entries and preserves history lock snapshots", () => {
  const revision = {
    id: "m",
    conversation: "c",
    author: "You",
    text: "Original",
    created: 1,
    pinned: false,
  };
  const c = normalizeCommsConfiguration({
    messageHistory: { m: [revision, { text: 7 }] },
    history: [
      {
        id: "h",
        created: 1,
        actorId: "sample-eli",
        label: "Locks",
        scope: { kind: "workspace", id: "workspace" },
        before: { settings: {}, permissions: {} },
        after: { settings: {}, permissions: {} },
        beforeLocks: { settings: [], permissions: [] },
        afterLocks: { settings: ["mode"], permissions: ["post"] },
      },
    ],
  });
  expect(c.messageHistory.m).toEqual([revision]);
  expect(c.history[0]).toMatchObject({
    beforeLocks: { settings: [], permissions: [] },
    afterLocks: { settings: ["mode"], permissions: ["post"] },
  });
  expect(normalizeCommsConfiguration(c)).toEqual(c);
});
