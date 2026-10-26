"use client";

import { useEffect } from "react";
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
import type { OpenViewDashboard } from "../adapters/dashboards-api";
import { invalidatesRecords } from "../adapters/openview-queries";

/**
 * One department's dashboards (BD3): the home, the others by position, and a
 * dashboard named in the address. The list carries each dashboard whole, so
 * the home needs no second read; a dashboard outside the list (archived, or
 * a link from another department) is read on its own.
 */
export function useDepartmentDashboards(
  departmentId: string | undefined,
  dashboardId: string | undefined,
) {
  const client = useQueryClient();
  const list = useQuery(dashboardListOptions(departmentId ?? "", false));
  const dashboards = list.data?.items ?? [];
  const listed = dashboardId
    ? dashboards.find((dashboard) => dashboard.id === dashboardId)
    : undefined;
  const detail = useQuery({
    ...dashboardDetailOptions(dashboardId ?? ""),
    enabled:
      Boolean(dashboardId) && (!departmentId || (list.isFetched && !listed)),
  });
  const home =
    dashboards.find((dashboard) => dashboard.isHome) ?? dashboards[0] ?? null;
  const shown: OpenViewDashboard | null = dashboardId
    ? (listed ?? (detail.data?.id === dashboardId ? detail.data : null))
    : home;

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
          refresh(dashboardKeys.snapshots, (query) => {
            const sources = query.queryKey[4];
            return (
              every ||
              !sources ||
              (Array.isArray(sources)
                ? sources.some((moduleId) => affected.has(String(moduleId)))
                : affected.has(String(sources)))
            );
          });
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

  /** Keep a confirmed write; an older read must not replace it. */
  const remember = (dashboard: OpenViewDashboard) => {
    void client.cancelQueries({ queryKey: dashboardKeys.detail(dashboard.id) });
    client.setQueryData(dashboardKeys.detail(dashboard.id), dashboard);
    void client.invalidateQueries({ queryKey: dashboardKeys.lists });
  };
  const reload = async () => {
    await client.invalidateQueries({ queryKey: dashboardKeys.lists });
    if (dashboardId)
      await client.invalidateQueries({
        queryKey: dashboardKeys.detail(dashboardId),
      });
  };
  const error = list.error ?? (dashboardId && !listed ? detail.error : null);
  return {
    list,
    dashboards,
    home,
    shown,
    others: dashboards.filter((dashboard) => dashboard.id !== home?.id),
    loading:
      Boolean(departmentId) && list.isPending
        ? true
        : Boolean(dashboardId) && !shown && !detail.error && !list.error,
    error:
      error && !(list.isFetching || detail.isFetching)
        ? apiErrorMessage(error, "This dashboard could not be loaded.")
        : "",
    errorObject: error,
    remember,
    reload,
  };
}
