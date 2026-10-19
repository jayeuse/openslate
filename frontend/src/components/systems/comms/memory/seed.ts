import { commsContextSchema } from "../contract/schemas";
import type { CommsContext } from "../contract/types";
import type { MemoryCommsState, MemoryMessage, MemoryPerson } from "./model";
import { DEFAULT_PERSONAL_PREFERENCES } from "../domain/settings";

/** Fixed fictional data, never a migration of unowned legacy snapshots. */
export function createMemorySeed(
  input: CommsContext,
  actor: Pick<MemoryPerson, "role" | "display_name">,
): MemoryCommsState {
  const context = commsContextSchema.parse(input);
  let next = 1;
  const id = () => {
    let value: string;
    do {
      value = `c0440000-0000-4000-8000-${(next++).toString(16).padStart(12, "0")}`;
    } while (value === context.user_id || value === context.org_id);
    return value;
  };
  const org_id = context.org_id;
  const created_at = "2026-09-11T01:00:00Z";
  const identity = () => ({
    id: id(),
    org_id,
    created_at,
    updated_at: created_at,
  });
  const department = { id: id(), org_id, name: "Operations" };
  const group = { id: id(), org_id, name: "Dispatch team" };
  const recordModule = { id: id(), org_id, name: "Service requests" };
  const field = { id: id(), org_id, module_id: recordModule.id };
  const person = (
    user_id: string,
    display_name: string,
    role: MemoryPerson["role"],
  ): MemoryPerson => ({
    user_id,
    org_id,
    display_name,
    role,
    active: true,
    group_ids: [group.id],
    department_levels: { [department.id]: "write" },
    readable_module_ids: [recordModule.id],
  });
  const people = [
    person(context.user_id, actor.display_name, actor.role),
    person(id(), "Noah Tan", "member"),
    person(id(), "Sofia Garcia", "member"),
    person(id(), "Mara Santos", "guest"),
  ];
  const category = {
    ...identity(),
    name: "Service delivery",
    position: 0,
    department_id: department.id,
    default_access: [
      { subject: "group" as const, group_id: group.id, level: "post" as const },
    ],
  };
  const channel = {
    ...identity(),
    kind: "channel" as const,
    scope: "organization" as const,
    name: "operations",
    topic: "Daily coordination, handovers, and field updates.",
    category_id: category.id,
    position: 0,
    archived_at: null,
    creator_id: people[1].user_id,
  };
  const record = {
    id: id(),
    org_id,
    module_id: recordModule.id,
    title: "Riverside service visit",
    fields: [
      { field_id: field.id, label: "Status", display_value: "In progress" },
    ],
  };
  const root: MemoryMessage = {
    id: id(),
    org_id,
    conversation_id: channel.id,
    seq: 1,
    author_id: people[1].user_id,
    client_key: id(),
    created_at,
    parent_id: null,
    reply_to_id: null,
    also_send_to_channel: false,
    state: "live",
    body: "Two vans are loaded. The spare tool kit is beside dispatch.",
    edited_at: null,
    pinned_at: null,
    pinned_by: null,
    attachment_ids: [],
    record_links: [],
    mention_user_ids: [],
    mentions_channel: false,
    mentions_here: false,
    reactions: [],
    link_previews: [],
    deleted_at: null,
  };
  const reply: MemoryMessage = {
    ...root,
    id: id(),
    seq: 2,
    client_key: id(),
    author_id: people[2].user_id,
    parent_id: root.id,
    body: "Thanks. I will confirm the next update with Riverside.",
    record_links: [],
  };
  const thread = {
    id: id(),
    org_id,
    conversation_id: channel.id,
    root_message_id: root.id,
    name: "Morning handover",
    resolved: false,
    locked: false,
    archived: false,
    starter_id: root.author_id,
  };
  // Allocate links after existing entities so their established IDs stay stable.
  root.record_links = [{ id: id(), record_id: record.id }];
  return {
    version: 1,
    org_id,
    people: Object.fromEntries(people.map((p) => [p.user_id, p])),
    groups: { [group.id]: group },
    departments: { [department.id]: department },
    modules: { [recordModule.id]: recordModule },
    fields: { [field.id]: field },
    records: { [record.id]: record },
    categories: { [category.id]: category },
    conversations: { [channel.id]: channel },
    members: {
      [channel.id]: Object.fromEntries(
        people.map((p) => [
          p.user_id,
          {
            user_id: p.user_id,
            member_role: "member",
            joined_at: created_at,
          },
        ]),
      ),
    },
    configuration: {},
    setting_locks: [],
    capability_locks: [],
    dm_rule: "everyone",
    blocks: {},
    messages: { [root.id]: root, [reply.id]: reply },
    threads: { [thread.id]: thread },
    revisions: {},
    files: {},
    users: Object.fromEntries(
      people.map((p) => [
        p.user_id,
        {
          personal: structuredClone(DEFAULT_PERSONAL_PREFERENCES),
          conversations: {},
          categories: {},
          last_read_seq: {},
          followed_thread_ids: [],
          notifications: [],
        },
      ]),
    ),
    high_water_seq: { [channel.id]: 2 },
    resource_versions: {},
    idempotency: {},
    reports: {},
    admissions: {},
    schedules: {},
    exports: {},
    templates: {},
    history: {},
    retention: {
      workspace: {
        scope: { kind: "workspace" },
        message_days: 0,
        file_days: 0,
      },
    },
  };
}
