"use client";

import {
  queryOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
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
  users: ["access", "users"] as const,
  userList: (deleted: AccessDeletedFilter) =>
    ["access", "users", "list", deleted] as const,
  userAccessAll: ["access", "users", "access"] as const,
  userAccess: (userId: string) =>
    ["access", "users", "access", userId] as const,
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
