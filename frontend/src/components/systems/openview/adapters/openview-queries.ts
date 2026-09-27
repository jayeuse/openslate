"use client";

import {
  queryOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { getAuthMe } from "@/lib/auth-api";
import { denyOpenViewAccess, watchOpenViewAccess } from "./openview-access";
import { getOpenViewChartPreferences } from "./chart-preferences-api";
import {
  listOpenViewReports,
  listOpenViewSharedReportRuns,
} from "./reports-api";
import {
  listOpenViewAudienceOptions,
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  listOpenViewPersonalDefaults,
  listOpenViewSavedViews,
  type OpenViewAudienceOption,
  type OpenViewDataSourceField,
  type OpenViewPage,
  type OpenViewPersonalDefault,
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
  /** The complete catalog, read in bounded pages (Views). */
  boundedCatalog: () => ["openview", "catalog", "bounded"] as const,
  /** The first catalog page (Charts and Reports load more on request). */
  catalogFirstPage: () => ["openview", "catalog", "first-page"] as const,
  fields: ["openview", "fields"] as const,
  fieldsFirstPage: (moduleId: string) =>
    ["openview", "fields", moduleId, "first-page"] as const,
  moduleWorkspaces: ["openview", "module-workspace"] as const,
  moduleWorkspace: (moduleId: string) =>
    ["openview", "module-workspace", moduleId] as const,
  audiences: () => ["openview", "audiences"] as const,
  chartPreferences: () => ["openview", "chart-preferences"] as const,
  reportLists: ["openview", "reports", "list"] as const,
  reportList: (deleted: "include" | "exclude") =>
    ["openview", "reports", "list", deleted] as const,
  sharedRuns: ["openview", "reports", "shared-runs"] as const,
  sharedRunsPage: (offset: number, limit: number) =>
    ["openview", "reports", "shared-runs", { offset, limit }] as const,
  /** The signed-in identity. It needs only a session, not records.read, so
   *  it sits outside the "openview" prefix and its access latch. */
  authMe: () => ["auth", "me"] as const,
};

export type ItemBatch<T> = { items: T[]; hasMore: boolean; nextOffset: number };

export async function boundedItems<T>(
  read: (options: {
    limit: number;
    offset: number;
  }) => Promise<OpenViewPage<T>>,
): Promise<ItemBatch<T>> {
  const items: T[] = [];
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = await read({ limit: 100, offset });
    items.push(...page.items);
    if (!page.pagination.hasMore || page.items.length === 0)
      return { items, hasMore: false, nextOffset: offset + page.items.length };
    offset += page.pagination.count;
  }
  return { items, hasMore: true, nextOffset: offset };
}

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
 * Records a refused "Load more" page: the OpenView access latch hides every
 * cached read, and the reads this page extends hold the refusal as their
 * error, so their section says why.
 */
export function recordPageDenial(
  client: QueryClient,
  queryKeys: readonly QueryKey[],
  error: ApiError,
): void {
  denyOpenViewAccess(client);
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
  defaults: OpenViewPersonalDefault[];
  defaultsHasMore: boolean;
  defaultsNextOffset: number;
};

export type AudienceLists = {
  roles: ItemBatch<OpenViewAudienceOption> | null;
  people: ItemBatch<OpenViewAudienceOption> | null;
  failed: boolean;
};

export const boundedCatalogOptions = () =>
  queryOptions({
    queryKey: openViewKeys.boundedCatalog(),
    queryFn: () => boundedItems((options) => listOpenViewDataSources(options)),
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

export const moduleWorkspaceOptions = (moduleId: string) =>
  queryOptions({
    queryKey: openViewKeys.moduleWorkspace(moduleId),
    queryFn: async (): Promise<ModuleWorkspace> => {
      const [fields, views, defaults] = await Promise.all([
        boundedItems((options) =>
          listOpenViewDataSourceFields(moduleId, options),
        ),
        boundedItems((options) =>
          listOpenViewSavedViews({ moduleId, deleted: "include", ...options }),
        ),
        boundedItems((options) => listOpenViewPersonalDefaults(options)),
      ]);
      return {
        moduleId,
        fields: fields.items,
        fieldsHasMore: fields.hasMore,
        fieldsNextOffset: fields.nextOffset,
        views: views.items,
        viewsHasMore: views.hasMore,
        viewsNextOffset: views.nextOffset,
        defaults: defaults.items,
        defaultsHasMore: defaults.hasMore,
        defaultsNextOffset: defaults.nextOffset,
      };
    },
    enabled: Boolean(moduleId),
  });

// Role and person choices only feed sharing, so a failed list keeps the last
// loaded one and reports a scoped message. Only a denial fails the query.
export const audienceOptions = () =>
  queryOptions({
    queryKey: openViewKeys.audiences(),
    queryFn: async ({ client, queryKey }): Promise<AudienceLists> => {
      const [roles, people] = await Promise.allSettled([
        boundedItems((options) => listOpenViewAudienceOptions("role", options)),
        boundedItems((options) => listOpenViewAudienceOptions("user", options)),
      ]);
      for (const result of [roles, people])
        if (
          result.status === "rejected" &&
          isAuthorizationDenied(result.reason)
        )
          throw result.reason;
      const previous = client.getQueryData<AudienceLists>(queryKey);
      return {
        roles:
          roles.status === "fulfilled"
            ? roles.value
            : (previous?.roles ?? null),
        people:
          people.status === "fulfilled"
            ? people.value
            : (previous?.people ?? null),
        failed: roles.status === "rejected" || people.status === "rejected",
      };
    },
  });

export const chartPreferencesOptions = () =>
  queryOptions({
    queryKey: openViewKeys.chartPreferences(),
    queryFn: () => getOpenViewChartPreferences(),
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

const CATALOG_ENTITIES = new Set([
  "departments",
  "fields",
  "modules",
  "workspace_profiles",
]);
const VIEW_METADATA_ENTITIES = new Set(["saved_views", "saved_view_defaults"]);

/** Entities whose change refreshes applied record results in a section. */
export function invalidatesRecords(entity: string): boolean {
  return (
    entity === "records" ||
    entity === "relationships" ||
    CATALOG_ENTITIES.has(entity)
  );
}

/** The cached reads that depend on one invalidated entity. */
export function openViewKeysForEntity(entity: string): QueryKey[] {
  if (CATALOG_ENTITIES.has(entity))
    return [
      openViewKeys.catalog,
      openViewKeys.fields,
      openViewKeys.moduleWorkspaces,
      openViewKeys.audiences(),
    ];
  if (VIEW_METADATA_ENTITIES.has(entity))
    return [openViewKeys.moduleWorkspaces];
  return [];
}

/** Starts the primary reads of an OpenView section before it opens. */
export function prefetchOpenViewSection(
  client: QueryClient,
  href: string,
): void {
  watchOpenViewAccess(client);
  const url = new URL(href, "http://openview.invalid");
  if (url.pathname !== "/openview") return;
  const section = url.searchParams.get("section") ?? "views";
  const reads: Promise<void>[] = [];
  if (section === "views")
    reads.push(client.prefetchQuery(boundedCatalogOptions()));
  if (section === "charts")
    reads.push(
      client.prefetchQuery(chartPreferencesOptions()),
      client.prefetchQuery(catalogFirstPageOptions()),
    );
  if (section === "reports")
    reads.push(
      client.prefetchQuery(reportListOptions("exclude")),
      client.prefetchQuery(sharedRunsOptions(0, REPORT_PAGE_SIZE)),
      client.prefetchQuery(authMeOptions()),
      client.prefetchQuery(catalogFirstPageOptions()),
    );
  void Promise.all(reads);
}
