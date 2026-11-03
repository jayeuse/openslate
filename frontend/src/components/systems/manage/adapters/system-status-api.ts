import { z } from "zod";

import { apiFetch } from "@/lib/api";

import type { OrganizationStatus, PartStatus } from "../domain/health-rules";

const KNOWN_STATUSES: readonly string[] = [
  "working",
  "not_working",
  "not_set_up",
  "set_up",
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
  })
  .strict() satisfies z.ZodType<OrganizationStatus>;

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
