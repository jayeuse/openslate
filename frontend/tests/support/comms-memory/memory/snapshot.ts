import { z } from "zod";
import { commsContextSchema } from "@/components/systems/comms/contract/schemas";
import type {
  CommsContext,
  GroupAccess,
  Settings,
  SettingsScope,
} from "@/components/systems/comms/contract/types";
import type { MemoryCommsState } from "./model";
import { scopeKey } from "../domain/policy-scope";
import type { MemoryRestoration } from "./store-types";
import { memorySnapshotSchema, memoryStateSchema } from "./snapshot-schema";

export function invalidMemoryState(): never {
  throw Object.assign(new Error("Invalid OpenComms state"), {
    kind: "invalid_response" as const,
  });
}
function ensure(condition: unknown): asserts condition {
  if (!condition) invalidMemoryState();
}

/** Referential integrity, not authorization: inactive historical actors are legal. */
function validateRelationships(state: MemoryCommsState) {
  const { people, conversations, messages } = state;
  const person = (id: string) => ensure(Object.hasOwn(people, id));
  const conversation = (id: string) => ensure(Object.hasOwn(conversations, id));
  const groupAccess = (rows: GroupAccess[]) => {
    for (const row of rows)
      if (row.subject === "group") ensure(state.groups[row.group_id]);
  };
  function entityMap(rows: Record<string, { id: string; org_id: string }>) {
    for (const [key, row] of Object.entries(rows))
      ensure(row.id === key && row.org_id === state.org_id);
  }
  for (const rows of [
    state.groups,
    state.departments,
    state.modules,
    state.fields,
    state.records,
    state.categories,
    conversations,
    messages,
    state.threads,
    state.files,
    state.reports,
    state.admissions,
    state.schedules,
    state.exports,
    state.templates,
    state.history,
  ])
    entityMap(rows);
  for (const [id, row] of Object.entries(people)) {
    ensure(row.user_id === id && row.org_id === state.org_id);
    for (const group of row.group_ids) ensure(state.groups[group]);
    for (const department of Object.keys(row.department_levels))
      ensure(state.departments[department]);
    for (const moduleId of row.readable_module_ids)
      ensure(state.modules[moduleId]);
  }
  for (const field of Object.values(state.fields))
    ensure(state.modules[field.module_id]);
  for (const record of Object.values(state.records)) {
    ensure(state.modules[record.module_id]);
    ensure(
      new Set(record.fields.map((field) => field.field_id)).size ===
        record.fields.length,
    );
    for (const field of record.fields)
      ensure(state.fields[field.field_id]?.module_id === record.module_id);
  }
  for (const category of Object.values(state.categories)) {
    if (category.department_id !== null)
      ensure(state.departments[category.department_id]);
    groupAccess(category.default_access);
  }
  for (const row of Object.values(conversations)) {
    person(row.creator_id);
    const membership = state.members[row.id];
    ensure(membership && Object.hasOwn(state.high_water_seq, row.id));
    const size = Object.keys(membership).length;
    if (row.kind === "direct") ensure(size === 2);
    else if (row.kind === "group") ensure(size >= 3 && size <= 50);
    else {
      if (row.category_id !== null) ensure(state.categories[row.category_id]);
      if (row.scope === "department")
        ensure(state.departments[row.department_id]);
      if (row.scope === "groups") groupAccess(row.access);
    }
  }
  for (const [conversationId, members] of Object.entries(state.members)) {
    conversation(conversationId);
    for (const [id, row] of Object.entries(members)) {
      person(id);
      ensure(id === row.user_id);
    }
  }
  for (const id of Object.keys(state.high_water_seq)) conversation(id);
  function scope(scope: SettingsScope) {
    if (scope.kind === "category") ensure(state.categories[scope.id]);
    if (scope.kind === "channel")
      ensure(conversations[scope.id]?.kind === "channel");
  }
  function settingsReferences(settings: Partial<Settings>) {
    for (const id of [
      ...(settings.default_member_ids ?? []),
      ...(settings.restricted_person_ids ?? []),
    ])
      person(id);
    for (const id of settings.allowed_record_modules ?? [])
      ensure(state.modules[id]);
    for (const id of settings.record_card_fields ?? [])
      ensure(state.fields[id]);
    if (settings.pinned_record_id != null)
      ensure(state.records[settings.pinned_record_id]);
  }
  for (const [key, configuration] of Object.entries(state.configuration)) {
    ensure(configuration);
    scope(configuration.capabilities.scope);
    ensure(scopeKey(configuration.capabilities.scope) === key);
    settingsReferences(configuration.settings);
    for (const grant of configuration.capabilities.group_grants)
      ensure(state.groups[grant.group_id]);
  }
  for (const [key, retention] of Object.entries(state.retention)) {
    scope(retention.scope);
    ensure(scopeKey(retention.scope) === key);
  }
  for (const [userId, blocks] of Object.entries(state.blocks)) {
    person(userId);
    ensure(
      new Set(blocks.map((block) => block.blocked_user_id)).size ===
        blocks.length,
    );
    for (const block of blocks) {
      person(block.blocked_user_id);
      ensure(block.blocked_user_id !== userId);
    }
  }
  const sequences = new Set<string>();
  const clientKeys = new Set<string>();
  const linkIds = new Set<string>();
  for (const message of Object.values(messages)) {
    conversation(message.conversation_id);
    person(message.author_id);
    const sequence = `${message.conversation_id}:${message.seq}`;
    const clientKey = `${message.author_id}:${message.client_key}`;
    ensure(!sequences.has(sequence) && !clientKeys.has(clientKey));
    sequences.add(sequence);
    clientKeys.add(clientKey);
    ensure(message.seq <= state.high_water_seq[message.conversation_id]);
    if (message.parent_id !== null) {
      const parent = messages[message.parent_id];
      ensure(
        parent &&
          parent.parent_id === null &&
          parent.conversation_id === message.conversation_id &&
          parent.id !== message.id,
      );
    }
    if (message.reply_to_id !== null)
      ensure(
        messages[message.reply_to_id]?.conversation_id ===
          message.conversation_id && message.reply_to_id !== message.id,
      );
    for (const id of message.attachment_ids)
      ensure(state.files[id]?.conversation_id === message.conversation_id);
    const recordIds = new Set<string>();
    for (const link of message.record_links) {
      ensure(
        state.records[link.record_id]?.org_id === message.org_id &&
          !recordIds.has(link.record_id) &&
          !linkIds.has(link.id) &&
          !Object.hasOwn(state.records, link.id),
      );
      recordIds.add(link.record_id);
      linkIds.add(link.id);
    }
    for (const id of message.mention_user_ids) person(id);
    if (message.pinned_by !== null) person(message.pinned_by);
    for (const reaction of message.reactions)
      for (const id of reaction.user_ids) person(id);
  }
  const threadRoots = new Set<string>();
  for (const thread of Object.values(state.threads)) {
    const root = messages[thread.root_message_id];
    ensure(
      root &&
        root.parent_id === null &&
        root.conversation_id === thread.conversation_id &&
        root.author_id === thread.starter_id,
    );
    ensure(!threadRoots.has(root.id));
    threadRoots.add(root.id);
  }
  for (const message of Object.values(messages))
    if (message.parent_id !== null) ensure(threadRoots.has(message.parent_id));
  const revisionIds = new Set<string>();
  for (const [id, revisions] of Object.entries(state.revisions)) {
    ensure(messages[id]);
    for (const revision of revisions) {
      ensure(revision.message_id === id && !revisionIds.has(revision.id));
      revisionIds.add(revision.id);
      person(revision.author_id);
    }
  }
  for (const [key, entry] of Object.entries(state.idempotency)) {
    const message = messages[entry.message_id];
    ensure(
      message &&
        key === `${state.org_id}:${message.author_id}:${message.client_key}`,
    );
  }
  for (const file of Object.values(state.files)) {
    conversation(file.conversation_id);
    person(file.creator_id);
  }
  for (const [id, user] of Object.entries(state.users)) {
    person(id);
    for (const key of Object.keys(user.conversations)) conversation(key);
    for (const key of Object.keys(user.categories))
      ensure(state.categories[key]);
    for (const [key, read] of Object.entries(user.last_read_seq)) {
      conversation(key);
      ensure(read <= state.high_water_seq[key]);
    }
    for (const key of user.followed_thread_ids) ensure(state.threads[key]);
    const notificationIds = new Set<string>();
    for (const notification of user.notifications) {
      ensure(
        notification.org_id === state.org_id &&
          !notificationIds.has(notification.id),
      );
      notificationIds.add(notification.id);
      ensure(
        messages[notification.message_id]?.conversation_id ===
          notification.conversation_id &&
          notification.subject_id === notification.message_id,
      );
    }
  }
  for (const report of Object.values(state.reports)) {
    person(report.reporter_id);
    ensure(
      messages[report.message_id]?.conversation_id === report.conversation_id,
    );
  }
  for (const admission of Object.values(state.admissions)) {
    person(admission.user_id);
    ensure(conversations[admission.conversation_id]?.kind === "channel");
  }
  for (const schedule of Object.values(state.schedules)) {
    person(schedule.author_id);
    // Terminal jobs retain historical request UUIDs after content purge. They
    // cannot be re-admitted from a stored job; the family must recheck any retry.
    if (schedule.status !== "pending" && schedule.status !== "running")
      continue;
    const request = schedule.request;
    conversation(request.conversation_id);
    if (request.parent_id !== null) {
      const root = messages[request.parent_id];
      ensure(
        root &&
          root.parent_id === null &&
          root.conversation_id === request.conversation_id,
      );
    }
    if (request.reply_to_id !== null)
      ensure(
        messages[request.reply_to_id]?.conversation_id ===
          request.conversation_id,
      );
    for (const id of request.attachment_ids)
      ensure(state.files[id]?.conversation_id === request.conversation_id);
    for (const id of request.record_ids) ensure(state.records[id]);
    for (const id of request.mention_user_ids) person(id);
  }
  for (const job of Object.values(state.exports)) {
    person(job.requested_by);
    if (job.status === "pending" || job.status === "running")
      for (const id of job.request.conversation_ids) conversation(id);
  }
  for (const template of Object.values(state.templates)) {
    settingsReferences(template.settings);
    for (const grant of template.capabilities?.group_grants ?? [])
      ensure(state.groups[grant.group_id]);
  }
  for (const history of Object.values(state.history)) {
    person(history.actor_id);
    scope(history.scope);
    // Before/after are historical contracts, not current grants. Their strict
    // schemas enforce matching scopes without resurrecting removed group access.
  }
}

export function validateMemoryState(
  input: unknown,
  orgId: string,
): MemoryCommsState {
  const parsed = memoryStateSchema.safeParse(input);
  if (!parsed.success || parsed.data.org_id !== orgId)
    return invalidMemoryState();
  validateRelationships(parsed.data);
  return parsed.data;
}

/** Pure admission only. Browser storage, if any, belongs to the caller. */
export function restoreMemorySnapshot(
  owner: CommsContext,
  initial: MemoryCommsState,
  input: unknown,
): {
  state: MemoryCommsState;
  restoration: MemoryRestoration;
} {
  const fallback = (restoration: MemoryRestoration) => ({
    state: structuredClone(initial),
    restoration,
  });
  if (input === undefined) return fallback("empty");
  const identity = z.object({ owner: commsContextSchema }).safeParse(input);
  if (
    !identity.success ||
    identity.data.owner.org_id !== owner.org_id ||
    identity.data.owner.user_id !== owner.user_id
  )
    return fallback("refused_owner");
  const parsed = memorySnapshotSchema.safeParse(input);
  if (!parsed.success) return fallback("recovered");
  try {
    const admitted = initial.people[owner.user_id];
    const restored = parsed.data.state.people[owner.user_id];
    if (
      !restored ||
      restored.role !== admitted.role ||
      restored.active !== admitted.active
    )
      return fallback("recovered");
    return {
      state: validateMemoryState(parsed.data.state, owner.org_id),
      restoration: "restored",
    };
  } catch {
    return fallback("recovered");
  }
}
