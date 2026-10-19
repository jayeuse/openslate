import { ApiContractError, apiFetchWithMetadata } from "@/lib/api";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import {
  conditionalOptions,
  requestOptions,
  responseData,
} from "./structure-contract";
import { versionedResponse } from "./preferences-api";

function settingsPath(scope: C.SettingsScope) {
  S.settingsScopeSchema.parse(scope);
  return scope.kind === "workspace"
    ? "/comms/settings/workspace"
    : scope.kind === "category"
      ? `/comms/settings/category/${encodeURIComponent(scope.id)}`
      : `/comms/settings/channel/${encodeURIComponent(scope.id)}`;
}

function sameScope(left: C.SettingsScope, right: C.SettingsScope) {
  return (
    left.kind === right.kind &&
    (left.kind === "workspace" ||
      (right.kind !== "workspace" && left.id === right.id))
  );
}

function settingsSchemaFor(context: C.CommsContext, scope: C.SettingsScope) {
  return S.settingsResponseSchema.refine(
    (value) => value.org_id === context.org_id && sameScope(value.scope, scope),
  );
}

function directPolicy(
  result: C.Versioned<C.SettingsResponse>,
): C.Versioned<C.DirectPolicy> {
  if (!("dm_rule" in result.data)) throw new ApiContractError();
  return { data: { dm_rule: result.data.dm_rule }, etag: result.etag };
}

export async function getSettings(
  context: C.CommsContext,
  scope: C.SettingsScope,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.SettingsResponse>> {
  const bound = S.commsContextSchema.parse(context);
  const target = S.settingsScopeSchema.parse(scope);
  return versionedResponse(
    await apiFetchWithMetadata(
      settingsPath(scope),
      settingsSchemaFor(bound, target),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function updateSettings(
  context: C.CommsContext,
  scope: C.SettingsScope,
  input: C.SettingsPatch,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.SettingsResponse>> {
  const bound = S.commsContextSchema.parse(context);
  const target = S.settingsScopeSchema.parse(scope);
  const request = S.settingsPatchSchema.parse(input);
  return versionedResponse(
    await apiFetchWithMetadata(
      settingsPath(scope),
      settingsSchemaFor(bound, target),
      {
        ...conditionalOptions(bound, options),
        method: "PATCH",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function resetSettings(
  context: C.CommsContext,
  scope: C.SettingsScope,
  input: C.SettingsReset,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.SettingsResponse>> {
  const bound = S.commsContextSchema.parse(context);
  const target = S.settingsScopeSchema.parse(scope);
  const request = S.settingsResetSchema.parse(input);
  return versionedResponse(
    await apiFetchWithMetadata(
      `${settingsPath(scope)}/reset`,
      settingsSchemaFor(bound, target),
      {
        ...conditionalOptions(bound, options),
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function setSettingsLocks(
  context: C.CommsContext,
  input: C.SettingsLocks,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.SettingsResponse>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.settingsLocksSchema.parse(input);
  return versionedResponse(
    await apiFetchWithMetadata(
      "/comms/settings/workspace/locks",
      settingsSchemaFor(bound, { kind: "workspace" }),
      {
        ...conditionalOptions(bound, options),
        method: "PUT",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function getCapabilityConfiguration(
  context: C.CommsContext,
  scope: C.SettingsScope,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.CapabilityConfiguration>> {
  const bound = S.commsContextSchema.parse(context);
  const target = S.settingsScopeSchema.parse(scope);
  return versionedResponse(
    await apiFetchWithMetadata(
      `${settingsPath(scope)}/capabilities`,
      S.capabilityConfigurationSchema.refine((value) =>
        sameScope(value.scope, target),
      ),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function setCapabilityConfiguration(
  context: C.CommsContext,
  input: C.CapabilityConfiguration,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.CapabilityConfiguration>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.capabilityConfigurationSchema.parse(input);
  return versionedResponse(
    await apiFetchWithMetadata(
      `${settingsPath(input.scope)}/capabilities`,
      S.capabilityConfigurationSchema.refine((value) =>
        sameScope(value.scope, request.scope),
      ),
      {
        ...conditionalOptions(bound, options),
        method: "PUT",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function getCapabilityLocks(
  context: C.CommsContext,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.CapabilityLocks>> {
  const bound = S.commsContextSchema.parse(context);
  return versionedResponse(
    await apiFetchWithMetadata(
      "/comms/settings/workspace/capability-locks",
      S.capabilityLocksSchema,
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function setCapabilityLocks(
  context: C.CommsContext,
  input: C.CapabilityLocks,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.CapabilityLocks>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.capabilityLocksSchema.parse(input);
  return versionedResponse(
    await apiFetchWithMetadata(
      "/comms/settings/workspace/capability-locks",
      S.capabilityLocksSchema,
      {
        ...conditionalOptions(bound, options),
        method: "PUT",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function getCapabilities(
  context: C.CommsContext,
  conversationId: string,
  options: C.RequestOptions = {},
): Promise<C.CapabilityCheck> {
  const bound = S.commsContextSchema.parse(context);
  return responseData(
    await apiFetchWithMetadata(
      `/comms/conversations/${encodeURIComponent(conversationId)}/capabilities`,
      S.capabilityCheckSchemaFor(bound, conversationId, bound.user_id),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function checkPerson(
  context: C.CommsContext,
  conversationId: string,
  userId: string,
  options: C.RequestOptions = {},
): Promise<C.CapabilityCheck> {
  const bound = S.commsContextSchema.parse(context);
  return responseData(
    await apiFetchWithMetadata(
      `/comms/conversations/${encodeURIComponent(conversationId)}/capabilities/${encodeURIComponent(userId)}`,
      S.capabilityCheckSchemaFor(bound, conversationId, userId),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function getChannelCreationCheck(
  context: C.CommsContext,
  scope: C.ChannelCreationScope,
  options: C.RequestOptions = {},
): Promise<C.ChannelCreationCheck> {
  const bound = S.commsContextSchema.parse(context);
  const target = S.channelCreationScopeSchema.parse(scope);
  const query = new URLSearchParams(
    target.kind === "workspace"
      ? { scope_kind: "workspace" }
      : { scope_kind: "category", category_id: target.id },
  );
  return responseData(
    await apiFetchWithMetadata(
      `/comms/capabilities/channel-creation?${query}`,
      S.channelCreationCheckSchemaFor(bound, target),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function getDirectPolicy(
  context: C.CommsContext,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.DirectPolicy>> {
  return directPolicy(
    await getSettings(context, { kind: "workspace" }, options),
  );
}

export async function setDirectPolicy(
  context: C.CommsContext,
  input: C.DirectPolicy,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.DirectPolicy>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.directPolicySchema.parse(input);
  return directPolicy(
    versionedResponse(
      await apiFetchWithMetadata(
        "/comms/settings/workspace",
        settingsSchemaFor(bound, { kind: "workspace" }),
        {
          ...conditionalOptions(bound, options),
          method: "PATCH",
          body: JSON.stringify(request),
        },
      ),
    ),
  );
}
