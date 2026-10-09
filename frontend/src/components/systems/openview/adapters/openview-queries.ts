"use client";

import {
  queryOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { getAuthMe } from "@/lib/auth-api";
import {
  getOpenViewDepartment,
  listOpenViewDepartments,
} from "./departments-api";
import { listRecordFiles } from "./record-files-api";
import {
  listOpenViewReports,
  listOpenViewSharedReportRuns,
} from "./reports-api";
import {
  getOpenViewDataSource,
  getOpenViewDataSourceField,
  listOpenViewAssignableUsers,
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  listOpenViewSavedViews,
  type OpenViewDataSourceField,
  type OpenViewAssignableUser,
  type OpenViewPage,
  type OpenViewSavedView,
} from "./views-api";

// Section-level OpenView reads share one client cache. Every key starts with
// "openview", so a stream resync (or leaving OpenView) can mark them all
// stale at once. Record rows, report history, and other detail reads stay in
// their components.

export const REPORT_PAGE_SIZE = 25;
export const CATALOG_PAGE_SIZE = 100;

export const openViewKeys = {
  all: ["openview"] as const,
  catalog: ["openview", "catalog"] as const,
  /** The first catalog batch; Views loads more only on request. */
  boundedCatalog: () => ["openview", "catalog", "bounded"] as const,
  /** The first catalog page (Charts and Reports load more on request). */
  catalogFirstPage: () => ["openview", "catalog", "first-page"] as const,
  /** Readable departments, which own Dashboards and name data sources. */
  departments: (search = "") =>
    ["openview", "catalog", "departments", { search }] as const,
  department: (id: string) =>
    ["openview", "catalog", "department", id] as const,
  dataSource: (id: string) => ["openview", "catalog", "source", id] as const,
  field: (moduleId: string, id: string) =>
    ["openview", "fields", moduleId, "detail", id] as const,
  fields: ["openview", "fields"] as const,
  assignableUsers: ["openview", "assignable-users"] as const,
  assignableUsersPage: (moduleId: string, search: string) =>
    ["openview", "assignable-users", moduleId, { search }] as const,
  fieldsFirstPage: (moduleId: string) =>
    ["openview", "fields", moduleId, "first-page"] as const,
  moduleWorkspaces: ["openview", "module-workspace"] as const,
  moduleWorkspace: (moduleId: string) =>
    ["openview", "module-workspace", moduleId] as const,
  reportLists: ["openview", "reports", "list"] as const,
  reportList: (deleted: "include" | "exclude") =>
    ["openview", "reports", "list", deleted] as const,
  sharedRuns: ["openview", "reports", "shared-runs"] as const,
  sharedRunsPage: (offset: number, limit: number) =>
    ["openview", "reports", "shared-runs", { offset, limit }] as const,
  /** The signed-in identity. It needs only a session, not records.read, so
   *  it sits outside the "openview" prefix and its access latch. */
  authMe: () => ["auth", "me"] as const,
  recordFiles: ["openview", "record-files"] as const,
  recordFileList: (recordId: string) =>
    [
      "openview",
      "record-files",
      "record_attachment",
      recordId,
      "exclude",
      { limit: 25, offset: 0 },
    ] as const,
};

export type ItemBatch<T> = { items: T[]; hasMore: boolean; nextOffset: number };

export function isAuthorizationDenied(error: unknown): error is ApiError {
  return error instanceof ApiError && [401, 403].includes(error.status);
}

// "Load more" pages extend a cached first page in one section's state. Two
// rules keep them honest across sections:
//
// 1. A page belongs to the one successful read that produced its first page,
//    identified by that read's `dataUpdatedAt`. Any later read drops it, even
//    one whose data is equal (structural sharing keeps the same object, so
//    object identity cannot tell reads apart).
// 2. A refused page (401/403) is a refusal of the whole collection. It is
//    recorded on the shared cached reads, so every section loses the cached
//    names and holds the refusal as `error` until a read succeeds.

/** The read a "Load more" page extends: 0 when no data is cached. */
export function readStamp(query: {
  data: unknown;
  dataUpdatedAt: number;
}): number {
  return query.data === undefined ? 0 : query.dataUpdatedAt;
}

/** Whether a page loaded after the read stamped `readAt` still applies. */
export function extendsRead(
  readAt: number,
  query: { data: unknown; dataUpdatedAt: number },
): boolean {
  const current = readStamp(query);
  return current !== 0 && current === readAt;
}

/** Cached reads that hold one data source's fields. */
export function moduleFieldKeys(moduleId: string): QueryKey[] {
  return [
    openViewKeys.fieldsFirstPage(moduleId),
    openViewKeys.moduleWorkspace(moduleId),
  ];
}

/**
 * Records a refused "Load more" page on the reads it extends, so their
 * section says why. The page's own request already set the OpenView access
 * latch (openview-access.ts), which hides every cached read.
 */
export function recordPageDenial(
  client: QueryClient,
  queryKeys: readonly QueryKey[],
  error: ApiError,
): void {
  const now = Date.now();
  for (const queryKey of queryKeys)
    for (const query of client.getQueryCache().findAll({ queryKey }))
      query.setState({
        data: undefined,
        dataUpdatedAt: 0,
        error,
        errorUpdatedAt: now,
        errorUpdateCount: query.state.errorUpdateCount + 1,
        fetchFailureCount: query.state.fetchFailureCount + 1,
        fetchFailureReason: error,
        status: "error",
        isInvalidated: true,
      });
}

export type ModuleWorkspace = {
  moduleId: string;
  fields: OpenViewDataSourceField[];
  fieldsHasMore: boolean;
  fieldsNextOffset: number;
  views: OpenViewSavedView[];
  viewsHasMore: boolean;
  viewsNextOffset: number;
};

export const boundedCatalogOptions = () =>
  queryOptions({
    queryKey: openViewKeys.boundedCatalog(),
    queryFn: async () => {
      const page = await listOpenViewDataSources({
        limit: CATALOG_PAGE_SIZE,
        offset: 0,
      });
      return {
        items: page.items,
        hasMore: page.pagination.hasMore,
        nextOffset: page.pagination.offset + page.pagination.count,
      };
    },
  });

export const departmentsOptions = (search = "") =>
  queryOptions({
    queryKey: openViewKeys.departments(search),
    queryFn: ({ signal }) =>
      listOpenViewDepartments({
        limit: CATALOG_PAGE_SIZE,
        offset: 0,
        search,
        signal,
      }),
  });

export const departmentOptions = (id: string, enabled = true) =>
  queryOptions({
    queryKey: openViewKeys.department(id),
    queryFn: ({ signal }) => getOpenViewDepartment(id, signal),
    enabled: Boolean(id) && enabled,
  });
export const dataSourceOptions = (id: string, enabled = true) =>
  queryOptions({
    queryKey: openViewKeys.dataSource(id),
    queryFn: ({ signal }) => getOpenViewDataSource(id, signal),
    enabled: Boolean(id) && enabled,
  });
export const fieldOptions = (moduleId: string, id: string) =>
  queryOptions({
    queryKey: openViewKeys.field(moduleId, id),
    queryFn: ({ signal }) => getOpenViewDataSourceField(moduleId, id, signal),
    enabled: Boolean(moduleId && id),
  });

export const catalogFirstPageOptions = () =>
  queryOptions({
    queryKey: openViewKeys.catalogFirstPage(),
    queryFn: () =>
      listOpenViewDataSources({ limit: CATALOG_PAGE_SIZE, offset: 0 }),
  });

export const fieldsFirstPageOptions = (moduleId: string) =>
  queryOptions({
    queryKey: openViewKeys.fieldsFirstPage(moduleId),
    queryFn: () =>
      listOpenViewDataSourceFields(moduleId, {
        limit: CATALOG_PAGE_SIZE,
        offset: 0,
      }),
    enabled: Boolean(moduleId),
  });

export const assignableUsersOptions = (
  moduleId: string,
  search: string,
  enabled = true,
) =>
  queryOptions({
    queryKey: openViewKeys.assignableUsersPage(moduleId, search),
    queryFn: (): Promise<OpenViewPage<OpenViewAssignableUser>> =>
      listOpenViewAssignableUsers(moduleId, {
        limit: CATALOG_PAGE_SIZE,
        offset: 0,
        search,
      }),
    enabled: Boolean(moduleId) && enabled,
    staleTime: 0,
  });

export const moduleWorkspaceOptions = (moduleId: string) =>
  queryOptions({
    queryKey: openViewKeys.moduleWorkspace(moduleId),
    queryFn: async (): Promise<ModuleWorkspace> => {
      const [fields, views] = await Promise.all([
        listOpenViewDataSourceFields(moduleId, {
          limit: CATALOG_PAGE_SIZE,
          offset: 0,
        }),
        listOpenViewSavedViews({
          moduleId,
          deleted: "include",
          limit: CATALOG_PAGE_SIZE,
          offset: 0,
        }),
      ]);
      return {
        moduleId,
        fields: fields.items,
        fieldsHasMore: fields.pagination.hasMore,
        fieldsNextOffset: fields.pagination.offset + fields.pagination.count,
        views: views.items,
        viewsHasMore: views.pagination.hasMore,
        viewsNextOffset: views.pagination.offset + views.pagination.count,
      };
    },
    enabled: Boolean(moduleId),
  });

export const reportListOptions = (deleted: "include" | "exclude") =>
  queryOptions({
    queryKey: openViewKeys.reportList(deleted),
    queryFn: () =>
      listOpenViewReports({ limit: REPORT_PAGE_SIZE, offset: 0, deleted }),
  });

export const sharedRunsOptions = (offset: number, limit: number) =>
  queryOptions({
    queryKey: openViewKeys.sharedRunsPage(offset, limit),
    queryFn: () => listOpenViewSharedReportRuns({ limit, offset }),
  });

export const authMeOptions = () =>
  queryOptions({
    queryKey: openViewKeys.authMe(),
    queryFn: ({ signal }) => getAuthMe(signal),
  });

export const recordFilesOptions = (recordId: string) =>
  queryOptions({
    queryKey: openViewKeys.recordFileList(recordId),
    queryFn: async ({ signal, client }) => {
      try {
        return await listRecordFiles(recordId, {
          limit: 25,
          offset: 0,
          signal,
        });
      } catch (error) {
        if (error instanceof ApiError && [401, 403, 404].includes(error.status))
          recordPageDenial(
            client,
            [
              error.status === 404
                ? openViewKeys.recordFileList(recordId)
                : openViewKeys.recordFiles,
            ],
            error,
          );
        throw error;
      }
    },
  });

const CATALOG_ENTITIES = new Set([
  "departments",
  "fields",
  "modules",
  "workspace_profiles",
]);
const VIEW_METADATA_ENTITIES = new Set(["saved_views"]);
const USER_DISPLAY_ENTITIES = new Set([
  "group_access",
  "group_members",
  "groups",
  "users",
]);

/** Entities whose change refreshes applied record results in a section. */
export function invalidatesRecords(entity: string): boolean {
  return (
    entity === "records" ||
    entity === "relationships" ||
    entity === "charts" ||
    CATALOG_ENTITIES.has(entity) ||
    USER_DISPLAY_ENTITIES.has(entity)
  );
}

/** The cached reads that depend on one invalidated entity. */
export function openViewKeysForEntity(entity: string): QueryKey[] {
  const fileKeys =
    entity === "files" ||
    entity === "records" ||
    CATALOG_ENTITIES.has(entity) ||
    USER_DISPLAY_ENTITIES.has(entity)
      ? [openViewKeys.recordFiles]
      : [];
  if (CATALOG_ENTITIES.has(entity))
    return [
      openViewKeys.catalog,
      openViewKeys.fields,
      openViewKeys.moduleWorkspaces,
      openViewKeys.assignableUsers,
      ...fileKeys,
    ];
  if (
    entity === "departments" ||
    entity === "group_access" ||
    entity === "group_members" ||
    entity === "groups" ||
    entity === "users"
  )
    return [openViewKeys.assignableUsers, ...fileKeys];
  if (VIEW_METADATA_ENTITIES.has(entity))
    return [openViewKeys.moduleWorkspaces];
  return fileKeys;
}

/** Starts the primary reads of an OpenView section before it opens. */
export function prefetchOpenViewSection(
  client: QueryClient,
  href: string,
): void {
  const url = new URL(href, "http://openview.invalid");
  if (url.pathname !== "/openview") return;
  const section = url.searchParams.get("section") ?? "views";
  const reads: Promise<void>[] = [];
  if (section === "views")
    reads.push(client.prefetchQuery(boundedCatalogOptions()));
  if (section === "charts")
    reads.push(client.prefetchQuery(catalogFirstPageOptions()));
  if (section === "reports")
    reads.push(
      client.prefetchQuery(reportListOptions("exclude")),
      client.prefetchQuery(sharedRunsOptions(0, REPORT_PAGE_SIZE)),
      client.prefetchQuery(authMeOptions()),
      client.prefetchQuery(catalogFirstPageOptions()),
    );
  void Promise.all(reads);
}
