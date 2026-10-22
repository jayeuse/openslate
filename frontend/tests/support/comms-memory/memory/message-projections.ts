import type * as S from "@/components/systems/comms/contract/schemas";
import type * as C from "@/components/systems/comms/contract/types";
import {
  activePerson,
  conversationAccess,
  notFound,
  ownedConversation,
} from "../domain/access";
import {
  DEFAULT_PERSONAL_PREFERENCES,
  resolveSettings,
} from "../domain/settings";
import { compare, page } from "./conversation-structure";
import type { MemoryCommsState, MemoryMessage } from "./model";
import type { MemoryPublication } from "./store-types";

export const messageKey = (id: string) => `message:${id}`;
export const threadKey = (rootId: string) => `thread:${rootId}`;
export const personalKey = (userId: string) => `personal:${userId}`;
export const memberPreferencesKey = (userId: string, id: string) =>
  `member-preferences:${userId}:${id}`;

export function memberPreferences(
  state: Readonly<MemoryCommsState>,
  userId: string,
  conversationId: string,
): C.MemberPreferences {
  return (
    state.users[userId]?.conversations[conversationId] ?? {
      notify: "all",
      mute: { kind: "off" },
      starred: false,
      hidden: false,
      manual_unread: false,
    }
  );
}

/** Called only by command apply, never by a read projection. */
export function messageUserState(state: MemoryCommsState, userId: string) {
  return (state.users[userId] ??= {
    personal: structuredClone(DEFAULT_PERSONAL_PREFERENCES),
    conversations: {},
    categories: {},
    last_read_seq: {},
    followed_thread_ids: [],
    notifications: [],
  });
}

export function readableConversation(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  conversationId: string,
) {
  const row = ownedConversation(state, context, conversationId);
  if (conversationAccess(state, context, conversationId).level === "none")
    return notFound();
  return row;
}

export function conversationSettings(
  state: Readonly<MemoryCommsState>,
  conversationId: string,
) {
  const row = state.conversations[conversationId];
  if (!row) return notFound();
  return resolveSettings(
    state,
    row.kind === "channel"
      ? { kind: "channel", id: conversationId }
      : { kind: "workspace" },
  ).effective;
}

export function messageRow(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  conversationId: string,
  messageId: string,
) {
  readableConversation(state, context, conversationId);
  const row = state.messages[messageId];
  if (
    !row ||
    row.org_id !== context.org_id ||
    row.conversation_id !== conversationId
  )
    return notFound();
  return row;
}

export function rootMessage(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  conversationId: string,
  rootId: string,
) {
  const row = messageRow(state, context, conversationId, rootId);
  if (row.parent_id !== null) return notFound();
  return row;
}

export function findThread(state: Readonly<MemoryCommsState>, rootId: string) {
  return Object.values(state.threads).find((t) => t.root_message_id === rootId);
}

export function projectThread(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  conversationId: string,
  rootId: string,
): C.Thread {
  rootMessage(state, context, conversationId, rootId);
  const thread = findThread(state, rootId);
  if (!thread || thread.conversation_id !== conversationId) return notFound();
  const replies = Object.values(state.messages)
    .filter(
      (m) => m.conversation_id === conversationId && m.parent_id === rootId,
    )
    .sort((a, b) => a.seq - b.seq);
  return {
    id: thread.id,
    org_id: thread.org_id,
    conversation_id: conversationId,
    root_message_id: rootId,
    name: thread.name,
    resolved: thread.resolved,
    locked: thread.locked,
    archived: thread.archived,
    followed:
      state.users[context.user_id]?.followed_thread_ids.includes(thread.id) ??
      false,
    reply_count: replies.length,
    last_reply_at: replies.at(-1)?.created_at ?? null,
  };
}

export function projectRecordLink(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  message: MemoryMessage,
  link: MemoryMessage["record_links"][number],
): C.RecordReference {
  messageRow(state, context, message.conversation_id, message.id);
  if (message.deleted_at) return notFound();
  const person = activePerson(state, context);
  const record = state.records[link.record_id];
  const linkedModule = record && state.modules[record.module_id];
  if (
    !record ||
    record.org_id !== context.org_id ||
    linkedModule?.org_id !== context.org_id ||
    !person.readable_module_ids.includes(record.module_id)
  )
    return { id: link.id, state: "unavailable" };
  const fields = conversationSettings(
    state,
    message.conversation_id,
  ).record_card_fields;
  return {
    id: link.id,
    state: "available",
    record_id: record.id,
    module_id: linkedModule.id,
    module_name: linkedModule.name,
    title: record.title,
    fields: record.fields.filter((field) => fields.includes(field.field_id)),
  };
}

/** One redacting projection for ordinary reads, command results and replay. */
export function projectMessage(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  conversationId: string,
  messageId: string,
): C.Message {
  const row = messageRow(state, context, conversationId, messageId);
  const rootId = row.parent_id ?? row.id;
  const identity = {
    id: row.id,
    org_id: row.org_id,
    conversation_id: row.conversation_id,
    seq: row.seq,
    author_id: row.author_id,
    client_key: row.client_key,
    created_at: row.created_at,
    parent_id: row.parent_id,
    reply_to_id: row.reply_to_id,
    also_send_to_channel: row.also_send_to_channel,
    thread: findThread(state, rootId)
      ? projectThread(state, context, conversationId, rootId)
      : null,
  };
  if (row.deleted_at)
    return { ...identity, state: "deleted", deleted_at: row.deleted_at };
  const attachments: C.Attachment[] = [];
  for (const id of row.attachment_ids) {
    const file = state.files[id];
    if (
      file?.org_id === context.org_id &&
      !file.is_deleted &&
      file.state === "ready" &&
      file.actual_size &&
      file.media_type
    )
      attachments.push({
        id,
        filename: file.filename,
        size: file.actual_size,
        media_type: file.media_type,
      });
  }
  return {
    ...identity,
    state: "live",
    body: row.body,
    edited_at: row.edited_at,
    pinned_at: row.pinned_at,
    pinned_by: row.pinned_by,
    attachments,
    record_references: row.record_links.map((link) =>
      projectRecordLink(state, context, row, link),
    ),
    mention_user_ids: row.mention_user_ids,
    mentions_channel: row.mentions_channel,
    mentions_here: row.mentions_here,
    reactions: row.reactions,
    link_previews: row.link_previews,
  };
}

export function readableMessageRows(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
) {
  activePerson(state, context);
  return Object.values(state.messages).filter(
    (m) =>
      m.org_id === context.org_id &&
      conversationAccess(state, context, m.conversation_id).level !== "none",
  );
}

export type ProjectReadSummary = (
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  conversationId: string,
) => Pick<
  C.ConversationSummary,
  | "preferences"
  | "last_read_seq"
  | "high_water_seq"
  | "unread_count"
  | "mention_count"
  | "first_unread_seq"
>;

export const projectReadSummary: ProjectReadSummary = (state, context, id) => {
  readableConversation(state, context, id);
  const highWater = state.high_water_seq[id] ?? 0;
  const lastRead = Math.min(
    state.users[context.user_id]?.last_read_seq[id] ?? 0,
    highWater,
  );
  const unread = Object.values(state.messages).filter(
    (m) =>
      m.conversation_id === id &&
      m.org_id === context.org_id &&
      m.author_id !== context.user_id &&
      !m.deleted_at &&
      m.seq > lastRead,
  );
  return {
    preferences: memberPreferences(state, context.user_id, id),
    last_read_seq: lastRead,
    high_water_seq: highWater,
    unread_count: Math.min(100, unread.length),
    mention_count: Math.min(
      100,
      unread.filter(
        (m) =>
          m.mention_user_ids.includes(context.user_id) ||
          (m.mentions_channel &&
            (state.conversations[id]?.kind === "channel" ||
              Boolean(state.members[id]?.[context.user_id]))),
      ).length,
    ),
    first_unread_seq: unread.length
      ? Math.min(...unread.map((m) => m.seq))
      : null,
  };
};

export function projectHistory(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  conversationId: string,
  rootId: string | null,
  request: ReturnType<typeof S.historyRequestSchema.parse>,
): C.HistoryPage {
  readableConversation(state, context, conversationId);
  if (rootId !== null) projectThread(state, context, conversationId, rootId);
  const rows = Object.values(state.messages)
    .filter(
      (m) =>
        m.conversation_id === conversationId &&
        (rootId === null
          ? m.parent_id === null || m.also_send_to_channel
          : m.parent_id === rootId),
    )
    .sort((a, b) => a.seq - b.seq);
  const {
    limit,
    after_seq: after,
    before_seq: before,
    around_seq: around,
  } = request;
  let selected: MemoryMessage[];
  if (after !== undefined)
    selected = rows.filter((m) => m.seq > after).slice(0, limit);
  else if (before !== undefined)
    selected = rows.filter((m) => m.seq < before).slice(-limit);
  else if (around !== undefined) {
    const pivot = rows.findIndex((m) => m.seq >= around);
    const start = Math.max(
      0,
      Math.min(
        rows.length - limit,
        (pivot < 0 ? rows.length : pivot) - Math.floor(limit / 2),
      ),
    );
    selected = rows.slice(start, start + limit);
  } else selected = rows.slice(-limit);
  const first = selected[0]?.seq ?? null;
  const last = selected.at(-1)?.seq ?? null;
  return {
    org_id: context.org_id,
    conversation_id: conversationId,
    thread_root_id: rootId,
    items: selected.map((m) =>
      projectMessage(state, context, conversationId, m.id),
    ),
    pagination: {
      limit,
      count: selected.length,
      first_seq: first,
      last_seq: last,
      high_water_seq: state.high_water_seq[conversationId] ?? 0,
      has_older:
        first !== null
          ? rows.some((m) => m.seq < first)
          : after !== undefined && rows.some((m) => m.seq <= after),
      has_newer:
        last !== null
          ? rows.some((m) => m.seq > last)
          : before !== undefined && rows.some((m) => m.seq >= before),
    },
  };
}

export function messagePublications(
  state: Readonly<MemoryCommsState>,
  message: MemoryMessage,
  kind: Extract<C.CommsEvent, { event: "message" }>["payload"]["kind"],
): MemoryPublication[] {
  const recipient_ids = Object.values(state.people)
    .filter(
      (person) =>
        person.active &&
        person.org_id === state.org_id &&
        conversationAccess(
          state,
          { org_id: state.org_id, user_id: person.user_id },
          message.conversation_id,
        ).level !== "none",
    )
    .map((person) => person.user_id);
  return [
    {
      recipient_ids,
      event: {
        private: true,
        topic: `org:${state.org_id}:conversation:${message.conversation_id}`,
        event: "message",
        payload: {
          conversation_id: message.conversation_id,
          seq: message.seq,
          kind,
        },
      },
    },
  ];
}

export function timeSort<T>(
  items: T[],
  request: { sort_order: "asc" | "desc" },
  timestamp: (item: T) => string,
  identity: (item: T) => string,
) {
  return items.sort(
    (a, b) =>
      (compare(timestamp(a), timestamp(b)) ||
        compare(identity(a), identity(b))) *
      (request.sort_order === "asc" ? 1 : -1),
  );
}

export function projectThreadList(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  request: ReturnType<typeof S.threadListRequestSchema.parse>,
): C.Page<C.Thread> {
  const visible = new Set(
    readableMessageRows(state, context)
      .filter((m) => m.parent_id === null)
      .map((m) => m.id),
  );
  const threads = Object.values(state.threads)
    .filter((t) => visible.has(t.root_message_id))
    .map((t) =>
      projectThread(state, context, t.conversation_id, t.root_message_id),
    )
    .filter(
      (t) =>
        t.archived === request.archived &&
        (request.followed === undefined || t.followed === request.followed) &&
        (request.resolved === undefined || t.resolved === request.resolved),
    );
  return page(
    timeSort(
      threads,
      request,
      (thread) =>
        request.sort_by === "updated_at"
          ? (thread.last_reply_at ??
            state.messages[thread.root_message_id].created_at)
          : state.messages[thread.root_message_id].created_at,
      (thread) => thread.id,
    ),
    request,
  );
}

export function projectPins(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  conversationId: string,
  request: ReturnType<typeof S.timeListRequestSchema.parse>,
): C.Page<C.Message> {
  readableConversation(state, context, conversationId);
  const rows = Object.values(state.messages).filter(
    (m) => m.conversation_id === conversationId && m.pinned_at && !m.deleted_at,
  );
  const sorted = timeSort(
    rows,
    request,
    (m) => (request.sort_by === "updated_at" ? m.pinned_at! : m.created_at),
    (m) => m.id,
  );
  return page(
    sorted.map((m) => projectMessage(state, context, conversationId, m.id)),
    request,
  );
}

export function projectLinkedRecords(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  request: ReturnType<typeof S.timeListRequestSchema.parse>,
): C.Page<C.RecordReference> {
  const rows = readableMessageRows(state, context)
    .filter((m) => !m.deleted_at)
    .flatMap((message) =>
      message.record_links.map((link) => ({ message, link })),
    );
  const sorted = timeSort(
    rows,
    request,
    ({ message }) =>
      request.sort_by === "updated_at"
        ? (message.edited_at ?? message.created_at)
        : message.created_at,
    ({ link }) => link.id,
  );
  return page(
    sorted.map(({ message, link }) =>
      projectRecordLink(state, context, message, link),
    ),
    request,
  );
}

export function projectSearch(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  query: ReturnType<typeof S.searchRequestSchema.parse>,
): C.Page<C.SearchHit> {
  const needle = query.q.toLowerCase();
  const hits = readableMessageRows(state, context)
    .filter((m) => {
      const day = new Date(m.created_at).toISOString().slice(0, 10);
      if (m.deleted_at || !m.body.toLowerCase().includes(needle)) return false;
      if (query.from && m.author_id !== query.from) return false;
      if (query.in && m.conversation_id !== query.in) return false;
      if (query.after && day <= query.after) return false;
      if (query.before && day >= query.before) return false;
      if (query.on && day !== query.on) return false;
      if (
        query.has === "file" &&
        !m.attachment_ids.some(
          (id) =>
            state.files[id]?.state === "ready" && !state.files[id].is_deleted,
        )
      )
        return false;
      if (
        query.has === "record" &&
        !m.record_links.some(
          (link) =>
            projectRecordLink(state, context, m, link).state === "available",
        )
      )
        return false;
      if (
        query.has === "link" &&
        !/https?:\/\//i.test(m.body) &&
        !m.link_previews.length
      )
        return false;
      if (query.is === "pinned" && !m.pinned_at) return false;
      if (
        query.is === "thread" &&
        m.parent_id === null &&
        !findThread(state, m.id)
      )
        return false;
      return true;
    })
    .map((m): C.SearchHit => {
      const conversation = state.conversations[m.conversation_id];
      const matches: C.SearchHit["matches"] = [];
      if (needle) {
        const text = m.body.toLowerCase();
        // Match the whole lowercased text, but index the original excerpt's code points.
        // A point may occupy two UTF-16 units or expand during lowercase conversion.
        const originalPoints: number[] = [];
        let pointIndex = 0;
        for (const point of m.body) {
          for (let unit = 0; unit < point.toLowerCase().length; unit++)
            originalPoints.push(pointIndex);
          pointIndex++;
        }
        let at = text.indexOf(needle);
        while (at !== -1) {
          matches.push({
            start: originalPoints[at],
            end: originalPoints[at + needle.length - 1] + 1,
          });
          at = text.indexOf(needle, at + needle.length);
        }
      }
      return {
        message_id: m.id,
        conversation_id: m.conversation_id,
        conversation_name:
          conversation.kind === "direct"
            ? "Direct conversation"
            : conversation.name,
        seq: m.seq,
        author_id: m.author_id,
        author_name: state.people[m.author_id].display_name,
        created_at: m.created_at,
        excerpt: m.body,
        matches,
        parent_id: m.parent_id,
      };
    });
  hits.sort((a, b) => {
    const primary =
      query.sort_by === "relevance"
        ? compare(a.matches.length, b.matches.length)
        : compare(a.created_at, b.created_at);
    return (
      (primary ||
        compare(a.created_at, b.created_at) ||
        compare(a.message_id, b.message_id)) *
      (query.sort_order === "asc" ? 1 : -1)
    );
  });
  return page(hits, query);
}
