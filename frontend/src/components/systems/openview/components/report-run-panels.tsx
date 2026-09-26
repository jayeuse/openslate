"use client";

import { Download, Printer } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { PaginationControls } from "@/components/ui/pagination-controls";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  OpenViewReport,
  OpenViewReportRun,
  OpenViewSharedReportRun,
} from "../adapters/reports-api";

export type ReportOutputAction = "download" | "print";

export function formatReportRunDate(value: string): string {
  return `${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value))} UTC`;
}

type ReportRunRow = OpenViewReportRun | OpenViewSharedReportRun;

type ReportRunActionsProps = {
  run: ReportRunRow;
  runName: string;
  dateLabel: string;
  actionPending: string;
  onOutputRun: (
    run: ReportRunRow,
    reportName: string,
    action: ReportOutputAction,
  ) => void | Promise<void>;
};

function ReportRunActions({
  run,
  runName,
  dateLabel,
  actionPending,
  onOutputRun,
}: ReportRunActionsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={Boolean(actionPending)}
        aria-label={`Download CSV for ${dateLabel}`}
        onClick={() => void onOutputRun(run, runName, "download")}
      >
        <Download data-icon="inline-start" /> CSV
      </Button>
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={Boolean(actionPending)}
        aria-label={`Print output from ${dateLabel}`}
        onClick={() => void onOutputRun(run, runName, "print")}
      >
        <Printer data-icon="inline-start" /> Print
      </Button>
    </div>
  );
}

type ReportRunsTableProps = {
  runs: ReportRunRow[];
  reportName?: string;
  showReportName: boolean;
  actionPending: string;
  pageIndex: number;
  pageCount: number;
  totalCount: number;
  pageSize: number;
  paginationLabel: string;
  onPageIndexChange: (pageIndex: number) => void;
  onOutputRun: (
    run: ReportRunRow,
    reportName: string,
    action: ReportOutputAction,
  ) => void | Promise<void>;
};

function ReportRunsTable({
  runs,
  reportName,
  showReportName,
  actionPending,
  pageIndex,
  pageCount,
  totalCount,
  pageSize,
  paginationLabel,
  onPageIndexChange,
  onOutputRun,
}: ReportRunsTableProps) {
  const firstRow = totalCount === 0 ? 0 : pageIndex * pageSize + 1;
  const lastRow = Math.min(pageIndex * pageSize + runs.length, totalCount);

  return (
    <>
      <ul
        aria-label={showReportName ? "Available outputs" : "Saved outputs"}
        className="grid min-w-0 gap-3 xl:hidden"
      >
        {runs.map((run) => {
          const sharedRun = "reportName" in run ? run : null;
          const runName = sharedRun?.reportName ?? reportName ?? "Report";
          const dateLabel = formatReportRunDate(run.createdAt);
          return (
            <li
              key={run.id}
              className="border-border min-w-0 rounded-lg border p-4"
            >
              {showReportName ? (
                <p className="mb-2 font-medium break-words">{runName}</p>
              ) : null}
              <time
                dateTime={run.createdAt}
                className="text-muted-foreground text-sm"
              >
                {dateLabel}
              </time>
              <dl className="my-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Recipe version</dt>
                  <dd>{run.recipeRevision}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Rows</dt>
                  <dd className="tabular-nums">{run.rowCount}</dd>
                </div>
              </dl>
              <ReportRunActions
                run={run}
                runName={runName}
                dateLabel={dateLabel}
                actionPending={actionPending}
                onOutputRun={onOutputRun}
              />
            </li>
          );
        })}
      </ul>
      <div className="border-border hidden overflow-x-auto rounded-lg border xl:block">
        <Table
          aria-label={showReportName ? "Available outputs" : "Saved outputs"}
          className="min-w-[38rem]"
        >
          <TableHeader>
            <TableRow>
              {showReportName ? (
                <TableHead scope="col">Report</TableHead>
              ) : null}
              <TableHead scope="col">Created (UTC)</TableHead>
              <TableHead scope="col">Recipe version</TableHead>
              <TableHead scope="col" className="text-right">
                Rows
              </TableHead>
              <TableHead scope="col">Output</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => {
              const sharedRun = "reportName" in run ? run : null;
              const runName = sharedRun?.reportName ?? reportName ?? "Report";
              const dateLabel = formatReportRunDate(run.createdAt);
              return (
                <TableRow key={run.id}>
                  {showReportName ? (
                    <TableCell className="max-w-48 font-medium break-words">
                      {runName}
                    </TableCell>
                  ) : null}
                  <TableCell className="whitespace-nowrap">
                    <time dateTime={run.createdAt}>{dateLabel}</time>
                  </TableCell>
                  <TableCell>Recipe version {run.recipeRevision}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {run.rowCount}
                  </TableCell>
                  <TableCell>
                    <ReportRunActions
                      run={run}
                      runName={runName}
                      dateLabel={dateLabel}
                      actionPending={actionPending}
                      onOutputRun={onOutputRun}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Showing {firstRow}–{lastRow} of {totalCount}
        </p>
        <PaginationControls
          ariaLabel={paginationLabel}
          className="w-auto justify-end"
          pageCount={pageCount}
          pageIndex={pageIndex}
          onPageIndexChange={onPageIndexChange}
        />
      </div>
    </>
  );
}

type AvailableReportRunsPanelProps = {
  runs: OpenViewSharedReportRun[];
  loading: boolean;
  error: string;
  actionPending: string;
  pageIndex: number;
  pageCount: number;
  totalCount: number;
  onPageIndexChange: (pageIndex: number) => void;
  onRefresh: () => void;
  onRetry: () => void;
  onOutputRun: (
    run: OpenViewSharedReportRun,
    reportName: string,
    action: ReportOutputAction,
  ) => void | Promise<void>;
};

export function AvailableReportRunsPanel({
  runs,
  loading,
  error,
  actionPending,
  pageIndex,
  pageCount,
  totalCount,
  onPageIndexChange,
  onRefresh,
  onRetry,
  onOutputRun,
}: AvailableReportRunsPanelProps) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Button
        type="button"
        variant="outline"
        className="min-h-11 self-start"
        disabled={loading}
        onClick={onRefresh}
      >
        Refresh available outputs
      </Button>
      {error ? (
        <Alert role="alert" variant="destructive">
          {error}
          <Button
            type="button"
            variant="outline"
            className="ml-3 min-h-11"
            onClick={onRetry}
          >
            Retry
          </Button>
        </Alert>
      ) : null}
      {loading && runs.length === 0 ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading available outputs…
        </p>
      ) : null}
      {!loading && runs.length === 0 && !error ? (
        <p className="text-muted-foreground text-sm">
          No outputs are available to this account.
        </p>
      ) : null}
      {runs.length > 0 ? (
        <ReportRunsTable
          runs={runs}
          showReportName
          actionPending={actionPending}
          pageIndex={pageIndex}
          pageCount={pageCount}
          totalCount={totalCount}
          pageSize={25}
          paginationLabel="Available output pages"
          onPageIndexChange={onPageIndexChange}
          onOutputRun={(run, runName, action) => {
            if ("reportName" in run) return onOutputRun(run, runName, action);
          }}
        />
      ) : null}
    </div>
  );
}

type SavedReportRunsPanelProps = {
  report: OpenViewReport;
  runs: OpenViewReportRun[];
  loading: boolean;
  error: string;
  actionPending: string;
  pageIndex: number;
  pageCount: number;
  totalCount: number;
  onPageIndexChange: (pageIndex: number) => void;
  onRefresh: () => void;
  onRetry: () => void;
  onOutputRun: (
    run: OpenViewReportRun,
    reportName: string,
    action: ReportOutputAction,
  ) => void | Promise<void>;
};

export function SavedReportRunsPanel({
  report,
  runs,
  loading,
  error,
  actionPending,
  pageIndex,
  pageCount,
  totalCount,
  onPageIndexChange,
  onRefresh,
  onRetry,
  onOutputRun,
}: SavedReportRunsPanelProps) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Saved outputs</CardTitle>
        <CardDescription>
          Each output keeps the data from when it ran. CSV and Print use the
          same frozen bytes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start"
          disabled={loading}
          onClick={onRefresh}
        >
          Refresh saved outputs
        </Button>
        {error ? (
          <Alert role="alert" variant="destructive">
            {error}
            <Button
              type="button"
              variant="outline"
              className="ml-3 min-h-11"
              onClick={onRetry}
            >
              Retry
            </Button>
          </Alert>
        ) : null}
        {loading && runs.length === 0 ? (
          <p role="status" className="text-muted-foreground text-sm">
            Loading saved outputs…
          </p>
        ) : null}
        {!loading && runs.length === 0 && !error ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No saved outputs</EmptyTitle>
              <EmptyDescription>
                Run this Report to save its first output.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {runs.length > 0 ? (
          <ReportRunsTable
            runs={runs}
            reportName={report.name}
            showReportName={false}
            actionPending={actionPending}
            pageIndex={pageIndex}
            pageCount={pageCount}
            totalCount={totalCount}
            pageSize={25}
            paginationLabel="Saved output pages"
            onPageIndexChange={onPageIndexChange}
            onOutputRun={(run, runName, action) => {
              if (!("reportName" in run))
                return onOutputRun(run, runName, action);
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
