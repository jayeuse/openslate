"use client";

import { useState } from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { dashboardKeys } from "../adapters/dashboard-queries";
import { fieldsFirstPageOptions } from "../adapters/openview-queries";
import type { OpenViewDashboard } from "../adapters/dashboards-api";
import type { OpenViewAggregateSnapshotRequest } from "../adapters/analytics-api";
import type { OpenViewDataSourceField } from "../adapters/views-api";
import { useOpenViewSelectedFields } from "../hooks/use-openview-catalog";
import {
  useDashboardAggregateSnapshots,
  useDashboardRecordSnapshot,
  useDashboardVisibility,
  savedWidgetUnchanged,
} from "../hooks/use-dashboard-snapshot";
import { aggregationLabel } from "../domain/chart-query";
import {
  DASHBOARD_PAGE_SIZE,
  type DraftWidget,
  type SnapshotState,
} from "../domain/dashboard-draft";
import { DashboardWidgetResults } from "./dashboard-widget-results";

type GridProps = {
  dashboard: OpenViewDashboard | null;
  widgets: DraftWidget[];
  dirty: boolean;
  loading: boolean;
  canManage: boolean;
  pending: boolean;
  onAdd: (saved: boolean) => void;
  onEdit: (widget: DraftWidget) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  onRemove: (key: string) => void;
};

function widgetTitle(
  widget: DraftWidget,
  fields: readonly OpenViewDataSourceField[],
  snapshot: SnapshotState | null,
) {
  if (widget.chartId != null) return snapshot?.data.sourceName ?? "Saved Chart";
  const config = widget.config;
  if (!config) return "Saved Chart";
  const query = config.query;
  const fieldName = (id?: string) =>
    fields.find((field) => field.id === id)?.name;
  if (widget.widgetType === "records")
    return fieldName(query.definition.columns[0]?.fieldId)
      ? `Records showing ${fieldName(query.definition.columns[0]?.fieldId)}`
      : "Live records";
  if (!("mode" in query)) return "Widget";
  const operation = aggregationLabel(query.aggregation);
  if (query.mode === "date_series")
    return `${operation}${query.measure ? ` of ${fieldName(query.measure.fieldId) ?? "selected measure"}` : ""} over time`;
  const dimension = fieldName(query.dimension.fieldId) ?? "selected field";
  if (widget.widgetType === "workload") return `Workload by ${dimension}`;
  if (widget.widgetType === "summary")
    return `${query.aggregation === "count" ? "Total records" : operation} by ${dimension}`;
  return `${operation}${query.measure ? ` of ${fieldName(query.measure.fieldId) ?? "selected measure"}` : ""} by ${dimension}`;
}

export function DashboardWidgetGrid(props: GridProps) {
  const client = useQueryClient();
  const visible = useDashboardVisibility();
  const aggregate = useDashboardAggregateSnapshots(
    props.dashboard,
    props.widgets,
    visible,
    props.dirty,
  );
  const queryKey = dashboardKeys.dashboardSnapshots(props.dashboard?.id ?? "");
  const fetching = useIsFetching({ queryKey }) > 0;
  const unavailable = props.pending || Boolean(props.dashboard?.isDeleted);
  const hasLive = props.widgets.some((widget) =>
    savedWidgetUnchanged(props.dashboard, widget),
  );
  return (
    <section aria-labelledby="dashboard-widgets" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2
            id="dashboard-widgets"
            className="text-lg font-semibold"
            data-slot="section-title"
          >
            Widgets
          </h2>
          <p role="status" className="text-muted-foreground text-sm">
            {props.widgets.length} of 12 widgets
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {hasLive && !props.dashboard?.isDeleted ? (
            <Button
              variant="outline"
              className="min-h-11"
              disabled={!visible || fetching}
              onClick={() =>
                void client.refetchQueries({ queryKey, type: "active" })
              }
            >
              <RefreshCw aria-hidden="true" data-icon="inline-start" />
              {fetching ? "Refreshing…" : "Refresh now"}
            </Button>
          ) : null}
          {props.canManage ? (
            <>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={unavailable || props.widgets.length >= 12}
                onClick={() => props.onAdd(true)}
              >
                Add from saved chart
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={unavailable || props.widgets.length >= 12}
                onClick={() => props.onAdd(false)}
              >
                <Plus aria-hidden="true" data-icon="inline-start" />
                Add widget
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {aggregate.error ? (
        <Alert role="alert" variant="destructive">
          {aggregate.error}{" "}
          {aggregate.data
            ? "The last successful data remains visible."
            : "Retry when access is available."}
          <Button
            variant="outline"
            className="mt-3 min-h-11"
            disabled={aggregate.loading}
            onClick={aggregate.refresh}
          >
            Retry widgets
          </Button>
        </Alert>
      ) : null}
      {props.loading ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading Dashboard…
        </p>
      ) : props.widgets.length ? (
        <div className="grid min-w-0 grid-cols-1 items-start gap-4 md:grid-cols-6">
          {props.widgets.map((widget, index) => {
            const tileProps = { ...props, widget, index, visible };
            return widget.widgetType === "records" ? (
              <DashboardRecordTile key={widget.key} {...tileProps} />
            ) : (
              <DashboardTile
                key={widget.key}
                {...tileProps}
                persisted={savedWidgetUnchanged(props.dashboard, widget)}
                snapshot={
                  aggregate.data?.find(
                    (item) => item.widgetKey === widget.key,
                  ) ?? null
                }
                snapshotLoading={aggregate.loading}
                snapshotError=""
                onRefresh={aggregate.refresh}
              />
            );
          })}
        </div>
      ) : (
        <div className="border-border bg-card flex min-h-64 flex-col justify-center gap-2 rounded-[var(--radius)] border p-5">
          <h2 data-slot="empty-title" className="text-lg font-semibold">
            {props.dashboard
              ? "No widgets in this Dashboard"
              : "Select a Dashboard to begin"}
          </h2>
          <p className="text-muted-foreground text-sm">
            {props.dashboard
              ? props.dashboard.isDeleted
                ? "Restore this Dashboard to add or change widgets."
                : "Add a widget to your draft, then save the Dashboard to load its live result."
              : "Choose a Dashboard from a department you can read."}
          </p>
        </div>
      )}
    </section>
  );
}

type TileProps = GridProps & {
  widget: DraftWidget;
  index: number;
  visible: boolean;
  snapshot: SnapshotState | null;
  persisted: boolean;
  snapshotLoading: boolean;
  snapshotError: string;
  onRefresh: () => void;
};

// Record requests remain bounded and independent; paging belongs to the stable
// tile key, never its position. They are not part of AggregateQuery's wire type.
function DashboardRecordTile(
  props: GridProps & { widget: DraftWidget; index: number; visible: boolean },
) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DASHBOARD_PAGE_SIZE);
  const read = useDashboardRecordSnapshot(
    props.dashboard,
    props.widget,
    props.visible,
    props.dirty,
    page,
    pageSize,
  );
  return (
    <DashboardTile
      {...props}
      persisted={read.persisted}
      snapshot={read.snapshot}
      snapshotLoading={read.loading}
      snapshotError={read.error}
      onRefresh={read.refresh}
      paging={{ page, pageSize, setPage, setPageSize }}
    />
  );
}

function DashboardTile(
  props: TileProps & {
    paging?: {
      page: number;
      pageSize: number;
      setPage: React.Dispatch<React.SetStateAction<number>>;
      setPageSize: React.Dispatch<React.SetStateAction<number>>;
    };
  },
) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DASHBOARD_PAGE_SIZE);
  const config = props.snapshot?.data.config ?? props.widget.config;
  const moduleId = config?.query.moduleId ?? "";
  const first = useQuery({
    ...fieldsFirstPageOptions(moduleId),
    enabled: Boolean(moduleId),
  });
  const query = config?.query;
  const aggregateQuery =
    query &&
    "mode" in query &&
    (query.mode === "groups" || query.mode === "date_series")
      ? (query as OpenViewAggregateSnapshotRequest)
      : null;
  const ids = query
    ? [
        ...query.definition.columns,
        ...query.definition.filters,
        ...query.definition.sort,
        ...query.definition.searchFields,
        ...(aggregateQuery
          ? [
              aggregateQuery.measure,
              aggregateQuery.dateField,
              ...(aggregateQuery.mode === "groups"
                ? [aggregateQuery.dimension]
                : []),
            ].filter((ref) => ref !== undefined)
          : []),
      ].map((ref) => ref.fieldId)
    : [];
  const fields = useOpenViewSelectedFields(moduleId, first.data?.items, ids);
  const title = widgetTitle(props.widget, fields.items, props.snapshot);
  const unavailable =
    !props.canManage || props.pending || Boolean(props.dashboard?.isDeleted);
  const paging = props.paging ?? { page, pageSize, setPage, setPageSize };
  return (
    <Card
      role="article"
      aria-label={title}
      className={`min-w-0 ${props.widget.size === "S" ? "md:col-span-2" : props.widget.size === "L" ? "md:col-span-6" : "md:col-span-3"}`}
    >
      <CardContent className="min-w-0 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">
            {props.widget.widgetType === "chart"
              ? config && "chartType" in config
                ? `${config.chartType === "pie" ? "Pie" : config.chartType === "line" ? "Line" : "Bar"} chart`
                : "Chart"
              : props.widget.widgetType === "records"
                ? "Records"
                : props.widget.widgetType === "summary"
                  ? "Summary"
                  : "Workload"}{" "}
            · {props.widget.size ?? "M"}
            {props.persisted ? "" : " · Unsaved"}
          </p>
          {props.canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 shrink-0"
                    aria-label={`Widget options: ${title}`}
                    disabled={unavailable}
                  />
                }
              >
                <MoreHorizontal aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="min-h-11"
                  disabled={unavailable}
                  onClick={() => props.onEdit(props.widget)}
                >
                  Edit widget
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-h-11"
                  disabled={unavailable || props.index === 0}
                  onClick={() => props.onMove(props.widget.key, -1)}
                >
                  Move earlier
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-h-11"
                  disabled={
                    unavailable || props.index === props.widgets.length - 1
                  }
                  onClick={() => props.onMove(props.widget.key, 1)}
                >
                  Move later
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="min-h-11"
                  variant="destructive"
                  disabled={unavailable}
                  onClick={() => props.onRemove(props.widget.key)}
                >
                  Remove widget
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <DashboardWidgetResults
          widget={props.widget}
          title={title}
          persisted={props.persisted}
          snapshot={props.snapshot}
          snapshotLoading={props.snapshotLoading}
          snapshotError={props.snapshotError}
          tablePage={paging.page}
          tablePageSize={paging.pageSize}
          fieldsByModule={{ [moduleId]: fields.items }}
          onRefresh={props.onRefresh}
          setTablePage={paging.setPage}
          setTablePageSize={paging.setPageSize}
        />
      </CardContent>
    </Card>
  );
}
