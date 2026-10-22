import { commsContextSchema } from "@/components/systems/comms/contract/schemas";
import type { CommsContext } from "@/components/systems/comms/contract/types";
import type {
  MemoryCommsState,
  MemoryConversation,
  MemoryMessage,
  MemoryPerson,
  MemoryPolicyWorld,
} from "./model";
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
  };
  // A category bound to a department holds only that department's channels
  // (D44 A8); every seeded person has a role in it.
  const channel = {
    ...identity(),
    kind: "channel" as const,
    scope: "department" as const,
    department_id: department.id,
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
    // Channel rows are a manager roster: only the creator's row exists.
    members: {
      [channel.id]: {
        [channel.creator_id]: {
          user_id: channel.creator_id,
          member_role: "member",
          joined_at: created_at,
        },
      },
    },
    configuration: {},
    setting_locks: [],
    capability_locks: [],
    dm_rule: "everyone",
    blocks: {},
    access_grants: {},
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

/** A channel row as an organization channel: everyone posts, guests read (D44). */
export function organizationChannel(
  room: MemoryConversation,
): Extract<MemoryConversation, { scope: "organization" }> {
  if (room.kind !== "channel") throw new Error("Only a channel has a scope");
  return {
    id: room.id,
    org_id: room.org_id,
    created_at: room.created_at,
    updated_at: room.updated_at,
    archived_at: room.archived_at,
    creator_id: room.creator_id,
    kind: "channel",
    scope: "organization",
    name: room.name,
    topic: room.topic,
    category_id: room.category_id,
    position: room.position,
  };
}

/**
 * Moves a channel into a new department nobody holds a role in, so only
 * admins and its managers still read it. It replaces the retired empty
 * group-access and private-channel scopes as the way to hide a channel.
 */
export function hideInNewDepartment(
  world: MemoryPolicyWorld,
  channelId: string,
  departmentId: string,
) {
  const room = organizationChannel(world.conversations[channelId]);
  world.departments[departmentId] = {
    id: departmentId,
    org_id: world.org_id,
    name: "Records desk",
  };
  world.conversations[channelId] = {
    ...room,
    category_id: null,
    scope: "department",
    department_id: departmentId,
  };
}
