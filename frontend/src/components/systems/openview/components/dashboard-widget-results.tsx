"use client";

import type { Dispatch, SetStateAction } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TablePagination } from "@/components/ui/table-pagination";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { OpenViewAggregateSnapshotResult } from "../adapters/analytics-api";
import type { OpenViewAggregateSnapshotRequest } from "../adapters/analytics-api";
import type {
  OpenViewDashboardWidgetConfig,
  OpenViewDashboardChartConfig,
} from "../adapters/dashboards-api";
import type { OpenViewDataSourceField } from "../adapters/views-api";
import { openViewRecordFieldValue } from "../domain/record-display";
import {
  type DraftWidget,
  type SnapshotState,
} from "../domain/dashboard-draft";
import { OpenViewChartPreview } from "./chart-preview";

const PREVIEW_POINTS = 12;
function aggregateDefinition(
  query: OpenViewDashboardWidgetConfig["query"],
): query is OpenViewAggregateSnapshotRequest {
  return (
    "mode" in query && (query.mode === "groups" || query.mode === "date_series")
  );
}
function chartDefinition(
  config: OpenViewDashboardWidgetConfig,
): config is OpenViewDashboardChartConfig {
  return "chartType" in config;
}

type DashboardWidgetResultsProps = {
  widget: DraftWidget;
  title: string;
  persisted: boolean;
  snapshot: SnapshotState | null;
  snapshotLoading: boolean;
  snapshotError: string;
  tablePage: number;
  tablePageSize: number;
  fieldsByModule: Record<string, OpenViewDataSourceField[]>;
  onRefresh: () => void;
  setTablePage: Dispatch<SetStateAction<number>>;
  setTablePageSize: Dispatch<SetStateAction<number>>;
};

function chartValues(
  result: OpenViewAggregateSnapshotResult,
  completeSeries: boolean,
) {
  const items = completeSeries
    ? result.items
    : result.items
        .filter((item) => item.value !== null)
        .slice(0, PREVIEW_POINTS);
  return items.map((item, index) => ({
    key: `dashboard-point-${index}`,
    label: item.label,
    value:
      item.value === null
        ? null
        : Number.isFinite(Number(item.value))
          ? Number(item.value)
          : null,
  }));
}

function displayRecordValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value))
    return value.map((item) => displayRecordValue(item)).join(", ");
  return "—";
}

export function DashboardWidgetResults({
  widget,
  title,
  persisted,
  snapshot,
  snapshotLoading,
  snapshotError,
  tablePage,
  tablePageSize,
  fieldsByModule,
  onRefresh,
  setTablePage,
  setTablePageSize,
}: DashboardWidgetResultsProps) {
  const config = snapshot?.data.config ?? widget.config ?? null;
  const aggregateQuery =
    config !== null && aggregateDefinition(config.query) ? config.query : null;
  const chartConfig =
    config !== null && chartDefinition(config) ? config : null;
  const activeIsDateSeries =
    widget.widgetType === "chart" && aggregateQuery?.mode === "date_series";
  const aggregateSnapshot =
    snapshot?.data.kind === "aggregate" ? snapshot.data.result : null;
  const recordsSnapshot =
    snapshot?.data.kind === "records" ? snapshot.data.result : null;
  const chartPreview =
    aggregateSnapshot && widget.widgetType === "chart"
      ? chartValues(aggregateSnapshot, activeIsDateSeries)
      : [];
  const bucket =
    widget.widgetType === "chart" && aggregateQuery?.mode === "date_series"
      ? (aggregateQuery.bucket ?? "day")
      : "day";
  const periods =
    bucket === "day"
      ? "days"
      : bucket === "week"
        ? "weeks"
        : bucket === "month"
          ? "months"
          : bucket === "quarter"
            ? "quarters"
            : "years";
  const chartPointDescription = activeIsDateSeries
    ? `${chartPreview.length} ${bucket === "day" ? "daily" : bucket} points; point labels and dots are suppressed`
    : `${chartPreview.length} categories`;
  const snapshotRows = aggregateSnapshot?.items ?? [];
  const tablePageCount = Math.max(
    1,
    Math.ceil(snapshotRows.length / tablePageSize),
  );
  const boundedTablePage = Math.min(tablePage, tablePageCount - 1);
  const firstRowIndex = boundedTablePage * tablePageSize;
  const visibleRows = snapshotRows.slice(
    firstRowIndex,
    firstRowIndex + tablePageSize,
  );
  const recordsFields =
    widget.widgetType === "records" && config !== null
      ? config.query.definition.columns.map((column, index) => {
          const field = fieldsByModule[config.query.moduleId]?.find(
            (candidate) => candidate.id === column.fieldId,
          );
          return {
            id: column.fieldId,
            name: field?.name ?? `Field ${index + 1}`,
            type: field?.type ?? column.expectedType,
          };
        })
      : [];
  const summaryTotalRecords =
    aggregateSnapshot?.items.reduce(
      (total, item) => total + item.recordCount,
      0,
    ) ?? 0;
  const recordsPagination = recordsSnapshot?.pagination;
  const updatePageSize = (size: number) => {
    setTablePageSize(size);
    setTablePage(0);
  };

  return (
    <section
      aria-labelledby="dashboard-widget-preview"
      className="border-border flex min-w-0 flex-col gap-4 border-t pt-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            data-slot="section-title"
            id="dashboard-widget-preview"
            className="text-lg font-semibold"
          >
            {title}
          </h2>
          <p className="text-muted-foreground text-sm">
            {persisted
              ? widget.widgetType === "records"
                ? "Current records from the selected data source."
                : "Current results from the selected data source."
              : "Save this Dashboard to load live data for the widget."}
          </p>
        </div>
      </div>
      {snapshotError ? (
        <Alert role="alert" variant="destructive">
          {snapshotError}
          {snapshot
            ? " The last successful data remains visible."
            : " Retry when access is available."}
          {persisted && !snapshotLoading ? (
            <Button
              className="mt-3 min-h-11"
              variant="outline"
              onClick={onRefresh}
            >
              Retry widget
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {snapshotLoading && !snapshot ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading current data…
        </p>
      ) : null}
      {snapshot &&
      snapshot.data.kind === "aggregate" &&
      widget.widgetType === "summary" &&
      widget.chartId == null &&
      aggregateQuery?.aggregation === "count" ? (
        <Card className="max-w-xl">
          <CardContent className="flex flex-col gap-2 pt-6">
            <p className="text-muted-foreground text-sm">
              Total records across {aggregateSnapshot?.items.length ?? 0} groups
            </p>
            <p className="text-3xl font-semibold">
              Total records: {summaryTotalRecords}
            </p>
          </CardContent>
        </Card>
      ) : snapshot &&
        snapshot.data.kind === "aggregate" &&
        (widget.widgetType === "workload" ||
          widget.widgetType === "summary") ? (
        <div className="flex min-w-0 flex-col gap-3">
          <h3 data-slot="section-title" className="font-semibold">
            Workload breakdown
          </h3>
          <div className="min-w-0 overflow-x-auto">
            <Table aria-label="Workload breakdown">
              <TableCaption>
                Group values and record counts for this Dashboard.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Group</TableHead>
                  <TableHead>Aggregate value</TableHead>
                  <TableHead>Record count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((item, index) => (
                  <TableRow
                    key={`${item.key ?? item.label}-${firstRowIndex + index}`}
                  >
                    <TableCell>{item.label}</TableCell>
                    <TableCell>
                      {item.value === null ? "—" : String(item.value)}
                    </TableCell>
                    <TableCell>{item.recordCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <TablePagination
            ariaLabel="Dashboard result pages"
            total={snapshotRows.length}
            offset={firstRowIndex}
            rowCount={visibleRows.length}
            pageSize={tablePageSize}
            onPageIndexChange={setTablePage}
            onPageSizeChange={updatePageSize}
          />
        </div>
      ) : snapshot &&
        snapshot.data.kind === "records" &&
        widget.widgetType === "records" ? (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="min-w-0 overflow-x-auto">
            <Table aria-label="Live records">
              <TableCaption>
                Current records from this Dashboard. Each page contains up to{" "}
                {recordsPagination?.limit ?? tablePageSize} rows.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  {recordsFields.map((field) => (
                    <TableHead key={field.id}>{field.name}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {recordsSnapshot?.items.map((record) => (
                  <TableRow key={record.id}>
                    {recordsFields.map((field) => (
                      <TableCell key={field.id}>
                        {displayRecordValue(
                          openViewRecordFieldValue(record, field),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <TablePagination
            ariaLabel="Dashboard result pages"
            total={recordsPagination?.total ?? 0}
            offset={recordsPagination?.offset ?? 0}
            rowCount={recordsPagination?.count ?? 0}
            pageSize={recordsPagination?.limit ?? tablePageSize}
            onPageIndexChange={setTablePage}
            onPageSizeChange={updatePageSize}
          />
        </div>
      ) : snapshot &&
        snapshot.data.kind === "aggregate" &&
        widget.widgetType === "chart" ? (
        <>
          <p role="status" className="text-muted-foreground text-sm">
            {activeIsDateSeries
              ? `Showing all ${snapshotRows.length} ${periods} in chronological order.`
              : `Preview shows up to ${Math.min(PREVIEW_POINTS, snapshotRows.length)} of ${snapshotRows.length} chart buckets. The complete values remain in the table.`}
          </p>
          <div
            role="group"
            aria-label={`${title} chart preview, ${chartPointDescription}`}
          >
            <OpenViewChartPreview
              data={chartPreview}
              type={chartConfig?.chartType ?? "bar"}
              valueLabel={
                aggregateQuery?.aggregation === "count"
                  ? "Records"
                  : (aggregateQuery?.aggregation ?? "count")
              }
              showLabels={false}
              showLegend={false}
              allowDecimals={aggregateQuery?.aggregation !== "count"}
              className="border-border/70 bg-muted/15 [&_.recharts-cartesian-axis-tick-value]:fill-muted-foreground [&_.recharts-label]:fill-foreground h-[18rem] w-full rounded-[var(--radius)] border p-3"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <h3 data-slot="section-title" className="font-semibold">
              {activeIsDateSeries
                ? "Complete date series data"
                : "Complete aggregate data"}
            </h3>
            <div className="min-w-0 overflow-x-auto">
              <Table aria-label={`Complete data for ${title}`}>
                <TableCaption>
                  Complete results for the current Dashboard widget.
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {activeIsDateSeries ? "Date" : "Group"}
                    </TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Record count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.map((item, index) => (
                    <TableRow
                      key={`${item.key ?? item.label}-${firstRowIndex + index}`}
                    >
                      <TableCell>{item.label}</TableCell>
                      <TableCell>
                        {item.value === null ? "—" : String(item.value)}
                      </TableCell>
                      <TableCell>{item.recordCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <TablePagination
              ariaLabel="Dashboard result pages"
              total={snapshotRows.length}
              offset={firstRowIndex}
              rowCount={visibleRows.length}
              pageSize={tablePageSize}
              onPageIndexChange={setTablePage}
              onPageSizeChange={updatePageSize}
            />
          </div>
        </>
      ) : persisted && !snapshotError ? (
        <p className="text-muted-foreground text-sm">
          {widget.widgetType === "records"
            ? "No matching records were found."
            : widget.widgetType === "summary"
              ? "No matching records were found for this summary."
              : "No aggregate data is available yet."}
        </p>
      ) : null}
    </section>
  );
}
