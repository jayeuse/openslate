"use client";

import { Download } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingRegion } from "@/components/ui/loading-region";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { serializeCsv } from "@/lib/csv";

import {
  AuditExportLimitError,
  type ManageAuditLog,
} from "../adapters/audit-api";

// The preview mirrors the server CSV (`audit/export.py`): the table name and
// the raw "Key: value" lines, so the preview matches the download.
function csvWords(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function csvValues(
  values: Record<string, unknown> | null,
  emptyLabel: string,
): string {
  if (!values || Object.keys(values).length === 0) return emptyLabel;
  return Object.entries(values)
    .map(([key, value]) => {
      const formatted =
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
          ? String(value)
          : (JSON.stringify(value) ?? String(value));
      return `${csvWords(key)}: ${formatted}`;
    })
    .join("\n");
}

function auditCsv(logs: readonly ManageAuditLog[]): string {
  const header = [
    "Date",
    "User",
    "Entity",
    "Action",
    "Target",
    "Before",
    "After",
  ];
  const rows = logs.map((log) => [
    log.created_at,
    log.actor_name?.trim() || "Unknown person",
    csvWords(log.entity_type),
    log.action[0]!.toUpperCase() + log.action.slice(1),
    log.target_label,
    csvValues(log.before, "No previous values recorded."),
    csvValues(log.after, "No updated values recorded."),
  ]);
  return serializeCsv([header, ...rows]);
}

/**
 * The export preview below the 10,000-event limit (MD7 keeps this flow):
 * the first 10 filtered events as CSV, then Download CSV for all of them.
 * The host owns the pinned request, the download and its cancellation.
 */
export function AuditExportDialog({
  open,
  onClose,
  finalFocus,
  count,
  logs,
  preview,
  downloadError,
  downloadPending,
  canDownload,
  onDownload,
}: {
  open: boolean;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
  count: number;
  logs: readonly ManageAuditLog[];
  preview: {
    isPending: boolean;
    isSuccess: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  };
  downloadError: unknown;
  downloadPending: boolean;
  canDownload: boolean;
  onDownload: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="slim-ui sm:max-w-3xl" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Audit export preview</DialogTitle>
          <DialogDescription>
            {count} filtered {count === 1 ? "entry" : "entries"} · the download
            includes every filtered entry across all pages.
          </DialogDescription>
        </DialogHeader>
        {downloadError ? (
          <Alert role="alert" variant="destructive">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p>
                {downloadError instanceof AuditExportLimitError
                  ? downloadError.message
                  : "Audit CSV could not be downloaded. Try again."}
              </p>
              <Button
                variant="outline"
                disabled={downloadPending}
                onClick={onDownload}
              >
                Retry
              </Button>
            </div>
          </Alert>
        ) : null}
        {preview.isError ? (
          <Alert role="alert" variant="destructive">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p>
                {preview.error instanceof AuditExportLimitError
                  ? preview.error.message
                  : "Audit export preview could not be loaded. Try again."}
              </p>
              <Button variant="outline" onClick={() => void preview.refetch()}>
                Retry
              </Button>
            </div>
          </Alert>
        ) : (
          <ScrollArea
            className="max-h-[50dvh] rounded-md"
            viewportProps={{
              className: "max-h-[50dvh]",
              tabIndex: 0,
              "aria-label": "CSV preview",
            }}
          >
            <LoadingRegion
              loading={preview.isPending}
              label="Preparing audit export…"
              skeleton={<Skeleton className="m-4 h-60 w-[calc(100%-2rem)]" />}
            >
              <pre className="bg-muted rounded-md p-4 text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap">
                {auditCsv(logs.slice(0, 10))}
              </pre>
            </LoadingRegion>
          </ScrollArea>
        )}
        {preview.isSuccess ? (
          <p className="text-muted-foreground text-sm">
            Showing the first {Math.min(10, count)} of {count} entries. The CSV
            download includes all {count} entries.
          </p>
        ) : null}
        {downloadPending ? (
          <p role="status" className="text-muted-foreground text-sm">
            Downloading audit CSV…
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            Close preview
          </Button>
          <Button
            className="min-h-11"
            onClick={onDownload}
            aria-busy={downloadPending}
            disabled={!canDownload}
          >
            <Download data-icon="inline-start" /> Download CSV
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
