"use client";

import {
  queryOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { getMfaStatus } from "@/lib/mfa-api";
import { ApiError } from "@/lib/api";
import {
  getAccessSecurityPolicy,
  getPersonSecurity,
  listAccessSessions,
  type AccessSecurityPolicy,
  type AccessSessionsRequest,
} from "./security-api";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import {
  getAccessInvitationSettings,
  getAccessUserAccess,
  listAccessDepartments,
  listAccessGroups,
  listAccessMemberCandidates,
  listAccessModules,
  listAccessUserSessions,
  listAccessUsers,
  type AccessDeletedFilter,
  type AccessInvitationSettings,
} from "../state/api";
import { loadAllAccessPages } from "../state/pagination";

// Section-level Access reads share the per-account client cache. Every key
// starts with "access", so one prefix marks the area stale. Access lists are
// complete collections: the directory, the group editor pickers and the
// overview health counts all need every row, not a first page. A person's
// effective access and sessions are cached under the users key, so a change
// to that person (a disable revokes sessions) marks them stale. Single-row
// detail reads stay in their components.
//
// The signed-in identity (`authMeOptions`, key ["auth", "me"]) is shared with
// OpenView and the navigation; Access does not define a second identity key.

export const accessKeys = {
  all: ["access"] as const,
  security: () => ["access", "security"] as const,
  adminSessions: () => ["access", "admin-sessions"] as const,
  adminSessionList: (request: AccessSessionsRequest) =>
    ["access", "admin-sessions", request] as const,
  users: ["access", "users"] as const,
  userList: (deleted: AccessDeletedFilter) =>
    ["access", "users", "list", deleted] as const,
  userAccessAll: ["access", "users", "access"] as const,
  userAccess: (userId: string) =>
    ["access", "users", "access", userId] as const,
  personSecurity: (userId: string) =>
    ["access", "users", "security", userId] as const,
  userSessions: (userId: string) =>
    ["access", "users", "sessions", userId] as const,
  groups: ["access", "groups"] as const,
  groupList: (deleted: AccessDeletedFilter) =>
    ["access", "groups", "list", deleted] as const,
  memberCandidates: () => ["access", "member-candidates"] as const,
  catalog: ["access", "catalog"] as const,
  departments: (deleted: AccessDeletedFilter) =>
    ["access", "catalog", "departments", deleted] as const,
  modules: (deleted: AccessDeletedFilter) =>
    ["access", "catalog", "modules", deleted] as const,
  invitationSettings: () => ["access", "invitation-settings"] as const,
};

/** Every person, administrators included. Administrator only. */
export const userListOptions = (deleted: AccessDeletedFilter) =>
  queryOptions({
    queryKey: accessKeys.userList(deleted),
    queryFn: ({ signal }) =>
      loadAllAccessPages(
        (page) => listAccessUsers({ ...page, deleted, sort_by: "username" }),
        { signal },
      ),
  });

/** One person's effective access and the groups that give it. */
export const userAccessOptions = (userId: string) =>
  queryOptions({
    queryKey: accessKeys.userAccess(userId),
    queryFn: ({ signal }) => getAccessUserAccess(userId, { signal }),
  });

/** One person's sign-in sessions. */
export const userSessionsOptions = (userId: string) =>
  queryOptions({
    queryKey: accessKeys.userSessions(userId),
    queryFn: ({ signal }) =>
      loadAllAccessPages((page) => listAccessUserSessions(userId, page), {
        signal,
      }),
  });

/** Every group the caller may change: all for administrators (D14). */
export const groupListOptions = (deleted: AccessDeletedFilter) =>
  queryOptions({
    queryKey: accessKeys.groupList(deleted),
    queryFn: ({ signal }) =>
      loadAllAccessPages(
        (page) => listAccessGroups({ ...page, deleted, sort_by: "name" }),
        { signal },
      ),
  });

/** People a manager may add to a group (D14). */
export const memberCandidateListOptions = () =>
  queryOptions({
    queryKey: accessKeys.memberCandidates(),
    queryFn: ({ signal }) =>
      loadAllAccessPages((page) => listAccessMemberCandidates(page), {
        signal,
      }),
  });

export const departmentListOptions = (deleted: AccessDeletedFilter) =>
  queryOptions({
    queryKey: accessKeys.departments(deleted),
    queryFn: ({ signal }) =>
      loadAllAccessPages(
        (page) =>
          listAccessDepartments({
            ...page,
            deleted,
            sort_by: "department_name",
          }),
        { signal },
      ),
  });

export const moduleListOptions = (deleted: AccessDeletedFilter) =>
  queryOptions({
    queryKey: accessKeys.modules(deleted),
    queryFn: ({ signal }) =>
      loadAllAccessPages(
        (page) =>
          listAccessModules({ ...page, deleted, sort_by: "module_name" }),
        { signal },
      ),
  });

export const invitationSettingsOptions = () =>
  queryOptions({
    queryKey: accessKeys.invitationSettings(),
    queryFn: ({ signal }) => getAccessInvitationSettings({ signal }),
  });

export { authMeOptions };

// Cache follow-up after a confirmed command. Nothing here is optimistic:
// each helper runs after the server accepted the change.

/**
 * A person was invited, changed, deleted, restored or had an invitation
 * resent or revoked. An invitation can add the person to groups, and a
 * change to the signed-in person can change their own role.
 */
export function afterAccessUserChange(client: QueryClient): Promise<void> {
  return invalidateAll(client, [
    accessKeys.users,
    accessKeys.groups,
    accessKeys.memberCandidates(),
    authMeOptions().queryKey,
  ]);
}

/**
 * A group was created, renamed, deleted, or had its access or members
 * replaced. Every person's effective access may change, and the signed-in
 * person may be a member, so their access (and with it the navigation) is
 * read again.
 */
export function afterAccessGroupChange(client: QueryClient): Promise<void> {
  return invalidateAll(client, [
    accessKeys.groups,
    accessKeys.userAccessAll,
    authMeOptions().queryKey,
  ]);
}

/** Store the accepted invitation settings; the response is the new state. */
export function afterInvitationSettingsChange(
  client: QueryClient,
  settings: AccessInvitationSettings,
): void {
  client.setQueryData(accessKeys.invitationSettings(), settings);
}

async function invalidateAll(
  client: QueryClient,
  queryKeys: readonly QueryKey[],
): Promise<void> {
  await Promise.all(
    queryKeys.map((queryKey) => client.invalidateQueries({ queryKey })),
  );
}

// Privileged-read refusal belongs to the verified account's existing client.
// Ordinary successes cannot clear it; only the owner's explicit fresh Retry can.
type SecurityRead = "policy" | "sessions";
type ReadAdmission = { sequence: number; accepted: number; denied: boolean };
const securityReads = new WeakMap<
  QueryClient,
  Record<SecurityRead, ReadAdmission>
>();
function securityRead(client: QueryClient, kind: SecurityRead) {
  let reads = securityReads.get(client);
  if (!reads) {
    reads = {
      policy: { sequence: 0, accepted: 0, denied: false },
      sessions: { sequence: 0, accepted: 0, denied: false },
    };
    securityReads.set(client, reads);
  }
  return reads[kind];
}
export function isAccessSecurityDenied(
  client: QueryClient,
  kind: SecurityRead,
) {
  return securityRead(client, kind).denied;
}
export function setAccessSecurityDenied(
  client: QueryClient,
  kind: SecurityRead,
  denied: boolean,
) {
  securityRead(client, kind).denied = denied;
}
async function readSecurity<T>(
  client: QueryClient,
  kind: SecurityRead,
  signal: AbortSignal,
  read: () => Promise<T>,
): Promise<T> {
  const admission = securityRead(client, kind);
  const sequence = ++admission.sequence;
  try {
    const result = await read();
    if (!signal.aborted)
      admission.accepted = Math.max(admission.accepted, sequence);
    return result;
  } catch (error) {
    if (
      !signal.aborted &&
      sequence >= admission.accepted &&
      error instanceof ApiError &&
      error.status === 403
    ) {
      securityRead(client, "policy").denied = true;
      securityRead(client, "sessions").denied = true;
    }
    throw error;
  }
}
export const accessSecurityOptions = (client: QueryClient) =>
  queryOptions({
    queryKey: accessKeys.security(),
    queryFn: ({ signal }) =>
      readSecurity(client, "policy", signal, () =>
        getAccessSecurityPolicy(signal),
      ),
  });
export const accessAdminSessionsOptions = (
  client: QueryClient,
  request: AccessSessionsRequest,
) =>
  queryOptions({
    queryKey: accessKeys.adminSessionList(request),
    queryFn: ({ signal }) =>
      readSecurity(client, "sessions", signal, () =>
        listAccessSessions(request, signal),
      ),
  });
export function afterAccessSecurityChange(
  client: QueryClient,
  policy: AccessSecurityPolicy,
) {
  client.setQueryData(accessKeys.security(), policy);
}
export function afterAccessAdminSessionsChange(client: QueryClient) {
  return client.invalidateQueries({ queryKey: accessKeys.adminSessions() });
}

export const personSecurityOptions = (userId: string, actorId: string) =>
  queryOptions({
    queryKey: accessKeys.personSecurity(userId),
    queryFn: async ({ signal }) => {
      const [status, actor] = await Promise.all([
        getPersonSecurity(userId, signal),
        getMfaStatus(signal),
      ]);
      if (actor.user_id !== actorId)
        throw new Error("Security identity changed.");
      return { status, assurance: actor.assurance_level };
    },
  });
export function afterPersonSecurityChange(client: QueryClient, userId: string) {
  return Promise.all([
    client.fetchQuery({ ...userSessionsOptions(userId), staleTime: 0 }),
    client.invalidateQueries({ queryKey: accessKeys.adminSessions() }),
    client.invalidateQueries({
      queryKey: accessKeys.personSecurity(userId),
      refetchType: "none",
    }),
  ]);
}
