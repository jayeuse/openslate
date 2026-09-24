"use client";

import { Download, Plus, Printer, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import {
  archiveOpenViewReport,
  createOpenViewReport,
  createOpenViewReportRun,
  downloadOpenViewReportRunCsv,
  getOpenViewReport,
  getOpenViewReportConflict,
  listOpenViewReportRuns,
  listOpenViewReports,
  listOpenViewSharedReportRuns,
  restoreOpenViewReport,
  updateOpenViewReport,
  type OpenViewReport,
  type OpenViewReportRun,
  type OpenViewSharedReportRun,
} from "../adapters/reports-api";
import {
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  type OpenViewDataSource,
  type OpenViewDataSourceField,
} from "../adapters/views-api";
import {
  emptyReportDraft,
  reportDraftFrom,
  reportDraftSignature,
  reportRecipeFromDraft,
  ReportDraftError,
  type ReportDraft,
  type ReportFilterDraft,
} from "./report-draft";
import { ReportRecipeEditor } from "./report-recipe-editor";
import { ReportScheduleControls } from "./report-schedule-controls";

const PAGE_SIZE = 25;
const CATALOG_PAGE_SIZE = 100;
type OutputAction = "download" | "print";

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function printFrozenCsv(printWindow: Window, csv: string, title: string): void {
  const page = printWindow.document;
  page.title = title;
  const heading = page.createElement("h1");
  heading.textContent = title;
  const content = page.createElement("pre");
  content.textContent = csv;
  content.style.whiteSpace = "pre-wrap";
  content.style.overflowWrap = "anywhere";
  page.body.append(heading, content);
  printWindow.focus();
  printWindow.print();
}

export default function ServerBackedReports() {
  const [reports, setReports] = useState<OpenViewReport[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [listOffset, setListOffset] = useState(0);
  const [listHasMore, setListHasMore] = useState(false);
  const [listRefresh, setListRefresh] = useState(0);
  const [sources, setSources] = useState<OpenViewDataSource[]>([]);
  const [sourcesHasMore, setSourcesHasMore] = useState(false);
  const [sourcesOffset, setSourcesOffset] = useState(0);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState("");
  const [sourcesRefresh, setSourcesRefresh] = useState(0);
  const [fields, setFields] = useState<OpenViewDataSourceField[]>([]);
  const [fieldsForModule, setFieldsForModule] = useState("");
  const [fieldsHasMore, setFieldsHasMore] = useState(false);
  const [fieldsOffset, setFieldsOffset] = useState(0);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldsError, setFieldsError] = useState("");
  const [fieldsRefresh, setFieldsRefresh] = useState(0);
  const [baselineReport, setBaselineReport] = useState<OpenViewReport | null>(
    null,
  );
  const [draft, setDraft] = useState<ReportDraft>(() => emptyReportDraft());
  const [baselineDraft, setBaselineDraft] = useState<ReportDraft>(() =>
    emptyReportDraft(),
  );
  const [actionPending, setActionPending] = useState("");
  const actionRef = useRef(false);
  const moduleIdRef = useRef("");
  const runRetryRef = useRef<{ reportId: string; key: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const [runs, setRuns] = useState<OpenViewReportRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState("");
  const [runsOffset, setRunsOffset] = useState(0);
  const [runsHasMore, setRunsHasMore] = useState(false);
  const [runsRefresh, setRunsRefresh] = useState(0);
  const [sharedRuns, setSharedRuns] = useState<OpenViewSharedReportRun[]>([]);
  const [sharedLoading, setSharedLoading] = useState(true);
  const [sharedError, setSharedError] = useState("");
  const [sharedOffset, setSharedOffset] = useState(0);
  const [sharedHasMore, setSharedHasMore] = useState(false);
  const [sharedRefresh, setSharedRefresh] = useState(0);
  const [pendingNavigation, setPendingNavigation] = useState<{
    resume: () => void;
  } | null>(null);

  const dirty =
    reportDraftSignature(draft) !== reportDraftSignature(baselineDraft);
  const canEdit = !baselineReport?.isDeleted && !actionPending;

  const navigationGuard = useCallback(
    (href: string, resume: () => void) => {
      if (actionRef.current) return false;
      if (!dirty) return true;
      if (
        typeof window !== "undefined" &&
        new URL(href, window.location.origin).href === window.location.href
      )
        return true;
      setPendingNavigation({ resume });
      return false;
    },
    [dirty, setPendingNavigation],
  );
  useWorkspaceNavigationGuard(navigationGuard);

  useEffect(() => {
    moduleIdRef.current = draft.moduleId;
  }, [draft.moduleId]);

  useEffect(() => {
    let active = true;
    void listOpenViewReports({
      limit: PAGE_SIZE,
      offset: listOffset,
      deleted: showArchived ? "include" : "exclude",
    })
      .then((page) => {
        if (!active) return;
        setReports((current) =>
          listOffset === 0
            ? page.items
            : [
                ...current,
                ...page.items.filter(
                  (item) => !current.some((report) => report.id === item.id),
                ),
              ],
        );
        setListHasMore(page.pagination.hasMore);
        setListError("");
      })
      .catch(() => {
        if (active) setListError("Reports could not be loaded. Try again.");
      })
      .finally(() => {
        if (active) setListLoading(false);
      });
    return () => {
      active = false;
    };
  }, [listOffset, listRefresh, showArchived]);

  useEffect(() => {
    let active = true;
    void listOpenViewSharedReportRuns({
      limit: PAGE_SIZE,
      offset: sharedOffset,
    })
      .then((page) => {
        if (!active) return;
        setSharedRuns((current) =>
          sharedOffset === 0
            ? page.items
            : [
                ...current,
                ...page.items.filter(
                  (item) => !current.some((run) => run.id === item.id),
                ),
              ],
        );
        setSharedHasMore(page.pagination.hasMore);
        setSharedError("");
      })
      .catch(() => {
        if (active)
          setSharedError("Available runs could not be loaded. Try again.");
      })
      .finally(() => {
        if (active) setSharedLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sharedOffset, sharedRefresh]);

  useEffect(() => {
    let active = true;
    void listOpenViewDataSources({ limit: CATALOG_PAGE_SIZE, offset: 0 })
      .then((page) => {
        if (!active) return;
        setSources(page.items);
        setSourcesHasMore(page.pagination.hasMore);
        setSourcesOffset(page.pagination.count);
        setSourcesError("");
      })
      .catch(() => {
        if (active)
          setSourcesError("Data sources could not be loaded. Try again.");
      })
      .finally(() => {
        if (active) setSourcesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sourcesRefresh]);

  useEffect(() => {
    if (!draft.moduleId) {
      setFields([]);
      setFieldsForModule("");
      return;
    }
    const moduleId = draft.moduleId;
    let active = true;
    setFieldsLoading(true);
    setFieldsError("");
    void listOpenViewDataSourceFields(moduleId, {
      limit: CATALOG_PAGE_SIZE,
      offset: 0,
    })
      .then((page) => {
        if (!active) return;
        setFields(page.items);
        setFieldsForModule(moduleId);
        setFieldsHasMore(page.pagination.hasMore);
        setFieldsOffset(page.pagination.count);
      })
      .catch(() => {
        if (active) setFieldsError("Fields could not be loaded. Try again.");
      })
      .finally(() => {
        if (active) setFieldsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [draft.moduleId, fieldsRefresh]);

  useEffect(() => {
    if (!baselineReport || baselineReport.isDeleted) {
      setRuns([]);
      setRunsHasMore(false);
      setRunsLoading(false);
      return;
    }
    const reportId = baselineReport.id;
    let active = true;
    setRunsLoading(true);
    void listOpenViewReportRuns(reportId, {
      limit: PAGE_SIZE,
      offset: runsOffset,
    })
      .then((page) => {
        if (!active) return;
        setRuns((current) =>
          runsOffset === 0
            ? page.items
            : [
                ...current,
                ...page.items.filter(
                  (item) => !current.some((run) => run.id === item.id),
                ),
              ],
        );
        setRunsHasMore(page.pagination.hasMore);
        setRunsError("");
      })
      .catch(() => {
        if (active)
          setRunsError("Report history could not be loaded. Try again.");
      })
      .finally(() => {
        if (active) setRunsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [baselineReport?.id, baselineReport?.isDeleted, runsOffset, runsRefresh]);

  function beginAction(name: string): boolean {
    if (actionRef.current) return false;
    actionRef.current = true;
    setActionPending(name);
    setError("");
    setNotice("");
    return true;
  }

  function endAction(): void {
    actionRef.current = false;
    setActionPending("");
  }

  function openReport(report: OpenViewReport): void {
    if (
      actionRef.current ||
      (dirty && !window.confirm("Discard unsaved Report changes?"))
    )
      return;
    const nextDraft = reportDraftFrom(report);
    setBaselineReport(report);
    setDraft(nextDraft);
    setBaselineDraft(nextDraft);
    setRunsOffset(0);
    setRuns([]);
    setRunsRefresh((current) => current + 1);
    setError("");
    setNotice("");
    setStale(false);
    runRetryRef.current = null;
  }

  function newReport(): void {
    if (
      actionRef.current ||
      (dirty && !window.confirm("Discard unsaved Report changes?"))
    )
      return;
    const nextDraft = emptyReportDraft();
    setBaselineReport(null);
    setDraft(nextDraft);
    setBaselineDraft(nextDraft);
    setError("");
    setNotice("");
    setStale(false);
    setRuns([]);
    runRetryRef.current = null;
  }

  function changeModule(moduleId: string): void {
    if (draft.moduleId === moduleId) return;
    if (
      (draft.fields.length || draft.filters.length || draft.sorts.length) &&
      !window.confirm(
        "Changing the source clears Report fields, filters, and sorting. Continue?",
      )
    )
      return;
    setDraft((current) => ({
      ...current,
      moduleId,
      fields: [],
      filters: [],
      sorts: [],
      groupBy: null,
    }));
  }

  async function loadMoreSources(): Promise<void> {
    if (sourcesLoading || !sourcesHasMore) return;
    setSourcesLoading(true);
    try {
      const page = await listOpenViewDataSources({
        limit: CATALOG_PAGE_SIZE,
        offset: sourcesOffset,
      });
      setSources((current) => [...current, ...page.items]);
      setSourcesOffset((current) => current + page.pagination.count);
      setSourcesHasMore(page.pagination.hasMore);
      setSourcesError("");
    } catch {
      setSourcesError("More data sources could not be loaded. Try again.");
    } finally {
      setSourcesLoading(false);
    }
  }

  async function loadMoreFields(): Promise<void> {
    if (fieldsLoading || !fieldsHasMore || !draft.moduleId) return;
    const moduleId = draft.moduleId;
    setFieldsLoading(true);
    try {
      const page = await listOpenViewDataSourceFields(moduleId, {
        limit: CATALOG_PAGE_SIZE,
        offset: fieldsOffset,
      });
      if (moduleId !== moduleIdRef.current) return;
      setFields((current) => [...current, ...page.items]);
      setFieldsOffset((current) => current + page.pagination.count);
      setFieldsHasMore(page.pagination.hasMore);
      setFieldsError("");
    } catch {
      if (moduleId === moduleIdRef.current)
        setFieldsError("More fields could not be loaded. Try again.");
    } finally {
      if (moduleId === moduleIdRef.current) setFieldsLoading(false);
    }
  }

  async function saveReport(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canEdit || !beginAction("save")) return;
    try {
      if (!draft.moduleId)
        throw new ReportDraftError("Choose a data source for this Report");
      if (!draft.name.trim()) throw new ReportDraftError("Enter a Report name");
      if (
        (draft.audience.kind === "role" && !draft.audience.roleId) ||
        (draft.audience.kind === "user" && !draft.audience.userId)
      )
        throw new ReportDraftError("Choose a Report audience target");
      const recipe = reportRecipeFromDraft(draft);
      const input = {
        moduleId: draft.moduleId,
        name: draft.name.trim(),
        subtitle: draft.subtitle.trim() || null,
        audience: draft.audience,
        recipe,
      };
      const saved = baselineReport
        ? await updateOpenViewReport({
            id: baselineReport.id,
            revision: baselineReport.revision,
            ...input,
          })
        : await createOpenViewReport(input);
      const nextDraft = reportDraftFrom(saved);
      setBaselineReport(saved);
      setDraft(nextDraft);
      setBaselineDraft(nextDraft);
      setReports((current) => [
        saved,
        ...current.filter((report) => report.id !== saved.id),
      ]);
      setListOffset(0);
      setListRefresh((current) => current + 1);
      setStale(false);
      setNotice(baselineReport ? "Report saved." : "Report created.");
      runRetryRef.current = null;
    } catch (reason) {
      const conflict = getOpenViewReportConflict(reason);
      setStale(Boolean(conflict));
      setError(
        conflict?.message ??
          (reason instanceof ReportDraftError
            ? reason.message
            : safeMessage(
                reason,
                "The Report could not be saved. Your draft remains open.",
              )),
      );
    } finally {
      endAction();
    }
  }

  async function reloadLatest(): Promise<void> {
    if (!baselineReport || !beginAction("reload")) return;
    if (
      dirty &&
      !window.confirm(
        "Replace your unsaved draft with the latest saved Report?",
      )
    ) {
      endAction();
      return;
    }
    try {
      const latest = await getOpenViewReport(baselineReport.id);
      const nextDraft = reportDraftFrom(latest);
      setBaselineReport(latest);
      setDraft(nextDraft);
      setBaselineDraft(nextDraft);
      setStale(false);
      setNotice("Latest Report loaded.");
      setReports((current) =>
        current.map((report) => (report.id === latest.id ? latest : report)),
      );
    } catch (reason) {
      setError(
        safeMessage(
          reason,
          "The latest Report could not be loaded. Try again.",
        ),
      );
    } finally {
      endAction();
    }
  }

  async function archiveOrRestore(): Promise<void> {
    if (
      !baselineReport ||
      dirty ||
      !beginAction(baselineReport.isDeleted ? "restore" : "archive")
    )
      return;
    try {
      let updated: OpenViewReport;
      if (baselineReport.isDeleted) {
        updated = await restoreOpenViewReport({
          id: baselineReport.id,
          revision: baselineReport.revision,
        });
      } else {
        if (
          !window.confirm(
            "Archive this Report? Its saved runs remain retained, but are unavailable until restore.",
          )
        )
          return;
        await archiveOpenViewReport({
          id: baselineReport.id,
          revision: baselineReport.revision,
        });
        updated = {
          ...baselineReport,
          isDeleted: true,
          revision: baselineReport.revision + 1,
        };
        setShowArchived(true);
      }
      const nextDraft = reportDraftFrom(updated);
      setBaselineReport(updated);
      setBaselineDraft(nextDraft);
      setDraft(nextDraft);
      setReports((current) =>
        current.map((report) => (report.id === updated.id ? updated : report)),
      );
      setListOffset(0);
      setListRefresh((current) => current + 1);
      setNotice(updated.isDeleted ? "Report archived." : "Report restored.");
      runRetryRef.current = null;
    } catch (reason) {
      const conflict = getOpenViewReportConflict(reason);
      setStale(Boolean(conflict));
      setError(
        conflict?.message ??
          safeMessage(reason, "The Report could not be changed. Try again."),
      );
    } finally {
      endAction();
    }
  }

  async function runReport(): Promise<void> {
    if (
      !baselineReport ||
      baselineReport.isDeleted ||
      dirty ||
      !beginAction("run")
    )
      return;
    const reportId = baselineReport.id;
    if (runRetryRef.current?.reportId !== reportId) {
      runRetryRef.current = { reportId, key: crypto.randomUUID() };
    }
    try {
      const run = await createOpenViewReportRun({
        reportId,
        idempotencyKey: runRetryRef.current.key,
      });
      runRetryRef.current = null;
      setRuns((current) => [
        run,
        ...current.filter((item) => item.id !== run.id),
      ]);
      setRunsOffset(0);
      setRunsRefresh((current) => current + 1);
      setSharedOffset(0);
      setSharedRefresh((current) => current + 1);
      setNotice(
        `Report run saved with ${run.rowCount} ${run.rowCount === 1 ? "row" : "rows"}.`,
      );
    } catch (reason) {
      setError(
        safeMessage(
          reason,
          "The Report could not run. Retry uses the same request key.",
        ),
      );
    } finally {
      endAction();
    }
  }

  async function outputRun(
    run: OpenViewReportRun | OpenViewSharedReportRun,
    reportName: string,
    action: OutputAction,
  ): Promise<void> {
    if (!beginAction(`${action}:${run.id}`)) return;
    const isSharedRun = "reportName" in run;
    if (isSharedRun) setSharedError("");
    const printWindow = action === "print" ? window.open("", "_blank") : null;
    if (printWindow) printWindow.opener = null;
    try {
      if (action === "print" && !printWindow)
        throw new Error(
          "Your browser blocked the print window. Allow pop-ups and try again.",
        );
      const { blob, filename } = await downloadOpenViewReportRunCsv(
        run.reportId,
        run.id,
      );
      if (action === "print") {
        printFrozenCsv(
          printWindow!,
          await blob.text(),
          `${reportName} — ${formatDate(run.createdAt)}`,
        );
      } else {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
    } catch (reason) {
      printWindow?.close();
      const message =
        reason instanceof Error &&
        reason.message.startsWith("Your browser blocked")
          ? reason.message
          : safeMessage(
              reason,
              "The saved Report output could not be opened. Try again.",
            );
      if (isSharedRun) setSharedError(message);
      else setError(message);
    } finally {
      endAction();
    }
  }

  function updateFilter(key: string, change: Partial<ReportFilterDraft>): void {
    setDraft((current) => ({
      ...current,
      filters: current.filters.map((filter) =>
        filter.key === key
          ? {
              ...filter,
              ...change,
              ...("fieldId" in change || "operator" in change
                ? { originalValue: undefined, originalText: undefined }
                : {}),
            }
          : filter,
      ),
    }));
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Reports</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Save a recipe, run it when needed, and open the retained output.
          </p>
        </div>
        <Button
          type="button"
          onClick={newReport}
          disabled={Boolean(actionPending)}
          className="min-h-11"
        >
          <Plus data-icon="inline-start" /> New Report
        </Button>
      </header>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card className="min-w-0 self-start">
            <CardHeader>
              <CardTitle>Saved Reports</CardTitle>
              <CardDescription>
                Only Reports you own appear here.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Field className="min-h-11 flex-row items-center gap-3">
                  <Checkbox
                    id="reports-show-archived"
                    checked={showArchived}
                    onCheckedChange={(value) => {
                      setShowArchived(Boolean(value));
                      setListOffset(0);
                      setListLoading(true);
                    }}
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
                  onClick={() => {
                    setListOffset(0);
                    setListLoading(true);
                    setListRefresh((current) => current + 1);
                  }}
                >
                  <RefreshCw />
                </Button>
              </div>
              {listError ? (
                <Alert role="alert" variant="destructive">
                  {listError}
                  <Button
                    type="button"
                    variant="outline"
                    className="ml-3 min-h-11"
                    onClick={() => {
                      setListLoading(true);
                      setListRefresh((current) => current + 1);
                    }}
                  >
                    Retry
                  </Button>
                </Alert>
              ) : null}
              {listLoading && reports.length === 0 ? (
                <p role="status" className="text-muted-foreground text-sm">
                  Loading Reports…
                </p>
              ) : null}
              {!listLoading && reports.length === 0 && !listError ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No saved Reports</EmptyTitle>
                    <EmptyDescription>
                      Choose a data source and fields to create your first
                      Report.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
              <ul className="flex min-w-0 flex-col gap-2">
                {reports.map((report) => (
                  <li key={report.id}>
                    <Button
                      type="button"
                      variant={
                        baselineReport?.id === report.id
                          ? "secondary"
                          : "outline"
                      }
                      className="min-h-11 w-full justify-start text-left"
                      disabled={Boolean(actionPending)}
                      onClick={() => openReport(report)}
                    >
                      <span className="min-w-0 truncate">{report.name}</span>
                      {report.isDeleted ? (
                        <Badge variant="outline" className="ml-auto">
                          Archived
                        </Badge>
                      ) : null}
                    </Button>
                  </li>
                ))}
              </ul>
              {listHasMore ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={listLoading}
                  onClick={() => {
                    setListLoading(true);
                    setListOffset(reports.length);
                  }}
                >
                  Load more Reports
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Available runs</CardTitle>
              <CardDescription>
                Saved outputs you are eligible to open, including your own.
                Recipe editing stays with the owner.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-4">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 self-start"
                disabled={sharedLoading}
                onClick={() => {
                  setSharedOffset(0);
                  setSharedLoading(true);
                  setSharedRefresh((current) => current + 1);
                }}
              >
                Refresh available runs
              </Button>
              {sharedError ? (
                <Alert role="alert" variant="destructive">
                  {sharedError}
                  <Button
                    type="button"
                    variant="outline"
                    className="ml-3 min-h-11"
                    onClick={() => {
                      setSharedLoading(true);
                      setSharedRefresh((current) => current + 1);
                    }}
                  >
                    Retry
                  </Button>
                </Alert>
              ) : null}
              {sharedLoading && sharedRuns.length === 0 ? (
                <p role="status" className="text-muted-foreground text-sm">
                  Loading available runs…
                </p>
              ) : null}
              {!sharedLoading && sharedRuns.length === 0 && !sharedError ? (
                <p className="text-muted-foreground text-sm">
                  No runs available to this account.
                </p>
              ) : null}
              <ul className="flex min-w-0 flex-col gap-3">
                {sharedRuns.map((run) => (
                  <li
                    key={run.id}
                    className="border-border rounded-lg border p-3"
                  >
                    <p className="font-medium break-words">{run.reportName}</p>
                    <p className="text-muted-foreground text-sm">
                      {formatDate(run.createdAt)} · {run.rowCount}{" "}
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
                          void outputRun(run, run.reportName, "download")
                        }
                      >
                        <Download data-icon="inline-start" /> CSV
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={Boolean(actionPending)}
                        onClick={() =>
                          void outputRun(run, run.reportName, "print")
                        }
                      >
                        <Printer data-icon="inline-start" /> Print
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              {sharedHasMore ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={sharedLoading}
                  onClick={() => {
                    setSharedLoading(true);
                    setSharedOffset(sharedRuns.length);
                  }}
                >
                  Load more available runs
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <ReportRecipeEditor
            baselineReport={baselineReport}
            draft={draft}
            setDraft={setDraft}
            dirty={dirty}
            actionPending={actionPending}
            error={error}
            notice={notice}
            stale={stale}
            sources={sources}
            sourcesHasMore={sourcesHasMore}
            sourcesLoading={sourcesLoading}
            sourcesError={sourcesError}
            fields={fields}
            fieldsForModule={fieldsForModule}
            fieldsHasMore={fieldsHasMore}
            fieldsLoading={fieldsLoading}
            fieldsError={fieldsError}
            onRetrySources={() => {
              setSourcesLoading(true);
              setSourcesRefresh((current) => current + 1);
            }}
            onRetryFields={() => setFieldsRefresh((current) => current + 1)}
            loadMoreSources={loadMoreSources}
            loadMoreFields={loadMoreFields}
            saveReport={saveReport}
            archiveOrRestore={archiveOrRestore}
            reloadLatest={reloadLatest}
            changeModule={changeModule}
            updateFilter={updateFilter}
            resetDraft={() => {
              setDraft(baselineDraft);
              setError("");
              setStale(false);
            }}
          />

          {baselineReport && !baselineReport.isDeleted ? (
            <ReportScheduleControls
              key={baselineReport.id}
              reportId={baselineReport.id}
              disabled={dirty || Boolean(actionPending)}
              disabledReason={
                dirty
                  ? "Save or reset your Report edits before changing its schedule."
                  : undefined
              }
            />
          ) : null}

          {baselineReport && !baselineReport.isDeleted ? (
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Saved runs</CardTitle>
                <CardDescription>
                  Each run keeps its own output. CSV and Print use the same
                  frozen bytes.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={Boolean(actionPending) || dirty}
                    onClick={() => void runReport()}
                  >
                    {actionPending === "run" ? "Running…" : "Run now"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={runsLoading}
                    onClick={() => {
                      setRunsOffset(0);
                      setRunsLoading(true);
                      setRunsRefresh((current) => current + 1);
                    }}
                  >
                    Refresh history
                  </Button>
                </div>
                {runsError ? (
                  <Alert role="alert" variant="destructive">
                    {runsError}
                    <Button
                      type="button"
                      variant="outline"
                      className="ml-3 min-h-11"
                      onClick={() => {
                        setRunsLoading(true);
                        setRunsRefresh((current) => current + 1);
                      }}
                    >
                      Retry
                    </Button>
                  </Alert>
                ) : null}
                {runsLoading && runs.length === 0 ? (
                  <p role="status" className="text-muted-foreground text-sm">
                    Loading saved runs…
                  </p>
                ) : null}
                {!runsLoading && runs.length === 0 && !runsError ? (
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
                          {formatDate(run.createdAt)}
                        </p>
                        <p className="text-muted-foreground text-sm">
                          {run.rowCount} {run.rowCount === 1 ? "row" : "rows"} ·
                          Recipe revision {run.recipeRevision}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={Boolean(actionPending)}
                        onClick={() =>
                          void outputRun(run, baselineReport.name, "download")
                        }
                      >
                        <Download data-icon="inline-start" /> CSV
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={Boolean(actionPending)}
                        onClick={() =>
                          void outputRun(run, baselineReport.name, "print")
                        }
                      >
                        <Printer data-icon="inline-start" /> Print
                      </Button>
                    </li>
                  ))}
                </ul>
                {runsHasMore ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={runsLoading}
                    onClick={() => {
                      setRunsLoading(true);
                      setRunsOffset(runs.length);
                    }}
                  >
                    Load more runs
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
      <AlertDialog
        open={Boolean(pendingNavigation)}
        onOpenChange={(open) => {
          if (!open) setPendingNavigation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved Report changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your unsaved recipe edits will be lost if you leave Reports.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingNavigation(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              onClick={() => {
                const pending = pendingNavigation;
                setPendingNavigation(null);
                setDraft(baselineDraft);
                pending?.resume();
              }}
            >
              Discard and continue
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
