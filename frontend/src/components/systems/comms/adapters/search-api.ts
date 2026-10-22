import { apiFetchWithMetadata } from "@/lib/api";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import {
  requestOptions,
  responseData,
  structurePageSchema,
} from "./structure-contract";

export async function search(
  context: C.CommsContext,
  input: C.SearchRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.SearchHit>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.searchRequestSchema.parse(input);
  const query = new URLSearchParams(
    Object.entries(request)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  // Hits have no organization field. Bind explicit filters; visibility and match
  // evaluation remain server-owned. Excerpts and their code-point spans are not rewritten.
  const hit = S.searchHitSchema.refine((value) => {
    const length = [...value.excerpt].length;
    return (
      (request.in === undefined || value.conversation_id === request.in) &&
      (request.from === undefined || value.author_id === request.from) &&
      value.parent_id !== value.message_id &&
      value.matches.every(({ start, end }) => start < end && end <= length)
    );
  });
  return responseData(
    await apiFetchWithMetadata(
      `/comms/search?${query}`,
      structurePageSchema(hit, request),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}
