import { z } from "zod";
import { ApiContractError, apiFetchWithMetadata } from "@/lib/api";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import {
  conditionalOptions,
  requestOptions,
  responseData,
  structurePageSchema,
} from "./structure-contract";
import { versionedResponse } from "./preferences-api";

function threadPath(conversationId: string, rootMessageId: string) {
  z.uuid().parse(conversationId);
  z.uuid().parse(rootMessageId);
  return `/comms/conversations/${encodeURIComponent(conversationId)}/threads/${encodeURIComponent(rootMessageId)}`;
}
function messagePath(conversationId: string, messageId: string) {
  z.uuid().parse(conversationId);
  z.uuid().parse(messageId);
  return `/comms/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`;
}
function threadSchemaFor(
  context: C.CommsContext,
  conversationId: string,
  rootMessageId: string,
) {
  return S.threadSchema.refine(
    (value) =>
      value.org_id === context.org_id &&
      value.conversation_id === conversationId &&
      value.root_message_id === rootMessageId,
  );
}
function messageSchemaFor(
  context: C.CommsContext,
  conversationId: string,
  messageId?: string,
) {
  return S.messageSchema.refine(
    (value) =>
      value.org_id === context.org_id &&
      value.conversation_id === conversationId &&
      (messageId === undefined || value.id === messageId) &&
      (value.thread === null ||
        threadSchemaFor(
          context,
          conversationId,
          value.parent_id ?? value.id,
        ).safeParse(value.thread).success),
  );
}
function queryString(request: object) {
  return new URLSearchParams(
    Object.entries(request)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  ).toString();
}

export async function getThread(
  context: C.CommsContext,
  conversationId: string,
  rootMessageId: string,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Thread>> {
  const bound = S.commsContextSchema.parse(context);
  return versionedResponse(
    await apiFetchWithMetadata(
      threadPath(conversationId, rootMessageId),
      threadSchemaFor(bound, conversationId, rootMessageId),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function createThread(
  context: C.CommsContext,
  conversationId: string,
  rootMessageId: string,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Thread>> {
  const bound = S.commsContextSchema.parse(context);
  const result = await apiFetchWithMetadata(
    threadPath(conversationId, rootMessageId),
    threadSchemaFor(bound, conversationId, rootMessageId),
    { ...requestOptions(bound, options), method: "POST" },
  );
  if (result.response.status === 200) return versionedResponse(result);
  const tag = S.preconditionSchema.safeParse({ if_match: result.etag });
  if (
    result.response.status !== 201 ||
    !tag.success ||
    result.response.headers.get("Location") !==
      `/api${threadPath(conversationId, rootMessageId)}`
  )
    throw new ApiContractError();
  return { data: result.data, etag: tag.data.if_match };
}

export async function updateThread(
  context: C.CommsContext,
  conversationId: string,
  rootMessageId: string,
  input: C.ThreadPatch,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.Thread>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.threadPatchSchema.parse(input);
  return versionedResponse(
    await apiFetchWithMetadata(
      threadPath(conversationId, rootMessageId),
      threadSchemaFor(bound, conversationId, rootMessageId),
      {
        ...conditionalOptions(bound, options),
        method: "PATCH",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function getReplies(
  context: C.CommsContext,
  conversationId: string,
  rootMessageId: string,
  input: C.HistoryRequest = {},
  options: C.RequestOptions = {},
): Promise<C.HistoryPage> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.historyRequestSchema.parse(input);
  const message = messageSchemaFor(bound, conversationId);
  return responseData(
    await apiFetchWithMetadata(
      `${threadPath(conversationId, rootMessageId)}/replies?${queryString(request)}`,
      S.historyPageSchemaFor(
        bound,
        conversationId,
        request,
        rootMessageId,
      ).refine((value) =>
        value.items.every((item) => message.safeParse(item).success),
      ),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function sendReply(
  context: C.CommsContext,
  conversationId: string,
  rootMessageId: string,
  input: C.SendReplyRequest,
  options: C.RequestOptions = {},
): Promise<C.SendResult> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.sendReplyRequestSchema.parse(input);
  const result = await apiFetchWithMetadata(
    `${threadPath(conversationId, rootMessageId)}/replies`,
    messageSchemaFor(bound, conversationId).refine(
      (value) =>
        value.parent_id === rootMessageId &&
        value.author_id === bound.user_id &&
        value.client_key === request.client_key &&
        value.also_send_to_channel === request.also_send_to_channel,
    ),
    {
      ...requestOptions(bound, options),
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  const sent = S.sendResultSchema.safeParse({
    status: result.response.status,
    message: result.data,
  });
  if (
    !sent.success ||
    (sent.data.status === 201 &&
      result.response.headers.get("Location") !==
        `/api${messagePath(conversationId, sent.data.message.id)}`)
  )
    throw new ApiContractError();
  return sent.data;
}

export async function followThread(
  context: C.CommsContext,
  conversationId: string,
  rootMessageId: string,
  input: C.FollowRequest,
  options: C.RequestOptions = {},
): Promise<C.Thread> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.followRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `${threadPath(conversationId, rootMessageId)}/follow`,
      threadSchemaFor(bound, conversationId, rootMessageId),
      {
        ...requestOptions(bound, options),
        method: "PUT",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function listThreads(
  context: C.CommsContext,
  input: C.ThreadListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.Thread>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.threadListRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `/comms/threads?${queryString(request)}`,
      structurePageSchema(
        S.threadSchema.refine((value) => value.org_id === bound.org_id),
        request,
      ),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function addReaction(
  context: C.CommsContext,
  conversationId: string,
  messageId: string,
  input: C.ReactionRequest,
  options: C.RequestOptions = {},
): Promise<C.Message> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.reactionRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `${messagePath(conversationId, messageId)}/reactions`,
      messageSchemaFor(bound, conversationId, messageId),
      {
        ...requestOptions(bound, options),
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function removeReaction(
  context: C.CommsContext,
  conversationId: string,
  messageId: string,
  input: C.ReactionRequest,
  options: C.RequestOptions = {},
): Promise<C.Message> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.reactionRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `${messagePath(conversationId, messageId)}/reactions`,
      messageSchemaFor(bound, conversationId, messageId),
      {
        ...requestOptions(bound, options),
        method: "DELETE",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function setPin(
  context: C.CommsContext,
  conversationId: string,
  messageId: string,
  input: C.PinRequest,
  options: C.RequestOptions = {},
): Promise<C.Message> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.pinRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `${messagePath(conversationId, messageId)}/pin`,
      messageSchemaFor(bound, conversationId, messageId),
      {
        ...requestOptions(bound, options),
        method: "PUT",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function listPins(
  context: C.CommsContext,
  conversationId: string,
  input: C.TimeListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.Message>> {
  const bound = S.commsContextSchema.parse(context);
  z.uuid().parse(conversationId);
  const request = S.timeListRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `/comms/conversations/${encodeURIComponent(conversationId)}/pins?${queryString(request)}`,
      structurePageSchema(messageSchemaFor(bound, conversationId), request),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}
