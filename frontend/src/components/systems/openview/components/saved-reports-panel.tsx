"use client";

import { RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import type { OpenViewReport } from "../adapters/reports-api";

type SavedReportsPanelProps = {
  reports: OpenViewReport[];
  showArchived: boolean;
  selectedReportId: string | undefined;
  templateReportId: string;
  actionPending: string;
  loading: boolean;
  error: string;
  hasMore: boolean;
  onShowArchivedChange: (showArchived: boolean) => void;
  onRefresh: () => void;
  onRetry: () => void;
  onOpenReport: (report: OpenViewReport) => void;
  onDuplicateReport: (reportId: string) => void;
  onTemplateReportChange: (reportId: string) => void;
  onStartFromTemplate: () => void;
  onLoadMore: () => void;
};

export function SavedReportsPanel({
  reports,
  showArchived,
  selectedReportId,
  templateReportId,
  actionPending,
  loading,
  error,
  hasMore,
  onShowArchivedChange,
  onRefresh,
  onRetry,
  onOpenReport,
  onDuplicateReport,
  onTemplateReportChange,
  onStartFromTemplate,
  onLoadMore,
}: SavedReportsPanelProps) {
  return (
    <Card className="min-w-0 self-start">
      <CardHeader>
        <CardTitle>Saved Reports</CardTitle>
        <CardDescription>Only Reports you own appear here.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Field className="min-h-11 flex-row items-center gap-3">
            <Checkbox
              id="reports-show-archived"
              checked={showArchived}
              onCheckedChange={(value) => onShowArchivedChange(Boolean(value))}
            />
            <FieldLabel htmlFor="reports-show-archived">
              Show archived
            </FieldLabel>
          </Field>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="ml-auto min-h-11 min-w-11"
            aria-label="Refresh Reports"
            onClick={onRefresh}
          >
            <RefreshCw />
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
        {loading && reports.length === 0 ? (
          <p role="status" className="text-muted-foreground text-sm">
            Loading Reports…
          </p>
        ) : null}
        {!loading && reports.length === 0 && !error ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No saved Reports</EmptyTitle>
              <EmptyDescription>
                Choose a data source and fields to create your first Report.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        <ul className="flex min-w-0 flex-col gap-2">
          {reports.map((report) => (
            <li key={report.id} className="flex min-w-0 gap-2">
              <Button
                type="button"
                variant={
                  selectedReportId === report.id ? "secondary" : "outline"
                }
                className="min-h-11 min-w-0 flex-1 justify-start text-left"
                disabled={Boolean(actionPending)}
                onClick={() => onOpenReport(report)}
              >
                <span className="min-w-0 truncate">{report.name}</span>
                {report.isDeleted ? (
                  <Badge variant="outline" className="ml-auto">
                    Archived
                  </Badge>
                ) : null}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={Boolean(actionPending) || report.isDeleted}
                onClick={() => onDuplicateReport(report.id)}
              >
                Duplicate
              </Button>
            </li>
          ))}
        </ul>
        {!showArchived && reports.length > 0 ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field className="min-w-48 flex-1">
              <FieldLabel htmlFor="report-template-source">
                Start from saved Report
              </FieldLabel>
              <Select
                id="report-template-source"
                value={templateReportId}
                onValueChange={onTemplateReportChange}
                placeholder="Choose a saved Report"
                disabled={Boolean(actionPending)}
              >
                {reports
                  .filter((report) => !report.isDeleted)
                  .map((report) => (
                    <option key={report.id} value={report.id}>
                      {report.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={!templateReportId || Boolean(actionPending)}
              onClick={onStartFromTemplate}
            >
              Start from saved Report
            </Button>
          </div>
        ) : null}
        {hasMore ? (
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={onLoadMore}
          >
            Load more Reports
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
