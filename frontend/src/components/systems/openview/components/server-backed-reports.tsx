"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  useOpenViewDepartmentNames,
  useOpenViewSource,
} from "../hooks/use-openview-catalog";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/api-errors";
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
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "../../shared/runtime/workspace-identity";
import { serializeOpenViewUrl } from "../domain/model";
import {
  archiveOpenViewReport,
  createOpenViewReport,
  createOpenViewReportRun,
  downloadOpenViewReportRunCsv,
  getOpenViewReport,
  getOpenViewReportRun,
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
import { useOpenViewAccessDenied } from "../adapters/openview-access";
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
import { canManageOpenView } from "../domain/manage-access";
import {
  AvailableReportRunsPanel,
  SavedReportRunsPanel,
  SelectedReportRunPanel,
  formatReportRunDate,
  type ReportOutputAction,
} from "./report-run-panels";
import { Input } from "@/components/ui/input";
import { reportDone } from "@/lib/feedback";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { LifecyclePurgeReview } from "../../shared/lifecycle-purge-review";
import {
  lifecycleErrorMessage,
  type LifecyclePurgePreview,
} from "@/lib/lifecycle";
import {
  workspaceLifecycleQueryOptions,
  workspaceCalendarQueryOptions,
  subscribeWorkspaceLifecycleSettings,
} from "../../manage/adapters/workspace-api";
import { previewReportPurge, purgeReport } from "../adapters/reports-api";
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

export default function ServerBackedReports({
  reportId,
  runId,
  invalidUrl = false,
}: {
  reportId?: string;
  runId?: string;
  invalidUrl?: boolean;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const verifiedUserId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const actionOwner = useRef({
    mounted: false,
    userId: verifiedUserId,
    suspended,
  });
  useLayoutEffect(() => {
    actionOwner.current = { mounted: true, userId: verifiedUserId, suspended };
    return () => {
      actionOwner.current.mounted = false;
    };
  }, [verifiedUserId, suspended]);
  const selectionSequence = useRef(0);
  const localSelection = useRef<string | null>(null);
  const [selectionRetry, setSelectionRetry] = useState(0);
  const [target, setTarget] = useState<{
    key: string;
    loading: boolean;
    reportError: string;
    runError: string;
    run: OpenViewReportRun | null;
  } | null>(null);
  const selectionKey = `${reportId ?? ""}:${runId ?? ""}:${invalidUrl}`;
  // A refusal of any cached OpenView read hides them all (openview-access.ts).
  const accessDenied = useOpenViewAccessDenied();
  const identityQuery = useQuery(authMeOptions());
  const currentIdentity: AuthMe | null = identityQuery.data ?? null;
  const currentIdentityLoading = identityQuery.isPending;
  const currentIdentityError = identityQuery.isError
    ? "Your access could not be confirmed. Reload to try again."
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
  const currentEditor = useRef({ dirty, baselineReport, runId, suspended });
  useLayoutEffect(() => {
    currentEditor.current = { dirty, baselineReport, runId, suspended };
  }, [dirty, baselineReport, runId, suspended]);

  const applyReport = useCallback((report: OpenViewReport) => {
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
  }, []);

  useEffect(() => {
    const sequence = ++selectionSequence.current;
    if (suspended) return;
    if (localSelection.current === selectionKey) {
      localSelection.current = null;
      return;
    }
    const editor = currentEditor.current;
    if (
      editor.dirty &&
      editor.baselineReport?.id !== reportId &&
      !window.confirm("Discard unsaved Report changes?")
    ) {
      router.replace(
        serializeOpenViewUrl({
          section: "reports",
          report: editor.baselineReport?.id,
        }) as Route,
      );
      return;
    }
    if (invalidUrl || !reportId) {
      setTarget(null);
      // A removed saved selection returns to the empty catalog. Intentional
      // New/Copy drafts have no saved baseline and survive identity pauses.
      if (editor.baselineReport) {
        const empty = emptyReportDraft();
        setDraft(empty);
        setBaselineDraft(empty);
        setRecipeEditorOpen(false);
        setTemplateReportId("");
        setActiveReportTab("saved-outputs");
        setError("");
        setNotice("");
        setStale(false);
        setRunsOffset(0);
        setRunsError("");
        runRetryRef.current = null;
      }
      setBaselineReport(null);
      setRuns([]);
      setRunsTotal(0);
      return;
    }
    let active = true;
    const owns = () =>
      active &&
      sequence === selectionSequence.current &&
      !currentEditor.current.suspended;
    setTarget({
      key: selectionKey,
      loading: true,
      reportError: "",
      runError: "",
      run: null,
    });
    void (async () => {
      try {
        const report = await getOpenViewReport(reportId);
        if (!owns()) return;
        if (
          !currentEditor.current.dirty ||
          currentEditor.current.baselineReport?.id !== reportId
        )
          applyReport(report);
        if (!runId) {
          setTarget({
            key: selectionKey,
            loading: false,
            reportError: "",
            runError: "",
            run: null,
          });
          return;
        }
        try {
          const run = await getOpenViewReportRun(reportId, runId);
          if (owns())
            setTarget({
              key: selectionKey,
              loading: false,
              reportError: "",
              runError: "",
              run,
            });
        } catch {
          if (owns())
            setTarget({
              key: selectionKey,
              loading: false,
              reportError: "",
              runError: "Selected output could not be loaded. Try again.",
              run: null,
            });
        }
      } catch {
        if (!owns()) return;
        setBaselineReport(null);
        setTarget({
          key: selectionKey,
          loading: false,
          reportError: "Selected Report could not be loaded. Try again.",
          runError: "",
          run: null,
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [
    reportId,
    runId,
    invalidUrl,
    selectionKey,
    selectionRetry,
    suspended,
    router,
    applyReport,
  ]);
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
  const listDenied = accessDenied || isAuthorizationDenied(listQuery.error);
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
  const sharedDenied = accessDenied || isAuthorizationDenied(sharedQuery.error);
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
  const sourcesDenied =
    accessDenied || isAuthorizationDenied(sourcesQuery.error);
  const sourcesBase = sourcesDenied ? undefined : sourcesQuery.data;
  const sourcesReadAt = sourcesBase ? readStamp(sourcesQuery) : 0;
  const sourcesMore = marksRead(sourcesExtension, "", sourcesReadAt)
    ? sourcesExtension
    : null;
  const loadedSources = [
    ...(sourcesBase?.items ?? []),
    ...(sourcesMore?.items ?? []),
  ];
  const selectedSource = useOpenViewSource(loadedSources, draft.moduleId);
  const sources = [
    ...loadedSources,
    ...(selectedSource &&
    !loadedSources.some((source) => source.id === selectedSource.id)
      ? [selectedSource]
      : []),
  ];
  // A Report belongs to the department of its module.
  const departmentNames = useOpenViewDepartmentNames(
    sources.map((source) => source.departmentId),
  );
  const reportDepartmentNames = new Map<string, string>();
  for (const source of sources) {
    const name = departmentNames.get(source.departmentId);
    if (name) reportDepartmentNames.set(source.id, name);
  }
  const canManageReportModule = (moduleId: string) =>
    canManageOpenView(
      currentIdentity ?? undefined,
      sources.find((source) => source.id === moduleId)?.departmentId,
      moduleId,
    );
  // Only a manager of the Report module creates, changes or schedules it.
  // Every reader of the module reads the Report and a non-guest runs it.
  const canCreateReports =
    currentIdentity?.role === "admin" ||
    (currentIdentity?.role === "member" &&
      currentIdentity.access.some((entry) => entry.level === "manage"));
  const canEdit =
    !baselineReport?.isDeleted &&
    !actionPending &&
    (baselineReport ? canManageReportModule(baselineReport.moduleId) : true) &&
    canCreateReports;
  // A new Report needs `manage` on its own module, so its source picker lists
  // only managed modules; an existing Report keeps every readable source.
  const editorSources = baselineReport
    ? sources
    : sources.filter((source) => canManageReportModule(source.id));
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
  const fieldsDenied = accessDenied || isAuthorizationDenied(fieldsQuery.error);
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
    if (accessDenied || !baselineReport || baselineReport.isDeleted) {
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
    accessDenied,
    baselineReport?.id,
    baselineReport?.isDeleted,
    runsOffset,
    runsPageSize,
    runsRefresh,
  ]);

  const [purgeTarget, setPurgeTarget] = useState<{
    report: OpenViewReport;
    ownerId: string;
    sequence: number;
  } | null>(null);
  const [purgePreview, setPurgePreview] =
    useState<LifecyclePurgePreview | null>(null);
  const [purgeName, setPurgeName] = useState("");
  const [purgePassword, setPurgePassword] = useState("");
  const [purgeError, setPurgeError] = useState("");
  const purgeRequest = useRef(0);
  const isPurgeAdmin =
    identityQuery.isSuccess &&
    currentIdentity?.id === verifiedUserId &&
    currentIdentity.role === "admin" &&
    !accessDenied &&
    !suspended;
  const lifecycleSettings = useQuery({
    ...workspaceLifecycleQueryOptions(),
    enabled: isPurgeAdmin && baselineReport?.isDeleted === true,
  });
  const purgeRegion = useQuery({
    ...workspaceCalendarQueryOptions(),
    enabled: isPurgeAdmin && baselineReport?.isDeleted === true,
  });
  const purgeEnabled =
    isPurgeAdmin &&
    lifecycleSettings.isSuccess &&
    lifecycleSettings.data.purge_enabled;
  useEffect(() => {
    if (isPurgeAdmin && baselineReport?.isDeleted)
      return subscribeWorkspaceLifecycleSettings(queryClient);
  }, [isPurgeAdmin, baselineReport?.isDeleted, queryClient]);
  useEffect(() => {
    purgeRequest.current += 1;
    setPurgeTarget(null);
    setPurgePreview(null);
    setPurgeName("");
    setPurgePassword("");
    setPurgeError("");
  }, [
    baselineReport?.id,
    baselineReport?.isDeleted,
    purgeEnabled,
    verifiedUserId,
    suspended,
  ]);

  async function reviewPurgeReport() {
    if (
      !baselineReport?.isDeleted ||
      !purgeEnabled ||
      dirty ||
      !beginAction("purge-preview")
    )
      return;
    const target = {
      report: baselineReport,
      ownerId: verifiedUserId,
      sequence: selectionSequence.current,
    };
    const request = ++purgeRequest.current;
    setPurgeTarget(target);
    setPurgePreview(null);
    setPurgeName("");
    setPurgePassword("");
    setPurgeError("");
    try {
      const preview = await previewReportPurge(target.report.id);
      if (
        ownsActionResult(target.ownerId) &&
        request === purgeRequest.current &&
        target.sequence === selectionSequence.current
      )
        setPurgePreview(preview);
    } catch (failure) {
      if (ownsActionResult(target.ownerId) && request === purgeRequest.current)
        setPurgeError(
          lifecycleErrorMessage(
            failure,
            "The Report review could not be prepared. Request a new review.",
          ),
        );
    } finally {
      if (ownsActionResult(target.ownerId)) endAction();
    }
  }

  async function confirmReportPurge() {
    const target = purgeTarget,
      preview = purgePreview;
    if (
      !target ||
      !preview ||
      !purgeEnabled ||
      dirty ||
      !ownsActionResult(target.ownerId) ||
      target.sequence !== selectionSequence.current ||
      currentEditor.current.baselineReport?.id !== target.report.id ||
      !target.report.isDeleted ||
      preview.impact.blockers.length ||
      purgeName !== preview.confirmation_name ||
      !purgePassword ||
      !beginAction("purge")
    )
      return;
    const request = ++purgeRequest.current;
    try {
      await purgeReport(target.report.id, {
        token: preview.token,
        confirmationName: purgeName,
        password: purgePassword,
      });
      if (
        !ownsActionResult(target.ownerId) ||
        request !== purgeRequest.current ||
        target.sequence !== selectionSequence.current
      )
        return;
      setPurgeTarget(null);
      setPurgePreview(null);
      setPurgeName("");
      setPurgePassword("");
      patchReports((current) =>
        current.filter((item) => item.id !== target.report.id),
      );
      refreshReportList();
      selectionSequence.current += 1;
      setTarget(null);
      localSelection.current = "::false";
      setBaselineReport(null);
      const empty = emptyReportDraft();
      setDraft(empty);
      setBaselineDraft(empty);
      setRecipeEditorOpen(false);
      setRuns([]);
      setRunsTotal(0);
      router.replace(serializeOpenViewUrl({ section: "reports" }) as Route);
      setNotice("Report permanently deleted.");
      reportDone("Report permanently deleted.");
    } catch (failure) {
      if (!ownsActionResult(target.ownerId) || request !== purgeRequest.current)
        return;
      setPurgeError(
        lifecycleErrorMessage(
          failure,
          "The Report was not permanently deleted. Request a new review.",
        ),
      );
      setPurgePreview(null);
      setPurgeName("");
    } finally {
      if (ownsActionResult(target.ownerId)) {
        setPurgePassword("");
        endAction();
      }
    }
  }

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

  function ownsActionResult(userId: string): boolean {
    const owner = actionOwner.current;
    return owner.mounted && owner.userId === userId && !owner.suspended;
  }

  function openReport(report: OpenViewReport): void {
    if (
      actionRef.current ||
      (dirty && !window.confirm("Discard unsaved Report changes?"))
    )
      return;
    selectionSequence.current += 1;
    applyReport(report);
    setTarget(null);
    localSelection.current =
      selectionKey === `${report.id}::false` ? null : `${report.id}::false`;
    router.push(
      serializeOpenViewUrl({ section: "reports", report: report.id }) as Route,
    );
  }

  function newReport(): void {
    if (
      actionRef.current ||
      (dirty && !window.confirm("Discard unsaved Report changes?"))
    )
      return;
    const nextDraft = emptyReportDraft();
    selectionSequence.current += 1;
    setTarget(null);
    localSelection.current = selectionKey === "::false" ? null : "::false";
    router.push(serializeOpenViewUrl({ section: "reports" }) as Route);
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
    const ownerId = verifiedUserId;
    if (
      !ownsActionResult(ownerId) ||
      !reportId ||
      actionRef.current ||
      (dirty && !window.confirm("Discard unsaved Report changes?")) ||
      !beginAction("template")
    )
      return;
    try {
      const source = await getOpenViewReport(reportId);
      if (!ownsActionResult(ownerId)) return;
      if (source.isDeleted) {
        setError("Restore the saved Report before using it as a template.");
        return;
      }
      const nextDraft = reportDraftFrom(source);
      nextDraft.name = `Copy of ${source.name}`.slice(0, 80);
      selectionSequence.current += 1;
      setTarget(null);
      localSelection.current = selectionKey === "::false" ? null : "::false";
      router.push(serializeOpenViewUrl({ section: "reports" }) as Route);
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
        `Started from “${source.name}”. Save to create a separate Report.`,
      );
      runRetryRef.current = null;
    } catch (reason) {
      if (!ownsActionResult(ownerId)) return;
      setError(
        apiErrorMessage(
          reason,
          "The saved Report could not be loaded as a template.",
        ),
      );
    } finally {
      // A paused current account may release its local pending guard without
      // applying the response; abandoned accounts/routes own no cleanup UI.
      if (actionOwner.current.mounted && actionOwner.current.userId === ownerId)
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
    const ownerId = verifiedUserId;
    if (!ownsActionResult(ownerId) || !canEdit || !beginAction("save")) return;
    try {
      if (!draft.moduleId)
        throw new ReportDraftError("Choose a data source for this Report");
      // A template can carry a module the user only reads.
      if (!baselineReport && !canManageReportModule(draft.moduleId))
        throw new ReportDraftError(
          "Choose a data source you manage for this Report",
        );
      if (!draft.name.trim()) throw new ReportDraftError("Enter a Report name");
      const recipe = reportRecipeFromDraft(draft);
      const input = {
        moduleId: draft.moduleId,
        name: draft.name.trim(),
        subtitle: draft.subtitle.trim() || null,
        recipe,
      };
      const saved = baselineReport
        ? await updateOpenViewReport({
            id: baselineReport.id,
            revision: baselineReport.revision,
            ...input,
          })
        : await createOpenViewReport(input);
      if (!ownsActionResult(ownerId)) return;
      const nextDraft = reportDraftFrom(saved);
      if (saved.id !== reportId) {
        selectionSequence.current += 1;
        setTarget(null);
        localSelection.current = `${saved.id}::false`;
        router.push(
          serializeOpenViewUrl({
            section: "reports",
            report: saved.id,
          }) as Route,
        );
      }
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
      if (!ownsActionResult(ownerId)) return;
      const conflict = getOpenViewReportConflict(reason);
      setStale(Boolean(conflict));
      setError(
        conflict?.message ??
          (reason instanceof ReportDraftError
            ? reason.message
            : apiErrorMessage(
                reason,
                "The Report could not be saved. Your draft remains open.",
              )),
      );
    } finally {
      if (actionOwner.current.mounted && actionOwner.current.userId === ownerId)
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
        apiErrorMessage(
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
          apiErrorMessage(
            reason,
            "The Report could not be changed. Try again.",
          ),
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
        apiErrorMessage(
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
    const blockedPrintMessage =
      "Your browser blocked the print window. Allow pop-ups and try again.";
    const printWindow = action === "print" ? window.open("", "_blank") : null;
    if (printWindow) printWindow.opener = null;
    try {
      if (action === "print" && !printWindow)
        throw new Error(blockedPrintMessage);
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
        action === "print" && !printWindow
          ? blockedPrintMessage
          : apiErrorMessage(
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
  const currentTarget = target?.key === selectionKey ? target : null;
  const selectionUnavailable =
    invalidUrl ||
    Boolean(
      reportId &&
      (currentTarget?.reportError || baselineReport?.id !== reportId),
    );
  const summaryName =
    draft.name.trim() || (baselineReport ? baselineReport.name : "New Report");
  const summarySource =
    sources.find((source) => source.id === draft.moduleId)?.name ??
    (draft.moduleId ? "Source details unavailable" : "Choose a source");
  const summaryDepartment = draft.moduleId
    ? (reportDepartmentNames.get(draft.moduleId) ?? "Department unavailable")
    : "Choose a source";
  const canRunReport = Boolean(
    baselineReport &&
    !baselineReport.isDeleted &&
    !dirty &&
    !actionPending &&
    !currentIdentityLoading &&
    currentIdentity &&
    currentIdentity.role !== "guest" &&
    !currentIdentityError,
  );
  const canManageSelected = Boolean(
    baselineReport && canManageReportModule(baselineReport.moduleId),
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
        {canCreateReports ? (
          <Button
            type="button"
            onClick={newReport}
            disabled={Boolean(actionPending)}
            className="min-h-11"
          >
            <Plus data-icon="inline-start" /> New Report
          </Button>
        ) : null}
      </header>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
        <div className="min-w-0">
          <SavedReportsPanel
            reports={reports}
            departmentNames={reportDepartmentNames}
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
            canCreate={canCreateReports}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {invalidUrl ? (
            <Alert role="alert" variant="destructive">
              This Report link is invalid.
            </Alert>
          ) : null}
          {currentTarget?.loading ? (
            <p role="status" className="text-muted-foreground text-sm">
              Loading selected Report output…
            </p>
          ) : null}
          {currentTarget?.reportError ? (
            <Alert role="alert" variant="destructive">
              {currentTarget.reportError}
              <Button
                type="button"
                variant="outline"
                className="ml-3 min-h-11"
                onClick={() => setSelectionRetry((value) => value + 1)}
              >
                Retry selected Report
              </Button>
            </Alert>
          ) : null}
          {currentTarget?.runError ? (
            <Alert role="alert" variant="destructive">
              {currentTarget.runError}
              <Button
                type="button"
                variant="outline"
                className="ml-3 min-h-11"
                onClick={() => setSelectionRetry((value) => value + 1)}
              >
                Retry selected output
              </Button>
            </Alert>
          ) : null}
          {/* A refusal hides the opened Report too; the draft stays in
              state and returns once an authorized read succeeds. */}
          {accessDenied ? (
            <Alert role="alert" variant="destructive">
              OpenView data is unavailable. Sign in or ask for access, then
              retry.
            </Alert>
          ) : null}
          {accessDenied || selectionUnavailable ? null : showReportSummary ? (
            <Card className="min-w-0 self-stretch">
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
                      <dt className="text-muted-foreground">Department</dt>
                      <dd>{summaryDepartment}</dd>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <dt className="text-muted-foreground">Columns</dt>
                      <dd>
                        {draft.fields.length}{" "}
                        {draft.fields.length === 1 ? "column" : "columns"}
                        {draft.includeRowCount ? " · row count included" : ""}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {!baselineReport?.isDeleted &&
                  (baselineReport ? canManageSelected : canCreateReports) ? (
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
                  {baselineReport && canManageSelected ? (
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
                        {baselineReport.isDeleted && purgeEnabled && (
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={dirty || Boolean(actionPending)}
                            onClick={() => void reviewPurgeReport()}
                          >
                            Permanently delete Report
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              </CardHeader>
              {dirty || error || notice || currentIdentityError ? (
                <CardContent className="flex flex-col gap-3 pt-0">
                  {dirty ? (
                    <p role="status" className="text-muted-foreground text-sm">
                      Unsaved changes. Save or reset before running or
                      archiving.
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

          {!accessDenied &&
          !selectionUnavailable &&
          baselineReport &&
          currentTarget?.run ? (
            <SelectedReportRunPanel
              report={baselineReport}
              run={currentTarget.run}
              actionPending={actionPending}
              onOutputRun={outputRun}
            />
          ) : null}
          {!accessDenied &&
          !selectionUnavailable &&
          baselineReport &&
          !baselineReport.isDeleted ? (
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
                  canManage={canManageSelected}
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
        sources={editorSources}
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
              Saved runs of Reports on data you can read. Only a manager of the
              department changes its Reports.
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
      <Dialog
        open={purgeTarget !== null}
        dismissible={!actionPending}
        onOpenChange={(open) => {
          if (!open && !actionRef.current) {
            purgeRequest.current += 1;
            setPurgeTarget(null);
            setPurgePreview(null);
            setPurgeName("");
            setPurgePassword("");
            setPurgeError("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete Report?</DialogTitle>
            <DialogDescription>
              This permanently removes the archived Report and its retained
              outputs.
            </DialogDescription>
          </DialogHeader>
          {actionPending === "purge-preview" && (
            <p role="status">Preparing review…</p>
          )}
          {purgeError && (
            <p role="alert" className="text-destructive text-sm">
              {purgeError}
            </p>
          )}
          {purgePreview ? (
            <div className="mt-4 space-y-4">
              <LifecyclePurgeReview
                preview={purgePreview}
                region={purgeRegion.data}
              />
              {purgePreview.impact.blockers.length === 0 && (
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void confirmReportPurge();
                  }}
                >
                  <p className="text-sm break-words">
                    Report name: <code>{purgePreview.confirmation_name}</code>
                  </p>
                  <label className="block space-y-2 text-sm">
                    Type the Report name
                    <Input
                      autoComplete="off"
                      value={purgeName}
                      disabled={Boolean(actionPending)}
                      onChange={(event) => setPurgeName(event.target.value)}
                    />
                  </label>
                  <label className="block space-y-2 text-sm">
                    Administrator password
                    <Input
                      type="password"
                      autoComplete="current-password"
                      value={purgePassword}
                      disabled={Boolean(actionPending)}
                      onChange={(event) => setPurgePassword(event.target.value)}
                    />
                  </label>
                  <Button
                    type="submit"
                    variant="destructive"
                    className="min-h-11"
                    disabled={
                      Boolean(actionPending) ||
                      !purgeEnabled ||
                      purgeName !== purgePreview.confirmation_name ||
                      !purgePassword
                    }
                  >
                    Confirm permanent deletion
                  </Button>
                </form>
              )}
            </div>
          ) : (
            !actionPending && (
              <Button
                className="mt-4 min-h-11"
                variant="outline"
                disabled={!purgeEnabled}
                onClick={() => void reviewPurgeReport()}
              >
                Review again
              </Button>
            )
          )}
          <Button
            className="mt-4 min-h-11"
            variant="outline"
            disabled={Boolean(actionPending)}
            onClick={() => {
              setPurgeTarget(null);
              setPurgePreview(null);
              setPurgeName("");
              setPurgePassword("");
              setPurgeError("");
            }}
          >
            Cancel
          </Button>
        </DialogContent>
      </Dialog>
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
