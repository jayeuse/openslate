import { expect, test } from "@playwright/test";
import { conversationAccess } from "../../support/comms-memory/domain/access";
import {
  admitSend,
  assertMessageChange,
  assertReaction,
} from "../../support/comms-memory/domain/posting";
import { notificationDecision } from "../../support/comms-memory/domain/notifications";
import { resolveSettings } from "../../support/comms-memory/domain/settings";
import { hideInNewDepartment } from "../../support/comms-memory/memory/seed";
import { caughtFailure, configure, policyFixture } from "./memory-fixture";

const now = Date.parse("2026-09-11T02:00:00Z");
const send = {
  client_key: "71000000-0000-4000-8000-000000000088",
  body: "Ready for handover",
};

test("root posting admits current posters, rejects guests and archive, and returns normalized input", () => {
  const { world, channel, person, context } = policyFixture();
  expect(admitSend(world, context, channel.id, send, { now }).body).toBe(
    "Ready for handover",
  );
  person.role = "guest";
  expect(() => admitSend(world, context, channel.id, send, { now })).toThrow(
    "refused",
  );
  person.role = "member";
  channel.archived_at = new Date(now).toISOString();
  expect(() => admitSend(world, context, channel.id, send, { now })).toThrow(
    "refused",
  );
});

test("empty messages and hidden resources retain distinct safe failure contracts", () => {
  const { world, channel, context } = policyFixture();
  expect(
    caughtFailure(() =>
      admitSend(world, context, channel.id, { ...send, body: "  " }, { now }),
    ),
  ).toMatchObject({
    kind: "http",
    failure: { status: 422, body: { detail: { code: "comms_message_empty" } } },
  });
  hideInNewDepartment(
    world,
    channel.id,
    "71000000-0000-4000-8000-0000000000aa",
  );
  expect(
    caughtFailure(() => admitSend(world, context, channel.id, send, { now })),
  ).toMatchObject({
    kind: "http",
    failure: { status: 404, body: { detail: { code: "comms_not_found" } } },
  });
});

test("notification refusal strips presentation after membership or context loss", () => {
  const { world, channel, person, context } = policyFixture();
  const shared = resolveSettings(world, {
    kind: "channel",
    id: channel.id,
  }).effective;
  const input = {
    world,
    context,
    conversation_id: channel.id,
    shared,
    personal: {},
    now,
    time_zone: "UTC",
    text: "Private update",
    mentioned: true,
    followed_thread: false,
  };
  person.active = false;
  expect(notificationDecision(input)).toEqual({
    allowed: false,
    reason: "no_access",
    sound: false,
    badge: false,
    preview: false,
    desktop: false,
  });
  person.active = true;
  expect(
    notificationDecision({
      ...input,
      context: { ...context, org_id: "71000000-0000-4000-8000-000000000099" },
    }).preview,
  ).toBe(false);
});

test("root and reply admission enforce locks, restrictions and channel modes without manager bypass", () => {
  const f = policyFixture();
  const { world, channel, context, person } = f;
  const root = Object.values(world.messages).find((m) => !m.parent_id)!;
  const scope = { kind: "channel", id: channel.id } as const;
  configure(f, { scope, everyone: {}, group_grants: [] });
  const settings = world.configuration[`channel:${channel.id}`]!.settings;
  settings.locked = true;
  person.role = "admin";
  expect(() => admitSend(world, context, channel.id, send, { now })).toThrow(
    "refused",
  );
  expect(() =>
    admitSend(world, context, channel.id, send, { now, parent_id: root.id }),
  ).toThrow("refused");
  settings.locked = false;
  settings.restricted_person_ids = [context.user_id];
  settings.restriction_until = new Date(now + 1).toISOString();
  expect(() => admitSend(world, context, channel.id, send, { now })).toThrow(
    "refused",
  );
  settings.restriction_until = new Date(now).toISOString();
  expect(admitSend(world, context, channel.id, send, { now }).body).toBe(
    send.body,
  );
  person.role = "member";
  settings.mode = "announcements";
  expect(() => admitSend(world, context, channel.id, send, { now })).toThrow(
    "refused",
  );
  expect(
    admitSend(world, context, channel.id, send, { now, parent_id: root.id })
      .body,
  ).toBe(send.body);
  settings.mode = "thread-first";
  expect(() => admitSend(world, context, channel.id, send, { now })).toThrow(
    "refused",
  );
  const thread = Object.values(world.threads)[0];
  thread.locked = true;
  expect(() =>
    admitSend(world, context, channel.id, send, { now, parent_id: root.id }),
  ).toThrow("refused");
});

test("posting validates record and file ownership, ready state, allowlists and narrower ceilings", () => {
  const f = policyFixture();
  const { world, channel, context } = f;
  configure(f, {
    scope: { kind: "channel", id: channel.id },
    everyone: {},
    group_grants: [],
  });
  const settings = world.configuration[`channel:${channel.id}`]!.settings;
  const record = Object.values(world.records)[0];
  settings.require_record_link = true;
  expect(() => admitSend(world, context, channel.id, send, { now })).toThrow(
    "refused",
  );
  const linked = { ...send, record_ids: [record.id] };
  expect(
    admitSend(world, context, channel.id, linked, { now }).record_ids,
  ).toEqual([record.id]);
  world.people[context.user_id].readable_module_ids = [];
  expect(() => admitSend(world, context, channel.id, linked, { now })).toThrow(
    "refused",
  );
  world.people[context.user_id].readable_module_ids = [record.module_id];
  const fileId = "71000000-0000-4000-8000-000000000070";
  world.files[fileId] = {
    id: fileId,
    org_id: world.org_id,
    conversation_id: channel.id,
    creator_id: context.user_id,
    purpose: "comms_attachment",
    filename: "handover.pdf",
    expected_size: 100,
    actual_size: 100,
    media_type: "application/pdf",
    state: "ready",
    failure_code: null,
    is_deleted: false,
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  };
  const attached = { ...linked, attachment_ids: [fileId] };
  expect(
    admitSend(world, context, channel.id, attached, { now }).attachment_ids,
  ).toEqual([fileId]);
  world.files[fileId].state = "awaiting_upload";
  expect(() =>
    admitSend(world, context, channel.id, attached, { now }),
  ).toThrow("refused");
  world.files[fileId].state = "ready";
  world.files[fileId].filename = "handover.txt";
  expect(() =>
    admitSend(world, context, channel.id, attached, { now }),
  ).toThrow("refused");
  world.files[fileId].filename = "handover.pdf";
  settings.max_file_size_mb = 0.00001;
  expect(() =>
    admitSend(world, context, channel.id, attached, { now }),
  ).toThrow("refused");
});

test("mentions and slow mode use structured recipients and all successful sends including replies", () => {
  const f = policyFixture();
  const { world, channel, context } = f;
  configure(f, {
    scope: { kind: "channel", id: channel.id },
    everyone: {},
    group_grants: [],
  });
  const settings = world.configuration[`channel:${channel.id}`]!.settings;
  expect(() =>
    admitSend(
      world,
      context,
      channel.id,
      { ...send, mentions_here: true },
      { now },
    ),
  ).toThrow("refused");
  const invalidRecipient = "71000000-0000-4000-8000-000000000097";
  expect(() =>
    admitSend(
      world,
      context,
      channel.id,
      { ...send, mention_user_ids: [invalidRecipient] },
      { now },
    ),
  ).toThrow("refused");
  const recipients = f.peers.slice(0, 2).map((p) => p.user_id);
  settings.mention_limit = 1;
  expect(() =>
    admitSend(
      world,
      context,
      channel.id,
      { ...send, mention_user_ids: recipients },
      { now },
    ),
  ).toThrow("refused");
  settings.slow_mode_seconds = 10;
  const reply = Object.values(world.messages).find((m) => m.parent_id)!;
  reply.author_id = context.user_id;
  reply.created_at = new Date(now - 5_000).toISOString();
  const before = structuredClone(world);
  expect(() => admitSend(world, context, channel.id, send, { now })).toThrow(
    "refused",
  );
  expect(world).toEqual(before);
  expect(
    admitSend(world, context, channel.id, send, { now: now + 5_000 }).body,
  ).toBe(send.body);
});

test("person mentions follow channel readers, not member rows", () => {
  const { world, channel, context, peers, person } = policyFixture();
  const recipient = peers[1];
  delete world.members[channel.id][recipient.user_id];
  const mentioned = { ...send, mention_user_ids: [recipient.user_id] };
  // D44 A4: a reader without a row is mentionable.
  expect(
    admitSend(world, context, channel.id, mentioned, { now }).mention_user_ids,
  ).toEqual([recipient.user_id]);
  // A department channel where only the sender holds a role.
  const desk = "71000000-0000-4000-8000-0000000000ab";
  hideInNewDepartment(world, channel.id, desk);
  person.department_levels[desk] = "write";
  expect(
    conversationAccess(
      world,
      { ...context, user_id: recipient.user_id },
      channel.id,
    ).level,
  ).toBe("none");
  const before = structuredClone(world);
  expect(
    caughtFailure(() =>
      admitSend(world, context, channel.id, mentioned, { now }),
    ),
  ).toMatchObject({
    kind: "http",
    failure: { status: 422, body: { detail: { code: "comms_invalid_input" } } },
  });
  expect(world).toEqual(before);
});

test("direct messages ignore channel modes but not blocks; org send rate includes other conversations", () => {
  const f = policyFixture();
  const { world, context, channel } = f;
  configure(f, {
    scope: { kind: "workspace" },
    everyone: {},
    group_grants: [],
  });
  world.configuration.workspace!.settings.mode = "thread-first";
  const { id, org_id, created_at, updated_at, archived_at, creator_id } =
    channel;
  world.conversations[id] = {
    id,
    org_id,
    created_at,
    updated_at,
    archived_at,
    creator_id,
    kind: "direct",
  };
  world.members[id] = {
    [context.user_id]: world.members[id][context.user_id],
    [f.peers[0].user_id]: world.members[id][f.peers[0].user_id],
  };
  expect(admitSend(world, context, id, send, { now }).body).toBe(send.body);
  world.blocks[f.peers[0].user_id] = [
    { blocked_user_id: context.user_id, created_at },
  ];
  expect(() => admitSend(world, context, id, send, { now })).toThrow("refused");
  world.blocks = {};
  const root = Object.values(world.messages)[0];
  for (let index = 0; index < 20; index++) {
    const key = `71000000-0000-4000-8000-${(100 + index).toString().padStart(12, "0")}`;
    world.messages[key] = {
      ...root,
      id: key,
      conversation_id: "71000000-0000-4000-8000-000000000095",
      author_id: context.user_id,
      created_at: new Date(now - 9_999).toISOString(),
    };
  }
  expect(() => admitSend(world, context, id, send, { now })).toThrow("refused");
  expect(admitSend(world, context, id, send, { now: now + 1 }).body).toBe(
    send.body,
  );
});

test("own edits obey windows and other-person removal requires capability; reactions obey policy", () => {
  const f = policyFixture();
  const { world, channel, context } = f;
  const message = Object.values(world.messages)[0];
  message.created_at = new Date(now - 60_001).toISOString();
  message.author_id = context.user_id;
  expect(() =>
    assertMessageChange(world, context, message.id, "edit", now),
  ).not.toThrow();
  configure(f, {
    scope: { kind: "channel", id: channel.id },
    everyone: {},
    group_grants: [],
  });
  const settings = world.configuration[`channel:${channel.id}`]!.settings;
  settings.edit_window_minutes = 1;
  settings.delete_window_minutes = 1;
  expect(() =>
    assertMessageChange(world, context, message.id, "edit", now),
  ).toThrow("refused");
  message.author_id = f.peers[1].user_id;
  expect(() =>
    assertMessageChange(world, context, message.id, "delete", now),
  ).toThrow("refused");
  world.members[channel.id][context.user_id] = {
    user_id: context.user_id,
    member_role: "manager",
    joined_at: "2026-09-11T01:00:00Z",
  };
  expect(() =>
    assertMessageChange(world, context, message.id, "delete", now),
  ).not.toThrow();
  expect(() =>
    assertMessageChange(world, context, message.id, "edit", now),
  ).toThrow("refused");
  message.author_id = context.user_id;
  expect(() =>
    assertMessageChange(world, context, message.id, "delete", now),
  ).toThrow("refused");
  expect(() => assertReaction(world, context, message.id, "👍")).not.toThrow();
  expect(() =>
    assertReaction(world, context, message.id, "not allowed"),
  ).toThrow("refused");
});

test("normal notification is local, readable and carries independent presentation decisions", () => {
  const { world, channel, context } = policyFixture();
  const shared = resolveSettings(world, {
    kind: "channel",
    id: channel.id,
  }).effective;
  expect(
    notificationDecision({
      world,
      context,
      conversation_id: channel.id,
      shared,
      personal: {},
      now,
      time_zone: "UTC",
      text: "Handover",
      mentioned: false,
      followed_thread: false,
    }),
  ).toEqual({
    allowed: true,
    reason: "allowed",
    sound: true,
    badge: true,
    preview: true,
    desktop: true,
  });
});

test("personal notification modes and keywords cannot widen shared policy or presentation", () => {
  const { world, channel, context } = policyFixture();
  const shared = resolveSettings(world, {
    kind: "channel",
    id: channel.id,
  }).effective;
  shared.notification_mode = "mentions";
  shared.keywords = ["handover"];
  shared.notification_preview = false;
  shared.notification_sound = false;
  const input = {
    world,
    context,
    conversation_id: channel.id,
    shared,
    personal: { notification_mode: "all" as const, notification_preview: true },
    now,
    time_zone: "UTC",
    text: "Ordinary update",
    mentioned: false,
    followed_thread: false,
  };
  expect(notificationDecision(input)).toMatchObject({
    allowed: false,
    sound: false,
    preview: false,
  });
  input.text = "HANDOVER is ready";
  expect(notificationDecision(input).allowed).toBe(true);
  expect(
    notificationDecision({
      ...input,
      personal: { notification_mode: "mentions", keywords: ["urgent"] },
    }).allowed,
  ).toBe(false);
  expect(
    notificationDecision({
      ...input,
      personal: { desktop_notifications: false, notification_badges: false },
    }),
  ).toMatchObject({ allowed: true, desktop: false, badge: false });
});

test("quiet-hour windows independently narrow in regional time; mute expiry and follow opt-out are exact", () => {
  const { world, channel, context } = policyFixture();
  const shared = resolveSettings(world, {
    kind: "channel",
    id: channel.id,
  }).effective;
  shared.quiet_hours_start = "22:00";
  shared.quiet_hours_end = "06:00";
  const input = {
    world,
    context,
    conversation_id: channel.id,
    shared,
    personal: { quiet_hours_start: "09:00", quiet_hours_end: "11:00" },
    now,
    time_zone: "Asia/Manila",
    text: "Update",
    mentioned: true,
    followed_thread: true,
  };
  expect(notificationDecision(input)).toEqual({
    allowed: true,
    reason: "quiet_hours",
    sound: false,
    badge: true,
    preview: true,
    desktop: false,
  }); // 10:00 regional: personal quiet hours only
  expect(
    notificationDecision({ ...input, now: Date.parse("2026-09-11T14:00:00Z") }),
  ).toEqual({
    allowed: true,
    reason: "quiet_hours",
    sound: false,
    badge: true,
    preview: true,
    desktop: false,
  }); // 22:00: shared quiet hours only, inclusive start
  expect(
    notificationDecision({ ...input, now: Date.parse("2026-09-10T22:00:00Z") }),
  ).toEqual({
    allowed: true,
    reason: "allowed",
    sound: true,
    badge: true,
    preview: true,
    desktop: true,
  }); // 06:00: shared exclusive end, personal window not started
  expect(
    notificationDecision({ ...input, now: Date.parse("2026-09-11T03:00:00Z") }),
  ).toEqual({
    allowed: true,
    reason: "allowed",
    sound: true,
    badge: true,
    preview: true,
    desktop: true,
  }); // 11:00: personal exclusive end, shared window not started
  expect(
    notificationDecision({
      ...input,
      personal: { notify_followed_threads: false },
      time_zone: "UTC",
      now: Date.parse("2026-09-11T12:00:00Z"),
    }).reason,
  ).toBe("follow_disabled");
  const prefs = {
    notify: "all" as const,
    mute: { kind: "until" as const, until: new Date(now).toISOString() },
    starred: false,
    hidden: false,
    manual_unread: false,
  };
  expect(
    notificationDecision({
      ...input,
      personal: {},
      time_zone: "UTC",
      now: Date.parse("2026-09-11T12:00:00Z"),
      preferences: prefs,
    }).allowed,
  ).toBe(true);
  prefs.mute.until = new Date(now + 86_400_000).toISOString();
  expect(notificationDecision({ ...input, preferences: prefs }).reason).toBe(
    "muted",
  );
});
