"use client";

import { Check, ChevronDown, Download, Maximize2, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { apiErrorMessage } from "@/lib/api-errors";
import type { WorkspaceRegion } from "@/lib/date-time";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogFrameHeader } from "@/components/ui/dialog-frame";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import {
  downloadOpenViewReportRunCsv,
  getOpenViewReportRun,
  listOpenViewReportRuns,
  type OpenViewReport,
  type OpenViewReportRun,
} from "../adapters/reports-api";
import { REPORT_COPY_PAGE_SIZE } from "../adapters/report-queries";
import type { OpenViewPage } from "../adapters/views-api";
import { copyFromCsv, type ReportCopyTable } from "../domain/report-copy";
import { copyDate } from "../domain/report-words";
import { useNarrowScreen } from "./live-record-results";

/** Rows a copy shows on the page; Print and CSV keep every row. */
const COPY_ROW_LIMIT = 500;

type CopyRead =
  | { runId: string; status: "loading" }
  | { runId: string; status: "failed"; message: string }
  | {
      runId: string;
      status: "ready";
      csv: string;
      filename: string;
      table: ReportCopyTable;
    };

function rowsWords(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "row" : "rows"}`;
}

/** Print lays the copy out as a table with its headings, every row. */
function printCopy(printWindow: Window, csv: string, title: string): void {
  const page = printWindow.document;
  page.title = title;
  const table = copyFromCsv(csv, Number.MAX_SAFE_INTEGER);
  const cell = (tag: "th" | "td", text: string, span = 1) => {
    const element = page.createElement(tag);
    element.textContent = text;
    if (span > 1) element.colSpan = span;
    return element;
  };
  const heading = page.createElement("h1");
  heading.textContent = title;
  const grid = page.createElement("table");
  const head = page.createElement("thead");
  const headRow = page.createElement("tr");
  headRow.append(...table.headings.map((text) => cell("th", text)));
  head.append(headRow);
  const body = page.createElement("tbody");
  for (const row of table.rows) {
    const line = page.createElement("tr");
    if (row.kind === "summary")
      line.append(cell("td", row.cells[0] ?? "", table.headings.length));
    else line.append(...row.cells.map((text) => cell("td", text)));
    body.append(line);
  }
  grid.append(head, body);
  const style = page.createElement("style");
  style.textContent =
    "body{font:12px system-ui,sans-serif}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}";
  page.head.append(style);
  page.body.append(heading, grid);
  printWindow.focus();
  printWindow.print();
}

function CopySkeleton() {
  return (
    <div className="p-4">
      <Skeleton className="mb-3 h-5 w-1/3" />
      <Skeleton className="mb-2 h-8 w-full" />
      <Skeleton className="mb-2 h-8 w-full" />
      <Skeleton className="h-8 w-2/3" />
    </div>
  );
}

function CopyRows({
  label,
  read,
  narrow,
  onRetry,
}: {
  label: string;
  read: CopyRead | null;
  /** Phones: each row as label and value lines, so nothing scrolls sideways. */
  narrow: boolean;
  onRetry: () => void;
}) {
  return (
    <LoadingRegion
      loading={!read || read.status === "loading"}
      label="Loading the copy…"
      skeleton={<CopySkeleton />}
    >
      {read?.status === "failed" ? (
        <div className="p-4">
          <Alert
            role="alert"
            variant="destructive"
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <span>{read.message}</span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={onRetry}
            >
              Retry
            </Button>
          </Alert>
        </div>
      ) : read?.status === "ready" ? (
        <CopyTable label={label} table={read.table} narrow={narrow} />
      ) : null}
    </LoadingRegion>
  );
}

function CopyTable({
  label,
  table,
  narrow,
}: {
  label: string;
  table: ReportCopyTable;
  narrow: boolean;
}) {
  // A copy's rows have no ids; their order is the copy itself.
  const rows = narrow ? (
    <ul aria-label={label} className="divide-border divide-y">
      {table.rows.map((row, index) =>
        row.kind === "summary" ? (
          <li
            key={index}
            className="text-muted-foreground px-5 py-3 text-sm font-medium"
          >
            {row.cells[0]}
          </li>
        ) : (
          <li key={index} className="px-5 py-3">
            <dl className="grid gap-x-3 gap-y-1 text-sm">
              {row.cells.map((cell, column) => (
                <div key={column} className="min-w-0">
                  <dt className="text-muted-foreground text-xs">
                    {table.headings[column]}
                  </dt>
                  <dd className="break-words">{cell}</dd>
                </div>
              ))}
            </dl>
          </li>
        ),
      )}
    </ul>
  ) : (
    <table aria-label={label} className="w-full border-collapse text-sm">
      <thead>
        <tr>
          {table.headings.map((heading, index) => (
            <th
              key={`${index}:${heading}`}
              scope="col"
              data-slot="table-head"
              className="bg-card text-muted-foreground sticky top-0 z-[1] h-9 px-4 text-left text-xs font-medium whitespace-nowrap shadow-[inset_0_-1px_0_var(--border)]"
            >
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody data-slot="table-body">
        {table.rows.map((row, index) =>
          row.kind === "summary" ? (
            <tr key={index} data-slot="table-row" className="border-b">
              <td
                data-slot="table-cell"
                colSpan={table.headings.length || 1}
                className="text-muted-foreground h-10 px-4 font-medium"
              >
                {row.cells[0]}
              </td>
            </tr>
          ) : (
            <tr key={index} data-slot="table-row" className="border-b">
              {row.cells.map((cell, column) => (
                <td
                  key={column}
                  data-slot="table-cell"
                  title={cell}
                  className="h-10 max-w-80 px-4 py-1.5 align-top"
                >
                  {/* Two lines at most; the whole text is in the title. */}
                  <span className="line-clamp-2 whitespace-normal">{cell}</span>
                </td>
              ))}
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
  return (
    <>
      {rows}
      {table.shown < table.total ? (
        <p className="text-muted-foreground px-4 py-3 text-sm">
          {table.shown.toLocaleString("en-US")} of{" "}
          {table.total.toLocaleString("en-US")} rows · CSV has all
        </p>
      ) : null}
    </>
  );
}

type ReportCopyPanelProps = {
  report: OpenViewReport;
  /** The cached latest copies (newest first) and their count. */
  copies: OpenViewPage<OpenViewReportRun> | undefined;
  copiesPending: boolean;
  copiesFailed: boolean;
  onRetryCopies: () => void;
  /** The copy the address names; without one the latest copy shows. */
  copyId: string | undefined;
  region: WorkspaceRegion | undefined;
  onSelectCopy: (copyId: string) => void;
};

/**
 * The copy itself (DC5): a bar that names it ("Copy of Mon, Oct 20 at 8:00
 * AM · 142 rows · as they were then"), Older copies, Print and CSV, then its
 * rows in the panel that scrolls. On a phone the rows open full screen.
 */
export function ReportCopyPanel({
  report,
  copies,
  copiesPending,
  copiesFailed,
  onRetryCopies,
  copyId,
  region,
  onSelectCopy,
}: ReportCopyPanelProps) {
  const [older, setOlder] = useState<{
    reportId: string;
    items: OpenViewReportRun[];
    hasMore: boolean;
  } | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [linked, setLinked] = useState<
    | { id: string; status: "loading" }
    | { id: string; status: "missing" }
    | { id: string; status: "ready"; run: OpenViewReportRun }
    | null
  >(null);
  const [read, setRead] = useState<CopyRead | null>(null);
  const [retry, setRetry] = useState(0);
  const [actionError, setActionError] = useState("");
  const [printing, setPrinting] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const narrow = useNarrowScreen();

  const loadedOlder = older?.reportId === report.id ? older : null;
  const listed = [...(copies?.items ?? []), ...(loadedOlder?.items ?? [])];
  const total = copies?.pagination.total ?? 0;
  const listedMatch = copyId
    ? listed.find((run) => run.id === copyId)
    : undefined;
  // A link to a copy beyond the latest page reads that copy (DC8).
  useEffect(() => {
    if (!copyId || listedMatch || !copies) return;
    let active = true;
    setLinked({ id: copyId, status: "loading" });
    getOpenViewReportRun(report.id, copyId)
      .then((run) => {
        if (active) setLinked({ id: copyId, status: "ready", run });
      })
      .catch(() => {
        if (active) setLinked({ id: copyId, status: "missing" });
      });
    return () => {
      active = false;
    };
  }, [copyId, listedMatch, copies, report.id]);
  const link = linked && copyId && linked.id === copyId ? linked : null;
  const linkedRun = link?.status === "ready" ? link.run : null;
  const copyMissing = !listedMatch && link?.status === "missing";
  const current: OpenViewReportRun | undefined = copyId
    ? (listedMatch ?? linkedRun ?? undefined)
    : copies?.items[0];

  // The copy's rows come from its CSV; a new copy reads its own.
  const currentId = current?.id;
  useEffect(() => {
    if (!currentId) return;
    let active = true;
    setRead({ runId: currentId, status: "loading" });
    downloadOpenViewReportRunCsv(report.id, currentId)
      .then(async ({ blob, filename }) => {
        const csv = await blob.text();
        if (active)
          setRead({
            runId: currentId,
            status: "ready",
            csv,
            filename,
            table: copyFromCsv(csv, COPY_ROW_LIMIT),
          });
      })
      .catch((reason: unknown) => {
        if (active)
          setRead({
            runId: currentId,
            status: "failed",
            message: apiErrorMessage(
              reason,
              "The copy could not be opened. Try again.",
            ),
          });
      });
    return () => {
      active = false;
    };
  }, [currentId, report.id, retry]);
  const currentRead = read?.runId === currentId ? read : null;

  async function loadOlder(): Promise<void> {
    if (olderLoading || !copies) return;
    setOlderLoading(true);
    try {
      const page = await listOpenViewReportRuns(report.id, {
        limit: REPORT_COPY_PAGE_SIZE,
        offset: listed.length,
      });
      setOlder({
        reportId: report.id,
        items: [
          ...(loadedOlder?.items ?? []),
          ...page.items.filter(
            (run) => !listed.some((known) => known.id === run.id),
          ),
        ],
        hasMore: page.pagination.hasMore,
      });
    } catch {
      setActionError("Older copies could not be loaded. Try again.");
    } finally {
      setOlderLoading(false);
    }
  }

  async function download(): Promise<void> {
    if (!current) return;
    setActionError("");
    try {
      const ready =
        currentRead?.status === "ready"
          ? {
              blob: new Blob([currentRead.csv]),
              filename: currentRead.filename,
            }
          : await downloadOpenViewReportRunCsv(report.id, current.id);
      const url = URL.createObjectURL(ready.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = ready.filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (reason) {
      setActionError(
        apiErrorMessage(reason, "The CSV could not be downloaded. Try again."),
      );
    }
  }

  async function print(): Promise<void> {
    if (!current || printing) return;
    setActionError("");
    const blocked =
      "Your browser blocked the print window. Allow pop-ups and try again.";
    // Opened before any wait, so the browser treats it as the click's window.
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setActionError(blocked);
      return;
    }
    printWindow.opener = null;
    setPrinting(true);
    try {
      const csv =
        currentRead?.status === "ready"
          ? currentRead.csv
          : await (
              await downloadOpenViewReportRunCsv(report.id, current.id)
            ).blob.text();
      printCopy(
        printWindow,
        csv,
        `${report.name} — ${copyDate(current.createdAt, region)}`,
      );
    } catch (reason) {
      printWindow.close();
      setActionError(
        apiErrorMessage(reason, "The copy could not be printed. Try again."),
      );
    } finally {
      setPrinting(false);
    }
  }

  if (copiesPending && !copies)
    return (
      <LoadingRegion
        loading
        label="Loading copies…"
        className="border-t"
        skeleton={<CopySkeleton />}
      />
    );
  if (copiesFailed && !copies)
    return (
      <div className="border-t p-4">
        <Alert
          role="alert"
          variant="destructive"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <span>Copies could not be loaded. Try again.</span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onRetryCopies}
          >
            Retry
          </Button>
        </Alert>
      </div>
    );
  if (copyMissing)
    return (
      <div className="border-t p-4">
        <Alert role="alert" variant="warning">
          This copy is not available.
        </Alert>
      </div>
    );
  if (!current)
    return copyId ? (
      <LoadingRegion
        loading
        label="Loading the copy…"
        className="border-t"
        skeleton={<CopySkeleton />}
      />
    ) : (
      <div className="text-muted-foreground border-t px-4 py-6 text-sm">
        No copies yet.
      </div>
    );

  const title = `Copy of ${copyDate(current.createdAt, region)}`;
  const others = listed.filter((run) => run.id !== current.id);
  const olderCount = Math.max(total - 1, others.length);
  const hasMoreOlder = loadedOlder
    ? loadedOlder.hasMore
    : listed.length < total;
  const actions = (
    <span className="flex flex-wrap items-center gap-1 md:ml-auto">
      {olderCount > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" variant="ghost" className="min-h-11" />
            }
          >
            Older copies ({olderCount})
            <ChevronDown aria-hidden="true" className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="slim-ui max-h-80 min-w-64 overflow-y-auto"
          >
            {/* Plain items marked as radios: the menu's radio parts would
                join the shared menu code every page loads. */}
            {listed.map((run) => (
              <DropdownMenuItem
                key={run.id}
                role="menuitemradio"
                aria-checked={run.id === current.id}
                className="min-h-11 tabular-nums xl:min-h-8"
                onClick={() => onSelectCopy(run.id)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {copyDate(run.createdAt, region)}
                </span>
                <span className="text-muted-foreground">
                  {rowsWords(run.rowCount)}
                </span>
                {run.id === current.id ? (
                  <Check aria-hidden="true" />
                ) : (
                  <span aria-hidden="true" className="size-4" />
                )}
              </DropdownMenuItem>
            ))}
            {hasMoreOlder ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="min-h-11 xl:min-h-8"
                  disabled={olderLoading}
                  closeOnClick={false}
                  onClick={() => void loadOlder()}
                >
                  {olderLoading ? "Loading…" : "Load older copies"}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        className="min-h-11"
        disabled={printing}
        onClick={() => void print()}
      >
        <Printer aria-hidden="true" />
        Print
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="min-h-11"
        aria-label={`Download CSV of the ${title.toLowerCase()}`}
        onClick={() => void download()}
      >
        <Download aria-hidden="true" />
        CSV
      </Button>
    </span>
  );
  const note = `${rowsWords(current.rowCount)} · as they were then`;
  return (
    <section
      aria-label={title}
      className="access-fill flex min-h-0 min-w-0 flex-col"
    >
      <div className="flex min-w-0 flex-col gap-2 border-y px-4 py-2 md:flex-row md:flex-wrap md:items-center md:gap-x-3">
        <h3 className="text-sm font-semibold tabular-nums">{title}</h3>
        <span className="text-muted-foreground text-xs tabular-nums">
          {note}
        </span>
        {actions}
        <Button
          type="button"
          variant="outline"
          className="min-h-11 md:hidden"
          onClick={() => setFullScreen(true)}
        >
          <Maximize2 aria-hidden="true" />
          Open copy
        </Button>
      </div>
      {actionError ? (
        <Alert role="alert" variant="destructive" className="m-4">
          {actionError}
        </Alert>
      ) : null}
      {/* Only this panel scrolls on desktop (EXIT-C4); phones open it full
          screen instead, so one layout renders at a time. */}
      {narrow ? null : (
        <div className="relative min-h-0 overflow-auto overscroll-contain xl:flex-1">
          <CopyRows
            label={title}
            read={currentRead}
            narrow={false}
            onRetry={() => setRetry((value) => value + 1)}
          />
        </div>
      )}
      {/* Phones: the copy opens full screen (DC12). */}
      <Sheet open={fullScreen} onOpenChange={setFullScreen}>
        <SheetContent className="slim-ui w-screen max-w-none">
          <DialogFrameHeader
            title={<SheetTitle>{report.name}</SheetTitle>}
            description={
              <SheetDescription className="tabular-nums">
                {title} · {note}
              </SheetDescription>
            }
            closeLabel="Close copy"
            onClose={() => setFullScreen(false)}
          />
          {actions}
          <div className="relative -mx-5 min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            {fullScreen ? (
              <CopyRows
                label={title}
                read={currentRead}
                narrow={narrow}
                onRetry={() => setRetry((value) => value + 1)}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
