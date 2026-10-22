import type { CommsClient } from "@/components/systems/comms/contract/client";
import * as S from "@/components/systems/comms/contract/schemas";
import type * as C from "@/components/systems/comms/contract/types";
import {
  activePerson,
  conversationAccess,
  notFound,
  ownedConversation,
  policyFailure,
} from "../domain/access";
import {
  capabilityCheck,
  channelCreationCheck,
  scopeManagementDecision,
} from "../domain/capabilities";
import { invalidInput, resolveSettings } from "../domain/settings";
import type { MemoryCommsState, MemoryPolicyWorld } from "./model";
import type { MemoryExecution } from "./store-types";
import {
  assertRequestActive,
  capabilityDenied,
  requireAvailable,
  type MemoryClientBinding,
} from "./availability";
import {
  configurationSnapshot,
  configurationVersionKeys,
  conversationVersionKeys,
  stageConfigurationChange,
  structurePublications,
} from "./configuration-mutation";

export const conversationKey = (id: string) => `conversation:${id}`;
export const categoryKey = (id: string) => `category:${id}`;

export function ownedCategory(
  world: MemoryPolicyWorld,
  context: C.CommsContext,
  id: string,
) {
  activePerson(world, context);
  const row = world.categories[id];
  if (!row || row.org_id !== context.org_id) return notFound();
  return row;
}

export function projectChannel(
  world: MemoryPolicyWorld,
  context: C.CommsContext,
  id: string,
): C.Channel {
  const row = projectConversation(world, context, id);
  if (row.kind !== "channel") return invalidInput();
  return row;
}

/** A person's current level in a conversation, or "none". */
function readerLevel(world: MemoryPolicyWorld, id: string, userId: string) {
  const person = world.people[userId];
  if (!person?.active || person.org_id !== world.org_id) return "none";
  return conversationAccess(
    world,
    { org_id: world.org_id, user_id: userId },
    id,
  ).level;
}

/**
 * A channel's members are its readers (D44): `member_role` is "manager"
 * exactly when the level is manage. Direct and group messages keep their rows.
 */
export function projectMember(
  world: MemoryPolicyWorld,
  id: string,
  userId: string,
): C.Member {
  const row = world.members[id]?.[userId];
  const person = world.people[userId];
  const conversation = world.conversations[id];
  const level = readerLevel(world, id, userId);
  if (
    !person?.active ||
    person.org_id !== world.org_id ||
    level === "none" ||
    (conversation.kind !== "channel" && !row)
  )
    return notFound();
  return {
    user_id: userId,
    display_name: person.display_name,
    member_role:
      conversation.kind === "channel"
        ? level === "manage"
          ? "manager"
          : "member"
        : row!.member_role,
    level,
    joined_at: row?.joined_at ?? conversation.created_at,
    departments: Object.keys(person.department_levels)
      .sort()
      .map((id) => ({ id, name: world.departments[id].name })),
  };
}

/** Everyone who can read the conversation: readers for a channel, rows otherwise. */
function memberIds(world: MemoryPolicyWorld, id: string) {
  return world.conversations[id].kind === "channel"
    ? Object.values(world.people)
        .filter((person) => readerLevel(world, id, person.user_id) !== "none")
        .map((person) => person.user_id)
    : Object.keys(world.members[id] ?? {}).filter(
        (userId) => world.people[userId]?.active,
      );
}

export function compare(left: string | number, right: string | number) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** D44 A8: a department's category holds only that department's channels. */
function requireCategoryFits(
  world: MemoryPolicyWorld,
  categoryId: string | null,
  departmentId: string | null,
) {
  if (!categoryId) return;
  if ((world.categories[categoryId]?.department_id ?? null) !== departmentId)
    policyFailure({
      status: 422,
      body: {
        detail: {
          code: "comms_invalid",
          message: "The channel does not match its category's department",
        },
      },
    });
}

function validateCategory(
  world: MemoryPolicyWorld,
  request: C.CategoryRequest,
) {
  if (
    request.department_id &&
    world.departments[request.department_id]?.org_id !== world.org_id
  )
    notFound();
}

function creationScope(categoryId: string | null): C.ChannelCreationScope {
  return categoryId
    ? { kind: "category", id: categoryId }
    : { kind: "workspace" };
}

function requireCreation(
  binding: MemoryClientBinding,
  world: MemoryPolicyWorld,
  context: C.CommsContext,
  categoryId: string | null,
  departmentId: string | null = null,
  channel = true,
) {
  const scope = creationScope(categoryId);
  requireAvailable(
    binding,
    context,
    { scope, capability: "createChannel" },
    channelCreationCheck(world, context, scope, departmentId, channel).decision,
  );
}

/** New canonical room with only the creator's row (D44); no copied content. */
function stageChannel(
  draft: MemoryCommsState,
  execution: MemoryExecution,
  request: C.ChannelRequest,
) {
  if (request.category_id)
    ownedCategory(draft, execution.context, request.category_id);
  if (
    request.scope === "department" &&
    draft.departments[request.department_id]?.org_id !== draft.org_id
  )
    notFound();
  requireCategoryFits(
    draft,
    request.category_id,
    request.scope === "department" ? request.department_id : null,
  );
  const members = [execution.context.user_id];
  activePerson(draft, execution.context);
  const id = execution.uuid();
  const timestamp = new Date(execution.now).toISOString();
  const fields = {
    id,
    org_id: draft.org_id,
    created_at: timestamp,
    updated_at: timestamp,
    creator_id: execution.context.user_id,
    archived_at: null,
    kind: "channel" as const,
    name: request.name,
    topic: request.topic,
    category_id: request.category_id,
    position: request.position,
  };
  draft.conversations[id] = { ...fields, ...request };
  draft.members[id] = Object.fromEntries(
    members.map((user_id) => [
      user_id,
      { user_id, member_role: "member", joined_at: timestamp },
    ]),
  );
  draft.high_water_seq[id] = 0;
  return projectChannel(draft, execution.context, id);
}

export function projectConversation(
  world: MemoryPolicyWorld,
  context: C.CommsContext,
  id: string,
): C.Conversation {
  const stored = ownedConversation(world, context, id);
  const access = conversationAccess(world, context, id);
  if (access.level === "none") return notFound();
  const members = world.members[id] ?? {};
  const common = {
    id: stored.id,
    org_id: stored.org_id,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
    archived_at: stored.archived_at,
    level: access.level,
    member_count: memberIds(world, id).length,
    member_role:
      stored.kind === "channel"
        ? access.level === "manage"
          ? ("manager" as const)
          : ("member" as const)
        : (members[context.user_id]?.member_role ?? null),
  };
  const participant_ids = Object.keys(members).sort();
  // Like the API: a person who is no longer an active member has no name.
  const participants = participant_ids.map((user_id) => {
    const person = world.people[user_id];
    return {
      user_id,
      display_name: person?.active ? person.display_name : null,
    };
  });
  if (stored.kind === "direct")
    return { ...common, kind: "direct", participant_ids, participants };
  if (stored.kind === "group")
    return {
      ...common,
      kind: "group",
      name: stored.name,
      participant_ids,
      participants,
    };
  const channel = {
    ...common,
    kind: "channel" as const,
    name: stored.name,
    topic: stored.topic,
    category_id: stored.category_id,
    position: stored.position,
    thread_branches: resolveSettings(world, { kind: "channel", id }).effective
      .thread_branches,
  };
  if (stored.scope === "department")
    return {
      ...channel,
      scope: "department",
      department_id: stored.department_id,
    };
  return { ...channel, scope: stored.scope };
}

export function requireConversationManagement(
  binding: MemoryClientBinding,
  world: MemoryPolicyWorld,
  context: C.CommsContext,
  id: string,
) {
  projectConversation(world, context, id);
  requireAvailable(
    binding,
    context,
    { scope: { kind: "channel", id }, capability: "manageChannel" },
    capabilityCheck(world, context, id).capabilities.manageChannel,
  );
}

export function page<T>(
  items: T[],
  request: { limit: number; offset: number },
): C.Page<T> {
  const values = items.slice(request.offset, request.offset + request.limit);
  return {
    items: values,
    pagination: {
      limit: request.limit,
      offset: request.offset,
      count: values.length,
      total: items.length,
      has_more: request.offset + values.length < items.length,
    },
  };
}

type ConversationStructure = Pick<
  CommsClient,
  | "archiveConversation"
  | "restoreConversation"
  | "listCategories"
  | "getCategory"
  | "createCategory"
  | "updateCategory"
  | "createChannel"
  | "updateChannel"
  | "listMembers"
  | "setMemberRole"
  | "removeMember"
  | "duplicateChannel"
>;
export function createConversationStructure(
  binding: MemoryClientBinding,
): ConversationStructure {
  const { handle } = binding;
  async function archive(
    id: string,
    archived: boolean,
    options: C.ConditionalOptions,
  ) {
    const key = conversationKey(id);
    const result = await handle.command({
      signal: options?.signal,
      conditions: [{ key, if_match: options?.if_match }],
      authorize(world, execution) {
        requireConversationManagement(binding, world, execution.context, id);
      },
      apply(draft, execution) {
        const row = draft.conversations[id];
        row.archived_at = archived
          ? new Date(execution.now).toISOString()
          : null;
        row.updated_at = new Date(execution.now).toISOString();
        return {
          kind: "commit",
          value: projectConversation(draft, execution.context, id),
          version_keys: conversationVersionKeys(draft, [id]),
          publications: structurePublications(draft),
        };
      },
    });
    return { data: result.value, etag: result.versions[key] };
  }
  return {
    async setMemberRole(id, userId, request, options) {
      const parsed = S.memberRoleRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const result = await handle.command({
        signal: options?.signal,
        conditions: [{ key: conversationKey(id), if_match: options?.if_match }],
        authorize(world, execution) {
          requireConversationManagement(binding, world, execution.context, id);
          if (world.conversations[id].kind === "direct") invalidInput();
          projectMember(world, id, userId);
          if (
            parsed.data.role === "manager" &&
            world.people[userId].role === "guest"
          )
            capabilityDenied();
        },
        apply(draft, execution) {
          const timestamp = new Date(execution.now).toISOString();
          const rows = draft.members[id];
          // On a channel the rows are a manager roster (D44 decision 3): a
          // reader gains a manager row; "member" drops it, except the creator's.
          if (draft.conversations[id].kind !== "channel")
            rows[userId].member_role = parsed.data.role;
          else if (parsed.data.role === "manager")
            rows[userId] = {
              user_id: userId,
              member_role: "manager",
              joined_at: rows[userId]?.joined_at ?? timestamp,
            };
          else if (
            draft.conversations[id].creator_id === userId &&
            rows[userId]
          )
            rows[userId].member_role = "member";
          else delete rows[userId];
          draft.conversations[id].updated_at = timestamp;
          return {
            kind: "commit",
            value: projectMember(draft, id, userId),
            version_keys: conversationVersionKeys(draft, [id]),
            publications: structurePublications(draft),
          };
        },
      });
      return result.value;
    },
    async removeMember(id, userId, options) {
      await handle.command({
        signal: options?.signal,
        conditions: [{ key: conversationKey(id), if_match: options?.if_match }],
        authorize(world, execution) {
          requireConversationManagement(binding, world, execution.context, id);
          const row = world.conversations[id];
          if (row.kind === "direct") invalidInput();
          if (!Object.hasOwn(world.members[id], userId)) notFound();
          // D44 decision 3: on a channel only a manager row is removable; the
          // creator's manager row turns back into a member row.
          if (
            row.kind === "channel" &&
            world.members[id][userId].member_role !== "manager"
          )
            notFound();
          if (
            row.kind === "group" &&
            Object.keys(world.members[id]).length <= 3
          )
            policyFailure({
              status: 409,
              body: {
                detail: {
                  code: "comms_conflict",
                  message: "Group requires at least three participants",
                },
              },
            });
        },
        apply(draft, execution) {
          if (
            draft.conversations[id].kind === "channel" &&
            draft.conversations[id].creator_id === userId
          )
            draft.members[id][userId].member_role = "member";
          else delete draft.members[id][userId];
          draft.conversations[id].updated_at = new Date(
            execution.now,
          ).toISOString();
          return {
            kind: "commit",
            value: undefined,
            version_keys: conversationVersionKeys(draft, [id]),
            publications: structurePublications(draft),
          };
        },
      });
    },
    async duplicateChannel(id, request, options) {
      const parsed = S.duplicateChannelRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const result = await handle.command({
        signal: options?.signal,
        conditions: [{ key: conversationKey(id), if_match: options?.if_match }],
        authorize(world, execution) {
          requireConversationManagement(binding, world, execution.context, id);
          const source = projectChannel(world, execution.context, id);
          requireCreation(
            binding,
            world,
            execution.context,
            parsed.data.category_id,
            source.scope === "department" ? source.department_id : null,
          );
        },
        apply(draft, execution) {
          const source = projectChannel(draft, execution.context, id);
          const fields = {
            name: parsed.data.name,
            topic: source.topic,
            category_id: parsed.data.category_id,
            position: source.position,
          };
          const access: C.ChannelRequest =
            source.scope === "department"
              ? {
                  ...fields,
                  scope: "department",
                  department_id: source.department_id,
                }
              : { ...fields, scope: "organization" };
          const copy = stageChannel(draft, execution, access);
          const scope = { kind: "channel", id: copy.id } as const;
          const next = configurationSnapshot(draft, { kind: "channel", id });
          next.capabilities.scope = scope;
          const staged = stageConfigurationChange(
            draft,
            execution,
            scope,
            next,
          );
          return {
            kind: "commit",
            value: copy,
            version_keys: staged.version_keys,
            publications: staged.publications,
          };
        },
      });
      return {
        data: result.value,
        etag: result.versions[conversationKey(result.value.id)],
      };
    },
    async listCategories(request = {}, options) {
      assertRequestActive(options);
      const parsed = S.categoryListRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const { search, sort_by, sort_order } = parsed.data;
      return handle.read((world) =>
        page(
          Object.values(world.categories)
            .filter(
              (c) =>
                c.org_id === world.org_id &&
                (!search ||
                  c.name
                    .toLocaleLowerCase("en-US")
                    .includes(search.toLocaleLowerCase("en-US"))),
            )
            .sort(
              (a, b) =>
                (compare(a[sort_by], b[sort_by]) || compare(a.id, b.id)) *
                (sort_order === "asc" ? 1 : -1),
            ),
          parsed.data,
        ),
      );
    },
    async getCategory(id, options) {
      assertRequestActive(options);
      return handle.read((world, context) => ({
        data: ownedCategory(world, context, id),
        etag: handle.version(categoryKey(id)),
      }));
    },
    async createCategory(request, options) {
      const parsed = S.categoryRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const result = await handle.command({
        signal: options?.signal,
        authorize(world, execution) {
          requireCreation(binding, world, execution.context, null, null, false);
        },
        apply(draft, execution) {
          validateCategory(draft, parsed.data);
          const timestamp = new Date(execution.now).toISOString();
          const row = {
            ...parsed.data,
            id: execution.uuid(),
            org_id: draft.org_id,
            created_at: timestamp,
            updated_at: timestamp,
          };
          draft.categories[row.id] = row;
          return {
            kind: "commit",
            value: row,
            version_keys: [categoryKey(row.id)],
            publications: structurePublications(draft),
          };
        },
      });
      return {
        data: result.value,
        etag: result.versions[categoryKey(result.value.id)],
      };
    },
    async updateCategory(id, request, options) {
      const parsed = S.categoryRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const scope = { kind: "category", id } as const;
      const key = categoryKey(id);
      const result = await handle.command({
        signal: options?.signal,
        conditions: [{ key, if_match: options?.if_match }],
        authorize(world, execution) {
          requireAvailable(
            binding,
            execution.context,
            { scope, capability: "manageChannel" },
            scopeManagementDecision(world, execution.context, scope),
          );
        },
        apply(draft, execution) {
          validateCategory(draft, parsed.data);
          // D44 A8 rebind: a category changes department only while every
          // live channel in it already belongs to the new department.
          if (
            parsed.data.department_id !== draft.categories[id].department_id &&
            Object.values(draft.conversations).some(
              (room) =>
                room.kind === "channel" &&
                room.category_id === id &&
                (room.scope === "department" ? room.department_id : null) !==
                  parsed.data.department_id,
            )
          )
            policyFailure({
              status: 422,
              body: {
                detail: {
                  code: "comms_invalid",
                  message:
                    "The category's channels belong to another department",
                },
              },
            });
          const row = {
            ...draft.categories[id],
            ...parsed.data,
            updated_at: new Date(execution.now).toISOString(),
          };
          draft.categories[id] = row;
          return {
            kind: "commit",
            value: row,
            version_keys: [key, ...configurationVersionKeys(draft, scope)],
            publications: structurePublications(draft),
          };
        },
      });
      return { data: result.value, etag: result.versions[key] };
    },
    async createChannel(request, options) {
      const parsed = S.channelRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const result = await handle.command({
        signal: options?.signal,
        authorize(world, execution) {
          requireCreation(
            binding,
            world,
            execution.context,
            parsed.data.category_id,
            parsed.data.scope === "department"
              ? parsed.data.department_id
              : null,
          );
        },
        apply(draft, execution) {
          const row = stageChannel(draft, execution, parsed.data);
          return {
            kind: "commit",
            value: row,
            version_keys: [conversationKey(row.id)],
            // Like the backend's create_channel: structure, then grants.
            publications: [
              ...structurePublications(draft),
              ...structurePublications(draft, "grants"),
            ],
          };
        },
      });
      return {
        data: result.value,
        etag: result.versions[conversationKey(result.value.id)],
      };
    },
    async updateChannel(id, request, options) {
      const parsed = S.channelPatchSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const key = conversationKey(id);
      const result = await handle.command({
        signal: options?.signal,
        conditions: [{ key, if_match: options?.if_match }],
        authorize(world, execution) {
          requireConversationManagement(binding, world, execution.context, id);
          projectChannel(world, execution.context, id);
          if (parsed.data.category_id)
            ownedCategory(world, execution.context, parsed.data.category_id);
        },
        apply(draft, execution) {
          const row = draft.conversations[id];
          if (row.kind !== "channel") return invalidInput();
          if (parsed.data.category_id !== undefined)
            requireCategoryFits(
              draft,
              parsed.data.category_id,
              row.scope === "department" ? row.department_id : null,
            );
          draft.conversations[id] = {
            ...row,
            ...parsed.data,
            updated_at: new Date(execution.now).toISOString(),
          };
          if (conversationAccess(draft, execution.context, id).level === "none")
            policyFailure({
              status: 409,
              body: {
                detail: {
                  code: "comms_conflict",
                  message:
                    "This change would remove your read access. No changes were saved.",
                },
              },
            });
          return {
            kind: "commit",
            value: projectChannel(draft, execution.context, id),
            version_keys: configurationVersionKeys(draft, {
              kind: "channel",
              id,
            }),
            publications: structurePublications(draft),
          };
        },
      });
      return { data: result.value, etag: result.versions[key] };
    },
    async listMembers(id, request = {}, options) {
      assertRequestActive(options);
      const parsed = S.memberListRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return handle.read((world, context) => {
        projectConversation(world, context, id);
        const items = memberIds(world, id)
          .map((userId) => projectMember(world, id, userId))
          .filter(
            (m) =>
              !parsed.data.search ||
              m.display_name
                .toLocaleLowerCase("en-US")
                .includes(parsed.data.search.toLocaleLowerCase("en-US")),
          )
          .sort(
            (a, b) =>
              (compare(a.display_name, b.display_name) ||
                compare(a.user_id, b.user_id)) *
              (parsed.data.sort_order === "asc" ? 1 : -1),
          );
        return page(items, parsed.data);
      });
    },
    archiveConversation: (id, options) => archive(id, true, options),
    restoreConversation: (id, options) => archive(id, false, options),
  };
}
