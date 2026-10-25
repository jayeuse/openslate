"use client";

import { ArrowLeft, MoreHorizontal, Plus } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  formatWorkspaceClockTime,
  type WorkspaceRegion,
} from "@/lib/date-time";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusWord } from "@/components/ui/status-word";
import {
  createOpenViewReportRun,
  type OpenViewReport,
  type OpenViewReportRun,
} from "../adapters/reports-api";
import {
  reportCopiesOptions,
  reportKeys,
  reportScheduleOptions,
} from "../adapters/report-queries";
import type { OpenViewPage } from "../adapters/views-api";
import {
  columnsWords,
  copiesWords,
  isScheduled,
  listsWords,
  runsWords,
  shortDate,
} from "../domain/report-words";
import { ReportCopyPanel } from "./report-copy-panel";
import {
  ReportPurgeDialog,
  useReportPurgeEnabled,
} from "./report-purge-dialog";
import { ReportScheduleControls } from "./report-schedule-controls";
import { ReportSteps } from "./report-steps";

export type ReportDetailProps = {
  report: OpenViewReport;
  moduleName: string;
  fieldName: (fieldId: string) => string | undefined;
  /** A manager of the report's module changes, schedules and archives it. */
  canManage: boolean;
  /** Any reader who is not a guest makes copies; null when they may. */
  copyBlockedReason: string | null;
  isAdmin: boolean;
  copyId: string | undefined;
  region: WorkspaceRegion | undefined;
  /** A list action (Archive, Restore) of this report is running. */
  lifecyclePending: boolean;
  onSelectCopy: (copyId: string | undefined) => void;
  onBack: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onPurged: () => void;
};

/**
 * One report (DC3–DC5): its name, More report actions and "Make a copy now";
 * the three steps (what it lists → when it runs → what you keep); then the
 * latest copy itself, or the schedule while step 2 is open.
 */
export function ReportDetail({
  report,
  moduleName,
  fieldName,
  canManage,
  copyBlockedReason,
  isAdmin,
  copyId,
  region,
  lifecyclePending,
  onSelectCopy,
  onBack,
  onEdit,
  onDuplicate,
  onArchive,
  onRestore,
  onPurged,
}: ReportDetailProps) {
  const queryClient = useQueryClient();
  const scheduleId = useId();
  const archived = report.isDeleted;
  const schedule = useQuery({
    ...reportScheduleOptions(report.id),
    enabled: !archived,
  });
  const copies = useQuery({
    ...reportCopiesOptions(report.id),
    enabled: !archived,
  });
  const purgeEnabled = useReportPurgeEnabled(isAdmin, archived);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [making, setMaking] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  // A retried copy reuses its request key, so one click makes one copy.
  const retryKey = useRef<{ reportId: string; key: string } | null>(null);

  async function makeCopy(): Promise<void> {
    if (making || copyBlockedReason || archived) return;
    if (retryKey.current?.reportId !== report.id)
      retryKey.current = { reportId: report.id, key: crypto.randomUUID() };
    setMaking(true);
    setCopyError("");
    setCopyStatus("");
    try {
      const run = await createOpenViewReportRun({
        reportId: report.id,
        idempotencyKey: retryKey.current.key,
      });
      retryKey.current = null;
      queryClient.setQueryData<OpenViewPage<OpenViewReportRun>>(
        reportKeys.copies(report.id),
        (page) =>
          page
            ? {
                items: [
                  run,
                  ...page.items.filter((item) => item.id !== run.id),
                ].slice(0, page.pagination.limit),
                pagination: {
                  ...page.pagination,
                  total: page.pagination.total + 1,
                },
              }
            : page,
      );
      void queryClient.invalidateQueries({
        queryKey: reportKeys.copies(report.id),
      });
      setScheduleOpen(false);
      onSelectCopy(undefined);
      setCopyStatus(
        `Copy made with ${run.rowCount} ${run.rowCount === 1 ? "row" : "rows"}.`,
      );
    } catch (reason) {
      setCopyError(
        apiErrorMessage(reason, "The copy was not made. Try again."),
      );
    } finally {
      setMaking(false);
    }
  }

  const savedSchedule = schedule.data ?? null;
  const time = savedSchedule
    ? region
      ? formatWorkspaceClockTime(savedSchedule.localTime, region)
      : savedSchedule.localTime
    : "";
  const total = copies.data?.pagination.total ?? 0;
  const latest = copies.data?.items[0];
  const recipe = report.recipe;
  const canChange = canManage && !archived;
  const steps = [
    {
      label: "What it lists",
      value: listsWords(recipe, moduleName, fieldName),
      detail: columnsWords(recipe),
      change: canChange
        ? { label: "Change what it lists", onClick: onEdit }
        : undefined,
    },
    {
      label: "When it runs",
      value:
        schedule.isPending && !archived ? "…" : runsWords(savedSchedule, time),
      detail: (
        <>
          {isScheduled(savedSchedule)
            ? savedSchedule.nextDueAt
              ? `Next: ${shortDate(savedSchedule.nextDueAt, region)}`
              : "Next copy not set"
            : "Not scheduled"}
          {/* A failed scheduled copy is a fact every reader needs. */}
          {savedSchedule?.lastRun?.state === "failed" ? (
            <span className="text-warn-text block">
              Last run failed
              {savedSchedule.lastRun.failureLabel
                ? ` · ${savedSchedule.lastRun.failureLabel}`
                : ""}
            </span>
          ) : null}
        </>
      ),
      change: canChange
        ? {
            label: "Change when it runs",
            onClick: () => setScheduleOpen((open) => !open),
            expanded: scheduleOpen,
            controls: scheduleId,
          }
        : undefined,
    },
    {
      label: "What you keep",
      value: "A dated copy each time",
      detail: archived
        ? "Kept while archived"
        : latest
          ? `${copiesWords(total)} · latest ${shortDate(latest.createdAt, region)}`
          : copiesWords(total),
    },
  ] as const;

  const menu = canManage ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label="More report actions"
            disabled={lifecyclePending}
          />
        }
      >
        <MoreHorizontal aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="slim-ui min-w-48">
        {archived ? (
          <>
            <DropdownMenuItem
              className="min-h-11 xl:min-h-8"
              onClick={onRestore}
            >
              Restore
            </DropdownMenuItem>
            {purgeEnabled ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  className="min-h-11 xl:min-h-8"
                  onClick={() => setPurgeOpen(true)}
                >
                  Delete forever…
                </DropdownMenuItem>
              </>
            ) : null}
          </>
        ) : (
          <>
            <DropdownMenuItem
              className="min-h-11 xl:min-h-8"
              onClick={onDuplicate}
            >
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              className="min-h-11 xl:min-h-8"
              onClick={onArchive}
            >
              Archive
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <section
      aria-labelledby={`${scheduleId}-name`}
      className="access-fill flex min-h-0 min-w-0 flex-col"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-4 pt-3 pb-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="-ml-2 size-11 md:hidden"
          aria-label="Back to reports"
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2
            id={`${scheduleId}-name`}
            data-slot="section-title"
            className="text-base font-semibold break-words"
          >
            {report.name}
          </h2>
          {report.subtitle ? (
            <p className="text-muted-foreground text-xs break-words">
              {report.subtitle}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {archived ? (
            <StatusWord word="Archived" tone="muted" className="mr-2 text-sm" />
          ) : null}
          {menu}
        </div>
        {/* On a phone the primary takes its own row under the name. */}
        {archived ? null : (
          <div className="flex shrink-0 max-md:w-full">
            <DisabledReason reason={copyBlockedReason}>
              <Button
                type="button"
                className="min-h-11 max-md:flex-1"
                disabled={making}
                onClick={() => void makeCopy()}
              >
                <Plus aria-hidden="true" />
                {making ? "Making a copy…" : "Make a copy now"}
              </Button>
            </DisabledReason>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3 px-4 pb-3">
        <ReportSteps steps={steps} label="How this report works" />
        {copyError ? (
          <Alert role="alert" variant="destructive">
            {copyError}
          </Alert>
        ) : null}
        <p role="status" className="sr-only">
          {copyStatus}
        </p>
      </div>
      {archived ? (
        <p className="text-muted-foreground border-t px-4 py-6 text-sm">
          Restore this report to make or open its copies.
        </p>
      ) : scheduleOpen && canChange ? (
        <section
          id={scheduleId}
          aria-label="When it runs"
          className="relative min-h-0 overflow-y-auto border-t px-4 py-3 xl:flex-1"
        >
          {schedule.isPending ? (
            <p role="status" className="text-muted-foreground text-sm">
              Loading schedule…
            </p>
          ) : schedule.isError ? (
            <Alert
              role="alert"
              variant="destructive"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <span>The schedule could not be loaded. Try again.</span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => void schedule.refetch()}
              >
                Retry
              </Button>
            </Alert>
          ) : (
            <ReportScheduleControls
              key={report.id}
              reportId={report.id}
              schedule={savedSchedule}
              region={region}
            />
          )}
        </section>
      ) : (
        <ReportCopyPanel
          key={report.id}
          report={report}
          copies={copies.data}
          copiesPending={copies.isPending}
          copiesFailed={copies.isError}
          onRetryCopies={() => void copies.refetch()}
          copyId={copyId}
          region={region}
          onSelectCopy={onSelectCopy}
        />
      )}
      {purgeOpen ? (
        <ReportPurgeDialog
          report={report}
          onClose={() => setPurgeOpen(false)}
          onPurged={() => {
            setPurgeOpen(false);
            onPurged();
          }}
        />
      ) : null}
    </section>
  );
}
