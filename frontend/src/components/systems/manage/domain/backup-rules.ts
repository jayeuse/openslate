import {
  backupScheduleLabels,
  backupStateLabels,
  type ManageBackupRun,
  type ManageBackupStatus,
} from "../adapters/backup-api";

// The words of the Backup status panel and history (MD8). The status payload
// carries the schedule, the service and the queue; the last good backup is
// the newest completed run from this installation, read on its own.

export type BackupTone = "flow" | "action" | "danger" | "warn" | "muted";

/** The newest completed run, none yet, or its read state. */
export type LastGoodBackup = ManageBackupRun | null | "loading" | "unavailable";

export type BackupStatusFacts = {
  schedule: string;
  lastGood: string;
  /** The state word on its own, then when the service last checked in. */
  service: { state: string; detail: string };
  queue: string;
  /** One line in warning ink when the service needs attention. */
  warning: string | null;
};

const serviceWords: Record<ManageBackupStatus["runner"]["state"], string> = {
  unknown: "Unknown",
  available: "Available",
  stale: "Not checked in recently",
  recovery_required: "Needs recovery on the server",
  adoption_required: "Needs confirmation after a restore",
};

const serviceWarnings: Record<
  ManageBackupStatus["runner"]["state"],
  string | null
> = {
  unknown: "The backup service has not checked in yet.",
  available: null,
  stale: "The backup service has not checked in recently.",
  // A backup that started but was never closed (`unresolved_run`).
  recovery_required:
    "The person who runs your server must run backup recovery. New requests wait in the queue.",
  // A schedule that came from another installation in a restore.
  adoption_required:
    "The person who runs your server must confirm backups after the restore. New requests wait in the queue.",
};

function kept(days: number): string {
  return `Kept ${days} days`;
}

export function backupStatusFacts(
  status: ManageBackupStatus,
  lastGood: LastGoodBackup,
  formatTime: (value: string) => string,
): BackupStatusFacts {
  const { policy, runner, active_run: active, queued_count: queued } = status;
  const schedule =
    policy.schedule === "disabled"
      ? `Off · ${kept(policy.retention_days)}`
      : `On · ${backupScheduleLabels[policy.schedule]} · ${kept(policy.retention_days)}`;
  const queue = [
    queued > 0 ? `${queued} queued` : null,
    active ? `1 ${backupStateLabels[active.state].toLowerCase()}` : null,
  ].filter(Boolean);
  return {
    schedule,
    lastGood:
      lastGood === "loading"
        ? "Loading…"
        : lastGood === "unavailable"
          ? "Not available"
          : lastGood === null
            ? "None yet"
            : lastGoodWords(lastGood, formatTime),
    service: {
      state: serviceWords[runner.state],
      detail: runner.last_seen_at
        ? `Checked in ${formatTime(runner.last_seen_at)}`
        : "Never checked in",
    },
    queue: queue.length ? queue.join(" · ") : "Nothing queued or running",
    warning: serviceWarnings[runner.state],
  };
}

/** When the last good backup finished, its verification, and its expiry. */
function lastGoodWords(
  run: ManageBackupRun,
  formatTime: (value: string) => string,
): string {
  return [
    formatTime(run.finished_at ?? run.requested_at),
    run.verified_at ? "Verified" : "Not verified yet",
    run.expired_at ? "Expired" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Why a backup cannot be prepared as an encrypted copy, or null when it can
 * (the same rule as `backupExportSourceAvailable`).
 */
export function backupExportReason(run: ManageBackupRun): string | null {
  if (run.installation === "previous")
    return "Backups from a previous installation cannot be exported.";
  if (run.expired_at) return "This backup has expired.";
  if (run.state === "queued") return "This backup has not run yet.";
  if (run.state === "running") return "This backup is still running.";
  if (!run.snapshot_id || !run.verified_at)
    return run.state === "succeeded"
      ? "This backup is not verified yet."
      : "This backup did not finish, so there is nothing to export.";
  if (!run.reconciled_at)
    return "This backup needs recovery on the server first.";
  return null;
}

/**
 * The detail's Server restart row. `reconciled_at` is set when the backup
 * runner closes the run out after it restarts the server
 * (`backup_runner.py`); a run that started and ended without it needs
 * recovery on the server. A run that has not ended has nothing to say yet.
 */
export function backupRestartWords(
  run: Pick<ManageBackupRun, "state" | "started_at" | "reconciled_at">,
  formatTime: (value: string) => string,
): string {
  if (run.reconciled_at) return `Recorded · ${formatTime(run.reconciled_at)}`;
  if (
    run.started_at === null ||
    run.state === "queued" ||
    run.state === "running"
  )
    return "—";
  return "Needs recovery on the server";
}

/** A row's status as a word and a dot tone. Verified is a completed run with a check. */
export function backupRunStatus(
  run: Pick<ManageBackupRun, "state" | "verified_at" | "expired_at">,
): { word: string; tone: BackupTone } {
  switch (run.state) {
    case "queued":
      return { word: "Queued", tone: "muted" };
    case "running":
      return { word: "Running", tone: "action" };
    case "failed":
      return { word: "Failed", tone: "danger" };
    case "interrupted":
      return { word: "Interrupted", tone: "warn" };
    case "succeeded":
      if (run.expired_at) return { word: "Expired", tone: "muted" };
      return run.verified_at
        ? { word: "Verified", tone: "flow" }
        : { word: "Completed", tone: "flow" };
  }
}

/** The schedule and retention a run was requested under ("Schedule then"). */
export function backupScheduleAtRequest(
  run: Pick<ManageBackupRun, "schedule" | "retention_days">,
): string {
  return run.schedule === "disabled"
    ? `Off · ${kept(run.retention_days)}`
    : `${backupScheduleLabels[run.schedule]} · ${kept(run.retention_days)}`;
}

const SNAPSHOT_EDGE = 8;

/** The first and last eight characters of a long id; the full id goes in a title. */
export function shortSnapshotId(id: string): string {
  return id.length > SNAPSHOT_EDGE * 2 + 1
    ? `${id.slice(0, SNAPSHOT_EDGE)}…${id.slice(-SNAPSHOT_EDGE)}`
    : id;
}
