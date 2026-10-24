import {
  downloadManageAuditCsv,
  getManageAuditExportPreview,
  getManageAuditOptions,
  listManageAuditLogs,
} from "../../../src/components/systems/manage/adapters/audit-api";
import { getAuditField } from "../../../src/components/systems/manage/adapters/audit-fields-api";
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
  getWorkspaceBrand,
  getWorkspaceCalendarSettings,
  getWorkspaceLifecycleSettings,
  updateManageWorkspace,
} from "../../../src/components/systems/manage/adapters/workspace-api";
import {
  getWorkspaceLogo,
  getWorkspaceLogoFile,
  reconcileWorkspaceLogo,
  reserveWorkspaceLogo,
  uploadWorkspaceLogo,
} from "../../../src/components/systems/manage/adapters/workspace-logo-api";
import {
  listManageJobs,
  retryManageJob,
} from "../../../src/components/systems/manage/adapters/jobs-api";
import { describeContracts } from "./openapi-contract";
import { wirePagination } from "../../helpers/pagination";

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
// The calendar read needs a calendar date.
const calendarWorkspace = { ...workspace, today: "2026-10-06" };

// A workspace logo is an image File the adapter asked for by id, with no
// record, board or department owner, at most 2 MiB.
const logoFile = {
  id: auditId,
  purpose: "workspace_logo",
  record_id: null,
  board_id: null,
  department_id: null,
  media_type: "image/png",
  expected_size: 1024,
  actual_size: 1024,
  state: "ready",
};
const logoBytes = () =>
  new File([new Uint8Array(1024)], "logo.png", { type: "image/png" });

// Jobs link values are application-relative; scheduled receipts retain kind/id.
const contractJob = {
  kind: "report-run",
  id: auditId,
  subject_label: "Contract Report",
  subject_link: "/openview?section=reports",
  state: "pending",
  scheduled_for: "2026-10-01T00:00:00Z",
  last_attempt_at: null,
  next_attempt_at: "2026-10-01T00:00:00Z",
  attempts: 0,
  failure_code: null,
  failure_label: null,
  can_retry: false,
};

describeContracts("Manage", [
  {
    name: "listManageJobs",
    run: () =>
      listManageJobs({
        kind: "report-run",
        state: "pending",
        limit: 10,
        offset: 0,
      }),
    // The standard page must describe the returned complete bounded page.
    responses: {
      "GET /api/jobs": {
        items: [contractJob],
        pagination: wirePagination({ limit: 10, count: 1, total: 1 }),
      },
    },
  },
  {
    name: "retryManageJob",
    run: () => retryManageJob({ kind: "report-run", id: auditId }),
    responses: { "POST /api/jobs/{kind}/{job_id}/retry": contractJob },
  },
  { name: "getWorkspaceAppearance", run: () => getWorkspaceAppearance() },
  {
    name: "listManageAuditLogs",
    run: () => listManageAuditLogs({ ...auditFilters, limit: 25, offset: 0 }),
  },
  { name: "getManageAuditOptions", run: () => getManageAuditOptions() },
  {
    name: "getAuditField",
    run: () => getAuditField(auditId),
    // The adapter accepts only the field it asked for.
    responses: { "GET /api/fields/{field_id}": { id: auditId } },
  },
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
    name: "getWorkspaceBrand",
    run: () => getWorkspaceBrand(),
    responses: { "GET /api/workspace": workspace },
  },
  {
    name: "getWorkspaceCalendarSettings",
    run: () => getWorkspaceCalendarSettings(),
    responses: { "GET /api/workspace": calendarWorkspace },
  },
  {
    name: "getWorkspaceLifecycleSettings",
    run: () => getWorkspaceLifecycleSettings(),
  },
  {
    name: "reserveWorkspaceLogo",
    run: () => reserveWorkspaceLogo(logoBytes()),
    responses: { "POST /api/files": logoFile },
  },
  {
    name: "uploadWorkspaceLogo",
    run: () => uploadWorkspaceLogo(auditId, logoBytes()),
    requestOnly: "The request body is the image bytes, not JSON",
  },
  {
    name: "getWorkspaceLogoFile",
    run: () => getWorkspaceLogoFile(auditId),
    responses: { "GET /api/files/{file_id}": logoFile },
  },
  {
    name: "reconcileWorkspaceLogo",
    run: () => reconcileWorkspaceLogo(auditId),
    responses: { "POST /api/files/{file_id}/reconcile": logoFile },
  },
  {
    name: "getWorkspaceLogo",
    run: () => getWorkspaceLogo(auditId),
    requestOnly: "The response is the image bytes, not JSON",
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
