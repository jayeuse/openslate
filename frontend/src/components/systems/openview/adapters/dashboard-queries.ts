"use client";

import { queryOptions } from "@tanstack/react-query";
import {
  getOpenViewDashboard,
  listOpenViewDashboards,
  type OpenViewWidgetSource,
} from "./dashboards-api";
import {
  queryOpenViewAggregateSnapshot,
  queryOpenViewAggregateSnapshots,
} from "./analytics-api";
import { queryOpenViewRecords } from "./views-api";
import { listReadableRelationshipFields } from "./records-api";
import { ApiContractError } from "@/lib/api";
import {
  getOpenViewChart,
  chartMatchesWidget,
  chartSourceStamp,
} from "./charts-api";
import {
  DASHBOARD_PAGE_SIZE,
  configSignature,
  type DashboardWidgetData,
  type DraftWidget,
  type SnapshotState,
} from "../domain/dashboard-draft";

export const dashboardKeys = {
  all: ["openview", "dashboards"] as const,
  lists: ["openview", "dashboards", "list"] as const,
  /** One department's dashboards, active or archived (BD3). */
  list: (departmentId: string, archived: boolean) =>
    ["openview", "dashboards", "list", departmentId, archived] as const,
  details: ["openview", "dashboards", "detail"] as const,
  detail: (id: string) => ["openview", "dashboards", "detail", id] as const,
  snapshots: ["openview", "dashboards", "snapshot"] as const,
  dashboardSnapshots: (id: string) =>
    ["openview", "dashboards", "snapshot", id] as const,
};

/**
 * A department's dashboards by position: the home and the others (BD3). One
 * page holds them; a department has one home and rarely more than a few.
 */
export const dashboardListOptions = (departmentId: string, archived: boolean) =>
  queryOptions({
    queryKey: dashboardKeys.list(departmentId, archived),
    queryFn: () =>
      listOpenViewDashboards({
        limit: DASHBOARD_PAGE_SIZE,
        offset: 0,
        sortBy: "position",
        sortOrder: "asc",
        deleted: archived ? "only" : "exclude",
        departmentId,
      }),
    enabled: Boolean(departmentId),
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

export const dashboardRecordSnapshotOptions = (
  dashboardId: string,
  widget: DraftWidget | undefined,
  page: number,
  pageSize: number,
) =>
  queryOptions<DashboardWidgetData>({
    queryKey: [
      ...dashboardKeys.dashboardSnapshots(dashboardId),
      widget?.config?.query.moduleId ?? "",
      widget?.key ?? "",
      dashboardSnapshotSignature(widget, page, pageSize),
    ],
    // Snapshots change through the stream, the saved cadence, or Refresh now.
    // A visibility transition must not commit or repeat a canceled hidden read.
    staleTime: Infinity,
    enabled: Boolean(dashboardId && widget),
    queryFn: ({ signal }) => {
      if (!widget) throw new Error("Choose a saved Dashboard widget.");
      return queryDashboardWidgetData(widget, page, pageSize, signal);
    },
  });

export const dashboardAggregateSnapshotOptions = (
  dashboardId: string,
  widgets: readonly DraftWidget[],
) =>
  queryOptions<SnapshotState[]>({
    // Inline cohorts refresh when an included module changes. A referenced
    // Chart can move source, so its current authority must be checked for any
    // module invalidation. Results remain correlated by stable widget key.
    queryKey: [
      ...dashboardKeys.dashboardSnapshots(dashboardId),
      widgets.some((widget) => widget.chartId != null)
        ? ""
        : [...new Set(widgets.map((widget) => widget.config?.query.moduleId))],
      "aggregate",
      widgets.map((widget) => [widget.key, configSignature(widget)]),
    ],
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const definitions = await Promise.all(
        widgets.map((widget) =>
          resolveDashboardWidgetDefinition(widget, signal),
        ),
      );
      signal.throwIfAborted();
      const queries = definitions.map(({ config }) => {
        if (!("mode" in config.query)) throw new ApiContractError();
        return config.query;
      });
      const batch = await queryOpenViewAggregateSnapshots(queries);
      signal.throwIfAborted();
      return widgets.map((widget, index) => ({
        widgetKey: widget.key,
        configSignature: configSignature(widget),
        data: {
          ...definitions[index],
          kind: "aggregate",
          result: batch.items[index],
        },
      }));
    },
  });

/** Fresh source authority is shared by grid reads, editor opening and previews. */
export async function resolveDashboardWidgetDefinition(
  widget: OpenViewWidgetSource,
  signal: AbortSignal,
) {
  let config = widget.config;
  let sourceStamp = JSON.stringify(widget);
  let sourceName: string | null = null;
  if (widget.chartId != null) {
    const chart = await getOpenViewChart(widget.chartId, signal);
    if (!chartMatchesWidget(chart, widget.widgetType))
      throw new ApiContractError();
    config = chart.config;
    sourceStamp = chartSourceStamp(chart);
    sourceName = chart.name;
  }
  signal.throwIfAborted();
  if (!config) throw new ApiContractError();
  return { config, sourceStamp, sourceName };
}

/** Both persisted results and a real, unpersisted dialog draft use this read.
 * No Dashboard or widget identity is fabricated to enable a saved-only hook. */
export async function queryDashboardWidgetData(
  widget: OpenViewWidgetSource,
  page: number,
  pageSize: number,
  signal: AbortSignal,
): Promise<DashboardWidgetData> {
  const resolved = await resolveDashboardWidgetDefinition(widget, signal);
  const { config } = resolved;
  let data: DashboardWidgetData;
  if (widget.widgetType === "records") {
    if ("mode" in config.query) throw new ApiContractError();
    data = {
      ...resolved,
      kind: "records",
      result: await queryOpenViewRecords({
        moduleId: config.query.moduleId,
        definition: config.query.definition,
        limit: pageSize,
        offset: page * pageSize,
      }),
    };
  } else {
    if (!("mode" in config.query)) throw new ApiContractError();
    data = {
      ...resolved,
      kind: "aggregate",
      result: await queryOpenViewAggregateSnapshot(config.query),
    };
  }
  signal.throwIfAborted();
  return data;
}

/** Relationship fields of readable modules, for the linked sources (BD11). */
export const linkedFieldsOptions = () =>
  queryOptions({
    queryKey: ["openview", "fields", "relationships-readable"] as const,
    queryFn: ({ signal }) => listReadableRelationshipFields(signal),
  });

/**
 * The modules a department's dashboard may read (BE2): its own, then every
 * module a relationship field links to one of them, in either direction.
 */
export function linkedModuleIds(
  ownModuleIds: ReadonlySet<string>,
  fields: readonly { moduleId: string; targetModuleId: string | null }[],
): Set<string> {
  const linked = new Set<string>();
  for (const field of fields) {
    if (!field.targetModuleId) continue;
    if (ownModuleIds.has(field.moduleId)) linked.add(field.targetModuleId);
    if (ownModuleIds.has(field.targetModuleId)) linked.add(field.moduleId);
  }
  for (const id of ownModuleIds) linked.delete(id);
  return linked;
}
