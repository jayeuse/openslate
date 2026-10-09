"use client";

import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { accessKeys } from "../../access/adapters/access-queries";

import {
  getManageWorkspace,
  getWorkspaceBrand,
  workspaceBrand,
  type WorkspaceBrand,
  type ManageWorkspaceProfile,
} from "./workspace-api";
import {
  getWorkspaceLogo,
  listWorkspaceLogoFiles,
  type WorkspaceLogoListInput,
} from "./workspace-logo-api";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";
import { ApiContractError, ApiError } from "@/lib/api";
import {
  listManageJobs,
  type ManageJobsRequest,
  type ManageJobIdentity,
} from "./jobs-api";
import {
  getManageAuditLog,
  getManageAuditOptions,
  getManageAuditExportPreview,
  listManageAuditLogs,
  type ManageAuditListRequest,
} from "./audit-api";
import {
  getManageBackupStatus,
  getManageBackupExport,
  getManageVersion,
  listManageBackups,
  type ManageBackupsRequest,
  type ManageBackupStatus,
} from "./backup-api";

// Keep an audit refusal through section remounts for this verified account.
// Query clients are replaced at the account boundary and are never persisted.
const auditDeniedClients = new WeakSet<QueryClient>();

export function isManageAuditDenied(client: QueryClient): boolean {
  return auditDeniedClients.has(client);
}

export function setManageAuditDenied(
  client: QueryClient,
  denied: boolean,
): void {
  if (denied) auditDeniedClients.add(client);
  else auditDeniedClients.delete(client);
}

export const manageKeys = {
  all: ["manage"] as const,
  workspace: () => ["manage", "workspace"] as const,
  brand: () => ["manage", "workspace-brand"] as const,
  logos: () => ["manage", "workspace-logo"] as const,
  logo: (id: string) => ["manage", "workspace-logo", id] as const,
  logoFiles: () => ["manage", "logo-files"] as const,
  logoFilePage: (input: WorkspaceLogoListInput) =>
    [
      "manage",
      "logo-files",
      {
        purpose: "workspace_logo",
        deleted: "include",
        sortBy: "created_at",
        sortOrder: "desc",
        ...input,
      },
    ] as const,
  auditLists: () => ["manage", "audit-logs", "list"] as const,
  audit: () => ["manage", "audit-logs"] as const,
  auditList: (request: ManageAuditListRequest) =>
    ["manage", "audit-logs", "list", request] as const,
  auditOptions: () => ["manage", "audit-logs", "options"] as const,
  auditDetail: (id: string) => ["manage", "audit-logs", "detail", id] as const,
  auditExport: (request: Omit<ManageAuditListRequest, "limit" | "offset">) =>
    ["manage", "audit-logs", "export", request] as const,
  jobs: () => ["manage", "jobs"] as const,
  jobsList: (request: ManageJobsRequest) =>
    ["manage", "jobs", request] as const,
  maintenance: () => ["manage", "maintenance"] as const,
  backupStatus: () => ["manage", "maintenance", "backup-status"] as const,
  backups: () => ["manage", "maintenance", "backups"] as const,
  backupList: (request: ManageBackupsRequest) =>
    ["manage", "maintenance", "backups", request] as const,
  backupExports: () => ["manage", "maintenance", "backup-exports"] as const,
  backupExport: (id: string) =>
    ["manage", "maintenance", "backup-exports", id] as const,
  version: () => ["manage", "maintenance", "version"] as const,
};

export const manageBackupStatusOptions = () =>
  queryOptions({
    queryKey: manageKeys.backupStatus(),
    queryFn: ({ signal }) => getManageBackupStatus(signal),
  });
export const manageBackupListOptions = (request: ManageBackupsRequest) =>
  queryOptions({
    queryKey: manageKeys.backupList(request),
    queryFn: ({ signal }) => listManageBackups(request, signal),
  });
export const manageVersionOptions = () =>
  queryOptions({
    queryKey: manageKeys.version(),
    queryFn: ({ signal }) => getManageVersion(signal),
  });
export const manageBackupExportOptions = (id: string) =>
  queryOptions({
    queryKey: manageKeys.backupExport(id),
    queryFn: ({ signal }) => getManageBackupExport(id, signal),
  });
export function afterManageBackupPolicyChange(
  client: QueryClient,
  status: ManageBackupStatus,
) {
  client.setQueryData(manageKeys.backupStatus(), status);
}
export function afterManageBackupQueue(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: manageKeys.backupStatus() }),
    client.invalidateQueries({ queryKey: manageKeys.backups() }),
  ]);
}

export const manageWorkspaceOptions = () =>
  queryOptions({
    queryKey: manageKeys.workspace(),
    queryFn: async ({ signal, client }) =>
      newestManageWorkspace(client, await getManageWorkspace(signal)),
  });

export function acceptedWorkspaceRevision(client: QueryClient): number {
  return Math.max(
    client.getQueryData<ManageWorkspaceProfile>(manageKeys.workspace())
      ?.revision ?? 0,
    client.getQueryData<WorkspaceBrand>(manageKeys.brand())?.revision ?? 0,
  );
}

/** A same-revision read still replaces the complete role-filtered payload. */
export function newestManageWorkspace(
  client: QueryClient,
  incoming: ManageWorkspaceProfile,
): ManageWorkspaceProfile {
  if (incoming.revision >= acceptedWorkspaceRevision(client)) return incoming;
  const current = client.getQueryData<ManageWorkspaceProfile>(
    manageKeys.workspace(),
  );
  if (current && current.revision >= acceptedWorkspaceRevision(client))
    return current;
  throw new ApiContractError();
}

export const workspaceBrandOptions = () =>
  queryOptions({
    queryKey: manageKeys.brand(),
    queryFn: async ({ signal, client }) => {
      const incoming = await getWorkspaceBrand(signal);
      if (incoming.revision >= acceptedWorkspaceRevision(client))
        return incoming;
      const current = client.getQueryData<WorkspaceBrand>(manageKeys.brand());
      if (current && current.revision >= acceptedWorkspaceRevision(client))
        return current;
      const workspace = client.getQueryData<ManageWorkspaceProfile>(
        manageKeys.workspace(),
      );
      if (workspace && workspace.revision >= acceptedWorkspaceRevision(client))
        return workspaceBrand(workspace);
      throw new ApiContractError();
    },
  });
export const workspaceLogoOptions = (id: string) =>
  queryOptions({
    queryKey: manageKeys.logo(id),
    queryFn: ({ signal }) => getWorkspaceLogo(id, signal),
    enabled: Boolean(id),
  });
export const workspaceLogoFilesOptions = (input: WorkspaceLogoListInput) =>
  queryOptions({
    queryKey: manageKeys.logoFilePage(input),
    queryFn: ({ signal }) => listWorkspaceLogoFiles(input, signal),
  });

/** Brand reads share the existing stream; an open settings draft is untouched. */
export function subscribeWorkspaceBrand(client: QueryClient) {
  const keys = [manageKeys.brand(), manageKeys.logos(), manageKeys.logoFiles()];
  const refresh = () => {
    const cold = keys
      .flatMap((queryKey) =>
        client.getQueryCache().findAll({ queryKey, fetchStatus: "fetching" }),
      )
      .filter((query) => query.state.data === undefined);
    void Promise.all(cold.map((query) => query.cancel({ revert: true }))).then(
      () =>
        Promise.all(
          keys.map((queryKey) => client.invalidateQueries({ queryKey })),
        ),
    );
  };
  const stop = subscribeWorkspaceInvalidations((event) => {
    if (
      event.type === "resync" ||
      event.entity === "workspace_profiles" ||
      event.entity === "files"
    )
      refresh();
  }, refresh);
  return () => {
    stop();
    for (const queryKey of keys)
      void client.invalidateQueries({ queryKey, refetchType: "none" });
  };
}

export function afterManageWorkspaceChange(
  client: QueryClient,
  workspace: ManageWorkspaceProfile,
): boolean {
  if (workspace.revision < acceptedWorkspaceRevision(client)) return false;
  client.setQueryData(manageKeys.workspace(), workspace);
  client.setQueryData(manageKeys.brand(), workspaceBrand(workspace));
  void client.invalidateQueries({ queryKey: manageKeys.logos() });
  void client.invalidateQueries({ queryKey: manageKeys.logoFiles() });
  void client.invalidateQueries({ queryKey: accessKeys.security() });
  return true;
}

/** Use from Manage navigation intent to fill the same account-scoped cache. */
export function prefetchManageWorkspace(client: QueryClient): Promise<void> {
  return client.prefetchQuery(manageWorkspaceOptions());
}

export const manageAuditListOptions = (request: ManageAuditListRequest) =>
  queryOptions({
    queryKey: manageKeys.auditList(request),
    queryFn: ({ signal }) => listManageAuditLogs(request, signal),
  });

export const manageAuditOptionsOptions = (search = "") =>
  queryOptions({
    queryKey: [...manageKeys.auditOptions(), search.trim()],
    queryFn: ({ signal }) => getManageAuditOptions(signal, search),
  });

export const manageAuditDetailOptions = (id: string) =>
  queryOptions({
    queryKey: manageKeys.auditDetail(id),
    queryFn: ({ signal }) => getManageAuditLog(id, signal),
    enabled: Boolean(id),
  });

export const manageAuditExportOptions = (
  request: Omit<ManageAuditListRequest, "limit" | "offset">,
) =>
  queryOptions({
    queryKey: manageKeys.auditExport(request),
    queryFn: ({ signal }) => getManageAuditExportPreview(request, signal),
  });

/** Use from Manage navigation intent to prefill the account-scoped list cache. */
export function prefetchManageAudit(client: QueryClient): Promise<void> {
  return Promise.all([
    client.prefetchQuery(
      manageAuditListOptions({ sortOrder: "desc", limit: 10, offset: 0 }),
    ),
    client.prefetchQuery(manageAuditOptionsOptions()),
  ]).then(() => undefined);
}

export type ManageJobsRecovery = ManageJobIdentity & {
  key?: string;
  readFirst: boolean;
  confirmed: boolean;
};
const jobsDeniedClients = new WeakSet<QueryClient>();
const jobsReadEpochs = new WeakMap<QueryClient, number>();
const jobsRecoveries = new WeakMap<QueryClient, ManageJobsRecovery>();
export const isManageJobsDenied = (client: QueryClient): boolean =>
  jobsDeniedClients.has(client);
export function fenceManageJobsReads(client: QueryClient): void {
  jobsReadEpochs.set(client, (jobsReadEpochs.get(client) ?? 0) + 1);
}
export function setManageJobsDenied(
  client: QueryClient,
  denied: boolean,
): void {
  if (denied) {
    jobsDeniedClients.add(client);
    fenceManageJobsReads(client);
  } else jobsDeniedClients.delete(client);
}
export const getManageJobsRecovery = (
  client: QueryClient,
): ManageJobsRecovery | null => jobsRecoveries.get(client) ?? null;
export function setManageJobsRecovery(
  client: QueryClient,
  recovery: ManageJobsRecovery | null,
): void {
  if (recovery) jobsRecoveries.set(client, recovery);
  else jobsRecoveries.delete(client);
}
export const manageJobsListOptions = (
  request: ManageJobsRequest,
  client: QueryClient,
) =>
  queryOptions({
    queryKey: manageKeys.jobsList(request),
    queryFn: async ({ signal }) => {
      const epoch = jobsReadEpochs.get(client) ?? 0;
      let result;
      try {
        result = await listManageJobs({ ...request, signal });
      } catch (error) {
        if (
          !signal.aborted &&
          epoch === (jobsReadEpochs.get(client) ?? 0) &&
          error instanceof ApiError &&
          error.status === 403
        )
          setManageJobsDenied(client, true);
        throw error;
      }
      if (signal.aborted || epoch !== (jobsReadEpochs.get(client) ?? 0))
        throw new DOMException("Jobs read was superseded", "AbortError");
      return result;
    },
    retry: false,
  });
export function prefetchManageJobs(client: QueryClient): Promise<void> {
  if (isManageJobsDenied(client)) return Promise.resolve();
  return client.prefetchQuery(
    manageJobsListOptions({ limit: 10, offset: 0 }, client),
  );
}
