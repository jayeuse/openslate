"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import type { AuthMe } from "@/lib/auth-api";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  restoreOpenViewReport,
  updateOpenViewReport,
  type OpenViewReport,
  type OpenViewReportRun,
  type OpenViewSharedReportRun,
} from "../adapters/reports-api";
import {
  authMeOptions,
  CATALOG_PAGE_SIZE,
  catalogFirstPageOptions,
  fieldsFirstPageOptions,
  isAuthorizationDenied,
  moduleFieldKeys,
  openViewKeys,
  readStamp,
  recordPageDenial,
  REPORT_PAGE_SIZE as PAGE_SIZE,
  reportListOptions,
  sharedRunsOptions,
} from "../adapters/openview-queries";
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
import {
  AvailableReportRunsPanel,
  SavedReportRunsPanel,
  formatReportRunDate,
  type ReportOutputAction,
} from "./report-run-panels";
import { SavedReportsPanel } from "./saved-reports-panel";

// The one read of a cached first page that "Load more" pages (and their
// failures) belong to: `scope` names the archive filter or data source, and
// `readAt` the read (see readStamp). Any later read of that first page drops
// them, like the former reload did. A refused page (401/403) is recorded on
// the shared cached reads instead (recordPageDenial).
type ReadMark = { scope: string; readAt: number };
type PageExtension<T> = ReadMark & {
  items: T[];
  hasMore: boolean;
  nextOffset: number;
};

function marksRead(
  mark: ReadMark | null,
  scope: string,
  readAt: number,
): boolean {
  return Boolean(
    mark && readAt && mark.scope === scope && mark.readAt === readAt,
  );
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
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

function ownerIncludedByAudience(
  report: OpenViewReport,
  identity: AuthMe,
): boolean {
  if (identity.id !== report.ownerId) return false;
  switch (report.audience.kind) {
    case "private":
    case "everyone":
      return true;
    case "role":
      return report.audience.roleId === identity.roleId;
    case "user":
      return report.audience.userId === identity.id;
  }
}

function reportAudienceLabel(audience: ReportDraft["audience"]): string {
  switch (audience.kind) {
    case "private":
      return "Private to me";
    case "everyone":
      return "Everyone with Records access";
    case "role":
      return "One role";
    case "user":
      return "One person";
  }
}

export default function ServerBackedReports() {
  const queryClient = useQueryClient();
  const identityQuery = useQuery(authMeOptions());
  const currentIdentity: AuthMe | null = identityQuery.data ?? null;
  const currentIdentityLoading = identityQuery.isPending;
  const currentIdentityError = identityQuery.isError
    ? "Your Report audience could not be confirmed. Reload to try again."
    : "";
  const [showArchived, setShowArchived] = useState(false);
  const [templateReportId, setTemplateReportId] = useState("");
  const [listExtension, setListExtension] =
    useState<PageExtension<OpenViewReport> | null>(null);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [listMoreFailedFor, setListMoreFailedFor] = useState<ReadMark | null>(
    null,
  );
  const [sourcesExtension, setSourcesExtension] =
    useState<PageExtension<OpenViewDataSource> | null>(null);
  const [sourcesLoadingMore, setSourcesLoadingMore] = useState(false);
  const [sourcesMoreFailedFor, setSourcesMoreFailedFor] =
    useState<ReadMark | null>(null);
  const [fieldsExtension, setFieldsExtension] =
    useState<PageExtension<OpenViewDataSourceField> | null>(null);
  const [fieldsLoadingMore, setFieldsLoadingMore] = useState(false);
  const [fieldsMoreFailedFor, setFieldsMoreFailedFor] =
    useState<ReadMark | null>(null);
  const [baselineReport, setBaselineReport] = useState<OpenViewReport | null>(
    null,
  );
  const [draft, setDraft] = useState<ReportDraft>(() => emptyReportDraft());
  const [baselineDraft, setBaselineDraft] = useState<ReportDraft>(() =>
    emptyReportDraft(),
  );
  const [actionPending, setActionPending] = useState("");
  const actionRef = useRef(false);
  const runRetryRef = useRef<{ reportId: string; key: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const [recipeEditorOpen, setRecipeEditorOpen] = useState(false);
  const [availableOutputsOpen, setAvailableOutputsOpen] = useState(false);
  const [activeReportTab, setActiveReportTab] = useState("saved-outputs");
  const [runs, setRuns] = useState<OpenViewReportRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState("");
  const [runsOffset, setRunsOffset] = useState(0);
  const [runsPageSize, setRunsPageSize] = useState(PAGE_SIZE);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsRefresh, setRunsRefresh] = useState(0);
  const [sharedActionError, setSharedActionError] = useState("");
  const [sharedOffset, setSharedOffset] = useState(0);
  const [sharedPageSize, setSharedPageSize] = useState(PAGE_SIZE);
  const [pendingNavigation, setPendingNavigation] = useState<{
    resume: () => void;
  } | null>(null);

  const dirty =
    reportDraftSignature(draft) !== reportDraftSignature(baselineDraft);
  const canEdit = !baselineReport?.isDeleted && !actionPending;
  const ownerExcludedFromAudience = Boolean(
    baselineReport &&
    currentIdentity &&
    !ownerIncludedByAudience(baselineReport, currentIdentity),
  );
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

  // Saved Reports: the cached first page for the archive filter, plus pages
  // loaded with "Load more".
  const listDeleted = showArchived ? "include" : "exclude";
  const listQuery = useQuery(reportListOptions(listDeleted));
  // A refused refresh hides the retained list until a read succeeds again.
  const listDenied = isAuthorizationDenied(listQuery.error);
  const listBase = listDenied ? undefined : listQuery.data;
  const listReadAt = listBase ? readStamp(listQuery) : 0;
  const listMore = marksRead(listExtension, listDeleted, listReadAt)
    ? listExtension
    : null;
  const reports = listBase
    ? [
        ...listBase.items,
        ...(listMore?.items ?? []).filter(
          (item) => !listBase.items.some((report) => report.id === item.id),
        ),
      ]
    : [];
  const listHasMore = listMore
    ? listMore.hasMore
    : (listBase?.pagination.hasMore ?? false);
  const listLoading = listQuery.isFetching || listLoadingMore;
  const listMoreFailed = marksRead(listMoreFailedFor, listDeleted, listReadAt);
  const listError =
    listMoreFailed || (listQuery.isError && !listQuery.isFetching)
      ? "Reports could not be loaded. Try again."
      : "";

  // Available outputs: one cached page per offset and size. The previous
  // page's total holds the pager steady while the next page loads.
  const sharedQuery = useQuery({
    ...sharedRunsOptions(sharedOffset, sharedPageSize),
    placeholderData: keepPreviousData,
  });
  const sharedDenied = isAuthorizationDenied(sharedQuery.error);
  const sharedRuns: OpenViewSharedReportRun[] =
    sharedQuery.isPlaceholderData || sharedDenied
      ? []
      : (sharedQuery.data?.items ?? []);
  const sharedTotal = sharedDenied
    ? 0
    : (sharedQuery.data?.pagination.total ?? 0);
  const sharedLoading = sharedQuery.isFetching;
  const sharedError =
    sharedActionError ||
    (sharedQuery.isError && !sharedQuery.isFetching
      ? "Available runs could not be loaded. Try again."
      : "");

  // Data sources and fields for the recipe editor: cached first pages plus
  // pages loaded with "Load more".
  const sourcesQuery = useQuery(catalogFirstPageOptions());
  // A refused read hides retained recipe metadata until a read succeeds.
  const sourcesDenied = isAuthorizationDenied(sourcesQuery.error);
  const sourcesBase = sourcesDenied ? undefined : sourcesQuery.data;
  const sourcesReadAt = sourcesBase ? readStamp(sourcesQuery) : 0;
  const sourcesMore = marksRead(sourcesExtension, "", sourcesReadAt)
    ? sourcesExtension
    : null;
  const sources = [
    ...(sourcesBase?.items ?? []),
    ...(sourcesMore?.items ?? []),
  ];
  const sourcesHasMore = sourcesMore
    ? sourcesMore.hasMore
    : (sourcesBase?.pagination.hasMore ?? false);
  const sourcesOffset = sourcesMore
    ? sourcesMore.nextOffset
    : (sourcesBase?.pagination.count ?? 0);
  const sourcesLoading = sourcesQuery.isFetching || sourcesLoadingMore;
  const sourcesError = marksRead(sourcesMoreFailedFor, "", sourcesReadAt)
    ? "More data sources could not be loaded. Try again."
    : sourcesQuery.isError && !sourcesQuery.isFetching
      ? "Data sources could not be loaded. Try again."
      : "";

  const fieldsQuery = useQuery(fieldsFirstPageOptions(draft.moduleId));
  const fieldsDenied = isAuthorizationDenied(fieldsQuery.error);
  const fieldsBase =
    draft.moduleId && !fieldsDenied ? fieldsQuery.data : undefined;
  const fieldsReadAt = fieldsBase ? readStamp(fieldsQuery) : 0;
  const fieldsMore = marksRead(fieldsExtension, draft.moduleId, fieldsReadAt)
    ? fieldsExtension
    : null;
  const fields = [...(fieldsBase?.items ?? []), ...(fieldsMore?.items ?? [])];
  const fieldsForModule = fieldsBase ? draft.moduleId : "";
  const fieldsHasMore = fieldsMore
    ? fieldsMore.hasMore
    : (fieldsBase?.pagination.hasMore ?? false);
  const fieldsOffset = fieldsMore
    ? fieldsMore.nextOffset
    : (fieldsBase?.pagination.count ?? 0);
  const fieldsLoading =
    (Boolean(draft.moduleId) && fieldsQuery.isFetching) || fieldsLoadingMore;
  const fieldsError = marksRead(
    fieldsMoreFailedFor,
    draft.moduleId,
    fieldsReadAt,
  )
    ? "More fields could not be loaded. Try again."
    : draft.moduleId && fieldsQuery.isError && !fieldsQuery.isFetching
      ? "Fields could not be loaded. Try again."
      : "";

  function refreshReportList(): void {
    setListExtension(null);
    setListMoreFailedFor(null);
    void queryClient.invalidateQueries({ queryKey: openViewKeys.reportLists });
  }

  /** Applies a local Report change to the listed pages without a reload. */
  function patchReports(
    update: (current: OpenViewReport[]) => OpenViewReport[],
  ): void {
    const queryKey = reportListOptions(listDeleted).queryKey;
    queryClient.setQueryData(queryKey, (page) =>
      page ? { ...page, items: update(page.items) } : page,
    );
    // The local update is a new read of the first page; the loaded pages
    // move onto it.
    const readAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
    setListExtension((current) =>
      current && marksRead(current, listDeleted, listReadAt)
        ? { ...current, readAt, items: update(current.items) }
        : current,
    );
  }

  async function loadMoreReports(): Promise<void> {
    if (!listBase || listLoadingMore) return;
    const base = listBase;
    const mark = { scope: listDeleted, readAt: listReadAt };
    const loaded = listMore?.items ?? [];
    setListLoadingMore(true);
    setListMoreFailedFor(null);
    try {
      const page = await listOpenViewReports({
        limit: PAGE_SIZE,
        offset: reports.length,
        deleted: listDeleted,
      });
      const known = [...base.items, ...loaded];
      setListExtension({
        ...mark,
        items: [
          ...loaded,
          ...page.items.filter(
            (item) => !known.some((report) => report.id === item.id),
          ),
        ],
        hasMore: page.pagination.hasMore,
        nextOffset: 0,
      });
    } catch (error) {
      if (isAuthorizationDenied(error))
        void recordPageDenial(queryClient, [openViewKeys.reportLists], error);
      else setListMoreFailedFor(mark);
    } finally {
      setListLoadingMore(false);
    }
  }

  function refreshSharedRuns(): void {
    setSharedActionError("");
    if (sharedOffset === 0) {
      void sharedQuery.refetch();
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: openViewKeys.sharedRuns,
      refetchType: "none",
    });
    setSharedOffset(0);
  }

  useEffect(() => {
    if (!baselineReport || baselineReport.isDeleted) {
      setRuns([]);
      setRunsTotal(0);
      setRunsLoading(false);
      return;
    }
    const reportId = baselineReport.id;
    let active = true;
    setRunsLoading(true);
    void listOpenViewReportRuns(reportId, {
      limit: runsPageSize,
      offset: runsOffset,
    })
      .then((page) => {
        if (!active) return;
        setRuns(page.items);
        setRunsTotal(page.pagination.total);
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
  }, [
    baselineReport?.id,
    baselineReport?.isDeleted,
    runsOffset,
    runsPageSize,
    runsRefresh,
  ]);

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
    setRecipeEditorOpen(false);
    setActiveReportTab("saved-outputs");
    setRunsOffset(0);
    setRuns([]);
    setRunsTotal(0);
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
    setRecipeEditorOpen(true);
    setActiveReportTab("saved-outputs");
    setError("");
    setNotice("");
    setStale(false);
    setRuns([]);
    setRunsTotal(0);
    runRetryRef.current = null;
  }

  async function startFromSavedReport(reportId: string): Promise<void> {
    if (
      !reportId ||
      actionRef.current ||
      (dirty && !window.confirm("Discard unsaved Report changes?")) ||
      !beginAction("template")
    )
      return;
    try {
      const source = await getOpenViewReport(reportId);
      if (source.isDeleted) {
        setError("Restore the saved Report before using it as a template.");
        return;
      }
      const nextDraft = reportDraftFrom(source);
      nextDraft.name = `Copy of ${source.name}`.slice(0, 80);
      setBaselineReport(null);
      setDraft(nextDraft);
      setBaselineDraft(emptyReportDraft());
      setRecipeEditorOpen(true);
      setActiveReportTab("saved-outputs");
      setRuns([]);
      setRunsTotal(0);
      setRunsOffset(0);
      setRunsError("");
      setTemplateReportId("");
      setStale(false);
      setError("");
      setNotice(
        `Started from “${source.name}”. Save to create a separate Report with the same audience.`,
      );
      runRetryRef.current = null;
    } catch (reason) {
      setError(
        safeMessage(
          reason,
          "The saved Report could not be loaded as a template.",
        ),
      );
    } finally {
      endAction();
    }
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
    if (sourcesLoading || !sourcesHasMore || !sourcesBase) return;
    const mark = { scope: "", readAt: sourcesReadAt };
    const loaded = sourcesMore?.items ?? [];
    setSourcesLoadingMore(true);
    try {
      const page = await listOpenViewDataSources({
        limit: CATALOG_PAGE_SIZE,
        offset: sourcesOffset,
      });
      setSourcesExtension({
        ...mark,
        items: [...loaded, ...page.items],
        hasMore: page.pagination.hasMore,
        nextOffset: sourcesOffset + page.pagination.count,
      });
      setSourcesMoreFailedFor(null);
    } catch (error) {
      if (isAuthorizationDenied(error))
        void recordPageDenial(queryClient, [openViewKeys.catalog], error);
      else setSourcesMoreFailedFor(mark);
    } finally {
      setSourcesLoadingMore(false);
    }
  }

  async function loadMoreFields(): Promise<void> {
    if (fieldsLoading || !fieldsHasMore || !draft.moduleId || !fieldsBase)
      return;
    const moduleId = draft.moduleId;
    const mark = { scope: moduleId, readAt: fieldsReadAt };
    const loaded = fieldsMore?.items ?? [];
    setFieldsLoadingMore(true);
    try {
      const page = await listOpenViewDataSourceFields(moduleId, {
        limit: CATALOG_PAGE_SIZE,
        offset: fieldsOffset,
      });
      // A result for a source that is no longer chosen is ignored, because
      // its mark no longer matches the first page shown.
      setFieldsExtension({
        ...mark,
        items: [...loaded, ...page.items],
        hasMore: page.pagination.hasMore,
        nextOffset: fieldsOffset + page.pagination.count,
      });
      setFieldsMoreFailedFor(null);
    } catch (error) {
      if (isAuthorizationDenied(error))
        void recordPageDenial(queryClient, moduleFieldKeys(moduleId), error);
      else setFieldsMoreFailedFor(mark);
    } finally {
      setFieldsLoadingMore(false);
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
      setRecipeEditorOpen(false);
      setActiveReportTab("saved-outputs");
      patchReports((current) => [
        saved,
        ...current.filter((report) => report.id !== saved.id),
      ]);
      refreshReportList();
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
      patchReports((current) =>
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
      setRecipeEditorOpen(false);
      setActiveReportTab("saved-outputs");
      patchReports((current) =>
        current.map((report) => (report.id === updated.id ? updated : report)),
      );
      refreshReportList();
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
      setRuns((current) =>
        [
          run,
          ...(runsOffset === 0
            ? current.filter((item) => item.id !== run.id)
            : []),
        ].slice(0, runsPageSize),
      );
      setRunsTotal((current) => current + 1);
      setRunsOffset(0);
      setRunsRefresh((current) => current + 1);
      refreshSharedRuns();
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
    action: ReportOutputAction,
  ): Promise<void> {
    if (!beginAction(`${action}:${run.id}`)) return;
    const isSharedRun = "reportName" in run;
    if (isSharedRun) setSharedActionError("");
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
          `${reportName} — ${formatReportRunDate(run.createdAt)}`,
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
      if (isSharedRun) setSharedActionError(message);
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

  const hasDraftContent = Boolean(
    draft.moduleId ||
    draft.name ||
    draft.subtitle ||
    draft.fields.length ||
    draft.filters.length ||
    draft.sorts.length ||
    draft.groupBy ||
    draft.includeRowCount,
  );
  const showReportSummary = Boolean(
    baselineReport || hasDraftContent || recipeEditorOpen,
  );
  const summaryName =
    draft.name.trim() || (baselineReport ? baselineReport.name : "New Report");
  const summarySource =
    sources.find((source) => source.id === draft.moduleId)?.name ??
    (draft.moduleId ? "Source details unavailable" : "Choose a source");
  const canRunReport = Boolean(
    baselineReport &&
    !baselineReport.isDeleted &&
    !dirty &&
    !actionPending &&
    !currentIdentityLoading &&
    currentIdentity &&
    !currentIdentityError &&
    !ownerExcludedFromAudience,
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            data-slot="page-title"
            className="text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            Reports
          </h1>
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
        <div className="min-w-0">
          <SavedReportsPanel
            reports={reports}
            showArchived={showArchived}
            selectedReportId={baselineReport?.id}
            templateReportId={templateReportId}
            actionPending={actionPending}
            loading={listLoading}
            error={listError}
            hasMore={listHasMore}
            onShowArchivedChange={(show) => {
              setShowArchived(show);
              setListExtension(null);
              setListMoreFailedFor(null);
            }}
            onRefresh={() => {
              setListExtension(null);
              setListMoreFailedFor(null);
              void listQuery.refetch();
            }}
            onRetry={() => {
              if (listMoreFailed) void loadMoreReports();
              else void listQuery.refetch();
            }}
            onOpenReport={openReport}
            onDuplicateReport={(reportId) => {
              void startFromSavedReport(reportId);
            }}
            onTemplateReportChange={setTemplateReportId}
            onStartFromTemplate={() => {
              void startFromSavedReport(templateReportId);
            }}
            onLoadMore={() => void loadMoreReports()}
            onOpenAvailableOutputs={() => setAvailableOutputsOpen(true)}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {showReportSummary ? (
            <Card className="min-w-0">
              <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <CardTitle className="break-words">{summaryName}</CardTitle>
                  {draft.subtitle.trim() ? (
                    <CardDescription className="mt-1 break-words">
                      {draft.subtitle.trim()}
                    </CardDescription>
                  ) : null}
                  <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                    <div className="flex flex-wrap gap-1.5">
                      <dt className="text-muted-foreground">Source</dt>
                      <dd>{summarySource}</dd>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <dt className="text-muted-foreground">Columns</dt>
                      <dd>
                        {draft.fields.length}{" "}
                        {draft.fields.length === 1 ? "column" : "columns"}
                        {draft.includeRowCount ? " · row count included" : ""}
                      </dd>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <dt className="text-muted-foreground">Audience</dt>
                      <dd>{reportAudienceLabel(draft.audience)}</dd>
                    </div>
                  </dl>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {!baselineReport?.isDeleted ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={Boolean(actionPending)}
                      onClick={() => setRecipeEditorOpen(true)}
                    >
                      Edit report
                    </Button>
                  ) : null}
                  {baselineReport && !baselineReport.isDeleted ? (
                    <Button
                      type="button"
                      className="min-h-11"
                      disabled={!canRunReport}
                      onClick={() => void runReport()}
                    >
                      {actionPending === "run" ? "Running…" : "Run now"}
                    </Button>
                  ) : null}
                  {baselineReport ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="min-h-11 min-w-11"
                            aria-label="Report options"
                          />
                        }
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={
                            baselineReport.isDeleted ||
                            dirty ||
                            Boolean(actionPending)
                          }
                          onClick={() =>
                            void startFromSavedReport(baselineReport.id)
                          }
                        >
                          Duplicate Report
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant={
                            baselineReport.isDeleted ? "default" : "destructive"
                          }
                          disabled={dirty || Boolean(actionPending)}
                          onClick={() => void archiveOrRestore()}
                        >
                          {baselineReport.isDeleted
                            ? "Restore Report"
                            : "Archive Report"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              </CardHeader>
              {dirty ||
              error ||
              notice ||
              currentIdentityError ||
              ownerExcludedFromAudience ? (
                <CardContent className="flex flex-col gap-3 pt-0">
                  {dirty ? (
                    <p role="status" className="text-muted-foreground text-sm">
                      Unsaved changes. Save or reset before running or
                      archiving.
                    </p>
                  ) : null}
                  {ownerExcludedFromAudience ? (
                    <p role="status" className="text-muted-foreground text-sm">
                      Your account is not included in this Report audience, so
                      you cannot run it. Scheduled runs remain available for
                      eligible recipients.
                    </p>
                  ) : null}
                  {currentIdentityError ? (
                    <Alert role="alert" variant="destructive">
                      {currentIdentityError}
                    </Alert>
                  ) : null}
                  {!recipeEditorOpen && error ? (
                    <Alert role="alert" variant="destructive">
                      {error}
                      {stale ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="ml-3 min-h-11"
                          onClick={() => void reloadLatest()}
                        >
                          Reload latest
                        </Button>
                      ) : null}
                    </Alert>
                  ) : null}
                  {!recipeEditorOpen && notice ? (
                    <Alert role="status" variant="success">
                      {notice}
                    </Alert>
                  ) : null}
                </CardContent>
              ) : null}
            </Card>
          ) : (
            <Card>
              <CardContent className="p-6">
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>Select a Report</EmptyTitle>
                    <EmptyDescription>
                      Choose a saved Report or create a new one to set up an
                      output.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </CardContent>
            </Card>
          )}

          {baselineReport && !baselineReport.isDeleted ? (
            <Tabs
              value={activeReportTab}
              onValueChange={setActiveReportTab}
              className="min-w-0"
            >
              <TabsList
                aria-label="Report output sections"
                className="w-full sm:w-fit"
              >
                <TabsTrigger
                  value="saved-outputs"
                  className="min-h-11 flex-1 sm:flex-none"
                >
                  Saved outputs
                </TabsTrigger>
                <TabsTrigger
                  value="schedule"
                  className="min-h-11 flex-1 sm:flex-none"
                >
                  Schedule
                </TabsTrigger>
              </TabsList>
              <TabsContent value="saved-outputs" keepMounted>
                <SavedReportRunsPanel
                  report={baselineReport}
                  actionPending={actionPending}
                  runs={runs}
                  loading={runsLoading}
                  error={runsError}
                  offset={runsOffset}
                  totalCount={runsTotal}
                  pageSize={runsPageSize}
                  onPageIndexChange={(pageIndex) => {
                    setRuns([]);
                    setRunsLoading(true);
                    setRunsOffset(pageIndex * runsPageSize);
                  }}
                  onPageSizeChange={(pageSize) => {
                    setRuns([]);
                    setRunsLoading(true);
                    setRunsPageSize(pageSize);
                    setRunsOffset(0);
                  }}
                  onRefresh={() => {
                    if (runsOffset !== 0) setRuns([]);
                    setRunsOffset(0);
                    setRunsLoading(true);
                    setRunsRefresh((current) => current + 1);
                  }}
                  onRetry={() => {
                    setRunsLoading(true);
                    setRunsRefresh((current) => current + 1);
                  }}
                  onOutputRun={outputRun}
                />
              </TabsContent>
              <TabsContent value="schedule" keepMounted>
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
              </TabsContent>
            </Tabs>
          ) : null}
        </div>
      </div>
      <ReportRecipeEditor
        open={recipeEditorOpen}
        onOpenChange={setRecipeEditorOpen}
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
          setSourcesExtension(null);
          setSourcesMoreFailedFor(null);
          void sourcesQuery.refetch();
        }}
        onRetryFields={() => {
          setFieldsExtension(null);
          setFieldsMoreFailedFor(null);
          void fieldsQuery.refetch();
        }}
        loadMoreSources={loadMoreSources}
        loadMoreFields={loadMoreFields}
        saveReport={saveReport}
        reloadLatest={reloadLatest}
        changeModule={changeModule}
        updateFilter={updateFilter}
        resetDraft={() => {
          setDraft(baselineDraft);
          setError("");
          setStale(false);
        }}
      />
      <Sheet open={availableOutputsOpen} onOpenChange={setAvailableOutputsOpen}>
        <SheetContent className="w-full gap-0 p-0 sm:w-[min(92vw,64rem)]">
          <SheetHeader className="border-border shrink-0 border-b p-5 pr-14">
            <SheetTitle>Available outputs</SheetTitle>
            <SheetDescription>
              Saved runs you are eligible to open. Recipe editing stays with the
              owner.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <AvailableReportRunsPanel
              runs={sharedRuns}
              loading={sharedLoading}
              error={sharedError}
              actionPending={actionPending}
              offset={sharedOffset}
              totalCount={sharedTotal}
              pageSize={sharedPageSize}
              onPageIndexChange={(pageIndex) => {
                setSharedActionError("");
                setSharedOffset(pageIndex * sharedPageSize);
              }}
              onPageSizeChange={(pageSize) => {
                setSharedActionError("");
                setSharedPageSize(pageSize);
                setSharedOffset(0);
              }}
              onRefresh={refreshSharedRuns}
              onRetry={() => {
                setSharedActionError("");
                void sharedQuery.refetch();
              }}
              onOutputRun={outputRun}
            />
          </div>
        </SheetContent>
      </Sheet>
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
