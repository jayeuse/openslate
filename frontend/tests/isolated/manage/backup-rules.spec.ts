import { expect, test } from "@playwright/test";

import {
  backupExportSourceAvailable,
  backupNameError,
  backupPolicyPatch,
  exportPassphraseError,
  failureLabel,
  isManageBackupExportId,
  type ManageBackupRun,
  type ManageBackupStatus,
} from "../../../src/components/systems/manage/adapters/backup-api";

// Backup rules the screen applies before it sends a request: which recovery
// points can be exported, the passphrase and backup-name rules, the routed
// export id, the policy patch, and the recorded failure labels. The http
// journeys keep one example of each: "export validates the passphrase before
// a request and cancels with empty secrets and restored phone focus" (a short
// passphrase), "export refuses an unverified source", "Back up now queues
// real history, cancels without writes, and preserves policy drafts" (a blank
// name), and "export reports an invalid route UUID without requesting another
// operation".

const passphraseError =
  "Use 16–128 printable characters, without spaces at the start or end.";
const valid = "Harbor-鍵-export-passphrase";

// The first six rows are the inputs the http journey used to send one by one.
const passphrases: { name: string; value: string; error: string | null }[] = [
  { name: "a short passphrase", value: "too-short", error: passphraseError },
  {
    name: "a leading space",
    value: " " + valid,
    error: passphraseError,
  },
  {
    name: "a trailing space",
    value: valid + " ",
    error: passphraseError,
  },
  {
    name: "a control character",
    value: "Harbor-\u0001-export-passphrase",
    error: passphraseError,
  },
  {
    name: "a line separator",
    value: "Harbor- -export-passphrase",
    error: passphraseError,
  },
  {
    name: "129 characters",
    value: "x".repeat(129),
    error: passphraseError,
  },
  {
    name: "a no-break space",
    value: "A printable export passphrase",
    error: passphraseError,
  },
  { name: "15 characters", value: "x".repeat(15), error: passphraseError },
  { name: "16 characters", value: "x".repeat(16), error: null },
  { name: "128 characters", value: "x".repeat(128), error: null },
  {
    name: "128 four-byte characters (512 bytes)",
    value: "🗝".repeat(128),
    error: null,
  },
  {
    name: "printable Unicode with inner spaces",
    value: "A printable é export passphrase",
    error: null,
  },
  { name: "printable Unicode", value: valid, error: null },
];

for (const row of passphrases)
  test(`an export passphrase with ${row.name} is ${row.error ? "refused" : "accepted"}`, () => {
    expect(exportPassphraseError(row.value)).toBe(row.error);
  });

const nameError = "Enter a backup name using 1–120 printable characters.";
const names: { name: string; value: string; error: string | null }[] = [
  { name: "an empty name", value: "", error: nameError },
  { name: "a blank name", value: " ", error: nameError },
  { name: "121 characters", value: "b".repeat(121), error: nameError },
  {
    name: "a control character",
    value: "Nightly\u0001backup",
    error: nameError,
  },
  {
    name: "a paragraph separator",
    value: "Nightly backup",
    error: nameError,
  },
  { name: "120 characters", value: "b".repeat(120), error: null },
  { name: "outer spaces", value: "  Before update  ", error: null },
];

for (const row of names)
  test(`a backup name with ${row.name} is ${row.error ? "refused" : "accepted"}`, () => {
    expect(backupNameError(row.value)).toBe(row.error);
  });

const exportIds: { value: string; valid: boolean }[] = [
  { value: "not-a-uuid", valid: false },
  { value: "abcdefab-cdef-4abc-8def-abcdefabcdef", valid: true },
  { value: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF", valid: true },
];

for (const row of exportIds)
  test(`the routed export id ${row.value} is ${row.valid ? "accepted" : "refused"}`, () => {
    expect(isManageBackupExportId(row.value)).toBe(row.valid);
  });

function run(values: Partial<ManageBackupRun> = {}): ManageBackupRun {
  return {
    id: "00000000-0000-4000-8000-000000000701",
    name: "Backup 1",
    provenance: "manual",
    installation: "current",
    state: "succeeded",
    requested_at: "2026-10-07T02:00:00Z",
    started_at: "2026-10-07T02:01:00Z",
    finished_at: "2026-10-07T02:05:00Z",
    reconciled_at: "2026-10-07T02:05:00Z",
    schedule: "daily",
    retention_days: 30,
    snapshot_id: "1".repeat(64),
    manifest_sha256: "a".repeat(64),
    verified_at: "2026-10-07T02:04:00Z",
    failure_code: null,
    expired_at: null,
    ...values,
  };
}

// The http journey keeps the unverified source; the other refusals are the
// sources it used to load one by one.
const sources: {
  name: string;
  values: Partial<ManageBackupRun>;
  available: boolean;
}[] = [
  {
    name: "a verified, reconciled current backup",
    values: {},
    available: true,
  },
  {
    name: "a retention-failed backup that was verified and reconciled",
    values: { state: "failed", failure_code: "retention_failed" },
    available: true,
  },
  {
    name: "a previous installation",
    values: { installation: "previous" },
    available: false,
  },
  {
    name: "an unverified source",
    values: { verified_at: null },
    available: false,
  },
  {
    name: "an unreconciled source",
    values: { reconciled_at: null },
    available: false,
  },
  {
    name: "an expired source",
    values: { expired_at: "2026-10-01T00:00:00Z" },
    available: false,
  },
  {
    name: "a source without a snapshot",
    values: { snapshot_id: null },
    available: false,
  },
];

for (const row of sources)
  test(`export is ${row.available ? "available" : "refused"} for ${row.name}`, () => {
    expect(backupExportSourceAvailable(run(row.values))).toBe(row.available);
  });

const policy: ManageBackupStatus["policy"] = {
  schedule: "disabled",
  retention_days: 30,
  revision: 3,
  timezone: "Asia/Manila",
  next_due_at: null,
  adopted: true,
};

const patches: {
  name: string;
  draft: Parameters<typeof backupPolicyPatch>[1];
  patch: ReturnType<typeof backupPolicyPatch>;
}[] = [
  { name: "an empty draft", draft: {}, patch: null },
  {
    name: "a draft equal to the policy",
    draft: { schedule: "disabled", retention_days: 30 },
    patch: null,
  },
  {
    name: "a schedule change",
    draft: { schedule: "weekly", retention_days: 30 },
    patch: { revision: 3, schedule: "weekly" },
  },
  {
    name: "a retention change",
    draft: { retention_days: 7 },
    patch: { revision: 3, retention_days: 7 },
  },
  {
    name: "both changes",
    draft: { schedule: "daily", retention_days: 90 },
    patch: { revision: 3, schedule: "daily", retention_days: 90 },
  },
];

for (const row of patches)
  test(`the backup policy patch for ${row.name}`, () => {
    expect(backupPolicyPatch(policy, row.draft)).toEqual(row.patch);
  });

const failureLabels: { code: string; label: string }[] = [
  { code: "backup_failed", label: "The backup did not finish" },
  { code: "backup_interrupted", label: "The backup was interrupted" },
  { code: "verification_failed", label: "The backup could not be verified" },
  { code: "restart_failed", label: "The server did not restart" },
  {
    code: "readiness_failed",
    label: "The server restarted but is not ready",
  },
  { code: "result_unconfirmed", label: "The result could not be confirmed" },
  { code: "retention_failed", label: "Old backups could not be removed" },
  { code: "release_unavailable", label: "The release source was unavailable" },
  {
    code: "release_invalid",
    label: "The release source sent an invalid answer",
  },
  {
    code: "release_timeout",
    label: "The release source did not answer in time",
  },
  // Export failure codes read as plain words too (Phase 7, MG17); the http
  // journey keeps source_unavailable and export_interrupted.
  { code: "source_unavailable", label: "The backup is no longer available" },
  { code: "source_unproven", label: "The backup could not be checked" },
  { code: "copy_failed", label: "The copy did not finish" },
  { code: "export_interrupted", label: "The export was interrupted" },
  { code: "foo_bar", label: "foo bar" },
];

for (const row of failureLabels)
  test(`failure code ${row.code} reads "${row.label}"`, () => {
    expect(failureLabel(row.code)).toBe(row.label);
  });
