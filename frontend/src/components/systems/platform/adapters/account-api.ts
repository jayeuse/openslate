import { z } from "zod";

import { apiFetch } from "@/lib/api";

const timestampSchema = z.iso.datetime({ offset: true });
const sessionSchema = z.object({
  id: z.string().uuid(),
  created_at: timestampSchema,
  refreshed_at: timestampSchema,
  expires_at: timestampSchema,
  user_agent: z.string().nullable(),
  current: z.boolean(),
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
