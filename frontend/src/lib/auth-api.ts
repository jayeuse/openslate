import { z } from "zod";

import { ApiError, apiFetch, refreshBrowserSession } from "@/lib/api";
import { announceIdentityChange } from "@/lib/session-broadcast";
import {
  currentOrganizationId,
  setCurrentOrganizationId,
} from "@/lib/organization-context";

const authenticatedResponse = z.object({
  authenticated: z.literal(true),
  setup_required: z.boolean(),
});
const noContentResponse = z.null();
const emailRequestResponse = z
  .object({ confirmation_required: z.literal(true) })
  .strict();
const emailConfirmationResponse = z.discriminatedUnion("authenticated", [
  z
    .object({
      authenticated: z.literal(false),
      confirmation_required: z.literal(true),
    })
    .strict(),
  z
    .object({
      authenticated: z.literal(true),
      confirmation_required: z.literal(false),
      setup_required: z.boolean(),
    })
    .strict(),
]);
export const defaultOrganizationBlockedSchema = z
  .enum(["mfa_required", "ip_not_allowed", "organization_required"])
  .nullable();
const sessionResponse = z.discriminatedUnion("authenticated", [
  z.object({
    authenticated: z.literal(true),
    user_id: z.string().uuid(),
    setup_required: z.boolean(),
    default_organization_blocked: defaultOrganizationBlockedSchema,
    // The organization a tab without its own choice opens; null when the
    // person must choose. Older servers omit it: the tab follows the session.
    organization_id: z.string().uuid().nullable().optional(),
  }),
  z.object({ authenticated: z.literal(false) }),
]);
const accessLevel = z.enum(["read", "write", "manage"]);
const accountRole = z.enum(["admin", "member", "guest"]);
const accessEntries = z.array(
  z.object({
    department_id: z.string().uuid(),
    module_id: z.string().uuid().nullable(),
    level: accessLevel,
  }),
);
const membershipResponse = z.object({
  org_id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string(),
  role: accountRole,
});
const authMeResponse = z.object({
  id: z.string().uuid(),
  username: z.string(),
  display_name: z.string().nullable(),
  avatar_file_id: z.string().uuid().nullable(),
  role: accountRole.nullable(),
  default_organization_blocked: defaultOrganizationBlockedSchema,
  access: accessEntries,
  memberships: z.array(membershipResponse),
  pending_invitations: z.array(
    membershipResponse.extend({
      id: z.string().uuid(),
      expires_at: z.string(),
    }),
  ),
  current_organization: membershipResponse
    .extend({ access: accessEntries, owner: z.boolean().default(false) })
    .nullable(),
  operator: z.boolean().default(false),
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
export type AccountRole = z.output<typeof accountRole>;
/** The membership role as people read it ("Administrator", "Member", "Guest"). */
export const membershipRoleLabels: Record<AccountRole, string> = {
  admin: "Administrator",
  member: "Member",
  guest: "Guest",
};
/** One organization the account belongs to, as `/auth/me` lists it. */
export type OrganizationMembership = {
  orgId: string;
  name: string;
  slug: string;
  role: AccountRole;
};
export type PendingInvitation = OrganizationMembership & {
  id: string;
  expiresAt: string;
};
export type AuthMe = {
  id: string;
  username: string;
  displayName: string | null;
  avatarFileId: string | null;
  /** The role of the current organization's membership; null without one. */
  role: AccountRole | null;
  access: AccessEntry[];
  defaultOrganizationBlocked: z.output<typeof defaultOrganizationBlockedSchema>;
  memberships: OrganizationMembership[];
  pendingInvitations: PendingInvitation[];
  currentOrganization: OrganizationMembership | null;
  /** The account owns the current organization: it alone changes sensitive security. */
  organizationOwner: boolean;
  /** The account owns the installation: it changes installation-wide sign-in policy. */
  operator: boolean;
};

function membership(
  value: z.output<typeof membershipResponse>,
): OrganizationMembership {
  return {
    orgId: value.org_id,
    name: value.name,
    slug: value.slug,
    role: value.role,
  };
}

function authMe(current: z.output<typeof authMeResponse>): AuthMe {
  const organization = current.current_organization;
  return {
    id: current.id,
    username: current.username,
    displayName: current.display_name,
    avatarFileId: current.avatar_file_id,
    // Navigation and admission follow the current organization's membership.
    role: organization?.role ?? null,
    defaultOrganizationBlocked: current.default_organization_blocked,
    access: (organization?.access ?? []).map((entry) => ({
      departmentId: entry.department_id,
      moduleId: entry.module_id,
      level: entry.level,
    })),
    memberships: current.memberships.map(membership),
    pendingInvitations: current.pending_invitations.map((invitation) => ({
      ...membership(invitation),
      id: invitation.id,
      expiresAt: invitation.expires_at,
    })),
    currentOrganization: organization ? membership(organization) : null,
    organizationOwner: organization?.owner ?? false,
    operator: current.operator,
  };
}

export async function getAuthMe(signal?: AbortSignal): Promise<AuthMe> {
  return authMe(
    await apiFetch("/auth/me", authMeResponse, {
      cache: "no-store",
      signal,
      refreshOnUnauthorized: false,
    }),
  );
}

/**
 * Saves `orgId` as the session's active organization, the default for tabs
 * and streams that name none. A gated organization refuses with 403.
 */
export async function selectOrganization(
  orgId: string,
  signal?: AbortSignal,
): Promise<AuthMe> {
  return authMe(
    await apiFetch("/auth/session/organization", authMeResponse, {
      method: "POST",
      body: JSON.stringify({ org_id: orgId }),
      headers: { "X-Org": orgId },
      signal,
      refreshOnUnauthorized: false,
    }),
  );
}

/** Joins the signed-in account to the organization of a pending invitation. */
export async function acceptOrganizationInvitation(
  invitationId: string,
  signal?: AbortSignal,
) {
  return apiFetch(
    `/auth/invitations/${encodeURIComponent(invitationId)}/accept`,
    noContentResponse,
    { method: "POST", signal, refreshOnUnauthorized: false },
  );
}

export async function signIn(email: string, password: string) {
  const session = await apiFetch("/auth/login", authenticatedResponse, {
    method: "POST",
    body: JSON.stringify({ email, password }),
    refreshOnUnauthorized: false,
  });
  announceIdentityChange();
  return session;
}

export async function signOut() {
  const result = await apiFetch("/auth/logout", noContentResponse, {
    method: "POST",
    refreshOnUnauthorized: false,
  });
  announceIdentityChange();
  return result;
}

/** This landing-page probe never refreshes an occupied or expired browser context. */
export async function probeEmailConfirmationSession(
  signal?: AbortSignal,
): Promise<SessionStatus> {
  return apiFetch("/auth/session", sessionResponse, {
    cache: "no-store",
    signal,
    refreshOnUnauthorized: false,
  });
}

export async function requestEmailChange(
  email: string,
  currentPassword: string,
  signal?: AbortSignal,
) {
  return apiFetch("/auth/me/email", emailRequestResponse, {
    method: "POST",
    body: JSON.stringify({ email, current_password: currentPassword }),
    signal,
    refreshOnUnauthorized: false,
  });
}

export async function completeEmailChange(
  tokenHash: string,
  signal?: AbortSignal,
) {
  const confirmation = await apiFetch(
    "/auth/email/complete",
    emailConfirmationResponse,
    {
      method: "POST",
      body: JSON.stringify({ token_hash: tokenHash }),
      signal,
      refreshOnUnauthorized: false,
    },
  );
  // A confirmation that signs this browser in changes the signed-in account.
  if (confirmation.authenticated) announceIdentityChange();
  return confirmation;
}

function isStaleOrganization(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 ||
      (error.status === 403 && error.code === "organization_required"))
  );
}

/**
 * Reads the session in the tab's organization. A tab organization the
 * account can no longer enter (removed membership, deleted organization) is
 * forgotten, and the read repeats against the session's active organization.
 */
async function readSession(signal?: AbortSignal): Promise<SessionStatus> {
  const read = () =>
    apiFetch("/auth/session", sessionResponse, {
      cache: "no-store",
      signal,
      refreshOnUnauthorized: false,
    });
  try {
    return await read();
  } catch (error) {
    if (currentOrganizationId() === null || !isStaleOrganization(error))
      throw error;
    setCurrentOrganizationId(null);
    return read();
  }
}

export async function getSessionStatus(
  signal?: AbortSignal,
): Promise<SessionStatus> {
  const current = await readSession(signal);
  if (current.authenticated) return current;
  const refreshed = await refreshBrowserSession();
  if (refreshed === "rejected") return current;
  if (refreshed === "unavailable")
    throw new ApiError(503, "Authentication is temporarily unavailable");
  return readSession(signal);
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
