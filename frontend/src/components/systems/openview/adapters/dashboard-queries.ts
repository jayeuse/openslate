"use client";

import { queryOptions } from "@tanstack/react-query";
import { getOpenViewDashboard, listOpenViewDashboards } from "./dashboards-api";
import { queryOpenViewAggregateSnapshot } from "./analytics-api";
import { queryOpenViewRecords } from "./views-api";
import {
  DASHBOARD_PAGE_SIZE,
  configSignature,
  type DashboardWidgetData,
  type DraftWidget,
} from "../domain/dashboard-draft";

export const dashboardKeys = {
  all: ["openview", "dashboards"] as const,
  lists: ["openview", "dashboards", "list"] as const,
  list: (archived: boolean) =>
    ["openview", "dashboards", "list", archived] as const,
  details: ["openview", "dashboards", "detail"] as const,
  detail: (id: string) => ["openview", "dashboards", "detail", id] as const,
  snapshots: ["openview", "dashboards", "snapshot"] as const,
  dashboardSnapshots: (id: string) =>
    ["openview", "dashboards", "snapshot", id] as const,
};

export const dashboardListOptions = (archived: boolean) =>
  queryOptions({
    queryKey: dashboardKeys.list(archived),
    queryFn: () =>
      listOpenViewDashboards({
        limit: DASHBOARD_PAGE_SIZE,
        offset: 0,
        sortBy: "position",
        sortOrder: "asc",
        deleted: archived ? "only" : "exclude",
      }),
  });

export const dashboardDetailOptions = (id: string) =>
  queryOptions({
    queryKey: dashboardKeys.detail(id),
    queryFn: () => getOpenViewDashboard(id),
    enabled: Boolean(id),
    // Keep the cached frame on selection, but read the current revision and
    // lifecycle state before relying on a detail from an earlier selection.
    staleTime: 0,
  });

export function dashboardSnapshotSignature(
  widget: DraftWidget | undefined,
  page: number,
  pageSize: number,
): string {
  const signature = configSignature(widget, page);
  return widget?.widgetType === "records"
    ? JSON.stringify({ signature, pageSize })
    : signature;
}

export const dashboardSnapshotOptions = (
  dashboardId: string,
  widget: DraftWidget | undefined,
  page: number,
  pageSize: number,
  interval: number | false,
) =>
  queryOptions({
    queryKey: [
      ...dashboardKeys.dashboardSnapshots(dashboardId),
      widget?.config.query.moduleId ?? "",
      widget?.key ?? "",
      dashboardSnapshotSignature(widget, page, pageSize),
    ],
    // Snapshots change through the stream, the saved cadence, or Refresh now.
    // A visibility transition must not commit or repeat a canceled hidden read.
    staleTime: Infinity,
    enabled: Boolean(dashboardId && widget),
    refetchIntervalInBackground: false,
    refetchInterval: (candidate) => {
      if (interval === false || candidate.state.fetchStatus !== "idle")
        return false;
      const finished = Math.max(
        candidate.state.dataUpdatedAt,
        candidate.state.errorUpdatedAt,
      );
      // Query restarts its interval when the fetch settles. Returning from a
      // short pause keeps that same deadline rather than starting a new one.
      return Math.max(1, interval - (finished ? Date.now() - finished : 0));
    },
    queryFn: async (): Promise<DashboardWidgetData> => {
      if (!widget) throw new Error("Choose a saved Dashboard widget.");
      return widget.widgetType === "records"
        ? {
            kind: "records",
            result: await queryOpenViewRecords({
              moduleId: widget.config.query.moduleId,
              definition: widget.config.query.definition,
              limit: pageSize,
              offset: page * pageSize,
            }),
          }
        : {
            kind: "aggregate",
            result: await queryOpenViewAggregateSnapshot(widget.config.query),
          };
    },
  });
