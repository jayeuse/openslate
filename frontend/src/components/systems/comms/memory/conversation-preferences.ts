import type { CommsClient } from "../contract/client";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import { activePerson } from "../domain/access";
import { DEFAULT_PERSONAL_PREFERENCES, invalidInput } from "../domain/settings";
import { assertRequestActive, type MemoryClientBinding } from "./availability";
import { ownedCategory, projectConversation } from "./conversation-structure";
import type { MemoryCommsState } from "./model";
import type { MemoryPublication } from "./store-types";

type ConversationPreferences = Pick<
  CommsClient,
  | "getPersonalPreferences"
  | "setPersonalPreferences"
  | "getMemberPreferences"
  | "updateMemberPreferences"
  | "getCategoryPreferences"
  | "setCategoryPreferences"
>;

const memberDefaults: C.MemberPreferences = {
  notify: "all",
  mute: { kind: "off" },
  starred: false,
  hidden: false,
  manual_unread: false,
};
const categoryDefaults: C.CategoryPreferences = {
  collapsed: false,
  mute: { kind: "off" },
};
const personalKey = (userId: string) => `personal:${userId}`;
const memberKey = (userId: string, id: string) =>
  `member-preferences:${userId}:${id}`;
const categoryKey = (userId: string, id: string) =>
  `category-preferences:${userId}:${id}`;

function userState(draft: MemoryCommsState, userId: string) {
  return (draft.users[userId] ??= {
    personal: structuredClone(DEFAULT_PERSONAL_PREFERENCES),
    conversations: {},
    categories: {},
    last_read_seq: {},
    followed_thread_ids: [],
    notifications: [],
  });
}
function publication(
  context: C.CommsContext,
  conversationId?: string,
): MemoryPublication[] {
  const common = {
    private: true as const,
    topic: `org:${context.org_id}:user:${context.user_id}`,
  };
  return [
    {
      recipient_ids: [context.user_id],
      event: conversationId
        ? {
            ...common,
            event: "membership",
            payload: { conversation_id: conversationId },
          }
        : { ...common, event: "structure", payload: {} },
    },
  ];
}

export function createConversationPreferences({
  handle,
}: MemoryClientBinding): ConversationPreferences {
  return {
    async getPersonalPreferences(options) {
      assertRequestActive(options);
      return handle.read((world, context) => ({
        data:
          world.users[context.user_id]?.personal ??
          DEFAULT_PERSONAL_PREFERENCES,
        etag: handle.version(personalKey(context.user_id)),
      }));
    },
    async setPersonalPreferences(request, options) {
      const parsed = S.personalPreferencesRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const key = personalKey(handle.context.user_id);
      const result = await handle.command({
        signal: options?.signal,
        authorize(world, execution) {
          activePerson(world, execution.context);
        },
        apply(draft, execution) {
          userState(draft, execution.context.user_id).personal = parsed.data;
          return {
            kind: "commit",
            value: parsed.data,
            version_keys: [key],
            publications: publication(execution.context),
          };
        },
      });
      return { data: result.value, etag: result.versions[key] };
    },
    async getMemberPreferences(id, options) {
      assertRequestActive(options);
      return handle.read((world, context) => {
        projectConversation(world, context, id);
        return {
          data:
            world.users[context.user_id]?.conversations[id] ?? memberDefaults,
          etag: handle.version(memberKey(context.user_id, id)),
        };
      });
    },
    async updateMemberPreferences(id, request, options) {
      const parsed = S.memberPreferencesPatchSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const key = memberKey(handle.context.user_id, id);
      const result = await handle.command({
        signal: options?.signal,
        authorize(world, execution) {
          projectConversation(world, execution.context, id);
        },
        apply(draft, execution) {
          const user = userState(draft, execution.context.user_id);
          const value = {
            ...(user.conversations[id] ?? memberDefaults),
            ...parsed.data,
          };
          user.conversations[id] = value;
          return {
            kind: "commit",
            value,
            version_keys: [key],
            publications: publication(execution.context, id),
          };
        },
      });
      return { data: result.value, etag: result.versions[key] };
    },
    async getCategoryPreferences(id, options) {
      assertRequestActive(options);
      return handle.read((world, context) => {
        ownedCategory(world, context, id);
        return {
          data:
            world.users[context.user_id]?.categories[id] ?? categoryDefaults,
          etag: handle.version(categoryKey(context.user_id, id)),
        };
      });
    },
    async setCategoryPreferences(id, request, options) {
      const parsed = S.categoryPreferencesSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const key = categoryKey(handle.context.user_id, id);
      const result = await handle.command({
        signal: options?.signal,
        authorize(world, execution) {
          ownedCategory(world, execution.context, id);
        },
        apply(draft, execution) {
          userState(draft, execution.context.user_id).categories[id] =
            parsed.data;
          return {
            kind: "commit",
            value: parsed.data,
            version_keys: [key],
            publications: publication(execution.context),
          };
        },
      });
      return { data: result.value, etag: result.versions[key] };
    },
  };
}
