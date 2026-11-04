import { z } from "zod";

import { apiFetch } from "@/lib/api";

// Types only: the shell reaches this module through `manage-queries`, so a
// value import of the page's rules would put them in every cold route.
import type {
  InstallationStatus,
  OrganizationStatus,
  PartStatus,
} from "../domain/health-rules";

// S5: `slow` for any part (Email is never slow by the contract, but a per-key
// word list would refuse the whole response) and Email `working` from real
// sends (API contract S5).
const KNOWN_STATUSES: readonly string[] = [
  "working",
  "not_working",
  "not_set_up",
  "set_up",
  "slow",
] satisfies PartStatus[];

function knownStatus(value: string): PartStatus {
  return KNOWN_STATUSES.includes(value) ? (value as PartStatus) : "unknown";
}

const instant = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();

// The admin-only organization part (API contract S3): backup freshness with
// no sizes, paths, run lists or failure codes, and three 7-day counts.
const organizationStatusSchema = z
  .object({
    since: instant,
    backups: z
      .object({
        state: z.enum([
          "on_time",
          "late",
          "no_schedule",
          "never_backed_up",
          "unknown",
        ]),
        last_success_at: instant.nullable(),
        last_result: z.enum(["verified", "failed", "interrupted"]).nullable(),
      })
      .strict(),
    failed_jobs: count.nullable(),
    failed_sign_ins: count,
    lockouts: count,
    // S5-C7: bytes of the organization's files; null when the server cannot
    // read them.
    storage_used_bytes: count.nullable(),
  })
  .strict() satisfies z.ZodType<OrganizationStatus>;

// The installation owner's block 4 (S5-C6): the database size from the newest
// sample, and each worker's state as the server judges it.
const installationStatusSchema = z
  .object({
    database_bytes: count.nullable(),
    database_measured_at: instant.nullable(),
    workers: z.array(
      z
        .object({
          key: z.enum([
            "record_triggers",
            "report_scheduling",
            "comms_jobs",
            "provider_signout",
            "backup_runner",
          ]),
          state: z.enum(["running", "not_seen", "never_seen"]),
          last_seen_at: instant.nullable(),
        })
        .strict(),
    ),
  })
  .strict() satisfies z.ZodType<InstallationStatus>;

// GET /api/system/status (docs/specs/system-health.md, API contract S2): the
// four parts in R1 order with their status words, the version and the time of
// the readiness check the server used. A word this page does not know is kept
// as `unknown`, so the row shows "—" instead of the page failing (D2.3).
const systemStatusSchema = z
  .object({
    parts: z.array(
      z
        .object({
          key: z.enum(["data", "signing_in", "files", "email"]),
          status: z.string().transform(knownStatus),
        })
        .strict(),
    ),
    version: z.string().min(1),
    checked_at: instant,
    // Always present: null for everyone but an admin of the bound
    // organization (S3-C1).
    organization: organizationStatusSchema.nullable(),
    // Always present: null for everyone but the installation owner (S5-C6).
    installation: installationStatusSchema.nullable(),
  })
  .strict();

export type SystemStatus = z.output<typeof systemStatusSchema>;

/**
 * `person` is a press on "Check again", the person's activity: a refused
 * session refreshes as for any action. `background` is the 60-second and focus
 * refresh, which is not activity, so it never renews or extends an idle
 * session (as the workspace event stream does).
 */
export function getSystemStatus(
  origin: "person" | "background",
  signal?: AbortSignal,
): Promise<SystemStatus> {
  return apiFetch("/system/status", systemStatusSchema, {
    cache: "no-store",
    signal,
    refreshOnUnauthorized: origin === "person",
  });
}
