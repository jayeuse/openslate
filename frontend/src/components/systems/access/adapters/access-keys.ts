import type { AccessSessionsRequest } from "./security-api";
import type { AccessSecurityEventsRequest } from "./security-events-api";
import type {
  AccessDeletedFilter,
  AccessDepartmentListOptions,
  AccessGroupListOptions,
  AccessSessionListOptions,
  AccessUserListOptions,
} from "../state/api";

// The Access query keys alone, without the reads, so another area can mark
// Access stale (Manage after a policy change) without loading Access code.
// The key comments live with the reads in access-queries.ts.

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
