"use client";

import {
  sampleOperationMessage,
  useSampleCommands,
  useSampleResource,
} from "../sample-async";
import { useState } from "react";
import { useSampleRuntime } from "../sample-state";
import type { SampleDraft, SampleRuntime } from "../sample-runtime";
import { departments, initialPeople, initialRoles, type Role } from "./model";
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
  type ResolveAccessInput,
  type ScopeCatalogEntry,
  type UpdateIdentityPatch,
  type UpdateRolePatch,
} from "./controller-utils";
import { initialManageSessions, type ManageSession } from "../manage/sessions";
import {
  decodeBoardAnnouncements,
  decodeBoards,
  INITIAL_ANNOUNCEMENTS as initialAnnouncements,
  INITIAL_BOARDS as initialBoards,
  type Announcement,
  type BoardAudienceLookup,
  type SampleBoard,
} from "../boards/model";
import {
  initialDashboards,
  initialReport,
  initialReportTemplates,
  initialSavedViews,
} from "../openview/seeds";
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
} from "../openview/model";
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

function publicResult(result: AccessCommandResult): ControllerMutationResult {
  if (!result.ok) return result;
  return {
    ok: true,
    summary: result.summary,
    ...(result.value ? { value: result.value } : {}),
  };
}

export function useAccessController() {
  const runtime = useSampleRuntime();
  const resource = useSampleResource<AccessRuntimeSnapshot>({
    keys: ACCESS_OWNER_KEYS,
    queryKey: "access:projection:v1",
    load: (signal) =>
      runtime.load((source) => readAccessProjection(source.read), {
        keys: ACCESS_OWNER_KEYS,
        signal,
      }),
  });
  const [initialProjection] = useState(() =>
    readAccessRuntimeSnapshot(runtime),
  );
  const commands = useSampleCommands();
  const projection = resource.data ?? initialProjection;
  const currentSnapshot = projection.snapshot;

  async function run(
    command: AccessCommand,
  ): Promise<ControllerMutationResult> {
    try {
      return await commands.run(commandKey(command), (signal) =>
        runtime.execute<ControllerMutationResult>(
          (draft) => {
            const current = readAccessProjection(draft.read);
            const result = executeFederatedAccessCommand(
              current.snapshot,
              current.owners,
              command,
              {
                now: new Date().toISOString(),
                id: (prefix) => `${prefix}:${crypto.randomUUID()}`,
              },
            );
            if (!result.ok) return draft.reject(publicResult(result));
            writeAccessProjection(
              draft,
              result.state,
              result.owners,
              current.manageSessions,
            );
            return publicResult(result);
          },
          { keys: ACCESS_OWNER_KEYS, signal },
        ),
      );
    } catch (error) {
      return {
        ok: false,
        error: sampleOperationMessage(
          error,
          "Could not apply this Access change. Try again.",
        ),
      };
    }
  }

  const state = {
    ...currentSnapshot,
    identities: getControllerIdentities(currentSnapshot),
    health: [
      ...getAccessHealth(currentSnapshot, new Date().toISOString()),
      ...projection.federatedFindings,
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
    resolveAccess: (input: ResolveAccessInput) =>
      resolveControllerAccess(currentSnapshot, input),
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
    pendingKeys: commands.pendingKeys,
    resource,
    // Boards owns its content state, while Access remains the policy owner.
    // Expose the current federated owners so Boards can re-project its latest
    // typed visibility without duplicating Access' resolver or write rules.
    owners: projection.owners,
    permissionCatalog,
    scopeCatalog: [
      ...coreScopeCatalog,
      ...(currentSnapshot.federatedScopes ?? []),
    ] as ScopeCatalogEntry[],
  };
}

export type AccessController = ReturnType<typeof useAccessController>;
export type AccessControllerState = AccessController["state"];
export type AccessControllerActions = AccessController["actions"];
export type PolicyImportParseResult = ReturnType<typeof parsePolicyBundle>;
export type PolicyBundle = AccessPolicyBundleV1;
