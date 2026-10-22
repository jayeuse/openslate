import { expect, test } from "@playwright/test";

import {
  attachmentReservationSchema,
  commsContextSchema,
  commsFailureSchema,
  conversationSchema,
  directRequestSchemaFor,
  groupRequestSchemaFor,
  historyPageSchema,
  historyPageSchemaFor,
  historyRequestSchema,
  bootstrapSchema,
  memberPreferencesPatchSchema,
  personalPreferencesRequestSchema,
  messageSchema,
  preconditionSchema,
  realtimeEventSchemaFor,
  recordReferenceSchema,
  sendMessageRequestSchema,
  sendReplyRequestSchema,
  sendResultSchema,
  settingsPatchSchema,
  templateImportSchema,
  exportRequestSchema,
  searchRequestSchema,
  retentionRequestSchema,
  retentionPreviewSchema,
  capabilityDefaults,
  capabilityConfigurationSchema,
  capabilityLocksSchema,
  capabilityCheckSchemaFor,
  configurationHistorySchema,
  configurationRestoreRequestSchema,
  templateApplyRequestSchema,
  channelCreationCheckSchemaFor,
} from "../../../src/components/systems/comms/contract/schemas";

const org = "00000000-0000-4000-8000-000000000001";
const otherOrg = "00000000-0000-4000-8000-000000000002";
const user = "00000000-0000-4000-8000-000000000003";
const otherUser = "00000000-0000-4000-8000-000000000004";
const thirdUser = "00000000-0000-4000-8000-000000000005";
const conversation = "00000000-0000-4000-8000-000000000006";
const messageId = "00000000-0000-4000-8000-000000000007";
const clientKey = "00000000-0000-4000-8000-000000000008";
const attachment = "00000000-0000-4000-8000-000000000009";
const context = { org_id: org, user_id: user };
const timestamp = "2026-10-19T08:00:00Z";
const reference = {
  id: "00000000-0000-4000-8000-000000000010",
  state: "unavailable",
};
const identity = {
  id: messageId,
  org_id: org,
  conversation_id: conversation,
  seq: 3,
  author_id: user,
  client_key: clientKey,
  created_at: timestamp,
  parent_id: null,
  reply_to_id: null,
  also_send_to_channel: false,
};
const liveMessage = {
  ...identity,
  state: "live",
  body: "The next shift starts at nine.",
  edited_at: null,
  pinned_at: null,
  pinned_by: null,
  attachments: [],
  record_references: [reference],
  mention_user_ids: [],
  mentions_channel: false,
  mentions_here: false,
  reactions: [],
  thread: null,
  link_previews: [],
};
const tombstone = {
  ...identity,
  state: "deleted",
  deleted_at: timestamp,
  thread: null,
};

test("send admission preserves Unicode and admits content without requiring text", () => {
  expect(
    sendMessageRequestSchema.safeParse({
      client_key: clientKey,
      body: "🧭".repeat(4_000),
    }).success,
  ).toBe(true);
  expect(
    sendMessageRequestSchema.safeParse({
      client_key: clientKey,
      body: "🧭".repeat(4_001),
    }).success,
  ).toBe(false);
  expect(
    sendMessageRequestSchema.safeParse({ client_key: clientKey, body: " \n " })
      .success,
  ).toBe(false);
  expect(
    sendMessageRequestSchema.safeParse({
      client_key: clientKey,
      body: "",
      attachment_ids: [attachment],
    }).success,
  ).toBe(true);
  expect(
    sendMessageRequestSchema.safeParse({
      client_key: clientKey,
      body: "",
      record_ids: [reference.id],
    }).success,
  ).toBe(true);
});

test("send admission rejects actor injection and duplicate or excessive attachments", () => {
  const request = { client_key: clientKey, body: "Ready" };
  expect(
    sendMessageRequestSchema.safeParse({ ...request, author_id: otherUser })
      .success,
  ).toBe(false);
  expect(
    sendMessageRequestSchema.safeParse({ ...request, org_id: otherOrg })
      .success,
  ).toBe(false);
  expect(sendMessageRequestSchema.safeParse({ body: "Ready" }).success).toBe(
    false,
  );
  expect(
    sendMessageRequestSchema.safeParse({
      ...request,
      attachment_ids: [attachment, attachment],
    }).success,
  ).toBe(false);
  const ten = Array.from(
    { length: 10 },
    (_, index) =>
      `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
  );
  expect(
    sendMessageRequestSchema.safeParse({ ...request, attachment_ids: ten })
      .success,
  ).toBe(true);
  expect(
    sendMessageRequestSchema.safeParse({
      ...request,
      attachment_ids: [...ten, attachment],
    }).success,
  ).toBe(false);
  expect(
    sendReplyRequestSchema.safeParse({
      ...request,
      also_send_to_channel: true,
    }).success,
  ).toBe(true);
  expect(
    sendMessageRequestSchema.safeParse({
      ...request,
      parent_id: messageId,
    }).success,
  ).toBe(false);
});

test("history requests select exactly one direction without offset paging", () => {
  for (const request of [
    {},
    { before_seq: 3 },
    { after_seq: 0 },
    { around_seq: 3, limit: 50 },
  ]) {
    expect(historyRequestSchema.safeParse(request).success).toBe(true);
  }
  for (const request of [
    { before_seq: 3, after_seq: 0 },
    { around_seq: 3, before_seq: 4 },
    { offset: 0 },
    { after_seq: -1 },
    { after_seq: 1.5 },
    { after_seq: Number.MAX_SAFE_INTEGER + 1 },
    { before_seq: 0 },
    { limit: 101 },
  ]) {
    expect(historyRequestSchema.safeParse(request).success).toBe(false);
  }
});

test("history accepts sparse ordered sequences but refuses mixed scope and inconsistent pages", () => {
  const later = {
    ...liveMessage,
    id: "00000000-0000-4000-8000-000000000011",
    seq: 9,
    client_key: "00000000-0000-4000-8000-000000000012",
  };
  const page = {
    org_id: org,
    conversation_id: conversation,
    thread_root_id: null,
    items: [liveMessage, later],
    pagination: {
      limit: 50,
      count: 2,
      first_seq: 3,
      last_seq: 9,
      high_water_seq: 12,
      has_older: true,
      has_newer: true,
    },
  };
  expect(historyPageSchema.safeParse(page).success).toBe(true);
  for (const invalid of [
    { ...page, items: [later, liveMessage] },
    { ...page, items: [liveMessage, { ...later, seq: 3 }] },
    { ...page, items: [liveMessage, { ...later, org_id: otherOrg }] },
    { ...page, items: [liveMessage, { ...later, conversation_id: otherUser }] },
    { ...page, pagination: { ...page.pagination, count: 1 } },
    { ...page, pagination: { ...page.pagination, last_seq: 8 } },
    { ...page, pagination: { ...page.pagination, high_water_seq: 8 } },
  ]) {
    expect(historyPageSchema.safeParse(invalid).success).toBe(false);
  }
  expect(
    historyPageSchema.safeParse({
      ...page,
      items: [],
      pagination: {
        ...page.pagination,
        count: 0,
        first_seq: null,
        last_seq: null,
        has_older: false,
        has_newer: false,
      },
    }).success,
  ).toBe(true);
});

test("tombstones and unavailable records cannot retain protected content", () => {
  expect(messageSchema.safeParse(liveMessage).success).toBe(true);
  expect(messageSchema.safeParse(tombstone).success).toBe(true);
  expect(
    messageSchema.safeParse({ ...tombstone, body: "Removed text" }).success,
  ).toBe(false);
  expect(
    messageSchema.safeParse({ ...tombstone, attachments: [attachment] })
      .success,
  ).toBe(false);
  expect(recordReferenceSchema.safeParse(reference).success).toBe(true);
  expect(
    recordReferenceSchema.safeParse({ ...reference, title: "Private record" })
      .success,
  ).toBe(false);
  expect(
    recordReferenceSchema.safeParse({ ...reference, record_id: messageId })
      .success,
  ).toBe(false);
  expect(
    sendResultSchema.safeParse({ status: 200, message: tombstone }).success,
  ).toBe(true);
  expect(
    sendResultSchema.safeParse({ status: 201, message: tombstone }).success,
  ).toBe(false);
});

test("conversation creation is bound to the actor and counts distinct participants", () => {
  expect(commsContextSchema.safeParse(context).success).toBe(true);
  expect(commsContextSchema.safeParse({ user_id: user }).success).toBe(false);
  const direct = directRequestSchemaFor(context);
  expect(direct.safeParse({ recipient_id: otherUser }).success).toBe(true);
  expect(direct.safeParse({ recipient_id: user }).success).toBe(false);
  const group = groupRequestSchemaFor(context);
  expect(
    group.safeParse({ participant_ids: [user, otherUser, thirdUser] }).success,
  ).toBe(true);
  for (const participant_ids of [
    [user, otherUser],
    [user, otherUser, otherUser],
    [org, otherUser, thirdUser],
    [
      user,
      ...Array.from(
        { length: 50 },
        (_, i) =>
          `00000000-0000-4000-8000-${String(i + 200).padStart(12, "0")}`,
      ),
    ],
  ]) {
    expect(group.safeParse({ participant_ids }).success).toBe(false);
  }
  const directConversation = {
    id: conversation,
    org_id: org,
    kind: "direct",
    participant_ids: [user, otherUser],
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null,
    level: "post",
    member_count: 2,
    member_role: "member",
  };
  expect(conversationSchema.safeParse(directConversation).success).toBe(true);
  expect(
    conversationSchema.safeParse({
      ...directConversation,
      participant_ids: [user, user],
    }).success,
  ).toBe(false);
});

test("private realtime events accept only their exact id payload and bound topic", () => {
  const schema = realtimeEventSchemaFor(context);
  const topic = `org:${org}:conversation:${conversation}`;
  const event = {
    topic,
    private: true,
    event: "message",
    payload: { conversation_id: conversation, seq: 9, kind: "edited" },
  };
  expect(schema.safeParse(event).success).toBe(true);
  for (const invalid of [
    { ...event, private: false },
    { ...event, topic: `org:${otherOrg}:conversation:${conversation}` },
    { ...event, topic: `org:${org}:conversation:${messageId}` },
    { ...event, topic: `org:${org}:user:${user}` },
    { ...event, payload: { ...event.payload, body: "Not an invalidation" } },
    { ...event, payload: { ...event.payload, client_key: clientKey } },
    { ...event, payload: { ...event.payload, kind: "upsert" } },
  ]) {
    expect(schema.safeParse(invalid).success).toBe(false);
  }
  expect(
    schema.safeParse({
      topic: `org:${org}:user:${user}`,
      private: true,
      event: "read",
      payload: { conversation_id: conversation, last_read_seq: 0 },
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      topic: `org:${org}:user:${otherUser}`,
      private: true,
      event: "notification",
      payload: { id: messageId },
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      topic: `org:${org}:presence`,
      private: true,
      event: "presence",
      payload: { user_id: otherUser, state: "away" },
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      topic,
      private: true,
      event: "typing",
      payload: { conversation_id: conversation, user_id: otherUser },
    }).success,
  ).toBe(true);
  for (const kind of ["grants", "structure"]) {
    expect(
      schema.safeParse({
        topic: `org:${org}:user:${user}`,
        private: true,
        event: kind,
        payload: {},
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        topic: `org:${org}:user:${user}`,
        private: true,
        event: kind,
        payload: { conversation_id: conversation },
      }).success,
    ).toBe(false);
  }
});

test("preconditions and runtime failures keep refusal status separate from success", () => {
  expect(
    preconditionSchema.safeParse({ if_match: '"settings-4"' }).success,
  ).toBe(true);
  for (const value of [{}, { if_match: " " }, { if_match: "*" }]) {
    expect(preconditionSchema.safeParse(value).success).toBe(false);
  }
  const denied = {
    status: 403,
    body: {
      detail: { code: "comms_post_denied", message: "Posting is not allowed" },
    },
  };
  expect(commsFailureSchema.safeParse(denied).success).toBe(true);
  expect(commsFailureSchema.safeParse({ ...denied, status: 200 }).success).toBe(
    false,
  );
  expect(commsFailureSchema.safeParse({ ...denied, status: 404 }).success).toBe(
    false,
  );
  expect(
    commsFailureSchema.safeParse({
      status: 429,
      body: {
        detail: { code: "comms_rate_limited", message: "Try again later" },
      },
      retry_after_seconds: 2,
    }).success,
  ).toBe(true);
  expect(
    commsFailureSchema.safeParse({
      status: 429,
      body: {
        detail: { code: "comms_rate_limited", message: "Try again later" },
      },
    }).success,
  ).toBe(false);
});

test("file admission retains the platform size ceiling and safe filename boundary", () => {
  const valid = { filename: "shift.pdf", expected_size: 10 * 1024 * 1024 };
  expect(attachmentReservationSchema.safeParse(valid).success).toBe(true);
  for (const invalid of [
    { ...valid, expected_size: valid.expected_size + 1 },
    { ...valid, expected_size: 0 },
    { ...valid, expected_size: 1.5 },
    { ...valid, filename: "../shift.pdf" },
    { ...valid, filename: "shift\u0000.pdf" },
    { ...valid, storage_path: "public/shift.pdf" },
  ]) {
    expect(attachmentReservationSchema.safeParse(invalid).success).toBe(false);
  }
});

test("history response binding enforces exclusive cursors and the requested organization", () => {
  const page = {
    org_id: org,
    conversation_id: conversation,
    thread_root_id: null,
    items: [liveMessage],
    pagination: {
      limit: 50,
      count: 1,
      first_seq: 3,
      last_seq: 3,
      high_water_seq: 12,
      has_older: false,
      has_newer: false,
    },
  };
  expect(
    historyPageSchemaFor(context, conversation, { after_seq: 2 }).safeParse(
      page,
    ).success,
  ).toBe(true);
  expect(
    historyPageSchemaFor(context, conversation, { after_seq: 3 }).safeParse(
      page,
    ).success,
  ).toBe(false);
  expect(
    historyPageSchemaFor(context, conversation, { before_seq: 3 }).safeParse(
      page,
    ).success,
  ).toBe(false);
  expect(
    historyPageSchemaFor(
      { ...context, org_id: otherOrg },
      conversation,
      {},
    ).safeParse(page).success,
  ).toBe(false);
});

test("manual unread is a reminder preference, not an author-supplied read watermark", () => {
  expect(
    memberPreferencesPatchSchema.safeParse({ manual_unread: true }).success,
  ).toBe(true);
  expect(
    memberPreferencesPatchSchema.safeParse({ manual_unread: false }).success,
  ).toBe(true);
  expect(
    memberPreferencesPatchSchema.safeParse({
      manual_unread: true,
      last_read_seq: 0,
    }).success,
  ).toBe(false);
  expect(
    memberPreferencesPatchSchema.safeParse({
      user_id: otherUser,
      manual_unread: true,
    }).success,
  ).toBe(false);
  expect(memberPreferencesPatchSchema.safeParse({}).success).toBe(false);
});

test("settings retain platform ceilings and exclude retired permission and automation fields", () => {
  expect(
    settingsPatchSchema.safeParse({
      edit_window_minutes: 0,
      link_previews: false,
    }).success,
  ).toBe(true);
  expect(
    settingsPatchSchema.safeParse({
      max_file_size_mb: 10,
      allowed_file_types: ["pdf", "png"],
    }).success,
  ).toBe(true);
  expect(
    settingsPatchSchema.safeParse({
      quiet_hours_start: "22:00",
      quiet_hours_end: "06:00",
    }).success,
  ).toBe(true);
  for (const input of [
    {},
    { max_file_size_mb: 11 },
    { allowed_file_types: ["exe"] },
    { edit_window_minutes: -1 },
    { quiet_hours_start: "25:00" },
    { quiet_hours_start: "22:00" },
    { system_messages: true },
    { mobile_notifications: true },
    { permissions: { person: "allow" } },
    { owner_id: user },
    { retention_days: 7 },
  ]) {
    expect(settingsPatchSchema.safeParse(input).success).toBe(false);
  }
});

test("template imports count UTF-8 bytes and reject legacy permissions", () => {
  const value = {
    name: "Shift",
    description: "",
    settings: { mode: "normal" },
  };
  expect(templateImportSchema.safeParse(value).success).toBe(true);
  expect(
    templateImportSchema.safeParse({ ...value, permissions: {} }).success,
  ).toBe(false);
  expect(
    templateImportSchema.safeParse({
      ...value,
      description: "🧭".repeat(17_000),
    }).success,
  ).toBe(false);
  for (const settings of [
    {},
    { quiet_hours_start: "22:00", quiet_hours_end: "06:00" },
    { quiet_hours_start: "", quiet_hours_end: "" },
  ]) {
    expect(templateImportSchema.safeParse({ ...value, settings }).success).toBe(
      true,
    );
  }
  for (const settings of [
    { quiet_hours_start: "22:00" },
    { quiet_hours_end: "06:00" },
    { quiet_hours_start: "", quiet_hours_end: "06:00" },
    { quiet_hours_start: "22:00", quiet_hours_end: "" },
  ]) {
    expect(templateImportSchema.safeParse({ ...value, settings }).success).toBe(
      false,
    );
  }
});

test("personal notification inputs set, clear or inherit both quiet-hour endpoints", () => {
  const preferences = {
    density: "comfortable",
    text_size: "medium",
    timestamps: "time",
    group_messages: true,
    avatars: true,
    previews: true,
    send_shortcut: "enter",
    shortcuts: { search: "Alt+F", new_message: "Alt+N" },
    channel_width: 240,
    member_width: 220,
    thread_width: 380,
  };
  for (const notifications of [
    {},
    { notification_sound: false },
    { quiet_hours_start: "22:00", quiet_hours_end: "06:00" },
    { quiet_hours_start: "", quiet_hours_end: "" },
  ]) {
    expect(
      personalPreferencesRequestSchema.safeParse({
        ...preferences,
        notifications,
      }).success,
    ).toBe(true);
  }
  for (const notifications of [
    { quiet_hours_start: "22:00" },
    { quiet_hours_end: "06:00" },
    { quiet_hours_start: "", quiet_hours_end: "06:00" },
    { quiet_hours_start: "22:00", quiet_hours_end: "" },
  ]) {
    expect(
      personalPreferencesRequestSchema.safeParse({
        ...preferences,
        notifications,
      }).success,
    ).toBe(false);
  }
});

test("export and search dates are ordered and export formats are finite", () => {
  const request = {
    conversation_ids: [conversation],
    format: "csv",
    after: "2026-10-01",
    before: "2026-10-19",
  };
  expect(exportRequestSchema.safeParse(request).success).toBe(true);
  expect(
    exportRequestSchema.safeParse({
      ...request,
      format: "xlsx",
      reason: "Review requested by administrator",
    }).success,
  ).toBe(true);
  expect(
    exportRequestSchema.safeParse({ ...request, format: "json" }).success,
  ).toBe(false);
  expect(
    exportRequestSchema.safeParse({ ...request, before: "2026-09-30" }).success,
  ).toBe(false);
  expect(
    searchRequestSchema.safeParse({
      q: "shift",
      after: "2026-10-01",
      before: "2026-10-19",
    }).success,
  ).toBe(true);
  expect(
    searchRequestSchema.safeParse({
      q: "shift",
      after: "2026-10-20",
      before: "2026-10-19",
    }).success,
  ).toBe(false);
});

test("retention requires a preview digest and keeps forever explicit", () => {
  const request = {
    scope: { kind: "workspace" },
    message_days: 0,
    file_days: 0,
    preview_digest: "a".repeat(64),
  };
  expect(retentionRequestSchema.safeParse(request).success).toBe(true);
  expect(
    retentionRequestSchema.safeParse({ ...request, message_days: -1 }).success,
  ).toBe(false);
  expect(
    retentionRequestSchema.safeParse({ ...request, preview_digest: "" })
      .success,
  ).toBe(false);
  expect(
    retentionRequestSchema.safeParse({
      ...request,
      scope: { kind: "category", id: conversation },
    }).success,
  ).toBe(false);
  const channel = { ...request, scope: { kind: "channel", id: conversation } };
  for (const periods of [
    { message_days: null, file_days: 7 },
    { message_days: 7, file_days: null },
    { message_days: null, file_days: null },
    { message_days: 0, file_days: 0 },
  ]) {
    expect(
      retentionRequestSchema.safeParse({ ...channel, ...periods }).success,
    ).toBe(true);
  }
  for (const periods of [
    { message_days: null },
    { file_days: null },
    { message_days: null, file_days: null },
  ]) {
    expect(
      retentionRequestSchema.safeParse({ ...request, ...periods }).success,
    ).toBe(false);
  }
  for (const periods of [{ message_days: -1 }, { file_days: -1 }]) {
    expect(
      retentionRequestSchema.safeParse({ ...channel, ...periods }).success,
    ).toBe(false);
  }
  expect(
    retentionRequestSchema.safeParse({
      scope: channel.scope,
      message_days: null,
      file_days: null,
    }).success,
  ).toBe(false);
});

test("retention previews distinguish inherited periods from explicit forever", () => {
  const preview = {
    policy: {
      scope: { kind: "channel", id: conversation },
      message_days: null,
      file_days: 0,
    },
    effective: { message_days: 30, file_days: 0 },
    sources: { message_days: "workspace", file_days: "channel" },
    message_count: 1,
    file_count: 0,
    preview_digest: "a".repeat(64),
    expires_at: timestamp,
  };
  expect(retentionPreviewSchema.safeParse(preview).success).toBe(true);
  expect(
    retentionPreviewSchema.safeParse({
      ...preview,
      policy: { scope: { kind: "workspace" }, message_days: 30, file_days: 0 },
      sources: { message_days: "workspace", file_days: "workspace" },
    }).success,
  ).toBe(true);
  for (const invalid of [
    { ...preview, sources: { message_days: "channel", file_days: "channel" } },
    {
      ...preview,
      sources: { message_days: "workspace", file_days: "workspace" },
    },
    { ...preview, effective: { message_days: 30, file_days: 7 } },
    { ...preview, effective: { message_days: null, file_days: 0 } },
  ]) {
    expect(retentionPreviewSchema.safeParse(invalid).success).toBe(false);
  }
});

test("bootstrap cannot manufacture unread targets or carry another organization's summary", () => {
  const summary = {
    conversation: {
      id: conversation,
      org_id: org,
      kind: "direct",
      participant_ids: [user, otherUser],
      created_at: timestamp,
      updated_at: timestamp,
      archived_at: null,
      level: "post",
      member_count: 2,
      member_role: "member",
    },
    preferences: {
      notify: "all",
      mute: { kind: "off" },
      starred: false,
      hidden: false,
      manual_unread: true,
    },
    last_read_seq: 9,
    high_water_seq: 9,
    unread_count: 0,
    mention_count: 0,
    first_unread_seq: null,
  };
  const bootstrap = {
    org_id: org,
    user_id: user,
    categories: [],
    conversations: [summary],
  };
  expect(bootstrapSchema.safeParse(bootstrap).success).toBe(true);
  expect(
    bootstrapSchema.safeParse({ ...bootstrap, org_id: otherOrg }).success,
  ).toBe(false);
  expect(
    bootstrapSchema.safeParse({
      ...bootstrap,
      conversations: [{ ...summary, first_unread_seq: 3 }],
    }).success,
  ).toBe(false);
  expect(
    bootstrapSchema.safeParse({
      ...bootstrap,
      conversations: [{ ...summary, unread_count: 0, mention_count: 1 }],
    }).success,
  ).toBe(false);
});

const expectedCapabilityDefaults = {
  react: "poster",
  reply: "poster",
  createThread: "poster",
  attachFiles: "poster",
  linkRecords: "poster",
  mentionChannel: "conversation_manager",
  pin: "conversation_manager",
  manageThreads: "conversation_manager",
  deleteOthersMessages: "conversation_manager",
  moderate: "conversation_manager",
  manageChannel: "conversation_manager",
  createChannel: "org_admin_or_department_manager",
  manageWorkspace: "org_admin",
} as const;
const groupId = "00000000-0000-4000-8000-000000000011";
const categoryId = "00000000-0000-4000-8000-000000000012";
const emptyCapabilities = { group_grants: [], everyone: {} };
const readerCheck = {
  org_id: org,
  user_id: otherUser,
  conversation_id: conversation,
  category_id: categoryId,
  membership_role: "member",
  conversation_level: "read",
  manager_source: null,
  access_source: { kind: "membership" },
  capabilities: Object.fromEntries(
    Object.entries(expectedCapabilityDefaults).map(([key, basis]) => [
      key,
      { allowed: false, source: { kind: "default", basis } },
    ]),
  ),
};
const posterCheck = {
  ...readerCheck,
  conversation_level: "post",
  capabilities: {
    ...readerCheck.capabilities,
    ...Object.fromEntries(
      ["react", "reply", "createThread", "attachFiles", "linkRecords"].map(
        (key) => [
          key,
          { allowed: true, source: { kind: "default", basis: "poster" } },
        ],
      ),
    ),
  },
};

test("D27 capability defaults and legal group scopes match the owner matrix", () => {
  expect(capabilityDefaults).toEqual(expectedCapabilityDefaults);
  const scopes = [
    { kind: "workspace" },
    { kind: "category", id: categoryId },
    { kind: "channel", id: conversation },
  ] as const;
  const common = [
    "reply",
    "mentionChannel",
    "pin",
    "manageThreads",
    "deleteOthersMessages",
    "moderate",
  ];
  for (const scope of scopes) {
    const allowed = [
      ...common,
      ...(scope.kind !== "workspace" ? ["manageChannel"] : []),
      ...(scope.kind !== "channel" ? ["createChannel"] : []),
    ];
    for (const capability of Object.keys(expectedCapabilityDefaults)) {
      expect(
        capabilityConfigurationSchema.safeParse({
          scope,
          everyone: {},
          group_grants: [{ group_id: groupId, capability }],
        }).success,
        `${scope.kind}: ${capability}`,
      ).toBe(allowed.includes(capability));
    }
  }
});

test("D27 local grants never encode people, denies, duplicate grants or lower-scope locks", () => {
  const valid = {
    scope: { kind: "category", id: categoryId },
    group_grants: [{ group_id: groupId, capability: "manageChannel" }],
    everyone: {
      react: false,
      reply: true,
      createThread: false,
      attachFiles: true,
      linkRecords: false,
    },
  };
  expect(capabilityConfigurationSchema.safeParse(valid).success).toBe(true);
  for (const input of [
    { ...valid, group_grants: [...valid.group_grants, ...valid.group_grants] },
    { ...valid, group_grants: [{ user_id: user, capability: "pin" }] },
    {
      ...valid,
      group_grants: [{ group_id: groupId, capability: "pin", granted: false }],
    },
    { ...valid, everyone: { moderate: true } },
    { ...valid, everyone: { react: "deny" } },
    { ...valid, locks: ["react"] },
    { ...valid, org_id: otherOrg },
    {
      ...valid,
      group_grants: [{ group_id: groupId, capability: "viewHistory" }],
    },
  ])
    expect(capabilityConfigurationSchema.safeParse(input).success).toBe(false);
  expect(
    capabilityConfigurationSchema.safeParse({
      scope: valid.scope,
      ...emptyCapabilities,
    }).success,
  ).toBe(true);
  expect(
    capabilityLocksSchema.safeParse({
      capabilities: ["react", "manageChannel", "createChannel"],
    }).success,
  ).toBe(true);
  expect(
    capabilityLocksSchema.safeParse({ capabilities: ["manageWorkspace"] })
      .success,
  ).toBe(false);
  expect(
    capabilityLocksSchema.safeParse({ capabilities: ["reply", "reply"] })
      .success,
  ).toBe(false);
  expect(
    capabilityLocksSchema.safeParse({ capabilities: [], scope: valid.scope })
      .success,
  ).toBe(false);
});

test("C6 capability responses retain complete shapes and bind the inspected context", () => {
  const schema = capabilityCheckSchemaFor(context, conversation, otherUser);
  expect(schema.safeParse(readerCheck).success).toBe(true);
  const withReply = (decision: object) => ({
    ...posterCheck,
    capabilities: { ...posterCheck.capabilities, reply: decision },
  });
  for (const source of [
    {
      kind: "group_grant",
      group_id: groupId,
      group_name: "Shift",
      scope: { kind: "category", id: categoryId },
    },
    {
      kind: "everyone",
      scope: { kind: "channel", id: conversation },
      enabled: true,
    },
    { kind: "workspace_lock", enabled: true },
  ])
    expect(schema.safeParse(withReply({ allowed: true, source })).success).toBe(
      true,
    );
  for (const invalid of [
    { ...readerCheck, org_id: otherOrg },
    { ...readerCheck, user_id: user },
    { ...readerCheck, conversation_id: messageId },
    { ...readerCheck, capabilities: {} },
    {
      ...readerCheck,
      capabilities: { ...readerCheck.capabilities, unknown: {} },
    },
    { ...readerCheck, membership_role: "owner" },
    { ...readerCheck, conversation_level: "write" },
    { ...readerCheck, manager_source: "owner" },
    { ...readerCheck, category_id: "not-a-uuid" },
    { ...readerCheck, extra: true },
    withReply({
      allowed: "true",
      source: { kind: "admin" },
    }),
    withReply({
      allowed: true,
      source: {
        kind: "group_grant",
        group_id: "not-a-uuid",
        group_name: "Shift",
        scope: { kind: "workspace" },
      },
    }),
    withReply({
      allowed: true,
      source: {
        kind: "everyone",
        scope: { kind: "channel" },
        enabled: false,
      },
    }),
    withReply({
      allowed: true,
      source: { kind: "workspace_lock" },
    }),
    withReply({
      allowed: true,
      source: { kind: "default", basis: "owner" },
    }),
    withReply({
      allowed: true,
      source: { kind: "admin", user_id: otherUser },
    }),
    withReply({
      allowed: true,
      source: { kind: "person_override", user_id: otherUser },
    }),
  ])
    expect(schema.safeParse(invalid).success).toBe(false);
  for (const omitted of Object.keys(expectedCapabilityDefaults)) {
    expect(
      schema.safeParse({
        ...readerCheck,
        capabilities: Object.fromEntries(
          Object.entries(readerCheck.capabilities).filter(
            ([key]) => key !== omitted,
          ),
        ),
      }).success,
      `missing ${omitted}`,
    ).toBe(false);
  }
});

test("C6 capability responses preserve server decisions without evaluating roles or grants", () => {
  const schema = capabilityCheckSchemaFor(context, conversation, otherUser);
  // These are shape examples, not authorization expectations. D27 is server-owned.
  for (const decision of [
    { allowed: true, source: { kind: "default", basis: "poster" } },
    { allowed: true, source: { kind: "workspace_lock", enabled: false } },
    {
      allowed: false,
      source: {
        kind: "group_grant",
        group_id: groupId,
        group_name: "Shift",
        scope: { kind: "category", id: messageId },
      },
    },
    {
      allowed: true,
      source: {
        kind: "everyone",
        scope: { kind: "channel", id: messageId },
        enabled: false,
      },
    },
  ]) {
    const check = {
      ...readerCheck,
      capabilities: { ...readerCheck.capabilities, reply: decision },
    };
    expect(schema.parse(check)).toEqual(check);
  }
  for (const metadata of [
    { membership_role: "guest" },
    { membership_role: "admin" },
    { manager_source: "creator" },
  ]) {
    const check = { ...posterCheck, ...metadata };
    expect(schema.parse(check)).toEqual(check);
  }
});

test("C6 accepts the D43 nonreading admin representation unchanged", () => {
  const schema = capabilityCheckSchemaFor(context, conversation, otherUser);
  const check = {
    ...readerCheck,
    membership_role: "admin",
    conversation_level: "none",
    access_source: { kind: "none", reason: "no_access" },
    capabilities: Object.fromEntries(
      Object.keys(expectedCapabilityDefaults).map((key) => [
        key,
        {
          allowed: false,
          source: { kind: "access", reason: "no_read_access" },
        },
      ]),
    ),
  };
  expect(schema.parse(check)).toEqual(check);
});

test("D27 templates and protected history carry scoped capabilities, not legacy permission or retention bypasses", () => {
  const template = {
    name: "Shift",
    description: "",
    settings: {},
    capabilities: {
      group_grants: [{ group_id: groupId, capability: "manageChannel" }],
      everyone: { reply: true },
    },
  };
  expect(templateImportSchema.safeParse(template).success).toBe(true);
  expect(
    templateImportSchema.safeParse({
      ...template,
      capabilities: {
        ...template.capabilities,
        group_grants: [{ group_id: groupId, capability: "createChannel" }],
      },
    }).success,
  ).toBe(false);
  const snapshot = {
    settings: {},
    capabilities: {
      scope: { kind: "channel", id: conversation },
      ...emptyCapabilities,
    },
  };
  const history = {
    id: messageId,
    org_id: org,
    created_at: timestamp,
    updated_at: timestamp,
    actor_id: user,
    scope: snapshot.capabilities.scope,
    before: snapshot,
    after: snapshot,
  };
  expect(configurationHistorySchema.safeParse(history).success).toBe(true);
  const workspaceSnapshot = {
    ...snapshot,
    capabilities: { scope: { kind: "workspace" }, ...emptyCapabilities },
    dm_rule: "shared-channel",
  };
  expect(
    configurationHistorySchema.safeParse({
      ...history,
      scope: { kind: "workspace" },
      before: workspaceSnapshot,
      after: workspaceSnapshot,
    }).success,
  ).toBe(true);
  expect(
    configurationHistorySchema.safeParse({
      ...history,
      after: { ...snapshot, dm_rule: "shared-channel" },
    }).success,
  ).toBe(false);
  expect(
    configurationHistorySchema.safeParse({
      ...history,
      after: {
        ...snapshot,
        capabilities: {
          ...snapshot.capabilities,
          scope: { kind: "workspace" },
        },
      },
    }).success,
  ).toBe(false);
  expect(
    configurationHistorySchema.safeParse({
      ...history,
      after: { ...snapshot, settings: { retention_days: 7 } },
    }).success,
  ).toBe(false);
  expect(
    configurationRestoreRequestSchema.safeParse({
      history_id: messageId,
      preview_digest: "a".repeat(64),
    }).success,
  ).toBe(true);
  expect(
    configurationRestoreRequestSchema.safeParse({ history_id: messageId })
      .success,
  ).toBe(false);
});

test("D27 capability-only template apply cannot target workspace authority or select nothing", () => {
  expect(
    templateApplyRequestSchema.safeParse({
      conversation_ids: [conversation],
      keys: [],
      capability_keys: ["reply", "manageChannel"],
    }).success,
  ).toBe(true);
  for (const capability_keys of [
    [],
    ["createChannel"],
    ["manageWorkspace"],
    ["pin", "pin"],
  ]) {
    expect(
      templateApplyRequestSchema.safeParse({
        conversation_ids: [conversation],
        keys: [],
        capability_keys,
      }).success,
    ).toBe(false);
  }
});

test("C6 access explanations validate source shape rather than infer access", () => {
  const schema = capabilityCheckSchemaFor(context, conversation, otherUser);
  const explained = {
    ...readerCheck,
    access_source: { kind: "department", department_id: thirdUser },
  };
  expect(schema.safeParse(explained).success).toBe(true);
  for (const access_source of [
    { kind: "organization" },
    explained.access_source,
    { kind: "membership" },
    { kind: "none", reason: "no_access" },
    { kind: "none", reason: "inactive_membership" },
    { kind: "admin" },
    { kind: "manager", reason: "creator" },
    { kind: "guest_cap" },
  ]) {
    expect(schema.safeParse({ ...readerCheck, access_source }).success).toBe(
      true,
    );
    expect(schema.safeParse({ ...posterCheck, access_source }).success).toBe(
      true,
    );
  }
  // D44: a channel shared with an access group no longer exists.
  expect(
    schema.safeParse({
      ...explained,
      access_source: { kind: "group", group_id: groupId, group_name: "Shift" },
    }).success,
  ).toBe(false);
});

test("C6 creation checks bind actor and target scope without evaluating server decisions", () => {
  const scope = { kind: "category", id: categoryId } as const;
  const schema = channelCreationCheckSchemaFor(context, scope);
  const granted = {
    org_id: org,
    user_id: user,
    scope,
    membership_role: "member",
    decision: {
      allowed: true,
      source: {
        kind: "group_grant",
        group_id: groupId,
        group_name: "Shift",
        scope,
      },
    },
  };
  expect(schema.safeParse(granted).success).toBe(true);
  expect(
    schema.safeParse({
      ...granted,
      decision: {
        allowed: true,
        source: {
          kind: "department_manager",
          department_id: thirdUser,
          category_id: categoryId,
        },
      },
    }).success,
  ).toBe(true);
  for (const check of [
    { ...granted, membership_role: "guest" },
    {
      ...granted,
      decision: {
        allowed: true,
        source: {
          ...granted.decision.source,
          scope: { kind: "channel", id: conversation },
        },
      },
    },
    {
      ...granted,
      decision: {
        allowed: true,
        source: {
          ...granted.decision.source,
          scope: { kind: "category", id: messageId },
        },
      },
    },
    {
      ...granted,
      decision: {
        allowed: true,
        source: { kind: "manager", reason: "creator" },
      },
    },
    {
      ...granted,
      membership_role: "admin",
      decision: {
        allowed: false,
        source: { kind: "workspace_lock", enabled: false },
      },
    },
  ])
    expect(schema.parse(check)).toEqual(check);
  for (const invalid of [
    { ...granted, org_id: otherOrg },
    { ...granted, user_id: otherUser },
    { ...granted, scope: { kind: "workspace" } },
    { ...granted, scope: { kind: "category", id: messageId } },
    { ...granted, scope: { kind: "channel", id: conversation } },
    { ...granted, scope: { kind: "category" } },
    { ...granted, membership_role: "owner" },
    { ...granted, conversation_id: conversation },
    { ...granted, decision: { source: { kind: "admin" } } },
    { ...granted, decision: { allowed: "true", source: { kind: "admin" } } },
    { ...granted, decision: { allowed: true, source: { kind: "owner" } } },
  ])
    expect(schema.safeParse(invalid).success).toBe(false);
});
