import { z } from "zod";

import { ApiError, apiFetch, refreshBrowserSession } from "@/lib/api";

const authenticatedResponse = z.object({
  authenticated: z.literal(true),
  setup_required: z.boolean(),
});
const noContentResponse = z.null();
const sessionResponse = z.discriminatedUnion("authenticated", [
  z.object({
    authenticated: z.literal(true),
    user_id: z.string().uuid(),
    setup_required: z.boolean(),
  }),
  z.object({ authenticated: z.literal(false) }),
]);

export type SessionStatus = z.output<typeof sessionResponse>;

export async function signIn(identifier: string, password: string) {
  return apiFetch("/auth/login", authenticatedResponse, {
    method: "POST",
    body: JSON.stringify({ identifier, password }),
    refreshOnUnauthorized: false,
  });
}

export async function signOut() {
  return apiFetch("/auth/logout", noContentResponse, {
    method: "POST",
    refreshOnUnauthorized: false,
  });
}

export async function getSessionStatus(
  signal?: AbortSignal,
): Promise<SessionStatus> {
  const current = await apiFetch("/auth/session", sessionResponse, {
    cache: "no-store",
    signal,
    refreshOnUnauthorized: false,
  });
  if (current.authenticated) return current;
  const refreshed = await refreshBrowserSession();
  if (refreshed === "rejected") return current;
  if (refreshed === "unavailable")
    throw new ApiError(503, "Authentication is temporarily unavailable");
  return apiFetch("/auth/session", sessionResponse, {
    cache: "no-store",
    signal,
    refreshOnUnauthorized: false,
  });
}

export async function changePassword(
  currentPassword: string,
  password: string,
) {
  return apiFetch("/auth/password/change", authenticatedResponse, {
    method: "POST",
    body: JSON.stringify({ current_password: currentPassword, password }),
  });
}

export async function completeInvitation(token: string, password: string) {
  return apiFetch("/auth/invitations/complete", noContentResponse, {
    method: "POST",
    body: JSON.stringify({ token, password }),
    refreshOnUnauthorized: false,
  });
}

export async function requestRecovery(identifier: string) {
  return apiFetch("/auth/recovery/request", noContentResponse, {
    method: "POST",
    body: JSON.stringify({ identifier }),
    refreshOnUnauthorized: false,
  });
}

export async function completeRecovery(token: string, password: string) {
  return apiFetch("/auth/recovery/complete", noContentResponse, {
    method: "POST",
    body: JSON.stringify({ token, password }),
    refreshOnUnauthorized: false,
  });
}
