"use client";

import { Check, ChevronDown, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/api-errors";
import type { WorkspaceRegion } from "@/lib/date-time";
import { reportDone, reportError, reportUndoable } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusWord } from "@/components/ui/status-word";
import {
  openRowClassName,
  RowOpenButton,
  tintRowClassName,
} from "@/components/systems/access/components/row-open-button";
import { useOpenViewAccessDenied } from "../adapters/openview-access";
import { isAuthorizationDenied } from "../adapters/openview-queries";
import {
  moduleReportListOptions,
  reportCopiesOptions,
  reportKeys,
  reportScheduleOptions,
  type ReportListFilter,
} from "../adapters/report-queries";
import {
  archiveOpenViewReport,
  getOpenViewReport,
  restoreOpenViewReport,
  type OpenViewReport,
} from "../adapters/reports-api";
import type { OpenViewDataSourceField } from "../adapters/views-api";
import { isScheduled, reportListLine } from "../domain/report-words";
import { ReportDetail } from "./report-detail";
import {
  emptyReportDraft,
  reportDraftFrom,
  type ReportViewSource,
} from "./report-draft";
import type { ReportDialogTarget } from "./report-recipe-editor";
import { ReportSteps } from "./report-steps";

export type ReportsRoute = {
  module?: string;
  report?: string;
  copy?: string;
};

type ModuleReportsProps = {
  moduleId: string;
  moduleName: string;
  fields: readonly OpenViewDataSourceField[];
  /** A manager of this module creates, changes, schedules and archives. */
  canManage: boolean;
  /** Why this person cannot make copies (a guest), or null. */
  copyBlockedReason: string | null;
  isAdmin: boolean;
  reportId: string | undefined;
  copyId: string | undefined;
  region: WorkspaceRegion | undefined;
  onRoute: (route: ReportsRoute, replace?: boolean) => void;
  /** The view on the page, for "Make a report from the current view". */
  view: ReportViewSource;
  onOpenDialog: (target: ReportDialogTarget) => void;
};

/** The view as the report dialog's target (DC7): a snapshot, not a share. */
function fromView(view: ReportViewSource): ReportDialogTarget {
  return { kind: "view", snapshot: JSON.stringify(view) };
}

/** "Make a report from this view…" in the Records view menu (DC7). */
export function MakeReportFromViewItem({
  view,
  disabled,
  onOpen,
}: {
  view: ReportViewSource;
  disabled: boolean;
  onOpen: (target: ReportDialogTarget) => void;
}) {
  return (
    <DropdownMenuItem
      className="min-h-11 xl:min-h-8"
      disabled={disabled}
      onClick={() => onOpen(fromView(view))}
    >
      Make a report from this view…
    </DropdownMenuItem>
  );
}

type LinkedReport =
  | { id: string; status: "loading" }
  | { id: string; status: "missing" }
  | { id: string; status: "ready"; report: OpenViewReport };

function ReportListSkeleton() {
  return (
    <ul aria-hidden="true" className="flex flex-col">
      {["a", "b", "c"].map((row) => (
        <li key={row} className="flex flex-col gap-1.5 border-b px-4 py-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </li>
      ))}
    </ul>
  );
}

/**
 * A module page's Reports view (DC1–DC5, DC10–DC12): the module's reports
 * as a list and a detail, or the teaching empty state. On a phone the list
 * and the detail are separate screens.
 */
export function ModuleReports({
  moduleId,
  moduleName,
  fields,
  canManage,
  copyBlockedReason,
  isAdmin,
  reportId,
  copyId,
  region,
  onRoute,
  view,
  onOpenDialog,
}: ModuleReportsProps) {
  const fromScratch = () =>
    onOpenDialog({ kind: "new", draft: emptyReportDraft(moduleId) });
  const queryClient = useQueryClient();
  const accessDenied = useOpenViewAccessDenied();
  const [filter, setFilter] = useState<ReportListFilter>("exclude");
  const listFilter: ReportListFilter = canManage ? filter : "exclude";
  const list = useQuery(moduleReportListOptions(moduleId, listFilter));
  const denied = accessDenied || isAuthorizationDenied(list.error);
  const reports = denied ? [] : (list.data?.items ?? []);
  const [pending, setPending] = useState("");

  // Each row's schedule and copies, shared with the detail's steps.
  const active = reports.filter((report) => !report.isDeleted);
  const schedules = useQueries({
    queries: active.map((report) => reportScheduleOptions(report.id)),
  });
  const copies = useQueries({
    queries: active.map((report) => reportCopiesOptions(report.id)),
  });
  const rowFacts = new Map(
    active.map((report, index) => [
      report.id,
      { schedule: schedules[index], copies: copies[index] },
    ]),
  );

  // A report the list does not hold (archived, another module, or gone) is
  // read once, so an old link opens it or says it is not available (DC8).
  const listed = reports.find((report) => report.id === reportId);
  const [linked, setLinked] = useState<LinkedReport | null>(null);
  const listReady = list.isSuccess && !denied;
  useEffect(() => {
    if (!reportId || listed || !listReady) return;
    let current = true;
    setLinked({ id: reportId, status: "loading" });
    getOpenViewReport(reportId)
      .then((report) => {
        if (current) setLinked({ id: reportId, status: "ready", report });
      })
      .catch(() => {
        if (current) setLinked({ id: reportId, status: "missing" });
      });
    return () => {
      current = false;
    };
  }, [reportId, listed, listReady]);
  const link = !listed && linked?.id === reportId ? linked : null;
  const linkedReport = link?.status === "ready" ? link.report : null;
  // A report of another module opens on its own module page.
  useEffect(() => {
    if (linkedReport && linkedReport.moduleId !== moduleId)
      onRoute(
        {
          module: linkedReport.moduleId,
          report: linkedReport.id,
          copy: copyId,
        },
        true,
      );
  }, [linkedReport, moduleId, copyId, onRoute]);
  const notAvailable = Boolean(reportId) && link?.status === "missing";
  const selected: OpenViewReport | undefined =
    listed ??
    (linkedReport?.moduleId === moduleId ? linkedReport : undefined) ??
    (!reportId || notAvailable ? reports[0] : undefined);
  const linkLoading =
    Boolean(reportId) && !listed && !selected && !notAvailable;

  function select(report: OpenViewReport): void {
    onRoute({ report: report.id });
  }

  function refreshLists(): void {
    void queryClient.invalidateQueries({ queryKey: reportKeys.lists });
  }

  async function restore(report: OpenViewReport, revision: number) {
    const restored = await restoreOpenViewReport({ id: report.id, revision });
    refreshLists();
    setFilter("exclude");
    onRoute({ report: restored.id }, true);
    return restored;
  }

  async function archive(report: OpenViewReport): Promise<void> {
    if (pending) return;
    setPending(report.id);
    try {
      await archiveOpenViewReport({ id: report.id, revision: report.revision });
      refreshLists();
      onRoute({ report: undefined }, true);
      reportUndoable("Report archived.", () => {
        void restore(report, report.revision + 1).catch((reason) =>
          reportError(
            apiErrorMessage(reason, "The report could not be restored."),
          ),
        );
      });
    } catch (reason) {
      reportError(apiErrorMessage(reason, "The report could not be archived."));
    } finally {
      setPending("");
    }
  }

  async function restoreSelected(report: OpenViewReport): Promise<void> {
    if (pending) return;
    setPending(report.id);
    try {
      await restore(report, report.revision);
      reportDone("Report restored.");
    } catch (reason) {
      reportError(apiErrorMessage(reason, "The report could not be restored."));
    } finally {
      setPending("");
    }
  }

  const fieldName = (fieldId: string) =>
    fields.find((field) => field.id === fieldId)?.name;

  if (denied)
    return (
      <Alert
        role="alert"
        variant="destructive"
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <span>Reports are unavailable. Sign in or ask for access.</span>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => void list.refetch()}
        >
          Retry
        </Button>
      </Alert>
    );

  const empty =
    list.isSuccess &&
    reports.length === 0 &&
    listFilter === "exclude" &&
    !selected &&
    !linkLoading;
  const notice = notAvailable ? (
    <Alert role="status" variant="warning" className="shrink-0">
      This report is not available.
    </Alert>
  ) : null;

  if (empty)
    return (
      <div className="access-fill flex min-h-0 min-w-0 flex-col gap-3">
        {notice}
        <Card className="access-fill flex min-w-0 flex-col self-auto">
          <section
            aria-labelledby="reports-empty-title"
            className="flex max-w-[55rem] flex-col items-start gap-4 px-6 py-7"
          >
            <h2
              id="reports-empty-title"
              data-slot="empty-title"
              className="text-[0.9375rem] font-semibold"
            >
              Keep a dated copy of these {moduleName.toLowerCase()}
            </h2>
            <div className="w-full">
              <ReportSteps
                dashed
                label="How a report works"
                steps={[
                  {
                    label: "What it lists",
                    value: `The ${moduleName.toLowerCase()} you choose`,
                    detail: "Start from the view you are using",
                  },
                  {
                    label: "When it runs",
                    value: "Now, or every day, week, or month",
                    detail: "At a time you pick",
                  },
                  {
                    label: "What you keep",
                    value: "A dated copy each time",
                    detail: "Print it or download it later",
                  },
                ]}
              />
            </div>
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="min-h-11"
                  onClick={() => onOpenDialog(fromView(view))}
                >
                  Make a report from the current view
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={fromScratch}
                >
                  Start from scratch
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                No reports for {moduleName} yet.
              </p>
            )}
          </section>
        </Card>
      </div>
    );

  const showDetailOnPhone = Boolean(reportId);
  return (
    <div className="access-fill flex min-h-0 min-w-0 flex-col gap-3">
      {notice}
      <div className="grid min-h-0 min-w-0 gap-3 md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] xl:flex-1 xl:grid-rows-[minmax(0,1fr)]">
        <Card
          aria-labelledby="reports-list-title"
          className={cn(
            "access-fill flex min-h-0 min-w-0 flex-col self-auto overflow-hidden",
            showDetailOnPhone && "max-md:hidden",
          )}
        >
          <div className="flex min-h-14 items-center gap-2 border-b px-4 py-2">
            <h2
              id="reports-list-title"
              data-slot="section-title"
              className="text-[0.9375rem] font-semibold"
            >
              Reports
            </h2>
            {canManage ? (
              <span className="ml-auto flex items-center gap-1">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-11 px-2"
                        aria-label={`Show: ${listFilter === "only" ? "Archived" : "Active"}`}
                      />
                    }
                  >
                    {listFilter === "only" ? "Archived" : "Active"}
                    <ChevronDown
                      aria-hidden="true"
                      className="text-muted-foreground"
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="slim-ui min-w-40">
                    {(
                      [
                        ["exclude", "Active"],
                        ["only", "Archived"],
                      ] as const
                    ).map(([value, label]) => (
                      <DropdownMenuItem
                        key={value}
                        role="menuitemradio"
                        aria-checked={listFilter === value}
                        className="min-h-11 xl:min-h-8"
                        onClick={() => {
                          setFilter(value);
                          onRoute({ report: undefined });
                        }}
                      >
                        {label}
                        {listFilter === value ? (
                          <Check aria-hidden="true" className="ml-auto" />
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={fromScratch}
                >
                  <Plus aria-hidden="true" />
                  New report
                </Button>
              </span>
            ) : null}
          </div>
          <LoadingRegion
            loading={list.isPending}
            label="Loading reports…"
            skeleton={<ReportListSkeleton />}
            className="access-fill relative min-h-0 overflow-y-auto overscroll-contain"
          >
            {list.isError && !list.data ? (
              <div className="p-4">
                <Alert
                  role="alert"
                  variant="destructive"
                  className="flex flex-wrap items-center justify-between gap-3"
                >
                  <span>Reports could not be loaded. Try again.</span>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => void list.refetch()}
                  >
                    Retry
                  </Button>
                </Alert>
              </div>
            ) : reports.length === 0 ? (
              <p className="text-muted-foreground px-4 py-6 text-sm">
                No archived reports.
              </p>
            ) : (
              <ul
                aria-label={`${moduleName} reports`}
                className="flex flex-col"
              >
                {reports.map((report) => {
                  const facts = rowFacts.get(report.id);
                  const schedule = facts?.schedule.data;
                  const total = facts?.copies.data?.pagination.total;
                  const current = report.id === selected?.id;
                  const line = report.isDeleted
                    ? "Archived"
                    : schedule === undefined || total === undefined
                      ? "…"
                      : reportListLine(schedule, total);
                  return (
                    <li
                      key={report.id}
                      data-state={current ? "selected" : undefined}
                      aria-current={current ? "true" : undefined}
                      className={cn(
                        openRowClassName,
                        tintRowClassName,
                        "flex min-w-0 items-start gap-3 border-b px-4 py-2",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <RowOpenButton
                          title={report.name}
                          subtitle={
                            <span className="tabular-nums">{line}</span>
                          }
                          onOpen={() => select(report)}
                        />
                      </span>
                      {report.isDeleted ? null : schedule ===
                        undefined ? null : (
                        <StatusWord
                          className="pt-3 text-sm"
                          word={
                            isScheduled(schedule)
                              ? "Scheduled"
                              : "Not scheduled"
                          }
                          tone={isScheduled(schedule) ? "flow" : "muted"}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </LoadingRegion>
        </Card>
        <Card
          className={cn(
            "access-fill flex min-h-0 min-w-0 flex-col self-auto overflow-hidden",
            !showDetailOnPhone && "max-md:hidden",
          )}
        >
          {selected ? (
            <ReportDetail
              key={selected.id}
              report={selected}
              moduleName={moduleName}
              fieldName={fieldName}
              canManage={canManage}
              copyBlockedReason={copyBlockedReason}
              isAdmin={isAdmin}
              copyId={selected.id === reportId ? copyId : undefined}
              region={region}
              lifecyclePending={pending === selected.id}
              onSelectCopy={(copy) => onRoute({ report: selected.id, copy })}
              onBack={() => onRoute({ report: undefined })}
              onEdit={() => onOpenDialog({ kind: "edit", report: selected })}
              onDuplicate={() =>
                onOpenDialog({
                  kind: "new",
                  draft: {
                    ...reportDraftFrom(selected),
                    name: `Copy of ${selected.name}`.slice(0, 80),
                  },
                })
              }
              onArchive={() => void archive(selected)}
              onRestore={() => void restoreSelected(selected)}
              onPurged={() => {
                refreshLists();
                onRoute({ report: undefined }, true);
                reportDone("Report deleted forever.");
              }}
            />
          ) : linkLoading ? (
            <div role="status" aria-label="Opening the report" className="p-4">
              <Skeleton className="mb-3 h-6 w-1/3" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : (
            <p className="text-muted-foreground p-4 text-sm">
              Choose a report.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
