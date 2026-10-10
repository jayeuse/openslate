"use client";

import { Download, Printer } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TablePagination } from "@/components/ui/table-pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { serializeCsv } from "@/lib/csv";
import type {
  OpenViewAggregateDatum,
  OpenViewAggregateSnapshotRequest,
  OpenViewAggregateSnapshotResult,
} from "../adapters/analytics-api";
import type { ChartType } from "../domain/chart-query";
import { OpenViewChartPreview } from "./chart-preview";

const MAX_CATEGORICAL_PREVIEW_POINTS = 100;

export type AppliedSnapshot = {
  result: OpenViewAggregateSnapshotResult;
  request: OpenViewAggregateSnapshotRequest;
  sourceName: string;
  chartType: ChartType;
  labelName: string;
  valueName: string;
  aggregationName: string;
  signature: string;
};

type ChartSnapshotResultsProps = {
  applied: AppliedSnapshot | null;
  draftSignature: string;
  top: string;
  showValues: boolean;
  showLegend: boolean;
  tablePage: number;
  tablePageSize: number;
  setTablePage: Dispatch<SetStateAction<number>>;
  setTablePageSize: Dispatch<SetStateAction<number>>;
};

function chartNumber(value: OpenViewAggregateDatum["value"]): number | null {
  if (value === null) return null;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

function chartDataFor(
  result: OpenViewAggregateSnapshotResult,
  chartType: ChartType,
  top: string,
) {
  const ranked =
    chartType === "line"
      ? result.items
      : result.items
          .filter((item) => item.value !== null)
          .map((item, index) => ({ item, index }))
          .sort((left, right) => {
            const difference =
              Number(right.item.value) - Number(left.item.value);
            return Number.isFinite(difference) && difference !== 0
              ? difference
              : left.index - right.index;
          })
          .map(({ item }) => item);
  const visible =
    chartType === "line"
      ? ranked
      : ranked.slice(0, top ? Number(top) : MAX_CATEGORICAL_PREVIEW_POINTS);
  const displayItems = visible.map((item, index) => ({
    key: `aggregate-${index}`,
    label: item.label,
    value: item.value,
  }));
  const data = displayItems.map((item) => ({
    ...item,
    value: chartNumber(item.value),
  }));
  const hasUnchartableValue = displayItems.some(
    (item) => item.value !== null && chartNumber(item.value) === null,
  );
  return {
    data,
    displayItems,
    hasUnchartableValue,
    total: result.items.length,
    previewCapped:
      chartType !== "line" && !top && result.items.length > visible.length,
  };
}

function downloadCsv(
  result: OpenViewAggregateSnapshotResult,
  dateSeries: boolean,
) {
  const csv = serializeCsv([
    [dateSeries ? "Date" : "Group", "Value", "Record count"],
    ...result.items.map((item) => [item.label, item.value, item.recordCount]),
  ]);
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "openview-chart-data.csv";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function ChartSnapshotResults({
  applied,
  draftSignature,
  top,
  showValues,
  showLegend,
  tablePage,
  tablePageSize,
  setTablePage,
  setTablePageSize,
}: ChartSnapshotResultsProps) {
  if (!applied) {
    return (
      <Card className="w-full min-w-0 print:hidden">
        <CardHeader>
          <CardTitle>Chart results</CardTitle>
          <CardDescription>
            Results appear after a successful Apply. No sample or partial result
            is shown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            No aggregate snapshot has been applied yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  const chart = chartDataFor(
    applied.result,
    applied.chartType,
    applied.chartType === "line" ? "" : top,
  );
  const allRows = applied.result.items;
  const visibleRows = allRows.slice(
    tablePage * tablePageSize,
    (tablePage + 1) * tablePageSize,
  );
  const bucket =
    applied.request.mode === "date_series"
      ? (applied.request.bucket ?? "day")
      : "day";
  const period = {
    day: "daily",
    week: "weekly",
    month: "monthly",
    quarter: "quarterly",
    year: "yearly",
  }[bucket];

  return (
    <>
      <Card className="w-full min-w-0 print:hidden">
        <CardHeader>
          <CardTitle>Chart preview</CardTitle>
          <CardDescription>
            {applied.sourceName} · {applied.aggregationName}{" "}
            {applied.valueName.toLowerCase()} by {applied.labelName}
            {applied.chartType === "line" ? " · chronological date series" : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          {applied.signature !== draftSignature ? (
            <Alert role="note">
              Unapplied chart settings; this preview and its exports still use
              the last successful snapshot.
            </Alert>
          ) : null}
          {applied.chartType !== "line" && top ? (
            <p className="text-muted-foreground text-sm">
              Showing top {Math.min(Number(top), chart.total)} of {chart.total}{" "}
              groups in the chart.
            </p>
          ) : null}
          {chart.previewCapped ? (
            <p className="text-muted-foreground text-sm">
              Showing top {chart.data.length} of {chart.total} groups in chart;
              complete table/CSV/print retained.
            </p>
          ) : null}
          <p className="text-muted-foreground text-sm">
            {chart.data.length} chart points · {applied.result.pagination.total}{" "}
            total{" "}
            {applied.chartType === "line"
              ? `${period} values`
              : "aggregate groups"}
            . Chart decimal values are numeric approximations; the table and
            exports preserve the returned value strings.
          </p>
          {applied.chartType === "line" &&
          showValues &&
          chart.data.length > 20 ? (
            <p className="text-muted-foreground text-sm">
              Dense line chart labels are hidden; complete values remain in the
              table and CSV.
            </p>
          ) : null}
          {chart.hasUnchartableValue ? (
            <Alert role="alert" variant="warning">
              One or more selected values exceed the chart’s numeric range. The
              complete returned values remain available in the table and
              exports.
            </Alert>
          ) : null}
          {chart.data.length && !chart.hasUnchartableValue ? (
            <div
              aria-label="Aggregate chart preview"
              className="w-full min-w-0"
              role="img"
            >
              <OpenViewChartPreview
                data={chart.data}
                type={applied.chartType}
                valueLabel={applied.valueName}
                allowDecimals={applied.aggregationName === "Average"}
                showLabels={
                  showValues &&
                  (applied.chartType !== "line" || chart.data.length <= 20)
                }
                showLegend={showLegend}
                className={cn(
                  "border-border/70 bg-muted/15 h-[22rem] w-full min-w-0 rounded-[var(--radius)] border p-3 sm:h-[26rem]",
                  "[&_.recharts-cartesian-axis-tick-value]:fill-muted-foreground",
                  "[&_.recharts-label]:fill-foreground",
                  applied.chartType === "pie" &&
                    "max-sm:[&_.recharts-legend-wrapper]:hidden max-sm:[&_.recharts-pie-label-text]:hidden",
                )}
              />
            </div>
          ) : (
            <p className="text-muted-foreground py-8 text-center text-sm">
              No chartable aggregate points are available.
            </p>
          )}
          {applied.chartType === "pie" &&
          showValues &&
          chart.displayItems.length ? (
            <ul
              aria-label="Pie chart categories and values"
              className="divide-border min-w-0 divide-y sm:hidden"
            >
              {chart.displayItems.map((item) => (
                <li
                  key={item.key}
                  className="grid min-h-11 min-w-0 grid-cols-2 gap-3 py-2 text-sm"
                >
                  <span className="min-w-0 break-words">{item.label}</span>
                  <span className="min-w-0 text-right break-all tabular-nums">
                    {item.value === null ? "—" : String(item.value)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <details className="border-border rounded-md border px-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
              How to read this chart
            </summary>
            <p className="text-muted-foreground pb-3 text-sm">
              {applied.chartType === "line"
                ? `Each point represents the selected measure for one ${bucket} in the applied date window.`
                : `Each bar or slice represents a ${applied.labelName.toLowerCase()} group.`}{" "}
              The preview may be limited or approximate. The complete table and
              exports below preserve every returned value and record count.
            </p>
          </details>
        </CardContent>
      </Card>

      <Card className="w-full min-w-0 print:hidden">
        <CardHeader className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <CardTitle>Complete aggregate data</CardTitle>
            <CardDescription>
              {applied.result.pagination.total}{" "}
              {applied.chartType === "line"
                ? `${period} values`
                : "aggregate groups"}{" "}
              · one complete snapshot · no record list is loaded
            </CardDescription>
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() =>
                downloadCsv(applied.result, applied.chartType === "line")
              }
            >
              <Download aria-hidden="true" /> Download complete CSV
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => window.print()}
            >
              <Printer aria-hidden="true" /> Print complete table
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          <div className="min-w-0 print:hidden">
            <Table aria-label="Complete aggregate data">
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {applied.chartType === "line" ? "Date" : "Group"}
                  </TableHead>
                  <TableHead>{applied.valueName}</TableHead>
                  <TableHead>Record count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((item, index) => (
                  <TableRow
                    key={`${item.key ?? item.label}-${tablePage * tablePageSize + index}`}
                  >
                    <TableCell>{item.label}</TableCell>
                    <TableCell>
                      {item.value === null ? "—" : String(item.value)}
                    </TableCell>
                    <TableCell>{item.recordCount}</TableCell>
                  </TableRow>
                ))}
                {!allRows.length ? (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="text-muted-foreground py-8 text-center"
                    >
                      No values matched this chart definition.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
        <TablePagination
          ariaLabel="Complete aggregate data pages"
          total={allRows.length}
          offset={tablePage * tablePageSize}
          rowCount={visibleRows.length}
          pageSize={tablePageSize}
          onPageIndexChange={setTablePage}
          onPageSizeChange={(size) => {
            setTablePageSize(size);
            setTablePage(0);
          }}
        />
      </Card>
      <div className="hidden print:block">
        <h1 data-slot="section-title" className="mb-2 text-xl font-semibold">
          {applied.sourceName} — {applied.labelName} chart data
        </h1>
        <p className="mb-4 text-sm">
          Complete aggregate snapshot: {allRows.length}{" "}
          {applied.chartType === "line" ? `${period} values` : "groups"}.
        </p>
        <Table aria-label="Printable complete aggregate data">
          <TableHeader>
            <TableRow>
              <TableHead>
                {applied.chartType === "line" ? "Date" : "Group"}
              </TableHead>
              <TableHead>{applied.valueName}</TableHead>
              <TableHead>Record count</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allRows.map((item, index) => (
              <TableRow
                key={`${item.key ?? item.label}-${index}`}
                data-print-row
                data-testid="charts-print-row"
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
    </>
  );
}
