import { z } from "zod";
import { ApiContractError, apiFetchWithMetadata } from "@/lib/api";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import { requestOptions, responseData } from "./structure-contract";
import {
  heartbeatPresenceRequestSchema,
  heartbeatPresenceResponseSchemaFor,
  type HttpHeartbeatRequest,
  type HttpHeartbeatResponse,
} from "./presence-contract";

export async function getPresence(
  context: C.CommsContext,
  input: C.PresenceListRequest,
  options: C.RequestOptions = {},
): Promise<C.PresenceSnapshot> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.presenceListRequestSchema.parse(input);
  const people = new Set(request.user_ids.map((id) => id.toLowerCase()));
  const query = new URLSearchParams(
    request.user_ids.map((id) => ["user_ids", id]),
  );
  const path = query.size ? `/comms/presence?${query}` : "/comms/presence";
  return responseData(
    await apiFetchWithMetadata(
      path,
      S.presenceSnapshotSchema.refine(
        (value) =>
          value.org_id === bound.org_id &&
          value.items.every((item) => people.has(item.user_id.toLowerCase())) &&
          new Set(value.items.map((item) => item.user_id.toLowerCase()))
            .size === value.items.length,
      ),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

/** HTTP-only B8 response; the Phase-A client/memory void method is not changed. */
export async function heartbeatPresence(
  context: C.CommsContext,
  input: HttpHeartbeatRequest,
  options: C.RequestOptions = {},
): Promise<HttpHeartbeatResponse> {
  const bound = S.commsContextSchema.parse(context);
  const request = heartbeatPresenceRequestSchema.parse(input);
  const result = await apiFetchWithMetadata(
    "/comms/presence",
    heartbeatPresenceResponseSchemaFor(bound),
    {
      ...requestOptions(bound, options),
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  const data = responseData(result);
  if (
    !result.response.headers
      .get("Cache-Control")
      ?.toLowerCase()
      .split(",")
      .some((part) => part.trim() === "no-store")
  )
    throw new ApiContractError();
  return data;
}

export async function sendTyping(
  context: C.CommsContext,
  conversationId: string,
  options: C.RequestOptions = {},
): Promise<void> {
  const bound = S.commsContextSchema.parse(context);
  z.uuid().parse(conversationId);
  responseData(
    await apiFetchWithMetadata(
      `/comms/conversations/${encodeURIComponent(conversationId)}/typing`,
      z.null(),
      { ...requestOptions(bound, options), method: "POST" },
    ),
    204,
  );
}
