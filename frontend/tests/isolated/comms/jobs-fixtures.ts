import * as jobs from "../../../src/components/systems/comms/adapters/jobs-api";
import * as retention from "../../../src/components/systems/comms/adapters/retention-api";
export { jobs, retention };
export {
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

export const jobId = "00000000-0000-4000-8000-000000000010";
export const scheduleInput = {
  conversation_id: conversationId,
  client_key: other,
  body: "Scheduled message",
  send_at: "2026-10-22T12:00:00Z",
};
export const scheduleRequest = {
  ...scheduleInput,
  attachment_ids: [],
  record_ids: [],
  mention_user_ids: [],
  mentions_channel: false,
  mentions_here: false,
  reply_to_id: null,
  parent_id: null,
  also_send_to_channel: false,
};
export const schedule = {
  id: jobId,
  org_id: org,
  author_id: user,
  request: scheduleRequest,
  status: "pending",
  message_id: null,
  failure_code: null,
  created_at: timestamp,
  updated_at: timestamp,
};
export const exportRequest = {
  conversation_ids: [conversationId],
  format: "csv" as const,
  reason: "Audit review",
};
export const exportJob = {
  id: jobId,
  org_id: org,
  requested_by: user,
  request: exportRequest,
  status: "pending",
  failure_code: null,
  created_at: timestamp,
  updated_at: timestamp,
};
export const workspacePolicy = {
  scope: { kind: "workspace" as const },
  message_days: 30,
  file_days: 0,
};
export const channelPolicy = {
  scope: { kind: "channel" as const, id: conversationId },
  message_days: null,
  file_days: 7,
};
export const retained = {
  policy: channelPolicy,
  effective: { message_days: 30, file_days: 7 },
  sources: { message_days: "workspace", file_days: "channel" },
};
export const preview = {
  ...retained,
  message_count: 120,
  file_count: 3,
  preview_digest: "c".repeat(64),
  expires_at: timestamp,
};
export const retentionRequest = {
  ...channelPolicy,
  preview_digest: preview.preview_digest,
};
// Deliberately synthetic. Exact proof whitespace belongs to this operation only.
export const password = " synthetic-retention-proof ";
export const proof = { ...conditional, password };
export const downloadHeaders = {
  "Content-Type": "text/csv; charset=utf-8",
  "Content-Disposition": 'attachment; filename="comms-export.csv"',
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Length": "5",
};

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
  query?: Record<string, string>;
  versioned?: boolean;
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
      name: "list schedules",
      invoke: () => jobs.listSchedules(context, {}, options),
      path: "/api/comms/scheduled-messages",
      method: "GET",
      wire: page([schedule]),
      expected: page([schedule]),
      query,
    },
    {
      name: "get schedule",
      invoke: () => jobs.getSchedule(context, jobId, options),
      path: `/api/comms/scheduled-messages/${jobId}`,
      method: "GET",
      wire: schedule,
      expected: { data: schedule, etag },
      versioned: true,
    },
    {
      name: "create schedule",
      invoke: () => jobs.createSchedule(context, scheduleInput, options),
      path: "/api/comms/scheduled-messages",
      method: "POST",
      wire: schedule,
      expected: { data: schedule, etag },
      status: 201,
      location: `/api/comms/scheduled-messages/${jobId}`,
      body: scheduleRequest,
      versioned: true,
    },
    {
      name: "update schedule",
      invoke: () =>
        jobs.updateSchedule(context, jobId, scheduleInput, conditions),
      path: `/api/comms/scheduled-messages/${jobId}`,
      method: "PUT",
      wire: schedule,
      expected: { data: schedule, etag },
      body: scheduleRequest,
      conditional: true,
      versioned: true,
    },
    {
      name: "send schedule now",
      invoke: () => jobs.sendScheduleNow(context, jobId, conditions),
      path: `/api/comms/scheduled-messages/${jobId}/send`,
      method: "POST",
      wire: { ...schedule, status: "running" },
      expected: { ...schedule, status: "running" },
      conditional: true,
    },
    {
      name: "cancel schedule",
      invoke: () => jobs.cancelSchedule(context, jobId, conditions),
      path: `/api/comms/scheduled-messages/${jobId}/cancellation`,
      method: "POST",
      wire: { ...schedule, status: "cancelled" },
      expected: { ...schedule, status: "cancelled" },
      conditional: true,
    },
    {
      name: "get retention",
      invoke: () =>
        retention.getRetention(context, channelPolicy.scope, options),
      path: "/api/comms/retention",
      method: "GET",
      wire: retained,
      expected: { data: retained, etag },
      query: { scope_kind: "channel", channel_id: conversationId },
      versioned: true,
    },
    {
      name: "preview retention",
      invoke: () =>
        retention.previewRetention(context, channelPolicy, protectedOptions),
      path: "/api/comms/retention/preview",
      method: "POST",
      wire: preview,
      expected: preview,
      body: { ...channelPolicy, password },
      conditional: true,
    },
    {
      name: "update retention",
      invoke: () =>
        retention.updateRetention(context, retentionRequest, protectedOptions),
      path: "/api/comms/retention",
      method: "PUT",
      wire: retained,
      expected: { data: retained, etag },
      body: { ...retentionRequest, password },
      conditional: true,
      versioned: true,
    },
    {
      name: "list exports",
      invoke: () => jobs.listExports(context, {}, options),
      path: "/api/comms/exports",
      method: "GET",
      wire: page([exportJob]),
      expected: page([exportJob]),
      query,
    },
    {
      name: "start export",
      invoke: () =>
        jobs.startExport(context, exportRequest, { password, signal }),
      path: "/api/comms/exports",
      method: "POST",
      wire: exportJob,
      expected: exportJob,
      status: 201,
      location: `/api/comms/exports/${jobId}`,
      body: { ...exportRequest, password },
    },
    {
      name: "get export",
      invoke: () => jobs.getExport(context, jobId, options),
      path: `/api/comms/exports/${jobId}`,
      method: "GET",
      wire: exportJob,
      expected: exportJob,
    },
  ];
}
