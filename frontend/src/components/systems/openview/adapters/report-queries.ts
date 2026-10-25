"use client";

import { queryOptions } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { getOpenViewReportSchedule } from "./report-schedule-api";
import { listOpenViewReportRuns, listOpenViewReports } from "./reports-api";

// The cached reads of a module page's Reports view (DC1–DC5). They live
// apart from openview-queries.ts, which the shell's sidebar prefetch imports,
// so the Report contract stays in the OpenView route's own chunk. Every key
// starts with "openview", so the OpenView stream bridge refreshes them.

/** A module's reports are few; one page holds them (DC2). */
export const MODULE_REPORT_LIMIT = 100;
/** The latest copies of a report: its list line, step 3, and Older copies. */
export const REPORT_COPY_PAGE_SIZE = 25;

export type ReportListFilter = "exclude" | "only";

export const reportKeys = {
  all: ["openview", "reports"] as const,
  lists: ["openview", "reports", "list"] as const,
  list: (moduleId: string, deleted: ReportListFilter) =>
    ["openview", "reports", "list", moduleId, deleted] as const,
  /** One report's schedule and latest copies. */
  report: (reportId: string) => ["openview", "reports", reportId] as const,
  schedule: (reportId: string) =>
    ["openview", "reports", reportId, "schedule"] as const,
  copies: (reportId: string) =>
    ["openview", "reports", reportId, "copies"] as const,
};

/** The module's reports, active or archived (archived is a list filter). */
export const moduleReportListOptions = (
  moduleId: string,
  deleted: ReportListFilter = "exclude",
) =>
  queryOptions({
    queryKey: reportKeys.list(moduleId, deleted),
    queryFn: () =>
      listOpenViewReports({
        moduleId,
        limit: MODULE_REPORT_LIMIT,
        offset: 0,
        deleted,
      }),
    enabled: Boolean(moduleId),
  });

/** A report's schedule, or null when it has none (the API answers 404). */
export const reportScheduleOptions = (reportId: string) =>
  queryOptions({
    queryKey: reportKeys.schedule(reportId),
    queryFn: async () => {
      try {
        return await getOpenViewReportSchedule(reportId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });

/** The latest copies of a report (the API lists newest first) and their count. */
export const reportCopiesOptions = (reportId: string) =>
  queryOptions({
    queryKey: reportKeys.copies(reportId),
    queryFn: () =>
      listOpenViewReportRuns(reportId, {
        limit: REPORT_COPY_PAGE_SIZE,
        offset: 0,
      }),
  });
