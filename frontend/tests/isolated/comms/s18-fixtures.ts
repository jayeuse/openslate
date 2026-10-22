export const org = "00000000-0000-4000-8000-000000000001";
export const user = "00000000-0000-4000-8000-000000000002";
export const conversationId = "00000000-0000-4000-8000-000000000003";
export const rootId = "00000000-0000-4000-8000-000000000004";
export const messageId = "00000000-0000-4000-8000-000000000005";
export const key = "00000000-0000-4000-8000-000000000006";
export const other = "00000000-0000-4000-8000-000000000007";
export const fileId = "00000000-0000-4000-8000-000000000008";
export const context = { org_id: org, user_id: user };
export const timestamp = "2026-10-19T08:00:00Z";
export const etag = '"thread-2"';
export const conditional = { if_match: '"thread-1"' };
export const threadPath = `/api/comms/conversations/${conversationId}/threads/${rootId}`;
export const messagePath = `/api/comms/conversations/${conversationId}/messages/${messageId}`;
export const thread = {
  id: other,
  org_id: org,
  conversation_id: conversationId,
  root_message_id: rootId,
  name: "Dispatch",
  resolved: false,
  locked: false,
  archived: false,
  followed: false,
  reply_count: 1,
  last_reply_at: timestamp,
};
const identity = {
  id: messageId,
  org_id: org,
  conversation_id: conversationId,
  seq: 7,
  author_id: user,
  client_key: key,
  created_at: timestamp,
  parent_id: rootId,
  reply_to_id: null,
  also_send_to_channel: true,
  thread: null,
};
export const live = {
  ...identity,
  state: "live",
  body: "Current reply",
  edited_at: timestamp,
  pinned_at: null,
  pinned_by: null,
  attachments: [],
  record_references: [],
  mention_user_ids: [],
  mentions_channel: false,
  mentions_here: false,
  reactions: [],
  link_previews: [],
};
export const tombstone = {
  ...identity,
  state: "deleted",
  deleted_at: timestamp,
};
export const replyRequest = {
  client_key: key,
  body: "Original reply",
  also_send_to_channel: true,
};
export const history = {
  org_id: org,
  conversation_id: conversationId,
  thread_root_id: rootId,
  items: [live],
  pagination: {
    limit: 50,
    count: 1,
    first_seq: 7,
    last_seq: 7,
    high_water_seq: 9,
    has_older: true,
    has_newer: true,
  },
};
export const page = (items: unknown[]) => ({
  items,
  pagination: {
    limit: 25,
    offset: 0,
    count: items.length,
    total: items.length,
    has_more: false,
  },
});
export const reservation = { filename: "résumé.pdf", expected_size: 5 };
export const file = {
  id: fileId,
  org_id: org,
  conversation_id: conversationId,
  creator_id: user,
  purpose: "comms_attachment",
  ...reservation,
  actual_size: null,
  media_type: null,
  state: "awaiting_upload",
  failure_code: null,
  is_deleted: false,
  created_at: timestamp,
  updated_at: timestamp,
};
export const ready = {
  ...file,
  actual_size: 5,
  media_type: "application/pdf",
  state: "ready",
};
export const downloadHeaders = {
  "Content-Type": "application/pdf",
  "Content-Disposition": "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Content-Length": "5",
};
export const unavailable = { id: other, state: "unavailable" };
export const available = {
  id: other,
  state: "available",
  record_id: rootId,
  module_id: key,
  module_name: "Cases",
  title: "Dispatch case",
  fields: [],
};
