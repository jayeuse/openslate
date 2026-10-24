import { z } from "zod";
import { DEFAULT_TABLE_PAGE_SIZE } from "@/components/ui/table-pagination";
import { ApiError, apiFetch } from "@/lib/api";

export const backupScheduleSchema = z.enum(["disabled", "daily", "weekly"]);
const retentionSchema = z.union([z.literal(7), z.literal(30), z.literal(90)]);
const timeSchema = z.iso.datetime({ offset: true });
const backupStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
]);
const backupRunSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  provenance: z.enum(["manual", "scheduled"]),
  installation: z.enum(["current", "previous"]),
  state: backupStateSchema,
  requested_at: timeSchema,
  started_at: timeSchema.nullable(),
  finished_at: timeSchema.nullable(),
  reconciled_at: timeSchema.nullable(),
  schedule: backupScheduleSchema,
  retention_days: retentionSchema,
  snapshot_id: z.string().nullable(),
  manifest_sha256: z.string().nullable(),
  verified_at: timeSchema.nullable(),
  failure_code: z.string().nullable(),
  expired_at: timeSchema.nullable(),
});
const policyFields = {
  schedule: backupScheduleSchema,
  retention_days: retentionSchema,
};
const backupStatusSchema = z.object({
  policy: z.object({
    ...policyFields,
    revision: z.number().int().positive(),
    timezone: z.string().min(1),
    next_due_at: timeSchema.nullable(),
    adopted: z.boolean(),
  }),
  runner: z.object({
    state: z.enum([
      "unknown",
      "available",
      "stale",
      "recovery_required",
      "adoption_required",
    ]),
    last_seen_at: timeSchema.nullable(),
  }),
  active_run: backupRunSchema.nullable(),
  queued_count: z.number().int().nonnegative(),
});
const backupPatchSchema = z
  .object({
    revision: z.number().int().positive(),
    ...z.object(policyFields).partial().shape,
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 1);
const backupsSchema = z.object({
  items: z.array(backupRunSchema),
  pagination: z.object({
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    has_more: z.boolean(),
  }),
});
const versionSchema = z.object({
  current_version: z.string().min(1),
  status: z.enum(["unknown", "available", "current", "unavailable", "stale"]),
  latest_version: z.string().nullable(),
  observed_at: timeSchema.nullable(),
  checked_at: timeSchema.nullable(),
  failure_code: z.string().nullable(),
  release_url: z
    .string()
    .regex(
      /^https:\/\/github\.com\/jayeuse\/openslate\/releases\/tag\/v?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/,
    )
    .nullable(),
});
const backupNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((name) => !/[\p{C}\p{Zl}\p{Zp}]/u.test(name));
const backupCreateSchema = z.object({ name: backupNameSchema }).strict();
const exportIdSchema = z.uuid();
const exportPassphraseSchema = z
  .string()
  .refine(
    (value) =>
      Array.from(value).length >= 16 &&
      Array.from(value).length <= 128 &&
      new TextEncoder().encode(value).byteLength <= 512 &&
      value.trim() === value &&
      !/[\p{C}\p{Z}]/u.test(value.replaceAll(" ", "")),
  );
const exportCreateSchema = z
  .object({
    backup_run_id: z.uuid(),
    passphrase: exportPassphraseSchema,
  })
  .strict();
const exportTimeSchema = timeSchema.refine((value) =>
  /(?:Z|\+00:00)$/.test(value),
);
const exportResponseSchema = z
  .object({
    id: exportIdSchema,
    backup_run_id: z.uuid(),
    state: z.enum([
      "queued",
      "preparing",
      "ready",
      "failed",
      "interrupted",
      "expired",
    ]),
    requested_at: exportTimeSchema,
    ready_at: exportTimeSchema.nullable(),
    expires_at: exportTimeSchema.nullable(),
    size_bytes: z.number().int().positive().nullable(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    failure_code: z
      .enum([
        "source_unavailable",
        "source_unproven",
        "copy_failed",
        "verification_failed",
        "export_interrupted",
        "result_unconfirmed",
      ])
      .nullable(),
  })
  .strict()
  .refine((value) => {
    const facts = [
      value.ready_at,
      value.expires_at,
      value.size_bytes,
      value.sha256,
    ];
    if (value.state === "ready" || value.state === "expired")
      return (
        facts.every((fact) => fact !== null) && value.failure_code === null
      );
    return (
      facts.every((fact) => fact === null) &&
      (value.state === "failed" || value.state === "interrupted"
        ? value.failure_code !== null
        : value.failure_code === null)
    );
  });
const exportAdmissionRequestSchema = z
  .object({
    password: z.string().refine((value) => {
      const length = Array.from(value).length;
      return length >= 1 && length <= 128;
    }),
  })
  .strict();
const exportAdmissionSchema = z
  .object({ expires_at: exportTimeSchema })
  .strict();

export type ManageBackupRun = z.output<typeof backupRunSchema>;
export type ManageBackupStatus = z.output<typeof backupStatusSchema>;
export type ManageBackupPatch = z.output<typeof backupPatchSchema>;
export type ManageBackups = z.output<typeof backupsSchema>;
export type ManageVersion = z.output<typeof versionSchema>;
export type ManageBackupExport = z.output<typeof exportResponseSchema>;
export type BackupPolicyDraft = Partial<
  Pick<ManageBackupStatus["policy"], "schedule" | "retention_days">
>;
export type ManageBackupsRequest = {
  limit: number;
  offset: number;
  search: string;
  sort_by: "requested_at" | "name" | "state" | "provenance" | "finished_at";
  sort_order: "asc" | "desc";
  state: "all" | ManageBackupRun["state"];
  provenance: "all" | ManageBackupRun["provenance"];
  installation: "all" | ManageBackupRun["installation"];
  run_id?: string;
};
export const defaultManageBackupsRequest: ManageBackupsRequest = {
  limit: DEFAULT_TABLE_PAGE_SIZE,
  offset: 0,
  search: "",
  sort_by: "requested_at",
  sort_order: "desc",
  state: "all",
  provenance: "all",
  installation: "all",
};

export function backupPolicyPatch(
  policy: ManageBackupStatus["policy"],
  draft: BackupPolicyDraft,
): ManageBackupPatch | null {
  const patch: ManageBackupPatch = { revision: policy.revision };
  if (draft.schedule !== undefined && draft.schedule !== policy.schedule)
    patch.schedule = draft.schedule;
  if (
    draft.retention_days !== undefined &&
    draft.retention_days !== policy.retention_days
  )
    patch.retention_days = draft.retention_days;
  return Object.keys(patch).length > 1 ? patch : null;
}

/** Backup and Updates belong to the installation owner (`operator_required`). */
export const OWNER_REFUSAL_MESSAGE = "Only the installation owner can do this.";

export function isOwnerRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.code === "operator_required"
  );
}

export function backupNameError(name: string): string | null {
  return backupNameSchema.safeParse(name).success
    ? null
    : "Enter a backup name using 1–120 printable characters.";
}

export function isManageBackupExportId(value: string): boolean {
  return exportIdSchema.safeParse(value).success;
}

export function exportPassphraseError(value: string): string | null {
  return exportPassphraseSchema.safeParse(value).success
    ? null
    : "Use 16–128 printable characters, without spaces at the start or end.";
}

export function backupExportSourceAvailable(run: ManageBackupRun): boolean {
  return (
    run.installation === "current" &&
    run.snapshot_id !== null &&
    run.verified_at !== null &&
    run.reconciled_at !== null &&
    run.expired_at === null
  );
}

export function getManageBackupStatus(signal?: AbortSignal) {
  return apiFetch("/backups/status", backupStatusSchema, {
    cache: "no-store",
    signal,
  });
}
export function updateManageBackupPolicy(
  patch: ManageBackupPatch,
  signal?: AbortSignal,
) {
  return apiFetch("/backups/status", backupStatusSchema, {
    method: "PATCH",
    body: JSON.stringify(backupPatchSchema.parse(patch)),
    signal,
  });
}
export function listManageBackups(
  request: ManageBackupsRequest,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ deleted: "exclude" });
  for (const [key, value] of Object.entries(request))
    if (value !== undefined && value !== "all") params.set(key, String(value));
  return apiFetch(`/backups?${params}`, backupsSchema, {
    cache: "no-store",
    signal,
  });
}
export function queueManageBackup(
  name: string,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  z.string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/)
    .parse(idempotencyKey);
  return apiFetch("/backups", backupRunSchema, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(backupCreateSchema.parse({ name })),
    signal,
  });
}
export function getManageVersion(signal?: AbortSignal) {
  return apiFetch("/version", versionSchema, { cache: "no-store", signal });
}

export function queueManageBackupExport(
  payload: { backup_run_id: string; passphrase: string },
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  z.string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/)
    .parse(idempotencyKey);
  return apiFetch("/backups/exports", exportResponseSchema, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(exportCreateSchema.parse(payload)),
    signal,
  });
}

export function getManageBackupExport(id: string, signal?: AbortSignal) {
  exportIdSchema.parse(id);
  return apiFetch(`/backups/exports/${id}`, exportResponseSchema, {
    cache: "no-store",
    signal,
  });
}

export function admitManageBackupExportDownload(
  id: string,
  password: string,
  signal?: AbortSignal,
) {
  exportIdSchema.parse(id);
  return apiFetch(
    `/backups/exports/${id}/download-admission`,
    exportAdmissionSchema,
    {
      method: "POST",
      body: JSON.stringify(exportAdmissionRequestSchema.parse({ password })),
      refreshOnUnauthorized: false,
      signal,
    },
  );
}

export function manageBackupExportContentUrl(id: string): string {
  exportIdSchema.parse(id);
  return "/api/backups/exports/" + id + "/content";
}

export const backupScheduleLabels = {
  disabled: "Disabled",
  daily: "Daily at 02:00",
  weekly: "Weekly on Sunday at 02:00",
} as const;
export const backupStateLabels = {
  queued: "Queued",
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
} as const;
const failureLabels: Record<string, string> = {
  backup_failed: "The backup did not finish",
  backup_interrupted: "The backup was interrupted",
  verification_failed: "The backup could not be verified",
  restart_failed: "Services did not restart",
  readiness_failed: "Services restarted but did not become ready",
  result_unconfirmed: "The result could not be confirmed",
  retention_failed: "Old backups could not be removed",
  release_unavailable: "The release source was unavailable",
  release_invalid: "The release source sent an invalid answer",
  release_timeout: "The release source did not answer in time",
};
/** Plain-language text for a recorded failure code; unknown codes stay readable. */
export function failureLabel(code: string): string {
  return failureLabels[code] ?? code.replaceAll("_", " ");
}
export const restoreProcedureUrl =
  "https://github.com/jayeuse/openslate/blob/main/infra/supabase/RESTORE.md";
export const updateProcedureUrl =
  "https://github.com/jayeuse/openslate/blob/main/infra/supabase/README.md#operator-updates";
