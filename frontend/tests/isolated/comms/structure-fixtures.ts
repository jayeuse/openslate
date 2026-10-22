import * as api from "../../../src/components/systems/comms/adapters/structure-api";

export const org = "00000000-0000-4000-8000-000000000001";
export const user = "00000000-0000-4000-8000-000000000002";
export const conversationId = "00000000-0000-4000-8000-000000000003";
export const categoryId = "00000000-0000-4000-8000-000000000004";
export const peer = "00000000-0000-4000-8000-000000000005";
export const other = "00000000-0000-4000-8000-000000000006";
export const context = { org_id: org, user_id: user };
export const timestamp = "2026-10-19T08:00:00Z";
export const etag = '"structure-2"';
export const conditional = { if_match: '"structure-1"' };
export const categoryRequest = {
  name: "Shifts",
  position: 2,
  department_id: null,
};
export const channelRequest = {
  name: "Dispatch",
  topic: "",
  position: 0,
  category_id: categoryId,
  scope: "organization" as const,
};
export const category = {
  ...categoryRequest,
  id: categoryId,
  org_id: org,
  created_at: timestamp,
  updated_at: timestamp,
};
const identity = {
  id: conversationId,
  org_id: org,
  created_at: timestamp,
  updated_at: timestamp,
  archived_at: null,
  level: "manage",
  member_count: 3,
  member_role: "manager",
};
export const channel = { ...identity, ...channelRequest, kind: "channel" };
export const direct = {
  ...identity,
  kind: "direct",
  participant_ids: [peer, user],
  member_count: 2,
};
export const group = {
  ...identity,
  kind: "group",
  name: "Team",
  participant_ids: [peer, other, user],
};
export const member = {
  user_id: peer,
  display_name: "Peer",
  member_role: "manager",
  level: "manage",
  joined_at: timestamp,
  departments: [],
};
export const block = { blocked_user_id: peer, created_at: timestamp };
export const conversationPath = `/api/comms/conversations/${conversationId}`;
export const categoryPath = `/api/comms/categories/${categoryId}`;
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

type Call = {
  name: string;
  invoke: () => Promise<unknown>;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  wire: unknown;
  status: number;
  expected: unknown;
  location?: string;
  conditional?: boolean;
};

export function calls(signal?: AbortSignal): Call[] {
  const options = { signal };
  const condition = { ...conditional, signal };
  const duplicate = { ...channel, id: other };
  return [
    {
      name: "list conversations",
      invoke: () => api.listConversations(context, {}, options),
      method: "GET",
      path: "/api/comms/conversations",
      status: 200,
      query: {
        limit: "25",
        offset: "0",
        sort_by: "position",
        sort_order: "asc",
        archived: "false",
      },
      wire: page([channel]),
      expected: page([channel]),
    },
    {
      name: "get conversation",
      invoke: () => api.getConversation(context, conversationId, options),
      method: "GET",
      path: conversationPath,
      status: 200,
      wire: channel,
      expected: { data: channel, etag },
    },
    {
      name: "list categories",
      invoke: () => api.listCategories(context, {}, options),
      method: "GET",
      path: "/api/comms/categories",
      status: 200,
      query: {
        limit: "25",
        offset: "0",
        sort_by: "position",
        sort_order: "asc",
      },
      wire: page([category]),
      expected: page([category]),
    },
    {
      name: "get category",
      invoke: () => api.getCategory(context, categoryId, options),
      method: "GET",
      path: categoryPath,
      status: 200,
      wire: category,
      expected: { data: category, etag },
    },
    {
      name: "create category",
      invoke: () => api.createCategory(context, categoryRequest, options),
      method: "POST",
      path: "/api/comms/categories",
      status: 201,
      body: categoryRequest,
      wire: category,
      expected: { data: category, etag },
      location: categoryPath,
    },
    {
      name: "update category",
      invoke: () =>
        api.updateCategory(context, categoryId, categoryRequest, condition),
      method: "PUT",
      path: categoryPath,
      status: 200,
      body: categoryRequest,
      conditional: true,
      wire: category,
      expected: { data: category, etag },
    },
    {
      name: "create channel",
      invoke: () => api.createChannel(context, channelRequest, options),
      method: "POST",
      path: "/api/comms/conversations",
      status: 201,
      body: channelRequest,
      wire: channel,
      expected: { data: channel, etag },
      location: conversationPath,
    },
    {
      name: "move channel",
      invoke: () =>
        api.updateChannel(
          context,
          conversationId,
          { category_id: null, position: 4 },
          condition,
        ),
      method: "PATCH",
      path: conversationPath,
      status: 200,
      body: { category_id: null, position: 4 },
      conditional: true,
      wire: { ...channel, category_id: null, position: 4 },
      expected: { data: { ...channel, category_id: null, position: 4 }, etag },
    },
    {
      name: "archive",
      invoke: () => api.archiveConversation(context, conversationId, condition),
      method: "POST",
      path: `${conversationPath}/archive`,
      status: 200,
      conditional: true,
      wire: { ...channel, archived_at: timestamp },
      expected: { data: { ...channel, archived_at: timestamp }, etag },
    },
    {
      name: "restore",
      invoke: () => api.restoreConversation(context, conversationId, condition),
      method: "POST",
      path: `${conversationPath}/restore`,
      status: 200,
      conditional: true,
      wire: channel,
      expected: { data: channel, etag },
    },
    {
      name: "new direct",
      invoke: () =>
        api.findOrCreateDirect(context, { recipient_id: peer }, options),
      method: "POST",
      path: "/api/comms/directs",
      status: 201,
      body: { recipient_id: peer },
      wire: direct,
      expected: { data: direct, etag },
      location: conversationPath,
    },
    {
      name: "existing direct",
      invoke: () =>
        api.findOrCreateDirect(context, { recipient_id: peer }, options),
      method: "POST",
      path: "/api/comms/directs",
      status: 200,
      body: { recipient_id: peer },
      wire: direct,
      expected: { data: direct, etag },
    },
    {
      name: "create group",
      invoke: () =>
        api.createGroup(
          context,
          { name: "Team", participant_ids: [user, peer, other] },
          options,
        ),
      method: "POST",
      path: "/api/comms/groups",
      status: 201,
      body: { name: "Team", participant_ids: [user, peer, other] },
      wire: group,
      expected: { data: group, etag },
      location: conversationPath,
    },
    {
      name: "list members",
      invoke: () => api.listMembers(context, conversationId, {}, options),
      method: "GET",
      path: `${conversationPath}/members`,
      status: 200,
      query: {
        limit: "25",
        offset: "0",
        sort_by: "display_name",
        sort_order: "asc",
      },
      wire: page([member]),
      expected: page([member]),
    },
    {
      name: "set member role",
      invoke: () =>
        api.setMemberRole(
          context,
          conversationId,
          peer,
          { role: "manager" },
          condition,
        ),
      method: "PUT",
      path: `${conversationPath}/members/${peer}`,
      status: 200,
      body: { role: "manager" },
      conditional: true,
      wire: member,
      expected: member,
    },
    {
      name: "remove member",
      invoke: () => api.removeMember(context, conversationId, peer, condition),
      method: "DELETE",
      path: `${conversationPath}/members/${peer}`,
      status: 204,
      conditional: true,
      wire: null,
      expected: undefined,
    },
    {
      name: "duplicate channel",
      invoke: () =>
        api.duplicateChannel(
          context,
          conversationId,
          { name: "Copy", category_id: categoryId },
          condition,
        ),
      method: "POST",
      path: `${conversationPath}/duplicates`,
      status: 201,
      body: { name: "Copy", category_id: categoryId },
      conditional: true,
      wire: duplicate,
      expected: { data: duplicate, etag },
      location: `/api/comms/conversations/${other}`,
    },
    {
      name: "list direct blocks",
      invoke: () => api.listDirectBlocks(context, {}, options),
      method: "GET",
      path: "/api/comms/direct-blocks",
      status: 200,
      query: {
        limit: "25",
        offset: "0",
        sort_by: "created_at",
        sort_order: "asc",
      },
      wire: page([block]),
      expected: page([block]),
    },
    {
      name: "block direct",
      invoke: () =>
        api.blockDirect(context, { blocked_user_id: peer }, options),
      method: "POST",
      path: "/api/comms/direct-blocks",
      status: 204,
      body: { blocked_user_id: peer },
      wire: null,
      expected: undefined,
    },
    {
      name: "unblock direct",
      invoke: () => api.unblockDirect(context, peer, options),
      method: "DELETE",
      path: `/api/comms/direct-blocks/${peer}`,
      status: 204,
      wire: null,
      expected: undefined,
    },
  ];
}
