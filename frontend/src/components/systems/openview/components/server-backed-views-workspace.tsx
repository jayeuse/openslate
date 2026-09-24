"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { ArrowDown, ArrowUp } from "lucide-react";
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
  setOpenViewPersonalDefault,
  unsetOpenViewPersonalDefault,
  updateOpenViewSavedView,
  type OpenViewDataSourceField,
  type OpenViewQueryDefinition,
  type OpenViewQueryFieldType,
  type OpenViewRecord,
  type OpenViewSavedView,
} from "../adapters/views-api";
import { isCalendarDateField } from "./live-calendar";
import { LiveKanban } from "./live-kanban";
import { LiveCalendar } from "./live-calendar";
import { LiveTimeline } from "./live-timeline";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
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
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import { serializeOpenViewUrl, type AudienceRef } from "../domain/model";
import { useServerViewsResource } from "../hooks/use-server-views-resource";
import { LiveRecordCards } from "./live-record-cards";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEARCHABLE_TYPES = new Set<OpenViewQueryFieldType>([
  "text",
  "long_text",
  "email",
  "url",
  "select",
]);
const EMPTY_OPERATORS = new Set(["empty", "not_empty", "blank", "not_blank"]);
const OPERATOR_LABELS: Record<OpenViewFilterOperator, string> = {
  eq: "is",
  neq: "is not",
  lt: "is before / less than",
  lte: "is on or before / at most",
  gt: "is after / greater than",
  gte: "is on or after / at least",
  contains: "contains",
  prefix: "starts with",
  suffix: "ends with",
  in: "is one of",
  empty: "is empty",
  not_empty: "is not empty",
  blank: "is blank",
  not_blank: "is not blank",
};

type SavedDraft = {
  name: string;
  audience: AudienceRef;
  definition: OpenViewQueryDefinition;
  presentation: OpenViewSavedView["presentation"];
};
type SaveConflict = {
  base: OpenViewSavedView;
  latest: OpenViewSavedView;
  local: SavedDraft;
};
type OpenViewFilterOperator =
  OpenViewQueryDefinition["filters"][number]["operator"];
type SavedViewLayout = OpenViewSavedView["presentation"]["layout"];
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
const UNSAFE_INTEGER_FILTER_ERROR =
  "Enter a whole number from -9007199254740991 to 9007199254740991.";
const GROUP_PAGE_SIZE = 12;
const GROUP_MEMBER_PAGE_SIZE = 25;

type RecordPageState = {
  moduleId: string;
  queryKey: string;
  rows: OpenViewRecord[];
  offset: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: string;
};

type RecordInspectionContext = {
  key: string;
  recordId: string;
  rows: OpenViewRecord[];
  offset: number;
  total: number;
  definition: OpenViewQueryDefinition;
  group: {
    fieldId: string;
    fieldType: OpenViewQueryFieldType;
    selected: OpenViewGroupSelector;
    offset: number;
  } | null;
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

function isGeneralGroupedLayout(layout: SavedViewLayout): boolean {
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

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function emptyDefinition(
  fields: readonly OpenViewDataSourceField[],
): OpenViewQueryDefinition {
  const columns = fields.slice(0, 100).map(({ id, type }) => ({
    fieldId: id,
    expectedType: type,
  }));
  return {
    version: 1,
    logic: "and",
    columns,
    filters: [],
    sort: [],
    deleted: "exclude",
    search: null,
    searchFields: fields
      .filter((field) => SEARCHABLE_TYPES.has(field.type))
      .slice(0, 100)
      .map(({ id, type }) => ({ fieldId: id, expectedType: type })),
  };
}

function emptyPresentation(
  fields: readonly OpenViewDataSourceField[],
): OpenViewSavedView["presentation"] {
  const columns = fields.slice(0, 8).map((field) => field.id);
  return {
    version: 1,
    layout: "table",
    columnFieldIds: columns,
    pinnedFieldIds: columns.slice(0, 1),
    density: "comfortable",
    wrap: false,
    cardSize: "comfortable",
    primaryFieldId: columns[0] ?? null,
    secondaryFieldId: columns[1] ?? null,
    dateFieldId: null,
    groupByFieldId: null,
    dateRange: "month",
    scale: null,
  };
}

function draftForView(view: OpenViewSavedView): SavedDraft {
  return {
    name: view.name,
    audience: view.audience,
    definition: view.definition,
    presentation: view.presentation,
  };
}

function upsertSavedView(
  views: OpenViewSavedView[],
  view: OpenViewSavedView,
): OpenViewSavedView[] {
  return [...views.filter((item) => item.id !== view.id), view];
}

function duplicateViewName(
  name: string,
  views: readonly OpenViewSavedView[],
): string {
  const nameCharacters = Array.from(name.trim() || "View");
  const existingNames = new Set(views.map((view) => view.name.toLowerCase()));
  for (let copyNumber = 1; ; copyNumber += 1) {
    const suffix = copyNumber === 1 ? " (copy)" : ` (copy ${copyNumber})`;
    let base = "";
    for (const character of nameCharacters) {
      if (base.length + character.length > 200 - suffix.length) break;
      base += character;
    }
    const candidate = `${base}${suffix}`;
    if (!existingNames.has(candidate.toLowerCase())) return candidate;
  }
}

function changedSavedViewFields(
  base: OpenViewSavedView,
  latest: OpenViewSavedView,
): string[] {
  const changed: string[] = [];
  if (base.name !== latest.name) changed.push("Name");
  if (JSON.stringify(base.audience) !== JSON.stringify(latest.audience))
    changed.push("Audience");
  if (JSON.stringify(base.definition) !== JSON.stringify(latest.definition))
    changed.push("Query, filters, or sort");
  if (
    base.presentation.layout !== latest.presentation.layout ||
    JSON.stringify(base.presentation.columnFieldIds) !==
      JSON.stringify(latest.presentation.columnFieldIds)
  )
    changed.push("Layout or columns");
  if (
    JSON.stringify(base.presentation) !== JSON.stringify(latest.presentation) &&
    !changed.includes("Layout or columns")
  )
    changed.push("Other presentation settings");
  return changed.length
    ? changed
    : ["Revision changed without visible field changes"];
}

function operatorChoices(
  type: OpenViewQueryFieldType,
): OpenViewFilterOperator[] {
  const common: OpenViewFilterOperator[] = [
    "eq",
    "neq",
    "empty",
    "not_empty",
    "blank",
    "not_blank",
  ];
  if (SEARCHABLE_TYPES.has(type)) {
    return type === "select"
      ? [...common, "contains", "in"]
      : [...common, "contains", "prefix", "suffix"];
  }
  if (["number", "decimal", "int", "date", "datetime"].includes(type))
    return [...common, "lt", "lte", "gt", "gte"];
  return common;
}

function isFilterOperator(
  value: string,
  type: OpenViewQueryFieldType,
): value is OpenViewFilterOperator {
  return operatorChoices(type).some((operator) => operator === value);
}

function filterValueForType(
  type: OpenViewQueryFieldType,
  value: string,
): string | number | boolean | null {
  if (type === "boolean") return value === "true";
  if (type === "decimal") return value;
  if (type === "int") {
    if (value === "") return value;
    const raw = value.trim();
    if (!/^[+-]?\d+$/.test(raw)) return value;
    const significantDigits = raw.replace(/^[+-]?0*/, "");
    if (significantDigits.length > 16) return value;
    const integerValue = Number(raw);
    return Number.isSafeInteger(integerValue) ? integerValue : value;
  }
  if (type === "number") {
    if (value === "") return value;
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : value;
  }
  return value;
}

function membershipFilterValues(
  value: OpenViewQueryDefinition["filters"][number]["value"],
): string[] {
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeFilterValues(
  definition: OpenViewQueryDefinition,
): OpenViewQueryDefinition {
  return {
    ...definition,
    filters: definition.filters.map((filter) =>
      filter.operator === "in"
        ? { ...filter, value: membershipFilterValues(filter.value) }
        : filter,
    ),
  };
}

function filterInputValue(
  filter: OpenViewQueryDefinition["filters"][number],
): string {
  if (filter.operator === "in" && Array.isArray(filter.value))
    return membershipFilterValues(filter.value).join(", ");
  return String(filter.value ?? "");
}

function hasUnsafeIntegerFilter(
  filter: OpenViewQueryDefinition["filters"][number],
): boolean {
  if (filter.expectedType !== "int") return false;
  const value = filter.value;
  if (value === null || value === undefined || value === "") return false;
  return typeof value !== "number" || !Number.isSafeInteger(value);
}

function isFilterReady(
  filter: OpenViewQueryDefinition["filters"][number],
): boolean {
  if (EMPTY_OPERATORS.has(filter.operator)) return true;
  if (filter.operator === "in")
    return membershipFilterValues(filter.value).length > 0;
  if (Array.isArray(filter.value)) return false;
  return (
    filter.value !== null && filter.value !== undefined && filter.value !== ""
  );
}

function recordValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return "—";
}

function audienceValue(audience: AudienceRef): string {
  if (audience.kind === "private" || audience.kind === "everyone")
    return audience.kind;
  return `${audience.kind}:${audience.id}`;
}

function parseAudience(value: string): AudienceRef {
  if (value === "everyone") return { kind: "everyone" };
  if (value.startsWith("role:"))
    return { kind: "role", id: value.slice("role:".length) };
  if (value.startsWith("identity:"))
    return { kind: "identity", id: value.slice("identity:".length) };
  return { kind: "private" };
}

export default function ServerBackedViewsWorkspace({
  invalidUrl,
}: {
  invalidUrl: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedModule = searchParams.get("module");
  const requestedView = searchParams.get("view");
  const requestedRecord = searchParams.get("record");
  const resource = useServerViewsResource(requestedModule);
  const {
    catalog,
    catalogHasMore,
    catalogLoading,
    catalogError,
    audiences,
    roleOptionsHasMore,
    userOptionsHasMore,
    moduleId,
    moduleWorkspace,
    setModuleWorkspace,
    moduleLoading,
    moduleError,
    metadataLoadingMore,
    metadataError,
    retryMetadata,
    loadMoreCatalog,
    loadMoreModuleMetadata,
    loadMoreAudienceOptions,
    refreshModule,
    retryCatalog,
  } = resource;
  const [recordPage, setRecordPage] = useState<RecordPageState | null>(null);
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
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveAudience, setSaveAudience] = useState("private");
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
    router.replace(
      serializeOpenViewUrl({ section: "views", module: moduleId }) as Route,
      { scroll: false },
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
  const fields = currentWorkspace?.fields ?? [];
  const source = catalog?.find((item) => item.id === moduleId);
  const moduleName = source?.name;
  const defaultViewId = currentWorkspace?.defaults.find(
    (item) => item.moduleId === moduleId,
  )?.viewId;
  const routedView = isUuid(requestedView) ? requestedView : undefined;
  const explicitUnsavedSelection = Boolean(
    moduleId && explicitUnsavedModules.has(moduleId),
  );
  const selectedViewId =
    routedView ?? (explicitUnsavedSelection ? undefined : defaultViewId) ?? "";
  const draftKey = `${moduleId ?? ""}:${selectedViewId}`;
  const [recordPagePosition, setRecordPagePosition] = useState(() => ({
    key: draftKey,
    offset: 0,
  }));
  const recordOffset =
    recordPagePosition.key === draftKey ? recordPagePosition.offset : 0;
  const setRecordOffset = (offset: number) =>
    setRecordPagePosition({ key: draftKey, offset });
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
      audience: { kind: "private" },
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
        offset: recordOffset,
      }),
    [moduleId, recordOffset, requestDefinition],
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
      offset: previous?.moduleId === moduleId ? previous.offset : 0,
      total: previous?.moduleId === moduleId ? previous.total : 0,
      hasMore: previous?.moduleId === moduleId ? previous.hasMore : false,
      loading: true,
      error: "",
    }));
    void queryOpenViewRecords({
      moduleId,
      definition: requestDefinition,
      limit: 25,
      offset: isUuid(requestedRecord) ? 0 : recordOffset,
    })
      .then((result) => {
        if (request !== recordRequest.current) return;
        setRecordPage({
          moduleId,
          queryKey,
          rows: result.items,
          offset: result.pagination.offset,
          total: result.pagination.total,
          hasMore: result.pagination.hasMore,
          loading: false,
          error: "",
        });
      })
      .catch((error: unknown) => {
        if (request !== recordRequest.current) return;
        setRecordPage((previous) => ({
          moduleId,
          queryKey,
          rows: previous?.moduleId === moduleId ? previous.rows : [],
          offset: previous?.moduleId === moduleId ? previous.offset : 0,
          total: previous?.moduleId === moduleId ? previous.total : 0,
          hasMore: previous?.moduleId === moduleId ? previous.hasMore : false,
          loading: false,
          error: messageFor(error, "Records could not be loaded."),
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
    recordRetry,
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
      limit: GROUP_MEMBER_PAGE_SIZE,
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
          error: messageFor(error, "Grouped records could not be loaded."),
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
    recordOffset,
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
  const cardLayout =
    presentationLayout === "grid" || presentationLayout === "gallery"
      ? presentationLayout
      : null;
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
  const currentDefault = defaultViewId === activeSaved?.id;
  const canEditSaved = Boolean(activeSaved?.canEdit);
  const archivedViews = moduleViews.filter(
    (view) => view.isDeleted && view.canEdit,
  );
  const roleOptions = audiences.filter((item) => item.kind === "role");
  const userOptions = audiences.filter((item) => item.kind === "identity");
  const saveTarget = canEditSaved ? activeSaved : undefined;
  const setRoute = useCallback(
    (
      patch: {
        module?: string | undefined;
        view?: string | undefined;
        record?: string | undefined;
      },
      replace = false,
    ) => {
      const target = serializeOpenViewUrl({
        section: "views",
        module: patch.module === undefined ? moduleId : patch.module,
        view: Object.hasOwn(patch, "view")
          ? patch.view
          : selectedViewId || undefined,
        record: Object.hasOwn(patch, "record")
          ? patch.record
          : isUuid(requestedRecord)
            ? requestedRecord
            : undefined,
      });
      if (replace) router.replace(target as Route, { scroll: false });
      else router.push(target as Route, { scroll: false });
    },
    [moduleId, requestedRecord, router, selectedViewId],
  );

  const openRecordFromResults = (recordId: string) => {
    if (
      moduleId &&
      currentRecordPage &&
      !currentRecordPage.loading &&
      !currentRecordPage.error &&
      currentRecordPage.rows.some((row) => row.id === recordId)
    ) {
      setInspectionContext({
        key: inspectionKey,
        recordId,
        rows: currentRecordPage.rows,
        offset: currentRecordPage.offset,
        total: currentRecordPage.total,
        definition: normalizedDraftDefinition,
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
    const offset =
      direction > 0 ? context.offset + 25 : Math.max(0, context.offset - 25);
    setInspectionLoading(true);
    setInspectionError("");
    try {
      const page = context.group
        ? await queryOpenViewGroupedRecords({
            moduleId,
            definition: context.definition,
            groupBy: {
              fieldId: context.group.fieldId,
              expectedType: context.group.fieldType,
            },
            selectedGroup: context.group.selected,
            groupLimit: GROUP_PAGE_SIZE,
            groupOffset: context.group.offset,
            limit: GROUP_MEMBER_PAGE_SIZE,
            offset,
          })
        : await queryOpenViewRecords({
            moduleId,
            definition: context.definition,
            limit: 25,
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
    if (activeInspectionContext)
      setRecordOffset(activeInspectionContext.offset);
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
      router.push(href, { scroll: false });
    };
    if (dirty) setPendingNavigation({ href, resume, discardDraft: true });
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
      if (pendingAction) return false;
      if (!dirty) return true;
      if (
        typeof window !== "undefined" &&
        new URL(href, window.location.origin).href === window.location.href
      )
        return true;
      setPendingNavigation({ href, resume, discardDraft: true });
      return false;
    },
    [dirty, pendingAction, setPendingNavigation],
  );
  useWorkspaceNavigationGuard(navigationGuard);

  const confirmDraftDiscard = (resume: () => void) => {
    if (!dirtyRef.current) {
      resume();
      return;
    }
    setPendingNavigation({
      href: typeof window === "undefined" ? "/openview" : window.location.href,
      resume,
      discardDraft: false,
    });
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
    dirtyRef.current = JSON.stringify(next) !== JSON.stringify(baseDraft);
    setDraftState({ key: draftKey, value: next });
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
    audience: AudienceRef,
    resolveConflict = false,
  ) => {
    if (
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
              audience,
              definition: normalizeFilterValues(draft.definition),
              presentation: draft.presentation,
            })
          : await createOpenViewSavedView({
              moduleId,
              name: cleanName,
              audience,
              definition: normalizeFilterValues(draft.definition),
              presentation: draft.presentation,
            });
      const changedDuringSave = submittedRevision !== editRevision.current;
      acceptSavedView(saved, !changedDuringSave);
      setSaveConflict(null);
      if (!changedDuringSave) {
        setDraftState({
          key: `${saved.moduleId}:${saved.id}`,
          value: draftForView(saved),
        });
        setSaveOpen(false);
        setNotice(`“${saved.name}” was saved.`);
      } else {
        setNotice(
          `“${saved.name}” was saved. Your newer edits remain open as an unsaved draft.`,
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
            local: { ...local, name: cleanName, audience },
          });
          setSaveName(cleanName);
          setSaveAudience(audienceValue(audience));
          setSaveError("");
          setActionError("");
        } catch (refreshError) {
          setSaveError(
            `${messageFor(refreshError, "The latest saved view could not be reloaded.")} Your local edits remain open.`,
          );
        }
      } else {
        setSaveError(
          messageFor(
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
    void saveView("update", activeSaved.name, activeSaved.audience);
  };

  const openSaveDialog = () => {
    if (saveConflict) {
      setSaveOpen(true);
      return;
    }
    setSaveError("");
    setSaveName(saveTarget?.name ?? "");
    setSaveAudience(audienceValue(saveTarget?.audience ?? { kind: "private" }));
    setSaveOpen(true);
  };

  const reloadConflictLatest = () => {
    if (!saveConflict) return;
    const { latest } = saveConflict;
    const latestDraft = draftForView(latest);
    setDraftState({
      key: `${latest.moduleId}:${latest.id}`,
      value: latestDraft,
    });
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
    void saveView(
      "update",
      saveName.trim() || saveConflict.local.name,
      parseAudience(saveAudience),
      true,
    );
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
        isDeleted: true,
        revision: activeSaved.revision + 1,
      };
      setModuleWorkspace((previous) => {
        if (!previous || previous.moduleId !== activeSaved.moduleId)
          return previous;
        return {
          ...previous,
          views: upsertSavedView(previous.views, archivedView),
          defaults: previous.defaults.filter(
            (entry) => entry.viewId !== activeSaved.id,
          ),
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
        messageFor(error, "The saved view could not be archived."),
      );
    } finally {
      setPendingAction("");
    }
  };

  const restoreView = async (view: OpenViewSavedView) => {
    if (!view.canEdit || pendingAction) return;
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
        messageFor(error, "The saved view could not be restored."),
      );
    } finally {
      setPendingAction("");
    }
  };

  const setDefault = async () => {
    if (!activeSaved || pendingAction) return;
    setActionError("");
    setPendingAction(
      currentDefault
        ? "Clearing personal default…"
        : "Setting personal default…",
    );
    try {
      if (currentDefault) {
        await unsetOpenViewPersonalDefault(activeSaved.moduleId);
        setModuleWorkspace((previous) =>
          previous && previous.moduleId === activeSaved.moduleId
            ? {
                ...previous,
                defaults: previous.defaults.filter(
                  (item) => item.moduleId !== activeSaved.moduleId,
                ),
              }
            : previous,
        );
        if (!routedView) setDraftState(null);
        setNotice("The personal default was cleared.");
      } else {
        const nextDefault = await setOpenViewPersonalDefault({
          moduleId: activeSaved.moduleId,
          viewId: activeSaved.id,
        });
        setModuleWorkspace((previous) =>
          previous && previous.moduleId === activeSaved.moduleId
            ? {
                ...previous,
                defaults: [
                  ...previous.defaults.filter(
                    (item) => item.moduleId !== activeSaved.moduleId,
                  ),
                  nextDefault,
                ],
              }
            : previous,
        );
        setNotice(`“${activeSaved.name}” is your personal default view.`);
      }
    } catch (error) {
      setActionError(
        messageFor(error, "The personal default could not be changed."),
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
        audience: { kind: "private" },
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
      setDraftState({
        key: `${duplicated.moduleId}:${duplicated.id}`,
        value: nextDraft,
      });
      draftRef.current = nextDraft;
      dirtyRef.current =
        JSON.stringify(nextDraft) !== JSON.stringify(draftForView(duplicated));
      setRoute(
        { module: duplicated.moduleId, view: duplicated.id, record: undefined },
        true,
      );
      setNotice(`“${duplicated.name}” was duplicated.`);
    } catch (error) {
      setActionError(
        messageFor(
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

  if (catalogLoading && !catalog) {
    return (
      <div role="status" className="text-muted-foreground py-16 text-center">
        Loading OpenView catalog…
      </div>
    );
  }

  if (!catalogError && catalog?.length === 0) {
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <OpenViewHeader />
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No active data sources</EmptyTitle>
            <EmptyDescription>
              OpenView needs an active catalog module before it can query
              records or save a view.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const rowPageLoading = currentRecordPage?.loading ?? false;
  const rowError = currentRecordPage?.error ?? "";
  const linkedRecordLoading = Boolean(
    isUuid(requestedRecord) &&
    (!ordinaryRecordPage || ordinaryRecordPage.loading),
  );
  const linkedRecord =
    isUuid(requestedRecord) && !linkedRecordLoading && !rowError
      ? (pageRows.find((row) => row.id === requestedRecord) ?? null)
      : null;
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
      <Button
        type="button"
        variant="ghost"
        className="min-h-11"
        onClick={returnToResults}
      >
        Return to results
      </Button>
    </div>
  ) : null;
  const linkedRecordPreview = isUuid(requestedRecord) ? (
    <section
      aria-label="Linked record"
      className="bg-card min-w-0 overflow-hidden rounded-[var(--radius)] border"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <h2 className="font-medium">Linked record</h2>
        {inspectionActions}
      </div>
      {inspectionLoading ? (
        <p role="status" className="text-muted-foreground px-4 py-2 text-sm">
          Loading adjacent records…
        </p>
      ) : null}
      {inspectionError ? (
        <p role="alert" className="text-destructive px-4 py-2 text-sm">
          {inspectionError}
        </p>
      ) : null}
      {linkedRecord ? (
        <LiveRecordCards
          layout="gallery"
          rows={[linkedRecord]}
          fields={cardFields}
          primaryFieldId={draft.presentation.primaryFieldId}
          secondaryFieldId={draft.presentation.secondaryFieldId}
          cardSize={draft.presentation.cardSize}
          wrap={draft.presentation.wrap}
          onOpenRecord={(recordId) => setRoute({ record: recordId })}
        />
      ) : rowError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p role="alert" className="text-destructive text-sm">
            {rowError}
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => setRecordRetry((value) => value + 1)}
          >
            Retry linked record
          </Button>
        </div>
      ) : linkedRecordLoading ? (
        <p role="status" className="text-muted-foreground px-4 py-6 text-sm">
          Loading linked record…
        </p>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>This record is unavailable</EmptyTitle>
            <EmptyDescription>
              The record may have been removed or may not be visible to you.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </section>
  ) : null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <OpenViewHeader />
      <header className="bg-card flex flex-wrap items-end justify-between gap-3 rounded-[var(--radius)] border p-4 sm:p-5">
        <div className="min-w-0 flex-1 sm:max-w-sm">
          <Field>
            <FieldLabel htmlFor="openview-data-source">Data source</FieldLabel>
            <Select
              id="openview-data-source"
              className="min-h-11"
              value={moduleId ?? ""}
              disabled={!catalog?.length || Boolean(pendingAction)}
              onValueChange={(next) => {
                if (!isUuid(next) || next === moduleId) return;
                const href = serializeOpenViewUrl({
                  section: "views",
                  module: next,
                }) as Route;
                if (dirty)
                  setPendingNavigation({
                    href,
                    resume: () => router.push(href),
                    discardDraft: true,
                  });
                else router.push(href, { scroll: false });
              }}
            >
              {(catalog ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <p className="text-muted-foreground mt-2 text-xs">
            {moduleName ?? "Data source"} · {fields.length} active fields
          </p>
          {catalogHasMore ? (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 px-0"
              disabled={Boolean(pendingAction) || metadataLoadingMore}
              onClick={() => void loadMoreCatalog()}
            >
              Load more data sources
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Field className="min-w-56 flex-1 sm:flex-none">
            <FieldLabel htmlFor="openview-saved-view">Saved view</FieldLabel>
            <Select
              id="openview-saved-view"
              className="min-h-11"
              value={activeSaved?.id ?? ""}
              disabled={!currentWorkspace || Boolean(pendingAction)}
              onValueChange={selectSavedView}
            >
              <option value="">Unsaved view</option>
              {moduleViews
                .filter((view) => !view.isDeleted)
                .map((view) => (
                  <option key={view.id} value={view.id}>
                    {view.name}
                    {view.id === defaultViewId ? " · default" : ""}
                  </option>
                ))}
            </Select>
          </Field>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 self-end"
            disabled={!currentWorkspace || Boolean(pendingAction)}
            onClick={() => setArchivedOpen(true)}
          >
            Archived views
            {archivedViews.length ? ` (${archivedViews.length})` : ""}
          </Button>
        </div>
      </header>

      {currentWorkspace &&
      (currentWorkspace.fieldsHasMore ||
        currentWorkspace.viewsHasMore ||
        currentWorkspace.defaultsHasMore) ? (
        <Alert
          role="note"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <span>
            OpenView loads metadata in bounded pages. More fields, saved views,
            or defaults are available.
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
          variant="warning"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <span>
            {catalogError} Previously loaded catalog data remains available.
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
      {metadataError ? (
        <Alert
          role="alert"
          variant="warning"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <span>{metadataError}</span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={retryMetadata}
          >
            Retry loading metadata
          </Button>
        </Alert>
      ) : null}
      {moduleError ? (
        <Alert
          role="alert"
          variant="warning"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <span>{moduleError} Previously loaded data remains available.</span>
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
      {moduleLoading || rowPageLoading || metadataLoadingMore ? (
        <Alert role="status" className="text-sm">
          {metadataLoadingMore
            ? "Loading more catalog metadata…"
            : pendingAction ||
              (moduleLoading
                ? "Refreshing saved views and fields…"
                : "Refreshing records…")}
        </Alert>
      ) : null}
      {pendingAction && !moduleLoading && !rowPageLoading ? (
        <Alert role="status" className="text-sm">
          {pendingAction} Navigation and conflicting actions are paused until it
          finishes.
        </Alert>
      ) : null}
      {rowError ? (
        <Alert
          role="alert"
          variant="warning"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <span>
            {rowError} The last successful record page remains visible.
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
        <Alert role="alert" variant="warning">
          {actionError}
        </Alert>
      ) : null}

      {moduleLoading && !currentWorkspace ? (
        <div
          role="status"
          className="text-muted-foreground rounded-[var(--radius)] border px-4 py-12 text-center"
        >
          Loading fields and saved views…
        </div>
      ) : moduleError && !currentWorkspace ? (
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
      ) : !moduleName ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No data source selected</EmptyTitle>
            <EmptyDescription>
              Select an active catalog module to continue.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <section
            className="bg-card flex min-w-0 flex-col gap-4 rounded-[var(--radius)] border p-4 sm:p-5"
            aria-label="View controls"
          >
            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)]">
              <Field>
                <FieldLabel htmlFor="openview-search">
                  Search {moduleName}
                </FieldLabel>
                <Input
                  id="openview-search"
                  className="min-h-11"
                  maxLength={240}
                  placeholder={`Search ${moduleName.toLowerCase()}…`}
                  value={draft.definition.search ?? ""}
                  onChange={(event) =>
                    updateDefinition((current) => ({
                      ...current,
                      search: event.target.value || null,
                    }))
                  }
                />
              </Field>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">
                    {presentationLayoutLabel} layout
                    {!isLiveRecordLayout(presentationLayout) ? " pending" : ""}
                  </Badge>
                  {activeSaved ? (
                    <Badge variant="outline">
                      Revision {activeSaved.revision}
                    </Badge>
                  ) : null}
                  {dirty ? (
                    <Badge variant="outline">Unsaved changes</Badge>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {dirty ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={Boolean(pendingAction) || Boolean(saveConflict)}
                      onClick={resetChanges}
                    >
                      Reset changes
                    </Button>
                  ) : null}
                  {canEditSaved && dirty ? (
                    <Button
                      type="button"
                      className="min-h-11"
                      disabled={
                        Boolean(pendingAction) ||
                        incompleteFilters ||
                        incompletePresentation ||
                        Boolean(saveConflict)
                      }
                      onClick={saveChanges}
                    >
                      Save changes
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant={canEditSaved && dirty ? "outline" : "default"}
                    className="min-h-11"
                    disabled={
                      Boolean(pendingAction) ||
                      incompleteFilters ||
                      incompletePresentation
                    }
                    onClick={openSaveDialog}
                  >
                    {saveTarget ? "Save view" : "Save view as"}
                  </Button>
                  {activeSaved ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={
                        Boolean(pendingAction) ||
                        Boolean(saveConflict) ||
                        incompleteFilters ||
                        incompletePresentation
                      }
                      onClick={() => void duplicateActiveView()}
                    >
                      Duplicate view
                    </Button>
                  ) : null}
                  {activeSaved ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={Boolean(pendingAction)}
                      onClick={() => {
                        if (currentDefault && !routedView)
                          confirmDraftDiscard(() => void setDefault());
                        else void setDefault();
                      }}
                    >
                      {currentDefault
                        ? "Clear my default"
                        : "Set as my default"}
                    </Button>
                  ) : null}
                  {canEditSaved ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={Boolean(pendingAction)}
                      onClick={() => setArchiveOpen(true)}
                    >
                      Archive view
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-end justify-between gap-3">
              <Field className="w-full max-w-56">
                <FieldLabel htmlFor="openview-presentation-layout">
                  Presentation layout
                </FieldLabel>
                <Select
                  id="openview-presentation-layout"
                  className="min-h-11"
                  value={presentationLayout}
                  aria-describedby="openview-presentation-layout-help"
                  onValueChange={(value) => {
                    if (!isLiveRecordLayout(value)) return;
                    updatePresentation((current) => ({
                      ...current,
                      layout: value,
                    }));
                  }}
                >
                  {!isLiveRecordLayout(presentationLayout) ? (
                    <option value={presentationLayout} disabled>
                      {presentationLayoutLabel} (pending)
                    </option>
                  ) : null}
                  <option value="table">Table</option>
                  <option value="grid">Grid</option>
                  <option value="gallery">Gallery</option>
                  <option value="kanban">Kanban</option>
                  <option value="calendar">Calendar</option>
                  <option value="timeline">Timeline</option>
                </Select>
              </Field>
              <p
                id="openview-presentation-layout-help"
                className="text-muted-foreground max-w-prose text-sm"
              >
                Table, Grid, Gallery, Kanban, Calendar, and Timeline load
                authorized server records.
              </p>
            </div>

            <details className="rounded-md border p-3">
              <summary className="min-h-11 cursor-pointer py-2 font-medium">
                Advanced query settings
              </summary>
              <div className="flex flex-col gap-4 border-t pt-4">
                {isGeneralGroupedLayout(presentationLayout) ? (
                  <section
                    aria-labelledby="openview-presentation-fields-heading"
                    className="flex min-w-0 flex-col gap-3"
                  >
                    <div>
                      <h3
                        id="openview-presentation-fields-heading"
                        className="font-medium"
                      >
                        {presentationLayout === "table"
                          ? "Visible columns and order"
                          : "Card detail fields"}
                      </h3>
                      <p className="text-muted-foreground text-sm">
                        {presentationLayout === "table"
                          ? "Choose the table columns and order. Keep one visible; a pinned column stays first while you scroll horizontally."
                          : "Choose the extra fields shown on cards and their order. The primary and secondary fields stay in the card heading."}
                      </p>
                    </div>
                    {presentationSettingsFields.length ? (
                      <div className="divide-y rounded-[var(--radius)] border">
                        {presentationSettingsFields.map((field) => {
                          const visible = presentationVisibleFieldIds.has(
                            field.id,
                          );
                          const index = presentationVisibleFields.findIndex(
                            (candidate) => candidate.id === field.id,
                          );
                          const pinnedIndex = pinnedField
                            ? presentationVisibleFields.findIndex(
                                (candidate) => candidate.id === pinnedField.id,
                              )
                            : -1;
                          const cannotMoveUp =
                            presentationLayout === "table" &&
                            pinnedField !== undefined &&
                            pinnedIndex >= 0 &&
                            field.id !== pinnedField.id &&
                            index - 1 === pinnedIndex;
                          const cannotMoveDown =
                            presentationLayout === "table" &&
                            pinnedIndex >= 0 &&
                            (field.id === pinnedField?.id ||
                              index + 1 === pinnedIndex);
                          return (
                            <div
                              key={field.id}
                              className="grid min-w-0 gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto] sm:items-center"
                            >
                              <Field className="min-h-11 flex-row items-center gap-3">
                                <Checkbox
                                  id={`openview-column-${field.id}`}
                                  checked={visible}
                                  disabled={
                                    (presentationLayout === "table" &&
                                      visible &&
                                      presentationVisibleFields.length <= 1) ||
                                    (!visible && visibleFields.length >= 20)
                                  }
                                  onCheckedChange={(checked) =>
                                    updatePresentationFieldVisibility(
                                      field.id,
                                      checked === true,
                                    )
                                  }
                                />
                                <FieldLabel
                                  htmlFor={`openview-column-${field.id}`}
                                  className="font-normal"
                                >
                                  Show {field.name}
                                </FieldLabel>
                              </Field>
                              {presentationLayout === "table" ? (
                                <Field className="min-h-11 flex-row items-center gap-3">
                                  <Checkbox
                                    id={`openview-pin-${field.id}`}
                                    checked={draft.presentation.pinnedFieldIds.includes(
                                      field.id,
                                    )}
                                    disabled={!visible}
                                    onCheckedChange={(checked) =>
                                      updatePinnedField(
                                        field.id,
                                        checked === true,
                                      )
                                    }
                                  />
                                  <FieldLabel
                                    htmlFor={`openview-pin-${field.id}`}
                                    className="font-normal"
                                  >
                                    Pin {field.name}
                                  </FieldLabel>
                                </Field>
                              ) : null}
                              <div className="flex items-center gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="size-11"
                                  disabled={
                                    !visible || index <= 0 || cannotMoveUp
                                  }
                                  aria-label={`Move ${field.name} up`}
                                  onClick={() =>
                                    movePresentationField(field.id, -1)
                                  }
                                >
                                  <ArrowUp aria-hidden="true" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="size-11"
                                  disabled={
                                    !visible ||
                                    index ===
                                      presentationVisibleFields.length - 1 ||
                                    cannotMoveDown
                                  }
                                  aria-label={`Move ${field.name} down`}
                                  onClick={() =>
                                    movePresentationField(field.id, 1)
                                  }
                                >
                                  <ArrowDown aria-hidden="true" />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p role="note" className="text-muted-foreground text-sm">
                        Add fields to the view query before configuring its
                        columns or card details.
                      </p>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
                      {presentationLayout === "table" ? (
                        <Field className="w-full max-w-72">
                          <FieldLabel htmlFor="openview-row-density">
                            Row density
                          </FieldLabel>
                          <Select
                            id="openview-row-density"
                            className="min-h-11"
                            value={draft.presentation.density}
                            onValueChange={(density) => {
                              if (
                                density === "comfortable" ||
                                density === "compact"
                              )
                                updatePresentation((current) => ({
                                  ...current,
                                  density,
                                }));
                            }}
                          >
                            <option value="comfortable">Comfortable</option>
                            <option value="compact">Compact</option>
                          </Select>
                        </Field>
                      ) : (
                        <Field className="w-full max-w-72">
                          <FieldLabel htmlFor="openview-card-size">
                            Card size
                          </FieldLabel>
                          <Select
                            id="openview-card-size"
                            className="min-h-11"
                            value={draft.presentation.cardSize}
                            onValueChange={(cardSize) => {
                              if (
                                cardSize === "comfortable" ||
                                cardSize === "compact"
                              )
                                updatePresentation((current) => ({
                                  ...current,
                                  cardSize,
                                }));
                            }}
                          >
                            <option value="comfortable">Comfortable</option>
                            <option value="compact">Compact</option>
                          </Select>
                        </Field>
                      )}
                      <Field className="min-h-11 flex-row items-center justify-between gap-3">
                        <div className="flex flex-col gap-1">
                          <FieldLabel htmlFor="openview-wrap-long-text">
                            Wrap long text
                          </FieldLabel>
                          <p
                            id="openview-wrap-long-text-help"
                            className="text-muted-foreground text-sm"
                          >
                            Keep full values visible when space is tight.
                          </p>
                        </div>
                        <Checkbox
                          id="openview-wrap-long-text"
                          aria-describedby="openview-wrap-long-text-help"
                          checked={draft.presentation.wrap}
                          onCheckedChange={(checked) =>
                            updatePresentation((current) => ({
                              ...current,
                              wrap: checked === true,
                            }))
                          }
                        />
                      </Field>
                    </div>
                  </section>
                ) : null}

                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="font-medium">Sort order</h3>
                      <p className="text-muted-foreground text-xs">
                        The first rule has the highest priority. Use up to three
                        rules.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={
                        draft.definition.sort.length >= 3 ||
                        fields.every((field) =>
                          draft.definition.sort.some(
                            (sort) => sort.fieldId === field.id,
                          ),
                        )
                      }
                      onClick={() => {
                        const unused = fields.find(
                          (field) =>
                            !draft.definition.sort.some(
                              (sort) => sort.fieldId === field.id,
                            ),
                        );
                        if (!unused || draft.definition.sort.length >= 3)
                          return;
                        updateDefinition((current) => ({
                          ...current,
                          sort: [
                            ...current.sort,
                            {
                              fieldId: unused.id,
                              expectedType: unused.type,
                              direction: "asc",
                            },
                          ],
                        }));
                      }}
                    >
                      Add sort rule
                    </Button>
                  </div>
                  {draft.definition.sort.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      Records keep their source order.
                    </p>
                  ) : null}
                  {draft.definition.sort.map((sort, index) => (
                    <div
                      key={`${sort.fieldId}:${index}`}
                      className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto] sm:items-end"
                    >
                      <Field>
                        <FieldLabel htmlFor={`openview-sort-field-${index}`}>
                          Sort field {index + 1}
                        </FieldLabel>
                        <Select
                          id={`openview-sort-field-${index}`}
                          className="min-h-11"
                          value={sort.fieldId}
                          onValueChange={(fieldId) => {
                            const field = fields.find(
                              (candidate) => candidate.id === fieldId,
                            );
                            if (
                              !field ||
                              draft.definition.sort.some(
                                (entry, entryIndex) =>
                                  entryIndex !== index &&
                                  entry.fieldId === field.id,
                              )
                            )
                              return;
                            updateDefinition((current) => ({
                              ...current,
                              sort: current.sort.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? {
                                      ...entry,
                                      fieldId: field.id,
                                      expectedType: field.type,
                                    }
                                  : entry,
                              ),
                            }));
                          }}
                        >
                          {!fields.some(
                            (field) => field.id === sort.fieldId,
                          ) ? (
                            <option value={sort.fieldId} disabled>
                              Saved sort field unavailable
                            </option>
                          ) : null}
                          {fields.map((field) => (
                            <option
                              key={field.id}
                              value={field.id}
                              disabled={draft.definition.sort.some(
                                (entry, entryIndex) =>
                                  entryIndex !== index &&
                                  entry.fieldId === field.id,
                              )}
                            >
                              {field.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel
                          htmlFor={`openview-sort-direction-${index}`}
                        >
                          Sort direction {index + 1}
                        </FieldLabel>
                        <Select
                          id={`openview-sort-direction-${index}`}
                          className="min-h-11"
                          value={sort.direction}
                          onValueChange={(direction) => {
                            if (direction !== "asc" && direction !== "desc")
                              return;
                            updateDefinition((current) => ({
                              ...current,
                              sort: current.sort.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? { ...entry, direction }
                                  : entry,
                              ),
                            }));
                          }}
                        >
                          <option value="asc">Ascending (A → Z)</option>
                          <option value="desc">Descending (Z → A)</option>
                        </Select>
                      </Field>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-11"
                        aria-label={`Remove sort rule ${index + 1}`}
                        onClick={() =>
                          updateDefinition((current) => ({
                            ...current,
                            sort: current.sort.filter(
                              (_, entryIndex) => entryIndex !== index,
                            ),
                          }))
                        }
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                </div>

                {isGeneralGroupedLayout(presentationLayout) ? (
                  <div className="flex flex-wrap items-end gap-3">
                    <Field className="w-full max-w-72">
                      <FieldLabel htmlFor="openview-general-group-field">
                        Group records by
                      </FieldLabel>
                      <Select
                        id="openview-general-group-field"
                        className="min-h-11"
                        value={draft.presentation.groupByFieldId ?? ""}
                        onValueChange={(value) =>
                          updatePresentation((current) => ({
                            ...current,
                            groupByFieldId: value || null,
                          }))
                        }
                      >
                        {draft.presentation.groupByFieldId && !groupByField ? (
                          <option
                            value={draft.presentation.groupByFieldId}
                            disabled
                          >
                            Saved field unavailable
                          </option>
                        ) : null}
                        <option value="">No grouping</option>
                        {queriedFields.map((field) => (
                          <option key={field.id} value={field.id}>
                            {field.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <p className="text-muted-foreground max-w-prose text-sm">
                      Counts come from the server. Select a group to load its
                      paged records.
                    </p>
                    {draft.presentation.groupByFieldId && !groupByField ? (
                      <p role="note" className="text-muted-foreground text-sm">
                        The saved grouping field is unavailable; records are
                        shown without grouping.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {(presentationLayout === "calendar" ||
                  presentationLayout === "timeline") &&
                draft.presentation.groupByFieldId ? (
                  <p role="note" className="text-muted-foreground text-sm">
                    General grouping is inactive in {presentationLayoutLabel};
                    the saved group field is preserved.
                  </p>
                ) : null}
              </div>
            </details>

            {presentationLayout === "kanban" ? (
              <div className="flex flex-wrap items-end gap-3">
                <Field className="w-full max-w-72">
                  <FieldLabel htmlFor="openview-kanban-group-field">
                    Group lanes by
                  </FieldLabel>
                  <Select
                    id="openview-kanban-group-field"
                    className="min-h-11"
                    value={draft.presentation.groupByFieldId ?? ""}
                    aria-describedby="openview-kanban-group-field-help"
                    onValueChange={(value) =>
                      updatePresentation((current) => ({
                        ...current,
                        groupByFieldId: value || null,
                      }))
                    }
                  >
                    {draft.presentation.groupByFieldId && !groupByField ? (
                      <option
                        value={draft.presentation.groupByFieldId}
                        disabled
                      >
                        Saved field unavailable
                      </option>
                    ) : null}
                    <option value="">Choose a queried field</option>
                    {queriedFields.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <p
                  id="openview-kanban-group-field-help"
                  className="text-muted-foreground max-w-prose text-sm"
                >
                  Lane counts are server-provided. Only one lane’s bounded page
                  of records is loaded at a time.
                </p>
              </div>
            ) : null}
            {presentationLayout === "calendar" ? (
              <div className="flex flex-wrap items-end gap-3">
                <Field className="w-full max-w-72">
                  <FieldLabel htmlFor="openview-calendar-date-field">
                    Calendar date field
                  </FieldLabel>
                  <Select
                    id="openview-calendar-date-field"
                    className="min-h-11"
                    value={draft.presentation.dateFieldId ?? ""}
                    onValueChange={(value) =>
                      updatePresentation((current) => ({
                        ...current,
                        dateFieldId: value || null,
                      }))
                    }
                  >
                    {draft.presentation.dateFieldId && !calendarDateField ? (
                      <option value={draft.presentation.dateFieldId} disabled>
                        Saved date field unavailable
                      </option>
                    ) : null}
                    <option value="">Choose a queried date field</option>
                    {dateFields.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name} · {field.type}
                      </option>
                    ))}
                  </Select>
                </Field>
                <p className="text-muted-foreground max-w-prose text-sm">
                  Calendar dates are queried as workspace-local days. Choose an
                  active date or datetime field in this view.
                </p>
              </div>
            ) : null}
            {presentationLayout === "timeline" ? (
              <div className="flex flex-wrap items-end gap-3">
                <Field className="w-full max-w-72">
                  <FieldLabel htmlFor="openview-timeline-start-field">
                    Timeline start field
                  </FieldLabel>
                  <Select
                    id="openview-timeline-start-field"
                    className="min-h-11"
                    value={draft.presentation.timelineStartFieldId ?? ""}
                    onValueChange={(value) =>
                      updatePresentation((current) => ({
                        ...current,
                        timelineStartFieldId: value || null,
                      }))
                    }
                  >
                    {draft.presentation.timelineStartFieldId &&
                    !timelineStartField ? (
                      <option
                        value={draft.presentation.timelineStartFieldId}
                        disabled
                      >
                        Saved start field unavailable
                      </option>
                    ) : null}
                    <option value="">Choose a queried date field</option>
                    {dateFields.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name} · {field.type}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field className="w-full max-w-72">
                  <FieldLabel htmlFor="openview-timeline-end-field">
                    Timeline end field
                  </FieldLabel>
                  <Select
                    id="openview-timeline-end-field"
                    className="min-h-11"
                    value={draft.presentation.timelineEndFieldId ?? ""}
                    onValueChange={(value) =>
                      updatePresentation((current) => ({
                        ...current,
                        timelineEndFieldId: value || null,
                      }))
                    }
                  >
                    {draft.presentation.timelineEndFieldId &&
                    !timelineEndField ? (
                      <option
                        value={draft.presentation.timelineEndFieldId}
                        disabled
                      >
                        Saved end field unavailable
                      </option>
                    ) : null}
                    <option value="">Choose a queried date field</option>
                    {dateFields.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name} · {field.type}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field className="w-full max-w-72">
                  <FieldLabel htmlFor="openview-timeline-deadline-field">
                    Deadline field (optional)
                  </FieldLabel>
                  <Select
                    id="openview-timeline-deadline-field"
                    className="min-h-11"
                    value={draft.presentation.timelineDeadlineFieldId ?? ""}
                    onValueChange={(value) =>
                      updatePresentation((current) => ({
                        ...current,
                        timelineDeadlineFieldId: value || null,
                      }))
                    }
                  >
                    {draft.presentation.timelineDeadlineFieldId &&
                    !timelineDeadlineField ? (
                      <option
                        value={draft.presentation.timelineDeadlineFieldId}
                        disabled
                      >
                        Saved deadline field unavailable
                      </option>
                    ) : null}
                    <option value="">No deadline</option>
                    {dateFields.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name} · {field.type}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field className="w-full max-w-72">
                  <FieldLabel htmlFor="openview-timeline-progress-field">
                    Progress field (optional)
                  </FieldLabel>
                  <Select
                    id="openview-timeline-progress-field"
                    className="min-h-11"
                    value={draft.presentation.timelineProgressFieldId ?? ""}
                    onValueChange={(value) =>
                      updatePresentation((current) => ({
                        ...current,
                        timelineProgressFieldId: value || null,
                      }))
                    }
                  >
                    {draft.presentation.timelineProgressFieldId &&
                    !timelineProgressField ? (
                      <option
                        value={draft.presentation.timelineProgressFieldId}
                        disabled
                      >
                        Saved progress field unavailable
                      </option>
                    ) : null}
                    <option value="">No progress</option>
                    {queriedFields
                      .filter((field) =>
                        ["number", "decimal", "int"].includes(field.type),
                      )
                      .map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.name} · {field.type}
                        </option>
                      ))}
                  </Select>
                </Field>
                <p className="text-muted-foreground max-w-prose text-sm">
                  Timeline bars use the complete start/end interval. The visible
                  window only clips the bar and filters matching intervals.
                </p>
              </div>
            ) : null}
            {incompletePresentation ? (
              <Alert role="note">
                {presentationLayout === "kanban"
                  ? "Choose an active queried field for Kanban lanes before saving this presentation."
                  : presentationLayout === "calendar"
                    ? "Choose an active queried date or datetime field before saving this Calendar presentation."
                    : presentationLayout === "timeline"
                      ? "Choose active queried start and end date fields, and clear any unavailable optional fields, before saving this Timeline presentation."
                      : "Complete the saved presentation fields before saving."}
              </Alert>
            ) : null}

            <details className="rounded-md border p-3">
              <summary className="min-h-11 cursor-pointer py-2 font-medium">
                Filters ({draft.definition.filters.length})
              </summary>
              <div className="flex flex-col gap-4 border-t pt-4">
                <Field className="max-w-xs">
                  <FieldLabel htmlFor="openview-filter-logic">
                    Match filters
                  </FieldLabel>
                  <Select
                    id="openview-filter-logic"
                    className="min-h-11"
                    value={draft.definition.logic}
                    onValueChange={(value) => {
                      if (value === "and" || value === "or")
                        updateDefinition((current) => ({
                          ...current,
                          logic: value,
                        }));
                    }}
                  >
                    <option value="and">All conditions (AND)</option>
                    <option value="or">Any condition (OR)</option>
                  </Select>
                </Field>
                {draft.definition.filters.map((filter, index) => {
                  const field = activeFields.get(filter.fieldId);
                  const operators = operatorChoices(filter.expectedType);
                  const needsValue = !EMPTY_OPERATORS.has(filter.operator);
                  const unsafeIntegerValue = hasUnsafeIntegerFilter(filter);
                  const valueErrorId = `openview-filter-value-error-${index}`;
                  return (
                    <div
                      key={filterRowKeyFor(filter, index)}
                      className="bg-muted/40 grid min-w-0 gap-3 rounded-md p-3 sm:grid-cols-[minmax(8rem,1fr)_minmax(9rem,1fr)_minmax(8rem,1fr)_auto]"
                    >
                      <Field>
                        <FieldLabel htmlFor={`openview-filter-field-${index}`}>
                          Field
                        </FieldLabel>
                        <Select
                          id={`openview-filter-field-${index}`}
                          className="min-h-11"
                          value={filter.fieldId}
                          onValueChange={(fieldId) => {
                            const nextField = activeFields.get(fieldId);
                            if (!nextField) return;
                            const expectedType = nextField.type;
                            const nextOperator =
                              operatorChoices(expectedType)[0] ?? "eq";
                            updateDefinition((current) => ({
                              ...current,
                              filters: updateFilterAtIndex(
                                current.filters,
                                index,
                                () => ({
                                  fieldId,
                                  expectedType,
                                  operator: nextOperator,
                                  value: EMPTY_OPERATORS.has(nextOperator)
                                    ? null
                                    : "",
                                }),
                              ),
                            }));
                          }}
                        >
                          {fields.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel
                          htmlFor={`openview-filter-operator-${index}`}
                        >
                          Condition
                        </FieldLabel>
                        <Select
                          id={`openview-filter-operator-${index}`}
                          className="min-h-11"
                          value={filter.operator}
                          onValueChange={(operator) => {
                            if (
                              !isFilterOperator(operator, filter.expectedType)
                            )
                              return;
                            updateDefinition((current) => ({
                              ...current,
                              filters: updateFilterAtIndex(
                                current.filters,
                                index,
                                (item) => ({
                                  ...item,
                                  operator,
                                  value: EMPTY_OPERATORS.has(operator)
                                    ? null
                                    : operator === "in" ||
                                        item.operator === "in"
                                      ? ""
                                      : (item.value ?? ""),
                                }),
                              ),
                            }));
                          }}
                        >
                          {operators.map((operator) => (
                            <option key={operator} value={operator}>
                              {OPERATOR_LABELS[operator] ?? operator}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      {needsValue ? (
                        <Field>
                          <FieldLabel
                            htmlFor={`openview-filter-value-${index}`}
                          >
                            Value
                          </FieldLabel>
                          {filter.expectedType === "boolean" ? (
                            <Select
                              id={`openview-filter-value-${index}`}
                              className="min-h-11"
                              value={String(filter.value ?? "")}
                              onValueChange={(value) =>
                                updateDefinition((current) => ({
                                  ...current,
                                  filters: updateFilterAtIndex(
                                    current.filters,
                                    index,
                                    (item) => ({
                                      ...item,
                                      value:
                                        value === "" ? "" : value === "true",
                                    }),
                                  ),
                                }))
                              }
                            >
                              <option value="">Choose…</option>
                              <option value="true">True</option>
                              <option value="false">False</option>
                            </Select>
                          ) : (
                            <>
                              <Input
                                id={`openview-filter-value-${index}`}
                                className="min-h-11"
                                aria-invalid={unsafeIntegerValue || undefined}
                                aria-describedby={
                                  unsafeIntegerValue ? valueErrorId : undefined
                                }
                                type={
                                  filter.expectedType === "date"
                                    ? "date"
                                    : ["number", "decimal", "int"].includes(
                                          filter.expectedType,
                                        )
                                      ? "number"
                                      : "text"
                                }
                                value={filterInputValue(filter)}
                                onChange={(event) =>
                                  updateDefinition((current) => ({
                                    ...current,
                                    filters: updateFilterAtIndex(
                                      current.filters,
                                      index,
                                      (item) => ({
                                        ...item,
                                        value:
                                          item.operator === "in"
                                            ? event.target.value
                                            : filterValueForType(
                                                item.expectedType,
                                                event.target.value,
                                              ),
                                      }),
                                    ),
                                  }))
                                }
                              />
                              {unsafeIntegerValue ? (
                                <p
                                  id={valueErrorId}
                                  role="alert"
                                  className="text-destructive text-sm"
                                >
                                  {UNSAFE_INTEGER_FILTER_ERROR}
                                </p>
                              ) : null}
                            </>
                          )}
                        </Field>
                      ) : (
                        <div aria-hidden="true" />
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 self-end"
                        aria-label={`Remove filter ${index + 1}`}
                        onClick={() =>
                          updateDefinition((current) => {
                            const keys = new Map<object, string>();
                            current.filters.forEach((item, itemIndex) => {
                              if (itemIndex !== index)
                                keys.set(
                                  item,
                                  filterRowKeyFor(item, itemIndex),
                                );
                            });
                            setFilterRowKeyState({ draftKey, keys });
                            return {
                              ...current,
                              filters: current.filters.filter(
                                (_, itemIndex) => itemIndex !== index,
                              ),
                            };
                          })
                        }
                      >
                        Remove
                      </Button>
                      {!isFilterReady(filter) ? (
                        <p className="text-destructive col-span-full text-sm">
                          Complete this condition or remove it before saving.
                        </p>
                      ) : null}
                      {!field ? (
                        <p className="text-destructive col-span-full text-sm">
                          This saved filter refers to an unavailable field.
                          Remove it before saving.
                        </p>
                      ) : null}
                    </div>
                  );
                })}
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 self-start"
                  disabled={
                    fields.length === 0 || draft.definition.filters.length >= 10
                  }
                  onClick={() => {
                    const field = fields[0];
                    if (!field) return;
                    updateDefinition((current) => {
                      const newFilter: OpenViewQueryDefinition["filters"][number] =
                        {
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
                      return {
                        ...current,
                        filters: [...current.filters, newFilter],
                      };
                    });
                  }}
                >
                  Add filter
                </Button>
              </div>
            </details>

            {!isLiveRecordLayout(presentationLayout) ? (
              <Alert role="note">
                <p className="font-medium">
                  {presentationLayoutLabel} layout is saved
                </p>
                <p className="mt-1">
                  {presentationLayoutLabel} rendering is pending. The saved
                  presentation stays intact; records appear in a Table preview
                  until a supported layout is selected.
                </p>
              </Alert>
            ) : null}
          </section>

          {isUuid(requestedRecord) ? (
            <Alert
              role="status"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <span>
                {presentationLayout === "kanban"
                  ? "This linked record is shown separately; Kanban lanes and counts continue to use the saved view query."
                  : "Showing this linked record. The saved view query remains unchanged."}
              </span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={returnToResults}
              >
                Return to results
              </Button>
            </Alert>
          ) : null}

          {generalGroupedView && !incompleteFilters ? (
            <section
              aria-label="Grouping results"
              className="bg-card min-w-0 overflow-hidden rounded-[var(--radius)] border"
            >
              <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
                <div>
                  <h2 className="font-medium">
                    Groups by {groupByField?.name}
                  </h2>
                  <p className="text-muted-foreground text-sm">
                    Counts include all matching records. Only the selected
                    group’s page of records is loaded.
                  </p>
                </div>
                <p aria-live="polite" className="text-muted-foreground text-sm">
                  {generalGroupLoading ? "Loading groups…" : groupRange}
                </p>
              </div>

              {generalGroupError ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                  <p role="alert">{generalGroupError}</p>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={generalGroupLoading || Boolean(pendingAction)}
                    onClick={() => setGeneralGroupRetry((retry) => retry + 1)}
                  >
                    {generalSelectedGroup
                      ? "Retry group records"
                      : "Retry groups"}
                  </Button>
                </div>
              ) : null}

              {generalGroupLoading && !currentGeneralGroupPage ? (
                <p
                  role="status"
                  className="text-muted-foreground px-4 py-8 text-center"
                >
                  Loading groups…
                </p>
              ) : currentGeneralGroupPage?.groups.length ? (
                <ul
                  aria-label="View groups"
                  className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                >
                  {currentGeneralGroupPage.groups.map((group) => {
                    const selector = groupSelectorForValue(group.value);
                    const label = groupName(group.value, group.label);
                    const selected =
                      groupSelectorKey(selector) ===
                      groupSelectorKey(generalSelectedGroup);
                    return (
                      <li key={groupSelectorKey(selector)} className="min-w-0">
                        <button
                          type="button"
                          aria-pressed={selected}
                          aria-label={`${label}, ${group.count} records`}
                          className={`focus-visible:ring-ring flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-[var(--radius)] border px-3 py-2 text-left focus-visible:ring-2 ${selected ? "border-primary bg-primary/5" : "bg-background hover:bg-muted/50"}`}
                          disabled={Boolean(pendingAction)}
                          onClick={() => {
                            setGeneralSelectedGroup(selector);
                            setRecordOffset(0);
                          }}
                        >
                          <span className="truncate font-medium">{label}</span>
                          <span className="text-muted-foreground shrink-0 text-sm">
                            {group.count}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : currentGeneralGroupPage ? (
                <p className="text-muted-foreground px-4 py-8 text-center">
                  No groups match this view.
                </p>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
                <p aria-live="polite" className="text-muted-foreground text-sm">
                  {groupRange}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={
                      !groupPagination ||
                      groupPagination.offset === 0 ||
                      generalGroupLoading ||
                      Boolean(generalGroupError) ||
                      Boolean(pendingAction)
                    }
                    onClick={() => {
                      setGeneralGroupOffset(
                        Math.max(
                          0,
                          (groupPagination?.offset ?? 0) - GROUP_PAGE_SIZE,
                        ),
                      );
                      setGeneralSelectedGroup(null);
                      setRecordOffset(0);
                    }}
                  >
                    Previous groups
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={
                      !groupPagination?.hasMore ||
                      generalGroupLoading ||
                      Boolean(generalGroupError) ||
                      Boolean(pendingAction)
                    }
                    onClick={() => {
                      setGeneralGroupOffset(
                        (groupPagination?.offset ?? 0) + GROUP_PAGE_SIZE,
                      );
                      setGeneralSelectedGroup(null);
                      setRecordOffset(0);
                    }}
                  >
                    Next groups
                  </Button>
                </div>
              </div>
            </section>
          ) : null}

          {isUuid(requestedRecord) &&
          presentationLayout !== "kanban" &&
          presentationLayout !== "calendar" &&
          presentationLayout !== "timeline" ? (
            linkedRecordPreview
          ) : incompleteFilters ? (
            isUuid(requestedRecord) ? (
              linkedRecordPreview
            ) : (
              <Alert role="alert" variant="warning">
                {draftHasUnsafeIntegerFilter
                  ? "Correct the integer filter above before loading matching records."
                  : "Complete the filter above before loading matching records."}
              </Alert>
            )
          ) : generalGroupedView && generalGroupError ? (
            <Alert role="status">
              Grouped results are unavailable. Use the retry action above.
            </Alert>
          ) : generalGroupedView && !generalSelectedGroup ? (
            <Alert role="note">Select a group to load its records.</Alert>
          ) : presentationLayout === "kanban" ? (
            groupByField && moduleId ? (
              <>
                {inspectionActions ? (
                  <div className="bg-card rounded-[var(--radius)] border p-3">
                    {inspectionActions}
                  </div>
                ) : null}
                <LiveKanban
                  key={`${moduleId}:${JSON.stringify(normalizedDraftDefinition)}:${groupByField.id}`}
                  moduleId={moduleId}
                  definition={normalizedDraftDefinition}
                  groupByFieldId={groupByField.id}
                  groupByFieldType={groupByField.type}
                  fields={cardFields}
                  primaryFieldId={draft.presentation.primaryFieldId}
                  secondaryFieldId={draft.presentation.secondaryFieldId}
                  linkedRecordRequested={isUuid(requestedRecord)}
                  linkedRecord={linkedRecord}
                  linkedRecordLoading={linkedRecordLoading}
                  linkedRecordError={isUuid(requestedRecord) ? rowError : ""}
                  onOpenRecord={(recordId) => setRoute({ record: recordId })}
                  onRetryLinkedRecord={() =>
                    setRecordRetry((value) => value + 1)
                  }
                />
              </>
            ) : (
              <Alert role="note">
                Choose an active queried field to load Kanban lane counts.
              </Alert>
            )
          ) : presentationLayout === "calendar" ? (
            <>
              {moduleId && calendarDateField ? (
                <LiveCalendar
                  key={`${moduleId}:${selectedViewId}:calendar`}
                  moduleId={moduleId}
                  definition={normalizedDraftDefinition}
                  dateRange={draft.presentation.dateRange}
                  dateField={calendarDateField}
                  titleField={liveTitleField}
                  detailFields={liveDetailFields}
                  onOpenRecord={(recordId) => setRoute({ record: recordId })}
                />
              ) : (
                <Alert role="note">
                  Choose an active queried DATE or DATETIME field to load
                  Calendar records.
                </Alert>
              )}
              {linkedRecordPreview}
            </>
          ) : presentationLayout === "timeline" ? (
            <>
              {moduleId && timelineStartField && timelineEndField ? (
                <LiveTimeline
                  key={`${moduleId}:${selectedViewId}:timeline`}
                  moduleId={moduleId}
                  definition={normalizedDraftDefinition}
                  dateRange={draft.presentation.dateRange}
                  startField={timelineStartField}
                  endField={timelineEndField}
                  deadlineField={timelineDeadlineField}
                  progressField={timelineProgressField}
                  titleField={liveTitleField}
                  detailFields={liveDetailFields}
                  onOpenRecord={(recordId) => setRoute({ record: recordId })}
                />
              ) : (
                <Alert role="note">
                  Choose active queried start and end DATE or DATETIME fields to
                  load Timeline records.
                </Alert>
              )}
              {linkedRecordPreview}
            </>
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
                <EmptyTitle>
                  {isUuid(requestedRecord)
                    ? "This record is unavailable"
                    : "No records match this view"}
                </EmptyTitle>
                <EmptyDescription>
                  {isUuid(requestedRecord)
                    ? "The record may have been removed or may not be visible to you."
                    : "Try a broader search or remove one of the active filters."}
                </EmptyDescription>
              </EmptyHeader>
              {isUuid(requestedRecord) ? (
                <EmptyContent>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={recoverLink}
                  >
                    Return to workspace
                  </Button>
                </EmptyContent>
              ) : null}
            </Empty>
          ) : fields.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No active fields</EmptyTitle>
                <EmptyDescription>
                  This data source has records but no active fields to display.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <section
              className="bg-card min-w-0 overflow-hidden rounded-[var(--radius)] border"
              aria-label="Record results"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                <div>
                  <h2 className="font-medium">
                    {activeSaved?.name ?? "Unsaved view"}
                  </h2>
                  <p className="text-muted-foreground text-sm">
                    {currentRecordPage?.total ?? pageRows.length}{" "}
                    {generalGroupedView && generalSelectedGroup
                      ? "records in selected group"
                      : "matching records"}{" "}
                    · live workspace data
                  </p>
                </div>
                <p className="text-muted-foreground text-xs">
                  {cardLayout
                    ? `${presentationLayoutLabel} layout`
                    : isLiveRecordLayout(presentationLayout)
                      ? "Table layout"
                      : `${presentationLayoutLabel} rendering pending · Table preview`}
                </p>
              </div>
              {rowPageLoading && pageRows.length > 0 ? (
                <p
                  role="status"
                  className="text-muted-foreground border-b px-4 py-2 text-sm"
                >
                  Updating matching records. The last loaded page remains
                  visible.
                </p>
              ) : null}
              <div className="overflow-x-auto">
                {cardLayout ? (
                  <LiveRecordCards
                    layout={cardLayout}
                    rows={pageRows}
                    fields={cardFields}
                    primaryFieldId={draft.presentation.primaryFieldId}
                    secondaryFieldId={draft.presentation.secondaryFieldId}
                    cardSize={draft.presentation.cardSize}
                    wrap={draft.presentation.wrap}
                    onOpenRecord={openRecordFromResults}
                  />
                ) : (
                  <table className="w-full min-w-[36rem] text-left text-sm">
                    <thead className="bg-muted/50 text-muted-foreground">
                      <tr>
                        {tableFields.map((field) => (
                          <th
                            key={field.id}
                            scope="col"
                            className={`px-4 py-3 font-medium ${field.id === pinnedField?.id ? "bg-muted/50 sticky left-0 z-20" : ""}`}
                          >
                            {field.name}
                          </th>
                        ))}
                        <th scope="col" className="px-4 py-3 font-medium">
                          Updated
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {pageRows.map((row) => (
                        <tr key={row.id}>
                          {tableFields.map((field, index) => (
                            <td
                              key={field.id}
                              className={`max-w-80 px-4 align-top ${draft.presentation.density === "compact" ? "py-1.5" : "py-3"} ${draft.presentation.wrap ? "break-words whitespace-normal" : "whitespace-nowrap"} ${field.id === pinnedField?.id ? "bg-card sticky left-0 z-10" : ""}`}
                            >
                              {index === 0 ? (
                                <button
                                  type="button"
                                  className="text-primary focus-visible:ring-ring min-h-11 text-left font-medium underline-offset-4 hover:underline focus-visible:ring-2"
                                  onClick={() => openRecordFromResults(row.id)}
                                >
                                  {recordValue(row.data[field.id])}
                                </button>
                              ) : (
                                recordValue(row.data[field.id])
                              )}
                            </td>
                          ))}
                          <td
                            className={`text-muted-foreground px-4 align-top ${draft.presentation.density === "compact" ? "py-1.5" : "py-3"}`}
                          >
                            {new Intl.DateTimeFormat("en", {
                              dateStyle: "medium",
                            }).format(new Date(row.updatedAt))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
                <p aria-live="polite" className="text-muted-foreground text-sm">
                  Showing {renderedRecordOffset + 1}–
                  {renderedRecordOffset + pageRows.length} of{" "}
                  {currentRecordPage?.total ?? pageRows.length}{" "}
                  {generalGroupedView && generalSelectedGroup
                    ? "records in selected group"
                    : "matching records"}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={
                      renderedRecordOffset === 0 ||
                      rowPageLoading ||
                      Boolean(pendingAction)
                    }
                    onClick={() =>
                      setRecordOffset(Math.max(0, renderedRecordOffset - 25))
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={
                      !currentRecordPage?.hasMore ||
                      rowPageLoading ||
                      Boolean(pendingAction)
                    }
                    onClick={() => setRecordOffset(renderedRecordOffset + 25)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </section>
          )}
        </>
      )}

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
              {saveTarget ? "Update saved view" : "Save view"}
            </DialogTitle>
            <DialogDescription>
              Save this query for reuse. Audience settings control who can see
              it; record access remains governed by workspace permissions.
            </DialogDescription>
          </DialogHeader>
          {saveConflict ? (
            <Alert
              role="alert"
              variant="warning"
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
                Your local version remains open: “{saveConflict.local.name}”,{" "}
                local search “{saveConflict.local.definition.search ?? "none"}”,{" "}
                {saveConflict.local.definition.filters.length} filters,{" "}
                {saveConflict.local.definition.sort.length} sort rules, and{" "}
                {saveConflict.local.presentation.layout} layout with{" "}
                {saveConflict.local.presentation.columnFieldIds.length} columns.
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
              <FieldLabel htmlFor="openview-save-name">View name</FieldLabel>
              <Input
                id="openview-save-name"
                className="min-h-11"
                maxLength={200}
                value={saveName}
                disabled={Boolean(pendingAction)}
                onChange={(event) => setSaveName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="openview-save-audience">Audience</FieldLabel>
              <Select
                id="openview-save-audience"
                className="min-h-11"
                value={saveAudience}
                disabled={Boolean(pendingAction)}
                onValueChange={setSaveAudience}
              >
                <option value="private">Only me</option>
                <option value="everyone">Everyone</option>
                {roleOptions.map((item) => (
                  <option key={item.id} value={`role:${item.id}`}>
                    Role: {item.label}
                  </option>
                ))}
                {userOptions.map((item) => (
                  <option key={item.id} value={`identity:${item.id}`}>
                    User: {item.label}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldGroup>
          {roleOptionsHasMore || userOptionsHasMore ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={Boolean(pendingAction) || metadataLoadingMore}
              onClick={() => void loadMoreAudienceOptions()}
            >
              Load more audience options
            </Button>
          ) : null}
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
                    saveTarget ? "update" : "create",
                    saveName,
                    parseAudience(saveAudience),
                  )
                }
              >
                {pendingAction || (saveTarget ? "Update view" : "Save view")}
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
            <Alert role="alert" variant="warning">
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
            <Alert role="alert" variant="warning">
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
            <AlertDialogTitle>Discard unsaved view changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your current view draft has unsaved changes. Continuing will
              discard them.
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
                setPendingNavigation(null);
                transition.resume();
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

function OpenViewHeader() {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 sm:gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          OpenView
        </h1>
        <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
          Explore operational records, compose reusable views, and prepare
          analytics for your team.
        </p>
      </div>
    </header>
  );
}
