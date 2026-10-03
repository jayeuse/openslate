"use client";

import { queryOptions, type QueryClient } from "@tanstack/react-query";

import {
  getManageWorkspace,
  type ManageWorkspaceProfile,
} from "./workspace-api";
import {
  getManageAuditLog,
  getManageAuditOptions,
  getManageAuditExportPreview,
  listManageAuditLogs,
  type ManageAuditListRequest,
} from "./audit-api";
import {
  getManageSecurityPolicy,
  listManageSessions,
  type ManageSecurityPolicy,
  type ManageSessionsRequest,
} from "./security-api";
import {
  getManageBackupStatus,
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
  security: () => ["manage", "security"] as const,
  sessions: () => ["manage", "sessions"] as const,
  sessionList: (request: ManageSessionsRequest) =>
    ["manage", "sessions", request] as const,
  auditLists: () => ["manage", "audit-logs", "list"] as const,
  audit: () => ["manage", "audit-logs"] as const,
  auditList: (request: ManageAuditListRequest) =>
    ["manage", "audit-logs", "list", request] as const,
  auditOptions: () => ["manage", "audit-logs", "options"] as const,
  auditDetail: (id: string) => ["manage", "audit-logs", "detail", id] as const,
  auditExport: (request: Omit<ManageAuditListRequest, "limit" | "offset">) =>
    ["manage", "audit-logs", "export", request] as const,
  maintenance: () => ["manage", "maintenance"] as const,
  backupStatus: () => ["manage", "maintenance", "backup-status"] as const,
  backups: () => ["manage", "maintenance", "backups"] as const,
  backupList: (request: ManageBackupsRequest) =>
    ["manage", "maintenance", "backups", request] as const,
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
    queryFn: ({ signal }) => getManageWorkspace(signal),
  });

export function afterManageWorkspaceChange(
  client: QueryClient,
  workspace: ManageWorkspaceProfile,
): void {
  client.setQueryData(manageKeys.workspace(), workspace);
  void client.invalidateQueries({ queryKey: manageKeys.security() });
}

export const manageSecurityOptions = () =>
  queryOptions({
    queryKey: manageKeys.security(),
    queryFn: ({ signal }) => getManageSecurityPolicy(signal),
  });

export const manageSessionsOptions = (request: ManageSessionsRequest) =>
  queryOptions({
    queryKey: manageKeys.sessionList(request),
    queryFn: ({ signal }) => listManageSessions(request, signal),
  });

export function afterManageSecurityChange(
  client: QueryClient,
  policy: ManageSecurityPolicy,
): void {
  client.setQueryData(manageKeys.security(), policy);
  void client.invalidateQueries({ queryKey: manageKeys.workspace() });
}

export function afterManageSessionsChange(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: manageKeys.sessions() });
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

export const manageAuditOptionsOptions = () =>
  queryOptions({
    queryKey: manageKeys.auditOptions(),
    queryFn: ({ signal }) => getManageAuditOptions(signal),
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
