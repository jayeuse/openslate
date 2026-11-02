import { z } from "zod";

import { apiFetch } from "@/lib/api";

import type { PartStatus } from "../domain/health-rules";

const KNOWN_STATUSES: readonly string[] = [
  "working",
  "not_working",
  "not_set_up",
  "set_up",
] satisfies PartStatus[];

function knownStatus(value: string): PartStatus {
  return KNOWN_STATUSES.includes(value) ? (value as PartStatus) : "unknown";
}

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
    checked_at: z.iso.datetime({ offset: true }),
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
