"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type SetStateAction,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { subscribeOpenViewInvalidations } from "../adapters/invalidation-events";
import {
  audienceOptions,
  extendsRead,
  moduleFieldKeys,
  readStamp,
  recordPageDenial,
  boundedCatalogOptions,
  invalidatesRecords,
  isAuthorizationDenied,
  moduleWorkspaceOptions,
  openViewKeys,
  type ModuleWorkspace,
} from "../adapters/openview-queries";
import { useOpenViewAccessDenied } from "../adapters/openview-access";
import {
  listOpenViewAudienceOptions,
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  listOpenViewPersonalDefaults,
  listOpenViewSavedViews,
  type OpenViewAudienceOption,
  type OpenViewDataSource,
  type OpenViewSavedView,
} from "../adapters/views-api";

export type { ModuleWorkspace };

function mergeViewsById(
  current: OpenViewSavedView[],
  next: OpenViewSavedView[],
): OpenViewSavedView[] {
  const views = new Map(current.map((view) => [view.id, view]));
  for (const view of next) views.set(view.id, view);
  return [...views.values()];
}

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

const NO_AUDIENCES: OpenViewAudienceOption[] = [];

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
type AudienceExtension = {
  readAt: number;
  items: OpenViewAudienceOption[];
  roleHasMore: boolean;
  roleNextOffset: number;
  userHasMore: boolean;
  userNextOffset: number;
  error: string | null;
};

export function useServerViewsResource(requestedModule: string | null) {
  const queryClient = useQueryClient();
  // A refusal of any cached OpenView read hides them all (openview-access.ts).
  const accessDenied = useOpenViewAccessDenied();
  const catalogQuery = useQuery(boundedCatalogOptions());
  const audienceQuery = useQuery(audienceOptions());
  const [catalogExtension, setCatalogExtension] =
    useState<CatalogExtension | null>(null);
  const [audienceExtension, setAudienceExtension] =
    useState<AudienceExtension | null>(null);
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
      subscribeOpenViewInvalidations((event) => {
        if (event.type === "resync" || invalidatesRecords(event.entity))
          setRecordInvalidation((value) => value + 1);
      }),
    [],
  );

  const catalogBatch = catalogQuery.data;
  const catalogReadAt = readStamp(catalogQuery);
  const catalogMore =
    catalogExtension && extendsRead(catalogExtension.readAt, catalogQuery)
      ? catalogExtension
      : null;
  // The workspace keys effects (route sync, deep-link lookup) on the
  // catalog and audience arrays, so they keep one identity per loaded batch,
  // as the former state did.
  const loadedCatalog = useMemo(
    () =>
      catalogBatch
        ? [...catalogBatch.items, ...(catalogMore?.items ?? [])]
        : null,
    [catalogBatch, catalogMore],
  );
  const catalogHasMore = catalogMore
    ? catalogMore.hasMore
    : (catalogBatch?.hasMore ?? false);
  const catalogNextOffset = catalogMore
    ? catalogMore.nextOffset
    : (catalogBatch?.nextOffset ?? 0);

  // The module follows the loaded catalog even while access is denied, so a
  // retry can clear a denial from any of the three reads.
  const loadedModuleId = loadedCatalog?.length
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
    [catalogQuery, audienceQuery, moduleQuery].some((query) =>
      isAuthorizationDenied(query.error),
    );

  const catalog = authorizationDenied ? null : loadedCatalog;
  const catalogLoading = catalogQuery.isFetching;
  const catalogLoadError = settledError(catalogQuery);
  const catalogError = authorizationDenied
    ? AUTHORIZATION_ERROR
    : catalogLoadError
      ? messageFor(
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
      ? messageFor(moduleLoadError, "The data source could not be loaded.")
      : "";

  const audienceLists = audienceQuery.data;
  const audienceReadAt = readStamp(audienceQuery);
  const audienceMore =
    audienceExtension && extendsRead(audienceExtension.readAt, audienceQuery)
      ? audienceExtension
      : null;
  const loadedAudiences = useMemo(
    () => [
      ...(audienceLists?.roles?.items ?? []),
      ...(audienceLists?.people?.items ?? []),
      ...(audienceMore?.items ?? []),
    ],
    [audienceLists, audienceMore],
  );
  const audiences = authorizationDenied ? NO_AUDIENCES : loadedAudiences;
  const roleOptionsHasMore = audienceMore
    ? audienceMore.roleHasMore
    : (audienceLists?.roles?.hasMore ?? false);
  const roleOptionsNextOffset = audienceMore
    ? audienceMore.roleNextOffset
    : (audienceLists?.roles?.nextOffset ?? 0);
  const userOptionsHasMore = audienceMore
    ? audienceMore.userHasMore
    : (audienceLists?.people?.hasMore ?? false);
  const userOptionsNextOffset = audienceMore
    ? audienceMore.userNextOffset
    : (audienceLists?.people?.nextOffset ?? 0);
  const audienceError = authorizationDenied
    ? ""
    : (audienceMore?.error ??
      (audienceLists?.failed
        ? "Roles and people could not be loaded. You can still share with Only me or Everyone."
        : ""));
  const audienceLoading = audienceQuery.isFetching;

  const retryAudiences = useCallback(() => {
    void audienceQuery.refetch();
  }, [audienceQuery]);

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
        messageFor(error, "More data sources could not be loaded."),
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
    const { fieldsHasMore, viewsHasMore, defaultsHasMore } = moduleWorkspace;
    if (!fieldsHasMore && !viewsHasMore && !defaultsHasMore) return;
    setMetadataLoadingMore(true);
    setMetadataError("");
    setMetadataRetryTarget(null);
    try {
      const [fieldsPage, viewsPage, defaultsPage] = await Promise.all([
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
        defaultsHasMore
          ? listOpenViewPersonalDefaults({
              limit: 100,
              offset: moduleWorkspace.defaultsNextOffset,
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
          defaults: defaultsPage
            ? [...previous.defaults, ...defaultsPage.items]
            : previous.defaults,
          defaultsHasMore:
            defaultsPage?.pagination.hasMore ?? previous.defaultsHasMore,
          defaultsNextOffset: defaultsPage
            ? previous.defaultsNextOffset + defaultsPage.pagination.count
            : previous.defaultsNextOffset,
        };
      });
    } catch (error) {
      if (isAuthorizationDenied(error)) {
        void recordPageDenial(queryClient, moduleFieldKeys(moduleId), error);
        return;
      }
      setMetadataRetryTarget("module");
      setMetadataError(
        messageFor(error, "More saved-view metadata could not be loaded."),
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

  const loadMoreAudienceOptions = useCallback(async () => {
    if (metadataLoadingMore || (!roleOptionsHasMore && !userOptionsHasMore))
      return;
    if (!audienceReadAt) return;
    setMetadataLoadingMore(true);
    const extension: AudienceExtension = {
      readAt: audienceReadAt,
      items: audienceMore?.items ?? [],
      roleHasMore: roleOptionsHasMore,
      roleNextOffset: roleOptionsNextOffset,
      userHasMore: userOptionsHasMore,
      userNextOffset: userOptionsNextOffset,
      error: "",
    };
    setAudienceExtension(extension);
    try {
      const [roles, users] = await Promise.all([
        roleOptionsHasMore
          ? listOpenViewAudienceOptions("role", {
              limit: 100,
              offset: roleOptionsNextOffset,
            })
          : Promise.resolve(null),
        userOptionsHasMore
          ? listOpenViewAudienceOptions("user", {
              limit: 100,
              offset: userOptionsNextOffset,
            })
          : Promise.resolve(null),
      ]);
      setAudienceExtension({
        ...extension,
        items: [
          ...extension.items,
          ...(roles?.items ?? []),
          ...(users?.items ?? []),
        ],
        ...(roles
          ? {
              roleHasMore: roles.pagination.hasMore,
              roleNextOffset: roleOptionsNextOffset + roles.pagination.count,
            }
          : {}),
        ...(users
          ? {
              userHasMore: users.pagination.hasMore,
              userNextOffset: userOptionsNextOffset + users.pagination.count,
            }
          : {}),
      });
    } catch (error) {
      if (isAuthorizationDenied(error)) {
        void recordPageDenial(queryClient, [openViewKeys.audiences()], error);
        return;
      }
      setAudienceExtension({
        ...extension,
        error:
          "More roles and people could not be loaded. You can still share with the choices shown.",
      });
    } finally {
      setMetadataLoadingMore(false);
    }
  }, [
    audienceMore,
    audienceReadAt,
    queryClient,
    metadataLoadingMore,
    roleOptionsHasMore,
    roleOptionsNextOffset,
    userOptionsHasMore,
    userOptionsNextOffset,
  ]);

  const refreshModule = useCallback(() => {
    void moduleQuery.refetch();
  }, [moduleQuery]);

  const retryCatalog = useCallback(() => {
    // Role and person choices reload with the catalog, as a denial may have
    // come from any read.
    void catalogQuery.refetch();
    void audienceQuery.refetch();
    if (moduleQuery.isError) void moduleQuery.refetch();
  }, [audienceQuery, catalogQuery, moduleQuery]);

  const retryMetadata = useCallback(() => {
    if (metadataRetryTarget === "catalog") void loadMoreCatalog();
    if (metadataRetryTarget === "module") void loadMoreModuleMetadata();
  }, [loadMoreCatalog, loadMoreModuleMetadata, metadataRetryTarget]);

  return {
    catalog,
    catalogHasMore,
    catalogLoading,
    catalogError,
    audiences,
    audienceError,
    audienceLoading,
    retryAudiences,
    roleOptionsHasMore,
    userOptionsHasMore,
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
    loadMoreAudienceOptions,
    refreshModule,
    retryCatalog,
    recordInvalidation,
    authorizationDenied,
  };
}
