import { z } from "zod";
import { apiFetchWithMetadata } from "@/lib/api";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import {
  conditionalOptions,
  inContext,
  requestOptions,
  responseData,
  structurePageSchema,
  versioned,
} from "./structure-contract";

// S17 structure routes only; authorization remains server-owned. No UI cutover.
function conversationPath(id: string) {
  z.uuid().parse(id);
  return `/comms/conversations/${encodeURIComponent(id)}`;
}

function categoryPath(id: string) {
  z.uuid().parse(id);
  return `/comms/categories/${encodeURIComponent(id)}`;
}

function queryString(request: object) {
  return new URLSearchParams(
    Object.entries(request)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  ).toString();
}

export async function listConversations(
  context: C.CommsContext,
  input: C.ConversationListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.Conversation>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.conversationListRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `/comms/conversations?${queryString(request)}`,
      structurePageSchema(
        S.conversationSchema.refine(inContext(bound)),
        request,
      ),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function getConversation(
  context: C.CommsContext,
  id: string,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Conversation>> {
  const bound = S.commsContextSchema.parse(context);
  return versioned(
    await apiFetchWithMetadata(
      conversationPath(id),
      S.conversationSchema.refine(inContext(bound, id)),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function listCategories(
  context: C.CommsContext,
  input: C.CategoryListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.Category>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.categoryListRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `/comms/categories?${queryString(request)}`,
      structurePageSchema(S.categorySchema.refine(inContext(bound)), request),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function getCategory(
  context: C.CommsContext,
  id: string,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Category>> {
  const bound = S.commsContextSchema.parse(context);
  return versioned(
    await apiFetchWithMetadata(
      categoryPath(id),
      S.categorySchema.refine(inContext(bound, id)),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function createCategory(
  context: C.CommsContext,
  input: C.CategoryRequest,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Category>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.categoryRequestSchema.parse(input);
  return versioned(
    await apiFetchWithMetadata(
      "/comms/categories",
      S.categorySchema.refine(inContext(bound)),
      {
        ...requestOptions(bound, options),
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
    [201],
    "/comms/categories",
  );
}

export async function updateCategory(
  context: C.CommsContext,
  id: string,
  input: C.CategoryRequest,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.Category>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.categoryRequestSchema.parse(input);
  return versioned(
    await apiFetchWithMetadata(
      categoryPath(id),
      S.categorySchema.refine(inContext(bound, id)),
      {
        ...conditionalOptions(bound, options),
        method: "PUT",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function createChannel(
  context: C.CommsContext,
  input: C.ChannelRequest,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Channel>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.channelRequestSchema.parse(input);
  return versioned(
    await apiFetchWithMetadata(
      "/comms/conversations",
      S.channelSchema.refine(
        (value) =>
          inContext(bound)(value) &&
          value.category_id === request.category_id &&
          value.scope === request.scope &&
          (request.scope !== "department" ||
            (value.scope === "department" &&
              value.department_id === request.department_id)),
      ),
      {
        ...requestOptions(bound, options),
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
    [201],
    "/comms/conversations",
  );
}

export async function updateChannel(
  context: C.CommsContext,
  id: string,
  input: C.ChannelPatch,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.Channel>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.channelPatchSchema.parse(input);
  return versioned(
    await apiFetchWithMetadata(
      conversationPath(id),
      S.channelSchema.refine(inContext(bound, id)),
      {
        ...conditionalOptions(bound, options),
        method: "PATCH",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function archiveConversation(
  context: C.CommsContext,
  id: string,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.Conversation>> {
  const bound = S.commsContextSchema.parse(context);
  return versioned(
    await apiFetchWithMetadata(
      `${conversationPath(id)}/archive`,
      S.conversationSchema.refine(inContext(bound, id)),
      { ...conditionalOptions(bound, options), method: "POST" },
    ),
  );
}

export async function restoreConversation(
  context: C.CommsContext,
  id: string,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.Conversation>> {
  const bound = S.commsContextSchema.parse(context);
  return versioned(
    await apiFetchWithMetadata(
      `${conversationPath(id)}/restore`,
      S.conversationSchema.refine(inContext(bound, id)),
      { ...conditionalOptions(bound, options), method: "POST" },
    ),
  );
}

export async function findOrCreateDirect(
  context: C.CommsContext,
  input: C.DirectRequest,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.DirectConversation>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.directRequestSchemaFor(bound).parse(input);
  return versioned(
    await apiFetchWithMetadata(
      "/comms/directs",
      S.directSchema.refine(
        (value) =>
          inContext(bound)(value) &&
          value.participant_ids.includes(bound.user_id) &&
          value.participant_ids.includes(request.recipient_id),
      ),
      {
        ...requestOptions(bound, options),
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
    [200, 201],
    "/comms/conversations",
  );
}

export async function createGroup(
  context: C.CommsContext,
  input: C.GroupRequest,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.GroupConversation>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.groupRequestSchemaFor(bound).parse(input);
  return versioned(
    await apiFetchWithMetadata(
      "/comms/groups",
      S.groupSchema.refine(
        (value) =>
          inContext(bound)(value) &&
          value.participant_ids.length === request.participant_ids.length &&
          value.participant_ids.every((id) =>
            request.participant_ids.includes(id),
          ),
      ),
      {
        ...requestOptions(bound, options),
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
    [201],
    "/comms/conversations",
  );
}

export async function listMembers(
  context: C.CommsContext,
  conversationId: string,
  input: C.MemberListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.Member>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.memberListRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `${conversationPath(conversationId)}/members?${queryString(request)}`,
      structurePageSchema(S.memberSchema, request),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function setChannelAccess(
  context: C.CommsContext,
  conversationId: string,
  input: C.AccessRequest,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.Channel>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.accessRequestSchema.parse(input);
  return versioned(
    await apiFetchWithMetadata(
      `${conversationPath(conversationId)}/access`,
      S.channelSchema.refine(inContext(bound, conversationId)),
      {
        ...conditionalOptions(bound, options),
        method: "PUT",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function setMemberRole(
  context: C.CommsContext,
  conversationId: string,
  userId: string,
  input: C.MemberRoleRequest,
  options: C.ConditionalOptions,
): Promise<C.Member> {
  const bound = S.commsContextSchema.parse(context);
  z.uuid().parse(userId);
  const request = S.memberRoleRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `${conversationPath(conversationId)}/members/${encodeURIComponent(userId)}`,
      S.memberSchema.refine((value) => value.user_id === userId),
      {
        ...conditionalOptions(bound, options),
        method: "PUT",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function removeMember(
  context: C.CommsContext,
  conversationId: string,
  userId: string,
  options: C.ConditionalOptions,
): Promise<void> {
  const bound = S.commsContextSchema.parse(context);
  z.uuid().parse(userId);
  responseData(
    await apiFetchWithMetadata(
      `${conversationPath(conversationId)}/members/${encodeURIComponent(userId)}`,
      z.null(),
      { ...conditionalOptions(bound, options), method: "DELETE" },
    ),
    204,
  );
}

export async function duplicateChannel(
  context: C.CommsContext,
  conversationId: string,
  input: C.DuplicateChannelRequest,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.Channel>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.duplicateChannelRequestSchema.parse(input);
  return versioned(
    await apiFetchWithMetadata(
      `${conversationPath(conversationId)}/duplicates`,
      S.channelSchema.refine(
        (value) =>
          inContext(bound)(value) &&
          value.id !== conversationId &&
          value.category_id === request.category_id,
      ),
      {
        ...conditionalOptions(bound, options),
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
    [201],
    "/comms/conversations",
  );
}

export async function listDirectBlocks(
  context: C.CommsContext,
  input: C.TimeListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.DirectBlock>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.timeListRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `/comms/direct-blocks?${queryString(request)}`,
      structurePageSchema(S.directBlockSchema, request),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function blockDirect(
  context: C.CommsContext,
  input: C.BlockRequest,
  options: C.RequestOptions = {},
): Promise<void> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.blockRequestSchema.parse(input);
  responseData(
    await apiFetchWithMetadata("/comms/direct-blocks", z.null(), {
      ...requestOptions(bound, options),
      method: "POST",
      body: JSON.stringify(request),
    }),
    204,
  );
}

export async function unblockDirect(
  context: C.CommsContext,
  userId: string,
  options: C.RequestOptions = {},
): Promise<void> {
  const bound = S.commsContextSchema.parse(context);
  z.uuid().parse(userId);
  responseData(
    await apiFetchWithMetadata(
      `/comms/direct-blocks/${encodeURIComponent(userId)}`,
      z.null(),
      { ...requestOptions(bound, options), method: "DELETE" },
    ),
    204,
  );
}
