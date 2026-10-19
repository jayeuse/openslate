import { z } from "zod";
import {
  ApiContractError,
  apiFetch,
  apiFetchWithMetadata,
  type ApiFetchMetadata,
} from "@/lib/api";

import {
  bootstrapSchema,
  commsContextSchema,
  editMessageRequestSchema,
  historyPageSchemaFor,
  historyRequestSchema,
  liveMessageSchema,
  markReadRequestSchema,
  messageSchema,
  readStateSchema,
  sendMessageRequestSchema,
  sendResultSchema,
  tombstoneSchema,
} from "../contract/schemas";
import type * as C from "../contract/types";

// S17 message routes only. Shared API helpers retain auth, CSRF and error handling;
// callers supply their bound context. This is not the full CommsClient or UI cutover.
function requestOptions(context: C.CommsContext, options: C.RequestOptions) {
  return {
    headers: { "X-Org": context.org_id },
    cache: "no-store" as const,
    signal: options.signal,
  };
}

function messagesPath(conversationId: string) {
  z.uuid().parse(conversationId);
  return `/comms/conversations/${encodeURIComponent(conversationId)}/messages`;
}

function inConversation(
  context: C.CommsContext,
  conversationId: string,
  message: C.Message,
) {
  return (
    message.org_id === context.org_id &&
    message.conversation_id === conversationId
  );
}

function versioned<Schema extends z.ZodType>(
  result: ApiFetchMetadata<Schema>,
): C.Versioned<z.output<Schema>> {
  if (result.response.status !== 200 || !result.etag?.trim())
    throw new ApiContractError();
  return { data: result.data, etag: result.etag };
}

export async function bootstrap(
  context: C.CommsContext,
  options: C.RequestOptions = {},
): Promise<C.Bootstrap> {
  const bound = commsContextSchema.parse(context);
  return apiFetch(
    "/comms/bootstrap",
    bootstrapSchema.refine(
      (data) => data.org_id === bound.org_id && data.user_id === bound.user_id,
    ),
    requestOptions(bound, options),
  );
}

export async function getHistory(
  context: C.CommsContext,
  conversationId: string,
  input: C.HistoryRequest = {},
  options: C.RequestOptions = {},
): Promise<C.HistoryPage> {
  const bound = commsContextSchema.parse(context);
  const request = historyRequestSchema.parse(input);
  const query = new URLSearchParams(
    Object.entries(request)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  return apiFetch(
    `${messagesPath(conversationId)}?${query}`,
    historyPageSchemaFor(bound, conversationId, request),
    requestOptions(bound, options),
  );
}

export async function getMessage(
  context: C.CommsContext,
  conversationId: string,
  messageId: string,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Message>> {
  const bound = commsContextSchema.parse(context);
  z.uuid().parse(messageId);
  return versioned(
    await apiFetchWithMetadata(
      `${messagesPath(conversationId)}/${encodeURIComponent(messageId)}`,
      messageSchema.refine(
        (message) =>
          inConversation(bound, conversationId, message) &&
          message.id === messageId,
      ),
      requestOptions(bound, options),
    ),
  );
}

export async function getMessageBySequence(
  context: C.CommsContext,
  conversationId: string,
  seq: number,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Message>> {
  const bound = commsContextSchema.parse(context);
  z.number().int().positive().parse(seq);
  return versioned(
    await apiFetchWithMetadata(
      `${messagesPath(conversationId)}/by-sequence/${encodeURIComponent(String(seq))}`,
      messageSchema.refine(
        (message) =>
          inConversation(bound, conversationId, message) && message.seq === seq,
      ),
      requestOptions(bound, options),
    ),
  );
}

export async function sendMessage(
  context: C.CommsContext,
  conversationId: string,
  input: C.SendMessageRequest,
  options: C.RequestOptions = {},
): Promise<C.SendResult> {
  const bound = commsContextSchema.parse(context);
  const request = sendMessageRequestSchema.parse(input);
  const result = await apiFetchWithMetadata(
    messagesPath(conversationId),
    messageSchema.refine(
      (message) =>
        inConversation(bound, conversationId, message) &&
        message.author_id === bound.user_id &&
        message.client_key === request.client_key &&
        message.parent_id === null,
    ),
    {
      ...requestOptions(bound, options),
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  const sent = sendResultSchema.safeParse({
    status: result.response.status,
    message: result.data,
  });
  if (!sent.success) throw new ApiContractError();
  return sent.data;
}

export async function editMessage(
  context: C.CommsContext,
  conversationId: string,
  messageId: string,
  input: C.EditMessageRequest,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.LiveMessage>> {
  const bound = commsContextSchema.parse(context);
  z.uuid().parse(messageId);
  const request = editMessageRequestSchema.parse(input);
  return versioned(
    await apiFetchWithMetadata(
      `${messagesPath(conversationId)}/${encodeURIComponent(messageId)}`,
      liveMessageSchema.refine(
        (message) =>
          inConversation(bound, conversationId, message) &&
          message.id === messageId,
      ),
      {
        ...requestOptions(bound, options),
        method: "PATCH",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function deleteMessage(
  context: C.CommsContext,
  conversationId: string,
  messageId: string,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Tombstone>> {
  const bound = commsContextSchema.parse(context);
  z.uuid().parse(messageId);
  return versioned(
    await apiFetchWithMetadata(
      `${messagesPath(conversationId)}/${encodeURIComponent(messageId)}`,
      tombstoneSchema.refine(
        (message) =>
          inConversation(bound, conversationId, message) &&
          message.id === messageId,
      ),
      { ...requestOptions(bound, options), method: "DELETE" },
    ),
  );
}

export async function markRead(
  context: C.CommsContext,
  conversationId: string,
  input: C.MarkReadRequest,
  options: C.RequestOptions = {},
): Promise<C.ReadState> {
  const bound = commsContextSchema.parse(context);
  z.uuid().parse(conversationId);
  const request = markReadRequestSchema.parse(input);
  return apiFetch(
    `/comms/conversations/${encodeURIComponent(conversationId)}/read`,
    readStateSchema.refine((state) => state.conversation_id === conversationId),
    {
      ...requestOptions(bound, options),
      method: "PUT",
      body: JSON.stringify(request),
    },
  );
}
