import { z } from "zod";
import * as S from "@/components/systems/comms/contract/schemas";
import type { MemoryCommsState } from "./model";

// Canonical storage omits actor projections. Never cast an external wire object
// to the internal model, or admit runtime bytes/proofs through a catch-all field.
const uuid = z.uuid();
const counter = z.number().int().nonnegative();
const ids = z
  .array(uuid)
  .refine((values) => new Set(values).size === values.length);
const group = z.strictObject({ id: uuid, org_id: uuid, name: z.string() });
const person = z.strictObject({
  user_id: uuid,
  org_id: uuid,
  display_name: z.string(),
  role: z.enum(["admin", "member", "guest"]),
  active: z.boolean(),
  group_ids: ids,
  department_levels: z.record(uuid, z.enum(["read", "write", "manage"])),
  readable_module_ids: ids,
});
const projections = {
  level: true,
  member_count: true,
  member_role: true,
} as const;
const creator = { creator_id: uuid };
const [organization, department] = S.channelSchema.options;
const conversation = z.union([
  organization.omit(projections).extend(creator),
  department.omit(projections).extend(creator),
  S.directSchema
    .omit({ ...projections, participant_ids: true })
    .extend(creator),
  S.groupSchema.omit({ ...projections, participant_ids: true }).extend(creator),
]);
const message = S.liveMessageSchema
  .omit({
    thread: true,
    attachments: true,
    record_references: true,
  })
  .extend({
    attachment_ids: ids.max(10),
    record_links: z.array(z.strictObject({ id: uuid, record_id: uuid })),
    deleted_at: z.iso.datetime({ offset: true }).nullable(),
  });
const thread = S.threadSchema
  .omit({
    followed: true,
    reply_count: true,
    last_reply_at: true,
  })
  .extend({ starter_id: uuid });
const user = z.strictObject({
  personal: S.personalPreferencesSchema,
  conversations: z.record(uuid, S.memberPreferencesSchema),
  categories: z.record(uuid, S.categoryPreferencesSchema),
  last_read_seq: z.record(uuid, counter),
  followed_thread_ids: ids,
  notifications: z.array(S.notificationSchema),
});

export const memoryStateSchema = z.strictObject({
  version: z.literal(1),
  org_id: uuid,
  people: z.record(uuid, person),
  groups: z.record(uuid, group),
  departments: z.record(uuid, group),
  modules: z.record(uuid, group),
  fields: z.record(
    uuid,
    z.strictObject({ id: uuid, org_id: uuid, module_id: uuid }),
  ),
  records: z.record(
    uuid,
    z.strictObject({
      id: uuid,
      org_id: uuid,
      module_id: uuid,
      title: z.string(),
      fields: S.recordReferenceSchema.options[1].shape.fields,
    }),
  ),
  categories: z.record(uuid, S.categorySchema),
  conversations: z.record(uuid, conversation),
  members: z.record(
    uuid,
    z.record(
      uuid,
      S.memberSchema.pick({
        user_id: true,
        member_role: true,
        joined_at: true,
      }),
    ),
  ),
  configuration: z.record(
    z.string(),
    z.strictObject({
      settings: S.settingsSchema.partial(),
      capabilities: S.capabilityConfigurationSchema,
    }),
  ),
  setting_locks: S.settingsLocksSchema.shape.keys,
  capability_locks: S.capabilityLocksSchema.shape.capabilities,
  dm_rule: S.directPolicySchema.shape.dm_rule,
  blocks: z.record(uuid, z.array(S.directBlockSchema)),
  messages: z.record(uuid, message),
  threads: z.record(uuid, thread),
  revisions: z.record(uuid, z.array(S.messageRevisionSchema)),
  files: z.record(uuid, S.fileSchema),
  users: z.record(uuid, user),
  high_water_seq: z.record(uuid, counter),
  resource_versions: z.record(z.string(), counter),
  idempotency: z.record(
    z.string(),
    z.strictObject({ payload: z.string(), message_id: uuid }),
  ),
  reports: z.record(uuid, S.reportSchema),
  schedules: z.record(uuid, S.scheduleSchema),
  exports: z.record(uuid, S.exportJobSchema),
  templates: z.record(uuid, S.templateSchema),
  history: z.record(uuid, S.configurationHistorySchema),
  retention: z.record(z.string(), S.retentionPolicySchema),
}) satisfies z.ZodType<MemoryCommsState>;

export const memorySnapshotSchema = z.strictObject({
  format: z.literal(1),
  owner: S.commsContextSchema,
  state: memoryStateSchema,
});
