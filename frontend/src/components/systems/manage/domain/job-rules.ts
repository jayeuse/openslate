import type { ManageJob } from "../adapters/jobs-api";

// The words of Manage Jobs (MD9). The list API (`GET /jobs`) returns one page
// and its total, with no counts per state, and has one command: retry, when a
// row says `can_retry`. It has no cancel.

/** What a missing value reads. */
export const JOB_EMPTY = "—";

export type JobTone = "flow" | "action" | "danger" | "warn" | "muted";

/**
 * The states the server can return: the scheduled-work states, then the two
 * that only backups have. The quick filters list them in this order.
 */
export const JOB_STATES = [
  { value: "pending", word: "Pending", tone: "muted" },
  { value: "running", word: "Running", tone: "action" },
  { value: "failed", word: "Failed", tone: "danger" },
  { value: "succeeded", word: "Succeeded", tone: "flow" },
  { value: "queued", word: "Queued", tone: "muted" },
  { value: "canceled", word: "Canceled", tone: "muted" },
  { value: "interrupted", word: "Interrupted", tone: "warn" },
] as const satisfies readonly { value: string; word: string; tone: JobTone }[];

/** The kinds the server registers, in its own words. */
export const JOB_KINDS = [
  { value: "report-run", label: "Report run" },
  { value: "post-publish", label: "Post publication" },
  { value: "event-reminder", label: "Event reminder" },
  { value: "backup", label: "Backup" },
  { value: "comms-scheduled-message", label: "Scheduled Comms message" },
  { value: "comms-export", label: "Comms export" },
  { value: "comms-link-preview", label: "Link preview" },
] as const;

/** A value the server sends that this page has no word for, made readable. */
function readable(value: string): string {
  return value
    ? value.charAt(0).toUpperCase() + value.slice(1).replaceAll(/[-_]/g, " ")
    : "Unknown";
}

/** A state as a word and a dot tone; a state added later reads as its name. */
export function jobStatus(state: string): { word: string; tone: JobTone } {
  const known = JOB_STATES.find((entry) => entry.value === state);
  return known
    ? { word: known.word, tone: known.tone }
    : { word: readable(state), tone: "muted" };
}

export function jobKindLabel(kind: string): string {
  return (
    JOB_KINDS.find((entry) => entry.value === kind)?.label ?? readable(kind)
  );
}

export function jobSubject(job: Pick<ManageJob, "subjectLabel">): string {
  return job.subjectLabel.trim() || "Unnamed job";
}

/**
 * The one time a row shows: when a waiting job runs next, or when any other
 * job last started. A job that has not reached that point has no time.
 */
export function jobTime(
  job: Pick<ManageJob, "state" | "nextAttemptAt" | "lastAttemptAt">,
): { label: "Next run" | "Last attempt"; at: string | null } {
  return job.state === "pending" || job.state === "queued"
    ? { label: "Next run", at: job.nextAttemptAt }
    : { label: "Last attempt", at: job.lastAttemptAt };
}

/**
 * The time a row does not show, when it adds a fact: when a waiting job that
 * already tried last started, or when a running job tries again.
 */
export function jobOtherTime(
  job: Pick<
    ManageJob,
    "state" | "attempts" | "nextAttemptAt" | "lastAttemptAt"
  >,
): { label: "Next run" | "Last attempt"; at: string } | null {
  if ((job.state === "pending" || job.state === "queued") && job.attempts > 0)
    return job.lastAttemptAt
      ? { label: "Last attempt", at: job.lastAttemptAt }
      : null;
  if (job.state === "running" && job.nextAttemptAt)
    return { label: "Next run", at: job.nextAttemptAt };
  return null;
}

/** Attempts show only once a job has tried; a job that never ran shows none. */
export function jobAttempts(attempts: number): string | null {
  if (attempts <= 0) return null;
  return attempts === 1 ? "1 attempt" : `${attempts} attempts`;
}

/** The recorded problem, or null when there is none. */
export function jobProblem(
  job: Pick<ManageJob, "failureLabel">,
): string | null {
  return job.failureLabel?.trim() || null;
}

export type JobAction = "retry";

/** The commands a row offers: only the ones the server says it allows. */
export function jobActions(job: Pick<ManageJob, "canRetry">): JobAction[] {
  return job.canRetry ? ["retry"] : [];
}
