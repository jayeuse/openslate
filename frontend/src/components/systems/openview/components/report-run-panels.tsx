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
import type {
  OpenViewReport,
  OpenViewReportRun,
  OpenViewSharedReportRun,
} from "../adapters/reports-api";

export type ReportOutputAction = "download" | "print";

export function formatReportRunDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

type AvailableReportRunsPanelProps = {
  runs: OpenViewSharedReportRun[];
  loading: boolean;
  error: string;
  hasMore: boolean;
  actionPending: string;
  onRefresh: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
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
  hasMore,
  actionPending,
  onRefresh,
  onRetry,
  onLoadMore,
  onOutputRun,
}: AvailableReportRunsPanelProps) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Available runs</CardTitle>
        <CardDescription>
          Saved outputs you are eligible to open, including your own. Recipe
          editing stays with the owner.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start"
          disabled={loading}
          onClick={onRefresh}
        >
          Refresh available runs
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
            Loading available runs…
          </p>
        ) : null}
        {!loading && runs.length === 0 && !error ? (
          <p className="text-muted-foreground text-sm">
            No runs available to this account.
          </p>
        ) : null}
        <ul className="flex min-w-0 flex-col gap-3">
          {runs.map((run) => (
            <li key={run.id} className="border-border rounded-lg border p-3">
              <p className="font-medium break-words">{run.reportName}</p>
              <p className="text-muted-foreground text-sm">
                {formatReportRunDate(run.createdAt)} · {run.rowCount}{" "}
                {run.rowCount === 1 ? "row" : "rows"} · Recipe revision{" "}
                {run.recipeRevision}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={Boolean(actionPending)}
                  onClick={() =>
                    void onOutputRun(run, run.reportName, "download")
                  }
                >
                  <Download data-icon="inline-start" /> CSV
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={Boolean(actionPending)}
                  onClick={() => void onOutputRun(run, run.reportName, "print")}
                >
                  <Printer data-icon="inline-start" /> Print
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {hasMore ? (
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={onLoadMore}
          >
            Load more available runs
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

type SavedReportRunsPanelProps = {
  report: OpenViewReport;
  currentIdentityError: string;
  currentIdentityLoading: boolean;
  hasCurrentIdentity: boolean;
  ownerExcludedFromAudience: boolean;
  dirty: boolean;
  actionPending: string;
  runs: OpenViewReportRun[];
  loading: boolean;
  error: string;
  hasMore: boolean;
  onRun: () => void | Promise<void>;
  onRefresh: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onOutputRun: (
    run: OpenViewReportRun,
    reportName: string,
    action: ReportOutputAction,
  ) => void | Promise<void>;
};

export function SavedReportRunsPanel({
  report,
  currentIdentityError,
  currentIdentityLoading,
  hasCurrentIdentity,
  ownerExcludedFromAudience,
  dirty,
  actionPending,
  runs,
  loading,
  error,
  hasMore,
  onRun,
  onRefresh,
  onRetry,
  onLoadMore,
  onOutputRun,
}: SavedReportRunsPanelProps) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Saved runs</CardTitle>
        <CardDescription>
          Each run keeps its own output. CSV and Print use the same frozen
          bytes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {currentIdentityError ? (
          <Alert role="alert" variant="destructive">
            {currentIdentityError}
          </Alert>
        ) : null}
        {ownerExcludedFromAudience ? (
          <p role="status" className="text-muted-foreground text-sm">
            Your account is not included in this Report audience, so you cannot
            run it. Scheduled runs remain available for eligible recipients.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="min-h-11"
            disabled={
              Boolean(actionPending) ||
              dirty ||
              currentIdentityLoading ||
              !hasCurrentIdentity ||
              ownerExcludedFromAudience
            }
            onClick={() => void onRun()}
          >
            {actionPending === "run" ? "Running…" : "Run now"}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={loading}
            onClick={onRefresh}
          >
            Refresh history
          </Button>
        </div>
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
            Loading saved runs…
          </p>
        ) : null}
        {!loading && runs.length === 0 && !error ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No runs yet</EmptyTitle>
              <EmptyDescription>
                Run this Report to save its first snapshot.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        <ul className="flex flex-col gap-3">
          {runs.map((run) => (
            <li
              key={run.id}
              className="border-border flex flex-wrap items-center gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {formatReportRunDate(run.createdAt)}
                </p>
                <p className="text-muted-foreground text-sm">
                  {run.rowCount} {run.rowCount === 1 ? "row" : "rows"} · Recipe
                  revision {run.recipeRevision}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={Boolean(actionPending)}
                onClick={() => void onOutputRun(run, report.name, "download")}
              >
                <Download data-icon="inline-start" /> CSV
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={Boolean(actionPending)}
                onClick={() => void onOutputRun(run, report.name, "print")}
              >
                <Printer data-icon="inline-start" /> Print
              </Button>
            </li>
          ))}
        </ul>
        {hasMore ? (
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={onLoadMore}
          >
            Load more runs
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
