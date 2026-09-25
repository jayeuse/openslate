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
import type { Role } from "../domain/model";
import {
  createPolicyBundle,
  parsePolicyBundle,
  type AccessPolicyBundleV1,
} from "../domain/policy-bundle";
import type {
  AccessDefaults,
  AccessGroup,
  AccessIdentityStatus,
  AccessRule,
} from "../domain/policy";
import { previewBulkIdentityUpdate } from "../domain/controller-commands";
import type {
  AccessCommand,
  BulkIdentityImpact,
  BulkIdentityUpdateInput,
  CreateGroupInput,
  CreateIdentityInput,
  CreateReviewCampaignInput,
  CreateRoleInput,
  UpdateIdentityPatch,
  UpdateRolePatch,
} from "../domain/controller-model";
import {
  getAccessHealth,
  previewHistoryRestore,
} from "../domain/controller-policy";
import {
  mapAuthoritativeScopeCatalog,
  type AuthoritativeAccessSnapshot,
} from "./authoritative";
import { listAccessUserSessions } from "./api";
import {
  EMPTY_ACCESS_SNAPSHOT,
  authoritativeIdentities,
  checkAuthoritativeAccess,
  getAuthoritativeAdminRoleId,
  loadAccessControllerSnapshot,
  loadAllAccessUserSessions,
  mapAccessSessions,
  mapAuthoritativePermissionCatalog,
  runAuthoritativeAccessCommand,
  type ControllerMutationResult,
  type LazySessionState,
} from "./authoritative-commands";

function rejected(error: string): ControllerMutationResult {
  return { ok: false, error };
}

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

export {
  ACCESS_OWNER_KEYS,
  readAccessProjection,
  readAccessRuntimeSnapshot,
  writeAccessProjection,
} from "./sample-projection";
export type { AccessReader, AccessRuntimeSnapshot } from "./sample-projection";
export {
  checkAuthoritativeAccess,
  executeAuthoritativeAccessCommand,
  getAuthoritativeAdminRoleId,
  loadAccessControllerSnapshot,
  loadAllAccessUserSessions,
  mapAuthoritativePermissionCatalog,
  runAuthoritativeAccessCommand,
} from "./authoritative-commands";
export type {
  AuthoritativeAccessCommandAdapters,
  ControllerMutationResult,
  LazySessionState,
} from "./authoritative-commands";

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
