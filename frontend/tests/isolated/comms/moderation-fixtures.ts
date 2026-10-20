import * as api from "../../../src/components/systems/comms/adapters/moderation-api";
import { DEFAULT_SETTINGS } from "../../../src/components/systems/comms/domain/settings";
import {
  context,
  org,
  user,
  other,
  conversationId,
  messageId,
  messagePath,
  timestamp,
  conditional,
  etag,
  live,
  tombstone,
  page,
} from "./s18-fixtures";

export {
  context,
  org,
  user,
  other,
  conversationId,
  messageId,
  messagePath,
  timestamp,
  conditional,
  etag,
  live,
  tombstone,
  page,
};
export const conversationPath = `/api/comms/conversations/${conversationId}`;
export const reportId = "00000000-0000-4000-8000-000000000009";
export const revision = {
  id: other,
  message_id: messageId,
  author_id: user,
  created_at: timestamp,
  body: "Earlier text",
};
export const report = {
  id: reportId,
  org_id: org,
  conversation_id: conversationId,
  message_id: messageId,
  reporter_id: other,
  reason: "Please review",
  status: "open",
  created_at: timestamp,
  updated_at: timestamp,
};
export const resolved = { ...report, status: "resolved" };
export const reportEtag = '"report-source.v1.opaque-result"';
export const reportCondition = '"report-source.v1.opaque-observed"';
export const restrictions = { user_ids: [other], until: null };
export const settings = {
  org_id: org,
  scope: { kind: "channel", id: conversationId },
  overrides: { restricted_person_ids: [other], restriction_until: null },
  effective: {
    ...DEFAULT_SETTINGS,
    restricted_person_ids: [other],
    restriction_until: null,
  },
  locked_keys: [],
  sources: Object.fromEntries(
    Object.keys(DEFAULT_SETTINGS).map((key) => [key, { kind: "default" }]),
  ),
  metadata: [],
};
export const preview = {
  org_id: org,
  conversation_id: conversationId,
  message_count: 10_000,
  file_count: 2,
  max_seq: 10_025,
  impact_digest: "a".repeat(64),
  token: "synthetic-purge-challenge",
  expires_at: timestamp,
  confirmation_name: " Dispatch ",
  last_successful_backup_at: null,
};
// Synthetic, operation-local proof. Whitespace is intentionally significant.
export const purgeRequest = {
  token: "synthetic-purge-challenge",
  confirmation_name: " Dispatch ",
  password: " synthetic-only-proof ",
};
export const purged = {
  org_id: org,
  conversation_id: conversationId,
  operation_id: other,
  purged_message_count: 10_000,
  purged_file_count: 2,
};

type Call = {
  name: string;
  invoke: () => Promise<unknown>;
  path: string;
  method: string;
  wire: unknown;
  expected: unknown;
  status?: number;
  body?: object;
  conditional?: boolean;
  query?: Record<string, string>;
  etag?: string;
  ifMatch?: string;
};
export function calls(signal?: AbortSignal): Call[] {
  const options = { signal },
    conditions = { ...conditional, signal };
  const query = {
    limit: "25",
    offset: "0",
    sort_by: "created_at",
    sort_order: "asc",
  };
  return [
    {
      name: "list revisions",
      invoke: () =>
        api.listMessageRevisions(
          context,
          conversationId,
          messageId,
          {},
          options,
        ),
      path: `${messagePath}/revisions`,
      method: "GET",
      wire: page([revision]),
      expected: page([revision]),
      query,
    },
    {
      name: "submit report",
      invoke: () =>
        api.reportMessage(
          context,
          conversationId,
          messageId,
          { reason: " Please review " },
          options,
        ),
      path: `${messagePath}/reports`,
      method: "POST",
      wire: null,
      expected: undefined,
      status: 204,
      body: { reason: "Please review" },
    },
    {
      name: "list reports",
      invoke: () => api.listReports(context, {}, options),
      path: "/api/comms/reports",
      method: "GET",
      wire: page([report]),
      expected: page([report]),
      query,
    },
    {
      name: "get report",
      invoke: () => api.getReport(context, reportId, options),
      path: `/api/comms/reports/${reportId}`,
      method: "GET",
      wire: report,
      expected: { data: report, etag },
    },
    {
      name: "resolve report",
      invoke: () => api.resolveReport(context, reportId, conditions),
      path: `/api/comms/reports/${reportId}/resolution`,
      method: "POST",
      wire: resolved,
      expected: resolved,
      conditional: true,
    },
    {
      name: "remove message",
      invoke: () =>
        api.removeMessage(context, conversationId, messageId, conditions),
      path: `${messagePath}/removal`,
      method: "POST",
      wire: tombstone,
      expected: { data: tombstone, etag },
      conditional: true,
    },
    {
      name: "remove reported message",
      invoke: () =>
        api.removeReportedMessage(context, reportId, {
          if_match: reportCondition,
          signal,
        }),
      path: `/api/comms/reports/${reportId}/message-removal`,
      method: "POST",
      wire: report,
      expected: { data: report, etag: reportEtag },
      conditional: true,
      etag: reportEtag,
      ifMatch: reportCondition,
    },
    {
      name: "restore reported message",
      invoke: () =>
        api.restoreReportedMessage(context, reportId, {
          if_match: reportCondition,
          signal,
        }),
      path: `/api/comms/reports/${reportId}/message-restoration`,
      method: "POST",
      wire: report,
      expected: { data: report, etag: reportEtag },
      conditional: true,
      etag: reportEtag,
      ifMatch: reportCondition,
    },
    {
      name: "restore message",
      invoke: () =>
        api.restoreMessage(context, conversationId, messageId, conditions),
      path: `${messagePath}/restoration`,
      method: "POST",
      wire: live,
      expected: { data: live, etag },
      conditional: true,
    },
    {
      name: "list removed",
      invoke: () =>
        api.listRemovedMessages(context, conversationId, {}, options),
      path: `${conversationPath}/removed-messages`,
      method: "GET",
      wire: page([tombstone]),
      expected: page([tombstone]),
      query,
    },
    {
      name: "restrict posting",
      invoke: () =>
        api.setPostingRestrictions(
          context,
          conversationId,
          restrictions,
          conditions,
        ),
      path: `${conversationPath}/restrictions`,
      method: "PUT",
      wire: settings,
      expected: { data: settings, etag },
      body: restrictions,
      conditional: true,
    },
    {
      name: "preview purge",
      invoke: () => api.previewPurge(context, conversationId, options),
      path: `${conversationPath}/purge/preview`,
      method: "POST",
      wire: preview,
      expected: preview,
    },
    {
      name: "purge conversation",
      invoke: () =>
        api.purgeConversation(context, conversationId, purgeRequest, options),
      path: `${conversationPath}/purge`,
      method: "POST",
      wire: purged,
      expected: purged,
      body: purgeRequest,
    },
  ];
}
