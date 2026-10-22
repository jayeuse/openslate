import { z } from "zod";
import {
  ApiContractError,
  apiFetchWithMetadata,
  type ApiFetchMetadata,
} from "@/lib/api";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import { versionedResponse } from "./preferences-api";
import {
  conditionalOptions,
  requestOptions,
  responseData,
  structurePageSchema,
} from "./structure-contract";

// HTTP boundary only. FastAPI owns moderation access, reporter privacy and purge safeguards.
function conversationPath(conversationId: string) {
  z.uuid().parse(conversationId);
  return `/comms/conversations/${encodeURIComponent(conversationId)}`;
}
function messagePath(conversationId: string, messageId: string) {
  z.uuid().parse(messageId);
  return `${conversationPath(conversationId)}/messages/${encodeURIComponent(messageId)}`;
}
function reportPath(id: string) {
  z.uuid().parse(id);
  return `/comms/reports/${encodeURIComponent(id)}`;
}
function queryString(request: object) {
  return new URLSearchParams(
    Object.entries(request).map(([key, value]) => [key, String(value)]),
  ).toString();
}
function messageMatches(
  context: C.CommsContext,
  conversationId: string,
  messageId?: string,
) {
  return (value: C.Message) =>
    value.org_id === context.org_id &&
    value.conversation_id === conversationId &&
    (messageId === undefined || value.id === messageId) &&
    (value.thread === null ||
      (value.thread.org_id === context.org_id &&
        value.thread.conversation_id === conversationId &&
        value.thread.root_message_id === (value.parent_id ?? value.id)));
}
function reportSchemaFor(context: C.CommsContext, id?: string) {
  return S.reportSchema.refine(
    (value) =>
      value.org_id === context.org_id && (id === undefined || value.id === id),
  );
}

export async function listMessageRevisions(
  context: C.CommsContext,
  conversationId: string,
  messageId: string,
  input: C.TimeListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.MessageRevision>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.timeListRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `${messagePath(conversationId, messageId)}/revisions?${queryString(request)}`,
      structurePageSchema(
        S.messageRevisionSchema.refine(
          (value) => value.message_id === messageId,
        ),
        request,
      ),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function reportMessage(
  context: C.CommsContext,
  conversationId: string,
  messageId: string,
  input: C.ReportRequest,
  options: C.RequestOptions = {},
): Promise<void> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.reportRequestSchema.parse(input);
  responseData(
    await apiFetchWithMetadata(
      `${messagePath(conversationId, messageId)}/reports`,
      z.null(),
      {
        ...requestOptions(bound, options),
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
    204,
  );
}

export async function listReports(
  context: C.CommsContext,
  input: C.TimeListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.Report>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.timeListRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `/comms/reports?${queryString(request)}`,
      structurePageSchema(reportSchemaFor(bound), request),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function getReport(
  context: C.CommsContext,
  id: string,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Report>> {
  const bound = S.commsContextSchema.parse(context);
  return versionedResponse(
    await apiFetchWithMetadata(reportPath(id), reportSchemaFor(bound, id), {
      ...requestOptions(bound, options),
      method: "GET",
    }),
  );
}

export async function resolveReport(
  context: C.CommsContext,
  id: string,
  options: C.ConditionalOptions,
): Promise<C.Report> {
  const bound = S.commsContextSchema.parse(context);
  return responseData(
    await apiFetchWithMetadata(
      `${reportPath(id)}/resolution`,
      reportSchemaFor(bound, id).refine((value) => value.status === "resolved"),
      { ...conditionalOptions(bound, options), method: "POST" },
    ),
  );
}

/** HTTP-only D43 commands; no Phase-A client or ordinary source-read authority. */
export async function removeReportedMessage(
  context: C.CommsContext,
  id: string,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.Report>> {
  const bound = S.commsContextSchema.parse(context);
  return reportActionResponse(
    await apiFetchWithMetadata(
      `${reportPath(id)}/message-removal`,
      reportSchemaFor(bound, id).refine((value) => value.status === "open"),
      { ...conditionalOptions(bound, options), method: "POST" },
    ),
  );
}

export async function restoreReportedMessage(
  context: C.CommsContext,
  id: string,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.Report>> {
  const bound = S.commsContextSchema.parse(context);
  return reportActionResponse(
    await apiFetchWithMetadata(
      `${reportPath(id)}/message-restoration`,
      reportSchemaFor(bound, id).refine((value) => value.status === "open"),
      { ...conditionalOptions(bound, options), method: "POST" },
    ),
  );
}

function reportActionResponse(
  result: ApiFetchMetadata<typeof S.reportSchema>,
): C.Versioned<C.Report> {
  const versioned = versionedResponse(result);
  const cache =
    result.response.headers
      .get("Cache-Control")
      ?.toLowerCase()
      .split(",")
      .map((part) => part.trim()) ?? [];
  if (
    !cache.includes("private") ||
    !cache.includes("no-store") ||
    cache.includes("public")
  )
    throw new ApiContractError();
  // The compound validator is opaque. Never compute a source version or hydrate
  // the reported message: this authority returns only the existing queue DTO.
  return versioned;
}

export async function removeMessage(
  context: C.CommsContext,
  conversationId: string,
  messageId: string,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.Tombstone>> {
  const bound = S.commsContextSchema.parse(context);
  return versionedResponse(
    await apiFetchWithMetadata(
      `${messagePath(conversationId, messageId)}/removal`,
      S.tombstoneSchema.refine(
        messageMatches(bound, conversationId, messageId),
      ),
      { ...conditionalOptions(bound, options), method: "POST" },
    ),
  );
}

export async function restoreMessage(
  context: C.CommsContext,
  conversationId: string,
  messageId: string,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.LiveMessage>> {
  const bound = S.commsContextSchema.parse(context);
  return versionedResponse(
    await apiFetchWithMetadata(
      `${messagePath(conversationId, messageId)}/restoration`,
      S.liveMessageSchema.refine(
        messageMatches(bound, conversationId, messageId),
      ),
      { ...conditionalOptions(bound, options), method: "POST" },
    ),
  );
}

export async function listRemovedMessages(
  context: C.CommsContext,
  conversationId: string,
  input: C.TimeListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.Tombstone>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.timeListRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `${conversationPath(conversationId)}/removed-messages?${queryString(request)}`,
      structurePageSchema(
        S.tombstoneSchema.refine(messageMatches(bound, conversationId)),
        request,
      ),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function setPostingRestrictions(
  context: C.CommsContext,
  conversationId: string,
  input: C.RestrictionRequest,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.SettingsResponse>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.restrictionRequestSchema.parse(input);
  return versionedResponse(
    await apiFetchWithMetadata(
      `${conversationPath(conversationId)}/restrictions`,
      S.settingsResponseSchema.refine(
        (value) =>
          value.org_id === bound.org_id &&
          value.scope.kind === "channel" &&
          value.scope.id === conversationId,
      ),
      {
        ...conditionalOptions(bound, options),
        method: "PUT",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function previewPurge(
  context: C.CommsContext,
  conversationId: string,
  options: C.RequestOptions = {},
): Promise<C.PurgePreview> {
  const bound = S.commsContextSchema.parse(context);
  return responseData(
    await apiFetchWithMetadata(
      `${conversationPath(conversationId)}/purge/preview`,
      S.purgePreviewSchema.refine(
        (value) =>
          value.org_id === bound.org_id &&
          value.conversation_id === conversationId,
      ),
      { ...requestOptions(bound, options), method: "POST" },
    ),
  );
}

export async function purgeConversation(
  context: C.CommsContext,
  conversationId: string,
  input: C.PurgeRequest,
  options: C.RequestOptions = {},
): Promise<C.PurgeResult> {
  const bound = S.commsContextSchema.parse(context);
  // Keep proof and confirmation exact and operation-local. The server binds the
  // challenge token to the preview digest; neither a digest nor If-Match is a request field.
  const request = S.purgeRequestSchema.parse(input);
  return responseData(
    await apiFetchWithMetadata(
      `${conversationPath(conversationId)}/purge`,
      S.purgeResultSchema.refine(
        (value) =>
          value.org_id === bound.org_id &&
          value.conversation_id === conversationId,
      ),
      {
        ...requestOptions(bound, options),
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
  );
}
