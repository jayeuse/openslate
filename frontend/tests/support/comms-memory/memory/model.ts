import type * as C from "@/components/systems/comms/contract/types";

/** Synthetic Phase A authority only. Never hydrated from account names/roles. */
export interface MemoryPerson {
  user_id: string;
  org_id: string;
  display_name: string;
  role: "admin" | "member" | "guest";
  active: boolean;
  group_ids: string[];
  department_levels: Record<string, "read" | "write" | "manage">;
  readable_module_ids: string[];
}
export interface MemoryGroup {
  id: string;
  org_id: string;
  name: string;
}
export type MemoryDepartment = MemoryGroup;
type StoredConversation<T> = T extends C.Conversation
  ? Omit<T, "level" | "member_count" | "member_role" | "participant_ids"> & {
      creator_id: string;
    }
  : never;
export type MemoryConversation = StoredConversation<C.Conversation>;
export type MemoryMember = Pick<
  C.Member,
  "user_id" | "member_role" | "joined_at"
>;
export type MemoryScopeKey =
  "workspace" | `category:${string}` | `channel:${string}`;
export interface MemoryScopeState {
  settings: Partial<C.Settings>;
  capabilities: C.CapabilityConfiguration;
}
export interface MemoryRecord {
  id: string;
  org_id: string;
  module_id: string;
  title: string;
  fields: Extract<C.RecordReference, { state: "available" }>["fields"];
}
/**
 * D45: a grant on a channel or a category, keyed by `accessGrantKey`. It only
 * adds read or post; a category grant reaches the channels currently in it.
 */
export interface MemoryAccessGrant {
  org_id: string;
  target: C.AccessGrantTarget;
  subject: C.AccessGrantSubject;
  subject_id: string;
  level: C.AccessGrantLevel;
  created_at: string;
  updated_at: string;
}
export const accessGrantKey = (
  target: C.AccessGrantTarget,
  subject: C.AccessGrantSubject,
  subjectId: string,
) => `${target.kind}:${target.id}:${subject}:${subjectId}`;
/** Validated internal state, not a schema for accepting browser snapshots. */
export interface MemoryPolicyWorld {
  org_id: string;
  people: Record<string, MemoryPerson>;
  groups: Record<string, MemoryGroup>;
  departments: Record<string, MemoryDepartment>;
  modules: Record<string, MemoryGroup>;
  fields: Record<string, { id: string; org_id: string; module_id: string }>;
  records: Record<string, MemoryRecord>;
  categories: Record<string, C.Category>;
  conversations: Record<string, MemoryConversation>;
  members: Record<string, Record<string, MemoryMember>>;
  configuration: Partial<Record<MemoryScopeKey, MemoryScopeState>>;
  setting_locks: C.SettingKey[];
  capability_locks: C.CapabilityLocks["capabilities"];
  dm_rule: C.DirectPolicy["dm_rule"];
  blocks: Record<string, C.DirectBlock[]>;
  access_grants: Record<string, MemoryAccessGrant>;
}

/** Private canonical content. Deleted content is never a read projection. */
export type MemoryMessage = Omit<
  C.LiveMessage,
  "thread" | "attachments" | "record_references"
> & {
  attachment_ids: string[];
  record_links: { id: string; record_id: string }[];
  deleted_at: string | null;
};
export type MemoryThread = Omit<
  C.Thread,
  "followed" | "reply_count" | "last_reply_at"
> & {
  starter_id: string;
};
export interface MemoryUserState {
  personal: C.PersonalPreferences;
  conversations: Record<string, C.MemberPreferences>;
  categories: Record<string, C.CategoryPreferences>;
  last_read_seq: Record<string, number>;
  followed_thread_ids: string[];
  notifications: C.CommsNotification[];
}

/** Serializable organization state; bytes, observers, proofs and clocks stay outside. */
export interface MemoryCommsState extends MemoryPolicyWorld {
  version: 1;
  messages: Record<string, MemoryMessage>;
  threads: Record<string, MemoryThread>;
  revisions: Record<string, C.MessageRevision[]>;
  files: Record<string, C.CommsFile>;
  users: Record<string, MemoryUserState>;
  high_water_seq: Record<string, number>;
  resource_versions: Record<string, number>;
  idempotency: Record<string, { payload: string; message_id: string }>;
  reports: Record<string, C.Report>;
  schedules: Record<string, C.Schedule>;
  exports: Record<string, C.ExportJob>;
  templates: Record<string, C.Template>;
  history: Record<string, C.ConfigurationHistory>;
  retention: Record<string, C.RetentionPolicy>;
}
