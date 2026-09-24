"use client";

import { ApiError } from "@/lib/api";
import {
  createSampleCommands,
  createSampleResource,
  sampleOperationMessage,
} from "../../shared/runtime/sample-async-state";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  SampleOperationError,
  type SampleDraft,
  type SampleRuntime,
} from "../../shared/runtime/sample-runtime";
import {
  departments,
  initialPeople,
  initialRoles,
  type Role,
} from "../domain/model";
import {
  createPolicyBundle,
  parsePolicyBundle,
  type AccessPolicyBundleV1,
} from "../domain/policy-bundle";
import {
  initialAccessDefaults,
  initialAccessGroups,
  initialAccessHistory,
  initialAccessIdentities,
  initialAccessReviews,
  initialAccessRules,
  initialAccessTemplates,
  initialDeletedAccessIdentities,
  type AccessDefaults,
  type AccessIdentity,
  type AccessGroup,
  type AccessIdentityStatus,
  type AccessReview,
  type AccessRule,
} from "../domain/policy";
import {
  adaptManageSessions,
  getAccessHealth,
  previewBulkIdentityUpdate,
  previewHistoryRestore,
  projectManageSessions,
  type AccessCommand,
  type AccessCommandResult,
  type AccessControllerSnapshot,
  type AccessHealthFinding,
  type BulkIdentityImpact,
  type BulkIdentityUpdateInput,
  type ControllerHistoryEntry,
  type CreateGroupInput,
  type CreateIdentityInput,
  type CreateReviewCampaignInput,
  type CreateRoleInput,
  type DeletedInternalIdentity,
  type ManagedGuestIdentity,
  type PermissionCatalogEntry,
  type UpdateIdentityPatch,
  type UpdateRolePatch,
} from "../domain/controller-utils";
import {
  initialManageSessions,
  type ManageSession,
} from "../../manage/state/sessions";
import {
  decodeBoardAnnouncements,
  decodeBoards,
  INITIAL_ANNOUNCEMENTS as initialAnnouncements,
  INITIAL_BOARDS as initialBoards,
  type Announcement,
  type BoardAudienceLookup,
  type SampleBoard,
} from "../../boards/domain/model";
import {
  initialDashboards,
  initialReport,
  initialReportTemplates,
  initialSavedViews,
} from "../../openview/domain/seeds";
import {
  activeAudienceIdentities,
  decodeDashboards,
  decodeReport,
  decodeReports,
  decodeSavedViews,
  projectAudienceLookup,
  toLegacyDashboard,
  toLegacyReport,
  type AudienceLookup,
} from "../../openview/domain/model";
import {
  CATEGORIES,
  CHANNELS,
  type Category,
  type Channel,
} from "../../comms/domain/model";
import { normalizeCommsConfiguration } from "../../comms/domain/configuration";
import {
  getFederatedAccess,
  type FederatedAccessOwners,
} from "../adapters/federated-adapters";
import {
  ACCESS_CAPABILITY_IDS,
  createAccessGroup,
  createAccessRole,
  applyAccessPolicyRuleBatch,
  createAccessServiceIdentity,
  createAccessUser,
  deleteAccessGroup,
  deleteAccessRole,
  deleteAccessServiceIdentity,
  deleteAccessUser,
  getAccessRole,
  previewAccessPolicyRuleBatch,
  resendAccessInvitation,
  revokeAccessInvitation,
  listAccessUserSessions,
  revokeAccessUserSession,
  revokeAccessUserSessions,
  updateAccessDefaults,
  updateAccessGroup,
  updateAccessRole,
  updateAccessServiceIdentity,
  updateAccessUser,
  checkWorkspaceAccess,
  type AccessDefaultsPatch,
  type AccessCapabilityId,
  type AccessCheckRequest,
  type AccessCheckResponse,
  type AccessGroupPatch,
  type AccessPolicyRuleBatchApply,
  type AccessPolicyRuleBatchOperation,
  type AccessRuleSubjectKind,
  type AccessRolePatch,
  type AccessServiceIdentityPatch,
  type AccessUserPatch,
  type AccessSession as ApiAccessSession,
} from "./api";
import {
  loadAuthoritativeAccessSnapshot,
  mapAuthoritativeScopeCatalog,
  type AuthoritativeAccessSnapshot,
} from "./authoritative";

export {
  scopeCatalog,
  type AccessHealthFinding,
  type AccessSession,
  type BulkIdentityImpact,
  type BulkIdentityUpdateInput,
  type CreateGroupInput,
  type CreateIdentityInput,
  type CreateReviewCampaignInput,
  type CreateRoleInput,
  type DeletedInternalIdentity,
  type ManagedGuestIdentity,
  type PermissionCatalogEntry,
  type ScopeCatalogEntry,
  type UpdateIdentityPatch,
  type UpdateRolePatch,
} from "../domain/controller-utils";

type VersionedItems<T> = { version: 1; items: T[] };
type VersionedValue<T> = { version: 1; value: T };

const initialGuests: ManagedGuestIdentity[] = initialAccessIdentities
  .filter((identity) => identity.kind === "guest")
  .map((identity) => ({
    ...identity,
    invitation: { sentAt: "2026-09-01T00:00:00.000Z", resendCount: 0 },
  }));
const initialServices = initialAccessIdentities.filter(
  (identity) => identity.kind === "service",
);
const initialDeletedIdentities: DeletedInternalIdentity[] =
  initialDeletedAccessIdentities.map((item) => ({
    ...item,
    person:
      initialPeople.find((person) => person.id === item.identity.id) ??
      initialPeople[0],
  }));

export const ACCESS_OWNER_KEYS = [
  "access-people",
  "access-roles",
  "access-guests-v1",
  "access-services-v1",
  "access-groups-v1",
  "access-rules-v1",
  "boards-list",
  "boards-announcements",
  "views-saved",
  "views-dashboards",
  "views-report-draft",
  "views-report-templates",
  "comms-configuration",
  "commsCategories",
  "commsChannels",
  "access-defaults-v1",
  "access-templates-v1",
  "access-reviews-v1",
  "access-deleted-identities-v1",
  "manage-sessions",
  "access-history-v1",
] as const;

export type AccessReader = <T>(key: string, initial: T) => T;
export type AccessRuntimeSnapshot = {
  snapshot: AccessControllerSnapshot;
  owners: FederatedAccessOwners;
  manageSessions: ManageSession[];
  federatedFindings: AccessHealthFinding[];
};

export function readAccessProjection(
  read: AccessReader,
): AccessRuntimeSnapshot {
  // The pure federated executors may update nested arrays while constructing
  // their result. Clone each native owner before handing it to a recipe so a
  // rejected or superseded operation cannot mutate the published snapshot.
  const people = structuredClone(read("access-people", initialPeople));
  const roles = structuredClone(read("access-roles", initialRoles));
  const guestSlice = structuredClone(
    read<VersionedItems<ManagedGuestIdentity>>("access-guests-v1", {
      version: 1,
      items: initialGuests,
    }),
  );
  const serviceSlice = structuredClone(
    read<VersionedItems<(typeof initialServices)[number]>>(
      "access-services-v1",
      { version: 1, items: initialServices },
    ),
  );
  const groupSlice = structuredClone(
    read<VersionedItems<AccessGroup>>("access-groups-v1", {
      version: 1,
      items: initialAccessGroups,
    }),
  );
  const ruleSlice = structuredClone(
    read<VersionedItems<AccessRule>>("access-rules-v1", {
      version: 1,
      items: initialAccessRules,
    }),
  );
  const defaultSlice = structuredClone(
    read<VersionedValue<AccessDefaults>>("access-defaults-v1", {
      version: 1,
      value: initialAccessDefaults,
    }),
  );
  const templateSlice = structuredClone(
    read("access-templates-v1", {
      version: 1 as const,
      items: initialAccessTemplates,
    }),
  );
  const reviewSlice = structuredClone(
    read<VersionedItems<AccessReview>>("access-reviews-v1", {
      version: 1,
      items: initialAccessReviews,
    }),
  );
  const deletedSlice = structuredClone(
    read<VersionedItems<DeletedInternalIdentity>>(
      "access-deleted-identities-v1",
      { version: 1, items: initialDeletedIdentities },
    ),
  );
  const manageSessions = structuredClone(
    read<ManageSession[]>("manage-sessions", initialManageSessions),
  );
  const historySlice = structuredClone(
    read<VersionedItems<ControllerHistoryEntry>>("access-history-v1", {
      version: 1,
      items: initialAccessHistory,
    }),
  );
  const rawBoards = read<unknown>("boards-list", null);
  const rawAnnouncements = read<unknown>("boards-announcements", null);
  const rawSavedViews = read<unknown>("views-saved", initialSavedViews);
  const rawDashboards = read<unknown>("views-dashboards", null);
  const rawReportDraft = read<unknown>("views-report-draft", initialReport);
  const rawReportTemplates = read<unknown>(
    "views-report-templates",
    initialReportTemplates,
  );
  const rawCommsConfiguration = read<unknown>("comms-configuration", null);
  const commsCategories = structuredClone(
    read<Category[]>("commsCategories", CATEGORIES),
  );
  const commsChannels = structuredClone(
    read<Channel[]>("commsChannels", CHANNELS),
  );

  const openViewAudienceLookup: AudienceLookup = {
    roles: roles.map(({ id, name }) => ({ id, name })),
    identities: activeAudienceIdentities(people),
  };
  const boardAudienceLookup: BoardAudienceLookup = {
    roles: roles.map(({ id, name }) => ({ id, name })),
    identities: activeAudienceIdentities(people),
    departments: ["Organization", ...departments].map((name) => ({
      id: name.toLowerCase().replaceAll(" ", "-"),
      name,
    })),
  };
  const boards: SampleBoard[] =
    rawBoards === null
      ? structuredClone(initialBoards)
      : decodeBoards(rawBoards, { audienceLookup: boardAudienceLookup });
  const announcements: Announcement[] =
    rawAnnouncements === null
      ? structuredClone(initialAnnouncements)
      : decodeBoardAnnouncements(rawAnnouncements, {
          audienceLookup: boardAudienceLookup,
        });
  const owners: FederatedAccessOwners = {
    boards,
    announcements,
    savedViews: decodeSavedViews(rawSavedViews, openViewAudienceLookup),
    dashboards: decodeDashboards(
      rawDashboards ?? structuredClone(initialDashboards),
      openViewAudienceLookup,
    ),
    reportDraft: decodeReport(rawReportDraft, openViewAudienceLookup),
    reportTemplates: decodeReports(rawReportTemplates, openViewAudienceLookup),
    commsConfiguration: normalizeCommsConfiguration(rawCommsConfiguration),
    commsCategories,
    commsChannels,
  };
  const federated = getFederatedAccess(owners, {
    roles,
    identities: people.map(({ id, name, active, accessStatus }) => ({
      id,
      name,
      status: accessStatus,
      deleted: !active,
    })),
    departments: boardAudienceLookup.departments,
  });

  return {
    snapshot: {
      people,
      roles,
      guests: guestSlice.items,
      services: serviceSlice.items,
      groups: groupSlice.items,
      rules: [...ruleSlice.items, ...federated.rules],
      defaults: defaultSlice.value,
      templates: templateSlice.items,
      reviews: reviewSlice.items,
      deletedIdentities: deletedSlice.items,
      sessions: adaptManageSessions(manageSessions),
      history: historySlice.items,
      federatedScopes: federated.scopes,
    },
    owners,
    manageSessions,
    federatedFindings: federated.findings,
  };
}

export function readAccessRuntimeSnapshot(
  runtime: Pick<SampleRuntime, "read">,
): AccessRuntimeSnapshot {
  return readAccessProjection(runtime.read);
}

function commandKey(command: AccessCommand): string {
  switch (command.type) {
    case "create-identity":
      return "access:identity:create";
    case "update-identity":
    case "set-identity-status":
    case "resend-invite":
    case "revoke-invite":
    case "restore-identity":
    case "delete-identity":
      return `access:identity:${command.identityId}`;
    case "revoke-session":
      return `access:session:${command.sessionId}`;
    case "revoke-all-sessions":
      return `access:identity:${command.identityId}:sessions`;
    case "bulk-update-identities":
      return "access:identities:bulk";
    case "create-role":
      return "access:role:create";
    case "update-role":
    case "duplicate-role":
    case "delete-role":
    case "apply-role-template":
      return `access:role:${command.roleId}`;
    case "create-group":
      return "access:group:create";
    case "update-group":
    case "delete-group":
    case "set-group-members":
      return `access:group:${command.groupId}`;
    case "upsert-rule":
      return `access:rule:${command.rule.id}`;
    case "upsert-rules":
      return "access:rules:bulk";
    case "delete-rule":
      return `access:rule:${command.ruleId}`;
    case "update-defaults":
      return "access:defaults";
    case "create-review-campaign":
      return "access:review:create";
    case "record-review-decision":
      return `access:record-review-decision:${command.reviewId}`;
    case "complete-review":
      return `access:complete-review:${command.reviewId}`;
    case "apply-history-restore":
      return `access:apply-history-restore:${command.historyId}`;
    case "import-policy-bundle":
      return "access:policy:import";
    default:
      return "access:unknown";
  }
}

export function writeAccessProjection(
  draft: SampleDraft,
  next: AccessControllerSnapshot,
  owners: FederatedAccessOwners,
  previousManageSessions: ManageSession[],
): void {
  const openViewAudienceLookup = projectAudienceLookup(next.roles, next.people);
  const dashboards = decodeDashboards(
    owners.dashboards,
    openViewAudienceLookup,
  );
  const reportDraft = decodeReport(owners.reportDraft, openViewAudienceLookup);
  const reportTemplates = decodeReports(
    owners.reportTemplates,
    openViewAudienceLookup,
  );
  draft.update("access-people", initialPeople, next.people);
  draft.update("access-roles", initialRoles, next.roles);
  draft.update(
    "access-guests-v1",
    { version: 1 as const, items: initialGuests },
    { version: 1, items: next.guests },
  );
  draft.update(
    "access-services-v1",
    { version: 1 as const, items: initialServices },
    { version: 1, items: next.services },
  );
  draft.update(
    "access-groups-v1",
    { version: 1 as const, items: initialAccessGroups },
    { version: 1, items: next.groups },
  );
  draft.update(
    "access-rules-v1",
    { version: 1 as const, items: initialAccessRules },
    { version: 1, items: next.rules },
  );
  draft.update("boards-list", initialBoards, owners.boards);
  draft.update(
    "boards-announcements",
    initialAnnouncements,
    owners.announcements,
  );
  draft.update<unknown>("views-saved", initialSavedViews, owners.savedViews);
  draft.update(
    "views-dashboards",
    initialDashboards,
    dashboards.map((dashboard) =>
      toLegacyDashboard(dashboard, openViewAudienceLookup),
    ),
  );
  draft.update(
    "views-report-draft",
    initialReport,
    toLegacyReport(reportDraft, openViewAudienceLookup),
  );
  draft.update(
    "views-report-templates",
    initialReportTemplates,
    reportTemplates.map((report) =>
      toLegacyReport(report, openViewAudienceLookup),
    ),
  );
  draft.update<unknown>("comms-configuration", null, owners.commsConfiguration);
  draft.update<Category[]>(
    "commsCategories",
    CATEGORIES,
    owners.commsCategories,
  );
  draft.update<Channel[]>("commsChannels", CHANNELS, owners.commsChannels);
  draft.update(
    "access-defaults-v1",
    { version: 1 as const, value: initialAccessDefaults },
    { version: 1, value: next.defaults },
  );
  draft.update(
    "access-templates-v1",
    { version: 1 as const, items: initialAccessTemplates },
    { version: 1, items: next.templates },
  );
  draft.update(
    "access-reviews-v1",
    { version: 1 as const, items: initialAccessReviews },
    { version: 1, items: next.reviews },
  );
  draft.update(
    "access-deleted-identities-v1",
    { version: 1 as const, items: [] as DeletedInternalIdentity[] },
    { version: 1, items: next.deletedIdentities },
  );
  draft.update(
    "manage-sessions",
    initialManageSessions,
    projectManageSessions(next.sessions, previousManageSessions),
  );
  draft.update(
    "access-history-v1",
    { version: 1 as const, items: [] as ControllerHistoryEntry[] },
    { version: 1, items: next.history },
  );
}

export type ControllerMutationResult =
  | {
      ok: true;
      summary: string;
      value?: Extract<AccessCommandResult, { ok: true }>["value"];
    }
  | { ok: false; error: string };

export function mapAuthoritativePermissionCatalog(
  capabilities: AuthoritativeAccessSnapshot["capabilities"],
): PermissionCatalogEntry[] {
  return capabilities.map((capability) => ({
    id: capability.id,
    name: capability.label,
    product: "Sandbox/core" as const,
  }));
}

export async function checkAuthoritativeAccess({
  current,
  identityId,
  permissionId,
  signal,
  check = checkWorkspaceAccess,
}: {
  current: AuthoritativeAccessSnapshot;
  identityId: string;
  permissionId: string;
  signal?: AbortSignal;
  check?: (
    request: AccessCheckRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<AccessCheckResponse>;
}): Promise<AccessCheckResponse> {
  const identity = authoritativeIdentities(current.snapshot).find(
    (candidate) => candidate.id === identityId,
  );
  if (!identity)
    throw new Error("The selected identity is no longer available.");
  const capability = current.capabilities.find(
    (candidate) => candidate.id === permissionId,
  );
  if (!capability)
    throw new Error("The selected action is no longer available.");

  const request: AccessCheckRequest = {
    principal_kind: identity.kind === "service" ? "service" : "user",
    principal_id: identity.id,
    permission_id: capability.id,
    scope_kind: "workspace",
  };
  const result = await check(request, { signal });
  if (
    result.principal_kind !== request.principal_kind ||
    result.principal_id !== request.principal_id ||
    result.permission_id !== request.permission_id ||
    result.scope_kind !== request.scope_kind
  )
    throw new Error("The access check response did not match the request.");
  return result;
}

export function getAuthoritativeAdminRoleId(
  snapshot: AccessControllerSnapshot,
): string | null {
  return snapshot.roles.find((role) => role.name === "admin")?.id ?? null;
}

export type AuthoritativeAccessCommandAdapters = {
  createUser: typeof createAccessUser;
  updateUser: typeof updateAccessUser;
  deleteUser: typeof deleteAccessUser;
  resendInvitation: typeof resendAccessInvitation;
  revokeInvitation: typeof revokeAccessInvitation;
  revokeSession: typeof revokeAccessUserSession;
  revokeAllSessions: typeof revokeAccessUserSessions;
  getRole: typeof getAccessRole;
  createRole: typeof createAccessRole;
  updateRole: typeof updateAccessRole;
  deleteRole: typeof deleteAccessRole;
  createGroup: typeof createAccessGroup;
  updateGroup: typeof updateAccessGroup;
  deleteGroup: typeof deleteAccessGroup;
  updateDefaults: typeof updateAccessDefaults;
  createService: typeof createAccessServiceIdentity;
  updateService: typeof updateAccessServiceIdentity;
  deleteService: typeof deleteAccessServiceIdentity;
  previewRules: typeof previewAccessPolicyRuleBatch;
  applyRules: typeof applyAccessPolicyRuleBatch;
};

const authoritativeAccessCommandAdapters: AuthoritativeAccessCommandAdapters = {
  createUser: createAccessUser,
  updateUser: updateAccessUser,
  deleteUser: deleteAccessUser,
  resendInvitation: resendAccessInvitation,
  revokeInvitation: revokeAccessInvitation,
  revokeSession: revokeAccessUserSession,
  revokeAllSessions: revokeAccessUserSessions,
  getRole: getAccessRole,
  createRole: createAccessRole,
  updateRole: updateAccessRole,
  deleteRole: deleteAccessRole,
  createGroup: createAccessGroup,
  updateGroup: updateAccessGroup,
  deleteGroup: deleteAccessGroup,
  updateDefaults: updateAccessDefaults,
  createService: createAccessServiceIdentity,
  updateService: updateAccessServiceIdentity,
  deleteService: deleteAccessServiceIdentity,
  previewRules: previewAccessPolicyRuleBatch,
  applyRules: applyAccessPolicyRuleBatch,
};

const EMPTY_ACCESS_SNAPSHOT: AccessControllerSnapshot = {
  people: [],
  roles: [],
  guests: [],
  services: [],
  groups: [],
  rules: [],
  defaults: {
    defaultRoleId: "",
    defaultDepartmentIds: [],
    defaultGroupIds: [],
    invitationExpiryDays: 1,
    guestDurationDays: 1,
    serviceDurationDays: 1,
    defaultDeny: true,
    requireGuestSponsor: true,
    requireServiceOwner: true,
  },
  templates: [],
  reviews: [],
  deletedIdentities: [],
  sessions: [],
  history: [],
  federatedScopes: [],
};

export type LazySessionState = {
  status: "idle" | "loading" | "ready" | "error";
  identityId: string | null;
  sessions: AccessControllerSnapshot["sessions"];
  error: string | null;
};

export async function loadAllAccessUserSessions(
  userId: string,
  read: typeof listAccessUserSessions = listAccessUserSessions,
  signal?: AbortSignal,
): Promise<ApiAccessSession[]> {
  const sessions: ApiAccessSession[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < 20; page += 1) {
    const result = await read(userId, { limit: 100, offset, signal });
    if (
      result.pagination.offset !== offset ||
      result.pagination.count !== result.items.length ||
      result.pagination.count > 100
    )
      throw new Error("Access session pagination is inconsistent.");
    for (const session of result.items) {
      if (seen.has(session.id))
        throw new Error("Access session pagination repeated a session.");
      seen.add(session.id);
      sessions.push(session);
    }
    const nextOffset = offset + result.pagination.count;
    if (result.pagination.has_more !== nextOffset < result.pagination.total)
      throw new Error("Access session pagination is inconsistent.");
    if (!result.pagination.has_more) {
      if (nextOffset !== result.pagination.total)
        throw new Error("Access session pagination ended early.");
      return sessions;
    }
    if (nextOffset <= offset)
      throw new Error("Access session pagination did not progress.");
    offset = nextOffset;
  }
  throw new Error("Access session pagination exceeded its safe limit.");
}

function mapAccessSessions(
  identityId: string,
  sessions: readonly ApiAccessSession[],
): AccessControllerSnapshot["sessions"] {
  return sessions.map((session) => ({
    id: session.id,
    identityId,
    label: session.user_agent ?? "Unknown device",
    current: session.current,
    status: "active" as const,
    lastActiveAt: session.refreshed_at,
  }));
}

function authoritativeIdentities(
  snapshot: AccessControllerSnapshot,
): AccessIdentity[] {
  return [
    ...snapshot.people.map((person) => ({
      kind: "internal" as const,
      id: person.id,
      name: person.name,
      email: person.email,
      status: person.accessStatus ?? (person.active ? "active" : "disabled"),
      roleId: person.role,
      groupIds: [...(person.groupIds ?? [])],
      departmentIds:
        person.departmentIds ??
        person.departments.map(
          (department) =>
            `department:${department.toLowerCase().replaceAll(" ", "-")}`,
        ),
      primaryDepartmentId:
        person.primaryDepartmentId ??
        (person.primary
          ? `department:${person.primary.toLowerCase().replaceAll(" ", "-")}`
          : ""),
      title: person.title,
      ...(person.expiresAt ? { expiresAt: person.expiresAt } : {}),
    })),
    ...snapshot.guests.map((identity) => structuredClone(identity)),
    ...snapshot.services.map((identity) => structuredClone(identity)),
  ];
}

function accepted(summary: string): ControllerMutationResult {
  return { ok: true, summary };
}

function rejected(error: string): ControllerMutationResult {
  return { ok: false, error };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((id, index) => id === sortedRight[index])
  );
}

function usernameForInvitation(email: string, attempt = 0): string | null {
  const normalizedEmail = email.trim().toLowerCase();
  const [local, domain] = normalizedEmail.split("@");
  if (!local || !domain) return null;
  const prefix = local.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const base = prefix.length >= 3 ? prefix : `${prefix || "user"}-user`;
  let suffix = "";
  if (attempt > 0) {
    let hash = 2166136261;
    for (const character of normalizedEmail)
      hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    suffix = `-${(hash >>> 0).toString(36)}-${attempt}`;
  }
  const username = `${base.slice(0, 100 - suffix.length)}${suffix}`;
  return /^[a-z0-9_-]{3,100}$/.test(username) ? username : null;
}

function capabilityPermissions(
  grants: readonly string[],
): AccessRolePatch["permissions"] | null {
  if (
    grants.some(
      (grant) =>
        !ACCESS_CAPABILITY_IDS.includes(
          grant as (typeof ACCESS_CAPABILITY_IDS)[number],
        ),
    )
  )
    return null;
  return Object.fromEntries([...new Set(grants)].map((grant) => [grant, true]));
}

function identityFor(current: AuthoritativeAccessSnapshot, identityId: string) {
  return authoritativeIdentities(current.snapshot).find(
    (identity) => identity.id === identityId,
  );
}

function versionFor(
  versions: Record<string, string>,
  id: string,
  resource: string,
): string | ControllerMutationResult {
  const etag = versions[id];
  return etag
    ? etag
    : rejected(
        `${resource} version is unavailable. Reload Access and try again.`,
      );
}

function userPatchFor(
  patch: UpdateIdentityPatch,
): AccessUserPatch | ControllerMutationResult {
  if ("email" in patch) return rejected("Email changes are not available yet.");
  if ("groupIds" in patch)
    return rejected("Change group membership from the group editor.");
  const result: AccessUserPatch = {};
  if ("name" in patch) result.display_name = patch.name?.trim() || null;
  if ("roleId" in patch && patch.roleId) result.role_id = patch.roleId;
  if ("status" in patch) {
    if (patch.status !== "active" && patch.status !== "disabled")
      return rejected("This identity status cannot be changed here.");
    result.status = patch.status;
  }
  if ("title" in patch) result.job_title = patch.title?.trim() || null;
  if ("sponsorId" in patch && patch.sponsorId)
    result.sponsor_user_id = patch.sponsorId;
  if ("expiresAt" in patch) result.expires_at = patch.expiresAt?.trim() || null;
  if ("departmentIds" in patch) result.department_ids = patch.departmentIds;
  if ("primaryDepartmentId" in patch)
    result.primary_department_id = patch.primaryDepartmentId || null;
  return Object.keys(result).length
    ? result
    : rejected("No supported changes were supplied.");
}

function servicePatchFor(
  patch: UpdateIdentityPatch,
): AccessServiceIdentityPatch | ControllerMutationResult {
  if ("groupIds" in patch)
    return rejected("Service identities cannot join groups.");
  if (
    "email" in patch ||
    "departmentIds" in patch ||
    "primaryDepartmentId" in patch ||
    "title" in patch ||
    "sponsorId" in patch
  )
    return rejected("This change is not available for a service identity.");
  const result: AccessServiceIdentityPatch = {};
  if ("name" in patch && patch.name) result.name = patch.name.trim();
  if ("roleId" in patch && patch.roleId) result.role_id = patch.roleId;
  if ("ownerId" in patch && patch.ownerId) result.owner_id = patch.ownerId;
  if ("purpose" in patch && patch.purpose)
    result.purpose = patch.purpose.trim();
  if ("expiresAt" in patch && patch.expiresAt)
    result.expires_at = patch.expiresAt;
  if ("status" in patch) {
    if (patch.status !== "active" && patch.status !== "disabled")
      return rejected("This identity status cannot be changed here.");
    result.status = patch.status;
  }
  return Object.keys(result).length
    ? result
    : rejected("No supported changes were supplied.");
}

function isFailure(
  value: string | ControllerMutationResult,
): value is ControllerMutationResult {
  return typeof value !== "string";
}

function isRejected(value: unknown): value is ControllerMutationResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

function policyRevisionFor(etag: string): number | ControllerMutationResult {
  const match = /^"workspace:([1-9]\d*)"$/.exec(etag);
  if (!match)
    return rejected(
      "Policy version is unavailable. Reload Access and try again.",
    );
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision)
    ? revision
    : rejected("Policy version is unavailable. Reload Access and try again.");
}

function policySubjectKindFor(
  current: AuthoritativeAccessSnapshot,
  rule: AccessRule,
): AccessRuleSubjectKind | ControllerMutationResult {
  const subject = rule.subject;
  if (subject.kind === "everyone") return "everyone";
  if (subject.kind === "role" || subject.kind === "group") return subject.kind;
  const persisted = current.versions.ruleSubjectKinds[rule.id];
  if (persisted === "user" || persisted === "service") return persisted;
  if (current.snapshot.services.some((identity) => identity.id === subject.id))
    return "service";
  if (
    [...current.snapshot.people, ...current.snapshot.guests].some(
      (identity) => identity.id === subject.id,
    )
  )
    return "user";
  return rejected("Rule subject is unavailable. Reload Access and try again.");
}

function policyRuleCommandFor(
  current: AuthoritativeAccessSnapshot,
  rule: AccessRule,
):
  | {
      subject_kind: AccessRuleSubjectKind;
      subject_id: string | null;
      scope_kind: "workspace" | "department";
      scope_id: string | null;
      permission_id: (typeof ACCESS_CAPABILITY_IDS)[number];
      decision: AccessRule["decision"];
      starts_at: string | null;
      ends_at: string | null;
      locked: boolean;
    }
  | ControllerMutationResult {
  const subjectKind = policySubjectKindFor(current, rule);
  if (isFailure(subjectKind)) return subjectKind;
  const subjectId = rule.subject.kind === "everyone" ? null : rule.subject.id;
  if (!ACCESS_CAPABILITY_IDS.includes(rule.permissionId as AccessCapabilityId))
    return rejected(
      "Rule permission is unavailable. Reload Access and try again.",
    );
  if (rule.scope.kind !== "workspace" && rule.scope.kind !== "department")
    return rejected("Only workspace and department rules are available.");
  if (rule.scope.kind === "workspace" && rule.scope.id !== "workspace")
    return rejected("Workspace rules must use the workspace scope.");
  if (
    rule.scope.kind === "department" &&
    !current.departments.some((department) => department.id === rule.scope.id)
  )
    return rejected("Rule scope is unavailable. Reload Access and try again.");
  return {
    subject_kind: subjectKind,
    subject_id: subjectId,
    scope_kind: rule.scope.kind,
    scope_id: rule.scope.kind === "workspace" ? null : rule.scope.id,
    permission_id: rule.permissionId as AccessCapabilityId,
    decision: rule.decision,
    starts_at: rule.startsAt ?? null,
    ends_at: rule.endsAt ?? null,
    locked: rule.locked === true,
  };
}

function ruleOperationsFor(
  current: AuthoritativeAccessSnapshot,
  rules: readonly AccessRule[],
): AccessPolicyRuleBatchOperation[] | ControllerMutationResult {
  if (!rules.length) return rejected("At least one policy rule is required.");
  if (rules.length > 100)
    return rejected("Review at most 100 policy changes at a time.");
  const seen = new Set<string>();
  const persisted = new Set(current.snapshot.rules.map((rule) => rule.id));
  const operations: AccessPolicyRuleBatchOperation[] = [];
  for (const rule of rules) {
    if (seen.has(rule.id))
      return rejected("Each policy rule can be changed only once per review.");
    seen.add(rule.id);
    const command = policyRuleCommandFor(current, rule);
    if (isRejected(command)) return command;
    operations.push(
      persisted.has(rule.id)
        ? { type: "update", rule_id: rule.id, patch: command }
        : { type: "create", rule: command },
    );
  }
  return operations;
}

function deleteRuleOperationFor(
  current: AuthoritativeAccessSnapshot,
  ruleId: string,
): AccessPolicyRuleBatchOperation[] | ControllerMutationResult {
  if (!current.snapshot.rules.some((rule) => rule.id === ruleId))
    return rejected("Rule is unavailable. Reload Access and try again.");
  return [{ type: "delete", rule_id: ruleId }];
}

async function applyAuthoritativeRuleOperations(
  current: AuthoritativeAccessSnapshot,
  operations: AccessPolicyRuleBatchOperation[],
  adapters: AuthoritativeAccessCommandAdapters,
  signal?: AbortSignal,
  onApplyAttempt?: () => void,
): Promise<ControllerMutationResult> {
  const baseRevision = policyRevisionFor(current.versions.policy);
  if (isRejected(baseRevision)) return baseRevision;
  const preview = await adapters.previewRules({
    base_revision: baseRevision,
    operations,
    signal,
  });
  const previewRevision = policyRevisionFor(preview.etag);
  if (isRejected(previewRevision)) return previewRevision;
  if (!preview.data.can_apply || preview.data.blockers.length)
    return rejected(
      preview.data.blockers[0]?.message ??
        "Policy changed during review. Reload Access and try again.",
    );
  if (
    preview.etag !== current.versions.policy ||
    previewRevision !== baseRevision ||
    preview.data.base_revision !== baseRevision ||
    preview.data.current_revision !== baseRevision
  )
    return rejected(
      "Policy changed during review. Reload Access and try again.",
    );
  onApplyAttempt?.();
  const applied = await adapters.applyRules({
    base_revision: baseRevision,
    operations,
    digest: preview.data.digest,
    etag: current.versions.policy,
    signal,
  });
  const appliedRevision = policyRevisionFor(applied.etag);
  if (isRejected(appliedRevision)) return appliedRevision;
  const changedRules =
    applied.data.counts.created +
      applied.data.counts.updated +
      applied.data.counts.deleted >
    0;
  const expectedRevision = baseRevision + (changedRules ? 1 : 0);
  if (
    applied.data.base_revision !== baseRevision ||
    applied.data.current_revision !== appliedRevision ||
    appliedRevision !== expectedRevision ||
    applied.data.digest !== preview.data.digest ||
    !samePolicyBatchCounts(applied.data.counts, preview.data.counts)
  )
    return rejected(
      "Policy change confirmation is inconsistent. Reload Access and try again.",
    );
  return accepted("Policy rules applied.");
}

function samePolicyBatchCounts(
  left: AccessPolicyRuleBatchApply["counts"],
  right: AccessPolicyRuleBatchApply["counts"],
): boolean {
  return (
    left.created === right.created &&
    left.updated === right.updated &&
    left.deleted === right.deleted &&
    left.unchanged === right.unchanged
  );
}

export async function executeAuthoritativeAccessCommand(
  current: AuthoritativeAccessSnapshot,
  command: AccessCommand,
  adapters: AuthoritativeAccessCommandAdapters = authoritativeAccessCommandAdapters,
  signal?: AbortSignal,
  onPolicyApplyAttempt?: () => void,
): Promise<ControllerMutationResult> {
  switch (command.type) {
    case "create-identity": {
      const { input } = command;
      if (input.id)
        return rejected("Client-provided identity IDs are not supported.");
      if (input.kind === "service") {
        if (input.groupIds.length)
          return rejected("Service identities cannot join groups.");
        if (input.status !== "active" && input.status !== "disabled")
          return rejected("Service identities must be active or disabled.");
        await adapters.createService({
          name: input.name,
          purpose: input.purpose,
          owner_id: input.ownerId,
          role_id: input.roleId,
          expires_at: input.expiresAt,
          status: input.status,
          signal,
        });
        return accepted("Service identity created.");
      }
      if (input.status !== "pending")
        return rejected("New invitations must start pending acceptance.");
      if (!sameIds(input.groupIds, current.snapshot.defaults.defaultGroupIds))
        return rejected(
          "New identities use the configured default groups. Change membership after invitation.",
        );
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const username = usernameForInvitation(input.email, attempt);
        if (!username) return rejected("Enter a valid email address.");
        try {
          await adapters.createUser({
            email: input.email,
            username,
            role_id: input.roleId,
            display_name: input.name,
            identity_kind: input.kind,
            ...(input.kind === "internal"
              ? {
                  job_title: input.title,
                  department_ids: input.departmentIds,
                  primary_department_id: input.primaryDepartmentId || null,
                  ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
                }
              : {
                  sponsor_user_id: input.sponsorId,
                  expires_at: input.expiresAt,
                }),
            signal,
          });
          return accepted("Invitation created.");
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error;
        }
      }
      return rejected(
        "This email may already have an invitation. Check People, then try again if needed.",
      );
    }
    case "update-identity": {
      const identity = identityFor(current, command.identityId);
      if (!identity)
        return rejected(
          "This identity is unavailable. Reload Access and try again.",
        );
      if (identity.kind === "service") {
        const etag = versionFor(
          current.versions.services,
          identity.id,
          "Service identity",
        );
        if (isFailure(etag)) return etag;
        const patch = servicePatchFor(command.patch);
        if ("ok" in patch) return patch;
        await adapters.updateService(identity.id, { ...patch, etag, signal });
      } else {
        const patch = userPatchFor(command.patch);
        if ("ok" in patch) return patch;
        await adapters.updateUser(identity.id, { ...patch, signal });
      }
      return accepted("Identity updated.");
    }
    case "set-identity-status":
      return executeAuthoritativeAccessCommand(
        current,
        {
          type: "update-identity",
          identityId: command.identityId,
          patch: { status: command.status },
        },
        adapters,
        signal,
      );
    case "resend-invite": {
      const identity = identityFor(current, command.identityId);
      if (!identity || identity.kind === "service")
        return rejected(
          "This invitation is unavailable. Reload Access and try again.",
        );
      if (identity.status !== "pending" && identity.status !== "revoked")
        return rejected("Only pending invitations can be resent.");
      await adapters.resendInvitation(identity.id, { signal });
      return accepted("Invitation resent by email.");
    }
    case "revoke-invite": {
      const identity = identityFor(current, command.identityId);
      if (!identity || identity.kind === "service")
        return rejected(
          "This invitation is unavailable. Reload Access and try again.",
        );
      if (identity.status !== "pending")
        return rejected("Only pending invitations can be revoked.");
      await adapters.revokeInvitation(identity.id, { signal });
      return accepted("Invitation revoked.");
    }
    case "delete-identity": {
      const identity = identityFor(current, command.identityId);
      if (!identity)
        return rejected(
          "This identity is unavailable. Reload Access and try again.",
        );
      if (identity.kind === "service") {
        const etag = versionFor(
          current.versions.services,
          identity.id,
          "Service identity",
        );
        if (isFailure(etag)) return etag;
        await adapters.deleteService(identity.id, { etag, signal });
      } else await adapters.deleteUser(identity.id, { signal });
      return accepted("Identity deleted.");
    }
    case "restore-identity":
      return rejected(
        "Deleted identities are not available in this directory yet.",
      );
    case "revoke-session": {
      const identity = identityFor(current, command.identityId);
      if (!identity || identity.kind === "service")
        return rejected(
          "This identity is unavailable. Reload Access and try again.",
        );
      await adapters.revokeSession(identity.id, command.sessionId, { signal });
      return accepted("Session revoked.");
    }
    case "revoke-all-sessions": {
      const identity = identityFor(current, command.identityId);
      if (!identity || identity.kind === "service")
        return rejected(
          "This identity is unavailable. Reload Access and try again.",
        );
      await adapters.revokeAllSessions(identity.id, { signal });
      return accepted("Sessions revoked.");
    }
    case "create-role": {
      if (command.input.id)
        return rejected("Client-provided role IDs are not supported.");
      const permissions = capabilityPermissions(command.input.grants ?? []);
      if (!permissions)
        return rejected(
          "This role includes permissions that the server does not support.",
        );
      await adapters.createRole({
        role: command.input.name,
        ...(command.input.description
          ? { description: command.input.description }
          : {}),
        permissions,
        signal,
      });
      return accepted("Role created.");
    }
    case "update-role": {
      if (!current.snapshot.roles.some((role) => role.id === command.roleId))
        return rejected(
          "This role is unavailable. Reload Access and try again.",
        );
      const patch: AccessRolePatch = {};
      if ("name" in command.patch && command.patch.name)
        patch.role = command.patch.name;
      if ("description" in command.patch)
        patch.description = command.patch.description?.trim() || null;
      if ("grants" in command.patch) {
        const permissions = capabilityPermissions(command.patch.grants ?? []);
        if (!permissions)
          return rejected(
            "This role includes permissions that the server does not support.",
          );
        patch.permissions = permissions;
      }
      if (!Object.keys(patch).length)
        return rejected("No supported changes were supplied.");
      await adapters.updateRole(command.roleId, { ...patch, signal });
      return accepted("Role updated.");
    }
    case "duplicate-role": {
      if (!current.snapshot.roles.some((role) => role.id === command.roleId))
        return rejected(
          "This role is unavailable. Reload Access and try again.",
        );
      const source = await adapters.getRole(command.roleId, { signal });
      await adapters.createRole({
        role: command.name ?? `${source.role} copy`,
        ...(source.description ? { description: source.description } : {}),
        permissions: source.permissions,
        signal,
      });
      return accepted("Role duplicated.");
    }
    case "delete-role":
      if (!current.snapshot.roles.some((role) => role.id === command.roleId))
        return rejected(
          "This role is unavailable. Reload Access and try again.",
        );
      await adapters.deleteRole(command.roleId, { signal });
      return accepted("Role deleted.");
    case "create-group":
      if (command.input.id)
        return rejected("Client-provided group IDs are not supported.");
      await adapters.createGroup({
        name: command.input.name,
        description: command.input.description ?? "",
        member_ids: command.input.memberIds ?? [],
        signal,
      });
      return accepted("Group created.");
    case "update-group": {
      if (
        !current.snapshot.groups.some((group) => group.id === command.groupId)
      )
        return rejected(
          "This group is unavailable. Reload Access and try again.",
        );
      const etag = versionFor(
        current.versions.groups,
        command.groupId,
        "Group",
      );
      if (isFailure(etag)) return etag;
      const patch: AccessGroupPatch = {};
      if ("name" in command.patch && command.patch.name)
        patch.name = command.patch.name;
      if (
        "description" in command.patch &&
        command.patch.description !== undefined
      )
        patch.description = command.patch.description;
      if ("memberIds" in command.patch && command.patch.memberIds)
        patch.member_ids = command.patch.memberIds;
      if (!Object.keys(patch).length)
        return rejected("No supported changes were supplied.");
      await adapters.updateGroup(command.groupId, { ...patch, etag, signal });
      return accepted("Group updated.");
    }
    case "set-group-members": {
      if (
        !current.snapshot.groups.some((group) => group.id === command.groupId)
      )
        return rejected(
          "This group is unavailable. Reload Access and try again.",
        );
      const etag = versionFor(
        current.versions.groups,
        command.groupId,
        "Group",
      );
      if (isFailure(etag)) return etag;
      await adapters.updateGroup(command.groupId, {
        member_ids: command.memberIds,
        etag,
        signal,
      });
      return accepted("Group members updated.");
    }
    case "delete-group": {
      if (
        !current.snapshot.groups.some((group) => group.id === command.groupId)
      )
        return rejected(
          "This group is unavailable. Reload Access and try again.",
        );
      const etag = versionFor(
        current.versions.groups,
        command.groupId,
        "Group",
      );
      if (isFailure(etag)) return etag;
      await adapters.deleteGroup(command.groupId, { etag, signal });
      return accepted("Group deleted.");
    }
    case "update-defaults": {
      const etag = current.versions.defaults;
      if (!etag)
        return rejected(
          "Access defaults version is unavailable. Reload Access and try again.",
        );
      const patch: AccessDefaultsPatch = {};
      if ("defaultRoleId" in command.patch && command.patch.defaultRoleId)
        patch.default_role_id = command.patch.defaultRoleId;
      if ("defaultGroupIds" in command.patch)
        patch.group_ids = command.patch.defaultGroupIds;
      if ("defaultDepartmentIds" in command.patch)
        patch.department_ids = command.patch.defaultDepartmentIds;
      if ("invitationExpiryDays" in command.patch)
        patch.invitation_expiry_days = command.patch.invitationExpiryDays;
      if ("guestDurationDays" in command.patch)
        patch.guest_duration_days = command.patch.guestDurationDays;
      if ("serviceDurationDays" in command.patch)
        patch.service_duration_days = command.patch.serviceDurationDays;
      if (!Object.keys(patch).length)
        return rejected("No supported changes were supplied.");
      await adapters.updateDefaults({ ...patch, etag, signal });
      return accepted("Access defaults updated.");
    }
    case "upsert-rule": {
      const operations = ruleOperationsFor(current, [command.rule]);
      if (isRejected(operations)) return operations;
      return applyAuthoritativeRuleOperations(
        current,
        operations,
        adapters,
        signal,
        onPolicyApplyAttempt,
      );
    }
    case "upsert-rules": {
      const operations = ruleOperationsFor(current, command.rules);
      if (isRejected(operations)) return operations;
      return applyAuthoritativeRuleOperations(
        current,
        operations,
        adapters,
        signal,
        onPolicyApplyAttempt,
      );
    }
    case "delete-rule": {
      const operations = deleteRuleOperationFor(current, command.ruleId);
      if (isRejected(operations)) return operations;
      return applyAuthoritativeRuleOperations(
        current,
        operations,
        adapters,
        signal,
        onPolicyApplyAttempt,
      );
    }
    case "bulk-update-identities":
      return rejected("Bulk identity updates are not available yet.");
    case "apply-role-template":
      return rejected("Role templates are not available yet.");
    case "create-review-campaign":
    case "record-review-decision":
    case "complete-review":
      return rejected("Access reviews are not available yet.");
    case "apply-history-restore":
      return rejected("Access history restore is not available yet.");
    case "import-policy-bundle":
      return rejected("Policy import is not available yet.");
    default:
      return rejected("This Access action is not available yet.");
  }
}

export async function runAuthoritativeAccessCommand({
  current,
  command,
  adapters = authoritativeAccessCommandAdapters,
  reload,
  signal,
}: {
  current: AuthoritativeAccessSnapshot;
  command: AccessCommand;
  adapters?: AuthoritativeAccessCommandAdapters;
  reload: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<ControllerMutationResult> {
  let policyApplyAttempted = false;
  let result: ControllerMutationResult;
  try {
    result = await executeAuthoritativeAccessCommand(
      current,
      command,
      adapters,
      signal,
      () => {
        policyApplyAttempted = true;
      },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 412) {
      await reload();
      return rejected(
        "This Access item changed elsewhere. Refresh was requested; keep your draft open and compare it with the current details before saving again.",
      );
    }
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      command.type === "delete-group"
    ) {
      if (error.message.startsWith("Group has access rules"))
        return rejected(
          "Open Detailed rules to remove or retarget this group's rules before deleting it.",
        );
      if (error.message === "Group has members")
        return rejected("Remove this group's members before deleting it.");
      if (error.message === "Group is used by defaults")
        return rejected(
          "Remove this group from Access defaults before deleting it.",
        );
      return rejected(
        "This group cannot be deleted. Review its members, Access defaults, and Detailed rules, then try again.",
      );
    }
    if (!policyApplyAttempted) throw error;
    try {
      await reload();
      return rejected(
        "Policy change could not be confirmed. Access was refreshed; review the current rules before trying again.",
      );
    } catch {
      return rejected(
        "Policy change could not be confirmed. Refresh Access and review the current rules before trying again.",
      );
    }
  }

  if (policyApplyAttempted) {
    try {
      await reload();
    } catch {
      return rejected(
        result.ok
          ? "Policy change was accepted, but Access could not refresh. Refresh Access and review the current rules."
          : "Policy change could not be confirmed. Refresh Access and review the current rules before trying again.",
      );
    }
    return result.ok
      ? result
      : rejected(
          "Policy response could not be verified. Access was refreshed; review the current rules before trying again.",
        );
  }

  if (result.ok) await reload();
  return result;
}

export async function loadAccessControllerSnapshot(
  signal?: AbortSignal,
  load: (options?: {
    signal?: AbortSignal;
  }) => Promise<AuthoritativeAccessSnapshot> = loadAuthoritativeAccessSnapshot,
): Promise<AuthoritativeAccessSnapshot> {
  try {
    return await load({ signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 403)
      throw new SampleOperationError(
        "unavailable",
        "You do not have permission to view Access. Ask an administrator for access.",
      );
    throw error;
  }
}

function useAuthoritativeAccessResource() {
  const [resource] = useState(() =>
    createSampleResource<AuthoritativeAccessSnapshot>(),
  );
  const state = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  );
  const reload = useCallback(
    () => resource.load((signal) => loadAccessControllerSnapshot(signal), true),
    [resource],
  );
  useEffect(() => {
    void reload();
    return () => resource.cancel();
  }, [reload, resource]);
  return { ...state, reload };
}

export function useAccessController() {
  const resource = useAuthoritativeAccessResource();
  const [commands] = useState(createSampleCommands);
  const pendingKeys = useSyncExternalStore(
    commands.subscribe,
    commands.getSnapshot,
    commands.getSnapshot,
  );
  useEffect(() => () => commands.cancel(), [commands]);
  const sessionAbort = useRef<AbortController | null>(null);
  const [sessionResource, setSessionResource] = useState<LazySessionState>({
    status: "idle",
    identityId: null,
    sessions: [],
    error: null,
  });
  const projection = resource.data;
  const current = projection ?? {
    snapshot: EMPTY_ACCESS_SNAPSHOT,
    versions: {
      defaults: "",
      groups: {},
      services: {},
      policy: "",
      ruleSubjectKinds: {},
    },
    capabilities: [],
    departments: [],
  };
  const currentSnapshot = current.snapshot;
  const adminRoleId = getAuthoritativeAdminRoleId(currentSnapshot);

  const loadSessions = useCallback(async (identityId: string) => {
    sessionAbort.current?.abort();
    const request = new AbortController();
    sessionAbort.current = request;
    setSessionResource({
      status: "loading",
      identityId,
      sessions: [],
      error: null,
    });
    try {
      const sessions = await loadAllAccessUserSessions(
        identityId,
        listAccessUserSessions,
        request.signal,
      );
      if (!request.signal.aborted && sessionAbort.current === request)
        setSessionResource({
          status: "ready",
          identityId,
          sessions: mapAccessSessions(identityId, sessions),
          error: null,
        });
    } catch (error) {
      if (!request.signal.aborted && sessionAbort.current === request)
        setSessionResource({
          status: "error",
          identityId,
          sessions: [],
          error:
            error instanceof Error
              ? error.message
              : "Could not load sessions. Try again.",
        });
    }
  }, []);
  useEffect(() => () => sessionAbort.current?.abort(), []);

  async function run(
    command: AccessCommand,
  ): Promise<ControllerMutationResult> {
    if (!projection)
      return rejected(
        "Access data is still loading. Try again when it is ready.",
      );
    try {
      return await commands.run(commandKey(command), (signal) =>
        runAuthoritativeAccessCommand({
          current: projection,
          command,
          reload: resource.reload,
          signal,
        }),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 403)
        return rejected(
          "You do not have permission for this Access change. Ask an administrator if you need it.",
        );
      return rejected(
        sampleOperationMessage(
          error,
          "Could not apply this Access change. Try again.",
        ),
      );
    }
  }

  const state = {
    ...currentSnapshot,
    identities: authoritativeIdentities(currentSnapshot),
    sessions: sessionResource.sessions,
    health: getAccessHealth(currentSnapshot, new Date().toISOString(), {
      adminRoleId,
      knownPermissionIds: current.capabilities.map(
        (capability) => capability.id,
      ),
    }),
  };
  const actions = {
    createIdentity: (input: CreateIdentityInput) =>
      run({ type: "create-identity", input }),
    updateIdentity: (identityId: string, patch: UpdateIdentityPatch) =>
      run({ type: "update-identity", identityId, patch }),
    setIdentityStatus: (identityId: string, status: AccessIdentityStatus) =>
      run({ type: "set-identity-status", identityId, status }),
    resendInvite: (identityId: string) =>
      run({ type: "resend-invite", identityId }),
    revokeInvite: (identityId: string) =>
      run({ type: "revoke-invite", identityId }),
    disableIdentity: (identityId: string) =>
      run({ type: "set-identity-status", identityId, status: "disabled" }),
    restoreIdentity: (identityId: string) =>
      run({ type: "restore-identity", identityId }),
    deleteIdentity: (identityId: string) =>
      run({ type: "delete-identity", identityId }),
    revokeSession: async (identityId: string, sessionId: string) => {
      const result = await run({
        type: "revoke-session",
        identityId,
        sessionId,
      });
      if (result.ok) await loadSessions(identityId);
      return result;
    },
    revokeAllSessions: async (identityId: string) => {
      const result = await run({ type: "revoke-all-sessions", identityId });
      if (result.ok) await loadSessions(identityId);
      return result;
    },
    previewBulkIdentityUpdate: (
      input: BulkIdentityUpdateInput,
    ): BulkIdentityImpact => previewBulkIdentityUpdate(currentSnapshot, input),
    bulkUpdateIdentities: (input: BulkIdentityUpdateInput) =>
      run({ type: "bulk-update-identities", input }),
    createRole: (input: CreateRoleInput) => run({ type: "create-role", input }),
    updateRole: (roleId: string, patch: UpdateRolePatch, expected?: Role) =>
      run({ type: "update-role", roleId, patch, expected }),
    duplicateRole: (roleId: string, name?: string) =>
      run({ type: "duplicate-role", roleId, name }),
    deleteRole: (roleId: string) => run({ type: "delete-role", roleId }),
    applyRoleTemplate: (roleId: string, templateId: string) =>
      run({ type: "apply-role-template", roleId, templateId }),
    createGroup: (input: CreateGroupInput) =>
      run({ type: "create-group", input }),
    updateGroup: (
      groupId: string,
      patch: Partial<Pick<AccessGroup, "name" | "description" | "memberIds">>,
      expected?: AccessGroup,
    ) => run({ type: "update-group", groupId, patch, expected }),
    deleteGroup: (groupId: string) => run({ type: "delete-group", groupId }),
    setGroupMembers: (groupId: string, memberIds: string[]) =>
      run({ type: "set-group-members", groupId, memberIds }),
    upsertRule: (rule: AccessRule) => run({ type: "upsert-rule", rule }),
    upsertRules: (rules: AccessRule[]) => run({ type: "upsert-rules", rules }),
    deleteRule: (ruleId: string) => run({ type: "delete-rule", ruleId }),
    checkAccess: (
      identityId: string,
      permissionId: string,
      signal?: AbortSignal,
    ) =>
      checkAuthoritativeAccess({
        current,
        identityId,
        permissionId,
        signal,
      }),
    updateDefaults: (patch: Partial<AccessDefaults>) =>
      run({ type: "update-defaults", patch }),
    createReviewCampaign: (input: CreateReviewCampaignInput) =>
      run({ type: "create-review-campaign", input }),
    recordReviewDecision: (
      reviewId: string,
      targetId: string,
      decision: "keep" | "change" | "revoke",
    ) => run({ type: "record-review-decision", reviewId, targetId, decision }),
    completeReview: (reviewId: string) =>
      run({ type: "complete-review", reviewId }),
    previewHistoryRestore: (historyId: string) =>
      previewHistoryRestore(currentSnapshot, historyId),
    applyHistoryRestore: (historyId: string) =>
      run({ type: "apply-history-restore", historyId }),
    exportPolicyBundle: (): string =>
      JSON.stringify(createPolicyBundle(currentSnapshot), null, 2),
    parsePolicyImport: (text: string): ReturnType<typeof parsePolicyBundle> =>
      parsePolicyBundle(text),
    importPolicyBundle: (text: string, mode: "merge" | "replace") =>
      run({ type: "import-policy-bundle", text, mode }),
  };

  return {
    state,
    actions,
    isPending: commands.isPending,
    pendingKeys,
    resource,
    permissionCatalog: mapAuthoritativePermissionCatalog(current.capabilities),
    departmentCatalog: current.departments.map((department) => ({
      id: department.id,
      name: department.department_name,
    })),
    adminRoleId,
    availability: {
      bulkIdentityUpdates: false,
      invitationRevocation: true,
      rules: true,
      simulator: true,
      reviews: false,
      policyImportExport: false,
      historyRestore: false,
    },
    sessionResource: { ...sessionResource, load: loadSessions },
    scopeCatalog: mapAuthoritativeScopeCatalog(),
  };
}

export type AccessController = ReturnType<typeof useAccessController>;
export type AccessControllerState = AccessController["state"];
export type AccessControllerActions = AccessController["actions"];
export type PolicyImportParseResult = ReturnType<typeof parsePolicyBundle>;
export type PolicyBundle = AccessPolicyBundleV1;
