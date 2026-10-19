import { z } from "zod";

// S01 contract-first definitions. These do not authorize requests or implement
// a transport; FastAPI must derive the actor and re-check the bound organization.
const uuid = z.uuid();
const dateTime = z.iso.datetime({ offset: true });
const sequence = z.number().int().positive();
const watermark = z.number().int().nonnegative();
const distinct = (values: readonly string[]) =>
  new Set(values).size === values.length;
const nonemptyPatch = (value: object) => Object.keys(value).length > 0;
const pairedQuietHours = (value: {
  quiet_hours_start?: string;
  quiet_hours_end?: string;
}) =>
  (value.quiet_hours_start === undefined) ===
    (value.quiet_hours_end === undefined) &&
  (value.quiet_hours_start === "") === (value.quiet_hours_end === "");
const ids = z.array(uuid).refine(distinct, "IDs must be distinct");
const body = z
  .string()
  .refine((text) => [...text].length <= 4_000, "At most 4,000 characters");

export const commsContextSchema = z.strictObject({
  org_id: uuid,
  user_id: uuid,
});

const contentFields = {
  body,
  attachment_ids: ids.max(10).default([]),
  record_ids: ids.default([]),
  mention_user_ids: ids.default([]),
  mentions_channel: z.boolean().default(false),
  mentions_here: z.boolean().default(false),
  reply_to_id: uuid.nullable().default(null),
};
const sendFields = {
  client_key: uuid,
  ...contentFields,
};
const hasContent = (value: {
  body: string;
  attachment_ids: string[];
  record_ids: string[];
}) =>
  value.body.trim().length > 0 ||
  value.attachment_ids.length > 0 ||
  value.record_ids.length > 0;
export const sendMessageRequestSchema = z
  .strictObject(sendFields)
  .refine(hasContent, "Message is empty");
export const sendReplyRequestSchema = z
  .strictObject({
    ...sendFields,
    also_send_to_channel: z.boolean().default(false),
  })
  .refine(hasContent, "Message is empty");

// File bodies remain binary. No storage key, bucket or direct URL is exposed.
const filename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !/[\u0000-\u001f/\\]/.test(value) && value !== "." && value !== "..",
    "A plain filename without control characters is required",
  );
const fileSize = z
  .number()
  .int()
  .positive()
  .max(10 * 1024 * 1024);
export const attachmentReservationSchema = z.strictObject({
  filename,
  expected_size: fileSize,
});
export const attachmentSchema = z.strictObject({
  id: uuid,
  filename,
  media_type: z.string().min(1),
  size: fileSize,
});
export const fileSchema = z.strictObject({
  id: uuid,
  org_id: uuid,
  conversation_id: uuid,
  creator_id: uuid,
  purpose: z.literal("comms_attachment"),
  filename,
  expected_size: fileSize,
  actual_size: fileSize.nullable(),
  media_type: z.string().nullable(),
  state: z.enum([
    "awaiting_upload",
    "uploading",
    "ready",
    "rejected",
    "deleting",
    "purged",
  ]),
  failure_code: z.string().nullable(),
  is_deleted: z.boolean(),
  created_at: dateTime,
  updated_at: dateTime,
});
export const recordReferenceSchema = z.discriminatedUnion("state", [
  z.strictObject({ id: uuid, state: z.literal("unavailable") }),
  z.strictObject({
    id: uuid,
    state: z.literal("available"),
    record_id: uuid,
    module_id: uuid,
    module_name: z.string(),
    title: z.string(),
    fields: z.array(
      z.strictObject({
        field_id: uuid,
        label: z.string(),
        display_value: z.string(),
      }),
    ),
  }),
]);
export const threadSchema = z.strictObject({
  id: uuid,
  org_id: uuid,
  conversation_id: uuid,
  root_message_id: uuid,
  name: z.string(),
  resolved: z.boolean(),
  locked: z.boolean(),
  archived: z.boolean(),
  followed: z.boolean(),
  reply_count: watermark,
  last_reply_at: dateTime.nullable(),
});
const messageIdentity = {
  id: uuid,
  org_id: uuid,
  conversation_id: uuid,
  seq: sequence,
  author_id: uuid,
  client_key: uuid,
  created_at: dateTime,
  parent_id: uuid.nullable(),
  reply_to_id: uuid.nullable(),
  also_send_to_channel: z.boolean(),
  thread: threadSchema.nullable(),
};
export const liveMessageSchema = z.strictObject({
  ...messageIdentity,
  state: z.literal("live"),
  body,
  edited_at: dateTime.nullable(),
  pinned_at: dateTime.nullable(),
  pinned_by: uuid.nullable(),
  attachments: z.array(attachmentSchema).max(10),
  record_references: z.array(recordReferenceSchema),
  mention_user_ids: ids,
  mentions_channel: z.boolean(),
  mentions_here: z.boolean(),
  reactions: z.array(
    z.strictObject({ emoji: z.string().min(1), user_ids: ids }),
  ),
  link_previews: z.array(
    z.strictObject({
      url: z.url({ protocol: /^https?$/ }),
      title: z.string(),
      description: z.string(),
      site_name: z.string(),
    }),
  ),
});
export const tombstoneSchema = z.strictObject({
  ...messageIdentity,
  state: z.literal("deleted"),
  deleted_at: dateTime,
});
export const messageSchema = z.discriminatedUnion("state", [
  liveMessageSchema,
  tombstoneSchema,
]);
// Status is client metadata, not a JSON success envelope. Replays re-check access
// and return the current representation, including a tombstone after deletion.
export const sendResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal(201), message: liveMessageSchema }),
  z.strictObject({ status: z.literal(200), message: messageSchema }),
]);

export const historyRequestSchema = z
  .strictObject({
    limit: z.number().int().min(1).max(100).default(50),
    before_seq: sequence.optional(),
    after_seq: watermark.optional(),
    around_seq: sequence.optional(),
  })
  .refine(
    (request) =>
      [request.before_seq, request.after_seq, request.around_seq].filter(
        (value) => value !== undefined,
      ).length <= 1,
    "Choose one history direction",
  );
export const historyPageSchema = z
  .strictObject({
    org_id: uuid,
    conversation_id: uuid,
    thread_root_id: uuid.nullable(),
    items: z.array(messageSchema).max(100),
    pagination: z.strictObject({
      limit: z.number().int().min(1).max(100),
      count: watermark,
      first_seq: sequence.nullable(),
      last_seq: sequence.nullable(),
      high_water_seq: watermark,
      has_older: z.boolean(),
      has_newer: z.boolean(),
    }),
  })
  .refine(
    ({ items, pagination: page, org_id, conversation_id, thread_root_id }) =>
      items.length === page.count &&
      page.count <= page.limit &&
      page.first_seq === (items[0]?.seq ?? null) &&
      page.last_seq === (items.at(-1)?.seq ?? null) &&
      distinct(items.map((item) => item.id)) &&
      items.every(
        (item, index) =>
          item.org_id === org_id &&
          item.conversation_id === conversation_id &&
          item.seq <= page.high_water_seq &&
          (index === 0 || item.seq > items[index - 1].seq) &&
          (thread_root_id === null
            ? item.parent_id === null || item.also_send_to_channel
            : item.parent_id === thread_root_id),
      ),
    "History scope, ordering and pagination must agree",
  );

const resourceIdentity = {
  id: uuid,
  org_id: uuid,
  created_at: dateTime,
  updated_at: dateTime,
};
export const groupAccessSchema = z.discriminatedUnion("subject", [
  z.strictObject({
    subject: z.literal("everyone"),
    level: z.enum(["read", "post"]),
  }),
  z.strictObject({
    subject: z.literal("group"),
    group_id: uuid,
    level: z.enum(["read", "post"]),
  }),
]);
export const categorySchema = z.strictObject({
  ...resourceIdentity,
  name: z.string().trim().min(1),
  position: watermark,
  department_id: uuid.nullable(),
  default_access: z.array(groupAccessSchema),
});
const conversationIdentity = {
  ...resourceIdentity,
  archived_at: dateTime.nullable(),
  level: z.enum(["read", "post", "manage"]),
  member_count: watermark,
  member_role: z.enum(["member", "manager"]).nullable(),
};
const channelFields = {
  ...conversationIdentity,
  kind: z.literal("channel"),
  name: z.string().trim().min(1),
  topic: z.string(),
  category_id: uuid.nullable(),
  position: watermark,
};
export const channelSchema = z.discriminatedUnion("scope", [
  z.strictObject({ ...channelFields, scope: z.literal("organization") }),
  z.strictObject({
    ...channelFields,
    scope: z.literal("department"),
    department_id: uuid,
  }),
  z.strictObject({
    ...channelFields,
    scope: z.literal("groups"),
    access: z.array(groupAccessSchema),
  }),
  z.strictObject({ ...channelFields, scope: z.literal("members") }),
]);
export const directSchema = z.strictObject({
  ...conversationIdentity,
  kind: z.literal("direct"),
  participant_ids: ids.length(2),
});
export const groupSchema = z.strictObject({
  ...conversationIdentity,
  kind: z.literal("group"),
  name: z.string(),
  participant_ids: ids.min(3).max(50),
});
export const conversationSchema = z.union([
  channelSchema,
  directSchema,
  groupSchema,
]);
export const directRequestSchema = z.strictObject({ recipient_id: uuid });
export function directRequestSchemaFor(
  context: z.output<typeof commsContextSchema>,
) {
  commsContextSchema.parse(context);
  return directRequestSchema.refine(
    (request) => request.recipient_id !== context.user_id,
    "Choose another person",
  );
}
export const groupRequestSchema = z.strictObject({
  name: z.string().default(""),
  participant_ids: ids.min(3).max(50),
});
export function groupRequestSchemaFor(
  context: z.output<typeof commsContextSchema>,
) {
  commsContextSchema.parse(context);
  return groupRequestSchema.refine(
    (request) => request.participant_ids.includes(context.user_id),
    "Participants include the current actor",
  );
}

const eventBase = { topic: z.string(), private: z.literal(true) };
export const realtimeEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    ...eventBase,
    event: z.literal("message"),
    payload: z.strictObject({
      conversation_id: uuid,
      seq: sequence,
      kind: z.enum([
        "created",
        "edited",
        "deleted",
        "reaction",
        "pin",
        "thread",
      ]),
    }),
  }),
  z.strictObject({
    ...eventBase,
    event: z.literal("typing"),
    payload: z.strictObject({ conversation_id: uuid, user_id: uuid }),
  }),
  z.strictObject({
    ...eventBase,
    event: z.literal("read"),
    payload: z.strictObject({
      conversation_id: uuid,
      last_read_seq: watermark,
    }),
  }),
  z.strictObject({
    ...eventBase,
    event: z.literal("notification"),
    payload: z.strictObject({ id: uuid }),
  }),
  z.strictObject({
    ...eventBase,
    event: z.literal("membership"),
    payload: z.strictObject({ conversation_id: uuid }),
  }),
  z.strictObject({
    ...eventBase,
    event: z.literal("grants"),
    payload: z.strictObject({}),
  }),
  z.strictObject({
    ...eventBase,
    event: z.literal("structure"),
    payload: z.strictObject({}),
  }),
  z.strictObject({
    ...eventBase,
    event: z.literal("presence"),
    payload: z.strictObject({
      user_id: uuid,
      state: z.enum(["online", "away", "offline"]),
    }),
  }),
]);
export function realtimeEventSchemaFor(
  context: z.output<typeof commsContextSchema>,
) {
  commsContextSchema.parse(context);
  return realtimeEventSchema.refine((event) => {
    const prefix = `org:${context.org_id}:`;
    if (event.event === "message" || event.event === "typing")
      return (
        event.topic === `${prefix}conversation:${event.payload.conversation_id}`
      );
    if (event.event === "presence") return event.topic === `${prefix}presence`;
    return event.topic === `${prefix}user:${context.user_id}`;
  }, "Event topic must match its payload and bound context");
}

export const preconditionSchema = z.strictObject({
  if_match: z.string().regex(/^"[^"\u0000-\u0020\u007f]+"$/),
});
function failure<const Status extends number, const Code extends string>(
  status: Status,
  codes: readonly [Code, ...Code[]],
) {
  return z.strictObject({
    status: z.literal(status),
    body: z.strictObject({
      detail: z.strictObject({ code: z.enum(codes), message: z.string() }),
    }),
  });
}
export const commsFailureSchema = z.union([
  z.strictObject({
    status: z.literal(401),
    body: z.strictObject({ detail: z.string() }),
  }),
  failure(403, [
    "comms_post_denied",
    "comms_capability_denied",
    "comms_admin_required",
    "comms_fresh_admin_required",
  ]),
  failure(404, ["comms_not_found", "file_not_found"]),
  failure(409, [
    "comms_idempotency_mismatch",
    "comms_conflict",
    "comms_capacity_reached",
    "comms_schedule_claimed",
    "file_uploads_full",
  ]),
  failure(412, ["comms_precondition_failed"]),
  failure(428, ["comms_precondition_required"]),
  failure(422, ["comms_message_empty", "comms_invalid_input"]),
  z.strictObject({
    status: z.literal(422),
    body: z.strictObject({
      detail: z.array(
        z.object({
          loc: z.array(z.union([z.string(), z.number()])),
          msg: z.string(),
          type: z.string(),
        }),
      ),
    }),
  }),
  failure(429, ["comms_rate_limited", "comms_slow_mode"]).extend({
    retry_after_seconds: z.number().int().nonnegative(),
  }),
  failure(503, ["comms_unavailable", "file_quota_busy"]),
]);

export function historyPageSchemaFor(
  context: z.output<typeof commsContextSchema>,
  conversationId: string,
  input: z.input<typeof historyRequestSchema>,
  threadRootId: string | null = null,
) {
  commsContextSchema.parse(context);
  uuid.parse(conversationId);
  const request = historyRequestSchema.parse(input);
  return historyPageSchema.refine(
    (page) =>
      page.org_id === context.org_id &&
      page.conversation_id === conversationId &&
      page.thread_root_id === threadRootId &&
      page.pagination.limit === request.limit &&
      page.items.every(
        (item) =>
          (request.before_seq === undefined || item.seq < request.before_seq) &&
          (request.after_seq === undefined || item.seq > request.after_seq),
      ),
    "History must match the requested scope and exclusive cursor",
  );
}

// Non-history lists use the existing StandardListResponse wire shape. Domain
// consumers mark complete/page collections in their adapters, not on the wire.
export function pageSchema<Item extends z.ZodType>(item: Item) {
  return z.strictObject({
    items: z.array(item),
    pagination: z.strictObject({
      limit: z.number().int().min(1).max(100),
      offset: watermark,
      count: watermark,
      total: watermark,
      has_more: z.boolean(),
    }),
  });
}
const listFields = {
  limit: z.number().int().min(1).max(100).default(25),
  offset: watermark.default(0),
  sort_order: z.enum(["asc", "desc"]).default("asc"),
};
export const conversationListRequestSchema = z.strictObject({
  ...listFields,
  sort_by: z.enum(["position", "name", "updated_at"]).default("position"),
  search: z.string().trim().max(100).optional(),
  archived: z.boolean().default(false),
});
export const categoryListRequestSchema = conversationListRequestSchema.omit({
  archived: true,
});
export const timeListRequestSchema = z.strictObject({
  ...listFields,
  sort_by: z.enum(["created_at", "updated_at"]).default("created_at"),
});
export const threadListRequestSchema = timeListRequestSchema.extend({
  followed: z.boolean().optional(),
  resolved: z.boolean().optional(),
  archived: z.boolean().default(false),
});
export const memberListRequestSchema = z.strictObject({
  ...listFields,
  sort_by: z.literal("display_name").default("display_name"),
  search: z.string().trim().max(100).optional(),
});
export const memberSchema = z.strictObject({
  user_id: uuid,
  display_name: z.string(),
  member_role: z.enum(["member", "manager"]),
  joined_at: dateTime,
  departments: z.array(z.strictObject({ id: uuid, name: z.string() })),
});
export const presenceSchema = z.strictObject({
  user_id: uuid,
  state: z.enum(["online", "away", "offline"]),
});
export const presenceSnapshotSchema = z.strictObject({
  org_id: uuid,
  items: z.array(presenceSchema).max(100),
});
export const presenceRequestSchema = z.strictObject({
  state: z.enum(["online", "away"]),
});
export const presenceListRequestSchema = z.strictObject({
  user_ids: ids.max(100),
});

const muteSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("off") }),
  z.strictObject({ kind: z.literal("indefinite") }),
  z.strictObject({ kind: z.literal("until"), until: dateTime }),
]);
export const memberPreferencesSchema = z.strictObject({
  notify: z.enum(["all", "mentions", "mute"]),
  mute: muteSchema,
  starred: z.boolean(),
  hidden: z.boolean(),
  manual_unread: z.boolean(),
});
export const memberPreferencesPatchSchema = memberPreferencesSchema
  .partial()
  .refine(nonemptyPatch);
export const readStateSchema = z.strictObject({
  conversation_id: uuid,
  last_read_seq: watermark,
});
export const markReadRequestSchema = z.strictObject({
  last_read_seq: watermark,
});
export const categoryPreferencesSchema = z.strictObject({
  collapsed: z.boolean(),
  mute: muteSchema,
});
export const conversationSummarySchema = z
  .strictObject({
    conversation: conversationSchema,
    preferences: memberPreferencesSchema,
    last_read_seq: watermark,
    high_water_seq: watermark,
    unread_count: watermark.max(100),
    mention_count: watermark.max(100),
    first_unread_seq: sequence.nullable(),
  })
  .refine(
    (summary) =>
      summary.last_read_seq <= summary.high_water_seq &&
      summary.mention_count <= summary.unread_count &&
      (summary.unread_count === 0
        ? summary.first_unread_seq === null
        : summary.first_unread_seq !== null &&
          summary.first_unread_seq > summary.last_read_seq &&
          summary.first_unread_seq <= summary.high_water_seq),
    "Unread targets and counts must follow the real read watermark",
  );
export const bootstrapSchema = z
  .strictObject({
    org_id: uuid,
    user_id: uuid,
    categories: z.array(
      z.strictObject({
        category: categorySchema,
        preferences: categoryPreferencesSchema,
      }),
    ),
    conversations: z.array(conversationSummarySchema),
  })
  .refine(
    (value) =>
      value.categories.every(
        ({ category }) => category.org_id === value.org_id,
      ) &&
      value.conversations.every(
        ({ conversation }) => conversation.org_id === value.org_id,
      ),
    "Bootstrap belongs to one organization",
  );

export const settingsScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("workspace") }),
  z.strictObject({ kind: z.literal("category"), id: uuid }),
  z.strictObject({ kind: z.literal("channel"), id: uuid }),
]);

export const capabilitySchema = z.enum([
  "react",
  "reply",
  "createThread",
  "attachFiles",
  "linkRecords",
  "mentionChannel",
  "pin",
  "manageThreads",
  "deleteOthersMessages",
  "moderate",
  "manageChannel",
  "createChannel",
  "manageWorkspace",
]);
export const capabilityDefaults = {
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
} as const satisfies Record<z.output<typeof capabilitySchema>, string>;
// Metadata only. S04/S16 own evaluation against live membership and settings.
export const capabilityGroupScopes: Readonly<
  Record<
    z.output<typeof capabilitySchema>,
    readonly z.output<typeof settingsScopeSchema>["kind"][]
  >
> = {
  react: [],
  reply: ["workspace", "category", "channel"],
  createThread: [],
  attachFiles: [],
  linkRecords: [],
  mentionChannel: ["workspace", "category", "channel"],
  pin: ["workspace", "category", "channel"],
  manageThreads: ["workspace", "category", "channel"],
  deleteOthersMessages: ["workspace", "category", "channel"],
  moderate: ["workspace", "category", "channel"],
  manageChannel: ["category", "channel"],
  createChannel: ["workspace", "category"],
  manageWorkspace: [],
};
export const everyoneCapabilitySchema = capabilitySchema.extract([
  "react",
  "reply",
  "createThread",
  "attachFiles",
  "linkRecords",
]);
export const lockableCapabilitySchema = capabilitySchema.exclude([
  "manageWorkspace",
]);
export const conversationCapabilitySchema = capabilitySchema.exclude([
  "createChannel",
  "manageWorkspace",
]);
export const capabilityGroupGrantSchema = z.strictObject({
  group_id: uuid,
  capability: capabilitySchema,
});
const capabilityConfigurationFields = {
  group_grants: z.array(capabilityGroupGrantSchema),
  everyone: z.strictObject({
    react: z.boolean().optional(),
    reply: z.boolean().optional(),
    createThread: z.boolean().optional(),
    attachFiles: z.boolean().optional(),
    linkRecords: z.boolean().optional(),
  }),
};
const capabilityConfigurationBase = z.strictObject({
  scope: settingsScopeSchema,
  ...capabilityConfigurationFields,
});
function validCapabilityGrants(
  grants: z.output<typeof capabilityGroupGrantSchema>[],
  scope: z.output<typeof settingsScopeSchema>["kind"],
) {
  return (
    distinct(grants.map((grant) => `${grant.group_id}:${grant.capability}`)) &&
    grants.every((grant) =>
      capabilityGroupScopes[grant.capability].includes(scope),
    )
  );
}
export const capabilityConfigurationSchema = capabilityConfigurationBase.refine(
  (value) => validCapabilityGrants(value.group_grants, value.scope.kind),
  "Group grants must be distinct and legal at this scope",
);
const channelTemplateCapabilitiesSchema = z
  .strictObject(capabilityConfigurationFields)
  .refine(
    (value) => validCapabilityGrants(value.group_grants, "channel"),
    "Templates contain only channel-scope capability grants",
  );
export const capabilityLocksSchema = z.strictObject({
  capabilities: z.array(lockableCapabilitySchema).refine(distinct),
});
const managerSourceSchema = z.enum([
  "creator",
  "membership_manager",
  "department_manager",
]);
export const capabilityDecisionSchema = z.strictObject({
  allowed: z.boolean(),
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("default"),
      basis: z.enum([
        "poster",
        "conversation_manager",
        "org_admin_or_department_manager",
        "org_admin",
      ]),
    }),
    z.strictObject({
      kind: z.literal("group_grant"),
      group_id: uuid,
      group_name: z.string().min(1),
      scope: settingsScopeSchema,
    }),
    z.strictObject({
      kind: z.literal("everyone"),
      scope: settingsScopeSchema,
      enabled: z.boolean(),
    }),
    z.strictObject({ kind: z.literal("workspace_lock"), enabled: z.boolean() }),
    z.strictObject({ kind: z.literal("manager"), reason: managerSourceSchema }),
    z.strictObject({
      kind: z.literal("department_manager"),
      department_id: uuid,
      category_id: uuid,
    }),
    z.strictObject({ kind: z.literal("admin") }),
    z.strictObject({ kind: z.literal("guest_cap") }),
    z.strictObject({
      kind: z.literal("access"),
      reason: z.enum(["no_read_access", "inactive_membership"]),
    }),
  ]),
});
export const conversationAccessSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("organization") }),
  z.strictObject({ kind: z.literal("department"), department_id: uuid }),
  z.strictObject({
    kind: z.literal("group"),
    group_id: uuid,
    group_name: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("membership") }),
  z.strictObject({ kind: z.literal("manager"), reason: managerSourceSchema }),
  z.strictObject({ kind: z.literal("admin") }),
  z.strictObject({ kind: z.literal("guest_cap") }),
  z.strictObject({
    kind: z.literal("none"),
    reason: z.enum(["no_access", "inactive_membership"]),
  }),
]);
const capabilityCheckBase = z.strictObject({
  org_id: uuid,
  user_id: uuid,
  conversation_id: uuid,
  category_id: uuid.nullable(),
  membership_role: z.enum(["admin", "member", "guest"]),
  conversation_level: z.enum(["none", "read", "post", "manage"]),
  manager_source: managerSourceSchema.nullable(),
  access_source: conversationAccessSourceSchema,
  capabilities: z.record(capabilitySchema, capabilityDecisionSchema),
});
function consistentConversationAccess(
  check: z.output<typeof capabilityCheckBase>,
) {
  const { membership_role, conversation_level, manager_source, access_source } =
    check;
  if (membership_role === "admin")
    return conversation_level === "manage" && access_source.kind === "admin";
  if (manager_source !== null)
    return (
      membership_role === "member" &&
      conversation_level === "manage" &&
      access_source.kind === "manager" &&
      access_source.reason === manager_source
    );
  switch (access_source.kind) {
    case "organization":
    case "department":
    case "group":
    case "membership":
      return (
        conversation_level === "read" ||
        (conversation_level === "post" && membership_role === "member")
      );
    case "none":
      return conversation_level === "none";
    case "guest_cap":
      return membership_role === "guest" && conversation_level === "read";
    default:
      return false;
  }
}
function consistentCapabilityCheck(
  check: z.output<typeof capabilityCheckBase>,
) {
  // Agreement among supplied fields only; live source lookup belongs to S04/S16.
  if (!consistentConversationAccess(check)) return false;
  const poster =
    check.conversation_level === "post" ||
    check.conversation_level === "manage";
  const inScope = (scope: z.output<typeof settingsScopeSchema>) =>
    scope.kind === "workspace" ||
    (scope.kind === "category"
      ? scope.id === check.category_id
      : scope.id === check.conversation_id);
  return capabilitySchema.options.every((capability) => {
    const { allowed, source } = check.capabilities[capability];
    if (check.membership_role === "guest")
      return (
        !allowed &&
        source.kind === "guest_cap" &&
        check.conversation_level !== "post" &&
        check.conversation_level !== "manage"
      );
    if (check.membership_role === "admin")
      return allowed && source.kind === "admin";
    const conversationCapability =
      conversationCapabilitySchema.safeParse(capability).success;
    if (
      conversationCapability &&
      check.conversation_level === "none" &&
      allowed
    )
      return false;
    if (check.manager_source !== null && conversationCapability)
      return (
        allowed &&
        source.kind === "manager" &&
        source.reason === check.manager_source
      );
    switch (source.kind) {
      case "default":
        return (
          source.basis === capabilityDefaults[capability] &&
          allowed === (source.basis === "poster" && poster)
        );
      case "group_grant":
        return (
          allowed &&
          inScope(source.scope) &&
          capabilityGroupScopes[capability].includes(source.scope.kind)
        );
      case "everyone":
        return (
          everyoneCapabilitySchema.safeParse(capability).success &&
          inScope(source.scope) &&
          allowed ===
            (source.enabled &&
              (check.conversation_level === "post" ||
                check.conversation_level === "manage"))
        );
      case "workspace_lock":
        return (
          lockableCapabilitySchema.safeParse(capability).success &&
          allowed === source.enabled &&
          (!source.enabled ||
            (capabilityDefaults[capability] === "poster" && poster) ||
            capabilityGroupScopes[capability].includes("workspace"))
        );
      case "department_manager":
        return (
          allowed &&
          capability === "createChannel" &&
          source.category_id === check.category_id
        );
      case "access":
        return (
          !allowed &&
          check.conversation_level === "none" &&
          (source.reason === "no_read_access" ||
            (check.access_source.kind === "none" &&
              check.access_source.reason === "inactive_membership"))
        );
      default:
        return false;
    }
  });
}
export const capabilityCheckSchema = capabilityCheckBase.refine(
  consistentCapabilityCheck,
  "Capability decisions must agree with their deciding sources and immutable role caps",
);
export function capabilityCheckSchemaFor(
  context: z.output<typeof commsContextSchema>,
  conversationId: string,
  userId: string,
) {
  commsContextSchema.parse(context);
  uuid.parse(conversationId);
  uuid.parse(userId);
  return capabilityCheckSchema.refine(
    (check) =>
      check.org_id === context.org_id &&
      check.conversation_id === conversationId &&
      check.user_id === userId,
    "Access check must match the bound organization, conversation and inspected person",
  );
}

export const channelCreationScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("workspace") }),
  z.strictObject({ kind: z.literal("category"), id: uuid }),
]);
export const channelCreationCheckSchema = z
  .strictObject({
    org_id: uuid,
    user_id: uuid,
    scope: channelCreationScopeSchema,
    membership_role: z.enum(["admin", "member", "guest"]),
    decision: capabilityDecisionSchema,
  })
  .refine((check) => {
    const { allowed, source } = check.decision;
    if (check.membership_role === "guest")
      return !allowed && source.kind === "guest_cap";
    if (check.membership_role === "admin")
      return allowed && source.kind === "admin";
    switch (source.kind) {
      case "default":
        return !allowed && source.basis === "org_admin_or_department_manager";
      case "group_grant":
        return (
          allowed &&
          (source.scope.kind === "workspace" ||
            (source.scope.kind === "category" &&
              sameSettingsScope(source.scope, check.scope)))
        );
      case "department_manager":
        return (
          allowed &&
          check.scope.kind === "category" &&
          source.category_id === check.scope.id
        );
      case "workspace_lock":
        return allowed === source.enabled;
      default:
        return false;
    }
  }, "Channel creation requires an organization or target-category source, never a conversation-manager role");
export function channelCreationCheckSchemaFor(
  context: z.output<typeof commsContextSchema>,
  scope: z.output<typeof channelCreationScopeSchema>,
) {
  commsContextSchema.parse(context);
  channelCreationScopeSchema.parse(scope);
  return channelCreationCheckSchema.refine(
    (check) =>
      check.org_id === context.org_id &&
      check.user_id === context.user_id &&
      sameSettingsScope(check.scope, scope),
    "Creation check must match the bound organization, actor and target scope",
  );
}

const clockTime = z.union([
  z.literal(""),
  z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
]);
const notificationFields = {
  notification_mode: z.enum(["all", "mentions", "none"]),
  keywords: z.array(z.string().trim().min(1)),
  notify_followed_threads: z.boolean(),
  quiet_hours_start: clockTime,
  quiet_hours_end: clockTime,
  notification_sound: z.boolean(),
  notification_badges: z.boolean(),
  notification_preview: z.boolean(),
  desktop_notifications: z.boolean(),
};
// Settings only: no capability names/defaults or role/person grant vocabulary.
// Manager assignments are membership, retention has a fresh-admin preview flow.
export const settingsSchema = z.strictObject({
  mode: z.enum(["normal", "announcements", "thread-first"]),
  edit_window_minutes: watermark,
  delete_window_minutes: watermark,
  slow_mode_seconds: watermark,
  formatting: z.boolean(),
  link_previews: z.boolean(),
  allowed_reactions: z.array(z.string().min(1)).refine(distinct),
  mention_limit: watermark,
  auto_archive_days: watermark,
  default_thread_subscription: z.boolean(),
  thread_branches: z.enum(["all", "followed", "none"]),
  join_rule: z.enum(["open", "request", "invite"]),
  default_member_ids: ids,
  ...notificationFields,
  allowed_file_types: z
    .array(z.enum(["pdf", "png", "jpg", "jpeg", "docx", "xlsx", "pptx"]))
    .refine(distinct),
  max_file_size_mb: z.number().min(0).max(10),
  file_previews: z.boolean(),
  file_downloads: z.boolean(),
  allowed_record_modules: ids,
  require_record_link: z.boolean(),
  record_card_fields: ids,
  locked: z.boolean(),
  restricted_person_ids: ids,
  restriction_until: dateTime.nullable(),
  allow_export: z.boolean(),
  pinned_record_id: uuid.nullable(),
});
export const settingsPatchSchema = settingsSchema
  .partial()
  .refine(nonemptyPatch)
  .refine(pairedQuietHours, "Set or clear both quiet-hour endpoints");
export const settingKeySchema = settingsSchema.keyof();
export const settingSourceSchema = z.union([
  z.strictObject({ kind: z.literal("default") }),
  settingsScopeSchema,
]);
export const directPolicySchema = z.strictObject({
  dm_rule: z.enum(["everyone", "shared-channel", "none"]),
});
export const settingMetadataSchema = z.strictObject({
  key: settingKeySchema,
  tier: z.enum(["common", "advanced"]),
  section: z.enum([
    "overview",
    "messaging",
    "threads",
    "members",
    "notifications",
    "files",
    "history",
  ]),
});
const settingsResponseFields = {
  org_id: uuid,
  overrides: settingsSchema.partial(),
  effective: settingsSchema,
  locked_keys: z.array(settingKeySchema),
  sources: z.record(settingKeySchema, settingSourceSchema),
  metadata: z.array(settingMetadataSchema),
};
export const settingsResponseSchema = z.union([
  z.strictObject({
    ...settingsResponseFields,
    scope: z.strictObject({ kind: z.literal("workspace") }),
    ...directPolicySchema.shape,
  }),
  z.strictObject({
    ...settingsResponseFields,
    scope: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("category"), id: uuid }),
      z.strictObject({ kind: z.literal("channel"), id: uuid }),
    ]),
  }),
]);
export const settingsResetSchema = z.strictObject({
  keys: z.array(settingKeySchema).min(1).refine(distinct),
});
export const settingsLocksSchema = z.strictObject({
  keys: z.array(settingKeySchema).refine(distinct),
});
export const personalPreferencesSchema = z.strictObject({
  density: z.enum(["comfortable", "compact"]),
  text_size: z.enum(["small", "medium", "large"]),
  timestamps: z.enum(["time", "full", "none"]),
  group_messages: z.boolean(),
  avatars: z.boolean(),
  previews: z.boolean(),
  send_shortcut: z.enum(["enter", "ctrl-enter"]),
  shortcuts: z.strictObject({ search: z.string(), new_message: z.string() }),
  channel_width: z.number().int().positive(),
  member_width: z.number().int().positive(),
  thread_width: z.number().int().positive(),
  notifications: z.strictObject(notificationFields).partial(),
});
export const personalPreferencesRequestSchema =
  personalPreferencesSchema.refine(
    ({ notifications }) => pairedQuietHours(notifications),
    "Set or clear both quiet-hour endpoints",
  );

export const editMessageRequestSchema = z.strictObject({
  body,
  mention_user_ids: ids,
  mentions_channel: z.boolean(),
  mentions_here: z.boolean(),
});
export const threadPatchSchema = z.strictObject({
  name: z.string().optional(),
  resolved: z.boolean().optional(),
  locked: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export const reactionRequestSchema = z.strictObject({
  emoji: z.string().min(1),
});
export const messageRevisionSchema = z.strictObject({
  id: uuid,
  message_id: uuid,
  author_id: uuid,
  created_at: dateTime,
  body,
});
export const reportRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(2_000),
});
export const reportSchema = z.strictObject({
  ...resourceIdentity,
  conversation_id: uuid,
  message_id: uuid,
  reporter_id: uuid,
  reason: z.string(),
  status: z.enum(["open", "resolved"]),
});
export const restrictionRequestSchema = z.strictObject({
  user_ids: ids,
  until: dateTime.nullable(),
});

export const scheduleRequestSchema = z
  .strictObject({
    conversation_id: uuid,
    ...sendFields,
    send_at: dateTime,
    parent_id: uuid.nullable().default(null),
    also_send_to_channel: z.boolean().default(false),
  })
  .refine(hasContent, "Message is empty");
export const scheduleSchema = z.strictObject({
  ...resourceIdentity,
  author_id: uuid,
  request: scheduleRequestSchema,
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
  message_id: uuid.nullable(),
  failure_code: z
    .enum(["access_lost", "post_denied", "invalid_content", "unavailable"])
    .nullable(),
});
const dateRange = {
  after: z.iso.date().optional(),
  before: z.iso.date().optional(),
};
const orderedDates = (value: { after?: string; before?: string }) =>
  !value.after || !value.before || value.after < value.before;
export const exportRequestSchema = z
  .strictObject({
    conversation_ids: ids.min(1),
    format: z.enum(["csv", "xlsx"]),
    ...dateRange,
    reason: z.string().trim().min(1).max(2_000).optional(),
  })
  .refine(orderedDates, "after must precede before");
export const exportJobSchema = z.strictObject({
  ...resourceIdentity,
  requested_by: uuid,
  request: exportRequestSchema,
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
  failure_code: z.enum(["access_lost", "unavailable"]).nullable(),
});
export const searchRequestSchema = z
  .strictObject({
    ...listFields,
    sort_by: z.enum(["created_at", "relevance"]).default("relevance"),
    q: z.string().trim().max(4_000).default(""),
    from: uuid.optional(),
    in: uuid.optional(),
    ...dateRange,
    on: z.iso.date().optional(),
    has: z.enum(["file", "link", "record"]).optional(),
    is: z.enum(["pinned", "thread"]).optional(),
  })
  .refine(orderedDates, "after must precede before");
export const searchHitSchema = z.strictObject({
  message_id: uuid,
  conversation_id: uuid,
  conversation_name: z.string(),
  seq: sequence,
  author_id: uuid,
  author_name: z.string(),
  created_at: dateTime,
  excerpt: z.string(),
  matches: z.array(z.strictObject({ start: watermark, end: watermark })),
  parent_id: uuid.nullable(),
});
const workspaceRetentionPolicySchema = z.strictObject({
  scope: z.strictObject({ kind: z.literal("workspace") }),
  message_days: watermark,
  file_days: watermark,
});
const channelRetentionPolicySchema = z.strictObject({
  scope: z.strictObject({ kind: z.literal("channel"), id: uuid }),
  message_days: watermark.nullable(),
  file_days: watermark.nullable(),
});
export const retentionPolicySchema = z.union([
  workspaceRetentionPolicySchema,
  channelRetentionPolicySchema,
]);
const retentionPreviewBinding = {
  preview_digest: z.string().regex(/^[a-f0-9]{64}$/),
};
export const retentionRequestSchema = z.union([
  workspaceRetentionPolicySchema.extend(retentionPreviewBinding),
  channelRetentionPolicySchema.extend(retentionPreviewBinding),
]);
const retentionResponseBase = z.strictObject({
  policy: retentionPolicySchema,
  effective: z.strictObject({ message_days: watermark, file_days: watermark }),
  sources: z.strictObject({
    message_days: z.enum(["workspace", "channel"]),
    file_days: z.enum(["workspace", "channel"]),
  }),
});
function retentionResolutionMatchesPolicy({
  policy,
  effective,
  sources,
}: z.output<typeof retentionResponseBase>) {
  const matches = (key: "message_days" | "file_days") =>
    policy[key] === null
      ? sources[key] === "workspace"
      : effective[key] === policy[key] && sources[key] === policy.scope.kind;
  return matches("message_days") && matches("file_days");
}
export const retentionResponseSchema = retentionResponseBase.refine(
  retentionResolutionMatchesPolicy,
  "Effective periods and sources must match the retention policy",
);
export const retentionPreviewSchema = retentionResponseBase
  .extend({
    message_count: watermark,
    file_count: watermark,
    ...retentionPreviewBinding,
    expires_at: dateTime,
  })
  .refine(
    retentionResolutionMatchesPolicy,
    "Effective periods and sources must match the retention policy",
  );
export const templateImportSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(255),
    description: z.string(),
    settings: settingsSchema.partial(),
    capabilities: channelTemplateCapabilitiesSchema.optional(),
  })
  .refine(
    ({ settings }) => pairedQuietHours(settings),
    "Set or clear both quiet-hour endpoints",
  )
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 64 * 1024,
    "Template exceeds 64 KiB",
  );
export const templateSchema = z.strictObject({
  ...resourceIdentity,
  ...templateImportSchema.shape,
});
export const templateApplyRequestSchema = z
  .strictObject({
    conversation_ids: ids.min(1),
    keys: z.array(settingKeySchema).refine(distinct),
    capability_keys: z
      .array(conversationCapabilitySchema)
      .refine(distinct)
      .optional(),
  })
  .refine(
    (request) =>
      request.keys.length > 0 || (request.capability_keys?.length ?? 0) > 0,
    "Choose settings or capabilities to apply",
  );
export const templateApplyResultSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      conversation_id: uuid,
      applied_keys: z.array(settingKeySchema),
      skipped_locked_keys: z.array(settingKeySchema),
      applied_capabilities: z.array(conversationCapabilitySchema).optional(),
      skipped_locked_capabilities: z
        .array(conversationCapabilitySchema)
        .optional(),
    }),
  ),
});
export const templateApplyPreviewSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      conversation_id: uuid,
      before: settingsSchema.partial(),
      after: settingsSchema.partial(),
      skipped_locked_keys: z.array(settingKeySchema),
      capabilities: z
        .strictObject({
          before: channelTemplateCapabilitiesSchema,
          after: channelTemplateCapabilitiesSchema,
          skipped_locked: z.array(conversationCapabilitySchema),
        })
        .optional(),
    }),
  ),
});
export const joinRequestSubmissionSchema = z.strictObject({
  conversation_id: uuid,
});
export const invitationRequestSchema = z.strictObject({ user_id: uuid });
export const admissionDecisionRequestSchema = z.strictObject({
  decision: z.enum(["accept", "decline"]),
});
export const admissionSchema = z
  .strictObject({
    ...resourceIdentity,
    conversation_id: uuid,
    user_id: uuid,
    kind: z.enum(["request", "invitation"]),
    status: z.enum(["pending", "accepted", "declined"]),
    resolved_at: dateTime.nullable(),
  })
  .refine(
    (value) => (value.status === "pending") === (value.resolved_at === null),
    "Only resolved admissions have a resolution time",
  );
export const memberRoleRequestSchema = z.strictObject({
  role: z.enum(["member", "manager"]),
});
export const duplicateChannelRequestSchema = z.strictObject({
  name: z.string().trim().min(1),
  category_id: uuid.nullable(),
});
export const configurationSnapshotSchema = z
  .strictObject({
    settings: settingsSchema.partial(),
    capabilities: capabilityConfigurationSchema,
    dm_rule: directPolicySchema.shape.dm_rule.optional(),
    setting_locks: z.array(settingKeySchema).refine(distinct).optional(),
    capability_locks: z
      .array(lockableCapabilitySchema)
      .refine(distinct)
      .optional(),
  })
  .refine(
    (snapshot) =>
      snapshot.capabilities.scope.kind === "workspace" ||
      (snapshot.setting_locks === undefined &&
        snapshot.capability_locks === undefined &&
        snapshot.dm_rule === undefined),
    "Only workspace history may carry locks or direct-message policy",
  );
function sameSettingsScope(
  left: z.output<typeof settingsScopeSchema>,
  right: z.output<typeof settingsScopeSchema>,
) {
  return (
    left.kind === right.kind &&
    (left.kind === "workspace" ||
      (right.kind !== "workspace" && left.id === right.id))
  );
}
const historyScopeMatches = (value: {
  scope: z.output<typeof settingsScopeSchema>;
  before: z.output<typeof configurationSnapshotSchema>;
  after: z.output<typeof configurationSnapshotSchema>;
}) =>
  sameSettingsScope(value.scope, value.before.capabilities.scope) &&
  sameSettingsScope(value.scope, value.after.capabilities.scope);
export const configurationHistorySchema = z
  .strictObject({
    ...resourceIdentity,
    actor_id: uuid,
    scope: settingsScopeSchema,
    before: configurationSnapshotSchema,
    after: configurationSnapshotSchema,
  })
  .refine(
    historyScopeMatches,
    "History snapshots must belong to the named scope",
  );
export const configurationRestoreRequestSchema = z.strictObject({
  history_id: uuid,
  preview_digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const configurationRestorePreviewSchema = z
  .strictObject({
    org_id: uuid,
    history_id: uuid,
    scope: settingsScopeSchema,
    before: configurationSnapshotSchema,
    after: configurationSnapshotSchema,
    preview_digest: z.string().regex(/^[a-f0-9]{64}$/),
    expires_at: dateTime,
  })
  .refine(
    historyScopeMatches,
    "Restore preview must belong to the named scope",
  );

// Normalized local connection state, never provider credentials or wire events.
export const connectionStateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("connecting") }),
  z.strictObject({ state: z.literal("live") }),
  z.strictObject({
    state: z.literal("reconnecting"),
    retry_after_seconds: watermark,
  }),
  z.strictObject({ state: z.literal("offline") }),
  z.strictObject({
    state: z.literal("paused"),
    reason: z.enum(["limit", "authentication"]),
  }),
]);

export const categoryRequestSchema = categorySchema.omit({
  id: true,
  org_id: true,
  created_at: true,
  updated_at: true,
});
const channelRequestFields = {
  name: channelFields.name,
  topic: channelFields.topic,
  category_id: channelFields.category_id,
  position: channelFields.position,
};
export const channelRequestSchema = z.discriminatedUnion("scope", [
  z.strictObject({ ...channelRequestFields, scope: z.literal("organization") }),
  z.strictObject({
    ...channelRequestFields,
    scope: z.literal("department"),
    department_id: uuid,
  }),
  z.strictObject({
    ...channelRequestFields,
    scope: z.literal("groups"),
    access: z.array(groupAccessSchema),
  }),
  z.strictObject({
    ...channelRequestFields,
    scope: z.literal("members"),
    member_ids: ids,
  }),
]);
export const channelPatchSchema = z
  .strictObject(channelRequestFields)
  .partial();
export const accessRequestSchema = z.strictObject({
  access: z.array(groupAccessSchema),
});
export const followRequestSchema = z.strictObject({ followed: z.boolean() });
export const pinRequestSchema = z.strictObject({ pinned: z.boolean() });
export const directBlockSchema = z.strictObject({
  blocked_user_id: uuid,
  created_at: dateTime,
});
export const blockRequestSchema = z.strictObject({ blocked_user_id: uuid });
export const notificationSchema = z.strictObject({
  id: uuid,
  org_id: uuid,
  subject_type: z.literal("comms_message"),
  subject_id: uuid,
  kind: z.enum([
    "comms-mention",
    "comms-direct",
    "comms-thread-reply",
    "comms-keyword",
  ]),
  conversation_id: uuid,
  message_id: uuid,
  status: z.enum(["read", "unread"]),
  scheduled_for: z.null(),
  created_at: dateTime,
  read_at: dateTime.nullable(),
});

// Count/max-seq projection replaces the unbounded lifecycle row list (S22).
// The challenge and confirmation safeguards are retained, not implemented here.
export const purgePreviewSchema = z.strictObject({
  org_id: uuid,
  conversation_id: uuid,
  message_count: watermark,
  file_count: watermark,
  max_seq: watermark,
  impact_digest: z.string().regex(/^[a-f0-9]{64}$/),
  token: z.string().min(1).max(128),
  expires_at: dateTime,
  confirmation_name: z.string().min(1),
  last_successful_backup_at: dateTime.nullable(),
});
export const purgeRequestSchema = z.strictObject({
  token: z.string().min(1).max(128),
  confirmation_name: z.string().min(1),
  password: z.string().min(1).max(256),
});
export const purgeResultSchema = z.strictObject({
  org_id: uuid,
  conversation_id: uuid,
  operation_id: uuid,
  purged_message_count: watermark,
  purged_file_count: watermark,
});

export const conversationPageSchema = pageSchema(conversationSchema);
export const categoryPageSchema = pageSchema(categorySchema);
export const memberPageSchema = pageSchema(memberSchema);
export const messagePageSchema = pageSchema(messageSchema);
export const threadPageSchema = pageSchema(threadSchema);
export const revisionPageSchema = pageSchema(messageRevisionSchema);
export const filePageSchema = pageSchema(fileSchema);
export const reportPageSchema = pageSchema(reportSchema);
export const removedMessagePageSchema = pageSchema(tombstoneSchema);
export const schedulePageSchema = pageSchema(scheduleSchema);
export const exportPageSchema = pageSchema(exportJobSchema);
export const searchPageSchema = pageSchema(searchHitSchema);
export const templatePageSchema = pageSchema(templateSchema);
export const directBlockPageSchema = pageSchema(directBlockSchema);
export const notificationPageSchema = pageSchema(notificationSchema);
export const recordReferencePageSchema = pageSchema(recordReferenceSchema);
export const admissionPageSchema = pageSchema(admissionSchema);
export const configurationHistoryPageSchema = pageSchema(
  configurationHistorySchema,
);
