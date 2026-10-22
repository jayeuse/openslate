import type { CommsClient } from "@/components/systems/comms/contract/client";
import * as S from "@/components/systems/comms/contract/schemas";
import type * as C from "@/components/systems/comms/contract/types";
import {
  activePerson,
  canStartDirect,
  conversationAccess,
  eligiblePersonIds,
  notFound,
} from "../domain/access";
import { invalidInput } from "../domain/settings";
import {
  assertRequestActive,
  capabilityDenied,
  type MemoryClientBinding,
} from "./availability";
import {
  compare,
  conversationKey,
  createConversationStructure,
  page,
  projectConversation,
} from "./conversation-structure";
import {
  conversationVersionKeys,
  structurePublications,
} from "./configuration-mutation";
import type { MemoryCommsState } from "./model";
import type { MemoryExecution } from "./store-types";
import { createConversationPreferences } from "./conversation-preferences";

type ConversationOperations = Pick<
  CommsClient,
  | "listCategories"
  | "getCategory"
  | "createCategory"
  | "updateCategory"
  | "createChannel"
  | "updateChannel"
  | "archiveConversation"
  | "restoreConversation"
  | "listMembers"
  | "setMemberRole"
  | "removeMember"
  | "duplicateChannel"
  | "getPersonalPreferences"
  | "setPersonalPreferences"
  | "getMemberPreferences"
  | "updateMemberPreferences"
  | "getCategoryPreferences"
  | "setCategoryPreferences"
  | "listConversations"
  | "getConversation"
  | "findOrCreateDirect"
  | "createGroup"
  | "listDirectBlocks"
  | "blockDirect"
  | "unblockDirect"
>;

function stageParticipants(
  draft: MemoryCommsState,
  execution: MemoryExecution,
  ids: string[],
  kind: "direct" | "group",
  name = "",
) {
  const timestamp = new Date(execution.now).toISOString();
  const id = execution.uuid();
  const fields = {
    id,
    org_id: draft.org_id,
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null,
    creator_id: execution.context.user_id,
  };
  draft.conversations[id] =
    kind === "direct" ? { ...fields, kind } : { ...fields, kind, name };
  draft.members[id] = Object.fromEntries(
    ids.map((user_id) => [
      user_id,
      { user_id, member_role: "member", joined_at: timestamp },
    ]),
  );
  draft.high_water_seq[id] = 0;
  return id;
}

function directVersionKeys(
  world: MemoryCommsState,
  left: string,
  right: string,
) {
  return conversationVersionKeys(
    world,
    Object.values(world.conversations)
      .filter(
        (c) =>
          c.kind === "direct" &&
          world.members[c.id][left] &&
          world.members[c.id][right],
      )
      .map((c) => c.id),
  );
}

export function createConversationOperations(
  binding: MemoryClientBinding,
): ConversationOperations {
  const { handle } = binding;
  return {
    ...createConversationStructure(binding),
    ...createConversationPreferences(binding),
    async findOrCreateDirect(request, options) {
      const parsed = S.directRequestSchemaFor(handle.context).safeParse(
        request,
      );
      if (!parsed.success) return invalidInput();
      const recipient = parsed.data.recipient_id;
      const result = await handle.command({
        signal: options?.signal,
        authorize(world, execution) {
          activePerson(world, { ...execution.context, user_id: recipient });
          if (!canStartDirect(world, execution.context, recipient))
            capabilityDenied();
        },
        apply(draft, execution) {
          const existing = Object.values(draft.conversations).find(
            (c) =>
              c.kind === "direct" &&
              draft.members[c.id][execution.context.user_id] &&
              draft.members[c.id][recipient],
          );
          const id =
            existing?.id ??
            stageParticipants(
              draft,
              execution,
              [execution.context.user_id, recipient],
              "direct",
            );
          const value = projectConversation(draft, execution.context, id);
          if (value.kind !== "direct") return invalidInput();
          const version_keys = [conversationKey(id)];
          return existing
            ? { kind: "unchanged", value, version_keys }
            : {
                kind: "commit",
                value,
                version_keys,
                publications: structurePublications(draft),
              };
        },
      });
      return {
        data: result.value,
        etag: result.versions[conversationKey(result.value.id)],
      };
    },
    async createGroup(request, options) {
      const parsed = S.groupRequestSchemaFor(handle.context).safeParse(request);
      if (!parsed.success) return invalidInput();
      const result = await handle.command({
        signal: options?.signal,
        authorize(world, execution) {
          for (const id of parsed.data.participant_ids) {
            activePerson(world, { ...execution.context, user_id: id });
            if (
              id !== execution.context.user_id &&
              !canStartDirect(world, execution.context, id)
            )
              capabilityDenied();
          }
        },
        apply(draft, execution) {
          const id = stageParticipants(
            draft,
            execution,
            parsed.data.participant_ids,
            "group",
            parsed.data.name,
          );
          const value = projectConversation(draft, execution.context, id);
          if (value.kind !== "group") return invalidInput();
          return {
            kind: "commit",
            value,
            version_keys: [conversationKey(id)],
            publications: structurePublications(draft),
          };
        },
      });
      return {
        data: result.value,
        etag: result.versions[conversationKey(result.value.id)],
      };
    },
    async listDirectBlocks(request = {}, options) {
      assertRequestActive(options);
      const parsed = S.timeListRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return handle.read((world, context) =>
        page(
          [...(world.blocks[context.user_id] ?? [])].sort(
            (a, b) =>
              (compare(a.created_at, b.created_at) ||
                compare(a.blocked_user_id, b.blocked_user_id)) *
              (parsed.data.sort_order === "asc" ? 1 : -1),
          ),
          parsed.data,
        ),
      );
    },
    async blockDirect(request, options) {
      const parsed = S.blockRequestSchema.safeParse(request);
      if (
        !parsed.success ||
        parsed.data.blocked_user_id === handle.context.user_id
      )
        return invalidInput();
      await handle.command({
        signal: options?.signal,
        authorize(world, execution) {
          if (
            !eligiblePersonIds(world, execution.context).includes(
              parsed.data.blocked_user_id,
            )
          )
            notFound();
        },
        apply(draft, execution) {
          const blocks = draft.blocks[execution.context.user_id] ?? [];
          if (
            blocks.some(
              (b) => b.blocked_user_id === parsed.data.blocked_user_id,
            )
          )
            return { kind: "unchanged", value: undefined, version_keys: [] };
          draft.blocks[execution.context.user_id] = [
            ...blocks,
            {
              blocked_user_id: parsed.data.blocked_user_id,
              created_at: new Date(execution.now).toISOString(),
            },
          ];
          return {
            kind: "commit",
            value: undefined,
            version_keys: directVersionKeys(
              draft,
              execution.context.user_id,
              parsed.data.blocked_user_id,
            ),
            publications: structurePublications(draft),
          };
        },
      });
    },
    async unblockDirect(userId, options) {
      const parsed = S.blockRequestSchema.safeParse({
        blocked_user_id: userId,
      });
      if (!parsed.success || userId === handle.context.user_id)
        return invalidInput();
      await handle.command({
        signal: options?.signal,
        authorize(world, execution) {
          activePerson(world, execution.context);
        },
        apply(draft, execution) {
          const blocks = draft.blocks[execution.context.user_id] ?? [];
          if (!blocks.some((b) => b.blocked_user_id === userId))
            return { kind: "unchanged", value: undefined, version_keys: [] };
          draft.blocks[execution.context.user_id] = blocks.filter(
            (b) => b.blocked_user_id !== userId,
          );
          return {
            kind: "commit",
            value: undefined,
            version_keys: directVersionKeys(
              draft,
              execution.context.user_id,
              userId,
            ),
            publications: structurePublications(draft),
          };
        },
      });
    },
    async listConversations(request = {}, options) {
      assertRequestActive(options);
      const parsed = S.conversationListRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return handle.read((world, context) => {
        const items = Object.values(world.conversations)
          .filter(
            (c) =>
              conversationAccess(world, context, c.id).level !== "none" &&
              Boolean(c.archived_at) === parsed.data.archived,
          )
          .filter(
            (c) =>
              c.kind !== "direct" ||
              !world.blocks[context.user_id]?.some((b) =>
                Boolean(world.members[c.id][b.blocked_user_id]),
              ),
          )
          .map((c) => projectConversation(world, context, c.id));
        const name = (c: C.Conversation) =>
          c.kind === "direct"
            ? c.participant_ids
                .filter((id) => id !== context.user_id)
                .map((id) => world.people[id].display_name)
                .join(", ")
            : c.name;
        const value = (c: C.Conversation) =>
          parsed.data.sort_by === "position"
            ? c.kind === "channel"
              ? c.position
              : 0
            : parsed.data.sort_by === "name"
              ? name(c)
              : c.updated_at;
        const query = parsed.data.search?.toLocaleLowerCase("en-US");
        const sorted = items
          .filter(
            (c) => !query || name(c).toLocaleLowerCase("en-US").includes(query),
          )
          .sort(
            (a, b) =>
              (compare(value(a), value(b)) || compare(a.id, b.id)) *
              (parsed.data.sort_order === "asc" ? 1 : -1),
          );
        return page(sorted, parsed.data);
      });
    },
    async getConversation(id, options) {
      assertRequestActive(options);
      return handle.read((world, context) => ({
        data: projectConversation(world, context, id),
        etag: handle.version(conversationKey(id)),
      }));
    },
  };
}
