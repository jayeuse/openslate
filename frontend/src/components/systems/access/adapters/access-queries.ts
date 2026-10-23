"use client";

import {
  queryOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { getMfaStatus } from "@/lib/mfa-api";
import { INACTIVE_DAYS_DEFAULT } from "../state/api-contracts";
import { ApiError } from "@/lib/api";
import {
  defaultAccessSessionsRequest,
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
  getAccessUserSummary,
  listAccessGroups,
  listAccessUserSessions,
  listAccessUsers,
  type AccessDeletedFilter,
  type AccessInvitationSettings,
  type AccessGroupListOptions,
  type AccessDepartmentListOptions,
  type AccessSessionListOptions,
  type AccessUserListOptions,
} from "../state/api";
import {
  defaultSecurityEventsRequest,
  getAccessSecurityEvent,
  listAccessSecurityEvents,
  type AccessSecurityEventsRequest,
} from "./security-events-api";
import type { SignInCursor } from "../helpers/overview-dashboard";

// Section-level Access reads share the per-account client cache. Every key
// starts with "access", so one prefix marks the area stale. Access lists are
// bounded pages; pickers search the server and counts use filtered totals.
// A person's
// effective access and sessions are cached under the users key, so a change
// to that person (a disable revokes sessions) marks them stale. Single-row
// detail reads stay in their components.
//
// The signed-in identity (`authMeOptions`, key ["auth", "me"]) is shared with
// OpenView and the navigation; Access does not define a second identity key.

export const accessKeys = {
  security: () => ["access", "security"] as const,
  securityEvents: () => ["access", "security-events"] as const,
  securityEventList: (request: AccessSecurityEventsRequest) =>
    ["access", "security-events", request] as const,
  adminSessions: () => ["access", "admin-sessions"] as const,
  adminSessionList: (request: AccessSessionsRequest) =>
    ["access", "admin-sessions", request] as const,
  users: ["access", "users"] as const,
  userList: (
    deleted: AccessDeletedFilter,
    request: AccessUserListOptions = {},
  ) => ["access", "users", "list", deleted, request] as const,
  directory: () => ["access", "users", "directory"] as const,
  directoryPage: (request: AccessUserListOptions) =>
    ["access", "users", "directory", request] as const,
  userSummary: () => ["access", "users", "summary"] as const,
  userSummaryForDays: (inactiveDays: number) =>
    ["access", "users", "summary", inactiveDays] as const,
  userAccessAll: ["access", "users", "access"] as const,
  userAccess: (userId: string) =>
    ["access", "users", "access", userId] as const,
  personSecurity: (userId: string) =>
    ["access", "users", "security", userId] as const,
  /** The signed-in viewer's own two-step verification status. */
  ownMfa: () => ["access", "own-mfa"] as const,
  ownMfaFor: (userId: string) => ["access", "own-mfa", userId] as const,
  userSessions: (userId: string) =>
    ["access", "users", "sessions", userId] as const,
  userSessionPage: (userId: string, request: AccessSessionListOptions) =>
    ["access", "users", "sessions", userId, request] as const,
  groups: ["access", "groups"] as const,
  groupList: (
    deleted: AccessDeletedFilter,
    request: AccessGroupListOptions = {},
  ) => ["access", "groups", "list", deleted, request] as const,
  memberCandidates: () => ["access", "member-candidates"] as const,
  departments: (
    deleted: AccessDeletedFilter,
    request: AccessDepartmentListOptions = {},
  ) => ["access", "catalog", "departments", deleted, request] as const,
  invitationSettings: () => ["access", "invitation-settings"] as const,
};

/** One bounded directory page, administrators included. Administrator only. */
export const userListOptions = (
  deleted: AccessDeletedFilter,
  request: AccessUserListOptions = {},
) =>
  queryOptions({
    queryKey: accessKeys.userList(deleted, request),
    queryFn: ({ signal }) =>
      listAccessUsers({
        limit: 25,
        offset: 0,
        sort_by: "username",
        ...request,
        deleted,
        signal,
      }),
  });

/** The status quick filters' totals: one one-row read per status, shared
 * with the Overview counts that use the same request. */
export const statusCountOptions = (status: AccessUserListOptions["status"]) =>
  userListOptions("exclude", {
    ...(status ? { status } : {}),
    limit: 1,
    offset: 0,
  });

export const directoryPageOptions = (request: AccessUserListOptions) =>
  queryOptions({
    queryKey: accessKeys.directoryPage(request),
    queryFn: ({ signal }) => listAccessUsers({ ...request, signal }),
  });

export const userSummaryOptions = (inactiveDays = INACTIVE_DAYS_DEFAULT) =>
  queryOptions({
    queryKey: accessKeys.userSummaryForDays(inactiveDays),
    queryFn: ({ signal }) =>
      getAccessUserSummary({ signal, inactive_days: inactiveDays }),
  });

/** Observation writes do not emit a User ORM invalidation. Never refresh the
 * person-security query here: its accepted read calls this follow-up. */
export function afterAccessMfaObservation(client: QueryClient) {
  return invalidateAll(client, [
    accessKeys.directory(),
    accessKeys.userSummary(),
    accessKeys.ownMfa(),
  ]);
}

/**
 * The viewer's own two-step status for the Security page line. A status for
 * another account (a late answer after an account change) is refused.
 */
export const accessOwnMfaOptions = (userId: string) =>
  queryOptions({
    queryKey: accessKeys.ownMfaFor(userId),
    queryFn: async ({ signal }) => {
      const status = await getMfaStatus(signal);
      if (status.user_id !== userId)
        throw new Error("Security identity changed.");
      return status;
    },
  });

/** One person's effective access and the groups that give it. */
export const userAccessOptions = (userId: string) =>
  queryOptions({
    queryKey: accessKeys.userAccess(userId),
    queryFn: ({ signal }) => getAccessUserAccess(userId, { signal }),
  });

/** One page of a person's sign-in sessions. */
export const userSessionsOptions = (
  userId: string,
  request: AccessSessionListOptions = { limit: 10, offset: 0 },
) =>
  queryOptions({
    queryKey: accessKeys.userSessionPage(userId, request),
    queryFn: ({ signal }) =>
      listAccessUserSessions(userId, { ...request, signal }),
  });

/** One page of groups the caller may change. */
export const groupListOptions = (
  deleted: AccessDeletedFilter,
  request: AccessGroupListOptions = {},
) =>
  queryOptions({
    queryKey: accessKeys.groupList(deleted, request),
    queryFn: ({ signal }) =>
      listAccessGroups({
        limit: 25,
        offset: 0,
        sort_by: "name",
        ...request,
        deleted,
        signal,
      }),
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
    accessKeys.directory(),
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
type SecurityRead = "policy" | "sessions" | "events";
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
      events: { sequence: 0, accepted: 0, denied: false },
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
      (error.status === 401 || error.status === 403)
    ) {
      securityRead(client, "policy").denied = true;
      securityRead(client, "sessions").denied = true;
      securityRead(client, "events").denied = true;
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
export const accessSecurityEventsOptions = (
  client: QueryClient,
  request: AccessSecurityEventsRequest,
) =>
  queryOptions({
    queryKey: accessKeys.securityEventList(request),
    queryFn: ({ signal }) =>
      readSecurity(client, "events", signal, () =>
        listAccessSecurityEvents(request, signal),
      ),
  });
export function readAccessSecurityEvent(
  client: QueryClient,
  eventId: string,
  signal: AbortSignal,
) {
  return readSecurity(client, "events", signal, () =>
    getAccessSecurityEvent(eventId, signal),
  );
}
// The Overview dashboard's own reads. Its counts reuse the one-row status
// reads of People and the default user summary; these add the activity
// windows, who is signed in now, recent sign-ins and the group access.

/** Active sessions, newest first: one page counts who is signed in now. */
export const overviewSessionsRequest: AccessSessionsRequest = {
  ...defaultAccessSessionsRequest,
  limit: 100,
};
/**
 * Every other session in the organization, for the End all remote sessions
 * count: the total is the session count, and the distinct people on this
 * page are the people (a lower bound when more pages exist).
 */
export const remoteSessionsCountRequest: AccessSessionsRequest = {
  ...defaultAccessSessionsRequest,
  limit: 100,
  status: "remote",
};
/**
 * Events each feed read asks for. A page shows at most
 * `OVERVIEW_FEED_MAX_ROWS`; the rest leaves room for events that share the
 * cursor's instant and for the one event that says another page exists. The
 * limit does not follow the page size, so a resize reads nothing again.
 */
export const OVERVIEW_SIGN_IN_ROWS = 50;
export const OVERVIEW_FEED_MAX_ROWS = 44;
/**
 * `event_type` filters one exact type, so two reads cover the feed: the
 * search matches `identity.sign_in` and `identity.sign_in_failure` (the
 * server searches event types by substring), and lockouts have their own.
 * A cursor reads the events before it, or the events after it oldest
 * first, so the nearest come back within the limit. The server compares
 * `occurred_before` strictly and stores microseconds; a lockout and its
 * failed sign-in share one instant. So both windows take in the cursor's
 * whole millisecond, and `signInPage` drops what sits on the cursor's side.
 */
export function overviewSignInRequests(
  cursor: SignInCursor,
): readonly AccessSecurityEventsRequest[] {
  const millisecond = cursor ? Date.parse(cursor.at) : 0;
  const window: Partial<AccessSecurityEventsRequest> = !cursor
    ? {}
    : cursor.direction === "older"
      ? { occurred_before: new Date(millisecond + 1).toISOString() }
      : {
          occurred_after: new Date(millisecond).toISOString(),
          sort_order: "asc",
        };
  return [
    {
      ...defaultSecurityEventsRequest,
      limit: OVERVIEW_SIGN_IN_ROWS,
      search: "identity.sign_in",
      ...window,
    },
    {
      ...defaultSecurityEventsRequest,
      limit: OVERVIEW_SIGN_IN_ROWS,
      event_type: "identity.lockout",
      ...window,
    },
  ];
}
/** The groups whose access entries and members give access by department. */
export const OVERVIEW_GROUP_LIMIT = 100;
export const overviewGroupsOptions = () =>
  groupListOptions("exclude", { limit: OVERVIEW_GROUP_LIMIT, offset: 0 });
/** The activity windows of the last-sign-in bar, in days. */
export const OVERVIEW_WINDOWS = [1, 7, 30] as const;

export function afterAccessSecurityChange(
  client: QueryClient,
  policy: AccessSecurityPolicy,
) {
  client.setQueryData(accessKeys.security(), policy);
}
export function afterAccessAdminSessionsChange(client: QueryClient) {
  return invalidateAll(client, [
    accessKeys.adminSessions(),
    accessKeys.directory(),
  ]);
}

export const personSecurityOptions = (userId: string, actorId: string) =>
  queryOptions({
    queryKey: accessKeys.personSecurity(userId),
    queryFn: async ({ signal, client }) => {
      const [status, actor] = await Promise.all([
        getPersonSecurity(userId, signal),
        getMfaStatus(signal),
      ]);
      if (actor.user_id !== actorId)
        throw new Error("Security identity changed.");
      if (!signal.aborted) await afterAccessMfaObservation(client);
      return { status, assurance: actor.assurance_level };
    },
  });
export async function afterPersonSecurityChange(
  client: QueryClient,
  userId: string,
) {
  // Every cached session page is now stale. Read back only the bounded first
  // page; later pages are fetched again when the person explicitly opens them.
  await client.invalidateQueries({
    queryKey: accessKeys.userSessions(userId),
    refetchType: "none",
  });
  return Promise.all([
    client.fetchQuery({ ...userSessionsOptions(userId), staleTime: 0 }),
    client.invalidateQueries({ queryKey: accessKeys.adminSessions() }),
    afterAccessMfaObservation(client),
    client.invalidateQueries({
      queryKey: accessKeys.personSecurity(userId),
      refetchType: "none",
    }),
  ]);
}
