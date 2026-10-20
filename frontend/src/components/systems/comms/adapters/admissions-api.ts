import { z } from "zod";
import { apiFetchWithMetadata } from "@/lib/api";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import {
  conditionalOptions,
  requestOptions,
  privateResponse,
  structurePageSchema,
  versioned,
} from "./structure-contract";

function conversationPath(id: string) {
  z.uuid().parse(id);
  return `/comms/conversations/${encodeURIComponent(id)}`;
}
function admissionPath(conversationId: string, id: string) {
  z.uuid().parse(id);
  return `${conversationPath(conversationId)}/admissions/${encodeURIComponent(id)}`;
}
function admissionSchemaFor(
  context: C.CommsContext,
  conversationId: string,
  id?: string,
) {
  return S.admissionSchema.refine(
    (value) =>
      value.org_id === context.org_id &&
      value.conversation_id === conversationId &&
      (id === undefined || value.id === id),
  );
}

export async function listAdmissions(
  context: C.CommsContext,
  conversationId: string,
  input: C.TimeListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.Admission>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.timeListRequestSchema.parse(input);
  const query = new URLSearchParams(
    Object.entries(request).map(([key, value]) => [key, String(value)]),
  );
  return privateResponse(
    await apiFetchWithMetadata(
      `${conversationPath(conversationId)}/admissions?${query}`,
      structurePageSchema(admissionSchemaFor(bound, conversationId), request),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}
export async function getAdmission(
  context: C.CommsContext,
  conversationId: string,
  id: string,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Admission>> {
  const bound = S.commsContextSchema.parse(context);
  const result = await apiFetchWithMetadata(
    admissionPath(conversationId, id),
    admissionSchemaFor(bound, conversationId, id),
    { ...requestOptions(bound, options), method: "GET" },
  );
  privateResponse(result);
  return versioned(result);
}
export async function invitePerson(
  context: C.CommsContext,
  conversationId: string,
  input: C.InvitationRequest,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Admission>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.invitationRequestSchema.parse(input);
  const result = await apiFetchWithMetadata(
    `${conversationPath(conversationId)}/invitations`,
    admissionSchemaFor(bound, conversationId).refine(
      (value) =>
        value.user_id === request.user_id && value.kind === "invitation",
    ),
    {
      ...requestOptions(bound, options),
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  privateResponse(result, 201);
  return versioned(
    result,
    [201],
    `${conversationPath(conversationId)}/admissions`,
  );
}
export async function decideAdmission(
  context: C.CommsContext,
  conversationId: string,
  id: string,
  input: C.AdmissionDecisionRequest,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.Admission>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.admissionDecisionRequestSchema.parse(input);
  const result = await apiFetchWithMetadata(
    `${admissionPath(conversationId, id)}/decision`,
    admissionSchemaFor(bound, conversationId, id).refine(
      (value) =>
        value.status ===
        (request.decision === "accept" ? "accepted" : "declined"),
    ),
    {
      ...conditionalOptions(bound, options),
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  privateResponse(result);
  return versioned(result);
}
/** No existence probe or requester resource; the server owns uniform acceptance. */
export async function submitJoinRequest(
  context: C.CommsContext,
  input: C.JoinRequestSubmission,
  options: C.RequestOptions = {},
): Promise<void> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.joinRequestSubmissionSchema.parse(input);
  privateResponse(
    await apiFetchWithMetadata("/comms/join-requests", z.null(), {
      ...requestOptions(bound, options),
      method: "POST",
      body: JSON.stringify(request),
    }),
    204,
  );
}
