"use client";

import { useSampleState, useSampleTransaction } from "../sample-state";
import { initialPeople, initialRoles } from "./model";
import {
  createPolicyBundle,
  parsePolicyBundle,
  type AccessPolicyBundleV1,
} from "./policy-bundle";
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
  type AccessGroup,
  type AccessIdentityStatus,
  type AccessReview,
  type AccessRule,
} from "./policy";
import {
  adaptManageSessions,
  getAccessHealth,
  getControllerIdentities,
  permissionCatalog,
  previewBulkIdentityUpdate,
  previewHistoryRestore,
  projectManageSessions,
  resolveControllerAccess,
  scopeCatalog as coreScopeCatalog,
  type AccessCommand,
  type AccessCommandResult,
  type AccessControllerSnapshot,
  type BulkIdentityImpact,
  type BulkIdentityUpdateInput,
  type ControllerHistoryEntry,
  type CreateGroupInput,
  type CreateIdentityInput,
  type CreateReviewCampaignInput,
  type CreateRoleInput,
  type DeletedInternalIdentity,
  type ManagedGuestIdentity,
  type ResolveAccessInput,
  type UpdateIdentityPatch,
  type UpdateRolePatch,
} from "./controller-utils";
import { initialManageSessions, type ManageSession } from "../manage/sessions";
import { initialBoards, type SampleBoard } from "../boards";
import { initialSavedViews, normalizeSavedViews } from "../openview";
import {
  initialDashboards,
  initialReport,
  initialReportTemplates,
  normalizeReports,
  type Dashboard,
  type Report,
} from "../openview/analytics";
import {
  CATEGORIES,
  CHANNELS,
  type Category,
  type Channel,
} from "../comms/model";
import { normalizeCommsConfiguration } from "../comms/configuration";
import {
  executeFederatedAccessCommand,
  getFederatedAccess,
  type FederatedAccessOwners,
} from "./federated-adapters";

export {
  permissionCatalog,
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
  type ResolveAccessInput,
  type ScopeCatalogEntry,
  type UpdateIdentityPatch,
  type UpdateRolePatch,
} from "./controller-utils";

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
export type ControllerMutationResult =
  | {
      ok: true;
      summary: string;
      value?: Extract<AccessCommandResult, { ok: true }>["value"];
    }
  | { ok: false; error: string };

function publicResult(result: AccessCommandResult): ControllerMutationResult {
  if (!result.ok) return result;
  return {
    ok: true,
    summary: result.summary,
    ...(result.value ? { value: result.value } : {}),
  };
}

export function useAccessController() {
  const [people] = useSampleState("access-people", initialPeople);
  const [roles] = useSampleState("access-roles", initialRoles);
  const [guestSlice] = useSampleState<VersionedItems<ManagedGuestIdentity>>(
    "access-guests-v1",
    { version: 1, items: initialGuests },
  );
  const [serviceSlice] = useSampleState<
    VersionedItems<(typeof initialServices)[number]>
  >("access-services-v1", { version: 1, items: initialServices });
  const [groupSlice] = useSampleState<VersionedItems<AccessGroup>>(
    "access-groups-v1",
    { version: 1, items: initialAccessGroups },
  );
  const [ruleSlice] = useSampleState<VersionedItems<AccessRule>>(
    "access-rules-v1",
    { version: 1, items: initialAccessRules },
  );
  const [defaultSlice] = useSampleState<VersionedValue<AccessDefaults>>(
    "access-defaults-v1",
    { version: 1, value: initialAccessDefaults },
  );
  const [templateSlice] = useSampleState("access-templates-v1", {
    version: 1 as const,
    items: initialAccessTemplates,
  });
  const [reviewSlice] = useSampleState<VersionedItems<AccessReview>>(
    "access-reviews-v1",
    { version: 1, items: initialAccessReviews },
  );
  const [deletedSlice] = useSampleState<
    VersionedItems<DeletedInternalIdentity>
  >("access-deleted-identities-v1", {
    version: 1,
    items: initialDeletedAccessIdentities.map((item) => ({
      ...item,
      person:
        initialPeople.find((person) => person.id === item.identity.id) ??
        initialPeople[0],
    })),
  });
  const [manageSessions] = useSampleState<ManageSession[]>(
    "manage-sessions",
    initialManageSessions,
  );
  const [historySlice] = useSampleState<VersionedItems<ControllerHistoryEntry>>(
    "access-history-v1",
    { version: 1, items: initialAccessHistory },
  );
  const [boards] = useSampleState<SampleBoard[]>("boards-list", initialBoards);
  const [rawSavedViews] = useSampleState<unknown>(
    "views-saved",
    initialSavedViews,
  );
  const [dashboards] = useSampleState<Dashboard[]>(
    "views-dashboards",
    initialDashboards,
  );
  const [reportDraft] = useSampleState<Report>(
    "views-report-draft",
    initialReport,
  );
  const [rawReportTemplates] = useSampleState<unknown>(
    "views-report-templates",
    initialReportTemplates,
  );
  const [rawCommsConfiguration] = useSampleState<unknown>(
    "comms-configuration",
    null,
  );
  const [commsCategories] = useSampleState<Category[]>(
    "commsCategories",
    CATEGORIES,
  );
  const [commsChannels] = useSampleState<Channel[]>("commsChannels", CHANNELS);
  const transact = useSampleTransaction();

  const owners: FederatedAccessOwners = {
    boards,
    savedViews: normalizeSavedViews(rawSavedViews),
    dashboards,
    reportDraft,
    reportTemplates: normalizeReports(rawReportTemplates),
    commsConfiguration: normalizeCommsConfiguration(rawCommsConfiguration),
    commsCategories,
    commsChannels,
  };
  const federated = getFederatedAccess(owners, roles);

  const snapshot: AccessControllerSnapshot = {
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
  };

  function run(command: AccessCommand): ControllerMutationResult {
    const result = executeFederatedAccessCommand(snapshot, owners, command, {
      now: new Date().toISOString(),
      id: (prefix) => `${prefix}:${crypto.randomUUID()}`,
    });
    if (!result.ok) return result;
    const next = result.state;
    transact(({ update }) => {
      update("access-people", initialPeople, next.people);
      update("access-roles", initialRoles, next.roles);
      update(
        "access-guests-v1",
        { version: 1 as const, items: initialGuests },
        { version: 1, items: next.guests },
      );
      update(
        "access-services-v1",
        { version: 1 as const, items: initialServices },
        { version: 1, items: next.services },
      );
      update(
        "access-groups-v1",
        { version: 1 as const, items: initialAccessGroups },
        { version: 1, items: next.groups },
      );
      update(
        "access-rules-v1",
        { version: 1 as const, items: initialAccessRules },
        { version: 1, items: next.rules },
      );
      update("boards-list", initialBoards, result.owners.boards);
      update("views-saved", initialSavedViews, result.owners.savedViews);
      update("views-dashboards", initialDashboards, result.owners.dashboards);
      update("views-report-draft", initialReport, result.owners.reportDraft);
      update(
        "views-report-templates",
        initialReportTemplates,
        result.owners.reportTemplates,
      );
      update<unknown>(
        "comms-configuration",
        null,
        result.owners.commsConfiguration,
      );
      update(
        "access-defaults-v1",
        { version: 1 as const, value: initialAccessDefaults },
        { version: 1, value: next.defaults },
      );
      update(
        "access-templates-v1",
        { version: 1 as const, items: initialAccessTemplates },
        { version: 1, items: next.templates },
      );
      update(
        "access-reviews-v1",
        { version: 1 as const, items: initialAccessReviews },
        { version: 1, items: next.reviews },
      );
      update(
        "access-deleted-identities-v1",
        { version: 1 as const, items: [] as DeletedInternalIdentity[] },
        { version: 1, items: next.deletedIdentities },
      );
      update(
        "manage-sessions",
        initialManageSessions,
        projectManageSessions(next.sessions, manageSessions),
      );
      update(
        "access-history-v1",
        { version: 1 as const, items: [] as ControllerHistoryEntry[] },
        { version: 1, items: next.history },
      );
    });
    return publicResult(result);
  }

  const state = {
    ...snapshot,
    identities: getControllerIdentities(snapshot),
    health: [
      ...getAccessHealth(snapshot, new Date().toISOString()),
      ...federated.findings,
    ],
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
    revokeSession: (identityId: string, sessionId: string) =>
      run({ type: "revoke-session", identityId, sessionId }),
    revokeAllSessions: (identityId: string) =>
      run({ type: "revoke-all-sessions", identityId }),
    previewBulkIdentityUpdate: (
      input: BulkIdentityUpdateInput,
    ): BulkIdentityImpact => previewBulkIdentityUpdate(snapshot, input),
    bulkUpdateIdentities: (input: BulkIdentityUpdateInput) =>
      run({ type: "bulk-update-identities", input }),
    createRole: (input: CreateRoleInput) => run({ type: "create-role", input }),
    updateRole: (roleId: string, patch: UpdateRolePatch) =>
      run({ type: "update-role", roleId, patch }),
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
    ) => run({ type: "update-group", groupId, patch }),
    deleteGroup: (groupId: string) => run({ type: "delete-group", groupId }),
    setGroupMembers: (groupId: string, memberIds: string[]) =>
      run({ type: "set-group-members", groupId, memberIds }),
    upsertRule: (rule: AccessRule) => run({ type: "upsert-rule", rule }),
    upsertRules: (rules: AccessRule[]) => run({ type: "upsert-rules", rules }),
    deleteRule: (ruleId: string) => run({ type: "delete-rule", ruleId }),
    resolveAccess: (input: ResolveAccessInput) =>
      resolveControllerAccess(snapshot, input),
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
      previewHistoryRestore(snapshot, historyId),
    applyHistoryRestore: (historyId: string) =>
      run({ type: "apply-history-restore", historyId }),
    exportPolicyBundle: (): string =>
      JSON.stringify(createPolicyBundle(snapshot), null, 2),
    parsePolicyImport: (text: string): ReturnType<typeof parsePolicyBundle> =>
      parsePolicyBundle(text),
    importPolicyBundle: (text: string, mode: "merge" | "replace") =>
      run({ type: "import-policy-bundle", text, mode }),
  };

  return {
    state,
    actions,
    permissionCatalog,
    scopeCatalog: [...coreScopeCatalog, ...federated.scopes],
  };
}

export type AccessController = ReturnType<typeof useAccessController>;
export type AccessControllerState = AccessController["state"];
export type AccessControllerActions = AccessController["actions"];
export type PolicyImportParseResult = ReturnType<typeof parsePolicyBundle>;
export type PolicyBundle = AccessPolicyBundleV1;
