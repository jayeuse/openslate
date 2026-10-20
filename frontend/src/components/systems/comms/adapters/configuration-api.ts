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
import { versionedResponse } from "./preferences-api";

function templatePath(id: string) {
  z.uuid().parse(id);
  return `/comms/templates/${encodeURIComponent(id)}`;
}
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
function queryString(request: object) {
  return new URLSearchParams(
    Object.entries(request).map(([key, value]) => [key, String(value)]),
  ).toString();
}
function templateSchemaFor(context: C.CommsContext, id?: string) {
  return S.templateSchema.refine(
    (value) =>
      value.org_id === context.org_id && (id === undefined || value.id === id),
  );
}
function templateRequest(input: C.TemplateImport) {
  // Check the supplied JSON before name trimming, then reuse the canonical
  // schema's independent UTF-8 bound and write validation. No file parser here.
  z.number()
    .max(65_536)
    .parse(new TextEncoder().encode(JSON.stringify(input)).byteLength);
  return S.templateImportSchema.parse(input);
}
function historySchemaFor(
  context: C.CommsContext,
  scope: C.SettingsScope,
  id?: string,
) {
  return S.configurationHistorySchema.refine(
    (value) =>
      value.org_id === context.org_id &&
      sameScope(value.scope, scope) &&
      (id === undefined || value.id === id),
  );
}
function targetsMatch(
  items: { conversation_id: string }[],
  request: C.TemplateApplyRequest,
) {
  const targets = new Set(request.conversation_ids);
  return (
    items.length === targets.size &&
    new Set(items.map((item) => item.conversation_id)).size === items.length &&
    items.every((item) => targets.has(item.conversation_id))
  );
}
function selectedOnly(keys: readonly string[], selected: readonly string[]) {
  const allowed = new Set(selected);
  return (
    new Set(keys).size === keys.length && keys.every((key) => allowed.has(key))
  );
}
function disjoint(left: readonly string[], right: readonly string[]) {
  const excluded = new Set(right);
  return left.every((key) => !excluded.has(key));
}

export async function listTemplates(
  context: C.CommsContext,
  input: C.TimeListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.Template>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.timeListRequestSchema.parse(input);
  return privateResponse(
    await apiFetchWithMetadata(
      `/comms/templates?${queryString(request)}`,
      structurePageSchema(templateSchemaFor(bound), request),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}
export async function getTemplate(
  context: C.CommsContext,
  id: string,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Template>> {
  const bound = S.commsContextSchema.parse(context);
  const result = await apiFetchWithMetadata(
    templatePath(id),
    templateSchemaFor(bound, id),
    { ...requestOptions(bound, options), method: "GET" },
  );
  privateResponse(result);
  return versioned(result);
}
export async function createTemplate(
  context: C.CommsContext,
  input: C.TemplateImport,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Template>> {
  const bound = S.commsContextSchema.parse(context);
  const request = templateRequest(input);
  const result = await apiFetchWithMetadata(
    "/comms/templates",
    templateSchemaFor(bound),
    {
      ...requestOptions(bound, options),
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  privateResponse(result, 201);
  return versioned(result, [201], "/comms/templates");
}
export async function saveTemplate(
  context: C.CommsContext,
  id: string,
  input: C.TemplateImport,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.Template>> {
  const bound = S.commsContextSchema.parse(context);
  const request = templateRequest(input);
  const result = await apiFetchWithMetadata(
    templatePath(id),
    templateSchemaFor(bound, id),
    {
      ...conditionalOptions(bound, options),
      method: "PUT",
      body: JSON.stringify(request),
    },
  );
  privateResponse(result);
  return versioned(result);
}
export async function previewTemplateApply(
  context: C.CommsContext,
  id: string,
  input: C.TemplateApplyRequest,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.TemplateApplyPreview>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.templateApplyRequestSchema.parse(input);
  const result = await apiFetchWithMetadata(
    `${templatePath(id)}/application-preview`,
    S.templateApplyPreviewSchema.refine(
      (value) =>
        targetsMatch(value.items, request) &&
        value.items.every(
          (item) =>
            selectedOnly(item.skipped_locked_keys, request.keys) &&
            selectedOnly(
              item.capabilities?.skipped_locked ?? [],
              request.capability_keys ?? [],
            ),
        ),
    ),
    {
      ...requestOptions(bound, options),
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  privateResponse(result);
  return versionedResponse(result);
}
export async function applyTemplate(
  context: C.CommsContext,
  id: string,
  input: C.TemplateApplyRequest,
  options: C.ConditionalOptions,
): Promise<C.TemplateApplyResult> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.templateApplyRequestSchema.parse(input);
  // Validate the server's classifications, not which keys should be locked.
  // Absent template values need not appear in either result classification.
  return privateResponse(
    await apiFetchWithMetadata(
      `${templatePath(id)}/applications`,
      S.templateApplyResultSchema.refine(
        (value) =>
          targetsMatch(value.items, request) &&
          value.items.every(
            (item) =>
              selectedOnly(item.applied_keys, request.keys) &&
              selectedOnly(item.skipped_locked_keys, request.keys) &&
              disjoint(item.applied_keys, item.skipped_locked_keys) &&
              selectedOnly(
                item.applied_capabilities ?? [],
                request.capability_keys ?? [],
              ) &&
              selectedOnly(
                item.skipped_locked_capabilities ?? [],
                request.capability_keys ?? [],
              ) &&
              disjoint(
                item.applied_capabilities ?? [],
                item.skipped_locked_capabilities ?? [],
              ),
          ),
      ),
      {
        ...conditionalOptions(bound, options),
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function listConfigurationHistory(
  context: C.CommsContext,
  scope: C.SettingsScope,
  input: C.TimeListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.ConfigurationHistory>> {
  const bound = S.commsContextSchema.parse(context);
  const target = S.settingsScopeSchema.parse(scope);
  const request = S.timeListRequestSchema.parse(input);
  return privateResponse(
    await apiFetchWithMetadata(
      `${settingsPath(scope)}/history?${queryString(request)}`,
      structurePageSchema(historySchemaFor(bound, target), request),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}
export async function getConfigurationHistory(
  context: C.CommsContext,
  scope: C.SettingsScope,
  historyId: string,
  options: C.RequestOptions = {},
): Promise<C.ConfigurationHistory> {
  const bound = S.commsContextSchema.parse(context);
  const target = S.settingsScopeSchema.parse(scope);
  z.uuid().parse(historyId);
  return privateResponse(
    await apiFetchWithMetadata(
      `${settingsPath(scope)}/history/${encodeURIComponent(historyId)}`,
      historySchemaFor(bound, target, historyId),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}
export async function previewConfigurationRestore(
  context: C.CommsContext,
  scope: C.SettingsScope,
  historyId: string,
  options: C.ConditionalOptions & C.FreshAdminOptions,
): Promise<C.Versioned<C.ConfigurationRestorePreview>> {
  const bound = S.commsContextSchema.parse(context);
  const target = S.settingsScopeSchema.parse(scope);
  const history_id = z.uuid().parse(historyId);
  const password = S.purgeRequestSchema.shape.password.parse(options?.password);
  const result = await apiFetchWithMetadata(
    `${settingsPath(scope)}/restoration-preview`,
    S.configurationRestorePreviewSchema.refine(
      (value) =>
        value.org_id === bound.org_id &&
        value.history_id === history_id &&
        sameScope(value.scope, target),
    ),
    {
      ...conditionalOptions(bound, options),
      method: "POST",
      body: JSON.stringify({ history_id, password }),
    },
  );
  privateResponse(result);
  return versionedResponse(result);
}
export async function restoreConfiguration(
  context: C.CommsContext,
  scope: C.SettingsScope,
  input: C.ConfigurationRestoreRequest,
  options: C.ConditionalOptions & C.FreshAdminOptions,
): Promise<C.Versioned<C.ConfigurationSnapshot>> {
  const bound = S.commsContextSchema.parse(context);
  const target = S.settingsScopeSchema.parse(scope);
  const request = S.configurationRestoreRequestSchema.parse(input);
  const password = S.purgeRequestSchema.shape.password.parse(options?.password);
  const result = await apiFetchWithMetadata(
    `${settingsPath(scope)}/restoration`,
    S.configurationSnapshotSchema.refine((value) =>
      sameScope(value.capabilities.scope, target),
    ),
    {
      ...conditionalOptions(bound, options),
      method: "POST",
      body: JSON.stringify({ ...request, password }),
    },
  );
  privateResponse(result);
  return versionedResponse(result);
}
