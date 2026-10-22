import * as configuration from "../../../src/components/systems/comms/adapters/configuration-api";
import type * as C from "../../../src/components/systems/comms/contract/types";
import {
  context,
  org,
  user,
  other,
  conversationId,
  timestamp,
  etag,
  conditional,
  page,
} from "./s18-fixtures";
export {
  configuration,
  context,
  org,
  user,
  other,
  conversationId,
  timestamp,
  etag,
  conditional,
  page,
};

export const id = "00000000-0000-4000-8000-000000000011";
export const historyId = "00000000-0000-4000-8000-000000000012";
export const secondConversation = "00000000-0000-4000-8000-000000000013";
export const identity = {
  id,
  org_id: org,
  created_at: timestamp,
  updated_at: timestamp,
};
export const templateInput: C.TemplateImport = {
  name: " Dispatch ",
  description: "Channel defaults",
  settings: { formatting: false },
  capabilities: { everyone: { react: false }, group_grants: [] },
};
export const templateBody = { ...templateInput, name: "Dispatch" };
export const template = { ...identity, ...templateBody };
export const applyInput: C.TemplateApplyRequest = {
  conversation_ids: [conversationId],
  keys: ["formatting", "notification_sound"],
  capability_keys: ["react"],
};
export const applyPreview = {
  items: [
    {
      conversation_id: conversationId,
      before: { formatting: true, notification_sound: true },
      after: { formatting: false, notification_sound: true },
      skipped_locked_keys: ["notification_sound"],
      capabilities: {
        before: { everyone: { react: true }, group_grants: [] },
        after: { everyone: { react: false }, group_grants: [] },
        skipped_locked: [],
      },
    },
  ],
};
export const applied = {
  items: [
    {
      conversation_id: conversationId,
      applied_keys: ["formatting"],
      skipped_locked_keys: ["notification_sound"],
      applied_capabilities: ["react"],
      skipped_locked_capabilities: [],
    },
  ],
};
export const scopes: C.SettingsScope[] = [
  { kind: "workspace" },
  { kind: "category", id: other },
  { kind: "channel", id: conversationId },
];
export function snapshot(scope: C.SettingsScope) {
  return {
    settings: { formatting: false },
    capabilities: { scope, everyone: {}, group_grants: [] },
  };
}
export function history(scope: C.SettingsScope) {
  return {
    ...identity,
    id: historyId,
    actor_id: user,
    scope,
    before: snapshot(scope),
    after: { ...snapshot(scope), settings: { formatting: true } },
  };
}
export function restorationPreview(scope: C.SettingsScope) {
  return {
    org_id: org,
    history_id: historyId,
    scope,
    before: history(scope).after,
    after: history(scope).before,
    preview_digest: "d".repeat(64),
    expires_at: timestamp,
  };
}
export const restoreInput = {
  history_id: historyId,
  preview_digest: "d".repeat(64),
};
// Synthetic exact proof, never a real account credential.
export const password = " synthetic-history-proof ";
export const proof = { ...conditional, password };

type Call = {
  name: string;
  invoke: () => Promise<unknown>;
  path: string;
  method: string;
  wire: unknown;
  expected: unknown;
  status?: number;
  location?: string;
  body?: object;
  conditional?: boolean;
  versioned?: boolean;
  query?: Record<string, string>;
};
export function calls(signal?: AbortSignal): Call[] {
  const options = { signal },
    conditions = { ...conditional, signal },
    protectedOptions = { ...proof, signal };
  const query = {
    limit: "25",
    offset: "0",
    sort_by: "created_at",
    sort_order: "asc",
  };
  return [
    {
      name: "list templates",
      invoke: () => configuration.listTemplates(context, {}, options),
      path: "/api/comms/templates",
      method: "GET",
      wire: page([template]),
      expected: page([template]),
      query,
    },
    {
      name: "get template",
      invoke: () => configuration.getTemplate(context, id, options),
      path: `/api/comms/templates/${id}`,
      method: "GET",
      wire: template,
      expected: { data: template, etag },
      versioned: true,
    },
    {
      name: "create template",
      invoke: () =>
        configuration.createTemplate(context, templateInput, options),
      path: "/api/comms/templates",
      method: "POST",
      wire: template,
      expected: { data: template, etag },
      status: 201,
      location: `/api/comms/templates/${id}`,
      body: templateBody,
      versioned: true,
    },
    {
      name: "save template",
      invoke: () =>
        configuration.saveTemplate(context, id, templateInput, conditions),
      path: `/api/comms/templates/${id}`,
      method: "PUT",
      wire: template,
      expected: { data: template, etag },
      body: templateBody,
      conditional: true,
      versioned: true,
    },
    {
      name: "preview application",
      invoke: () =>
        configuration.previewTemplateApply(context, id, applyInput, options),
      path: `/api/comms/templates/${id}/application-preview`,
      method: "POST",
      wire: applyPreview,
      expected: { data: applyPreview, etag },
      body: applyInput,
      versioned: true,
    },
    {
      name: "apply template",
      invoke: () =>
        configuration.applyTemplate(context, id, applyInput, conditions),
      path: `/api/comms/templates/${id}/applications`,
      method: "POST",
      wire: applied,
      expected: applied,
      body: applyInput,
      conditional: true,
    },
    ...scopes.flatMap((scope): Call[] => {
      const path =
        scope.kind === "workspace"
          ? "/api/comms/settings/workspace"
          : `/api/comms/settings/${scope.kind}/${scope.id}`;
      return [
        {
          name: `list ${scope.kind} history`,
          invoke: () =>
            configuration.listConfigurationHistory(context, scope, {}, options),
          path: `${path}/history`,
          method: "GET",
          wire: page([history(scope)]),
          expected: page([history(scope)]),
          query,
        },
        {
          name: `get ${scope.kind} history`,
          invoke: () =>
            configuration.getConfigurationHistory(
              context,
              scope,
              historyId,
              options,
            ),
          path: `${path}/history/${historyId}`,
          method: "GET",
          wire: history(scope),
          expected: history(scope),
        },
        {
          name: `preview ${scope.kind} restoration`,
          invoke: () =>
            configuration.previewConfigurationRestore(
              context,
              scope,
              historyId,
              protectedOptions,
            ),
          path: `${path}/restoration-preview`,
          method: "POST",
          wire: restorationPreview(scope),
          expected: { data: restorationPreview(scope), etag },
          body: { history_id: historyId, password },
          conditional: true,
          versioned: true,
        },
        {
          name: `restore ${scope.kind} configuration`,
          invoke: () =>
            configuration.restoreConfiguration(
              context,
              scope,
              restoreInput,
              protectedOptions,
            ),
          path: `${path}/restoration`,
          method: "POST",
          wire: snapshot(scope),
          expected: { data: snapshot(scope), etag },
          body: { ...restoreInput, password },
          conditional: true,
          versioned: true,
        },
      ];
    }),
  ];
}
