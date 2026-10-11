import {
  endAllAccessRemoteSessions,
  endAccessSession,
  getAccessCallerIp,
  getAccessSecurityPolicy,
  getPersonSecurity,
  listAccessSessions,
  recoverPerson,
  resetPersonMfa,
  updateAccessSecurityPolicy,
} from "../../../src/components/systems/access/adapters/security-api";
import {
  defaultSecurityEventsRequest,
  getAccessSecurityEvent,
  listAccessSecurityEvents,
} from "../../../src/components/systems/access/adapters/security-events-api";
import {
  cancelMfaEnrollment,
  enrollMfa,
  getMfaStatus,
  removeMfa,
  verifyMfa,
} from "../../../src/lib/mfa-api";
import {
  createAccessGroup,
  deleteAccessGroup,
  deleteAccessUser,
  getAccessGroup,
  getAccessInvitationSettings,
  getAccessUser,
  getAccessUserSummary,
  getAccessUserAccess,
  inviteAccessUser,
  listAccessDepartments,
  listAccessGroups,
  listAccessMemberCandidates,
  listAccessModules,
  listAccessUsers,
  listAccessUserSessions,
  replaceAccessGroupAccess,
  replaceAccessGroupMembers,
  resendAccessInvitation,
  restoreAccessUser,
  revokeAccessInvitation,
  revokeAccessUserSession,
  revokeAccessUserSessions,
  updateAccessGroup,
  updateAccessInvitationSettings,
  updateAccessUser,
} from "../../../src/components/systems/access/state/api";
import { describeContracts } from "./openapi-contract";

const userId = "00000000-0000-4000-8000-000000000001";
const groupId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const departmentId = "00000000-0000-4000-8000-000000000004";
const moduleId = "00000000-0000-4000-8000-000000000005";
const etag = '"group-1"';
const eventId = "00000000-0000-4000-8000-000000000006";
const factorId = "00000000-0000-4000-8000-000000000007";
const list = {
  limit: 25,
  offset: 0,
  sort_order: "asc",
  search: "ana",
  deleted: "exclude",
} as const;

// Policy controls represent independent values, including non-preset combinations.
const securityPolicy = {
  session_timeout_minutes: 30,
  password_min_length: 13,
  password_require_mixed_case: false,
  password_require_number: true,
};

describeContracts("Access", [
  {
    name: "getAccessCallerIp",
    run: () => getAccessCallerIp(),
    responses: { "GET /api/workspace/security/caller-ip": { address: "::1" } },
  },
  {
    name: "getAccessSecurityPolicy",
    run: () => getAccessSecurityPolicy(),
    responses: { "GET /api/workspace/security": securityPolicy },
  },
  {
    name: "updateAccessSecurityPolicy",
    run: () =>
      updateAccessSecurityPolicy({
        revision: 2,
        session_timeout_minutes: 30,
        password_min_length: 16,
        password_require_mixed_case: true,
        password_require_number: true,
        session_absolute_lifetime_minutes: null,
        session_concurrent_limit: null,
        mfa_require_admin: true,
        mfa_require_member: false,
        mfa_require_guest: false,
        mfa_grace_days: 0,
        login_failed_attempt_threshold: 5,
        login_window_minutes: 15,
        login_cooldown_minutes: 15,
        ip_allow_list: ["10.0.0.0/8"],
      }),
    responses: { "PATCH /api/workspace/security": securityPolicy },
  },
  {
    name: "listAccessSessions",
    run: () =>
      listAccessSessions({
        limit: 4,
        offset: 0,
        search: "ana",
        sort_by: "person_name",
        sort_order: "asc",
        status: "remote",
        device: "Desktop",
      }),
  },
  {
    name: "endAccessSession",
    run: () =>
      endAccessSession({
        id: sessionId,
        user_id: userId,
        person_name: "Ana",
        user_agent: null,
        device: "Desktop",
        browser: "Firefox",
        created_at: "2026-01-01T00:00:00Z",
        refreshed_at: "2026-01-01T00:00:00Z",
        expires_at: "2026-01-02T00:00:00Z",
        current: false,
        ip_address: null,
      }),
  },
  {
    name: "endAllAccessRemoteSessions",
    run: () => endAllAccessRemoteSessions(),
  },
  {
    name: "listAccessSecurityEvents",
    run: () =>
      listAccessSecurityEvents({
        ...defaultSecurityEventsRequest,
        search: "sign",
        event_type: "identity.sign_in",
        outcome: "failure",
        person_id: userId,
        occurred_after: "2026-10-01T00:00:00Z",
        occurred_before: "2026-10-02T00:00:00Z",
        operation_id: sessionId,
      }),
  },
  {
    name: "getAccessSecurityEvent",
    run: () => getAccessSecurityEvent(eventId),
    // The adapter refuses a detail for another event on purpose.
    responses: {
      "GET /api/security-events/{security_event_id}": { id: eventId },
    },
  },
  {
    name: "getPersonSecurity",
    run: () => getPersonSecurity(userId),
    // The adapter refuses a status for another person on purpose.
    responses: { "GET /api/users/{user_id}/security": { user_id: userId } },
  },
  // UserRecoveryResponse declares local_revocation and revoked_sessions
  // independently; the route sends a count only with "committed", and the
  // adapter refuses any other pairing (finding in the F4 report).
  {
    name: "recoverPerson",
    run: () => recoverPerson(userId, true),
    responses: {
      "POST /api/users/{user_id}/recovery": {
        user_id: userId,
        local_revocation: "committed",
        revoked_sessions: 2,
      },
    },
  },
  {
    name: "recoverPerson without signing out",
    run: () => recoverPerson(userId, false),
    responses: {
      "POST /api/users/{user_id}/recovery": {
        user_id: userId,
        local_revocation: "not_requested",
        revoked_sessions: null,
      },
    },
  },
  {
    name: "resetPersonMfa",
    run: () => resetPersonMfa(userId),
    responses: { "POST /api/users/{user_id}/mfa/reset": { user_id: userId } },
  },
  { name: "getMfaStatus", run: () => getMfaStatus() },
  { name: "enrollMfa", run: () => enrollMfa() },
  {
    name: "verifyMfa",
    run: () => verifyMfa(factorId, "123456"),
    // The route returns the access token only to bearer clients
    // (mfa_router.py); a cookie-authenticated browser gets null, the only
    // value the adapter accepts (finding in the F4 report).
    responses: {
      "POST /api/auth/mfa/factors/{factor_id}/verification": {
        access_token: null,
      },
    },
  },
  { name: "removeMfa", run: () => removeMfa(factorId) },
  { name: "cancelMfaEnrollment", run: () => cancelMfaEnrollment(factorId) },

  {
    name: "listAccessUsers",
    run: () =>
      listAccessUsers({ ...list, sort_by: "username", role: "member" }),
  },
  { name: "getAccessUserSummary", run: () => getAccessUserSummary() },
  { name: "getAccessUser", run: () => getAccessUser(userId) },
  {
    name: "inviteAccessUser",
    run: () =>
      inviteAccessUser({
        email: "ana@example.com",
        username: "ana",
        role: "guest",
        group_ids: [groupId],
        display_name: "Ana",
        job_title: "Clerk",
        sponsor_user_id: userId,
        expires_at: "2026-02-01T00:00:00Z",
      }),
  },
  {
    name: "updateAccessUser",
    run: () =>
      updateAccessUser(userId, {
        username: "ana",
        role: "member",
        status: "active",
        display_name: "Ana",
        job_title: "Clerk",
        sponsor_user_id: null,
        expires_at: null,
      }),
  },
  { name: "deleteAccessUser", run: () => deleteAccessUser(userId) },
  { name: "restoreAccessUser", run: () => restoreAccessUser(userId) },
  { name: "resendAccessInvitation", run: () => resendAccessInvitation(userId) },
  { name: "revokeAccessInvitation", run: () => revokeAccessInvitation(userId) },
  { name: "getAccessUserAccess", run: () => getAccessUserAccess(userId) },
  {
    name: "listAccessUserSessions",
    run: () => listAccessUserSessions(userId, { limit: 25, offset: 0 }),
  },
  {
    name: "revokeAccessUserSession",
    run: () => revokeAccessUserSession(userId, sessionId),
  },
  {
    name: "revokeAccessUserSessions",
    run: () => revokeAccessUserSessions(userId),
  },
  {
    name: "listAccessGroups",
    run: () => listAccessGroups({ ...list, sort_by: "name" }),
  },
  { name: "getAccessGroup", run: () => getAccessGroup(groupId) },
  {
    name: "createAccessGroup",
    run: () =>
      createAccessGroup({
        name: "Clerks",
        description: "Front desk",
        member_ids: [userId],
      }),
  },
  {
    name: "updateAccessGroup",
    run: () =>
      updateAccessGroup(groupId, {
        name: "Clerks",
        description: "Front desk",
        etag,
      }),
  },
  {
    name: "replaceAccessGroupAccess",
    run: () =>
      replaceAccessGroupAccess(groupId, {
        access: [
          { department_id: departmentId, module_id: null, level: "read" },
          { department_id: departmentId, module_id: moduleId, level: "write" },
        ],
        etag,
      }),
  },
  {
    name: "replaceAccessGroupMembers",
    run: () =>
      replaceAccessGroupMembers(groupId, { member_ids: [userId], etag }),
  },
  {
    name: "deleteAccessGroup",
    run: () => deleteAccessGroup(groupId, { etag }),
  },
  {
    name: "listAccessMemberCandidates",
    run: () =>
      listAccessMemberCandidates({
        limit: 25,
        offset: 0,
        sort_by: "display_name",
        sort_order: "desc",
        search: "ana",
      }),
    responses: {
      // The route never lists administrators; the frontend rejects one on purpose.
      "GET /api/access/member-candidates": { items: [{ role: "member" }] },
    },
  },
  {
    name: "listAccessDepartments",
    run: () => listAccessDepartments({ ...list, sort_by: "department_name" }),
  },
  {
    name: "listAccessModules",
    run: () =>
      listAccessModules({
        ...list,
        sort_by: "module_name",
        department_id: departmentId,
      }),
  },
  {
    name: "getAccessInvitationSettings",
    run: () => getAccessInvitationSettings(),
  },
  {
    name: "updateAccessInvitationSettings",
    run: () =>
      updateAccessInvitationSettings({
        revision: 3,
        invitation_expiry_days: 7,
        guest_duration_days: 30,
      }),
  },
]);
