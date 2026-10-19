import { z } from "zod";
import {
  ApiContractError,
  apiFetchWithMetadata,
  type ApiFetchMetadata,
} from "@/lib/api";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import { requestOptions } from "./structure-contract";

// Response validators remain available even though private writes are LWW.
export function versionedResponse<Schema extends z.ZodType>(
  result: ApiFetchMetadata<Schema>,
): C.Versioned<z.output<Schema>> {
  if (
    result.response.status !== 200 ||
    result.etag === null ||
    !S.preconditionSchema.safeParse({ if_match: result.etag }).success
  )
    throw new ApiContractError();
  return { data: result.data, etag: result.etag };
}

export async function getPersonalPreferences(
  context: C.CommsContext,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.PersonalPreferences>> {
  const bound = S.commsContextSchema.parse(context);
  return versionedResponse(
    await apiFetchWithMetadata(
      "/comms/preferences",
      S.personalPreferencesSchema,
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function setPersonalPreferences(
  context: C.CommsContext,
  input: C.PersonalPreferencesRequest,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.PersonalPreferences>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.personalPreferencesRequestSchema.parse(input);
  return versionedResponse(
    await apiFetchWithMetadata(
      "/comms/preferences",
      S.personalPreferencesSchema,
      {
        ...requestOptions(bound, options),
        method: "PUT",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function getMemberPreferences(
  context: C.CommsContext,
  conversationId: string,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.MemberPreferences>> {
  const bound = S.commsContextSchema.parse(context);
  z.uuid().parse(conversationId);
  return versionedResponse(
    await apiFetchWithMetadata(
      `/comms/conversations/${encodeURIComponent(conversationId)}/preferences`,
      S.memberPreferencesSchema,
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function updateMemberPreferences(
  context: C.CommsContext,
  conversationId: string,
  input: C.MemberPreferencesPatch,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.MemberPreferences>> {
  const bound = S.commsContextSchema.parse(context);
  z.uuid().parse(conversationId);
  const request = S.memberPreferencesPatchSchema.parse(input);
  return versionedResponse(
    await apiFetchWithMetadata(
      `/comms/conversations/${encodeURIComponent(conversationId)}/preferences`,
      S.memberPreferencesSchema,
      {
        ...requestOptions(bound, options),
        method: "PATCH",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function getCategoryPreferences(
  context: C.CommsContext,
  categoryId: string,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.CategoryPreferences>> {
  const bound = S.commsContextSchema.parse(context);
  z.uuid().parse(categoryId);
  return versionedResponse(
    await apiFetchWithMetadata(
      `/comms/categories/${encodeURIComponent(categoryId)}/preferences`,
      S.categoryPreferencesSchema,
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function setCategoryPreferences(
  context: C.CommsContext,
  categoryId: string,
  input: C.CategoryPreferences,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.CategoryPreferences>> {
  const bound = S.commsContextSchema.parse(context);
  z.uuid().parse(categoryId);
  const request = S.categoryPreferencesSchema.parse(input);
  return versionedResponse(
    await apiFetchWithMetadata(
      `/comms/categories/${encodeURIComponent(categoryId)}/preferences`,
      S.categoryPreferencesSchema,
      {
        ...requestOptions(bound, options),
        method: "PUT",
        body: JSON.stringify(request),
      },
    ),
  );
}
