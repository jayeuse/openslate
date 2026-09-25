"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { subscribeOpenViewInvalidations } from "../adapters/invalidation-events";
import {
  listOpenViewAudienceOptions,
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  listOpenViewPersonalDefaults,
  listOpenViewSavedViews,
  type OpenViewAudienceOption,
  type OpenViewDataSource,
  type OpenViewDataSourceField,
  type OpenViewPage,
  type OpenViewPersonalDefault,
  type OpenViewSavedView,
} from "../adapters/views-api";

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

type ItemBatch<T> = { items: T[]; hasMore: boolean; nextOffset: number };

function mergeViewsById(
  current: OpenViewSavedView[],
  next: OpenViewSavedView[],
): OpenViewSavedView[] {
  const views = new Map(current.map((view) => [view.id, view]));
  for (const view of next) views.set(view.id, view);
  return [...views.values()];
}

async function boundedItems<T>(
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

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function isAuthorizationDenied(error: unknown): boolean {
  return error instanceof ApiError && [401, 403].includes(error.status);
}

const CATALOG_ENTITIES = new Set([
  "departments",
  "fields",
  "modules",
  "workspace_profiles",
]);
const VIEW_METADATA_ENTITIES = new Set(["saved_views", "saved_view_defaults"]);

export function useServerViewsResource(requestedModule: string | null) {
  const [catalog, setCatalog] = useState<OpenViewDataSource[] | null>(null);
  const [catalogHasMore, setCatalogHasMore] = useState(false);
  const [catalogNextOffset, setCatalogNextOffset] = useState(0);
  const [audiences, setAudiences] = useState<OpenViewAudienceOption[]>([]);
  const [roleOptionsHasMore, setRoleOptionsHasMore] = useState(false);
  const [roleOptionsNextOffset, setRoleOptionsNextOffset] = useState(0);
  const [userOptionsHasMore, setUserOptionsHasMore] = useState(false);
  const [userOptionsNextOffset, setUserOptionsNextOffset] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [moduleWorkspace, setModuleWorkspace] =
    useState<ModuleWorkspace | null>(null);
  const [moduleLoading, setModuleLoading] = useState(false);
  const [moduleError, setModuleError] = useState("");
  const [moduleRetry, setModuleRetry] = useState(0);
  const [metadataLoadingMore, setMetadataLoadingMore] = useState(false);
  const [metadataError, setMetadataError] = useState("");
  const [metadataRetryTarget, setMetadataRetryTarget] = useState<
    "catalog" | "module" | "audience" | null
  >(null);
  const [recordInvalidation, setRecordInvalidation] = useState(0);
  const [authorizationDenied, setAuthorizationDenied] = useState(false);
  const catalogRequest = useRef(0);
  const moduleRequest = useRef(0);

  const markAuthorizationDenied = useCallback(() => {
    catalogRequest.current += 1;
    moduleRequest.current += 1;
    setAuthorizationDenied(true);
    setCatalog(null);
    setCatalogLoading(false);
    setCatalogHasMore(false);
    setCatalogNextOffset(0);
    setAudiences([]);
    setModuleWorkspace(null);
    setModuleLoading(false);
    setCatalogError(
      "OpenView data is unavailable. Sign in or ask for access, then retry.",
    );
    setModuleError(
      "OpenView data is unavailable. Sign in or ask for access, then retry.",
    );
  }, []);

  useEffect(
    () =>
      subscribeOpenViewInvalidations((event) => {
        if (event.type === "resync") {
          setRecordInvalidation((value) => value + 1);
          setCatalogRetry((value) => value + 1);
          setModuleRetry((value) => value + 1);
          return;
        }
        if (event.entity === "records" || event.entity === "relationships") {
          setRecordInvalidation((value) => value + 1);
        }
        if (CATALOG_ENTITIES.has(event.entity)) {
          setRecordInvalidation((value) => value + 1);
          setCatalogRetry((value) => value + 1);
          setModuleRetry((value) => value + 1);
          return;
        }
        if (VIEW_METADATA_ENTITIES.has(event.entity))
          setModuleRetry((value) => value + 1);
      }),
    [],
  );

  useEffect(() => {
    const request = ++catalogRequest.current;
    setCatalogLoading(true);
    setCatalogError("");
    void Promise.allSettled([
      boundedItems((options) => listOpenViewDataSources(options)),
      boundedItems((options) => listOpenViewAudienceOptions("role", options)),
      boundedItems((options) => listOpenViewAudienceOptions("user", options)),
    ])
      .then((results) => {
        if (request !== catalogRequest.current) return;
        if (
          results.some(
            (result) =>
              result.status === "rejected" &&
              isAuthorizationDenied(result.reason),
          )
        ) {
          markAuthorizationDenied();
          return;
        }
        setAuthorizationDenied(false);
        const [sources, roles, people] = results;
        if (sources.status === "fulfilled") {
          setCatalog(sources.value.items);
          setCatalogHasMore(sources.value.hasMore);
          setCatalogNextOffset(sources.value.nextOffset);
        }
        if (roles.status === "fulfilled") {
          setAudiences((current) => [
            ...current.filter((item) => item.kind !== "role"),
            ...roles.value.items,
          ]);
          setRoleOptionsHasMore(roles.value.hasMore);
          setRoleOptionsNextOffset(roles.value.nextOffset);
        }
        if (people.status === "fulfilled") {
          setAudiences((current) => [
            ...current.filter((item) => item.kind !== "identity"),
            ...people.value.items,
          ]);
          setUserOptionsHasMore(people.value.hasMore);
          setUserOptionsNextOffset(people.value.nextOffset);
        }
        const failed = results.find((result) => result.status === "rejected");
        setCatalogError(
          failed?.status === "rejected"
            ? messageFor(
                failed.reason,
                "The OpenView catalog could not be loaded.",
              )
            : "",
        );
      })
      .finally(() => {
        if (request === catalogRequest.current) setCatalogLoading(false);
      });
    return () => {
      catalogRequest.current += 1;
    };
  }, [catalogRetry, markAuthorizationDenied]);

  const moduleId = useMemo(() => {
    if (!catalog?.length) return undefined;
    return catalog.some((source) => source.id === requestedModule)
      ? (requestedModule ?? undefined)
      : catalog[0]?.id;
  }, [catalog, requestedModule]);

  useEffect(() => {
    if (!moduleId) return;
    const request = ++moduleRequest.current;
    setModuleLoading(true);
    setModuleError("");
    void Promise.all([
      boundedItems((options) =>
        listOpenViewDataSourceFields(moduleId, options),
      ),
      boundedItems((options) =>
        listOpenViewSavedViews({ moduleId, deleted: "include", ...options }),
      ),
      boundedItems((options) => listOpenViewPersonalDefaults(options)),
    ])
      .then(([fields, views, defaults]) => {
        if (request !== moduleRequest.current) return;
        setAuthorizationDenied(false);
        setModuleWorkspace({
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
        });
      })
      .catch((error: unknown) => {
        if (request !== moduleRequest.current) return;
        if (isAuthorizationDenied(error)) {
          markAuthorizationDenied();
          return;
        }
        setModuleError(
          messageFor(error, "The data source could not be loaded."),
        );
      })
      .finally(() => {
        if (request === moduleRequest.current) setModuleLoading(false);
      });
    return () => {
      moduleRequest.current += 1;
    };
  }, [markAuthorizationDenied, moduleId, moduleRetry]);

  const loadMoreCatalog = useCallback(async () => {
    if (!catalogHasMore || metadataLoadingMore) return;
    setMetadataLoadingMore(true);
    setMetadataError("");
    setMetadataRetryTarget(null);
    try {
      const page = await listOpenViewDataSources({
        limit: 100,
        offset: catalogNextOffset,
      });
      setCatalog((current) => [...(current ?? []), ...page.items]);
      setCatalogHasMore(page.pagination.hasMore);
      setCatalogNextOffset(catalogNextOffset + page.pagination.count);
    } catch (error) {
      setMetadataRetryTarget("catalog");
      setMetadataError(
        messageFor(error, "More data sources could not be loaded."),
      );
    } finally {
      setMetadataLoadingMore(false);
    }
  }, [catalogHasMore, catalogNextOffset, metadataLoadingMore]);

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
      setMetadataRetryTarget("module");
      setMetadataError(
        messageFor(error, "More saved-view metadata could not be loaded."),
      );
    } finally {
      setMetadataLoadingMore(false);
    }
  }, [metadataLoadingMore, moduleId, moduleWorkspace]);

  const loadMoreAudienceOptions = useCallback(async () => {
    if (metadataLoadingMore || (!roleOptionsHasMore && !userOptionsHasMore))
      return;
    setMetadataLoadingMore(true);
    setMetadataError("");
    setMetadataRetryTarget(null);
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
      setAudiences((current) => [
        ...current,
        ...(roles?.items ?? []),
        ...(users?.items ?? []),
      ]);
      if (roles) {
        setRoleOptionsHasMore(roles.pagination.hasMore);
        setRoleOptionsNextOffset(
          roleOptionsNextOffset + roles.pagination.count,
        );
      }
      if (users) {
        setUserOptionsHasMore(users.pagination.hasMore);
        setUserOptionsNextOffset(
          userOptionsNextOffset + users.pagination.count,
        );
      }
    } catch (error) {
      setMetadataRetryTarget("audience");
      setMetadataError(
        messageFor(error, "More audience options could not be loaded."),
      );
    } finally {
      setMetadataLoadingMore(false);
    }
  }, [
    metadataLoadingMore,
    roleOptionsHasMore,
    roleOptionsNextOffset,
    userOptionsHasMore,
    userOptionsNextOffset,
  ]);

  const refreshModule = useCallback(() => {
    setModuleRetry((value) => value + 1);
  }, []);

  const retryCatalog = useCallback(() => {
    setCatalogRetry((value) => value + 1);
  }, []);

  const retryMetadata = useCallback(() => {
    if (metadataRetryTarget === "catalog") void loadMoreCatalog();
    if (metadataRetryTarget === "module") void loadMoreModuleMetadata();
    if (metadataRetryTarget === "audience") void loadMoreAudienceOptions();
  }, [
    loadMoreAudienceOptions,
    loadMoreCatalog,
    loadMoreModuleMetadata,
    metadataRetryTarget,
  ]);

  return {
    catalog,
    catalogHasMore,
    catalogLoading,
    catalogError,
    audiences,
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
    markAuthorizationDenied,
  };
}
