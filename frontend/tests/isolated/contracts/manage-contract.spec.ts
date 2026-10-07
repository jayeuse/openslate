import {
  downloadManageAuditCsv,
  getManageAuditExportPreview,
  getManageAuditLog,
  getManageAuditOptions,
  listManageAuditLogs,
} from "../../../src/components/systems/manage/adapters/audit-api";
import {
  admitManageBackupExportDownload,
  getManageBackupExport,
  getManageBackupStatus,
  getManageVersion,
  listManageBackups,
  queueManageBackup,
  queueManageBackupExport,
  updateManageBackupPolicy,
} from "../../../src/components/systems/manage/adapters/backup-api";
import {
  getManageWorkspace,
  getWorkspaceAppearance,
  updateManageWorkspace,
} from "../../../src/components/systems/manage/adapters/workspace-api";
import { describeContracts } from "./openapi-contract";

const auditId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const auditFilters = {
  search: "pump",
  action: "update",
  entityType: "record",
  performedBy: userId,
  createdAfter: "2026-01-01T00:00:00Z",
  createdBefore: "2026-02-01T00:00:00Z",
  sortOrder: "desc",
} as const;

// Backups keep 7, 30 or 90 days; the screen offers only those.
const backupRun = { retention_days: 30 };
const queuedExport = {
  state: "queued",
  ready_at: null,
  expires_at: null,
  size_bytes: null,
  sha256: null,
  failure_code: null,
};
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
    name: "queueManageBackupExport",
    run: () =>
      queueManageBackupExport(
        { backup_run_id: auditId, passphrase: "synthetic-export-passphrase" },
        "export-key-1",
      ),
    responses: { "POST /api/backups/exports": queuedExport },
  },
  {
    name: "getManageBackupExport",
    run: () => getManageBackupExport(auditId),
    responses: { "GET /api/backups/exports/{export_id}": queuedExport },
  },
  {
    name: "admitManageBackupExportDownload",
    // Acting passwords use the existing 1–128-character verifier, not the
    // policy for choosing a new password.
    run: () => admitManageBackupExportDownload(auditId, "old"),
  },
  {
    name: "getManageVersion",
    run: () => getManageVersion(),
    responses: { "GET /api/version": version },
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
        legal_name: "Harbor Clinic Ltd",
        description: "Organization profile",
        contact_email: "clinic@example.com",
        contact_phone: null,
        postal_address: "Clinic Street",
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
