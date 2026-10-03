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
const accessLevel = z.enum(["read", "write", "manage"]);
const authMeResponse = z.object({
  id: z.string().uuid(),
  role: z.enum(["admin", "member", "guest"]),
  access: z.array(
    z.object({
      department_id: z.string().uuid(),
      module_id: z.string().uuid().nullable(),
      level: accessLevel,
    }),
  ),
});

export type SessionStatus = z.output<typeof sessionResponse>;
export const sessionRecheckEvent = "openslate:session-recheck";
export function requestSessionRecheck() {
  window.dispatchEvent(new Event(sessionRecheckEvent));
}
export type AccessLevel = z.output<typeof accessLevel>;
/** A module entry wins over its department entry. An admin has no entries. */
export type AccessEntry = {
  departmentId: string;
  moduleId: string | null;
  level: AccessLevel;
};
export type AuthMe = {
  id: string;
  role: "admin" | "member" | "guest";
  access: AccessEntry[];
};

export async function getAuthMe(signal?: AbortSignal): Promise<AuthMe> {
  const current = await apiFetch("/auth/me", authMeResponse, {
    cache: "no-store",
    signal,
    refreshOnUnauthorized: false,
  });
  return {
    id: current.id,
    role: current.role,
    access: current.access.map((entry) => ({
      departmentId: entry.department_id,
      moduleId: entry.module_id,
      level: entry.level,
    })),
  };
}

export async function signIn(email: string, password: string) {
  return apiFetch("/auth/login", authenticatedResponse, {
    method: "POST",
    body: JSON.stringify({ email, password }),
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

export async function completeInvitation(tokenHash: string, password: string) {
  return apiFetch("/auth/invitations/complete", noContentResponse, {
    method: "POST",
    body: JSON.stringify({ token_hash: tokenHash, password }),
    refreshOnUnauthorized: false,
  });
}

export async function requestRecovery(email: string) {
  return apiFetch("/auth/recovery/request", noContentResponse, {
    method: "POST",
    body: JSON.stringify({ email }),
    refreshOnUnauthorized: false,
  });
}

export async function completeRecovery(tokenHash: string, password: string) {
  return apiFetch("/auth/recovery/complete", noContentResponse, {
    method: "POST",
    body: JSON.stringify({ token_hash: tokenHash, password }),
    refreshOnUnauthorized: false,
  });
}
