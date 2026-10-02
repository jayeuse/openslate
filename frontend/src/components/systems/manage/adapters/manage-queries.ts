"use client";

import { queryOptions, type QueryClient } from "@tanstack/react-query";

import {
  getManageWorkspace,
  type ManageWorkspaceProfile,
} from "./workspace-api";
import {
  getManageAuditLog,
  getManageAuditOptions,
  listAllManageAuditLogs,
  listManageAuditLogs,
  type ManageAuditListRequest,
} from "./audit-api";

export const manageKeys = {
  all: ["manage"] as const,
  workspace: () => ["manage", "workspace"] as const,
  auditLists: () => ["manage", "audit-logs", "list"] as const,
  auditList: (request: ManageAuditListRequest) =>
    ["manage", "audit-logs", "list", request] as const,
  auditOptions: () => ["manage", "audit-logs", "options"] as const,
  auditDetail: (id: string) => ["manage", "audit-logs", "detail", id] as const,
  auditExport: (request: Omit<ManageAuditListRequest, "limit" | "offset">) =>
    ["manage", "audit-logs", "export", request] as const,
};

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
    queryFn: ({ signal }) => listAllManageAuditLogs(request, signal),
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
