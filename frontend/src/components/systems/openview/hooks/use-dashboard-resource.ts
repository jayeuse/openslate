"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useQuery,
  useQueryClient,
  type Query,
  type QueryKey,
} from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/api-errors";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";
import {
  dashboardDetailOptions,
  dashboardKeys,
  dashboardListOptions,
} from "../adapters/dashboard-queries";
import {
  listOpenViewDashboards,
  type OpenViewDashboard,
} from "../adapters/dashboards-api";
import {
  extendsRead,
  invalidatesRecords,
  readStamp,
} from "../adapters/openview-queries";
import { DASHBOARD_PAGE_SIZE } from "../domain/dashboard-draft";

type Extension = {
  readAt: number;
  items: OpenViewDashboard[];
  hasMore: boolean;
  nextOffset: number;
};

export function useDashboardResource(
  archived: boolean,
  id: string | undefined,
  routeClearPending: boolean,
) {
  const client = useQueryClient();
  const list = useQuery(dashboardListOptions(archived));
  const detail = useQuery({
    ...dashboardDetailOptions(id ?? ""),
    enabled: Boolean(id) && !routeClearPending,
  });
  const [extension, setExtension] = useState<Extension | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setLoadingMore(false);
    setPageError("");
  }, [archived, list.dataUpdatedAt]);
  const readAt = readStamp(list);
  const more =
    extension && extendsRead(extension.readAt, list) ? extension : null;
  const dashboards = useMemo(
    () => [...(list.data?.items ?? []), ...(more?.items ?? [])],
    [list.data, more],
  );
  const hasMore = more?.hasMore ?? list.data?.pagination.hasMore ?? false;

  const refreshList = useCallback(() => {
    generation.current += 1;
    setLoadingMore(false);
    setPageError("");
    void client.invalidateQueries({ queryKey: dashboardKeys.lists });
  }, [client]);

  const loadMore = async () => {
    const base = list.data;
    if (!base || !readAt || !hasMore || loadingMore) return;
    const started = generation.current;
    const offset = more?.nextOffset ?? base.pagination.count;
    setLoadingMore(true);
    setPageError("");
    try {
      const page = await listOpenViewDashboards({
        limit: DASHBOARD_PAGE_SIZE,
        offset,
        sortBy: "position",
        sortOrder: "asc",
        deleted: archived ? "only" : "exclude",
      });
      if (generation.current !== started) return;
      setExtension({
        readAt,
        items: [...(more?.items ?? []), ...page.items],
        hasMore: page.pagination.hasMore,
        nextOffset: offset + page.pagination.count,
      });
    } catch (error) {
      if (generation.current === started)
        setPageError(
          apiErrorMessage(error, "More Dashboards could not be loaded."),
        );
    } finally {
      if (generation.current === started) setLoadingMore(false);
    }
  };

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let all = false;
    let metadata = false;
    let everyModule = false;
    const modules = new Set<string>();
    const refresh = (
      key: QueryKey,
      matches: (query: Query) => boolean = () => true,
    ) => {
      const cold = client
        .getQueryCache()
        .findAll({ queryKey: key, fetchStatus: "fetching" })
        .filter((query) => matches(query) && query.state.data === undefined);
      void Promise.all(
        cold.map((query) => query.cancel({ revert: true })),
      ).then(() =>
        client.invalidateQueries({ queryKey: key, predicate: matches }),
      );
    };
    const flush = () => {
      timer = undefined;
      if (all) refresh(dashboardKeys.all);
      else {
        if (metadata) {
          refresh(dashboardKeys.lists);
          refresh(dashboardKeys.details);
        }
        if (everyModule || modules.size) {
          const affected = new Set(modules);
          const every = everyModule;
          refresh(
            dashboardKeys.snapshots,
            (query) =>
              every ||
              !query.queryKey[4] ||
              affected.has(String(query.queryKey[4])),
          );
        }
      }
      all = metadata = everyModule = false;
      modules.clear();
    };
    const unsubscribe = subscribeWorkspaceInvalidations(
      (event) => {
        if (event.type === "resync") all = true;
        else if (event.entity === "dashboards") metadata = true;
        else if (invalidatesRecords(event.entity)) {
          if (event.moduleId) modules.add(event.moduleId);
          else everyModule = true;
          if (
            event.entity !== "records" &&
            event.entity !== "relationships" &&
            event.entity !== "charts"
          )
            metadata = true;
        } else return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(flush, 300);
      },
      () => refresh(dashboardKeys.all),
    );
    return () => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      void client.invalidateQueries({
        queryKey: dashboardKeys.all,
        refetchType: "none",
      });
    };
  }, [client]);

  const remember = (dashboard: OpenViewDashboard) => {
    // An older read must not replace a mutation response we just accepted.
    void client.cancelQueries({ queryKey: dashboardKeys.detail(dashboard.id) });
    client.setQueryData(dashboardKeys.detail(dashboard.id), dashboard);
  };
  const reload = async (dashboardId: string) => {
    await client.invalidateQueries({
      queryKey: dashboardKeys.detail(dashboardId),
      refetchType: "none",
    });
    return client.fetchQuery(dashboardDetailOptions(dashboardId));
  };
  return {
    dashboards,
    hasMore,
    loading: list.isPending,
    loadingMore,
    error:
      pageError ||
      (list.error && !list.isFetching
        ? apiErrorMessage(list.error, "Dashboards could not be loaded.")
        : ""),
    detail,
    refreshList,
    loadMore,
    remember,
    reload,
  };
}
