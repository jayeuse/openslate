"use client";
import { useDisplayRegion } from "@/components/use-display-region";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Route } from "next";
import { ApiContractError, ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { Columns3, Download, MoreHorizontal, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import {
  queryOpenViewGroupedRecords,
  type OpenViewGroupSelector,
  type OpenViewGroupedRecordsResult,
} from "../adapters/analytics-api";
import {
  archiveOpenViewSavedView,
  createOpenViewSavedView,
  getOpenViewConflict,
  getOpenViewSavedView,
  queryOpenViewRecords,
  restoreOpenViewSavedView,
  updateOpenViewSavedView,
  type OpenViewDataSourceField,
  type OpenViewQueryDefinition,
  type OpenViewRecord,
  type OpenViewSavedView,
} from "../adapters/views-api";
import { queryOpenViewWindowRecords } from "../adapters/window-api";
import { authMeOptions } from "../adapters/openview-queries";
import { isCalendarDateField } from "./live-calendar";
import { LiveKanban } from "./live-kanban";
import {
  recordMoveChanges,
  sameRecordMoveValue,
  type PendingRecordMove,
  type RecordMoveCommand,
} from "../domain/record-moves";
import { updateOpenViewRecordMoves } from "../adapters/records-api";
import { serverFieldMessage } from "../domain/record-form";
import { LiveCalendar } from "./live-calendar";
import { LiveTimeline } from "./live-timeline";
import { workspaceCalendarQueryOptions } from "../../manage/adapters/workspace-api";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";
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
import { LoadingRegion } from "@/components/ui/loading-region";
import { Button } from "@/components/ui/button";
import {
  AccessToolbar,
  FilterSelect,
  type FilterChip,
} from "@/components/systems/access/components/access-toolbar";
import { LayoutMenu } from "./layout-menu";
import { QuickFilter, useQuickFilterCounts } from "./quick-filter";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  GuardedWorkspaceLink,
  useWorkspaceNavigationGuard,
} from "@/components/workspace-navigation-guard";
import { serializeOpenViewUrl } from "../domain/model";
import { canManageOpenView, openViewLevel } from "../domain/manage-access";
import {
  changedSavedViewFields,
  draftForView,
  duplicateViewName,
  emptyDefinition,
  emptyPresentation,
  hasUnsafeIntegerFilter,
  isFilterReady,
  normalizeFilterValues,
  OPERATOR_LABELS,
  upsertSavedView,
} from "../domain/server-view-draft";
import type { SavedDraft } from "../domain/server-view-draft";
import {
  decodeTemporaryView,
  encodeTemporaryView,
  parseTemporaryView,
  TEMPORARY_VIEW_PARAM,
} from "../domain/temporary-view";
import { useServerViewsResource } from "../hooks/use-server-views-resource";
import { LiveGroupedResults } from "./live-grouped-results";
import {
  LiveRecordInspector,
  type RecordInspectionContext,
  type RecordInspectionPage,
} from "./live-record-inspector";
import { LiveRecordResults } from "./live-record-results";
import { RecordCreateDialog } from "./record-create-dialog";
import { ExportDialog } from "./export-dialog";
import { useOpenViewAccessDenied } from "../adapters/openview-access";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "../../shared/runtime/workspace-identity";
import { reportDone } from "@/lib/feedback";
import { SavedViewColumnControls } from "./saved-view-column-controls";
import { SavedViewFilterControls } from "./saved-view-filter-controls";
import { SavedViewAdvancedControls } from "./saved-view-advanced-controls";
import {
  ViewsToolbarSkeleton,
  ViewsWorkspaceSkeleton,
} from "./openview-skeletons";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type SaveConflict = {
  base: OpenViewSavedView;
  latest: OpenViewSavedView;
  local: SavedDraft;
};
type SavedViewLayout = OpenViewSavedView["presentation"]["layout"];
type GeneralGroupedLayout = "table" | "grid" | "gallery";
type LiveRecordLayout =
  "table" | "grid" | "gallery" | "kanban" | "calendar" | "timeline";

const SAVED_VIEW_LAYOUT_LABELS: Record<SavedViewLayout, string> = {
  table: "Table",
  grid: "Grid",
  gallery: "Gallery",
  kanban: "Kanban",
  calendar: "Calendar",
  timeline: "Timeline",
};
const GROUP_PAGE_SIZE = 12;
const DEFAULT_RECORD_PAGE_SIZE = 25;

type RecordPageState = {
  moduleId: string;
  queryKey: string;
  rows: OpenViewRecord[];
  /** The query that produced `rows`; a reload keeps the previous rows. */
  rowsQueryKey: string;
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: string;
};

type GroupedRecordSnapshot = {
  key: string;
  page: OpenViewGroupedRecordsResult | null;
  loading: boolean;
  error: string;
};

type PendingNavigation = {
  href: string;
  resume: () => void;
  discardDraft: boolean;
} | null;

function isUuid(value: string | null): value is string {
  return value !== null && UUID_PATTERN.test(value);
}

function isLiveRecordLayout(value: string): value is LiveRecordLayout {
  return (
    value === "table" ||
    value === "grid" ||
    value === "gallery" ||
    value === "kanban" ||
    value === "calendar" ||
    value === "timeline"
  );
}

function isGeneralGroupedLayout(
  layout: SavedViewLayout,
): layout is GeneralGroupedLayout {
  return layout === "table" || layout === "grid" || layout === "gallery";
}

function groupSelectorForValue(value: string | null): OpenViewGroupSelector {
  return value === null ? { kind: "unspecified" } : { kind: "value", value };
}

function groupSelectorKey(group: OpenViewGroupSelector | null): string {
  if (group === null) return "none";
  return group.kind === "unspecified" ? "unspecified" : `value:${group.value}`;
}

function groupName(value: string | null, label: string): string {
  if (value === null) return "Unspecified";
  if (value === "") return "Blank value";
  return label;
}

function selectLabelForId(
  field: OpenViewDataSourceField | undefined,
  value: unknown,
): string {
  if (!field || field.type !== "select" || typeof value !== "string")
    return "Unavailable option";
  const options = field.config.options;
  if (!Array.isArray(options)) return "Unavailable option";
  const option = options.find(
    (candidate): candidate is { id: string; label: string } =>
      typeof candidate === "object" &&
      candidate !== null &&
      "id" in candidate &&
      candidate.id === value &&
      "label" in candidate &&
      typeof candidate.label === "string",
  );
  return option?.label ?? "Unavailable option";
}

/** A filter's condition without its field, for its chip ("is Active"). */
function filterCondition(
  filter: OpenViewQueryDefinition["filters"][number],
  field: OpenViewDataSourceField | undefined,
): string {
  const label = OPERATOR_LABELS[filter.operator];
  if (filter.expectedType === "user") return `${label} person`;
  if (filter.value === null || filter.value === undefined) return label;
  if (filter.expectedType === "select") {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    return `${label} ${values
      .map((value) => selectLabelForId(field, value))
      .join(", ")}`;
  }
  const value = Array.isArray(filter.value)
    ? filter.value.join(", ")
    : typeof filter.value === "boolean"
      ? filter.value
        ? "Yes"
        : "No"
      : String(filter.value);
  return value ? `${label} ${value}` : label;
}

function quickSortLabel(
  field: OpenViewDataSourceField,
  direction: "asc" | "desc",
) {
  const order = ["date", "datetime"].includes(field.type)
    ? direction === "desc"
      ? "Newest"
      : "Oldest"
    : ["number", "decimal", "int"].includes(field.type)
      ? direction === "desc"
        ? "High to low"
        : "Low to high"
      : direction === "desc"
        ? "Z to A"
        : "A to Z";
  return `${field.name} · ${order}`;
}

function isAuthorizationDenied(error: unknown): boolean {
  return error instanceof ApiError && [401, 403].includes(error.status);
}

/** Replace the temporary View changes without a navigation or history entry. */
function replaceTemporaryChanges(value: string | null) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(TEMPORARY_VIEW_PARAM, value);
  else url.searchParams.delete(TEMPORARY_VIEW_PARAM);
  // Next syncs useSearchParams only for calls without its own history state.
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

import {
  selectedFieldIds,
  useOpenViewDepartmentNames,
  useOpenViewSelectedFields,
} from "../hooks/use-openview-catalog";

function DepartmentName({
  departmentId,
  fallback,
}: {
  departmentId: string | undefined;
  fallback: string;
}) {
  const names = useOpenViewDepartmentNames(departmentId ? [departmentId] : []);
  return names.get(departmentId ?? "") ?? fallback;
}

export default function ServerBackedViewsWorkspace({
  invalidUrl,
}: {
  invalidUrl: boolean;
}) {
  const router = useRouter();
  // Every navigation this workspace starts runs in this transition, so the
  // temporary-changes mirror below never rewrites the address under it.
  const [navigationPending, startNavigation] = useTransition();
  const searchParams = useSearchParams();
  const requestedModule = searchParams.get("module");
  const requestedView = searchParams.get("view");
  const requestedRecord = searchParams.get("record");
  const requestedChanges = searchParams.get(TEMPORARY_VIEW_PARAM);
  const resource = useServerViewsResource(requestedModule);
  const verifiedUserId = useVerifiedWorkspaceUserId();
  const interactionSuspended = useWorkspaceInteractionSuspended();
  const exportAccessDenied = useOpenViewAccessDenied();
  const exportButtonRef = useRef<HTMLButtonElement | null>(null);
  const [exportContext, setExportContext] = useState<{
    key: string;
    moduleId: string;
    viewId: string | null;
    definition: OpenViewQueryDefinition;
    fields: OpenViewDataSourceField[];
  } | null>(null);
  const {
    catalog,
    catalogLoading,
    catalogError,
    moduleId,
    moduleWorkspace,
    setModuleWorkspace,
    moduleLoading,
    moduleError,
    metadataLoadingMore,
    metadataError,
    retryMetadata,
    loadMoreModuleMetadata,
    refreshModule,
    retryCatalog,
    recordInvalidation: streamRecordInvalidation,
  } = resource;
  // A record change made here refreshes results at once; the stream's own
  // invalidation for it may arrive later.
  const [recordChanges, setRecordChanges] = useState(0);
  const recordInvalidation = streamRecordInvalidation + recordChanges;
  const [createRecordOpen, setCreateRecordOpen] = useState(false);
  // An open edit form keeps the record dialog from closing by accident.
  const [recordEditing, setRecordEditing] = useState(false);
  const [recordPage, setRecordPage] = useState<RecordPageState | null>(null);
  const [recordPageSize, setRecordPageSize] = useState(
    DEFAULT_RECORD_PAGE_SIZE,
  );
  const [recordRetry, setRecordRetry] = useState(0);
  const [inspectionContext, setInspectionContext] =
    useState<RecordInspectionContext | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [inspectionError, setInspectionError] = useState("");
  const inspectionRequest = useRef(0);
  const [generalGroupOffset, setGeneralGroupOffset] = useState(0);
  const [generalSelectedGroup, setGeneralSelectedGroup] =
    useState<OpenViewGroupSelector | null>(null);
  const [generalGroupRetry, setGeneralGroupRetry] = useState(0);
  const [generalGroupSnapshot, setGeneralGroupSnapshot] =
    useState<GroupedRecordSnapshot | null>(null);
  const [draftState, setDraftState] = useState<{
    key: string;
    value: SavedDraft;
  } | null>(null);
  const [explicitUnsavedModules, setExplicitUnsavedModules] = useState<
    Set<string>
  >(() => new Set());
  const [pendingNavigation, setPendingNavigation] =
    useState<PendingNavigation>(null);
  const [pendingAction, setPendingAction] = useState("");
  const [recordMoves, setRecordMoves] = useState<
    Map<string, PendingRecordMove>
  >(() => new Map());
  const recordMovesRef = useRef(recordMoves);
  const savingRecordMoves = useRef(false);
  const recordMoveRequest = useRef(0);
  const hasRecordMoves = recordMoves.size > 0;
  useEffect(() => {
    if (!hasRecordMoves && pendingAction !== "save-moves") return;
    const preventUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [hasRecordMoves, pendingAction]);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  // The panel keeps its kind while it closes, so its title does not change
  // during the exit.
  const [viewPanel, setViewPanel] = useState<{
    kind: "columns" | "layout";
    open: boolean;
  }>({ kind: "columns", open: false });
  const [saveName, setSaveName] = useState("");
  // Save as new view creates a view even while a saved one is selected.
  const [saveAsNew, setSaveAsNew] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveConflict, setSaveConflict] = useState<SaveConflict | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedError, setArchivedError] = useState("");
  const [archivedNotice, setArchivedNotice] = useState("");
  const editRevision = useRef(0);
  const [filterRowKeyState, setFilterRowKeyState] = useState<{
    draftKey: string;
    keys: Map<object, string>;
  } | null>(null);
  const nextFilterRowKey = useRef(0);
  const recordRequest = useRef(0);
  const generalGroupRequest = useRef(0);
  const deepLinkRequest = useRef(0);
  const deepLinkStatusRef = useRef<{
    id: string;
    status: "loading" | "error";
  } | null>(null);
  const [deepLinkView, setDeepLinkView] = useState<OpenViewSavedView | null>(
    null,
  );
  const [deepLinkLookup, setDeepLinkLookup] = useState<{
    id: string;
    status: "loading" | "error";
  } | null>(null);

  useEffect(() => {
    if (!catalog || !moduleId || requestedModule) return;
    startNavigation(() =>
      router.replace(
        serializeOpenViewUrl({ section: "views", module: moduleId }) as Route,
        { scroll: false },
      ),
    );
  }, [catalog, moduleId, requestedModule, router]);

  const currentWorkspace =
    moduleWorkspace?.moduleId === moduleId ? moduleWorkspace : null;
  const moduleViews = useMemo(() => {
    const views = currentWorkspace?.views ?? [];
    if (
      !deepLinkView ||
      deepLinkView.moduleId !== moduleId ||
      views.some((view) => view.id === deepLinkView.id)
    )
      return views;
    return [...views, deepLinkView];
  }, [currentWorkspace, deepLinkView, moduleId]);
  const metadataView =
    moduleViews.find((view) => view.id === requestedView && !view.isDeleted) ??
    moduleViews.find((view) => view.isDefault && !view.isDeleted);
  const temporaryMetadata =
    requestedChanges && currentWorkspace
      ? parseTemporaryView(
          requestedChanges,
          metadataView
            ? draftForView(metadataView)
            : {
                name: "",
                definition: emptyDefinition(currentWorkspace.fields),
                presentation: emptyPresentation(currentWorkspace.fields),
              },
        )
      : null;
  const selectedFields = useOpenViewSelectedFields(
    moduleId,
    currentWorkspace?.fields,
    [
      ...selectedFieldIds(metadataView),
      ...selectedFieldIds(temporaryMetadata),
      ...(draftState?.key.startsWith(`${moduleId}:`)
        ? selectedFieldIds(draftState.value)
        : []),
    ],
  );
  const fields = selectedFields.items;
  // A missing or mismatched field is refused by normal URL validation.
  // Dependency failures must keep a valid arriving address available to Retry.
  const selectedMetadataFailure =
    selectedFields.error &&
    !(selectedFields.error instanceof ApiContractError) &&
    !(
      selectedFields.error instanceof ApiError &&
      selectedFields.error.status === 404
    );
  const fieldMetadataError = selectedMetadataFailure
    ? apiErrorMessage(
        selectedFields.error,
        "Field metadata could not be loaded. Retry.",
      )
    : "";
  const source = catalog?.find((item) => item.id === moduleId);
  const moduleName = source?.name;
  const departmentName = useOpenViewDepartmentNames(
    source?.departmentId ? [source.departmentId] : [],
  ).get(source?.departmentId ?? "");
  // The module's shared default view opens when the address names no view.
  const defaultViewId = currentWorkspace?.views.find(
    (view) => view.isDefault && !view.isDeleted,
  )?.id;
  const identity = useQuery(authMeOptions());
  const workspaceCalendar = useQuery(workspaceCalendarQueryOptions());
  const displayRegion = useDisplayRegion(workspaceCalendar.data);
  const queryClient = useQueryClient();
  useEffect(() => {
    const queryKey = workspaceCalendarQueryOptions().queryKey;
    const refreshSettings = () => {
      const cold = queryClient
        .getQueryCache()
        .findAll({ queryKey, fetchStatus: "fetching" })
        .filter((query) => query.state.data === undefined);
      void Promise.all(
        cold.map((query) => query.cancel({ revert: true })),
      ).then(() => queryClient.invalidateQueries({ queryKey }));
    };
    const unsubscribe = subscribeWorkspaceInvalidations((event) => {
      if (event.type === "resync" || event.entity === "workspace_profiles")
        refreshSettings();
    }, refreshSettings);
    return () => {
      unsubscribe();
      void queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    };
  }, [queryClient]);
  // Only a manager of the module creates, changes or archives its views.
  const canManageViews = canManageOpenView(
    identity.data,
    source?.departmentId,
    moduleId,
  );
  const recordLevel =
    source && moduleId
      ? openViewLevel(identity.data, source.departmentId, moduleId)
      : null;
  // The server checks every change; these only decide which controls show.
  const canWriteRecords = recordLevel === "write" || recordLevel === "manage";
  useEffect(() => {
    // A receipt belongs to the authority/source that submitted it. Refusal or
    // an account/source transition permanently invalidates that attempt.
    recordMoveRequest.current += 1;
    return () => {
      recordMoveRequest.current += 1;
    };
  }, [
    moduleId,
    verifiedUserId,
    canWriteRecords,
    exportAccessDenied,
    interactionSuspended,
  ]);
  // Record history is for administrators and managers of the department.
  const canReadRecordHistory = Boolean(
    source && openViewLevel(identity.data, source.departmentId) === "manage",
  );
  const routedView = isUuid(requestedView) ? requestedView : undefined;
  const explicitUnsavedSelection = Boolean(
    moduleId && explicitUnsavedModules.has(moduleId),
  );
  const implicitDraftSelection =
    !routedView && moduleId && draftState?.key.startsWith(`${moduleId}:`)
      ? draftState.key.slice(moduleId.length + 1)
      : undefined;
  const implicitSavedView = moduleViews.find(
    (view) => view.id === implicitDraftSelection && !view.isDeleted,
  );
  const implicitBaseDraft =
    implicitDraftSelection === undefined
      ? null
      : implicitDraftSelection === ""
        ? {
            name: "",
            definition: emptyDefinition(fields),
            presentation: emptyPresentation(fields),
          }
        : implicitSavedView
          ? draftForView(implicitSavedView)
          : null;
  const preserveImplicitDraft =
    implicitDraftSelection !== undefined &&
    (implicitBaseDraft === null ||
      JSON.stringify(draftState?.value) !== JSON.stringify(implicitBaseDraft));
  const selectedViewId =
    routedView ??
    (explicitUnsavedSelection
      ? undefined
      : preserveImplicitDraft
        ? implicitDraftSelection
        : defaultViewId) ??
    "";
  const draftKey = `${moduleId ?? ""}:${selectedViewId}`;
  const [recordPagePosition, setRecordPagePosition] = useState(() => ({
    key: draftKey,
    offset: 0,
  }));
  const recordOffset =
    recordPagePosition.key === draftKey ? recordPagePosition.offset : 0;
  const setRecordOffset = (offset: number) =>
    setRecordPagePosition({ key: draftKey, offset });
  const changeRecordPageSize = (pageSize: number) => {
    if (pageSize === recordPageSize) return;
    setRecordPage(null);
    setGeneralGroupSnapshot(null);
    setRecordPageSize(pageSize);
    setRecordOffset(0);
  };
  useEffect(() => {
    setRecordPagePosition((current) =>
      current.key === draftKey ? current : { key: draftKey, offset: 0 },
    );
  }, [draftKey]);
  const listedActiveView = moduleViews.find(
    (view) => view.id === selectedViewId && !view.isDeleted,
  );
  const activeSaved =
    listedActiveView ??
    (deepLinkView?.id === selectedViewId &&
    deepLinkView.moduleId === moduleId &&
    !deepLinkView.isDeleted
      ? deepLinkView
      : undefined);
  const baseDraft = useMemo<SavedDraft>(() => {
    if (activeSaved) return draftForView(activeSaved);
    return {
      name: "",
      definition: emptyDefinition(fields),
      presentation: emptyPresentation(fields),
    };
  }, [activeSaved, fields]);
  const draft = draftState?.key === draftKey ? draftState.value : baseDraft;
  const draftRef = useRef(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseDraft);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  // Temporary changes live in the page address so they can be bookmarked and
  // shared; only a manager's save stores them. `draftState` stays the one
  // owner of the draft: an address that arrives with a View (a link, reload,
  // or back/forward) restores it once, and the address then mirrors it. A
  // value the page wrote itself is never restored onto another View.
  const temporaryChanges = dirty ? encodeTemporaryView(baseDraft, draft) : null;
  const draftBaseReady = Boolean(
    moduleId &&
    currentWorkspace &&
    (!routedView || activeSaved) &&
    !selectedFields.pending &&
    !selectedMetadataFailure,
  );
  const restoredDraftKey = useRef<string | null>(null);
  const mirroredChanges = useRef<string | null>(null);
  useEffect(() => {
    if (!draftBaseReady || navigationPending) return;
    if (restoredDraftKey.current !== draftKey) {
      restoredDraftKey.current = draftKey;
      const arrived =
        requestedChanges !== null &&
        requestedChanges !== mirroredChanges.current &&
        draftState?.key !== draftKey;
      const restored = arrived
        ? decodeTemporaryView(requestedChanges, baseDraft, fields)
        : null;
      if (restored && JSON.stringify(restored) !== JSON.stringify(baseDraft)) {
        mirroredChanges.current = requestedChanges;
        setDraftState({ key: draftKey, value: restored });
        return;
      }
    }
    mirroredChanges.current = temporaryChanges;
    if (temporaryChanges !== requestedChanges)
      replaceTemporaryChanges(temporaryChanges);
  }, [
    baseDraft,
    draftBaseReady,
    draftKey,
    draftState,
    fields,
    navigationPending,
    requestedChanges,
    temporaryChanges,
  ]);
  const activeFields = useMemo(
    () => new Map(fields.map((field) => [field.id, field])),
    [fields],
  );
  const validModuleParam = !requestedModule || isUuid(requestedModule);
  const missingModuleParam = Boolean(
    catalog &&
    requestedModule &&
    !catalog.some((item) => item.id === requestedModule),
  );
  const missingRequestedView = Boolean(
    requestedView && currentWorkspace && !listedActiveView && !activeSaved,
  );
  const deepLinkLookupFailed = Boolean(
    requestedView &&
    deepLinkLookup?.id === requestedView &&
    deepLinkLookup.status === "error",
  );
  const invalidView = Boolean(
    requestedView &&
    (!isUuid(requestedView) || (missingRequestedView && deepLinkLookupFailed)),
  );
  const invalidRecord = Boolean(requestedRecord && !isUuid(requestedRecord));
  const invalidLink =
    invalidUrl ||
    !validModuleParam ||
    missingModuleParam ||
    invalidView ||
    invalidRecord;
  const normalizedDraftDefinition = useMemo(
    () => normalizeFilterValues(draft.definition),
    [draft.definition],
  );
  const inspectionKey = JSON.stringify({
    moduleId,
    draftKey,
    definition: normalizedDraftDefinition,
    groupByFieldId: draft.presentation.groupByFieldId,
    selectedGroup: generalSelectedGroup,
  });
  useEffect(() => {
    inspectionRequest.current += 1;
    setInspectionLoading(false);
    setInspectionError("");
    return () => {
      inspectionRequest.current += 1;
    };
  }, [inspectionKey]);
  const requestDefinition = useMemo<OpenViewQueryDefinition>(() => {
    if (!isUuid(requestedRecord)) return normalizedDraftDefinition;
    return {
      ...normalizedDraftDefinition,
      filters: [],
      search: requestedRecord,
      searchFields: [],
      deleted: "include",
    };
    // The compiler cannot prove the stability of search-param values; this
    // memoization keeps record reads anchored to the actual address value.
  }, [normalizedDraftDefinition, requestedRecord]);
  const draftHasUnsafeIntegerFilter = draft.definition.filters.some(
    hasUnsafeIntegerFilter,
  );
  const unsafeIntegerRequestFilter = requestDefinition.filters.some(
    hasUnsafeIntegerFilter,
  );
  const incompleteRequestFilter = requestDefinition.filters.some(
    (filter) => !isFilterReady(filter),
  );
  const presentationLayout = draft.presentation.layout;
  const queryFieldIds = new Set(
    draft.definition.columns.map(({ fieldId }) => fieldId),
  );
  const queriedFields = fields.filter((field) => queryFieldIds.has(field.id));
  const groupByField = queriedFields.find(
    (field) => field.id === draft.presentation.groupByFieldId,
  );
  const groupByFieldId = groupByField?.id;
  const groupByFieldType = groupByField?.type;
  const incompleteFilters = draft.definition.filters.some(
    (filter) => !isFilterReady(filter) || hasUnsafeIntegerFilter(filter),
  );
  const generalGroupedView = Boolean(
    moduleId &&
    isGeneralGroupedLayout(presentationLayout) &&
    groupByField &&
    !isUuid(requestedRecord),
  );
  const generalGroupRequestKey =
    generalGroupedView && moduleId && groupByFieldId && groupByFieldType
      ? JSON.stringify({
          moduleId,
          definition: normalizedDraftDefinition,
          groupByFieldId,
          groupByFieldType,
          groupOffset: generalGroupOffset,
          selectedGroup: generalSelectedGroup,
          recordPageSize,
          recordOffset,
          retry: generalGroupRetry,
        })
      : "";
  useEffect(() => {
    setGeneralGroupOffset(0);
    setGeneralSelectedGroup(null);
  }, [draftKey]);
  const queryKey = useMemo(
    () =>
      JSON.stringify({
        moduleId,
        definition: requestDefinition,
        limit: recordPageSize,
        offset: recordOffset,
      }),
    [moduleId, recordOffset, recordPageSize, requestDefinition],
  );

  useEffect(() => {
    if (unsafeIntegerRequestFilter || incompleteRequestFilter) {
      recordRequest.current += 1;
      setRecordPage(null);
      return;
    }
    if (generalGroupedView) {
      recordRequest.current += 1;
      setRecordPage(null);
      return;
    }
    if (
      (presentationLayout === "kanban" ||
        presentationLayout === "calendar" ||
        presentationLayout === "timeline") &&
      !isUuid(requestedRecord)
    ) {
      setRecordPage(null);
      return;
    }
    if (
      !moduleId ||
      !currentWorkspace ||
      currentWorkspace.fields.length === 0
    ) {
      setRecordPage(null);
      return;
    }
    const request = ++recordRequest.current;
    setRecordPage((previous) => ({
      moduleId,
      queryKey,
      rows: previous?.moduleId === moduleId ? previous.rows : [],
      rowsQueryKey:
        previous?.moduleId === moduleId ? previous.rowsQueryKey : queryKey,
      limit: recordPageSize,
      offset: previous?.moduleId === moduleId ? previous.offset : 0,
      total: previous?.moduleId === moduleId ? previous.total : 0,
      hasMore: previous?.moduleId === moduleId ? previous.hasMore : false,
      loading: true,
      error: "",
    }));
    void queryOpenViewRecords({
      moduleId,
      definition: requestDefinition,
      limit: recordPageSize,
      offset: isUuid(requestedRecord) ? 0 : recordOffset,
    })
      .then((result) => {
        if (request !== recordRequest.current) return;
        setRecordPage({
          moduleId,
          queryKey,
          rows: result.items,
          rowsQueryKey: queryKey,
          limit: result.pagination.limit,
          offset: result.pagination.offset,
          total: result.pagination.total,
          hasMore: result.pagination.hasMore,
          loading: false,
          error: "",
        });
      })
      .catch((error: unknown) => {
        if (request !== recordRequest.current) return;
        if (isAuthorizationDenied(error)) {
          inspectionRequest.current += 1;
          setInspectionContext(null);
          setInspectionError(
            "This record is no longer available with your current access.",
          );
          setRecordPage({
            moduleId,
            queryKey,
            rows: [],
            rowsQueryKey: queryKey,
            limit: recordPageSize,
            offset: 0,
            total: 0,
            hasMore: false,
            loading: false,
            error:
              "You no longer have access to these records. Sign in or ask for access, then retry.",
          });
          return;
        }
        setRecordPage((previous) => ({
          moduleId,
          queryKey,
          rows: previous?.moduleId === moduleId ? previous.rows : [],
          rowsQueryKey:
            previous?.moduleId === moduleId ? previous.rowsQueryKey : queryKey,
          limit: recordPageSize,
          offset: previous?.moduleId === moduleId ? previous.offset : 0,
          total: previous?.moduleId === moduleId ? previous.total : 0,
          hasMore: previous?.moduleId === moduleId ? previous.hasMore : false,
          loading: false,
          error: apiErrorMessage(error, "Records could not be loaded."),
        }));
      });
    return () => {
      recordRequest.current += 1;
    };
  }, [
    currentWorkspace,
    generalGroupedView,
    incompleteRequestFilter,
    moduleId,
    presentationLayout,
    queryKey,
    recordOffset,
    recordInvalidation,
    recordRetry,
    recordPageSize,
    requestDefinition,
    requestedRecord,
    unsafeIntegerRequestFilter,
  ]);

  useEffect(() => {
    if (
      !generalGroupedView ||
      !moduleId ||
      !currentWorkspace ||
      !groupByFieldId ||
      !groupByFieldType ||
      incompleteFilters
    ) {
      generalGroupRequest.current += 1;
      setGeneralGroupSnapshot(null);
      return;
    }
    const request = ++generalGroupRequest.current;
    setGeneralGroupSnapshot({
      key: generalGroupRequestKey,
      page: null,
      loading: true,
      error: "",
    });
    void queryOpenViewGroupedRecords({
      moduleId,
      definition: normalizedDraftDefinition,
      groupBy: {
        fieldId: groupByFieldId,
        expectedType: groupByFieldType,
      },
      limit: recordPageSize,
      offset: recordOffset,
      groupLimit: GROUP_PAGE_SIZE,
      groupOffset: generalGroupOffset,
      selectedGroup: generalSelectedGroup,
    })
      .then((page) => {
        if (request !== generalGroupRequest.current) return;
        setGeneralGroupSnapshot({
          key: generalGroupRequestKey,
          page,
          loading: false,
          error: "",
        });
      })
      .catch((error: unknown) => {
        if (request !== generalGroupRequest.current) return;
        setGeneralGroupSnapshot({
          key: generalGroupRequestKey,
          page: null,
          loading: false,
          error: apiErrorMessage(error, "Grouped records could not be loaded."),
        });
      });
    return () => {
      generalGroupRequest.current += 1;
    };
  }, [
    currentWorkspace,
    generalGroupOffset,
    generalGroupRequestKey,
    generalGroupedView,
    generalSelectedGroup,
    groupByFieldId,
    groupByFieldType,
    incompleteFilters,
    moduleId,
    normalizedDraftDefinition,
    recordPageSize,
    recordOffset,
    recordInvalidation,
  ]);

  const ordinaryRecordPage =
    !unsafeIntegerRequestFilter &&
    !incompleteRequestFilter &&
    recordPage &&
    recordPage.moduleId === moduleId &&
    recordPage.queryKey === queryKey
      ? recordPage
      : null;
  const currentGeneralGroupSnapshot =
    generalGroupSnapshot?.key === generalGroupRequestKey
      ? generalGroupSnapshot
      : null;
  const currentGeneralGroupPage = currentGeneralGroupSnapshot?.page ?? null;
  const generalGroupError = currentGeneralGroupSnapshot?.error ?? "";
  const generalGroupLoading = Boolean(
    generalGroupedView &&
    (currentGeneralGroupSnapshot === null ||
      currentGeneralGroupSnapshot.loading),
  );
  const groupPagination = currentGeneralGroupPage?.groupPagination;
  const groupStart =
    groupPagination && groupPagination.count > 0
      ? groupPagination.offset + 1
      : 0;
  const groupEnd = groupPagination
    ? groupPagination.offset + groupPagination.count
    : 0;
  const groupRange = groupPagination
    ? groupPagination.total === 0
      ? "No groups"
      : `Groups ${groupStart}–${groupEnd} of ${groupPagination.total}`
    : generalGroupLoading
      ? "Loading groups…"
      : "Groups unavailable";
  const groupOptions =
    currentGeneralGroupPage?.groups.map((group) => {
      const selector = groupSelectorForValue(group.value);
      const key = groupSelectorKey(selector);
      return {
        key,
        label: groupName(group.value, group.label),
        count: group.count,
        selected: key === groupSelectorKey(generalSelectedGroup),
        selector,
      };
    }) ?? [];
  const selectedGeneralGroupPage =
    currentGeneralGroupPage &&
    groupSelectorKey(currentGeneralGroupPage.selectedGroup) ===
      groupSelectorKey(generalSelectedGroup) &&
    currentGeneralGroupPage.pagination?.offset === recordOffset
      ? currentGeneralGroupPage
      : null;
  const selectedGeneralGroupDetails = currentGeneralGroupPage?.groups.find(
    (group) =>
      groupSelectorKey(groupSelectorForValue(group.value)) ===
      groupSelectorKey(generalSelectedGroup),
  );
  const currentRecordPage: RecordPageState | null = generalGroupedView
    ? generalSelectedGroup && moduleId
      ? {
          moduleId,
          queryKey: generalGroupRequestKey,
          rows: selectedGeneralGroupPage?.items ?? [],
          rowsQueryKey: generalGroupRequestKey,
          limit: selectedGeneralGroupPage?.pagination?.limit ?? recordPageSize,
          offset: selectedGeneralGroupPage?.pagination?.offset ?? 0,
          total:
            selectedGeneralGroupPage?.pagination?.total ??
            selectedGeneralGroupDetails?.count ??
            0,
          hasMore: selectedGeneralGroupPage?.pagination?.hasMore ?? false,
          loading: generalGroupLoading,
          error: generalGroupError,
        }
      : null
    : ordinaryRecordPage;
  const pageRows = currentRecordPage?.rows ?? [];
  const renderedRecordOffset = currentRecordPage?.offset ?? 0;
  const activeInspectionContext =
    inspectionContext?.key === inspectionKey &&
    inspectionContext.recordId === requestedRecord
      ? inspectionContext
      : null;
  const inspectedIndex =
    activeInspectionContext?.rows.findIndex(
      (row) => row.id === requestedRecord,
    ) ?? -1;
  const hasPreviousInspectedRecord = Boolean(
    activeInspectionContext &&
    inspectedIndex >= 0 &&
    (inspectedIndex > 0 || activeInspectionContext.offset > 0),
  );
  const hasNextInspectedRecord = Boolean(
    activeInspectionContext &&
    inspectedIndex >= 0 &&
    (inspectedIndex < activeInspectionContext.rows.length - 1 ||
      activeInspectionContext.offset + activeInspectionContext.rows.length <
        activeInspectionContext.total),
  );
  const displayFields = draft.presentation.columnFieldIds.flatMap((fieldId) => {
    const field = fields.find(
      (candidate) => candidate.id === fieldId && queryFieldIds.has(fieldId),
    );
    return field ? [field] : [];
  });
  const isCardPresentation =
    presentationLayout === "grid" || presentationLayout === "gallery";
  const visibleFields = displayFields.length
    ? displayFields
    : !isCardPresentation
      ? fields.filter((field) => queryFieldIds.has(field.id)).slice(0, 8)
      : [];
  const cardHeaderFieldIds = new Set(
    [draft.presentation.primaryFieldId, draft.presentation.secondaryFieldId]
      .filter((fieldId): fieldId is string => fieldId !== null)
      .filter((fieldId) => queryFieldIds.has(fieldId)),
  );
  const presentationControlFields = isCardPresentation
    ? queriedFields.filter((field) => !cardHeaderFieldIds.has(field.id))
    : queriedFields;
  const pinnedField = visibleFields.find((field) =>
    draft.presentation.pinnedFieldIds.includes(field.id),
  );
  const tableFields = pinnedField
    ? [
        pinnedField,
        ...visibleFields.filter((field) => field.id !== pinnedField.id),
      ]
    : visibleFields;
  const exportContextKey = JSON.stringify({
    moduleId,
    draftKey,
    viewId: activeSaved?.id ?? null,
    verifiedUserId,
  });
  const canExport = Boolean(
    moduleId &&
    source &&
    currentWorkspace &&
    identity.isSuccess &&
    identity.data.id === verifiedUserId &&
    recordLevel &&
    !invalidLink &&
    !incompleteFilters &&
    !fieldMetadataError &&
    !selectedFields.error &&
    !selectedFields.pending &&
    !moduleLoading &&
    !interactionSuspended &&
    !exportAccessDenied,
  );
  useEffect(() => {
    // A lost source or read permission ends this export context permanently.
    // A subsequent retry requires a new explicit Export action.
    if (exportContext && (!canExport || exportContext.key !== exportContextKey))
      setExportContext(null);
  }, [canExport, exportContext, exportContextKey]);
  const presentationVisibleFields = isCardPresentation
    ? visibleFields.filter((field) => !cardHeaderFieldIds.has(field.id))
    : tableFields;
  const presentationVisibleFieldIds = new Set(
    presentationVisibleFields.map((field) => field.id),
  );
  const presentationSettingsFields = [
    ...presentationVisibleFields,
    ...presentationControlFields.filter(
      (field) => !presentationVisibleFieldIds.has(field.id),
    ),
  ];
  const dateFields = queriedFields.filter(isCalendarDateField);
  const calendarDateField = dateFields.find(
    (field) => field.id === draft.presentation.dateFieldId,
  );
  const timelineStartField = dateFields.find(
    (field) => field.id === draft.presentation.timelineStartFieldId,
  );
  const timelineEndField = dateFields.find(
    (field) => field.id === draft.presentation.timelineEndFieldId,
  );
  const timelineDeadlineField = dateFields.find(
    (field) => field.id === draft.presentation.timelineDeadlineFieldId,
  );
  const timelineProgressField = queriedFields.find(
    (field) =>
      field.id === draft.presentation.timelineProgressFieldId &&
      ["number", "decimal", "int"].includes(field.type),
  );
  const cardFieldIds = new Set(
    [
      ...visibleFields.map(({ id }) => id),
      draft.presentation.primaryFieldId,
      draft.presentation.secondaryFieldId,
    ].filter((fieldId): fieldId is string => fieldId !== null),
  );
  const cardFields = [...cardFieldIds].flatMap((fieldId) => {
    const field = fields.find(
      (candidate) => candidate.id === fieldId && queryFieldIds.has(fieldId),
    );
    return field ? [field] : [];
  });
  const liveTitleField =
    cardFields.find(
      (field) => field.id === draft.presentation.primaryFieldId,
    ) ?? cardFields[0];
  const liveDetailFields = cardFields.filter(
    (field) =>
      field.id !== liveTitleField?.id &&
      field.id !== draft.presentation.secondaryFieldId,
  );
  const presentationLayoutLabel = SAVED_VIEW_LAYOUT_LABELS[presentationLayout];
  const activeLayout = presentationLayout;
  const incompletePresentation =
    (presentationLayout === "kanban" && !groupByField) ||
    (presentationLayout === "calendar" && !calendarDateField) ||
    (presentationLayout === "timeline" &&
      (!timelineStartField ||
        !timelineEndField ||
        (draft.presentation.timelineDeadlineFieldId != null &&
          !timelineDeadlineField) ||
        (draft.presentation.timelineProgressFieldId != null &&
          !timelineProgressField)));
  const currentDefault = Boolean(activeSaved?.isDefault);
  const canEditSaved = Boolean(canManageViews && activeSaved?.canEdit);
  const quickSortFields = fields.filter((field) => queryFieldIds.has(field.id));
  const firstSort = draft.definition.sort[0];
  const quickSortValue = firstSort
    ? `${firstSort.fieldId}:${firstSort.direction}`
    : "";
  const changeLayout = (value: string) => {
    if (!isLiveRecordLayout(value)) return;
    updatePresentation((current) => ({ ...current, layout: value }));
  };
  const changeQuickSort = (value: string) => {
    if (!value) {
      updateDefinition((current) => ({
        ...current,
        sort: [],
      }));
      return;
    }
    const separator = value.lastIndexOf(":");
    const fieldId = value.slice(0, separator);
    const direction = value.slice(separator + 1);
    const field = quickSortFields.find((candidate) => candidate.id === fieldId);
    if (!field || (direction !== "asc" && direction !== "desc")) return;
    updateDefinition((current) => ({
      ...current,
      sort: [
        { fieldId: field.id, expectedType: field.type, direction },
        ...current.sort.filter((sort) => sort.fieldId !== field.id).slice(0, 2),
      ],
    }));
  };
  const archivedViews = moduleViews.filter((view) => view.isDeleted);
  const saveTarget = canEditSaved ? activeSaved : undefined;
  const renameTarget = saveAsNew ? undefined : saveTarget;
  const setRoute = useCallback(
    (
      patch: {
        module?: string | undefined;
        view?: string | undefined;
        record?: string | undefined;
      },
      replace = false,
    ) => {
      const targetModule = patch.module === undefined ? moduleId : patch.module;
      const view = Object.hasOwn(patch, "view")
        ? patch.view
        : selectedViewId || undefined;
      const target = serializeOpenViewUrl({
        section: "views",
        module: targetModule,
        view,
        record: Object.hasOwn(patch, "record")
          ? patch.record
          : isUuid(requestedRecord)
            ? requestedRecord
            : undefined,
        // Opening or closing a record keeps the temporary changes.
        changes:
          targetModule === moduleId && view === (selectedViewId || undefined)
            ? (temporaryChanges ?? undefined)
            : undefined,
      });
      if (
        replace &&
        typeof window !== "undefined" &&
        target === `${window.location.pathname}${window.location.search}`
      )
        return;
      startNavigation(() => {
        if (replace) router.replace(target as Route, { scroll: false });
        else router.push(target as Route, { scroll: false });
      });
    },
    // This callback's identity tracks the current address and temporary draft.
    [moduleId, requestedRecord, router, selectedViewId, temporaryChanges],
  );

  const openRecordFromResults = (
    recordId: string,
    pageContext?: RecordInspectionPage,
  ) => {
    const sourcePage = pageContext ?? currentRecordPage;
    if (
      moduleId &&
      sourcePage &&
      (pageContext ||
        (!currentRecordPage?.loading && !currentRecordPage?.error)) &&
      sourcePage.rows.some((row) => row.id === recordId)
    ) {
      setInspectionContext({
        key: inspectionKey,
        recordId,
        rows: [...sourcePage.rows],
        offset: sourcePage.offset,
        total: sourcePage.total,
        definition: normalizedDraftDefinition,
        source: pageContext?.source ?? {
          kind: "records",
          limit: currentRecordPage?.limit ?? recordPageSize,
          group:
            generalGroupedView &&
            groupByFieldId &&
            groupByFieldType &&
            generalSelectedGroup
              ? {
                  fieldId: groupByFieldId,
                  fieldType: groupByFieldType,
                  selected: generalSelectedGroup,
                  offset: generalGroupOffset,
                }
              : null,
        },
      });
    } else {
      setInspectionContext(null);
    }
    setRoute({ record: recordId });
  };

  const navigateInspectedRecord = async (direction: -1 | 1) => {
    const context = activeInspectionContext;
    if (!context || !moduleId || inspectedIndex < 0 || inspectionLoading)
      return;
    const adjacent = context.rows[inspectedIndex + direction];
    if (adjacent) {
      setInspectionContext({ ...context, recordId: adjacent.id });
      setRoute({ record: adjacent.id });
      return;
    }
    if (
      (direction < 0 && context.offset === 0) ||
      (direction > 0 && context.offset + context.rows.length >= context.total)
    )
      return;

    const request = ++inspectionRequest.current;
    const stillInspecting = () => {
      const location = new URL(window.location.href);
      return (
        location.searchParams.get("module") === moduleId &&
        location.searchParams.get("view") === (selectedViewId || null) &&
        location.searchParams.get("record") === context.recordId
      );
    };
    const pageSize =
      context.source.kind === "window"
        ? (context.source.request.limit ?? DEFAULT_RECORD_PAGE_SIZE)
        : (context.source.limit ?? DEFAULT_RECORD_PAGE_SIZE);
    const offset =
      direction > 0
        ? context.offset + pageSize
        : Math.max(0, context.offset - pageSize);
    setInspectionLoading(true);
    setInspectionError("");
    try {
      const page =
        context.source.kind === "window"
          ? await queryOpenViewWindowRecords({
              ...context.source.request,
              offset,
            })
          : context.source.group
            ? await queryOpenViewGroupedRecords({
                moduleId,
                definition: context.definition,
                groupBy: {
                  fieldId: context.source.group.fieldId,
                  expectedType: context.source.group.fieldType,
                },
                selectedGroup: context.source.group.selected,
                groupLimit: GROUP_PAGE_SIZE,
                groupOffset: context.source.group.offset,
                limit: pageSize,
                offset,
              })
            : await queryOpenViewRecords({
                moduleId,
                definition: context.definition,
                limit: pageSize,
                offset,
              });
      if (request !== inspectionRequest.current || !stillInspecting()) return;
      const rows = page.items;
      const adjacent = rows[direction > 0 ? 0 : rows.length - 1];
      if (!adjacent || !page.pagination) {
        setInspectionError(
          "The adjacent record is unavailable. Return to results and try again.",
        );
        return;
      }
      setInspectionContext({
        ...context,
        recordId: adjacent.id,
        rows,
        offset: page.pagination.offset,
        total: page.pagination.total,
      });
      setRoute({ record: adjacent.id });
    } catch {
      if (request === inspectionRequest.current && stillInspecting())
        setInspectionError("Adjacent records could not be loaded. Try again.");
    } finally {
      if (request === inspectionRequest.current) setInspectionLoading(false);
    }
  };

  const copyInspectedRecordLink = async () => {
    if (!moduleId || !isUuid(requestedRecord)) return;
    const path = serializeOpenViewUrl({
      section: "views",
      module: moduleId,
      view: selectedViewId || undefined,
      record: requestedRecord,
    });
    try {
      await navigator.clipboard.writeText(
        new URL(path, window.location.origin).href,
      );
      setNotice("Safe link copied.");
    } catch {
      setInspectionError("Copy is unavailable in this browser.");
    }
  };

  const returnToResults = () => {
    inspectionRequest.current += 1;
    setInspectionLoading(false);
    if (activeInspectionContext) {
      setRecordOffset(activeInspectionContext.offset);
      activeInspectionContext.source.returnToPage?.(
        activeInspectionContext.offset,
      );
    }
    setInspectionContext(null);
    setInspectionError("");
    setRoute({ record: undefined });
  };

  const selectSavedView = (next: string) => {
    if (!moduleId || next === selectedViewId) return;
    const href = serializeOpenViewUrl({
      section: "views",
      module: moduleId,
      view: next || undefined,
    }) as Route;
    const resume = () => {
      setExplicitUnsavedModules((current) => {
        const shouldBeUnsaved = next === "";
        if (current.has(moduleId) === shouldBeUnsaved) return current;
        const updated = new Set(current);
        if (shouldBeUnsaved) updated.add(moduleId);
        else updated.delete(moduleId);
        return updated;
      });
      startNavigation(() => router.push(href, { scroll: false }));
    };
    if (dirty || hasRecordMoves)
      setPendingNavigation({ href, resume, discardDraft: true });
    else resume();
  };

  useEffect(() => {
    const cancelActiveLookup = () => {
      if (deepLinkStatusRef.current?.status === "loading") {
        deepLinkRequest.current += 1;
        deepLinkStatusRef.current = null;
      }
    };
    if (
      !requestedView ||
      !isUuid(requestedView) ||
      !currentWorkspace ||
      (requestedModule &&
        !catalog?.some((sourceEntry) => sourceEntry.id === requestedModule))
    ) {
      cancelActiveLookup();
      return;
    }
    if (listedActiveView) {
      cancelActiveLookup();
      deepLinkStatusRef.current = null;
      setDeepLinkLookup((current) =>
        current?.id === requestedView ? null : current,
      );
      return;
    }
    if (deepLinkView?.id === requestedView && !deepLinkView.isDeleted) {
      cancelActiveLookup();
      deepLinkStatusRef.current = null;
      if (
        !requestedModule &&
        catalog?.some(
          (sourceEntry) => sourceEntry.id === deepLinkView.moduleId,
        ) &&
        moduleId !== deepLinkView.moduleId
      )
        setRoute(
          { module: deepLinkView.moduleId, view: deepLinkView.id },
          true,
        );
      else if (deepLinkView.moduleId !== moduleId) {
        deepLinkStatusRef.current = { id: requestedView, status: "error" };
        setDeepLinkLookup({ id: requestedView, status: "error" });
      }
      return;
    }
    if (
      deepLinkStatusRef.current?.id === requestedView &&
      (deepLinkStatusRef.current.status === "loading" ||
        deepLinkStatusRef.current.status === "error")
    )
      return;

    const request = ++deepLinkRequest.current;
    deepLinkStatusRef.current = { id: requestedView, status: "loading" };
    setDeepLinkLookup({ id: requestedView, status: "loading" });
    void getOpenViewSavedView(requestedView)
      .then((view) => {
        if (request !== deepLinkRequest.current) return;
        if (
          view.isDeleted ||
          !catalog?.some((sourceEntry) => sourceEntry.id === view.moduleId) ||
          (requestedModule && requestedModule !== view.moduleId)
        ) {
          deepLinkStatusRef.current = { id: requestedView, status: "error" };
          setDeepLinkLookup({ id: requestedView, status: "error" });
          return;
        }
        deepLinkStatusRef.current = null;
        setDeepLinkView(view);
        setModuleWorkspace((previous) => {
          if (!previous || previous.moduleId !== view.moduleId) return previous;
          return {
            ...previous,
            views: upsertSavedView(previous.views, view),
          };
        });
        setDeepLinkLookup(null);
        if (!requestedModule && moduleId !== view.moduleId)
          setRoute({ module: view.moduleId, view: view.id }, true);
      })
      .catch(() => {
        if (request !== deepLinkRequest.current) return;
        deepLinkStatusRef.current = { id: requestedView, status: "error" };
        setDeepLinkLookup({ id: requestedView, status: "error" });
      });
    return () => {
      if (request === deepLinkRequest.current) {
        deepLinkRequest.current += 1;
        if (
          deepLinkStatusRef.current?.id === requestedView &&
          deepLinkStatusRef.current.status === "loading"
        )
          deepLinkStatusRef.current = null;
      }
    };
  }, [
    catalog,
    currentWorkspace,
    deepLinkView,
    listedActiveView,
    moduleId,
    requestedModule,
    requestedView,
    setRoute,
  ]);

  const navigationGuard = useCallback(
    (href: string, resume: () => void) => {
      if (pendingAction || savingRecordMoves.current) return false;
      if (!dirty && !hasRecordMoves) return true;
      if (
        typeof window !== "undefined" &&
        new URL(href, window.location.origin).href === window.location.href
      )
        return true;
      setPendingNavigation({ href, resume, discardDraft: true });
      return false;
    },
    [dirty, hasRecordMoves, pendingAction, setPendingNavigation],
  );
  useWorkspaceNavigationGuard(navigationGuard);

  const confirmDraftDiscard = (resume: () => void) => {
    if (!dirtyRef.current && recordMovesRef.current.size === 0) {
      resume();
      return;
    }
    setPendingNavigation({
      href: typeof window === "undefined" ? "/openview" : window.location.href,
      resume,
      discardDraft: false,
    });
  };

  const replaceRecordMoves = (moves: Map<string, PendingRecordMove>) => {
    recordMovesRef.current = moves;
    setRecordMoves(moves);
  };

  const stageRecordMove = (
    record: OpenViewRecord,
    field: OpenViewDataSourceField,
    value: string | boolean | null,
    targetLabel: string,
  ) => {
    stageMove(
      record,
      { kind: "single", fieldId: field.id, value },
      targetLabel,
      [field.id],
      false,
    );
  };

  const stageMove = (
    record: OpenViewRecord,
    command: RecordMoveCommand,
    targetLabel: string,
    fieldIds: readonly string[],
    dates = true,
  ) => {
    const changes = recordMoveChanges(command);
    if (
      !canWriteRecords ||
      interactionSuspended ||
      exportAccessDenied ||
      pendingAction ||
      savingRecordMoves.current ||
      record.isDeleted ||
      record.moduleId !== moduleId ||
      changes.some((change) => {
        const field = activeFields.get(change.fieldId);
        return (
          !field ||
          field.moduleId !== moduleId ||
          !fieldIds.includes(field.id) ||
          !(
            dates ? ["date", "datetime"] : ["select", "user", "boolean"]
          ).includes(field.type)
        );
      })
    )
      return;
    const existing = recordMovesRef.current.get(record.id);
    if (
      existing &&
      recordMoveChanges(existing).some(
        (change) => !fieldIds.includes(change.fieldId),
      )
    ) {
      setActionError(
        "This record already has a move in another field. Save or discard that move first.",
      );
      return;
    }
    const original = existing?.original ?? {
      ...record,
      data: { ...record.data },
      displayValues: { ...record.displayValues },
    };
    const moves = new Map(recordMovesRef.current);
    const combined = new Map(
      (existing ? recordMoveChanges(existing) : []).map((change) => [
        change.fieldId,
        change,
      ]),
    );
    changes.forEach((change) => combined.set(change.fieldId, change));
    const changed = [...combined.values()].filter(
      (change) =>
        !sameRecordMoveValue(
          original.data[change.fieldId],
          change.value,
          activeFields.get(change.fieldId)?.type,
        ),
    );
    if (changed.length === 0) moves.delete(record.id);
    else {
      if (!existing && moves.size >= 100) {
        setActionError(
          "You can move up to 100 records at a time. Save or discard the current moves first.",
        );
        return;
      }
      if (changed.length > 2) return;
      const next: RecordMoveCommand =
        changed.length === 1
          ? { kind: "single", ...changed[0] }
          : { kind: "compound", changes: [changed[0], changed[1]] };
      moves.set(record.id, { ...next, original, targetLabel });
    }
    replaceRecordMoves(moves);
    setActionError("");
    setNotice("");
  };

  const saveRecordMoves = async () => {
    if (
      !moduleId ||
      !canWriteRecords ||
      interactionSuspended ||
      exportAccessDenied ||
      pendingAction ||
      savingRecordMoves.current ||
      recordMovesRef.current.size === 0
    )
      return;
    const submitted = new Map(recordMovesRef.current);
    if (
      [...submitted.values()].some(
        (move) => move.original.moduleId !== moduleId,
      )
    ) {
      setActionError(
        "These unsaved moves belong to another data source. Discard them before moving records here.",
      );
      return;
    }
    savingRecordMoves.current = true;
    const request = ++recordMoveRequest.current;
    setPendingAction("save-moves");
    setActionError("");
    setNotice("");
    try {
      const results = await updateOpenViewRecordMoves({
        moduleId,
        items: [...submitted].map(([recordId, move]) => ({
          recordId,
          ...(move.kind === "single"
            ? { fieldId: move.fieldId, value: move.value }
            : { changes: [...move.changes] }),
          revision: move.original.updatedAt,
        })),
      });
      const remaining = new Map(submitted);
      if (request !== recordMoveRequest.current) return;
      let saved = 0;
      let forbidden = false;
      for (const result of results) {
        if (result.status === "updated") {
          remaining.delete(result.record_id);
          saved += 1;
          continue;
        }
        const move = submitted.get(result.record_id);
        if (!move) continue;
        const error =
          result.status === "stale"
            ? "Changed by someone else — review"
            : result.status === "forbidden"
              ? "You no longer have permission to move this record."
              : result.errors
                  .map((issue) => serverFieldMessage(issue.message))
                  .join(" ") ||
                "This move cannot be saved. Review the field value.";
        remaining.set(result.record_id, {
          ...move,
          status: result.status,
          error,
        });
        forbidden ||= result.status === "forbidden";
      }
      replaceRecordMoves(remaining);
      setRecordChanges((current) => current + 1);
      setNotice(
        `Saved ${saved} ${saved === 1 ? "move" : "moves"}.${remaining.size ? ` ${remaining.size} ${remaining.size === 1 ? "move needs" : "moves need"} review.` : ""}`,
      );
      if (forbidden) await identity.refetch();
    } catch (error: unknown) {
      if (request !== recordMoveRequest.current) return;
      setActionError(
        `Your moves could not be confirmed. ${apiErrorMessage(error, "Moves could not be saved.")} Your unsaved moves are kept.`,
      );
      // An unavailable or uncorrelated response can follow a committed write.
      // Refresh authoritative results without changing the pending revisions.
      if (!(error instanceof ApiError) || error.status >= 500)
        setRecordChanges((current) => current + 1);
      if (error instanceof ApiError && error.status === 403)
        await identity.refetch();
    } finally {
      savingRecordMoves.current = false;
      setPendingAction("");
    }
  };

  const updateDraft = (update: (current: SavedDraft) => SavedDraft) => {
    const next = update(draft);
    if (
      JSON.stringify(next.definition) !== JSON.stringify(draft.definition) ||
      next.presentation.groupByFieldId !== draft.presentation.groupByFieldId
    ) {
      setRecordOffset(0);
      setGeneralGroupOffset(0);
      setGeneralSelectedGroup(null);
    }
    editRevision.current += 1;
    draftRef.current = next;
    const nextDirty = JSON.stringify(next) !== JSON.stringify(baseDraft);
    dirtyRef.current = nextDirty;
    setDraftState(nextDirty ? { key: draftKey, value: next } : null);
    setNotice("");
    setActionError("");
  };

  const updateDefinition = (
    update: (current: OpenViewQueryDefinition) => OpenViewQueryDefinition,
  ) =>
    updateDraft((current) => ({
      ...current,
      definition: update(current.definition),
    }));

  const filterRowKeyFor = (
    filter: OpenViewQueryDefinition["filters"][number],
    index: number,
  ) => {
    if (filterRowKeyState?.draftKey === draftKey) {
      const existingKey = filterRowKeyState.keys.get(filter);
      if (existingKey) return existingKey;
    }
    return `${draftKey}:saved-filter:${index}`;
  };

  const updateFilterAtIndex = (
    filters: OpenViewQueryDefinition["filters"],
    index: number,
    update: (
      filter: OpenViewQueryDefinition["filters"][number],
    ) => OpenViewQueryDefinition["filters"][number],
  ) =>
    filters.map((filter, filterIndex) => {
      if (filterIndex !== index) return filter;
      const updated = update(filter);
      const keys = new Map<object, string>();
      filters.forEach((candidate, candidateIndex) => {
        keys.set(
          candidateIndex === index ? updated : candidate,
          filterRowKeyFor(candidate, candidateIndex),
        );
      });
      setFilterRowKeyState({ draftKey, keys });
      return updated;
    });

  const updateFilter = (
    index: number,
    update: (
      filter: OpenViewQueryDefinition["filters"][number],
    ) => OpenViewQueryDefinition["filters"][number],
  ) =>
    updateDefinition((current) => ({
      ...current,
      filters: updateFilterAtIndex(current.filters, index, update),
    }));

  const removeFilter = (index: number) =>
    updateDefinition((current) => {
      const keys = new Map<object, string>();
      current.filters.forEach((item, itemIndex) => {
        if (itemIndex !== index)
          keys.set(item, filterRowKeyFor(item, itemIndex));
      });
      setFilterRowKeyState({ draftKey, keys });
      return {
        ...current,
        filters: current.filters.filter((_, itemIndex) => itemIndex !== index),
      };
    });

  // OD14: the first choice field is the quick filter. Its choice is an
  // "is" filter on that field, shown in the strip rather than as a chip.
  const quickField = fields.find((field) => field.type === "select");
  const isQuickFilter = (filter: OpenViewQueryDefinition["filters"][number]) =>
    filter.fieldId === quickField?.id &&
    filter.operator === "eq" &&
    typeof filter.value === "string" &&
    filter.value !== "";
  const quickFilterValue = draft.definition.filters.find(isQuickFilter)?.value;
  const quickFilterCounts = useQuickFilterCounts({
    moduleId: moduleId ?? "",
    fieldId: quickField?.id ?? "",
    definition: {
      ...normalizedDraftDefinition,
      filters: normalizedDraftDefinition.filters.filter(
        (filter) => !isQuickFilter(filter),
      ),
    },
    refreshKey: recordInvalidation,
    // Any-condition logic would widen the view with the strip's choice.
    enabled: Boolean(
      moduleId && quickField && draft.definition.logic === "and",
    ),
  });
  // The strip shows its choice; without a strip the choice is a chip.
  const quickFilterShown = quickFilterCounts.choices.length > 0;
  const setQuickFilter = (value: string | null) => {
    if (!quickField) return;
    updateDefinition((current) => {
      const keys = new Map<object, string>();
      const filters = current.filters.filter((item, itemIndex) => {
        if (isQuickFilter(item)) return false;
        keys.set(item, filterRowKeyFor(item, itemIndex));
        return true;
      });
      if (value !== null) {
        const quick: OpenViewQueryDefinition["filters"][number] = {
          fieldId: quickField.id,
          expectedType: "select",
          operator: "eq",
          value,
        };
        keys.set(
          quick,
          `${draftKey}:quick-filter:${nextFilterRowKey.current++}`,
        );
        filters.push(quick);
      }
      setFilterRowKeyState({ draftKey, keys });
      return { ...current, filters };
    });
  };
  const filterChips: FilterChip[] = [
    ...draft.definition.filters.flatMap((filter, index) =>
      quickFilterShown && isQuickFilter(filter)
        ? []
        : [
            {
              key: filterRowKeyFor(filter, index),
              label:
                activeFields.get(filter.fieldId)?.name ?? "Unavailable field",
              value: filterCondition(filter, activeFields.get(filter.fieldId)),
              onRemove: () => removeFilter(index),
            },
          ],
    ),
    ...(draft.definition.deleted === "exclude"
      ? []
      : [
          {
            key: "deleted",
            label: "Deleted records",
            value: draft.definition.deleted === "only" ? "Only" : "Shown",
            onRemove: () =>
              updateDefinition((current) => ({
                ...current,
                deleted: "exclude",
              })),
          },
        ]),
  ];
  const addFilter = () => {
    const field = fields[0];
    if (!field) return;
    updateDefinition((current) => {
      const newFilter: OpenViewQueryDefinition["filters"][number] = {
        fieldId: field.id,
        expectedType: field.type,
        operator: "eq",
        value: "",
      };
      const keys = new Map<object, string>();
      current.filters.forEach((item, itemIndex) => {
        keys.set(item, filterRowKeyFor(item, itemIndex));
      });
      keys.set(
        newFilter,
        `${draftKey}:new-filter:${nextFilterRowKey.current++}`,
      );
      setFilterRowKeyState({ draftKey, keys });
      return { ...current, filters: [...current.filters, newFilter] };
    });
  };

  const updatePresentation = (
    update: (
      current: OpenViewSavedView["presentation"],
    ) => OpenViewSavedView["presentation"],
  ) =>
    updateDraft((current) => ({
      ...current,
      presentation: update(current.presentation),
    }));

  const updatePresentationFieldVisibility = (
    fieldId: string,
    visible: boolean,
  ) => {
    const currentVisibleIds = visibleFields.map((field) => field.id);
    if (visible) {
      updatePresentation((current) => {
        const columnFieldIds = current.columnFieldIds.length
          ? current.columnFieldIds
          : currentVisibleIds;
        if (columnFieldIds.includes(fieldId) || columnFieldIds.length >= 20)
          return current;
        return { ...current, columnFieldIds: [...columnFieldIds, fieldId] };
      });
      return;
    }
    if (presentationLayout === "table" && currentVisibleIds.length <= 1) return;
    updatePresentation((current) => {
      const columnFieldIds = current.columnFieldIds.length
        ? current.columnFieldIds
        : currentVisibleIds;
      const nextColumnFieldIds = columnFieldIds.filter((id) => id !== fieldId);
      return {
        ...current,
        columnFieldIds: nextColumnFieldIds,
        pinnedFieldIds: current.pinnedFieldIds.filter((id) =>
          nextColumnFieldIds.includes(id),
        ),
      };
    });
  };

  const movePresentationField = (fieldId: string, direction: -1 | 1) => {
    const visibleIds = presentationVisibleFields.map((field) => field.id);
    const index = visibleIds.indexOf(fieldId);
    const nextPosition = index + direction;
    if (index < 0 || nextPosition < 0 || nextPosition >= visibleIds.length)
      return;
    const pinnedIndex = pinnedField ? visibleIds.indexOf(pinnedField.id) : -1;
    if (presentationLayout === "table" && pinnedIndex >= 0) {
      if (
        (fieldId === pinnedField?.id && direction === 1) ||
        (fieldId !== pinnedField?.id && nextPosition === pinnedIndex)
      )
        return;
    }
    const nextVisibleIds = [...visibleIds];
    [nextVisibleIds[index], nextVisibleIds[nextPosition]] = [
      nextVisibleIds[nextPosition],
      nextVisibleIds[index],
    ];
    const reorderableIds = new Set(visibleIds);
    updatePresentation((current) => {
      const columnFieldIds = current.columnFieldIds.length
        ? current.columnFieldIds
        : visibleFields.map((field) => field.id);
      let nextIdIndex = 0;
      return {
        ...current,
        columnFieldIds: columnFieldIds.map((id) =>
          reorderableIds.has(id) ? nextVisibleIds[nextIdIndex++] : id,
        ),
      };
    });
  };

  const updatePinnedField = (fieldId: string, pinned: boolean) => {
    if (!pinned) {
      updatePresentation((current) => ({
        ...current,
        pinnedFieldIds: current.pinnedFieldIds.filter((id) => id !== fieldId),
      }));
      return;
    }
    updatePresentation((current) => {
      const columnFieldIds = current.columnFieldIds.length
        ? current.columnFieldIds
        : visibleFields.map((field) => field.id);
      return {
        ...current,
        columnFieldIds: [
          fieldId,
          ...columnFieldIds.filter((id) => id !== fieldId),
        ],
        pinnedFieldIds: [fieldId],
      };
    });
  };

  const acceptSavedView = (view: OpenViewSavedView, select = true) => {
    setModuleWorkspace((previous) => {
      if (!previous || previous.moduleId !== view.moduleId) return previous;
      return { ...previous, views: upsertSavedView(previous.views, view) };
    });
    setDeepLinkView((current) => (current?.id === view.id ? view : current));
    if (select)
      setRoute(
        { module: view.moduleId, view: view.id, record: undefined },
        true,
      );
  };

  const saveView = async (
    mode: "create" | "update",
    name: string,
    resolveConflict = false,
  ) => {
    if (
      !canManageViews ||
      !moduleId ||
      pendingAction ||
      incompleteFilters ||
      incompletePresentation ||
      (saveConflict && mode === "update" && !resolveConflict)
    )
      return;
    draftRef.current = draft;
    const cleanName = name.trim();
    if (!cleanName) {
      setSaveError("Give this view a name before saving.");
      return;
    }
    if (mode === "update" && !saveTarget) return;
    const submittedRevision = editRevision.current;
    setSaveError("");
    setActionError("");
    setPendingAction(
      mode === "update" ? "Updating saved view…" : "Saving saved view…",
    );
    try {
      const saved =
        mode === "update" && saveTarget
          ? await updateOpenViewSavedView({
              id: saveTarget.id,
              revision: saveTarget.revision,
              name: cleanName,
              definition: normalizeFilterValues(draft.definition),
              presentation: draft.presentation,
            })
          : await createOpenViewSavedView({
              moduleId,
              name: cleanName,
              definition: normalizeFilterValues(draft.definition),
              presentation: draft.presentation,
            });
      const changedDuringSave = submittedRevision !== editRevision.current;
      acceptSavedView(saved, !changedDuringSave);
      setSaveConflict(null);
      if (!changedDuringSave) {
        draftRef.current = draftForView(saved);
        dirtyRef.current = false;
        setDraftState(null);
        setSaveOpen(false);
        setNotice(`“${saved.name}” was saved.`);
      } else {
        const latestDraft = draftRef.current;
        const newerEditsRemain =
          JSON.stringify(latestDraft) !== JSON.stringify(draftForView(saved));
        dirtyRef.current = newerEditsRemain;
        setDraftState(
          newerEditsRemain ? { key: draftKey, value: latestDraft } : null,
        );
        setNotice(
          newerEditsRemain
            ? `“${saved.name}” was saved. Your newer edits remain open as an unsaved draft.`
            : `“${saved.name}” was saved.`,
        );
      }
    } catch (error) {
      const conflict = getOpenViewConflict(error);
      if (conflict && saveTarget) {
        setSaveOpen(true);
        try {
          const latest = await getOpenViewSavedView(saveTarget.id);
          setModuleWorkspace((previous) => {
            if (!previous || previous.moduleId !== latest.moduleId)
              return previous;
            return {
              ...previous,
              views: upsertSavedView(previous.views, latest),
            };
          });
          setDeepLinkView((current) =>
            current?.id === latest.id ? latest : current,
          );
          const local = draftRef.current;
          setSaveConflict({
            base: saveTarget,
            latest,
            local: { ...local, name: cleanName },
          });
          setSaveName(cleanName);
          setSaveError("");
          setActionError("");
        } catch (refreshError) {
          setSaveError(
            `${apiErrorMessage(refreshError, "The latest saved view could not be reloaded.")} Your local edits remain open.`,
          );
        }
      } else {
        setSaveError(
          apiErrorMessage(
            error,
            "The view could not be saved. Your edits remain open.",
          ),
        );
      }
    } finally {
      setPendingAction("");
    }
  };

  const saveChanges = () => {
    if (!activeSaved || !canEditSaved || saveConflict) return;
    void saveView("update", activeSaved.name);
  };

  const openSaveDialog = (asNew?: boolean) => {
    if (saveConflict) {
      setSaveOpen(true);
      return;
    }
    setSaveError("");
    setSaveAsNew(Boolean(asNew));
    setSaveName(asNew ? "" : (saveTarget?.name ?? ""));
    setSaveOpen(true);
  };

  const copyViewLink = async () => {
    try {
      // The address carries any unsaved changes, so the link shares them.
      await navigator.clipboard.writeText(window.location.href);
      setNotice("Link copied.");
    } catch {
      setActionError("Copy is unavailable in this browser.");
    }
  };

  const reloadConflictLatest = () => {
    if (!saveConflict) return;
    const { latest } = saveConflict;
    const latestDraft = draftForView(latest);
    setDraftState(null);
    draftRef.current = latestDraft;
    dirtyRef.current = false;
    setDeepLinkView(latest);
    setModuleWorkspace((previous) => {
      if (!previous || previous.moduleId !== latest.moduleId) return previous;
      return {
        ...previous,
        views: upsertSavedView(previous.views, latest),
      };
    });
    setSaveConflict(null);
    setSaveOpen(false);
    setSaveError("");
    setNotice(`Reloaded latest revision ${latest.revision}.`);
  };

  const saveMyVersionOverLatest = () => {
    if (!saveConflict || pendingAction) return;
    void saveView("update", saveName.trim() || saveConflict.local.name, true);
  };

  const archiveView = async () => {
    if (!activeSaved || !canEditSaved || pendingAction) return;
    setArchiveError("");
    setPendingAction("Archiving saved view…");
    try {
      await archiveOpenViewSavedView({
        id: activeSaved.id,
        revision: activeSaved.revision,
      });
      const archivedView = {
        ...activeSaved,
        isDefault: false,
        isDeleted: true,
        revision: activeSaved.revision + 1,
      };
      setModuleWorkspace((previous) => {
        if (!previous || previous.moduleId !== activeSaved.moduleId)
          return previous;
        return {
          ...previous,
          views: upsertSavedView(previous.views, archivedView),
        };
      });
      setDeepLinkView((current) =>
        current?.id === archivedView.id ? archivedView : current,
      );
      setDraftState(null);
      setRoute({ view: undefined, record: undefined }, true);
      setArchiveOpen(false);
      setNotice(`“${activeSaved.name}” was archived.`);
      refreshModule();
    } catch (error) {
      setArchiveError(
        apiErrorMessage(error, "The saved view could not be archived."),
      );
    } finally {
      setPendingAction("");
    }
  };

  const restoreView = async (view: OpenViewSavedView) => {
    if (!canManageViews || !view.canEdit || pendingAction) return;
    setArchivedError("");
    setPendingAction(`Restoring ${view.name}…`);
    try {
      const restored = await restoreOpenViewSavedView({
        id: view.id,
        revision: view.revision,
      });
      setModuleWorkspace((previous) => {
        if (!previous || previous.moduleId !== restored.moduleId)
          return previous;
        return {
          ...previous,
          views: upsertSavedView(previous.views, restored),
        };
      });
      setDeepLinkView((current) =>
        current?.id === restored.id ? restored : current,
      );
      setDraftState(null);
      setArchivedError("");
      setArchivedNotice(`“${restored.name}” was restored.`);
      setNotice(`“${restored.name}” was restored.`);
      setRoute({ view: restored.id, record: undefined }, true);
      refreshModule();
    } catch (error) {
      setArchivedError(
        apiErrorMessage(error, "The saved view could not be restored."),
      );
    } finally {
      setPendingAction("");
    }
  };

  const setDefault = async () => {
    if (!activeSaved || !canEditSaved || pendingAction) return;
    setActionError("");
    setPendingAction(
      currentDefault
        ? "Clearing the default view…"
        : "Setting the default view…",
    );
    try {
      const saved = await updateOpenViewSavedView({
        id: activeSaved.id,
        revision: activeSaved.revision,
        isDefault: !currentDefault,
      });
      // Setting a default clears the previous one on the server; reread the
      // module so every view shows its current revision.
      setModuleWorkspace((previous) =>
        previous && previous.moduleId === saved.moduleId
          ? {
              ...previous,
              views: upsertSavedView(
                previous.views.map((view) =>
                  saved.isDefault && view.isDefault
                    ? { ...view, isDefault: false }
                    : view,
                ),
                saved,
              ),
            }
          : previous,
      );
      setDeepLinkView((current) =>
        current?.id === saved.id ? saved : current,
      );
      if (!saved.isDefault && !routedView) setDraftState(null);
      setNotice(
        saved.isDefault
          ? `“${saved.name}” is now the default view of this module.`
          : "The default view was cleared.",
      );
      refreshModule();
    } catch (error) {
      setActionError(
        apiErrorMessage(error, "The default view could not be changed."),
      );
    } finally {
      setPendingAction("");
    }
  };

  const resetChanges = () => {
    if (!dirty || pendingAction || saveConflict) return;
    const restoredDraft = activeSaved ? draftForView(activeSaved) : baseDraft;
    editRevision.current += 1;
    draftRef.current = restoredDraft;
    dirtyRef.current = false;
    setDraftState(null);
    setGeneralGroupOffset(0);
    setGeneralSelectedGroup(null);
    setActionError("");
    setNotice("View changes were reset.");
  };

  const duplicateActiveView = async () => {
    if (
      !activeSaved ||
      !moduleId ||
      pendingAction ||
      saveConflict ||
      incompleteFilters ||
      incompletePresentation
    )
      return;
    const submittedRevision = editRevision.current;
    const submittedDraft = draftRef.current;
    setActionError("");
    setNotice("");
    setPendingAction("Duplicating saved view…");
    try {
      const duplicated = await createOpenViewSavedView({
        moduleId,
        name: duplicateViewName(activeSaved.name, moduleViews),
        definition: normalizeFilterValues(submittedDraft.definition),
        presentation: submittedDraft.presentation,
      });
      setModuleWorkspace((previous) => {
        if (!previous || previous.moduleId !== duplicated.moduleId)
          return previous;
        return {
          ...previous,
          views: upsertSavedView(previous.views, duplicated),
        };
      });
      const changedDuringDuplicate = submittedRevision !== editRevision.current;
      const nextDraft = changedDuringDuplicate
        ? draftRef.current
        : draftForView(duplicated);
      draftRef.current = nextDraft;
      const newerEditsRemain =
        JSON.stringify(nextDraft) !== JSON.stringify(draftForView(duplicated));
      dirtyRef.current = newerEditsRemain;
      setDraftState(
        newerEditsRemain
          ? { key: `${duplicated.moduleId}:${duplicated.id}`, value: nextDraft }
          : null,
      );
      setRoute(
        { module: duplicated.moduleId, view: duplicated.id, record: undefined },
        true,
      );
      setNotice(`“${duplicated.name}” was duplicated.`);
    } catch (error) {
      setActionError(
        apiErrorMessage(
          error,
          "The saved view could not be duplicated. Your edits remain open.",
        ),
      );
    } finally {
      setPendingAction("");
    }
  };

  const recoverLink = () => {
    if (!moduleId) return;
    setRoute({ module: moduleId, view: undefined, record: undefined }, true);
  };

  if (!catalogError && catalog?.length === 0) {
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <OpenViewHeader />
        <Empty>
          <EmptyHeader>
            <EmptyTitle role="heading" aria-level={2}>
              Nothing published yet
            </EmptyTitle>
            <EmptyDescription>
              OpenView shows records from published modules. Design your modules
              in the Sandbox and publish them to see records here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild className="min-h-11">
              <GuardedWorkspaceLink href={"/sandbox" as Route}>
                Open Sandbox
              </GuardedWorkspaceLink>
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  const recordPageRequestPending = Boolean(
    !generalGroupedView &&
    moduleId &&
    currentWorkspace &&
    currentWorkspace.fields.length > 0 &&
    presentationLayout !== "kanban" &&
    presentationLayout !== "calendar" &&
    presentationLayout !== "timeline" &&
    !unsafeIntegerRequestFilter &&
    !incompleteRequestFilter &&
    (!recordPage ||
      recordPage.moduleId !== moduleId ||
      recordPage.queryKey !== queryKey),
  );
  const rowPageLoading = currentRecordPage?.loading ?? recordPageRequestPending;
  const rowError = currentRecordPage?.error ?? "";
  // A refresh keeps showing the record its own lookup already returned, so an
  // open edit form is not discarded while results reload. A row from another
  // query (such as the list) never shows before the lookup authorizes it.
  const linkedRecordRow =
    isUuid(requestedRecord) &&
    ordinaryRecordPage &&
    !ordinaryRecordPage.error &&
    ordinaryRecordPage.rowsQueryKey === queryKey
      ? (ordinaryRecordPage.rows.find((row) => row.id === requestedRecord) ??
        null)
      : null;
  const linkedRecordLoading = Boolean(
    isUuid(requestedRecord) &&
    (!ordinaryRecordPage || ordinaryRecordPage.loading) &&
    !linkedRecordRow,
  );
  const linkedRecord = linkedRecordLoading ? null : linkedRecordRow;
  const inspectionActions = linkedRecord ? (
    <div className="flex flex-wrap items-center gap-2">
      {activeInspectionContext ? (
        <>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!hasPreviousInspectedRecord || inspectionLoading}
            onClick={() => void navigateInspectedRecord(-1)}
          >
            Previous record
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!hasNextInspectedRecord || inspectionLoading}
            onClick={() => void navigateInspectedRecord(1)}
          >
            Next record
          </Button>
        </>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        onClick={() => void copyInspectedRecordLink()}
      >
        Copy safe link
      </Button>
    </div>
  ) : null;
  const recordTotal =
    currentRecordPage && !generalGroupedView ? currentRecordPage.total : null;
  // Refreshes report here, in the meta line, so the page never shifts.
  const status = metadataLoadingMore
    ? "Loading more fields and views…"
    : pendingAction ||
      (moduleLoading
        ? "Refreshing views and fields…"
        : rowPageLoading
          ? "Refreshing records…"
          : "");
  const meta = [
    departmentName,
    recordTotal === null
      ? null
      : `${recordTotal} ${recordTotal === 1 ? "record" : "records"}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const savePending =
    Boolean(pendingAction) ||
    incompleteFilters ||
    incompletePresentation ||
    Boolean(saveConflict);
  // OD5: one primary. With unsaved changes a manager saves the view;
  // otherwise a writer adds a record.
  const saving = dirty && canManageViews;
  const headerActions = moduleId ? (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <label
          htmlFor="openview-saved-view"
          className="text-muted-foreground shrink-0 text-sm"
        >
          View
        </label>
        <Select
          id="openview-saved-view"
          aria-label="Saved view"
          className="min-h-11 min-w-0 sm:w-48"
          value={activeSaved?.id ?? ""}
          disabled={!currentWorkspace || Boolean(pendingAction)}
          onValueChange={selectSavedView}
        >
          <option value="">All records</option>
          {moduleViews
            .filter((view) => !view.isDeleted)
            .map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
                {view.id === defaultViewId ? " · default" : ""}
              </option>
            ))}
        </Select>
      </div>
      <Button
        ref={exportButtonRef}
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={!canExport}
        onClick={() => {
          if (!canExport || !moduleId) return;
          setExportContext({
            key: exportContextKey,
            moduleId,
            viewId: activeSaved?.id ?? null,
            definition: normalizedDraftDefinition,
            fields: tableFields,
          });
        }}
      >
        <Download aria-hidden="true" />
        Export
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11"
              aria-label="More view actions"
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="slim-ui min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuItem
              className="min-h-11"
              onClick={() => void copyViewLink()}
            >
              Copy link
            </DropdownMenuItem>
            {dirty ? (
              <DropdownMenuItem
                className="min-h-11"
                disabled={Boolean(pendingAction) || Boolean(saveConflict)}
                onClick={resetChanges}
              >
                Reset changes
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              className="min-h-11"
              disabled={!currentWorkspace || Boolean(pendingAction)}
              onClick={() => setArchivedOpen(true)}
            >
              Archived views
              {archivedViews.length ? ` (${archivedViews.length})` : ""}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {canManageViews ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {saving ? null : (
                  <DropdownMenuItem
                    className="min-h-11"
                    disabled={savePending}
                    onClick={() => openSaveDialog(true)}
                  >
                    Save as new view…
                  </DropdownMenuItem>
                )}
                {saveTarget ? (
                  <DropdownMenuItem
                    className="min-h-11"
                    disabled={
                      Boolean(pendingAction) || dirty || Boolean(saveConflict)
                    }
                    onClick={() => openSaveDialog()}
                  >
                    Rename view…
                  </DropdownMenuItem>
                ) : null}
                {activeSaved ? (
                  <DropdownMenuItem
                    className="min-h-11"
                    disabled={savePending}
                    onClick={() => void duplicateActiveView()}
                  >
                    Duplicate view
                  </DropdownMenuItem>
                ) : null}
                {canEditSaved ? (
                  <DropdownMenuItem
                    className="min-h-11"
                    disabled={Boolean(pendingAction)}
                    onClick={() => {
                      if (currentDefault && !routedView)
                        confirmDraftDiscard(() => void setDefault());
                      else void setDefault();
                    }}
                  >
                    {currentDefault
                      ? "Clear default view"
                      : "Make default view"}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuGroup>
            </>
          ) : null}
          {canEditSaved ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  className="min-h-11"
                  disabled={Boolean(pendingAction)}
                  onClick={() => setArchiveOpen(true)}
                >
                  Archive view
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {canWriteRecords ? (
        <Button
          type="button"
          variant={saving ? "outline" : "default"}
          className="min-h-11"
          disabled={
            Boolean(pendingAction) ||
            Boolean(currentWorkspace?.fieldsHasMore) ||
            metadataLoadingMore
          }
          title={
            currentWorkspace?.fieldsHasMore
              ? "Load all fields before creating a record."
              : undefined
          }
          onClick={() => setCreateRecordOpen(true)}
        >
          <Plus aria-hidden="true" />
          New record
        </Button>
      ) : null}
      {saving && canEditSaved ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={savePending}
          onClick={() => openSaveDialog(true)}
        >
          Save as new view
        </Button>
      ) : null}
      {saving ? (
        <Button
          type="button"
          className="min-h-11"
          disabled={savePending}
          onClick={canEditSaved ? saveChanges : () => openSaveDialog(true)}
        >
          Save view
        </Button>
      ) : null}
    </>
  ) : null;
  return (
    <div className="openview-ui slim-ui flex min-h-0 min-w-0 flex-col xl:flex-1">
      <div className="shrink-0">
        <PageHeader
          title={moduleName ?? "Records"}
          description={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {meta ? <span>{meta}</span> : null}
              {dirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
              <span role="status">{status}</span>
            </span>
          }
          actions={headerActions}
        />
      </div>
      <LoadingRegion
        loading={catalogLoading && !catalog}
        label="Loading OpenView catalog…"
        className="access-fill"
        skeleton={
          <div className="flex min-w-0 flex-col gap-5">
            <ViewsToolbarSkeleton />
            <ViewsWorkspaceSkeleton />
          </div>
        }
      >
        <div className="access-fill flex min-w-0 flex-col gap-3">
          {workspaceCalendar.isError && activeLayout !== "calendar" && (
            <Alert variant="destructive">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {workspaceCalendar.data
                    ? "Regional settings could not be refreshed. The last loaded settings are still in use."
                    : "Could not load regional settings. Dates are unavailable."}
                </span>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => void workspaceCalendar.refetch()}
                >
                  Retry regional settings
                </Button>
              </div>
            </Alert>
          )}
          {currentWorkspace &&
          (currentWorkspace.fieldsHasMore || currentWorkspace.viewsHasMore) ? (
            <Alert
              role="note"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <span>
                OpenView loads metadata in bounded pages. More fields or saved
                views are available.
              </span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={Boolean(pendingAction) || metadataLoadingMore}
                onClick={() => void loadMoreModuleMetadata()}
              >
                Load more metadata
              </Button>
            </Alert>
          ) : null}

          {catalogError ? (
            <Alert
              role="alert"
              variant="destructive"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <span>
                {catalogError}
                {catalog?.length
                  ? " Previously loaded catalog data remains available."
                  : ""}
              </span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={retryCatalog}
              >
                Retry catalog
              </Button>
            </Alert>
          ) : null}
          {metadataError || fieldMetadataError ? (
            <Alert
              role="alert"
              variant="destructive"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <span>{metadataError || fieldMetadataError}</span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={
                  fieldMetadataError ? selectedFields.retry : retryMetadata
                }
              >
                Retry loading metadata
              </Button>
            </Alert>
          ) : null}
          {moduleError ? (
            <Alert
              role="alert"
              variant="destructive"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <span>
                {moduleError}
                {currentWorkspace
                  ? " Previously loaded data remains available."
                  : ""}
              </span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={refreshModule}
              >
                Retry data source
              </Button>
            </Alert>
          ) : null}
          {rowError ? (
            <Alert
              role="alert"
              variant="destructive"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <span>
                {rowError}{" "}
                {pageRows.length
                  ? "The last successful record page remains visible."
                  : "No record rows remain displayed."}
              </span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setRecordRetry((value) => value + 1)}
              >
                Retry records
              </Button>
            </Alert>
          ) : null}
          {invalidLink ? (
            <Alert
              role="alert"
              variant="warning"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <span>
                This OpenView link is unavailable or contains unsupported state.
                Return to the current workspace to clear it.
              </span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={Boolean(pendingAction)}
                onClick={recoverLink}
              >
                Return to workspace
              </Button>
            </Alert>
          ) : null}
          {deepLinkLookup?.id === requestedView &&
          deepLinkLookup.status === "loading" ? (
            <Alert role="status">Looking up the linked saved view…</Alert>
          ) : null}
          {notice ? <Alert role="status">{notice}</Alert> : null}
          {actionError ? (
            <Alert role="alert" variant="destructive">
              {actionError}
            </Alert>
          ) : null}
          {hasRecordMoves ? (
            <section
              aria-label="Unsaved record moves"
              className="bg-card border-card-edge flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border p-4"
            >
              <p className="text-sm">
                {recordMoves.size} unsaved{" "}
                {recordMoves.size === 1 ? "move" : "moves"}. Save to update the
                records.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={!canWriteRecords || Boolean(pendingAction)}
                  onClick={() => void saveRecordMoves()}
                >
                  Save changes ({recordMoves.size})
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={Boolean(pendingAction)}
                  onClick={() => {
                    replaceRecordMoves(new Map());
                    setActionError("");
                    setNotice("Record moves were discarded.");
                  }}
                >
                  Discard
                </Button>
              </div>
            </section>
          ) : null}

          <LoadingRegion
            loading={moduleLoading && !currentWorkspace}
            label="Loading fields and saved views…"
            className="access-fill"
            skeleton={<ViewsWorkspaceSkeleton />}
          >
            {moduleError && !currentWorkspace ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Data source unavailable</EmptyTitle>
                  <EmptyDescription>{moduleError}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={refreshModule}
                  >
                    Retry
                  </Button>
                </EmptyContent>
              </Empty>
            ) : !moduleName || !moduleId ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No data source selected</EmptyTitle>
                  <EmptyDescription>
                    Select an active catalog module to continue.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="access-fill flex min-w-0 flex-col gap-3">
                <AccessToolbar
                  searchLabel={`Search ${moduleName}`}
                  placeholder={`Search ${moduleName.toLowerCase()}`}
                  query={draft.definition.search ?? ""}
                  onQueryChange={(query) =>
                    updateDefinition((current) => ({
                      ...current,
                      search: query || null,
                    }))
                  }
                  searchMaxLength={240}
                  sort={quickSortValue}
                  sortOptions={[
                    ...(!quickSortFields.some(
                      (field) => field.id === firstSort?.fieldId,
                    ) && firstSort
                      ? [
                          {
                            value: quickSortValue,
                            label: "Saved sort field unavailable",
                            disabled: true,
                          },
                        ]
                      : []),
                    { value: "", label: "Default order" },
                    ...quickSortFields.flatMap((field) => [
                      {
                        value: `${field.id}:asc`,
                        label: quickSortLabel(field, "asc"),
                      },
                      {
                        value: `${field.id}:desc`,
                        label: quickSortLabel(field, "desc"),
                      },
                    ]),
                  ]}
                  onSortChange={changeQuickSort}
                  sortDisabled={Boolean(pendingAction)}
                  filtersDisabled={Boolean(pendingAction)}
                  chips={filterChips}
                  onClearFilters={() =>
                    updateDefinition((current) => ({
                      ...current,
                      filters: [],
                      deleted: "exclude",
                    }))
                  }
                  sortInFiltersBelowXl
                  quickFilters={
                    quickField && quickFilterShown ? (
                      <QuickFilter
                        field={quickField}
                        counts={quickFilterCounts}
                        value={
                          typeof quickFilterValue === "string"
                            ? quickFilterValue
                            : null
                        }
                        disabled={Boolean(pendingAction)}
                        onChange={setQuickFilter}
                      />
                    ) : null
                  }
                  actions={
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={Boolean(pendingAction)}
                        onClick={() =>
                          setViewPanel({ kind: "columns", open: true })
                        }
                      >
                        <Columns3 aria-hidden="true" />
                        Columns
                      </Button>
                      <LayoutMenu
                        layout={activeLayout}
                        disabled={Boolean(pendingAction)}
                        onLayoutChange={changeLayout}
                        onOpenSettings={() =>
                          setViewPanel({ kind: "layout", open: true })
                        }
                      />
                    </div>
                  }
                >
                  <SavedViewFilterControls
                    moduleId={moduleId}
                    logic={draft.definition.logic}
                    filters={draft.definition.filters}
                    fields={fields}
                    activeFields={activeFields}
                    rowKeyFor={filterRowKeyFor}
                    onLogicChange={(logic) =>
                      updateDefinition((current) => ({ ...current, logic }))
                    }
                    onUpdateFilter={updateFilter}
                    onRemoveFilter={removeFilter}
                    onAddFilter={addFilter}
                  />
                  <FilterSelect
                    id="openview-deleted-records"
                    label="Deleted"
                    ariaLabel="Deleted records"
                    value={draft.definition.deleted}
                    options={[
                      { value: "exclude", label: "Hide deleted records" },
                      { value: "include", label: "Show deleted records" },
                      { value: "only", label: "Show only deleted records" },
                    ]}
                    onChange={(deleted) =>
                      updateDefinition((current) => ({ ...current, deleted }))
                    }
                  />
                </AccessToolbar>

                <div className="access-fill min-w-0">
                  {generalGroupedView && !incompleteFilters ? (
                    <LiveGroupedResults
                      fieldName={groupByField?.name ?? ""}
                      range={groupRange}
                      loading={generalGroupLoading}
                      error={generalGroupError}
                      hasPage={currentGeneralGroupPage !== null}
                      groups={groupOptions}
                      pagination={groupPagination ?? null}
                      selectedGroup={generalSelectedGroup}
                      pending={Boolean(pendingAction)}
                      onRetry={() => setGeneralGroupRetry((retry) => retry + 1)}
                      onSelectGroup={(group) => {
                        setGeneralSelectedGroup(group);
                        setRecordOffset(0);
                      }}
                      onPreviousPage={() => {
                        setGeneralGroupOffset(
                          Math.max(
                            0,
                            (groupPagination?.offset ?? 0) - GROUP_PAGE_SIZE,
                          ),
                        );
                        setGeneralSelectedGroup(null);
                        setRecordOffset(0);
                      }}
                      onNextPage={() => {
                        setGeneralGroupOffset(
                          (groupPagination?.offset ?? 0) + GROUP_PAGE_SIZE,
                        );
                        setGeneralSelectedGroup(null);
                        setRecordOffset(0);
                      }}
                    />
                  ) : null}

                  {incompleteFilters ? (
                    <Alert role="alert" variant="warning">
                      {draftHasUnsafeIntegerFilter
                        ? "Correct the number condition in Filters before loading matching records."
                        : "Complete the condition in Filters before loading matching records."}
                    </Alert>
                  ) : generalGroupedView && generalGroupError ? (
                    <Alert role="alert" variant="destructive">
                      Grouped results are unavailable. Use the retry action
                      above.
                    </Alert>
                  ) : generalGroupedView && !generalSelectedGroup ? (
                    <Alert role="note">
                      Select a group to load its records.
                    </Alert>
                  ) : activeLayout === "kanban" ? (
                    groupByField && moduleId ? (
                      <LiveKanban
                        region={displayRegion}
                        key={
                          moduleId +
                          ":" +
                          JSON.stringify(normalizedDraftDefinition) +
                          ":" +
                          groupByField.id
                        }
                        moduleId={moduleId}
                        definition={normalizedDraftDefinition}
                        refreshKey={recordInvalidation}
                        groupByField={groupByField}
                        canWrite={canWriteRecords}
                        movesPending={Boolean(pendingAction)}
                        pendingMoves={recordMoves}
                        onMoveRecord={stageRecordMove}
                        fields={cardFields}
                        primaryFieldId={draft.presentation.primaryFieldId}
                        secondaryFieldId={draft.presentation.secondaryFieldId}
                        onOpenRecord={openRecordFromResults}
                      />
                    ) : (
                      <Alert role="note">
                        Choose an active queried field to load Kanban lane
                        counts.
                      </Alert>
                    )
                  ) : activeLayout === "calendar" ? (
                    moduleId && calendarDateField ? (
                      <LiveCalendar
                        region={workspaceCalendar.data}
                        workspaceCalendar={workspaceCalendar.data}
                        settingsPending={workspaceCalendar.isPending}
                        settingsError={workspaceCalendar.isError}
                        onRetrySettings={() => void workspaceCalendar.refetch()}
                        key={moduleId + ":" + selectedViewId + ":calendar"}
                        moduleId={moduleId}
                        definition={normalizedDraftDefinition}
                        dateRange={draft.presentation.dateRange}
                        refreshKey={recordInvalidation}
                        scale={draft.presentation.scale}
                        dateField={calendarDateField}
                        canWrite={
                          canWriteRecords &&
                          !interactionSuspended &&
                          !exportAccessDenied
                        }
                        movesPending={Boolean(pendingAction)}
                        pendingMoves={recordMoves}
                        onMoveDates={stageMove}
                        titleField={liveTitleField}
                        detailFields={liveDetailFields}
                        onOpenRecord={openRecordFromResults}
                      />
                    ) : (
                      <Alert role="note">
                        Choose an active queried DATE or DATETIME field to load
                        Calendar records.
                      </Alert>
                    )
                  ) : activeLayout === "timeline" ? (
                    moduleId && timelineStartField && timelineEndField ? (
                      <LiveTimeline
                        region={workspaceCalendar.data}
                        key={moduleId + ":" + selectedViewId + ":timeline"}
                        moduleId={moduleId}
                        definition={normalizedDraftDefinition}
                        dateRange={draft.presentation.dateRange}
                        refreshKey={recordInvalidation}
                        startField={timelineStartField}
                        canWrite={
                          canWriteRecords &&
                          !interactionSuspended &&
                          !exportAccessDenied
                        }
                        movesPending={Boolean(pendingAction)}
                        pendingMoves={recordMoves}
                        onMoveDates={stageMove}
                        endField={timelineEndField}
                        deadlineField={timelineDeadlineField}
                        progressField={timelineProgressField}
                        titleField={liveTitleField}
                        detailFields={liveDetailFields}
                        onOpenRecord={openRecordFromResults}
                      />
                    ) : (
                      <Alert role="note">
                        Choose active queried start and end DATE or DATETIME
                        fields to load Timeline records.
                      </Alert>
                    )
                  ) : rowError && pageRows.length === 0 ? (
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>Records could not be loaded</EmptyTitle>
                        <EmptyDescription>{rowError}</EmptyDescription>
                      </EmptyHeader>
                      <EmptyContent>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          onClick={() => setRecordRetry((value) => value + 1)}
                        >
                          Retry records
                        </Button>
                      </EmptyContent>
                    </Empty>
                  ) : rowPageLoading && pageRows.length === 0 ? (
                    <div
                      role="status"
                      className="text-muted-foreground rounded-[var(--radius)] border px-4 py-12 text-center"
                    >
                      {generalGroupedView
                        ? "Loading records in the selected group…"
                        : "Loading matching records…"}
                    </div>
                  ) : pageRows.length === 0 ? (
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>No records match this view</EmptyTitle>
                        <EmptyDescription>
                          Try a broader search or remove one of the active
                          filters.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : fields.length === 0 ? (
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>No active fields</EmptyTitle>
                        <EmptyDescription>
                          This data source has records but no active fields to
                          display.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <LiveRecordResults
                      region={displayRegion}
                      page={{
                        rows: pageRows,
                        offset: renderedRecordOffset,
                        total: currentRecordPage?.total ?? pageRows.length,
                        hasMore: currentRecordPage?.hasMore ?? false,
                        loading: rowPageLoading,
                      }}
                      cardLayout={
                        activeLayout === "grid" || activeLayout === "gallery"
                          ? activeLayout
                          : null
                      }
                      cardFields={cardFields}
                      tableFields={tableFields}
                      pinnedFieldId={pinnedField?.id ?? null}
                      presentation={draft.presentation}
                      pending={Boolean(pendingAction)}
                      pageSize={currentRecordPage?.limit ?? recordPageSize}
                      onOpenRecord={openRecordFromResults}
                      onPageIndexChange={(pageIndex) => {
                        if (rowPageLoading || pendingAction) return;
                        const pageSize =
                          currentRecordPage?.limit ?? recordPageSize;
                        setRecordOffset(pageIndex * pageSize);
                      }}
                      onPageSizeChange={changeRecordPageSize}
                    />
                  )}
                </div>

                <Dialog
                  open={viewPanel.open}
                  onOpenChange={(open) => {
                    if (!open)
                      setViewPanel((current) => ({ ...current, open: false }));
                  }}
                >
                  <DialogContent className="max-w-5xl">
                    <DialogHeader>
                      <DialogTitle>
                        {viewPanel.kind === "columns"
                          ? "Columns"
                          : "Layout settings"}
                      </DialogTitle>
                      <DialogDescription>
                        Changes are kept in this view draft until you save them.
                      </DialogDescription>
                    </DialogHeader>

                    {viewPanel.kind === "columns" ? (
                      <SavedViewColumnControls
                        layout={activeLayout}
                        fields={presentationSettingsFields}
                        visibleFields={presentationVisibleFields}
                        selectedVisibleFieldCount={
                          presentationVisibleFields.length
                        }
                        visibleFieldIds={presentationVisibleFieldIds}
                        pinnedFieldId={pinnedField?.id ?? null}
                        presentation={draft.presentation}
                        onToggleVisibility={updatePresentationFieldVisibility}
                        onTogglePinned={updatePinnedField}
                        onMove={movePresentationField}
                        onDensityChange={(density) =>
                          updatePresentation((current) => ({
                            ...current,
                            density,
                          }))
                        }
                        onCardSizeChange={(cardSize) =>
                          updatePresentation((current) => ({
                            ...current,
                            cardSize,
                          }))
                        }
                        onWrapChange={(wrap) =>
                          updatePresentation((current) => ({
                            ...current,
                            wrap,
                          }))
                        }
                      />
                    ) : null}

                    {viewPanel.kind === "layout" ? (
                      <div className="flex flex-col gap-6">
                        <Field className="max-w-sm">
                          <FieldLabel htmlFor="openview-presentation-layout">
                            Presentation layout
                          </FieldLabel>
                          <Select
                            id="openview-presentation-layout"
                            className="min-h-11"
                            value={presentationLayout}
                            onValueChange={changeLayout}
                          >
                            <option value="table">Table</option>
                            <option value="grid">Grid</option>
                            <option value="gallery">Gallery</option>
                            <option value="kanban">Kanban</option>
                            <option value="calendar">Calendar</option>
                            <option value="timeline">Timeline</option>
                          </Select>
                        </Field>
                        <SavedViewAdvancedControls
                          model={{
                            draft,
                            layout: presentationLayout,
                            layoutLabel: presentationLayoutLabel,
                            fields: {
                              all: fields,
                              queried: queriedFields,
                              groupByField,
                              dates: dateFields,
                              calendarDateField,
                              timelineStartField,
                              timelineEndField,
                              timelineDeadlineField,
                              timelineProgressField,
                            },
                            incompletePresentation,
                          }}
                          actions={{ updateDefinition, updatePresentation }}
                        />
                      </div>
                    ) : null}

                    <DialogFooter>
                      <DialogClose
                        render={
                          <Button variant="outline" className="min-h-11" />
                        }
                      >
                        Close
                      </DialogClose>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                <Dialog
                  open={isUuid(requestedRecord)}
                  dismissible={!recordEditing}
                  onOpenChange={(open) => {
                    if (!open && isUuid(requestedRecord)) returnToResults();
                  }}
                >
                  <DialogContent className="flex max-w-2xl flex-col overflow-y-hidden">
                    <DialogHeader>
                      <DialogTitle>Record details</DialogTitle>
                      <DialogDescription className="space-y-1">
                        <span className="block">
                          Showing this linked record. The saved view query
                          remains unchanged.
                        </span>
                        {activeLayout === "kanban" ? (
                          <span className="block">
                            Kanban lanes and counts continue to use the saved
                            view query.
                          </span>
                        ) : null}
                        <span className="block">
                          Details show the fields selected in this view. Editing
                          shows every field.
                        </span>
                      </DialogDescription>
                    </DialogHeader>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <LiveRecordInspector
                        region={displayRegion}
                        actions={recordEditing ? null : inspectionActions}
                        record={linkedRecord}
                        recordLoading={linkedRecordLoading}
                        recordError={ordinaryRecordPage?.error ?? ""}
                        inspectionLoading={inspectionLoading}
                        inspectionError={inspectionError}
                        fields={queriedFields}
                        primaryFieldId={draft.presentation.primaryFieldId}
                        onRetryRecord={() =>
                          setRecordRetry((value) => value + 1)
                        }
                        controls={
                          moduleId && source
                            ? {
                                moduleId,
                                departmentId: source.departmentId,
                                editableFields: fields,
                                fieldsHasMore: Boolean(
                                  currentWorkspace?.fieldsHasMore,
                                ),
                                fieldsLoadingMore: metadataLoadingMore,
                                onLoadMoreFields: () =>
                                  void loadMoreModuleMetadata(),
                                dataSources: catalog ?? [],
                                canWrite: canWriteRecords,
                                canReadHistory: canReadRecordHistory,
                                onChanged: (message) => {
                                  if (message) setNotice(message);
                                  setRecordChanges((value) => value + 1);
                                },
                                onEditingChange: setRecordEditing,
                              }
                            : undefined
                        }
                      />
                    </div>
                    {recordEditing ? null : (
                      <DialogFooter>
                        <DialogClose
                          render={
                            <Button variant="outline" className="min-h-11" />
                          }
                        >
                          Close
                        </DialogClose>
                      </DialogFooter>
                    )}
                  </DialogContent>
                </Dialog>
                {exportContext &&
                exportContext.key === exportContextKey &&
                canExport ? (
                  <ExportDialog
                    moduleId={exportContext.moduleId}
                    viewId={exportContext.viewId}
                    definition={exportContext.definition}
                    fields={exportContext.fields}
                    returnFocus={exportButtonRef}
                    onClose={() => setExportContext(null)}
                    onDownloaded={() => {
                      setExportContext(null);
                      setNotice("Export downloaded.");
                      reportDone("Export downloaded.");
                    }}
                  />
                ) : null}
                {moduleId && canWriteRecords ? (
                  <RecordCreateDialog
                    open={createRecordOpen}
                    moduleId={moduleId}
                    moduleName={moduleName ?? "this data source"}
                    fields={fields}
                    onOpenChange={setCreateRecordOpen}
                    onCreated={(created) => {
                      setCreateRecordOpen(false);
                      setNotice("Record created.");
                      setRecordChanges((value) => value + 1);
                      setInspectionContext(null);
                      setRoute({ record: created.id });
                    }}
                  />
                ) : null}
              </div>
            )}
          </LoadingRegion>

          <Dialog
            open={saveOpen}
            onOpenChange={(open) => {
              if (!pendingAction && (!saveConflict || open)) {
                setSaveOpen(open);
                setSaveError("");
              }
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {saveConflict
                    ? "Update saved view"
                    : renameTarget
                      ? "Rename view"
                      : "Save view"}
                </DialogTitle>
                <DialogDescription>
                  {renameTarget ? "Rename" : "Save"} this view for everyone who
                  can read this module in the{" "}
                  <DepartmentName
                    departmentId={source?.departmentId}
                    fallback="current"
                  />{" "}
                  department. Record access still follows each person’s access.
                </DialogDescription>
              </DialogHeader>
              {saveConflict ? (
                <Alert
                  role="alert"
                  variant="destructive"
                  className="flex flex-col gap-3"
                >
                  <p className="font-medium">
                    Another edit was saved at revision{" "}
                    {saveConflict.latest.revision}.
                  </p>
                  <p>
                    Latest saved fields changed:{" "}
                    {changedSavedViewFields(
                      saveConflict.base,
                      saveConflict.latest,
                    ).join(", ")}
                    .
                  </p>
                  <p>
                    Your local version remains open: “{saveConflict.local.name}
                    ”, local search “
                    {saveConflict.local.definition.search ?? "none"}”,{" "}
                    {saveConflict.local.definition.filters.length} filters,{" "}
                    {saveConflict.local.definition.sort.length} sort rules, and{" "}
                    {saveConflict.local.presentation.layout} layout with{" "}
                    {saveConflict.local.presentation.columnFieldIds.length}{" "}
                    columns.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={Boolean(pendingAction)}
                      onClick={reloadConflictLatest}
                    >
                      Reload latest
                    </Button>
                    <Button
                      type="button"
                      className="min-h-11"
                      disabled={
                        Boolean(pendingAction) ||
                        !saveName.trim() ||
                        incompleteFilters ||
                        incompletePresentation
                      }
                      onClick={saveMyVersionOverLatest}
                    >
                      Save my version over latest
                    </Button>
                  </div>
                </Alert>
              ) : null}
              {saveError ? (
                <Alert role="alert" variant="destructive">
                  {saveError}
                </Alert>
              ) : null}
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="openview-save-name">
                    View name
                  </FieldLabel>
                  <Input
                    id="openview-save-name"
                    className="min-h-11"
                    maxLength={200}
                    value={saveName}
                    disabled={Boolean(pendingAction)}
                    onChange={(event) => setSaveName(event.target.value)}
                  />
                </Field>
              </FieldGroup>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={Boolean(pendingAction) || Boolean(saveConflict)}
                  onClick={() => setSaveOpen(false)}
                >
                  Cancel
                </Button>
                {!saveConflict ? (
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={
                      Boolean(pendingAction) ||
                      incompleteFilters ||
                      incompletePresentation ||
                      !saveName.trim()
                    }
                    onClick={() =>
                      void saveView(
                        renameTarget ? "update" : "create",
                        saveName,
                      )
                    }
                  >
                    {pendingAction ||
                      (renameTarget ? "Rename view" : "Save view")}
                  </Button>
                ) : null}
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog
            open={archiveOpen}
            onOpenChange={(open) => {
              if (!pendingAction) {
                setArchiveOpen(open);
                setArchiveError("");
              }
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Archive saved view?</AlertDialogTitle>
                <AlertDialogDescription>
                  “{activeSaved?.name}” will move to your archived views. Its
                  records will not be changed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {archiveError ? (
                <Alert role="alert" variant="destructive">
                  {archiveError}
                </Alert>
              ) : null}
              <AlertDialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={Boolean(pendingAction)}
                  onClick={() => setArchiveOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-11"
                  disabled={!canEditSaved || Boolean(pendingAction)}
                  onClick={() => confirmDraftDiscard(() => void archiveView())}
                >
                  Archive view
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <Dialog
            open={archivedOpen}
            onOpenChange={(open) => {
              if (!pendingAction) {
                setArchivedOpen(open);
                setArchivedError("");
              }
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Archived views</DialogTitle>
                <DialogDescription>
                  Only your archived saved views can be restored here.
                </DialogDescription>
              </DialogHeader>
              {archivedError ? (
                <Alert role="alert" variant="destructive">
                  {archivedError}
                </Alert>
              ) : null}
              {archivedNotice ? (
                <Alert role="status">{archivedNotice}</Alert>
              ) : null}
              {archivedViews.length ? (
                <ul className="flex max-h-[min(24rem,60vh)] flex-col gap-2 overflow-y-auto">
                  {archivedViews.map((view) => (
                    <li
                      key={view.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                    >
                      <div>
                        <p className="font-medium">{view.name}</p>
                        <p className="text-muted-foreground text-xs">
                          Revision {view.revision}
                        </p>
                      </div>
                      {canManageViews && view.canEdit ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={Boolean(pendingAction)}
                          aria-label={`Restore ${view.name}`}
                          onClick={() =>
                            confirmDraftDiscard(() => void restoreView(view))
                          }
                        >
                          Restore {view.name}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No archived views</EmptyTitle>
                    <EmptyDescription>
                      Your archived saved views will appear here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={Boolean(pendingAction)}
                  onClick={() => setArchivedOpen(false)}
                >
                  Close
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog
            open={pendingNavigation !== null}
            onOpenChange={(open) => {
              if (!open && !pendingAction) setPendingNavigation(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {hasRecordMoves
                    ? "Discard unsaved changes?"
                    : "Discard unsaved view changes?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {hasRecordMoves
                    ? `You have ${recordMoves.size} unsaved ${recordMoves.size === 1 ? "move" : "moves"}.${dirty ? " Your current view draft also has unsaved changes." : ""} Continuing will discard them.`
                    : "Your current view draft has unsaved changes. Continuing will discard them."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={Boolean(pendingAction)}
                  onClick={() => setPendingNavigation(null)}
                >
                  Keep editing
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-11"
                  disabled={Boolean(pendingAction)}
                  onClick={() => {
                    const transition = pendingNavigation;
                    if (!transition) return;
                    if (transition.discardDraft) setDraftState(null);
                    replaceRecordMoves(new Map());
                    setPendingNavigation(null);
                    startNavigation(transition.resume);
                  }}
                >
                  Discard and continue
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </LoadingRegion>
    </div>
  );
}

export function OpenViewHeader() {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 sm:gap-4">
      <div className="min-w-0">
        <h1
          data-slot="page-title"
          className="text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          Views
        </h1>
        <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
          Explore operational records, compose reusable views, and prepare
          analytics for your team.
        </p>
      </div>
    </header>
  );
}
