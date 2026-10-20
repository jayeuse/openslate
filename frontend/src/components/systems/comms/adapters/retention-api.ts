import { z } from "zod";
import { apiFetchWithMetadata } from "@/lib/api";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import {
  conditionalOptions,
  requestOptions,
  privateResponse,
} from "./structure-contract";
import { versionedResponse } from "./preferences-api";

const scopeSchema = z.union([
  S.retentionPolicySchema.options[0].shape.scope,
  S.retentionPolicySchema.options[1].shape.scope,
]);
function sameScope(
  left: C.RetentionPolicy["scope"],
  right: C.RetentionPolicy["scope"],
) {
  return (
    left.kind === right.kind &&
    (left.kind === "workspace" ||
      (right.kind === "channel" && left.id === right.id))
  );
}
function samePolicy(left: C.RetentionPolicy, right: C.RetentionPolicy) {
  return (
    sameScope(left.scope, right.scope) &&
    left.message_days === right.message_days &&
    left.file_days === right.file_days
  );
}

export async function getRetention(
  context: C.CommsContext,
  scope: C.RetentionPolicy["scope"],
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.RetentionResponse>> {
  const bound = S.commsContextSchema.parse(context);
  const target = scopeSchema.parse(scope);
  const query = new URLSearchParams(
    target.kind === "workspace"
      ? { scope_kind: "workspace" }
      : { scope_kind: "channel", channel_id: target.id },
  );
  const result = await apiFetchWithMetadata(
    `/comms/retention?${query}`,
    S.retentionResponseSchema.refine((value) =>
      sameScope(value.policy.scope, target),
    ),
    { ...requestOptions(bound, options), method: "GET" },
  );
  privateResponse(result);
  return versionedResponse(result);
}

export async function previewRetention(
  context: C.CommsContext,
  input: C.RetentionPolicy,
  options: C.ConditionalOptions & C.FreshAdminOptions,
): Promise<C.RetentionPreview> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.retentionPolicySchema.parse(input);
  const password = S.purgeRequestSchema.shape.password.parse(options?.password);
  return privateResponse(
    await apiFetchWithMetadata(
      "/comms/retention/preview",
      S.retentionPreviewSchema.refine((value) =>
        samePolicy(value.policy, request),
      ),
      {
        ...conditionalOptions(bound, options),
        method: "POST",
        body: JSON.stringify({ ...request, password }),
      },
    ),
  );
}

/** Null channel overrides reset through this protected write, never settings/reset. */
export async function updateRetention(
  context: C.CommsContext,
  input: C.RetentionRequest,
  options: C.ConditionalOptions & C.FreshAdminOptions,
): Promise<C.Versioned<C.RetentionResponse>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.retentionRequestSchema.parse(input);
  const password = S.purgeRequestSchema.shape.password.parse(options?.password);
  const result = await apiFetchWithMetadata(
    "/comms/retention",
    S.retentionResponseSchema.refine((value) =>
      samePolicy(value.policy, request),
    ),
    {
      ...conditionalOptions(bound, options),
      method: "PUT",
      body: JSON.stringify({ ...request, password }),
    },
  );
  privateResponse(result);
  return versionedResponse(result);
}
