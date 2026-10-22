import type { CommsClient } from "@/components/systems/comms/contract/client";
import * as S from "@/components/systems/comms/contract/schemas";
import type * as C from "@/components/systems/comms/contract/types";
import {
  activePerson,
  directBlocked,
  memberCandidateIds,
  notFound,
  policyFailure,
} from "../domain/access";
import { capabilityCheck } from "../domain/capabilities";
import {
  assertMessageChange,
  assertReaction,
  postDenied,
} from "../domain/posting";
import { invalidInput } from "../domain/settings";
import {
  assertRequestActive,
  capabilityDenied,
  requireAvailable,
  type MemoryClientBinding,
} from "./availability";
import { page } from "./conversation-structure";
import {
  conversationSettings,
  findThread,
  memberPreferences,
  memberPreferencesKey,
  messageKey,
  messagePublications,
  messageRow,
  messageUserState,
  personalKey,
  projectHistory,
  projectLinkedRecords,
  projectMessage,
  projectPins,
  projectRecordLink,
  projectSearch,
  projectThread,
  projectThreadList,
  readableConversation,
  rootMessage,
  threadKey,
  timeSort,
} from "./message-projections";
import {
  assertSendDependencies,
  messageRemovalCommand,
  messageSendCommand,
  stageThread,
  type MemorySendDependencies,
} from "./message-transitions";
import type { MemoryCommsState, MemoryMessage } from "./model";
import { invalidMemoryState } from "./snapshot";
import type { MemoryPublication } from "./store-types";

export { projectReadSummary } from "./message-projections";
export type { ProjectReadSummary } from "./message-projections";
export type MessageFamily = Pick<
  CommsClient,
  | "markRead"
  | "getHistory"
  | "getMessage"
  | "getMessageBySequence"
  | "sendMessage"
  | "editMessage"
  | "deleteMessage"
  | "listMessageRevisions"
  | "getThread"
  | "createThread"
  | "getReplies"
  | "sendReply"
  | "updateThread"
  | "followThread"
  | "listThreads"
  | "addReaction"
  | "removeReaction"
  | "setPin"
  | "listPins"
  | "reserveAttachment"
  | "uploadAttachment"
  | "downloadAttachment"
  | "getRecordReference"
  | "listLinkedRecords"
  | "search"
>;

function messageCapability(
  binding: MemoryClientBinding,
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  id: string,
  capability: C.Capability,
) {
  const row = readableConversation(state, context, id);
  const check = capabilityCheck(state, context, id);
  requireAvailable(
    binding,
    context,
    {
      scope:
        row.kind === "channel"
          ? { kind: "channel", id }
          : { kind: "workspace" },
      capability,
    },
    check.capabilities[capability],
  );
}

function liveProjection(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  conversationId: string,
  messageId: string,
) {
  const result = projectMessage(state, context, conversationId, messageId);
  if (result.state !== "live") return notFound();
  return result;
}

function validateEdit(
  binding: MemoryClientBinding,
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  message: MemoryMessage,
  request: C.EditMessageRequest,
) {
  const id = message.conversation_id;
  if (
    !request.body.trim() &&
    !message.attachment_ids.length &&
    !message.record_links.length
  )
    return policyFailure({
      status: 422,
      body: {
        detail: { code: "comms_message_empty", message: "Message is empty" },
      },
    });
  const settings = conversationSettings(state, id);
  if (request.mentions_channel || request.mentions_here)
    messageCapability(binding, state, context, id, "mentionChannel");
  if (
    settings.mention_limit > 0 &&
    request.mention_user_ids.length +
      Number(request.mentions_channel) +
      Number(request.mentions_here) >
      settings.mention_limit
  )
    return invalidInput();
  for (const userId of request.mention_user_ids) {
    const person = state.people[userId];
    if (
      !person?.active ||
      person.org_id !== context.org_id ||
      !memberCandidateIds(state, id).includes(userId)
    )
      return invalidInput();
    // Same current core access decision as a new-send mention, without send rate limits.
    if (
      capabilityCheck(state, { ...context, user_id: userId }, id)
        .conversation_level === "none"
    )
      return invalidInput();
  }
}

/** Actual bounded family, composed over one canonical handle and resource owner. */
export function createMessageFamily(
  binding: MemoryClientBinding,
  dependencies: MemorySendDependencies,
): MessageFamily {
  assertSendDependencies(dependencies);
  const { handle } = binding;
  assertRequestActive({ signal: handle.lifetimeSignal });
  if (
    !handle.isCurrentFor(dependencies.store) ||
    binding.authority !== dependencies.authority
  )
    return invalidMemoryState();
  const files = dependencies.files.bind(binding);

  async function reaction(
    conversationId: string,
    messageId: string,
    request: C.ReactionRequest,
    add: boolean,
    options?: C.RequestOptions,
  ) {
    const parsed = S.reactionRequestSchema.safeParse(request);
    if (!parsed.success) return invalidInput();
    const result = await handle.command({
      signal: options?.signal,
      authorize(current, execution) {
        messageRow(current, execution.context, conversationId, messageId);
        assertReaction(
          current,
          execution.context,
          messageId,
          parsed.data.emoji,
        );
        messageCapability(
          binding,
          current,
          execution.context,
          conversationId,
          "react",
        );
      },
      apply(draft, execution) {
        const row = draft.messages[messageId];
        const existing = row.reactions.find(
          (r) => r.emoji === parsed.data.emoji,
        );
        const included =
          existing?.user_ids.includes(execution.context.user_id) ?? false;
        if (included === add)
          return {
            kind: "unchanged",
            value: projectMessage(
              draft,
              execution.context,
              conversationId,
              messageId,
            ),
            version_keys: [],
          };
        if (add) {
          if (existing) existing.user_ids.push(execution.context.user_id);
          else
            row.reactions.push({
              emoji: parsed.data.emoji,
              user_ids: [execution.context.user_id],
            });
        } else if (existing) {
          existing.user_ids = existing.user_ids.filter(
            (id) => id !== execution.context.user_id,
          );
          if (!existing.user_ids.length)
            row.reactions = row.reactions.filter((r) => r !== existing);
        }
        return {
          kind: "commit",
          value: projectMessage(
            draft,
            execution.context,
            conversationId,
            messageId,
          ),
          version_keys: [
            messageKey(messageId),
            `conversation:${conversationId}`,
          ],
          publications: messagePublications(draft, row, "reaction"),
        };
      },
    });
    return result.value;
  }

  return {
    ...files,
    async markRead(conversationId, request, options) {
      const parsed = S.markReadRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const result = await handle.command({
        signal: options?.signal,
        authorize(current, execution) {
          readableConversation(current, execution.context, conversationId);
        },
        apply(draft, execution) {
          const userId = execution.context.user_id;
          const previous =
            draft.users[userId]?.last_read_seq[conversationId] ?? 0;
          const last_read_seq = Math.min(
            draft.high_water_seq[conversationId] ?? 0,
            Math.max(previous, parsed.data.last_read_seq),
          );
          const preferences = memberPreferences(draft, userId, conversationId);
          const value = { conversation_id: conversationId, last_read_seq };
          if (last_read_seq === previous && !preferences.manual_unread)
            return { kind: "unchanged", value, version_keys: [] };
          const user = messageUserState(draft, userId);
          user.last_read_seq[conversationId] = last_read_seq;
          user.conversations[conversationId] = {
            ...preferences,
            manual_unread: false,
          };
          for (const notification of user.notifications) {
            if (
              notification.conversation_id === conversationId &&
              notification.status === "unread" &&
              draft.messages[notification.message_id]?.seq <= last_read_seq
            ) {
              notification.status = "read";
              notification.read_at = new Date(execution.now).toISOString();
            }
          }
          const publications: MemoryPublication[] = [
            {
              recipient_ids: [userId],
              event: {
                private: true,
                topic: `org:${draft.org_id}:user:${userId}`,
                event: "read",
                payload: value,
              },
            },
          ];
          return {
            kind: "commit",
            value,
            version_keys: [
              personalKey(userId),
              memberPreferencesKey(userId, conversationId),
            ],
            publications,
          };
        },
      });
      return result.value;
    },
    async getHistory(conversationId, request = {}, options) {
      assertRequestActive(options);
      const parsed = S.historyRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return handle.read((state, context) =>
        projectHistory(state, context, conversationId, null, parsed.data),
      );
    },
    async getMessage(conversationId, messageId, options) {
      assertRequestActive(options);
      return handle.read((state, context) => ({
        data: projectMessage(state, context, conversationId, messageId),
        etag: handle.version(messageKey(messageId)),
      }));
    },
    async getMessageBySequence(conversationId, seq, options) {
      assertRequestActive(options);
      if (!Number.isSafeInteger(seq) || seq <= 0) return invalidInput();
      return handle.read((state, context) => {
        readableConversation(state, context, conversationId);
        const row = Object.values(state.messages).find(
          (m) => m.conversation_id === conversationId && m.seq === seq,
        );
        if (!row) return notFound();
        return {
          data: projectMessage(state, context, conversationId, row.id),
          etag: handle.version(messageKey(row.id)),
        };
      });
    },
    async sendMessage(conversationId, request, options) {
      const result = await handle.command(
        messageSendCommand(
          {
            conversation_id: conversationId,
            parent_id: null,
            request,
            signal: options?.signal,
          },
          dependencies,
        ),
      );
      return result.value;
    },
    async sendReply(conversationId, rootId, request, options) {
      const result = await handle.command(
        messageSendCommand(
          {
            conversation_id: conversationId,
            parent_id: rootId,
            request,
            signal: options?.signal,
          },
          dependencies,
        ),
      );
      return result.value;
    },
    async editMessage(conversationId, messageId, request, options) {
      const parsed = S.editMessageRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const key = messageKey(messageId);
      const result = await handle.command({
        signal: options?.signal,
        authorize(current, execution) {
          const row = messageRow(
            current,
            execution.context,
            conversationId,
            messageId,
          );
          assertMessageChange(
            current,
            execution.context,
            messageId,
            "edit",
            execution.now,
          );
          if (
            capabilityCheck(current, execution.context, conversationId)
              .conversation_level === "read"
          )
            messageCapability(
              binding,
              current,
              execution.context,
              conversationId,
              "reply",
            );
          validateEdit(binding, current, execution.context, row, parsed.data);
        },
        apply(draft, execution) {
          const row = draft.messages[messageId];
          const timestamp = new Date(execution.now).toISOString();
          (draft.revisions[messageId] ??= []).push({
            id: execution.uuid(),
            message_id: messageId,
            author_id: row.author_id,
            created_at: timestamp,
            body: row.body,
          });
          Object.assign(row, parsed.data, { edited_at: timestamp });
          return {
            kind: "commit",
            value: liveProjection(
              draft,
              execution.context,
              conversationId,
              messageId,
            ),
            version_keys: [key, `conversation:${conversationId}`],
            publications: messagePublications(draft, row, "edited"),
          };
        },
      });
      return { data: result.value, etag: result.versions[key] };
    },
    async deleteMessage(conversationId, messageId, options) {
      const recipe = messageRemovalCommand({
        conversation_id: conversationId,
        message_id: messageId,
        action: "delete",
        options,
      });
      const result = await handle.command({
        ...recipe,
        // Ordinary deletion is unconditional; the shared moderation/restore
        // recipe retains its precondition for its other callers.
        conditions: [],
        authorize(current, execution, prepared) {
          recipe.authorize(current, execution, prepared);
          if (
            current.messages[messageId].author_id !== execution.context.user_id
          )
            messageCapability(
              binding,
              current,
              execution.context,
              conversationId,
              "deleteOthersMessages",
            );
          else if (
            capabilityCheck(current, execution.context, conversationId)
              .conversation_level === "read"
          )
            messageCapability(
              binding,
              current,
              execution.context,
              conversationId,
              "reply",
            );
        },
      });
      if (result.value.state !== "deleted") return invalidMemoryState();
      return {
        data: result.value,
        etag: result.versions[messageKey(messageId)],
      };
    },
    async listMessageRevisions(
      conversationId,
      messageId,
      request = {},
      options,
    ) {
      assertRequestActive(options);
      const parsed = S.timeListRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return handle.read((state, context) => {
        const row = messageRow(state, context, conversationId, messageId);
        if (row.deleted_at) return notFound();
        if (row.author_id !== context.user_id) {
          if (
            capabilityCheck(state, context, conversationId)
              .conversation_level !== "manage"
          )
            return capabilityDenied();
          binding.authority.assertInspectionAvailable(
            context,
            state.conversations[conversationId].kind === "channel"
              ? { kind: "channel", id: conversationId }
              : { kind: "workspace" },
          );
        }
        return page(
          timeSort(
            [...(state.revisions[messageId] ?? [])],
            parsed.data,
            (revision) => revision.created_at,
            (revision) => revision.id,
          ),
          parsed.data,
        );
      });
    },
    async getThread(conversationId, rootId, options) {
      assertRequestActive(options);
      return handle.read((state, context) => ({
        data: projectThread(state, context, conversationId, rootId),
        etag: handle.version(threadKey(rootId)),
      }));
    },
    async createThread(conversationId, rootId, options) {
      const key = threadKey(rootId);
      const result = await handle.command({
        signal: options?.signal,
        authorize(current, execution) {
          rootMessage(current, execution.context, conversationId, rootId);
          const conversation = current.conversations[conversationId];
          const settings = conversationSettings(current, conversationId);
          if (
            conversation.archived_at ||
            settings.locked ||
            (settings.restricted_person_ids.includes(
              execution.context.user_id,
            ) &&
              (!settings.restriction_until ||
                Date.parse(settings.restriction_until) > execution.now))
          )
            return postDenied();
          if (
            conversation.kind === "direct" &&
            Object.keys(current.members[conversationId] ?? {}).some((userId) =>
              directBlocked(current, execution.context.user_id, userId),
            )
          )
            return postDenied();
          messageCapability(
            binding,
            current,
            execution.context,
            conversationId,
            "createThread",
          );
        },
        apply(draft, execution) {
          if (findThread(draft, rootId))
            return {
              kind: "unchanged",
              value: projectThread(
                draft,
                execution.context,
                conversationId,
                rootId,
              ),
              version_keys: [key],
            };
          const thread = stageThread(draft, execution, conversationId, rootId);
          if (
            conversationSettings(draft, conversationId)
              .default_thread_subscription
          )
            messageUserState(
              draft,
              execution.context.user_id,
            ).followed_thread_ids.push(thread.id);
          return {
            kind: "commit",
            value: projectThread(
              draft,
              execution.context,
              conversationId,
              rootId,
            ),
            version_keys: [
              key,
              messageKey(rootId),
              `conversation:${conversationId}`,
              personalKey(execution.context.user_id),
            ],
            publications: messagePublications(
              draft,
              draft.messages[rootId],
              "thread",
            ),
          };
        },
      });
      return { data: result.value, etag: result.versions[key] };
    },
    async getReplies(conversationId, rootId, request = {}, options) {
      assertRequestActive(options);
      const parsed = S.historyRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return handle.read((state, context) =>
        projectHistory(state, context, conversationId, rootId, parsed.data),
      );
    },
    async updateThread(conversationId, rootId, request, options) {
      const parsed = S.threadPatchSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const key = threadKey(rootId);
      const result = await handle.command({
        signal: options?.signal,
        conditions: [{ key, if_match: options?.if_match }],
        authorize(current, execution) {
          const root = rootMessage(
            current,
            execution.context,
            conversationId,
            rootId,
          );
          projectThread(current, execution.context, conversationId, rootId);
          const onlyResolve = Object.keys(parsed.data).every(
            (field) => field === "resolved",
          );
          if (root.author_id !== execution.context.user_id || !onlyResolve)
            messageCapability(
              binding,
              current,
              execution.context,
              conversationId,
              "manageThreads",
            );
          else if (activePerson(current, execution.context).role === "guest")
            return capabilityDenied();
        },
        apply(draft, execution) {
          const thread = findThread(draft, rootId)!;
          const patch = parsed.data;
          if (
            (patch.name === undefined || patch.name === thread.name) &&
            (patch.resolved === undefined ||
              patch.resolved === thread.resolved) &&
            (patch.locked === undefined || patch.locked === thread.locked) &&
            (patch.archived === undefined || patch.archived === thread.archived)
          )
            return {
              kind: "unchanged",
              value: projectThread(
                draft,
                execution.context,
                conversationId,
                rootId,
              ),
              version_keys: [key],
            };
          if (patch.name !== undefined) thread.name = patch.name;
          if (patch.resolved !== undefined) thread.resolved = patch.resolved;
          if (patch.locked !== undefined) thread.locked = patch.locked;
          if (patch.archived !== undefined) thread.archived = patch.archived;
          return {
            kind: "commit",
            value: projectThread(
              draft,
              execution.context,
              conversationId,
              rootId,
            ),
            version_keys: [
              key,
              messageKey(rootId),
              `conversation:${conversationId}`,
            ],
            publications: messagePublications(
              draft,
              draft.messages[rootId],
              "thread",
            ),
          };
        },
      });
      return { data: result.value, etag: result.versions[key] };
    },
    async followThread(conversationId, rootId, request, options) {
      const parsed = S.followRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const result = await handle.command({
        signal: options?.signal,
        authorize(current, execution) {
          projectThread(current, execution.context, conversationId, rootId);
        },
        apply(draft, execution) {
          const thread = findThread(draft, rootId)!;
          const current =
            draft.users[execution.context.user_id]?.followed_thread_ids ?? [];
          if (current.includes(thread.id) === parsed.data.followed)
            return {
              kind: "unchanged",
              value: projectThread(
                draft,
                execution.context,
                conversationId,
                rootId,
              ),
              version_keys: [],
            };
          const user = messageUserState(draft, execution.context.user_id);
          user.followed_thread_ids = parsed.data.followed
            ? [...user.followed_thread_ids, thread.id]
            : user.followed_thread_ids.filter((id) => id !== thread.id);
          return {
            kind: "commit",
            value: projectThread(
              draft,
              execution.context,
              conversationId,
              rootId,
            ),
            version_keys: [personalKey(execution.context.user_id)],
            publications: [
              {
                recipient_ids: [execution.context.user_id],
                event: {
                  private: true,
                  topic: `org:${draft.org_id}:user:${execution.context.user_id}`,
                  event: "membership",
                  payload: { conversation_id: conversationId },
                },
              },
            ],
          };
        },
      });
      return result.value;
    },
    async listThreads(request = {}, options) {
      assertRequestActive(options);
      const parsed = S.threadListRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return handle.read((state, context) =>
        projectThreadList(state, context, parsed.data),
      );
    },
    addReaction: (conversationId, messageId, request, options) =>
      reaction(conversationId, messageId, request, true, options),
    removeReaction: (conversationId, messageId, request, options) =>
      reaction(conversationId, messageId, request, false, options),
    async setPin(conversationId, messageId, request, options) {
      const parsed = S.pinRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const result = await handle.command({
        signal: options?.signal,
        authorize(current, execution) {
          liveProjection(current, execution.context, conversationId, messageId);
          messageCapability(
            binding,
            current,
            execution.context,
            conversationId,
            "pin",
          );
        },
        apply(draft, execution) {
          const row = draft.messages[messageId];
          if (Boolean(row.pinned_at) === parsed.data.pinned)
            return {
              kind: "unchanged",
              value: projectMessage(
                draft,
                execution.context,
                conversationId,
                messageId,
              ),
              version_keys: [],
            };
          row.pinned_at = parsed.data.pinned
            ? new Date(execution.now).toISOString()
            : null;
          row.pinned_by = parsed.data.pinned ? execution.context.user_id : null;
          return {
            kind: "commit",
            value: projectMessage(
              draft,
              execution.context,
              conversationId,
              messageId,
            ),
            version_keys: [
              messageKey(messageId),
              `conversation:${conversationId}`,
            ],
            publications: messagePublications(draft, row, "pin"),
          };
        },
      });
      return result.value;
    },
    async listPins(conversationId, request = {}, options) {
      assertRequestActive(options);
      const parsed = S.timeListRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return handle.read((state, context) =>
        projectPins(state, context, conversationId, parsed.data),
      );
    },
    async getRecordReference(conversationId, referenceId, options) {
      assertRequestActive(options);
      return handle.read((state, context) => {
        readableConversation(state, context, conversationId);
        for (const message of Object.values(state.messages)) {
          if (message.conversation_id !== conversationId || message.deleted_at)
            continue;
          const link = message.record_links.find(
            (link) => link.id === referenceId,
          );
          if (link) return projectRecordLink(state, context, message, link);
        }
        return notFound();
      });
    },
    async listLinkedRecords(request = {}, options) {
      assertRequestActive(options);
      const parsed = S.timeListRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return handle.read((state, context) =>
        projectLinkedRecords(state, context, parsed.data),
      );
    },
    async search(request, options) {
      assertRequestActive(options);
      const parsed = S.searchRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return handle.read((state, context) =>
        projectSearch(state, context, parsed.data),
      );
    },
  };
}
