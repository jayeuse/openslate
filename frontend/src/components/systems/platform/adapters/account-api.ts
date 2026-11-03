import { z } from "zod";

import { apiFetch } from "@/lib/api";
import { pageSchema } from "@/components/systems/access/state/api-contracts";

const timestampSchema = z.iso.datetime({ offset: true });
const sessionSchema = z.object({
  id: z.string().uuid(),
  created_at: timestampSchema,
  refreshed_at: timestampSchema,
  expires_at: timestampSchema,
  user_agent: z.string().nullable(),
  current: z.boolean(),
  ip_address: z.string().nullable(),
});
const sessionsResponse = z.array(sessionSchema);
const noContentResponse = z.null();
const passwordChangeResponse = z.object({
  authenticated: z.literal(true),
  setup_required: z.boolean(),
});

export type AccountSession = z.output<typeof sessionSchema>;

export function listAccountSessions(signal?: AbortSignal) {
  return apiFetch("/auth/sessions", sessionsResponse, {
    cache: "no-store",
    signal,
  });
}

export function changeAccountPassword(
  currentPassword: string,
  newPassword: string,
) {
  return apiFetch("/auth/password/change", passwordChangeResponse, {
    method: "POST",
    body: JSON.stringify({
      current_password: currentPassword,
      password: newPassword,
    }),
  });
}

export function endAccountSession(sessionId: string) {
  return apiFetch(
    `/auth/sessions/${encodeURIComponent(sessionId)}`,
    noContentResponse,
    { method: "DELETE" },
  );
}

export function endOtherAccountSessions() {
  return apiFetch("/auth/sessions/revoke-others", noContentResponse, {
    method: "POST",
  });
}

// GET /api/auth/sign-in-events (docs/specs/system-health.md, API contract
// S4): the caller's own sign-ins, failed attempts, lockouts and ended
// sessions, newest first. Keys are unique as `kind:id`, not by id alone.
const signInEventSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["signed_in", "session_ended", "sign_in_failed", "locked_out"]),
  occurred_at: timestampSchema,
  user_agent: z.string().nullable(),
  ip_address: z.string().nullable(),
});
const signInEventPageSchema = pageSchema(signInEventSchema);

export type SignInEvent = z.output<typeof signInEventSchema>;
export type SignInEventPage = z.output<typeof signInEventPageSchema>;
/** Settings shows the history ten events at a time (D9.3). */
export const SIGN_IN_EVENT_PAGE_SIZE = 10;

export function listOwnSignInEvents(offset: number, signal?: AbortSignal) {
  const query = new URLSearchParams({
    limit: String(SIGN_IN_EVENT_PAGE_SIZE),
    offset: String(offset),
  });
  return apiFetch(`/auth/sign-in-events?${query}`, signInEventPageSchema, {
    cache: "no-store",
    signal,
  });
}
