import { z } from "zod";
import {
  ApiContractError,
  apiFetchWithMetadata,
  type ApiFetchMetadata,
} from "@/lib/api";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import {
  conditionalOptions,
  requestOptions,
  requirePrivateNoStore,
} from "./structure-contract";

// D45 access grants on a channel or a category; FastAPI owns every decision.
function targetPath(input: C.AccessGrantTarget) {
  const target = S.accessGrantTargetSchema.parse(input);
  return `/comms/${target.kind === "channel" ? "conversations" : "categories"}/${encodeURIComponent(target.id)}`;
}

function grantPath(
  target: C.AccessGrantTarget,
  subject: C.AccessGrantSubject,
  subjectId: string,
) {
  S.accessGrantSubjectSchema.parse(subject);
  z.uuid().parse(subjectId);
  return `${targetPath(target)}/access-grants/${subject === "group" ? "group" : "user"}/${encodeURIComponent(subjectId)}`;
}

/** A private reply with a strong ETag: the target's configuration token. */
function versionedReply<T>(
  result: ApiFetchMetadata<z.ZodType<T>>,
  statuses: readonly number[],
): C.Versioned<T> {
  requirePrivateNoStore(result.response.headers);
  if (
    !statuses.includes(result.response.status) ||
    result.etag === null ||
    !S.preconditionSchema.safeParse({ if_match: result.etag }).success
  )
    throw new ApiContractError();
  return { data: result.data, etag: result.etag };
}

export async function listAccessGrants(
  context: C.CommsContext,
  target: C.AccessGrantTarget,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.AccessGrantList>> {
  const bound = S.commsContextSchema.parse(context);
  const kind = S.accessGrantTargetSchema.parse(target).kind;
  return versionedReply(
    await apiFetchWithMetadata(
      `${targetPath(target)}/access-grants`,
      S.accessGrantListSchema.refine(
        ({ items }) =>
          kind === "channel" ||
          items.every((item) => item.source === "category"),
      ),
      { ...requestOptions(bound, options), method: "GET" },
    ),
    [200],
  );
}

export async function setAccessGrant(
  context: C.CommsContext,
  target: C.AccessGrantTarget,
  subject: C.AccessGrantSubject,
  subjectId: string,
  input: { level: C.AccessGrantLevel },
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.AccessGrant>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.accessGrantRequestSchema.parse(input);
  const path = grantPath(target, subject, subjectId);
  const result = await apiFetchWithMetadata(
    path,
    S.accessGrantSchema.refine(
      (grant) =>
        grant.subject === subject &&
        grant.subject_id === subjectId &&
        grant.level === request.level &&
        grant.source === target.kind,
    ),
    {
      ...conditionalOptions(bound, options),
      method: "PUT",
      body: JSON.stringify(request),
    },
  );
  if (
    result.response.status === 201 &&
    result.response.headers.get("Location") !== `/api${path}`
  )
    throw new ApiContractError();
  return versionedReply(result, [200, 201]);
}

export async function removeAccessGrant(
  context: C.CommsContext,
  target: C.AccessGrantTarget,
  subject: C.AccessGrantSubject,
  subjectId: string,
  options: C.ConditionalOptions,
): Promise<void> {
  const bound = S.commsContextSchema.parse(context);
  const result = await apiFetchWithMetadata(
    grantPath(target, subject, subjectId),
    z.null(),
    { ...conditionalOptions(bound, options), method: "DELETE" },
  );
  if (result.response.status !== 204) throw new ApiContractError();
}

export async function listAccessCandidates(
  context: C.CommsContext,
  target: C.AccessGrantTarget,
  input: C.AccessCandidatesRequest,
  options: C.RequestOptions = {},
): Promise<C.AccessCandidates> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.accessCandidatesRequestSchema.parse(input);
  const query = new URLSearchParams({
    q: request.q,
    limit: String(request.limit),
    ...(request.kind ? { kind: request.kind } : {}),
  });
  const result = await apiFetchWithMetadata(
    `${targetPath(target)}/access-candidates?${query}`,
    S.accessCandidatesSchema.refine(
      ({ people, groups }) =>
        people.length <= request.limit &&
        groups.length <= request.limit &&
        (request.kind !== "user" || groups.length === 0) &&
        (request.kind !== "group" || people.length === 0),
    ),
    { ...requestOptions(bound, options), method: "GET" },
  );
  requirePrivateNoStore(result.response.headers);
  if (result.response.status !== 200) throw new ApiContractError();
  return result.data;
}
