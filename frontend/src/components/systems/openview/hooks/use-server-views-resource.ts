"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type SetStateAction,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/api-errors";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";
import {
  extendsRead,
  moduleFieldKeys,
  readStamp,
  recordPageDenial,
  boundedCatalogOptions,
  dataSourceOptions,
  invalidatesRecords,
  isAuthorizationDenied,
  moduleWorkspaceOptions,
  openViewKeys,
  type ModuleWorkspace,
} from "../adapters/openview-queries";
import { useOpenViewAccessDenied } from "../adapters/openview-access";
import {
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  listOpenViewSavedViews,
  type OpenViewDataSource,
  type OpenViewSavedView,
} from "../adapters/views-api";

import { uuidSchema } from "../adapters/views-schemas";

export type { ModuleWorkspace };

function mergeViewsById(
  current: OpenViewSavedView[],
  next: OpenViewSavedView[],
): OpenViewSavedView[] {
  const views = new Map(current.map((view) => [view.id, view]));
  for (const view of next) views.set(view.id, view);
  return [...views.values()];
}

const AUTHORIZATION_ERROR =
  "OpenView data is unavailable. Sign in or ask for access, then retry.";

// Pages loaded with "Load more" extend the cached first batch. They belong to
// the read that produced it (`readAt`, see readStamp): any later read of the
// batch drops them.
type CatalogExtension = {
  readAt: number;
  items: OpenViewDataSource[];
  hasMore: boolean;
  nextOffset: number;
};

export function useServerViewsResource(requestedModule: string | null) {
  const queryClient = useQueryClient();
  // A refusal of any cached OpenView read hides them all (openview-access.ts).
  const accessDenied = useOpenViewAccessDenied();
  const catalogQuery = useQuery(boundedCatalogOptions());
  const [catalogExtension, setCatalogExtension] =
    useState<CatalogExtension | null>(null);
  const [metadataLoadingMore, setMetadataLoadingMore] = useState(false);
  const [metadataError, setMetadataError] = useState("");
  const [metadataRetryTarget, setMetadataRetryTarget] = useState<
    "catalog" | "module" | null
  >(null);
  const [recordInvalidation, setRecordInvalidation] = useState(0);

  // Record results are not cached reads; they refresh through this counter.
  // Cached reads refresh through OpenViewQuerySync on the same stream.
  useEffect(
    () =>
      subscribeWorkspaceInvalidations((event) => {
        if (event.type === "resync" || invalidatesRecords(event.entity))
          setRecordInvalidation((value) => value + 1);
      }),
    [],
  );

  const catalogBatch = catalogQuery.data;
  const catalogReadAt = readStamp(catalogQuery);
  const sourceMissing = Boolean(
    catalogBatch &&
    requestedModule &&
    ![
      ...catalogBatch.items,
      ...(catalogExtension && extendsRead(catalogExtension.readAt, catalogQuery)
        ? catalogExtension.items
        : []),
    ].some((source) => source.id === requestedModule),
  );
  const selectedSource = useQuery(
    dataSourceOptions(
      requestedModule ?? "",
      sourceMissing && uuidSchema.safeParse(requestedModule).success,
    ),
  );
  const catalogMore =
    catalogExtension && extendsRead(catalogExtension.readAt, catalogQuery)
      ? catalogExtension
      : null;
  // The workspace keys effects (route sync, deep-link lookup) on the
  // catalog array, so it keeps one identity per loaded batch,
  // as the former state did.
  const resolvedSource = selectedSource.isSuccess
    ? selectedSource.data
    : undefined;
  const loadedCatalog = useMemo(
    () =>
      catalogBatch
        ? [
            ...catalogBatch.items,
            ...(catalogMore?.items ?? []),
            ...(resolvedSource &&
            ![...catalogBatch.items, ...(catalogMore?.items ?? [])].some(
              (source) => source.id === resolvedSource.id,
            )
              ? [resolvedSource]
              : []),
          ]
        : null,
    [catalogBatch, catalogMore, resolvedSource],
  );
  const catalogHasMore = catalogMore
    ? catalogMore.hasMore
    : (catalogBatch?.hasMore ?? false);
  const catalogNextOffset = catalogMore
    ? catalogMore.nextOffset
    : (catalogBatch?.nextOffset ?? 0);

  // The module follows the loaded catalog even while access is denied, so a
  // retry can clear a denial from any of the three reads.
  const loadedModuleId =
    sourceMissing && selectedSource.isFetching
      ? undefined
      : loadedCatalog?.length
        ? loadedCatalog.some((source) => source.id === requestedModule)
          ? (requestedModule ?? undefined)
          : loadedCatalog[0]?.id
        : undefined;
  const moduleQuery = useQuery(moduleWorkspaceOptions(loadedModuleId ?? ""));

  // A settled error counts; a retry in flight clears its message first.
  const settledError = (query: { error: unknown; isFetching: boolean }) =>
    query.isFetching ? null : query.error;
  // A denial holds until a read succeeds again: the query keeps its error
  // through a retry, so retained data stays hidden while access is checked.
  const authorizationDenied =
    accessDenied ||
    [catalogQuery, selectedSource, moduleQuery].some((query) =>
      isAuthorizationDenied(query.error),
    );

  const catalog = authorizationDenied ? null : loadedCatalog;
  const catalogLoading =
    catalogQuery.isFetching || (sourceMissing && selectedSource.isFetching);
  const catalogLoadError = settledError(catalogQuery);
  const catalogError = authorizationDenied
    ? AUTHORIZATION_ERROR
    : catalogLoadError
      ? apiErrorMessage(
          catalogLoadError,
          "The OpenView catalog could not be loaded.",
        )
      : "";
  // The chosen source's id stays through a refusal (it is not data) so the
  // editing draft keyed by it survives; its names and rows are hidden.
  const moduleId = loadedModuleId;
  const moduleWorkspace = authorizationDenied
    ? null
    : (moduleQuery.data ?? null);
  const moduleLoading = moduleQuery.isFetching;
  const moduleLoadError = settledError(moduleQuery);
  // While refused, the catalog alert carries the one message and Retry.
  const moduleError = authorizationDenied
    ? ""
    : moduleLoadError
      ? apiErrorMessage(moduleLoadError, "The data source could not be loaded.")
      : "";

  // Saved-view commands update the cached workspace of the module they
  // belong to; each updater ignores a workspace for another module.
  const setModuleWorkspace = useCallback(
    (action: SetStateAction<ModuleWorkspace | null>) => {
      queryClient.setQueriesData<ModuleWorkspace>(
        { queryKey: openViewKeys.moduleWorkspaces },
        (previous) =>
          (typeof action === "function" ? action(previous ?? null) : action) ??
          undefined,
      );
    },
    [queryClient],
  );

  const loadMoreCatalog = useCallback(async () => {
    if (!catalogHasMore || metadataLoadingMore || !catalogReadAt) return;
    const readAt = catalogReadAt;
    setMetadataLoadingMore(true);
    setMetadataError("");
    setMetadataRetryTarget(null);
    try {
      const page = await listOpenViewDataSources({
        limit: 100,
        offset: catalogNextOffset,
      });
      setCatalogExtension((current) => ({
        readAt,
        items: [
          ...(current?.readAt === readAt ? current.items : []),
          ...page.items,
        ],
        hasMore: page.pagination.hasMore,
        nextOffset: catalogNextOffset + page.pagination.count,
      }));
    } catch (error) {
      if (isAuthorizationDenied(error)) {
        void recordPageDenial(queryClient, [openViewKeys.catalog], error);
        return;
      }
      setMetadataRetryTarget("catalog");
      setMetadataError(
        apiErrorMessage(error, "More data sources could not be loaded."),
      );
    } finally {
      setMetadataLoadingMore(false);
    }
  }, [
    catalogHasMore,
    catalogNextOffset,
    catalogReadAt,
    metadataLoadingMore,
    queryClient,
  ]);

  const loadMoreModuleMetadata = useCallback(async () => {
    if (!moduleId || !moduleWorkspace || metadataLoadingMore) return;
    const { fieldsHasMore, viewsHasMore } = moduleWorkspace;
    if (!fieldsHasMore && !viewsHasMore) return;
    setMetadataLoadingMore(true);
    setMetadataError("");
    setMetadataRetryTarget(null);
    try {
      const [fieldsPage, viewsPage] = await Promise.all([
        fieldsHasMore
          ? listOpenViewDataSourceFields(moduleId, {
              limit: 100,
              offset: moduleWorkspace.fieldsNextOffset,
            })
          : Promise.resolve(null),
        viewsHasMore
          ? listOpenViewSavedViews({
              moduleId,
              deleted: "include",
              limit: 100,
              offset: moduleWorkspace.viewsNextOffset,
            })
          : Promise.resolve(null),
      ]);
      setModuleWorkspace((previous) => {
        if (!previous || previous.moduleId !== moduleId) return previous;
        return {
          ...previous,
          fields: fieldsPage
            ? [...previous.fields, ...fieldsPage.items]
            : previous.fields,
          fieldsHasMore:
            fieldsPage?.pagination.hasMore ?? previous.fieldsHasMore,
          fieldsNextOffset: fieldsPage
            ? previous.fieldsNextOffset + fieldsPage.pagination.count
            : previous.fieldsNextOffset,
          views: viewsPage
            ? mergeViewsById(previous.views, viewsPage.items)
            : previous.views,
          viewsHasMore: viewsPage?.pagination.hasMore ?? previous.viewsHasMore,
          viewsNextOffset: viewsPage
            ? previous.viewsNextOffset + viewsPage.pagination.count
            : previous.viewsNextOffset,
        };
      });
    } catch (error) {
      if (isAuthorizationDenied(error)) {
        void recordPageDenial(queryClient, moduleFieldKeys(moduleId), error);
        return;
      }
      setMetadataRetryTarget("module");
      setMetadataError(
        apiErrorMessage(error, "More saved-view metadata could not be loaded."),
      );
    } finally {
      setMetadataLoadingMore(false);
    }
  }, [
    metadataLoadingMore,
    moduleId,
    moduleWorkspace,
    queryClient,
    setModuleWorkspace,
  ]);

  const refreshModule = useCallback(() => {
    void moduleQuery.refetch();
  }, [moduleQuery]);

  const retryCatalog = useCallback(() => {
    // Retry the refused source detail as well as the catalog and workspace.
    void catalogQuery.refetch();
    if (selectedSource.isError) void selectedSource.refetch();
    if (moduleQuery.isError) void moduleQuery.refetch();
  }, [catalogQuery, selectedSource, moduleQuery]);

  const retryMetadata = useCallback(() => {
    if (metadataRetryTarget === "catalog") void loadMoreCatalog();
    if (metadataRetryTarget === "module") void loadMoreModuleMetadata();
  }, [loadMoreCatalog, loadMoreModuleMetadata, metadataRetryTarget]);

  return {
    catalog,
    catalogHasMore,
    catalogLoading,
    catalogError,
    moduleId,
    moduleWorkspace,
    setModuleWorkspace,
    moduleLoading,
    moduleError,
    metadataLoadingMore,
    metadataError,
    retryMetadata,
    loadMoreCatalog,
    loadMoreModuleMetadata,
    refreshModule,
    retryCatalog,
    recordInvalidation,
    authorizationDenied,
  };
}
