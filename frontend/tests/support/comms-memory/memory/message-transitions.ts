import * as S from "@/components/systems/comms/contract/schemas";
import type * as C from "@/components/systems/comms/contract/types";
import {
  conversationAccess,
  memberCandidateIds,
  notFound,
  policyFailure,
} from "../domain/access";
import { notificationDecision } from "../domain/notifications";
import { admitSend, assertMessageChange } from "../domain/posting";
import { DEFAULT_PERSONAL_PREFERENCES, invalidInput } from "../domain/settings";
import type { MemoryClientBinding } from "./availability";
import type { MemoryFileResources } from "./files";
import { structurePublications } from "./configuration-mutation";
import {
  conversationSettings,
  findThread,
  memberPreferences,
  messageKey,
  messagePublications,
  messageRow,
  messageUserState,
  personalKey,
  projectMessage,
  readableConversation,
  rootMessage,
  threadKey,
} from "./message-projections";
import type { MemoryCommsState, MemoryMessage } from "./model";
import { invalidMemoryState } from "./snapshot";
import type {
  MemoryCommand,
  MemoryExecution,
  MemoryPublication,
  MemoryStore,
  MemoryVersionKey,
} from "./store-types";

/** Implemented by the operational owner; facts only, never a permission grant. */
export interface MemorySendPresence {
  readonly store: MemoryStore;
  onlineUserIds(input: {
    store: MemoryStore;
    org_id: string;
    now: number;
  }): readonly string[];
}
export interface MemorySendDependencies {
  readonly store: MemoryStore;
  readonly files: MemoryFileResources;
  readonly presence: MemorySendPresence;
  readonly authority: MemoryClientBinding["authority"];
}
export type MessageSendInput = {
  conversation_id: string;
  parent_id: string | null;
  request: C.SendMessageRequest | C.SendReplyRequest;
  signal?: AbortSignal;
};
export type MessageSendCommand = (
  input: MessageSendInput,
  dependencies: MemorySendDependencies,
) => MemoryCommand<void, C.SendResult>;
export type MessageRemovalCommand = (input: {
  conversation_id: string;
  message_id: string;
  action: "delete" | "restore";
  options?: C.RequestOptions | C.ConditionalOptions;
}) => MemoryCommand<void, C.Message>;

export function assertSendDependencies(dependencies: MemorySendDependencies) {
  const { store, files, presence } = dependencies;
  if (files.store !== store || presence.store !== store)
    return invalidMemoryState();
  files.assertCurrent(store);
}

function parseSend(input: MessageSendInput) {
  const parsed = (
    input.parent_id === null
      ? S.sendMessageRequestSchema
      : S.sendReplyRequestSchema
  ).safeParse(input.request);
  if (!parsed.success) {
    if (
      parsed.error.issues.every(
        (issue) => issue.code === "custom" && issue.path.length === 0,
      )
    )
      return policyFailure({
        status: 422,
        body: {
          detail: { code: "comms_message_empty", message: "Message is empty" },
        },
      });
    return invalidInput();
  }
  return {
    ...parsed.data,
    also_send_to_channel:
      "also_send_to_channel" in parsed.data
        ? parsed.data.also_send_to_channel === true
        : false,
  };
}

/** Original normalized request, not the mutable or redacted message projection. */
function fingerprint(
  input: MessageSendInput,
  request: ReturnType<typeof parseSend>,
) {
  return JSON.stringify({
    conversation_id: input.conversation_id,
    parent_id: input.parent_id,
    body: request.body,
    reply_to_id: request.reply_to_id,
    also_send_to_channel: request.also_send_to_channel,
    attachment_ids: [...request.attachment_ids].sort(),
    record_ids: [...request.record_ids].sort(),
    mention_user_ids: [...request.mention_user_ids].sort(),
    mentions_channel: request.mentions_channel,
    mentions_here: request.mentions_here,
  });
}

function replay(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  key: string,
  payload: string,
) {
  const entry =
    state.idempotency[`${context.org_id}:${context.user_id}:${key}`];
  if (!entry) return null;
  if (entry.payload !== payload)
    return policyFailure({
      status: 409,
      body: {
        detail: {
          code: "comms_idempotency_mismatch",
          message: "Client key has another payload",
        },
      },
    });
  return entry.message_id;
}

export function stageThread(
  draft: MemoryCommsState,
  execution: MemoryExecution,
  conversationId: string,
  rootId: string,
) {
  const root = rootMessage(draft, execution.context, conversationId, rootId);
  const existing = findThread(draft, rootId);
  if (existing) return existing;
  const id = execution.uuid();
  if (Object.hasOwn(draft.threads, id)) return invalidMemoryState();
  const thread = {
    id,
    org_id: draft.org_id,
    conversation_id: conversationId,
    root_message_id: rootId,
    name: "",
    resolved: false,
    locked: false,
    archived: false,
    starter_id: root.author_id,
  };
  draft.threads[id] = thread;
  return thread;
}

function currentMembers(
  state: Readonly<MemoryCommsState>,
  conversationId: string,
) {
  return memberCandidateIds(state, conversationId).filter((userId) => {
    const person = state.people[userId];
    return (
      person?.active &&
      person.org_id === state.org_id &&
      conversationAccess(
        state,
        { org_id: state.org_id, user_id: userId },
        conversationId,
      ).level !== "none"
    );
  });
}

function stageNotifications(
  draft: MemoryCommsState,
  execution: MemoryExecution,
  message: MemoryMessage,
  mentioned: ReadonlySet<string>,
) {
  const publications: MemoryPublication[] = [];
  const version_keys: string[] = [];
  const conversation = draft.conversations[message.conversation_id];
  const shared = conversationSettings(draft, conversation.id);
  const thread = message.parent_id
    ? findThread(draft, message.parent_id)
    : undefined;
  for (const userId of currentMembers(draft, conversation.id)) {
    if (userId === message.author_id) continue;
    const user = draft.users[userId];
    const personal = user?.personal ?? DEFAULT_PERSONAL_PREFERENCES;
    const followed = Boolean(
      thread && user?.followed_thread_ids.includes(thread.id),
    );
    const keywords = [
      ...shared.keywords,
      ...(personal.notifications.keywords ?? []),
    ];
    const keyword = keywords.some(
      (word) =>
        word.trim() &&
        message.body.toLowerCase().includes(word.trim().toLowerCase()),
    );
    const kind = mentioned.has(userId)
      ? "comms-mention"
      : conversation.kind !== "channel"
        ? "comms-direct"
        : followed
          ? "comms-thread-reply"
          : keyword
            ? "comms-keyword"
            : null;
    if (!kind) continue;
    const context = { org_id: draft.org_id, user_id: userId };
    const decision = notificationDecision({
      world: draft,
      context,
      conversation_id: conversation.id,
      shared,
      personal: personal.notifications,
      now: execution.now,
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      text: message.body,
      mentioned: mentioned.has(userId),
      followed_thread: followed,
      preferences: memberPreferences(draft, userId, conversation.id),
      category_preferences:
        conversation.kind === "channel" && conversation.category_id
          ? user?.categories[conversation.category_id]
          : undefined,
    });
    if (!decision.allowed) continue;
    const id = execution.uuid();
    messageUserState(draft, userId).notifications.push({
      id,
      org_id: draft.org_id,
      subject_type: "comms_message",
      subject_id: message.id,
      kind,
      conversation_id: conversation.id,
      message_id: message.id,
      status: "unread",
      scheduled_for: null,
      created_at: new Date(execution.now).toISOString(),
      read_at: null,
    });
    version_keys.push(personalKey(userId));
    publications.push({
      recipient_ids: [userId],
      event: {
        private: true,
        topic: `org:${draft.org_id}:user:${userId}`,
        event: "notification",
        payload: { id },
      },
    });
  }
  return { publications, version_keys };
}

/** Direct sends and the scheduler compose this exact synchronous recipe. */
export const messageSendCommand: MessageSendCommand = (input, dependencies) => {
  assertSendDependencies(dependencies);
  const request = parseSend(input);
  const conversationId = input.conversation_id;
  const parentId = input.parent_id;
  const payload = fingerprint(input, request);
  // Strip the reply-only field when calling the root input validator.
  const ordinaryRequest = {
    client_key: request.client_key,
    body: request.body,
    attachment_ids: request.attachment_ids,
    record_ids: request.record_ids,
    mention_user_ids: request.mention_user_ids,
    mentions_channel: request.mentions_channel,
    mentions_here: request.mentions_here,
    reply_to_id: request.reply_to_id,
  };
  return {
    signal: input.signal,
    authorize(current, execution) {
      assertSendDependencies(dependencies);
      readableConversation(current, execution.context, conversationId);
      const previous = replay(
        current,
        execution.context,
        request.client_key,
        payload,
      );
      if (previous) {
        messageRow(current, execution.context, conversationId, previous);
        return;
      }
      admitSend(
        current,
        execution.context,
        conversationId,
        parentId === null ? ordinaryRequest : request,
        { now: execution.now, parent_id: parentId },
      );
      const conversation = current.conversations[conversationId];
      const scope: C.SettingsScope =
        conversation.kind === "channel"
          ? { kind: "channel", id: conversationId }
          : { kind: "workspace" };
      const capabilities: C.Capability[] = [];
      if (parentId !== null) capabilities.push("reply");
      if (request.attachment_ids.length) capabilities.push("attachFiles");
      if (request.record_ids.length) capabilities.push("linkRecords");
      if (request.mentions_channel || request.mentions_here)
        capabilities.push("mentionChannel");
      for (const capability of capabilities)
        dependencies.authority.assertCapabilityAvailable(execution.context, {
          scope,
          capability,
        });
      dependencies.files.assertSendReady({
        store: dependencies.store,
        current,
        execution,
        conversation_id: conversationId,
        attachment_ids: request.attachment_ids,
      });
    },
    apply(draft, execution) {
      const previous = replay(
        draft,
        execution.context,
        request.client_key,
        payload,
      );
      if (previous)
        return {
          kind: "unchanged",
          value: {
            status: 200,
            message: projectMessage(
              draft,
              execution.context,
              conversationId,
              previous,
            ),
          },
          version_keys: [],
        };
      const seq = (draft.high_water_seq[conversationId] ?? 0) + 1;
      if (!Number.isSafeInteger(seq)) return invalidInput();
      const id = execution.uuid();
      if (Object.hasOwn(draft.messages, id)) return invalidMemoryState();
      const thread =
        parentId === null
          ? undefined
          : stageThread(draft, execution, conversationId, parentId);
      const members = currentMembers(draft, conversationId);
      const mentioned = new Set(request.mention_user_ids);
      if (request.mentions_channel)
        for (const userId of members) mentioned.add(userId);
      if (request.mentions_here) {
        const online = dependencies.presence.onlineUserIds({
          store: dependencies.store,
          org_id: execution.context.org_id,
          now: execution.now,
        });
        for (const userId of online)
          if (members.includes(userId)) mentioned.add(userId);
      }
      mentioned.delete(execution.context.user_id);
      const message: MemoryMessage = {
        id,
        org_id: execution.context.org_id,
        conversation_id: conversationId,
        seq,
        author_id: execution.context.user_id,
        client_key: request.client_key,
        created_at: new Date(execution.now).toISOString(),
        parent_id: parentId,
        reply_to_id: request.reply_to_id,
        also_send_to_channel: request.also_send_to_channel,
        state: "live",
        body: request.body,
        edited_at: null,
        pinned_at: null,
        pinned_by: null,
        attachment_ids: request.attachment_ids,
        record_links: request.record_ids.map((record_id) => ({
          id: execution.uuid(),
          record_id,
        })),
        // Persist actual @here recipients; later reads/replays never sample presence.
        mention_user_ids: [
          ...new Set([...request.mention_user_ids, ...mentioned]),
        ].sort(),
        mentions_channel: request.mentions_channel,
        mentions_here: request.mentions_here,
        reactions: [],
        link_previews: [],
        deleted_at: null,
      };
      draft.messages[id] = message;
      draft.high_water_seq[conversationId] = seq;
      const replayKey = `${execution.context.org_id}:${execution.context.user_id}:${request.client_key}`;
      draft.idempotency[replayKey] = { payload, message_id: id };
      draft.conversations[conversationId].updated_at = message.created_at;
      // A scheduled send is not visible engagement: markRead owns read/reminder state.
      const followedVersions: string[] = [];
      if (
        thread &&
        conversationSettings(draft, conversationId).default_thread_subscription
      ) {
        const user = messageUserState(draft, execution.context.user_id);
        if (!user.followed_thread_ids.includes(thread.id)) {
          user.followed_thread_ids.push(thread.id);
          followedVersions.push(personalKey(execution.context.user_id));
        }
      }
      const notifications = stageNotifications(
        draft,
        execution,
        message,
        mentioned,
      );
      const projected = projectMessage(
        draft,
        execution.context,
        conversationId,
        id,
      );
      if (projected.state !== "live") return invalidMemoryState();
      return {
        kind: "commit",
        failure_point: "send",
        value: { status: 201, message: projected },
        version_keys: [
          `conversation:${conversationId}`,
          messageKey(id),
          ...(parentId === null
            ? []
            : [threadKey(parentId), messageKey(parentId)]),
          ...followedVersions,
          ...notifications.version_keys,
        ],
        publications: [
          ...messagePublications(draft, message, "created"),
          ...notifications.publications,
        ],
      };
    },
  };
};

/** No actor override: moderation must authorize its own capability before composing. */
export const messageRemovalCommand: MessageRemovalCommand = (input) => {
  const {
    conversation_id: conversationId,
    message_id: messageId,
    action,
    options,
  } = input;
  const key = messageKey(messageId);
  return {
    signal: options?.signal,
    conditions: [
      {
        key,
        if_match:
          options && "if_match" in options ? options.if_match : undefined,
      },
    ],
    authorize(current, execution) {
      messageRow(current, execution.context, conversationId, messageId);
      assertMessageChange(
        current,
        execution.context,
        messageId,
        action,
        execution.now,
      );
    },
    apply(draft, execution) {
      const row = draft.messages[messageId];
      if (action === "restore" && !row.deleted_at)
        return {
          kind: "unchanged",
          value: projectMessage(
            draft,
            execution.context,
            conversationId,
            messageId,
          ),
          version_keys: [key],
        };
      if (action !== "delete" && action !== "restore") return notFound();
      row.deleted_at =
        action === "delete" ? new Date(execution.now).toISOString() : null;
      const rootId = row.parent_id ?? row.id;
      return {
        kind: "commit",
        value: projectMessage(
          draft,
          execution.context,
          conversationId,
          messageId,
        ),
        version_keys: [
          key,
          `conversation:${conversationId}`,
          ...(findThread(draft, rootId) ? [threadKey(rootId)] : []),
        ],
        publications: messagePublications(
          draft,
          row,
          action === "delete" ? "deleted" : "edited",
        ),
      };
    },
  };
};

/** Physical content pruning only. The protected caller owns challenge/admission. */
export function stageConversationPurge(
  draft: MemoryCommsState,
  execution: MemoryExecution,
  conversationId: string,
): {
  result: C.PurgeResult;
  released_file_ids: readonly string[];
  version_keys: readonly MemoryVersionKey[];
  publications: readonly MemoryPublication[];
} {
  const target = draft.conversations[conversationId];
  if (!target || target.org_id !== execution.context.org_id) return notFound();
  const messages = Object.values(draft.messages).filter(
    (m) => m.conversation_id === conversationId,
  );
  const messageIds = new Set(messages.map((m) => m.id));
  const files = Object.values(draft.files).filter(
    (f) => f.conversation_id === conversationId,
  );
  const threads = Object.values(draft.threads).filter(
    (t) => t.conversation_id === conversationId,
  );
  const threadIds = new Set(threads.map((t) => t.id));
  const keys = new Set<string>([
    `conversation:${conversationId}`,
    `configuration:channel:${conversationId}`,
    `capabilities:channel:${conversationId}`,
    `retention:channel:${conversationId}`,
    ...messages.map((m) => messageKey(m.id)),
    ...threads.map((t) => threadKey(t.root_message_id)),
    ...files.map((f) => `file:${f.id}`),
  ]);
  for (const row of messages) {
    delete draft.messages[row.id];
    delete draft.revisions[row.id];
  }
  for (const row of threads) delete draft.threads[row.id];
  for (const row of files) delete draft.files[row.id];
  for (const [key, value] of Object.entries(draft.idempotency))
    if (messageIds.has(value.message_id)) delete draft.idempotency[key];
  for (const [id, user] of Object.entries(draft.users)) {
    const affected =
      Object.hasOwn(user.conversations, conversationId) ||
      Object.hasOwn(user.last_read_seq, conversationId) ||
      user.followed_thread_ids.some((key) => threadIds.has(key)) ||
      user.notifications.some((n) => n.conversation_id === conversationId);
    if (!affected) continue;
    delete user.conversations[conversationId];
    delete user.last_read_seq[conversationId];
    user.followed_thread_ids = user.followed_thread_ids.filter(
      (id) => !threadIds.has(id),
    );
    user.notifications = user.notifications.filter(
      (n) => n.conversation_id !== conversationId,
    );
    keys.add(personalKey(id));
    keys.add(`member-preferences:${id}:${conversationId}`);
  }
  for (const row of Object.values(draft.reports)) {
    if (row.conversation_id !== conversationId) continue;
    delete draft.reports[row.id];
    keys.add(`report:${row.id}`);
  }
  const timestamp = new Date(execution.now).toISOString();
  for (const row of Object.values(draft.schedules)) {
    if (
      row.request.conversation_id !== conversationId ||
      (row.status !== "pending" && row.status !== "running")
    )
      continue;
    draft.schedules[row.id] = {
      ...row,
      status: "failed",
      failure_code: "access_lost",
      message_id: null,
      updated_at: timestamp,
    };
    keys.add(`schedule:${row.id}`);
  }
  for (const row of Object.values(draft.exports)) {
    if (
      !row.request.conversation_ids.includes(conversationId) ||
      (row.status !== "pending" && row.status !== "running")
    )
      continue;
    draft.exports[row.id] = {
      ...row,
      status: "failed",
      failure_code: "access_lost",
      updated_at: timestamp,
    };
    keys.add(`export:${row.id}`);
  }
  for (const row of Object.values(draft.history)) {
    if (row.scope.kind !== "channel" || row.scope.id !== conversationId)
      continue;
    delete draft.history[row.id];
    keys.add(`history:${row.id}`);
  }
  delete draft.configuration[`channel:${conversationId}`];
  delete draft.retention[`channel:${conversationId}`];
  delete draft.members[conversationId];
  delete draft.high_water_seq[conversationId];
  delete draft.conversations[conversationId];
  return {
    result: {
      org_id: execution.context.org_id,
      conversation_id: conversationId,
      operation_id: execution.uuid(),
      purged_message_count: messages.length,
      purged_file_count: files.length,
    },
    released_file_ids: files.map((f) => f.id),
    version_keys: [...keys],
    publications: structurePublications(draft),
  };
}
