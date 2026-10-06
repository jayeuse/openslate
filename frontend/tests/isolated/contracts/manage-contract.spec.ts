import {
  downloadManageAuditCsv,
  getManageAuditExportPreview,
  getManageAuditLog,
  getManageAuditOptions,
  listManageAuditLogs,
} from "../../../src/components/systems/manage/adapters/audit-api";
import {
  getManageBackupStatus,
  getManageVersion,
  listManageBackups,
  queueManageBackup,
  updateManageBackupPolicy,
} from "../../../src/components/systems/manage/adapters/backup-api";
import {
  endAllManageRemoteSessions,
  endManageSession,
  getManageSecurityPolicy,
  listManageSessions,
  updateManageSecurityPolicy,
} from "../../../src/components/systems/manage/adapters/security-api";
import {
  getManageWorkspace,
  getWorkspaceAppearance,
  updateManageWorkspace,
} from "../../../src/components/systems/manage/adapters/workspace-api";
import { describeContracts } from "./openapi-contract";

const auditId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const auditFilters = {
  search: "pump",
  action: "update",
  entityType: "record",
  performedBy: userId,
  createdAfter: "2026-01-01T00:00:00Z",
  createdBefore: "2026-02-01T00:00:00Z",
  sortOrder: "desc",
} as const;

// The frontend accepts only the policy values the settings screen can show.
const securityPolicy = {
  session_timeout_minutes: 30,
  password_min_length: 12,
  password_require_mixed_case: true,
  password_require_number: false,
};
// Backups keep 7, 30 or 90 days; the screen offers only those.
const backupRun = { retention_days: 30 };
// Release links must point at a tagged OpenSlate release.
const version = {
  release_url: "https://github.com/jayeuse/openslate/releases/tag/v1.2.3",
};
// Currency is an ISO 4217 code.
const workspace = { currency: "PHP" };

describeContracts("Manage", [
  { name: "getWorkspaceAppearance", run: () => getWorkspaceAppearance() },
  {
    name: "listManageAuditLogs",
    run: () => listManageAuditLogs({ ...auditFilters, limit: 25, offset: 0 }),
  },
  { name: "getManageAuditLog", run: () => getManageAuditLog(auditId) },
  { name: "getManageAuditOptions", run: () => getManageAuditOptions() },
  {
    name: "getManageAuditExportPreview",
    run: () => getManageAuditExportPreview(auditFilters),
  },
  {
    name: "downloadManageAuditCsv",
    run: () => downloadManageAuditCsv(auditFilters),
    requestOnly: "The response is a CSV file, not JSON",
  },
  {
    name: "getManageBackupStatus",
    run: () => getManageBackupStatus(),
    responses: {
      "GET /api/backups/status": {
        policy: backupRun,
        active_run: backupRun,
      },
    },
  },
  {
    name: "updateManageBackupPolicy",
    run: () =>
      updateManageBackupPolicy({
        revision: 2,
        schedule: "daily",
        retention_days: 30,
      }),
    responses: {
      "PATCH /api/backups/status": {
        policy: backupRun,
        active_run: backupRun,
      },
    },
  },
  {
    name: "listManageBackups",
    run: () =>
      listManageBackups({
        limit: 4,
        offset: 0,
        search: "nightly",
        sort_by: "requested_at",
        sort_order: "desc",
        state: "succeeded",
        provenance: "manual",
        installation: "current",
        run_id: auditId,
      }),
    responses: { "GET /api/backups": { items: [backupRun] } },
  },
  {
    name: "queueManageBackup",
    run: () => queueManageBackup("Before update", "backup-key-1"),
    responses: { "POST /api/backups": backupRun },
  },
  {
    name: "getManageVersion",
    run: () => getManageVersion(),
    responses: { "GET /api/version": version },
  },
  {
    name: "getManageSecurityPolicy",
    run: () => getManageSecurityPolicy(),
    responses: { "GET /api/workspace/security": securityPolicy },
  },
  {
    name: "updateManageSecurityPolicy",
    run: () =>
      updateManageSecurityPolicy({
        revision: 2,
        session_timeout_minutes: 30,
        password_min_length: 16,
        password_require_mixed_case: true,
        password_require_number: true,
        mfa_policy: "admins",
        ip_allow_list: ["10.0.0.0/8"],
      }),
    responses: { "PATCH /api/workspace/security": securityPolicy },
  },
  {
    name: "listManageSessions",
    run: () =>
      listManageSessions({
        limit: 4,
        offset: 0,
        search: "ana",
        sort_by: "person_name",
        sort_order: "asc",
        status: "remote",
        device: "Desktop",
      }),
  },
  {
    name: "endManageSession",
    run: () =>
      endManageSession({
        id: sessionId,
        user_id: userId,
        person_name: "Ana",
        user_agent: null,
        device: "Desktop",
        browser: "Firefox",
        created_at: "2026-01-01T00:00:00Z",
        refreshed_at: "2026-01-01T00:00:00Z",
        expires_at: "2026-01-02T00:00:00Z",
        current: false,
      }),
  },
  {
    name: "endAllManageRemoteSessions",
    run: () => endAllManageRemoteSessions(),
  },
  {
    name: "getManageWorkspace",
    run: () => getManageWorkspace(),
    responses: { "GET /api/workspace": workspace },
  },
  {
    name: "updateManageWorkspace",
    run: () =>
      updateManageWorkspace({
        revision: 2,
        display_name: "Harbor Clinic",
        locale: "en-PH",
        timezone: "Asia/Manila",
        mark: "HC",
        currency: "PHP",
        week_start: "monday",
        business_hours: "08:00-17:00",
        theme: "stockroom",
      }),
    responses: { "PATCH /api/workspace": workspace },
  },
]);
