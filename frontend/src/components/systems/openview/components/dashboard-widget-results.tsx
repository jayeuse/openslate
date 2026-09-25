"use client";

import type { Dispatch, SetStateAction } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import type { OpenViewDataSourceField } from "../adapters/views-api";
import {
  DASHBOARD_PAGE_SIZE,
  type DraftWidget,
  type SnapshotState,
} from "../domain/dashboard-draft";
import { OpenViewChartPreview } from "./chart-preview";

const PREVIEW_POINTS = 12;

type DashboardWidgetResultsProps = {
  widget: DraftWidget;
  title: string;
  persisted: boolean;
  snapshot: SnapshotState | null;
  snapshotLoading: boolean;
  snapshotError: string;
  tablePage: number;
  fieldsByModule: Record<string, OpenViewDataSourceField[]>;
  onRefresh: () => void;
  setTablePage: Dispatch<SetStateAction<number>>;
};

function chartValues(
  result: OpenViewAggregateSnapshotResult,
  completeSeries: boolean,
) {
  const items = completeSeries
    ? result.items
    : result.items.slice(0, PREVIEW_POINTS);
  return items.map((item, index) => ({
    key: `dashboard-point-${index}`,
    label: item.label,
    value: Number.isFinite(Number(item.value)) ? Number(item.value) : 0,
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
  fieldsByModule,
  onRefresh,
  setTablePage,
}: DashboardWidgetResultsProps) {
  const activeIsDateSeries =
    widget.widgetType === "chart" && widget.config.query.mode === "date_series";
  const aggregateSnapshot =
    snapshot?.data.kind === "aggregate" ? snapshot.data.result : null;
  const recordsSnapshot =
    snapshot?.data.kind === "records" ? snapshot.data.result : null;
  const chartPreview =
    aggregateSnapshot && widget.widgetType === "chart"
      ? chartValues(aggregateSnapshot, activeIsDateSeries)
      : [];
  const chartPointDescription = activeIsDateSeries
    ? `${chartPreview.length} daily points; point labels and dots are suppressed`
    : `${chartPreview.length} categories`;
  const snapshotRows = aggregateSnapshot?.items ?? [];
  const tablePageCount = Math.max(
    1,
    Math.ceil(snapshotRows.length / DASHBOARD_PAGE_SIZE),
  );
  const boundedTablePage = Math.min(tablePage, tablePageCount - 1);
  const firstRowIndex = boundedTablePage * DASHBOARD_PAGE_SIZE;
  const visibleRows = snapshotRows.slice(
    firstRowIndex,
    firstRowIndex + DASHBOARD_PAGE_SIZE,
  );
  const recordsFields =
    widget.widgetType === "records"
      ? widget.config.query.definition.columns.map((column, index) => ({
          id: column.fieldId,
          name:
            fieldsByModule[widget.config.query.moduleId]?.find(
              (field) => field.id === column.fieldId,
            )?.name ?? `Field ${index + 1}`,
        }))
      : [];
  const summaryTotalRecords =
    aggregateSnapshot?.items.reduce(
      (total, item) => total + item.recordCount,
      0,
    ) ?? 0;
  const recordsPagination = recordsSnapshot?.pagination;

  return (
    <section
      aria-labelledby="dashboard-widget-preview"
      className="border-border flex min-w-0 flex-col gap-4 border-t pt-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="dashboard-widget-preview" className="text-lg font-semibold">
            {title}
          </h2>
          <p className="text-muted-foreground text-sm">
            {persisted
              ? widget.widgetType === "records"
                ? "Current records are loaded through the authorized query endpoint."
                : "Current aggregate values are loaded through the authorized snapshot endpoint."
              : "Save this Dashboard to load live data for the widget."}
          </p>
        </div>
        {persisted ? (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={snapshotLoading}
            onClick={onRefresh}
          >
            {snapshotLoading ? "Refreshing…" : "Refresh now"}
          </Button>
        ) : null}
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
      {snapshot &&
      snapshot.data.kind === "aggregate" &&
      widget.widgetType === "summary" ? (
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
        widget.widgetType === "workload" ? (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold">Workload breakdown</h3>
              <p role="status" className="text-muted-foreground text-sm">
                {snapshotRows.length
                  ? `${firstRowIndex + 1}–${Math.min(firstRowIndex + DASHBOARD_PAGE_SIZE, snapshotRows.length)} of ${snapshotRows.length} groups`
                  : "0 groups"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="min-h-11"
                disabled={boundedTablePage === 0}
                onClick={() => setTablePage((page) => Math.max(0, page - 1))}
              >
                Previous data page
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={boundedTablePage + 1 >= tablePageCount}
                onClick={() =>
                  setTablePage((page) => Math.min(tablePageCount - 1, page + 1))
                }
              >
                Next data page
              </Button>
            </div>
          </div>
          <div className="min-w-0 overflow-x-auto">
            <Table aria-label="Workload breakdown">
              <TableCaption>
                Group values and record counts from the current query.
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
                    <TableCell>{String(item.value)}</TableCell>
                    <TableCell>{item.recordCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : snapshot &&
        snapshot.data.kind === "records" &&
        widget.widgetType === "records" ? (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="status" className="text-muted-foreground text-sm">
              {recordsPagination?.count
                ? `${recordsPagination.offset + 1}–${recordsPagination.offset + recordsPagination.count} of ${recordsPagination.total} records`
                : `${recordsPagination?.total ?? 0} records`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="min-h-11"
                disabled={!recordsPagination || recordsPagination.offset === 0}
                onClick={() => setTablePage((page) => Math.max(0, page - 1))}
              >
                Previous records
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={!recordsPagination?.hasMore}
                onClick={() => setTablePage((page) => page + 1)}
              >
                Next records
              </Button>
            </div>
          </div>
          <div className="min-w-0 overflow-x-auto">
            <Table aria-label="Live records">
              <TableCaption>
                Current authorized records. Each page contains up to{" "}
                {DASHBOARD_PAGE_SIZE} rows.
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
                        {displayRecordValue(record.data[field.id])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : snapshot &&
        snapshot.data.kind === "aggregate" &&
        widget.widgetType === "chart" ? (
        <>
          <p role="status" className="text-muted-foreground text-sm">
            {activeIsDateSeries
              ? `Showing all ${snapshotRows.length} days in chronological order.`
              : `Preview shows up to ${Math.min(PREVIEW_POINTS, snapshotRows.length)} of ${snapshotRows.length} chart buckets. The complete values remain in the table.`}
          </p>
          <div
            role="group"
            aria-label={`${title} chart preview, ${chartPointDescription}`}
          >
            <OpenViewChartPreview
              data={chartPreview}
              type={widget.config.chartType}
              valueLabel={
                widget.config.query.aggregation === "count"
                  ? "Records"
                  : widget.config.query.aggregation
              }
              showLabels={false}
              showLegend={false}
              allowDecimals={widget.config.query.aggregation !== "count"}
              className="border-border/70 bg-muted/15 h-[18rem] w-full rounded-[var(--radius)] border p-3"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold">
                  {activeIsDateSeries
                    ? "Complete date series data"
                    : "Complete aggregate data"}
                </h3>
                <p role="status" className="text-muted-foreground text-sm">
                  {snapshotRows.length
                    ? `${firstRowIndex + 1}–${Math.min(firstRowIndex + DASHBOARD_PAGE_SIZE, snapshotRows.length)} of ${snapshotRows.length} ${activeIsDateSeries ? "daily values" : "aggregate groups"}`
                    : `0 ${activeIsDateSeries ? "daily values" : "aggregate groups"}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={boundedTablePage === 0}
                  onClick={() => setTablePage((page) => Math.max(0, page - 1))}
                >
                  Previous data page
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={boundedTablePage + 1 >= tablePageCount}
                  onClick={() =>
                    setTablePage((page) =>
                      Math.min(tablePageCount - 1, page + 1),
                    )
                  }
                >
                  Next data page
                </Button>
              </div>
            </div>
            <div className="min-w-0 overflow-x-auto">
              <Table aria-label={`Complete data for ${title}`}>
                <TableCaption>
                  Page {boundedTablePage + 1} of {tablePageCount}. The table
                  pages the complete authorized snapshot.
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
                      <TableCell>{String(item.value)}</TableCell>
                      <TableCell>{item.recordCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      ) : snapshotLoading ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading the selected widget data…
        </p>
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
