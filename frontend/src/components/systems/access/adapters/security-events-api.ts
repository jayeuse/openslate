import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { pageSchema } from "../state/api-contracts";

const instant = z.iso.datetime({ offset: true });
export const securityEventOutcomeSchema = z.enum([
  "attempt",
  "success",
  "denied",
  "failure",
  "partial",
]);
const eventSchema = z.strictObject({
  id: z.uuid(),
  occurred_at: instant,
  event_type: z.string().min(1).max(100),
  outcome: securityEventOutcomeSchema,
  source: z.string().min(1).max(100),
  operation_id: z.uuid(),
  actor_id: z.uuid().nullable(),
  subject_id: z.uuid().nullable(),
  labels: z.record(z.string(), z.string()),
  fingerprint: z.string().max(128).nullable(),
  reason: z.string().max(500).nullable(),
  request_id: z.uuid().nullable(),
  request_method: z.string().max(10).nullable(),
  request_path: z.string().max(2048).nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
const eventPageSchema = pageSchema(eventSchema);

export type AccessSecurityEvent = z.output<typeof eventSchema>;
export type AccessSecurityEventsPage = z.output<typeof eventPageSchema>;
export type AccessSecurityEventOutcome = z.output<
  typeof securityEventOutcomeSchema
>;
export type AccessSecurityEventsRequest = {
  limit: number;
  offset: number;
  search: string;
  sort_by: "occurred_at" | "event_type" | "outcome" | "source";
  sort_order: "asc" | "desc";
  event_type: string;
  outcome: AccessSecurityEventOutcome | "";
  person_id: string;
  occurred_after: string;
  occurred_before: string;
  operation_id: string;
};
export const defaultSecurityEventsRequest: AccessSecurityEventsRequest = {
  limit: 10,
  offset: 0,
  search: "",
  sort_by: "occurred_at",
  sort_order: "desc",
  event_type: "",
  outcome: "",
  person_id: "",
  occurred_after: "",
  occurred_before: "",
  operation_id: "",
};

/** Existing exact-admin list: all filters are applied by the server before paging. */
export function listAccessSecurityEvents(
  request: AccessSecurityEventsRequest,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request)) {
    if (value !== "" || key === "search") params.set(key, String(value));
  }
  return apiFetch(`/security-events?${params}`, eventPageSchema, {
    signal,
    cache: "no-store",
    refreshOnUnauthorized: false,
  });
}

/** Row detail stays local to its dialog and must match the requested identity. */
export function getAccessSecurityEvent(eventId: string, signal?: AbortSignal) {
  return apiFetch(
    `/security-events/${eventId}`,
    eventSchema.refine((event) => event.id === eventId),
    { signal, cache: "no-store", refreshOnUnauthorized: false },
  );
}
