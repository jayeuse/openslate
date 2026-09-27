"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { ChevronDown, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import { ApiError } from "@/lib/api";
import {
  archiveOpenViewDashboard,
  createOpenViewDashboard,
  getOpenViewDashboard,
  getOpenViewDashboardDefault,
  getOpenViewDashboardConflict,
  listOpenViewDashboards,
  restoreOpenViewDashboard,
  setOpenViewDashboardDefault,
  updateOpenViewDashboard,
  type OpenViewDashboard,
  type OpenViewDashboardAggregateConfig,
  type OpenViewDashboardChartConfig,
  type OpenViewDashboardRecordsConfig,
  type OpenViewDashboardRefreshCadence,
  type OpenViewDashboardWidgetType,
  type OpenViewDashboardWidget,
} from "../adapters/dashboards-api";
import { queryOpenViewAggregateSnapshot } from "../adapters/analytics-api";
import {
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  queryOpenViewRecords,
  type OpenViewDataSource,
  type OpenViewDataSourceField,
  type OpenViewQueryDefinition,
} from "../adapters/views-api";
import { parseOpenViewUrl, serializeOpenViewUrl } from "../domain/model";
import {
  DASHBOARD_PAGE_SIZE,
  configSignature,
  draftWidgetsFrom,
  inputWidgets,
  type DashboardWidgetData,
  type DraftWidget,
  type SnapshotState,
} from "../domain/dashboard-draft";
import { DashboardWidgetResults } from "./dashboard-widget-results";

const CATEGORICAL_FIELD_TYPES = new Set([
  "text",
  "long_text",
  "email",
  "url",
  "select",
  "boolean",
]);
const NUMERIC_FIELD_TYPES = new Set(["int", "number", "decimal"]);
const DATE_RANGE_DAY_MS = 86_400_000;

type BuilderChartType = OpenViewDashboardChartConfig["chartType"];
type BuilderAggregation =
  OpenViewDashboardAggregateConfig["query"]["aggregation"];
type PendingNavigation = {
  href: string;
  resume: () => void;
} | null;
type DashboardDialogKind = "new" | "settings" | null;

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function widgetTitle(
  widget: OpenViewDashboardWidget | DraftWidget,
  fieldsByModule: Record<string, OpenViewDataSourceField[]>,
): string {
  if (widget.widgetType === "records") {
    const fieldId = widget.config.query.definition.columns[0]?.fieldId;
    const field = fieldId
      ? fieldsByModule[widget.config.query.moduleId]?.find(
          (candidate) => candidate.id === fieldId,
        )
      : undefined;
    return field ? `Records showing ${field.name}` : "Live records";
  }
  if (widget.widgetType === "summary" || widget.widgetType === "workload") {
    const { query } = widget.config;
    const field = fieldsByModule[query.moduleId]?.find(
      (candidate) => candidate.id === query.dimension.fieldId,
    );
    return widget.widgetType === "summary"
      ? `Total records by ${field?.name ?? "selected field"}`
      : `Workload by ${field?.name ?? "selected field"}`;
  }
  const { query } = widget.config;
  const { aggregation } = query;
  const operation =
    aggregation === "average"
      ? "Average"
      : aggregation === "sum"
        ? "Sum"
        : "Count";
  const measureFieldId = query.measure?.fieldId;
  const measure = measureFieldId
    ? fieldsByModule[query.moduleId]?.find(
        (candidate) => candidate.id === measureFieldId,
      )
    : undefined;
  const measureLabel = measureFieldId
    ? ` of ${measure?.name ?? "selected measure"}`
    : "";
  if (query.mode === "date_series")
    return `${operation}${measureLabel} over time`;
  const field = fieldsByModule[query.moduleId]?.find(
    (candidate) =>
      candidate.id ===
      (
        query as Extract<
          OpenViewDashboardChartConfig["query"],
          { mode: "groups" }
        >
      ).dimension.fieldId,
  );
  return `${operation}${measureLabel} by ${field?.name ?? "selected field"}`;
}

function isCategoricalField(field: OpenViewDataSourceField): boolean {
  return CATEGORICAL_FIELD_TYPES.has(field.type);
}

function isDateField(
  field: OpenViewDataSourceField,
): field is OpenViewDataSourceField & { type: "date" | "datetime" } {
  return field.type === "date" || field.type === "datetime";
}

function inclusiveDateRangeDays(
  fromDate: string,
  toDate: string,
): number | null {
  const parseDate = (value: string): number | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    ) {
      return null;
    }
    return date.getTime();
  };
  const from = parseDate(fromDate);
  const to = parseDate(toDate);
  if (from === null || to === null || to < from) return null;
  return Math.floor((to - from) / DATE_RANGE_DAY_MS) + 1;
}

function loadDashboardWidgetData(
  widget: DraftWidget,
  recordOffset: number,
  pageSize: number,
): Promise<DashboardWidgetData> {
  if (widget.widgetType === "records") {
    return queryOpenViewRecords({
      moduleId: widget.config.query.moduleId,
      definition: widget.config.query.definition,
      limit: pageSize,
      offset: recordOffset,
    }).then((result) => ({ kind: "records", result }));
  }
  return queryOpenViewAggregateSnapshot(widget.config.query).then((result) => ({
    kind: "aggregate",
    result,
  }));
}

function dashboardSnapshotSignature(
  widget: DraftWidget | undefined,
  page: number,
  pageSize: number,
): string {
  const signature = configSignature(widget, page);
  return widget?.widgetType === "records"
    ? JSON.stringify({ signature, pageSize })
    : signature;
}

function lastValidDashboardPage(
  currentPage: number,
  itemCount: number,
  pageSize: number,
): number {
  return Math.min(
    currentPage,
    Math.max(0, Math.ceil(itemCount / pageSize) - 1),
  );
}

function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && [401, 403].includes(error.status);
}

export default function ServerBackedDashboards() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlState = parseOpenViewUrl(`${pathname}?${searchParams.toString()}`);
  const routeDashboardId =
    urlState.section === "dashboards" ? urlState.dashboard : undefined;
  const [dashboards, setDashboards] = useState<OpenViewDashboard[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [dashboardListLoading, setDashboardListLoading] = useState(true);
  const [dashboardListError, setDashboardListError] = useState("");
  const [dashboardListHasMore, setDashboardListHasMore] = useState(false);
  const [dashboardListLoadingMore, setDashboardListLoadingMore] =
    useState(false);
  const [dashboardListRefresh, setDashboardListRefresh] = useState(0);
  const [pendingNavigation, setPendingNavigation] =
    useState<PendingNavigation>(null);
  const [selectedDashboard, setSelectedDashboard] =
    useState<OpenViewDashboard | null>(null);
  const [dashboardDialogKind, setDashboardDialogKind] =
    useState<DashboardDialogKind>(null);
  const [widgetDialogOpen, setWidgetDialogOpen] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [routeClearPending, setRouteClearPending] = useState(false);
  const [dashboardError, setDashboardError] = useState("");
  const [notice, setNotice] = useState("");
  const [dashboardName, setDashboardName] = useState("");
  const [refreshCadence, setRefreshCadence] =
    useState<OpenViewDashboardRefreshCadence>("manual");
  const [draftWidgets, setDraftWidgets] = useState<DraftWidget[]>([]);
  const [activeWidgetKey, setActiveWidgetKey] = useState("");
  const [savePending, setSavePending] = useState(false);
  const [duplicatePending, setDuplicatePending] = useState(false);
  const [archivePending, setArchivePending] = useState(false);
  const [restorePendingId, setRestorePendingId] = useState("");
  const [dashboardDefaultId, setDashboardDefaultId] = useState<string | null>(
    null,
  );
  const [dashboardDefaultLoading, setDashboardDefaultLoading] = useState(true);
  const [dashboardDefaultPending, setDashboardDefaultPending] = useState(false);
  const [dashboardDefaultError, setDashboardDefaultError] = useState("");
  const [catalogSources, setCatalogSources] = useState<OpenViewDataSource[]>(
    [],
  );
  const [catalogSourceOffset, setCatalogSourceOffset] = useState(0);
  const [catalogSourcesHasMore, setCatalogSourcesHasMore] = useState(false);
  const [catalogLoadingMore, setCatalogLoadingMore] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [fieldsByModule, setFieldsByModule] = useState<
    Record<string, OpenViewDataSourceField[]>
  >({});
  const [fieldOffset, setFieldOffset] = useState(0);
  const [fieldsHasMore, setFieldsHasMore] = useState(false);
  const [fieldsLoadingMore, setFieldsLoadingMore] = useState(false);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [builderModuleId, setBuilderModuleId] = useState("");
  const [builderWidgetType, setBuilderWidgetType] =
    useState<OpenViewDashboardWidgetType>("chart");
  const [builderChartType, setBuilderChartType] =
    useState<BuilderChartType>("bar");
  const [builderAggregation, setBuilderAggregation] =
    useState<BuilderAggregation>("count");
  const [builderDimensionId, setBuilderDimensionId] = useState("");
  const [builderRecordFieldId, setBuilderRecordFieldId] = useState("");
  const [builderMeasureId, setBuilderMeasureId] = useState("");
  const [builderDateFieldId, setBuilderDateFieldId] = useState("");
  const [builderFromDate, setBuilderFromDate] = useState("");
  const [builderToDate, setBuilderToDate] = useState("");
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState("");
  const [lastGoodSnapshot, setLastGoodSnapshot] =
    useState<SnapshotState | null>(null);
  const [tablePage, setTablePage] = useState(0);
  const [tablePageSize, setTablePageSize] = useState(DASHBOARD_PAGE_SIZE);
  const [pageVisible, setPageVisible] = useState(false);
  const requestSequence = useRef(0);
  const routeLoadSequence = useRef(0);
  const dashboardListRequestSequence = useRef(0);
  const fieldRequestSequence = useRef(0);
  const dashboardDefaultRequestSequence = useRef(0);
  const dashboardDefaultIdRef = useRef<string | null>(null);
  const initialDashboardSelectionSuppressed = useRef(false);
  const routeDashboardIdRef = useRef(routeDashboardId);
  routeDashboardIdRef.current = routeDashboardId;
  const draftDirtyRef = useRef(false);
  const pendingNavigationRef = useRef<PendingNavigation>(null);
  pendingNavigationRef.current = pendingNavigation;
  const applyDashboardRef = useRef<(dashboard: OpenViewDashboard) => void>(
    () => {},
  );
  const lastGoodSnapshotRef = useRef<SnapshotState | null>(null);
  const snapshotInFlightRef = useRef<number | null>(null);
  const refreshActiveSnapshotRef = useRef<() => void>(() => {});
  const restorePendingRef = useRef("");
  const skipRouteLoadForId = useRef("");

  const refreshDashboardDefault = useCallback(
    async (autoSelect = false) => {
      const sequence = ++dashboardDefaultRequestSequence.current;
      setDashboardDefaultLoading(true);
      setDashboardDefaultError("");
      try {
        const preference = await getOpenViewDashboardDefault();
        if (dashboardDefaultRequestSequence.current !== sequence) return;
        dashboardDefaultIdRef.current = preference.dashboardId;
        setDashboardDefaultId(preference.dashboardId);

        if (
          !autoSelect ||
          !preference.dashboardId ||
          routeDashboardIdRef.current ||
          draftDirtyRef.current ||
          pendingNavigationRef.current ||
          initialDashboardSelectionSuppressed.current
        )
          return;

        const dashboard = await getOpenViewDashboard(preference.dashboardId);
        if (
          dashboardDefaultRequestSequence.current !== sequence ||
          dashboardDefaultIdRef.current !== preference.dashboardId ||
          routeDashboardIdRef.current ||
          draftDirtyRef.current ||
          pendingNavigationRef.current ||
          initialDashboardSelectionSuppressed.current
        )
          return;
        if (dashboard.isDeleted) {
          dashboardDefaultIdRef.current = null;
          setDashboardDefaultId(null);
          return;
        }

        applyDashboardRef.current(dashboard);
        skipRouteLoadForId.current = dashboard.id;
        router.replace(
          serializeOpenViewUrl({
            section: "dashboards",
            dashboard: dashboard.id,
          }) as Route,
          { scroll: false },
        );
      } catch (error) {
        if (dashboardDefaultRequestSequence.current === sequence)
          setDashboardDefaultError(
            safeMessage(error, "The default Dashboard could not be loaded."),
          );
      } finally {
        if (dashboardDefaultRequestSequence.current === sequence)
          setDashboardDefaultLoading(false);
      }
    },
    [router],
  );

  useEffect(() => {
    let active = true;
    const sequence = ++dashboardListRequestSequence.current;
    setDashboardListLoading(true);
    setDashboardListLoadingMore(false);
    setDashboardListError("");
    void listOpenViewDashboards({
      limit: DASHBOARD_PAGE_SIZE,
      offset: 0,
      sortBy: "updated_at",
      sortOrder: "desc",
      deleted: showArchived ? "only" : "exclude",
    })
      .then((page) => {
        if (!active || dashboardListRequestSequence.current !== sequence)
          return;
        setDashboards(page.items);
        setDashboardListHasMore(page.pagination.hasMore);
      })
      .catch((error: unknown) => {
        if (active && dashboardListRequestSequence.current === sequence)
          setDashboardListError(
            safeMessage(error, "Dashboards could not be loaded."),
          );
      })
      .finally(() => {
        if (active && dashboardListRequestSequence.current === sequence)
          setDashboardListLoading(false);
      });
    return () => {
      active = false;
    };
  }, [dashboardListRefresh, showArchived]);

  useEffect(() => {
    let active = true;
    void listOpenViewDataSources({ limit: 100, offset: 0 })
      .then((page) => {
        if (!active) return;
        setCatalogSources(page.items);
        setCatalogSourceOffset(page.items.length);
        setCatalogSourcesHasMore(page.pagination.hasMore);
        setCatalogError("");
      })
      .catch((error: unknown) => {
        if (active)
          setCatalogError(
            safeMessage(
              error,
              "The active data-source catalog could not be loaded.",
            ),
          );
      });
    return () => {
      active = false;
    };
  }, [catalogRetry]);

  useEffect(() => {
    let active = true;
    const sequence = ++fieldRequestSequence.current;
    setFieldsLoadingMore(false);
    if (!builderModuleId) {
      setBuilderDimensionId("");
      setBuilderRecordFieldId("");
      setBuilderDateFieldId("");
      setFieldsHasMore(false);
      setFieldOffset(0);
      return;
    }
    setCatalogError("");
    setFieldsHasMore(false);
    setFieldOffset(0);
    void listOpenViewDataSourceFields(builderModuleId, {
      limit: 100,
      offset: 0,
    })
      .then((page) => {
        if (!active || fieldRequestSequence.current !== sequence) return;
        setFieldsByModule((current) => ({
          ...current,
          [builderModuleId]: page.items,
        }));
        setFieldOffset(page.items.length);
        setFieldsHasMore(page.pagination.hasMore);
        const categoricalFields = page.items.filter(isCategoricalField);
        const queryableFields = page.items;
        setBuilderDimensionId((current) =>
          categoricalFields.some((field) => field.id === current)
            ? current
            : (categoricalFields[0]?.id ?? ""),
        );
        setBuilderRecordFieldId((current) =>
          queryableFields.some((field) => field.id === current)
            ? current
            : (queryableFields[0]?.id ?? ""),
        );
      })
      .catch((error: unknown) => {
        if (active && fieldRequestSequence.current === sequence)
          setCatalogError(
            safeMessage(error, "The field catalog could not be loaded."),
          );
      });
    return () => {
      active = false;
    };
  }, [builderModuleId, catalogRetry]);

  useEffect(() => {
    let active = true;
    const sequence = ++routeLoadSequence.current;
    if (!routeDashboardId) {
      setRouteClearPending(false);
      setDashboardLoading(false);
      return;
    }
    if (skipRouteLoadForId.current === routeDashboardId) {
      skipRouteLoadForId.current = "";
      return;
    }
    setSelectedDashboard(null);
    setDashboardName("");
    setDraftWidgets([]);
    setActiveWidgetKey("");
    setLastGoodSnapshot(null);
    lastGoodSnapshotRef.current = null;
    setSnapshotError("");
    setDashboardLoading(true);
    setDashboardError("");
    setNotice("");
    void getOpenViewDashboard(routeDashboardId)
      .then((dashboard) => {
        if (!active || routeLoadSequence.current !== sequence) return;
        applyDashboard(dashboard);
      })
      .catch((error: unknown) => {
        if (active && routeLoadSequence.current === sequence) {
          setSelectedDashboard(null);
          setDashboardError(
            safeMessage(error, "This Dashboard could not be loaded."),
          );
        }
      })
      .finally(() => {
        if (active && routeLoadSequence.current === sequence)
          setDashboardLoading(false);
      });
    return () => {
      active = false;
    };
  }, [routeDashboardId]);

  const activeWidget = draftWidgets.find(
    (widget) => widget.key === activeWidgetKey,
  );
  const activePersistedWidget = selectedDashboard?.widgets.find(
    (widget) => widget.id === activeWidgetKey,
  );
  const activeSignature = dashboardSnapshotSignature(
    activeWidget,
    tablePage,
    tablePageSize,
  );
  const visibleSnapshot =
    activeWidget &&
    lastGoodSnapshot?.widgetKey === activeWidget.key &&
    lastGoodSnapshot.configSignature === activeSignature
      ? lastGoodSnapshot
      : null;
  const widgetsChanged = selectedDashboard
    ? JSON.stringify(
        selectedDashboard.widgets.map(({ widgetType, config }) => ({
          widgetType,
          config,
        })),
      ) !==
      JSON.stringify(
        draftWidgets.map(({ widgetType, config }) => ({ widgetType, config })),
      )
    : draftWidgets.length > 0;
  const draftDirty = selectedDashboard
    ? dashboardName !== selectedDashboard.name ||
      refreshCadence !== selectedDashboard.refreshCadence ||
      widgetsChanged
    : Boolean(dashboardName.trim()) ||
      refreshCadence !== "manual" ||
      draftWidgets.length > 0;
  draftDirtyRef.current = draftDirty;
  const navigationGuard = useCallback(
    (href: string, resume: () => void) => {
      if (savePending || duplicatePending || archivePending || restorePendingId)
        return false;
      if (!draftDirty) {
        setDashboardDialogKind(null);
        setWidgetDialogOpen(false);
        return true;
      }
      if (
        typeof window !== "undefined" &&
        new URL(href, window.location.origin).href === window.location.href
      )
        return true;
      setDashboardDialogKind(null);
      setWidgetDialogOpen(false);
      setPendingNavigation({ href, resume });
      return false;
    },
    [
      archivePending,
      draftDirty,
      duplicatePending,
      restorePendingId,
      savePending,
    ],
  );
  useWorkspaceNavigationGuard(navigationGuard);
  useEffect(() => {
    const updateVisibility = () => {
      const visible = document.visibilityState === "visible";
      if (!visible) {
        requestSequence.current += 1;
        snapshotInFlightRef.current = null;
        setSnapshotLoading(false);
      }
      setPageVisible(visible);
    };
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      requestSequence.current += 1;
    };
  }, []);
  useEffect(() => {
    void refreshDashboardDefault(true);
    return () => {
      dashboardDefaultRequestSequence.current += 1;
    };
  }, [refreshDashboardDefault]);
  const activeTitle = activeWidget
    ? widgetTitle(activeWidget, fieldsByModule)
    : "";
  const builderIsDateSeries =
    builderWidgetType === "chart" && builderChartType === "line";
  const builderFields = (fieldsByModule[builderModuleId] ?? []).filter(
    isCategoricalField,
  );
  const builderRecordFields = fieldsByModule[builderModuleId] ?? [];
  const builderNumericFields = (fieldsByModule[builderModuleId] ?? []).filter(
    (field) => NUMERIC_FIELD_TYPES.has(field.type),
  );
  const builderMeasure = builderNumericFields.find(
    (field) => field.id === builderMeasureId,
  );
  const builderMeasureValid =
    builderAggregation === "count" || Boolean(builderMeasure);
  const builderDateFields = (fieldsByModule[builderModuleId] ?? []).filter(
    isDateField,
  );
  const builderDateField = builderDateFields.find(
    (field) => field.id === builderDateFieldId,
  );
  const builderDateRangeDays = inclusiveDateRangeDays(
    builderFromDate,
    builderToDate,
  );
  const builderDateRangeValid =
    builderDateRangeDays !== null && builderDateRangeDays <= 366;
  const builderDimensionValid = builderFields.some(
    (field) => field.id === builderDimensionId,
  );
  const builderRecordField = builderRecordFields.find(
    (field) => field.id === builderRecordFieldId,
  );
  const builderCanAddWidget =
    builderWidgetType === "records"
      ? Boolean(builderModuleId && builderRecordField)
      : builderWidgetType === "summary"
        ? Boolean(builderModuleId && builderDimensionValid)
        : builderWidgetType === "workload"
          ? Boolean(
              builderModuleId && builderDimensionValid && builderMeasureValid,
            )
          : builderIsDateSeries
            ? Boolean(
                builderModuleId &&
                builderDateField &&
                builderDateRangeValid &&
                builderMeasureValid,
              )
            : Boolean(
                builderModuleId && builderDimensionValid && builderMeasureValid,
              );
  const builderDateRangeDescription =
    !builderFromDate || !builderToDate
      ? "Choose an inclusive start and end date spanning 1 to 366 days."
      : builderDateRangeDays === null
        ? "The end date must be on or after the start date."
        : builderDateRangeDays > 366
          ? "The inclusive date range cannot exceed 366 days."
          : `Both dates are included (${builderDateRangeDays} ${builderDateRangeDays === 1 ? "day" : "days"}).`;

  useEffect(() => {
    setTablePage(0);
  }, [activeWidgetKey]);

  useEffect(() => {
    let active = true;
    if (!activeWidget || !activePersistedWidget) {
      requestSequence.current += 1;
      setSnapshotLoading(false);
      setSnapshotError("");
      return;
    }
    const signature = dashboardSnapshotSignature(
      activeWidget,
      tablePage,
      tablePageSize,
    );
    const previous = lastGoodSnapshotRef.current;
    if (
      previous?.widgetKey === activeWidget.key &&
      previous.configSignature === signature
    ) {
      requestSequence.current += 1;
      setLastGoodSnapshot(previous);
      setSnapshotLoading(false);
      setSnapshotError("");
      return;
    }
    const sequence = ++requestSequence.current;
    snapshotInFlightRef.current = sequence;
    setSnapshotLoading(true);
    setSnapshotError("");
    void loadDashboardWidgetData(
      activeWidget,
      tablePage * tablePageSize,
      tablePageSize,
    )
      .then((data) => {
        if (!active || requestSequence.current !== sequence) return;
        const next = {
          widgetKey: activeWidget.key,
          configSignature: signature,
          data,
        };
        lastGoodSnapshotRef.current = next;
        setLastGoodSnapshot(next);
        if (data.kind === "aggregate")
          setTablePage((current) =>
            lastValidDashboardPage(
              current,
              data.result.items.length,
              tablePageSize,
            ),
          );
      })
      .catch((error: unknown) => {
        if (!active || requestSequence.current !== sequence) return;
        if (
          isAccessDenied(error) &&
          lastGoodSnapshotRef.current?.widgetKey === activeWidget.key
        ) {
          lastGoodSnapshotRef.current = null;
          setLastGoodSnapshot(null);
        }
        setSnapshotError(
          safeMessage(error, "This Dashboard widget could not be refreshed."),
        );
      })
      .finally(() => {
        if (snapshotInFlightRef.current === sequence)
          snapshotInFlightRef.current = null;
        if (active && requestSequence.current === sequence)
          setSnapshotLoading(false);
      });
    return () => {
      active = false;
      if (requestSequence.current === sequence) requestSequence.current += 1;
      if (snapshotInFlightRef.current === sequence)
        snapshotInFlightRef.current = null;
    };
  }, [activePersistedWidget, activeWidget, tablePage, tablePageSize]);

  useEffect(() => {
    let active = true;
    const moduleId = activeWidget?.config.query.moduleId;
    if (!moduleId || fieldsByModule[moduleId]) return;
    void listOpenViewDataSourceFields(moduleId, { limit: 100, offset: 0 })
      .then((page) => {
        if (active)
          setFieldsByModule((current) => ({
            ...current,
            [moduleId]: page.items,
          }));
      })
      .catch(() => {
        // The chart remains usable; its table still shows the authorized values.
      });
    return () => {
      active = false;
    };
  }, [activeWidget, fieldsByModule]);

  function updateDashboardUrl(id?: string) {
    suppressInitialDefaultSelection();
    if (!id) setRouteClearPending(Boolean(routeDashboardId));
    router.push(
      serializeOpenViewUrl({ section: "dashboards", dashboard: id }) as Route,
      { scroll: false },
    );
  }

  function refreshDashboardList() {
    dashboardListRequestSequence.current += 1;
    setDashboardListLoadingMore(false);
    setDashboardListRefresh((current) => current + 1);
  }

  async function toggleDashboardDefault() {
    if (
      !selectedDashboard ||
      selectedDashboard.isDeleted ||
      dashboardDefaultLoading ||
      dashboardDefaultPending
    )
      return;

    const nextDefaultId =
      dashboardDefaultId === selectedDashboard.id ? null : selectedDashboard.id;
    const sequence = ++dashboardDefaultRequestSequence.current;
    setDashboardDefaultLoading(false);
    setDashboardDefaultPending(true);
    setDashboardDefaultError("");
    try {
      const preference = await setOpenViewDashboardDefault(nextDefaultId);
      if (dashboardDefaultRequestSequence.current !== sequence) return;
      dashboardDefaultIdRef.current = preference.dashboardId;
      setDashboardDefaultId(preference.dashboardId);
      setNotice(
        preference.dashboardId
          ? "Default Dashboard updated."
          : "Default Dashboard cleared.",
      );
    } catch (error) {
      if (dashboardDefaultRequestSequence.current === sequence)
        setDashboardDefaultError(
          safeMessage(error, "The default Dashboard could not be updated."),
        );
    } finally {
      if (dashboardDefaultRequestSequence.current === sequence)
        setDashboardDefaultPending(false);
    }
  }

  function selectBuilderModule(moduleId: string) {
    if (moduleId === builderModuleId) return;
    fieldRequestSequence.current += 1;
    setFieldsLoadingMore(false);
    setFieldOffset(0);
    setFieldsHasMore(false);
    setBuilderModuleId(moduleId);
  }

  function retryCatalog() {
    fieldRequestSequence.current += 1;
    setFieldsLoadingMore(false);
    setCatalogRetry((current) => current + 1);
  }

  function applyDashboard(dashboard: OpenViewDashboard) {
    const widgets = draftWidgetsFrom(dashboard);
    setSelectedDashboard(dashboard);
    setDashboardName(dashboard.name);
    setRefreshCadence(dashboard.refreshCadence);
    setDraftWidgets(widgets);
    setActiveWidgetKey(widgets[0]?.key ?? "");
    selectBuilderModule(widgets[0]?.config.query.moduleId ?? "");
    lastGoodSnapshotRef.current = null;
    setLastGoodSnapshot(null);
    setSnapshotError("");
  }

  applyDashboardRef.current = applyDashboard;

  function suppressInitialDefaultSelection() {
    initialDashboardSelectionSuppressed.current = true;
  }

  function beginNewDashboard() {
    suppressInitialDefaultSelection();
    if (selectedDashboard && draftDirty) {
      setNotice("Save this Dashboard before switching to a new one.");
      return;
    }
    if (selectedDashboard || routeDashboardId) {
      routeLoadSequence.current += 1;
      setSelectedDashboard(null);
      setDashboardName("");
      setRefreshCadence("manual");
      setDraftWidgets([]);
      setActiveWidgetKey("");
      lastGoodSnapshotRef.current = null;
      setLastGoodSnapshot(null);
      setSnapshotError("");
      updateDashboardUrl();
    }
    setNotice("");
    setDashboardDialogKind("new");
  }

  function chooseDashboard(dashboardId: string) {
    if (!dashboardId || dashboardId === selectedDashboard?.id) return;
    suppressInitialDefaultSelection();
    if (draftDirty) {
      setNotice("Save this Dashboard before switching to another one.");
      return;
    }
    setNotice("");
    updateDashboardUrl(dashboardId);
  }

  function submitBuilderWidget() {
    if (!builderCanAddWidget || draftWidgets.length >= 12) return;
    if (builderWidgetType === "records") addRecordsWidget();
    else if (
      builderWidgetType === "summary" ||
      builderWidgetType === "workload"
    )
      addGroupedAggregateWidget();
    else if (builderIsDateSeries) addLineChart();
    else addGroupedChart();
    setWidgetDialogOpen(false);
  }

  function toggleArchivedList() {
    suppressInitialDefaultSelection();
    if (draftDirty) {
      setNotice("Save this Dashboard before changing the list view.");
      return;
    }
    dashboardListRequestSequence.current += 1;
    setDashboardListLoadingMore(false);
    routeLoadSequence.current += 1;
    setShowArchived((value) => !value);
    if (selectedDashboard || routeDashboardId) {
      setSelectedDashboard(null);
      setDashboardName("");
      setRefreshCadence("manual");
      setDraftWidgets([]);
      setActiveWidgetKey("");
      lastGoodSnapshotRef.current = null;
      setLastGoodSnapshot(null);
      setSnapshotError("");
      updateDashboardUrl();
    }
  }

  async function loadMoreDashboards() {
    const sequence = dashboardListRequestSequence.current;
    const offset = dashboards.length;
    if (dashboardListLoadingMore || !dashboardListHasMore) return;
    setDashboardListLoadingMore(true);
    setDashboardListError("");
    try {
      const page = await listOpenViewDashboards({
        limit: DASHBOARD_PAGE_SIZE,
        offset,
        sortBy: "updated_at",
        sortOrder: "desc",
        deleted: showArchived ? "only" : "exclude",
      });
      if (dashboardListRequestSequence.current !== sequence) return;
      setDashboards((current) => [...current, ...page.items]);
      setDashboardListHasMore(page.pagination.hasMore);
    } catch (error) {
      if (dashboardListRequestSequence.current !== sequence) return;
      setDashboardListError(
        safeMessage(error, "More Dashboards could not be loaded."),
      );
    } finally {
      if (dashboardListRequestSequence.current === sequence)
        setDashboardListLoadingMore(false);
    }
  }

  async function loadMoreSources() {
    setCatalogLoadingMore(true);
    setCatalogError("");
    try {
      const page = await listOpenViewDataSources({
        limit: 100,
        offset: catalogSourceOffset,
      });
      setCatalogSources((current) => [...current, ...page.items]);
      setCatalogSourceOffset((current) => current + page.items.length);
      setCatalogSourcesHasMore(page.pagination.hasMore);
    } catch (error) {
      setCatalogError(
        safeMessage(error, "More data sources could not be loaded."),
      );
    } finally {
      setCatalogLoadingMore(false);
    }
  }

  async function loadMoreFields() {
    if (!builderModuleId) return;
    const moduleId = builderModuleId;
    const sequence = fieldRequestSequence.current;
    const offset = fieldOffset;
    setFieldsLoadingMore(true);
    setCatalogError("");
    try {
      const page = await listOpenViewDataSourceFields(moduleId, {
        limit: 100,
        offset,
      });
      if (fieldRequestSequence.current !== sequence) return;
      setFieldsByModule((current) => ({
        ...current,
        [moduleId]: [...(current[moduleId] ?? []), ...page.items],
      }));
      setFieldOffset(offset + page.items.length);
      setFieldsHasMore(page.pagination.hasMore);
    } catch (error) {
      if (fieldRequestSequence.current !== sequence) return;
      setCatalogError(safeMessage(error, "More fields could not be loaded."));
    } finally {
      if (fieldRequestSequence.current === sequence)
        setFieldsLoadingMore(false);
    }
  }

  function addGroupedChart() {
    if (builderWidgetType !== "chart" || builderChartType === "line") return;
    const field = (fieldsByModule[builderModuleId] ?? []).find(
      (candidate) =>
        candidate.id === builderDimensionId && isCategoricalField(candidate),
    );
    const measure = builderAggregation === "count" ? undefined : builderMeasure;
    if (
      !field ||
      (builderAggregation !== "count" && !measure) ||
      draftWidgets.length >= 12
    ) {
      return;
    }
    const definition: OpenViewQueryDefinition = {
      version: 1,
      logic: "and",
      columns: [],
      filters: [],
      sort: [],
      deleted: "exclude",
      search: null,
      searchFields: [],
    };
    const config: OpenViewDashboardChartConfig = {
      version: 1,
      chartType: builderChartType,
      query: {
        mode: "groups",
        moduleId: builderModuleId,
        definition,
        aggregation: builderAggregation,
        ...(measure
          ? {
              measure: {
                fieldId: measure.id,
                expectedType: measure.type,
              },
            }
          : {}),
        dimension: { fieldId: field.id, expectedType: field.type },
      },
    };
    const next: DraftWidget = {
      key: crypto.randomUUID(),
      widgetType: "chart",
      config,
    };
    suppressInitialDefaultSelection();
    setDraftWidgets((current) => [...current, next]);
    setActiveWidgetKey(next.key);
    setNotice("");
  }

  function addLineChart() {
    if (builderWidgetType !== "chart") return;
    const field = builderDateFields.find(
      (candidate) => candidate.id === builderDateFieldId,
    );
    const measure = builderAggregation === "count" ? undefined : builderMeasure;
    const rangeDays = inclusiveDateRangeDays(builderFromDate, builderToDate);
    if (
      !field ||
      (builderAggregation !== "count" && !measure) ||
      rangeDays === null ||
      rangeDays < 1 ||
      rangeDays > 366 ||
      draftWidgets.length >= 12
    ) {
      return;
    }
    const definition: OpenViewQueryDefinition = {
      version: 1,
      logic: "and",
      columns: [],
      filters: [],
      sort: [],
      deleted: "exclude",
      search: null,
      searchFields: [],
    };
    const config: OpenViewDashboardChartConfig = {
      version: 1,
      chartType: "line",
      query: {
        mode: "date_series",
        moduleId: builderModuleId,
        definition,
        aggregation: builderAggregation,
        ...(measure
          ? {
              measure: {
                fieldId: measure.id,
                expectedType: measure.type,
              },
            }
          : {}),
        dateField: { fieldId: field.id, expectedType: field.type },
        fromDate: builderFromDate,
        toDate: builderToDate,
      },
    };
    const next: DraftWidget = {
      key: crypto.randomUUID(),
      widgetType: "chart",
      config,
    };
    suppressInitialDefaultSelection();
    setDraftWidgets((current) => [...current, next]);
    setActiveWidgetKey(next.key);
    setNotice("");
  }

  function addGroupedAggregateWidget() {
    if (builderWidgetType !== "summary" && builderWidgetType !== "workload")
      return;
    const field = (fieldsByModule[builderModuleId] ?? []).find(
      (candidate) =>
        candidate.id === builderDimensionId && isCategoricalField(candidate),
    );
    const aggregation =
      builderWidgetType === "summary" ? "count" : builderAggregation;
    const measure = aggregation === "count" ? undefined : builderMeasure;
    if (
      !field ||
      (aggregation !== "count" && !measure) ||
      draftWidgets.length >= 12
    )
      return;
    const config: OpenViewDashboardAggregateConfig = {
      version: 1,
      query: {
        mode: "groups",
        moduleId: builderModuleId,
        definition: {
          version: 1,
          logic: "and",
          columns: [],
          filters: [],
          sort: [],
          deleted: "exclude",
          search: null,
          searchFields: [],
        },
        aggregation,
        ...(measure
          ? {
              measure: {
                fieldId: measure.id,
                expectedType: measure.type,
              },
            }
          : {}),
        dimension: { fieldId: field.id, expectedType: field.type },
      },
    };
    const next: DraftWidget = {
      key: crypto.randomUUID(),
      widgetType: builderWidgetType,
      config,
    };
    suppressInitialDefaultSelection();
    setDraftWidgets((current) => [...current, next]);
    setActiveWidgetKey(next.key);
    setNotice("");
  }

  function addRecordsWidget() {
    const field = builderRecordFields.find(
      (candidate) => candidate.id === builderRecordFieldId,
    );
    if (builderWidgetType !== "records" || !field || draftWidgets.length >= 12)
      return;
    const config: OpenViewDashboardRecordsConfig = {
      version: 1,
      query: {
        moduleId: builderModuleId,
        definition: {
          version: 1,
          logic: "and",
          columns: [{ fieldId: field.id, expectedType: field.type }],
          filters: [],
          sort: [],
          deleted: "exclude",
          search: null,
          searchFields: [],
        },
      },
    };
    const next: DraftWidget = {
      key: crypto.randomUUID(),
      widgetType: "records",
      config,
    };
    suppressInitialDefaultSelection();
    setDraftWidgets((current) => [...current, next]);
    setActiveWidgetKey(next.key);
    setNotice("");
  }

  function removeWidget(key: string) {
    const next = draftWidgets.filter((widget) => widget.key !== key);
    suppressInitialDefaultSelection();
    setDraftWidgets(next);
    if (activeWidgetKey === key) setActiveWidgetKey(next[0]?.key ?? "");
  }

  function moveWidget(key: string, direction: -1 | 1) {
    const index = draftWidgets.findIndex((widget) => widget.key === key);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= draftWidgets.length) return;
    const next = [...draftWidgets];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(nextIndex, 0, moved);
    suppressInitialDefaultSelection();
    setDraftWidgets(next);
  }

  async function saveDashboard() {
    if (
      !dashboardName.trim() ||
      routeClearPending ||
      savePending ||
      selectedDashboard?.isDeleted
    )
      return;
    setSavePending(true);
    setDashboardError("");
    setNotice("");
    const widgets = inputWidgets(draftWidgets);
    try {
      const saved = selectedDashboard
        ? await updateOpenViewDashboard({
            id: selectedDashboard.id,
            revision: selectedDashboard.revision,
            name: dashboardName,
            refreshCadence,
            widgets,
          })
        : await createOpenViewDashboard({
            name: dashboardName,
            refreshCadence,
            widgets,
          });
      applyDashboard(saved);
      refreshDashboardList();
      if (saved.id !== routeDashboardId) {
        skipRouteLoadForId.current = saved.id;
        router.replace(
          serializeOpenViewUrl({
            section: "dashboards",
            dashboard: saved.id,
          }) as Route,
          { scroll: false },
        );
      }
      setNotice("Dashboard saved.");
    } catch (error) {
      const conflict = getOpenViewDashboardConflict(error);
      if (conflict?.code === "stale_revision") {
        setDashboardError(
          conflict.message ??
            "This Dashboard changed since you opened it. Your draft is still here; reload the saved version to compare.",
        );
      } else {
        setDashboardError(
          safeMessage(
            error,
            "The Dashboard could not be saved. Your draft is still here.",
          ),
        );
      }
    } finally {
      setSavePending(false);
    }
  }

  async function duplicateDashboard() {
    if (
      !selectedDashboard ||
      selectedDashboard.isDeleted ||
      duplicatePending ||
      savePending ||
      draftDirty
    ) {
      if (draftDirty)
        setNotice("Save or reload this Dashboard before duplicating it.");
      return;
    }
    setDuplicatePending(true);
    setDashboardError("");
    setNotice("");
    try {
      const duplicate = await createOpenViewDashboard({
        name: `Copy of ${selectedDashboard.name}`.slice(0, 200),
        refreshCadence: selectedDashboard.refreshCadence,
        widgets: inputWidgets(draftWidgetsFrom(selectedDashboard)),
      });
      applyDashboard(duplicate);
      refreshDashboardList();
      skipRouteLoadForId.current = duplicate.id;
      router.replace(
        serializeOpenViewUrl({
          section: "dashboards",
          dashboard: duplicate.id,
        }) as Route,
        { scroll: false },
      );
      setNotice(
        "Dashboard duplicated. The original and default are unchanged.",
      );
    } catch (error) {
      setDashboardError(
        safeMessage(error, "The Dashboard could not be duplicated."),
      );
    } finally {
      setDuplicatePending(false);
    }
  }

  async function reloadSelectedDashboard(discardDraft = false) {
    if (!selectedDashboard || (draftDirty && !discardDraft) || dashboardLoading)
      return;
    setDashboardLoading(true);
    setDashboardError("");
    try {
      applyDashboard(await getOpenViewDashboard(selectedDashboard.id));
      setNotice("Dashboard reloaded.");
    } catch (error) {
      setDashboardError(
        safeMessage(error, "The Dashboard could not be reloaded."),
      );
    } finally {
      setDashboardLoading(false);
    }
  }

  async function archiveDashboard() {
    if (!selectedDashboard || archivePending || duplicatePending) return;
    setArchivePending(true);
    setDashboardError("");
    try {
      await archiveOpenViewDashboard({
        id: selectedDashboard.id,
        revision: selectedDashboard.revision,
      });
      setSelectedDashboard(null);
      setDashboardName("");
      setRefreshCadence("manual");
      setDraftWidgets([]);
      setActiveWidgetKey("");
      lastGoodSnapshotRef.current = null;
      setLastGoodSnapshot(null);
      refreshDashboardList();
      setNotice("Dashboard archived.");
      void refreshDashboardDefault();
      updateDashboardUrl();
    } catch (error) {
      const conflict = getOpenViewDashboardConflict(error);
      setDashboardError(
        conflict?.message ??
          safeMessage(error, "The Dashboard could not be archived."),
      );
    } finally {
      setArchivePending(false);
    }
  }

  async function restoreDashboard(dashboard: OpenViewDashboard) {
    suppressInitialDefaultSelection();
    if (
      restorePendingRef.current ||
      duplicatePending ||
      draftDirty ||
      savePending ||
      archivePending
    ) {
      if (draftDirty)
        setNotice("Save this Dashboard before restoring another one.");
      return;
    }
    restorePendingRef.current = dashboard.id;
    setRestorePendingId(dashboard.id);
    setDashboardError("");
    try {
      const restored = await restoreOpenViewDashboard({
        id: dashboard.id,
        revision: dashboard.revision,
      });
      setShowArchived(false);
      applyDashboard(restored);
      refreshDashboardList();
      void refreshDashboardDefault();
      if (routeDashboardId !== restored.id) {
        skipRouteLoadForId.current = restored.id;
        router.replace(
          serializeOpenViewUrl({
            section: "dashboards",
            dashboard: restored.id,
          }) as Route,
          { scroll: false },
        );
      }
      setNotice("Dashboard restored.");
    } catch (error) {
      const conflict = getOpenViewDashboardConflict(error);
      setDashboardError(
        conflict?.message ??
          safeMessage(error, "The Dashboard could not be restored."),
      );
    } finally {
      restorePendingRef.current = "";
      setRestorePendingId("");
    }
  }

  function refreshActiveSnapshot() {
    if (
      !activeWidget ||
      !activePersistedWidget ||
      snapshotInFlightRef.current !== null
    )
      return;
    const signature = dashboardSnapshotSignature(
      activeWidget,
      tablePage,
      tablePageSize,
    );
    const sequence = ++requestSequence.current;
    snapshotInFlightRef.current = sequence;
    setSnapshotLoading(true);
    setSnapshotError("");
    void loadDashboardWidgetData(
      activeWidget,
      tablePage * tablePageSize,
      tablePageSize,
    )
      .then((data) => {
        if (requestSequence.current !== sequence) return;
        const next = {
          widgetKey: activeWidget.key,
          configSignature: signature,
          data,
        };
        lastGoodSnapshotRef.current = next;
        setLastGoodSnapshot(next);
        if (data.kind === "aggregate")
          setTablePage((current) =>
            lastValidDashboardPage(
              current,
              data.result.items.length,
              tablePageSize,
            ),
          );
      })
      .catch((error: unknown) => {
        if (requestSequence.current !== sequence) return;
        if (
          isAccessDenied(error) &&
          lastGoodSnapshotRef.current?.widgetKey === activeWidget.key
        ) {
          lastGoodSnapshotRef.current = null;
          setLastGoodSnapshot(null);
        }
        setSnapshotError(
          safeMessage(error, "The Dashboard widget could not be refreshed."),
        );
      })
      .finally(() => {
        if (snapshotInFlightRef.current === sequence)
          snapshotInFlightRef.current = null;
        if (requestSequence.current === sequence) setSnapshotLoading(false);
      });
  }

  refreshActiveSnapshotRef.current = refreshActiveSnapshot;

  useEffect(() => {
    const cadence = selectedDashboard?.refreshCadence;
    if (
      !selectedDashboard ||
      selectedDashboard.isDeleted ||
      !activePersistedWidget ||
      !activeWidget ||
      draftDirty ||
      snapshotLoading ||
      !pageVisible ||
      routeDashboardId !== selectedDashboard.id ||
      cadence === undefined ||
      cadence === "manual"
    )
      return;
    const intervalMs = cadence === "one-minute" ? 60_000 : 300_000;
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        !draftDirtyRef.current &&
        snapshotInFlightRef.current === null
      )
        refreshActiveSnapshotRef.current();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [
    activePersistedWidget,
    activeWidget,
    draftDirty,
    pageVisible,
    routeDashboardId,
    selectedDashboard,
    snapshotLoading,
  ]);

  const dashboardChoices =
    selectedDashboard &&
    !dashboards.some((item) => item.id === selectedDashboard.id)
      ? [selectedDashboard, ...dashboards]
      : dashboards;
  const cadenceDescription =
    refreshCadence === "manual"
      ? "Manual refresh"
      : refreshCadence === "one-minute"
        ? "Every minute while this page is open"
        : "Every five minutes while this page is open";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            data-slot="page-title"
            id="dashboard-page-title"
            className="text-2xl font-semibold"
          >
            Private dashboards
          </h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            Keep useful live results together. Each Dashboard is private to you.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            disabled={
              savePending ||
              duplicatePending ||
              archivePending ||
              dashboardDefaultPending ||
              Boolean(restorePendingId)
            }
            onClick={beginNewDashboard}
          >
            New Dashboard
          </Button>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={
              savePending ||
              duplicatePending ||
              archivePending ||
              dashboardDefaultPending ||
              Boolean(restorePendingId)
            }
            onClick={toggleArchivedList}
          >
            {showArchived ? "Show active" : "Show archived"}
          </Button>
        </div>
      </header>

      {notice ? <Alert role="status">{notice}</Alert> : null}
      {dashboardError ? (
        <Alert role="alert" variant="destructive">
          {dashboardError}
        </Alert>
      ) : null}
      {dashboardDefaultError ? (
        <Alert role="alert" variant="destructive">
          {dashboardDefaultError}
          <Button
            className="mt-3 min-h-11"
            variant="outline"
            disabled={dashboardDefaultLoading || dashboardDefaultPending}
            onClick={() => void refreshDashboardDefault(true)}
          >
            Retry default Dashboard
          </Button>
        </Alert>
      ) : null}
      {dashboardListError ? (
        <Alert role="alert" variant="destructive">
          {dashboardListError}
          <Button
            className="mt-3 min-h-11"
            variant="outline"
            onClick={refreshDashboardList}
          >
            Retry Dashboard list
          </Button>
        </Alert>
      ) : null}

      <section
        aria-label="Dashboard context"
        className="border-border bg-card grid min-w-0 gap-4 rounded-[var(--radius)] border p-4 lg:grid-cols-[minmax(0,1fr)_auto]"
      >
        <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(13rem,0.8fr)_minmax(0,1fr)] sm:items-end">
          <div className="min-w-0">
            <h2 className="mb-1 text-sm font-medium">
              {showArchived ? "Archived dashboards" : "Your dashboards"}
            </h2>
            <Field className="min-w-0">
              <FieldLabel htmlFor="dashboard-context">Dashboard</FieldLabel>
              <Select
                id="dashboard-context"
                className="min-h-11 w-full"
                value={selectedDashboard?.id ?? ""}
                disabled={
                  dashboardListLoading ||
                  dashboardLoading ||
                  routeClearPending ||
                  savePending ||
                  archivePending ||
                  Boolean(restorePendingId)
                }
                onValueChange={chooseDashboard}
              >
                <option value="">
                  {showArchived
                    ? "Choose an archived Dashboard"
                    : "Choose a Dashboard"}
                </option>
                {dashboardChoices.map((dashboard) => (
                  <option key={dashboard.id} value={dashboard.id}>
                    {dashboard.name}
                    {dashboardDefaultId === dashboard.id ? " · Default" : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold">
                {selectedDashboard
                  ? dashboardName || selectedDashboard.name
                  : dashboardName || "No dashboard selected"}
              </h2>
              {selectedDashboard ? (
                <>
                  <Badge variant="outline">Only you</Badge>
                  {dashboardDefaultId === selectedDashboard.id ? (
                    <Badge variant="secondary">Default</Badge>
                  ) : null}
                  {selectedDashboard.isDeleted ? (
                    <Badge variant="outline">Archived</Badge>
                  ) : null}
                </>
              ) : null}
              {draftDirty ? (
                <span
                  role="status"
                  className="text-muted-foreground text-sm font-medium"
                >
                  Unsaved changes
                </span>
              ) : null}
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              {selectedDashboard
                ? "Revision " +
                  selectedDashboard.revision +
                  " · " +
                  cadenceDescription +
                  ". Only you can view these Dashboards."
                : dashboardName || draftWidgets.length
                  ? "Private draft · " + cadenceDescription
                  : "Choose a private Dashboard or create one."}
            </p>
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-end gap-2">
          {activePersistedWidget && !selectedDashboard?.isDeleted ? (
            <Button
              variant="outline"
              className="min-h-11"
              disabled={snapshotLoading}
              onClick={refreshActiveSnapshot}
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              {snapshotLoading ? "Refreshing…" : "Refresh now"}
            </Button>
          ) : null}
          {draftDirty ? (
            <Button
              className="min-h-11"
              onClick={() => void saveDashboard()}
              disabled={
                savePending ||
                duplicatePending ||
                routeClearPending ||
                archivePending ||
                Boolean(restorePendingId) ||
                !dashboardName.trim() ||
                selectedDashboard?.isDeleted
              }
            >
              {savePending ? "Saving…" : "Save Dashboard"}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  className="min-h-11"
                  aria-label="Dashboard options"
                />
              }
            >
              Dashboard options{" "}
              <ChevronDown data-icon="inline-end" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuItem
                className="min-h-11"
                disabled={
                  !selectedDashboard ||
                  selectedDashboard.isDeleted ||
                  savePending ||
                  archivePending ||
                  Boolean(restorePendingId)
                }
                onClick={() => setDashboardDialogKind("settings")}
              >
                Dashboard settings
              </DropdownMenuItem>
              {selectedDashboard ? <DropdownMenuSeparator /> : null}
              {selectedDashboard && !selectedDashboard.isDeleted ? (
                <>
                  <DropdownMenuItem
                    className="min-h-11"
                    disabled={
                      draftDirty ||
                      duplicatePending ||
                      savePending ||
                      archivePending ||
                      Boolean(restorePendingId)
                    }
                    onClick={() => void duplicateDashboard()}
                  >
                    {duplicatePending ? "Duplicating…" : "Duplicate Dashboard"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="min-h-11"
                    disabled={
                      dashboardDefaultLoading ||
                      dashboardDefaultPending ||
                      duplicatePending ||
                      archivePending ||
                      Boolean(restorePendingId)
                    }
                    onClick={() => void toggleDashboardDefault()}
                  >
                    {dashboardDefaultPending
                      ? "Updating default…"
                      : dashboardDefaultId === selectedDashboard.id
                        ? "Clear default"
                        : "Set as default"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="min-h-11"
                    disabled={dashboardLoading || duplicatePending}
                    onClick={() => void reloadSelectedDashboard(draftDirty)}
                  >
                    {draftDirty
                      ? "Discard draft and reload"
                      : "Reload saved Dashboard"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="min-h-11"
                    disabled={
                      archivePending ||
                      duplicatePending ||
                      draftDirty ||
                      dashboardDefaultPending
                    }
                    onClick={() => void archiveDashboard()}
                  >
                    {archivePending ? "Archiving…" : "Archive Dashboard"}
                  </DropdownMenuItem>
                </>
              ) : null}
              {selectedDashboard?.isDeleted ? (
                <DropdownMenuItem
                  className="min-h-11"
                  disabled={
                    draftDirty ||
                    archivePending ||
                    duplicatePending ||
                    Boolean(restorePendingId)
                  }
                  onClick={() => void restoreDashboard(selectedDashboard)}
                >
                  Restore Dashboard
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {showArchived && dashboards.length ? (
          <ul className="border-border flex min-w-0 flex-wrap gap-2 border-t pt-3 lg:col-span-2">
            {dashboards.map((dashboard) => (
              <li
                key={dashboard.id}
                className="flex min-w-0 flex-wrap items-center gap-2"
              >
                <Button
                  variant={
                    selectedDashboard?.id === dashboard.id
                      ? "secondary"
                      : "outline"
                  }
                  className="min-h-11 min-w-0 justify-start text-left"
                  disabled={
                    dashboardLoading ||
                    draftDirty ||
                    savePending ||
                    duplicatePending ||
                    archivePending ||
                    dashboardDefaultPending ||
                    Boolean(restorePendingId)
                  }
                  onClick={() => chooseDashboard(dashboard.id)}
                >
                  {dashboard.name}
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={
                    draftDirty ||
                    routeClearPending ||
                    savePending ||
                    archivePending ||
                    Boolean(restorePendingId)
                  }
                  aria-busy={restorePendingId === dashboard.id}
                  onClick={() => void restoreDashboard(dashboard)}
                >
                  Restore {dashboard.name}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {dashboardListLoading ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading Dashboards…
        </p>
      ) : null}
      {!dashboardListLoading &&
      !dashboardListError &&
      dashboards.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {showArchived
            ? "No archived Dashboards."
            : "No Dashboards yet. Create one to get started."}
        </p>
      ) : null}
      {dashboardListHasMore ? (
        <Button
          variant="outline"
          className="min-h-11 self-start"
          disabled={dashboardListLoadingMore}
          onClick={() => void loadMoreDashboards()}
        >
          {dashboardListLoadingMore ? "Loading…" : "Load more Dashboards"}
        </Button>
      ) : null}

      <div className="border-border bg-card grid min-w-0 grid-cols-1 overflow-hidden rounded-[var(--radius)] border lg:grid-cols-[minmax(15rem,0.72fr)_minmax(0,1.8fr)]">
        <aside
          aria-labelledby="dashboard-widgets"
          className="border-border flex min-w-0 flex-col gap-3 p-4 lg:border-r"
        >
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="dashboard-widgets" className="text-lg font-semibold">
              Widgets
            </h2>
            <p role="status" className="text-muted-foreground text-sm">
              {draftWidgets.length} of 12 widgets
            </p>
          </div>
          <Button
            variant="outline"
            className="min-h-11 w-full"
            disabled={
              selectedDashboard?.isDeleted ||
              draftWidgets.length >= 12 ||
              duplicatePending ||
              savePending ||
              Boolean(restorePendingId)
            }
            onClick={() => setWidgetDialogOpen(true)}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add widget
          </Button>

          {draftWidgets.length ? (
            <ol className="flex min-w-0 flex-col gap-2">
              {draftWidgets.map((widget, index) => {
                const title = widgetTitle(widget, fieldsByModule);
                const kind =
                  widget.widgetType === "chart"
                    ? (widget.config.chartType === "line"
                        ? "Line"
                        : widget.config.chartType === "pie"
                          ? "Pie"
                          : "Bar") + " chart"
                    : widget.widgetType === "summary"
                      ? "Summary"
                      : widget.widgetType === "workload"
                        ? "Workload"
                        : "Records";
                const viewLabel =
                  widget.widgetType === "chart"
                    ? "chart"
                    : widget.widgetType === "records"
                      ? "records"
                      : widget.widgetType;
                const persisted = selectedDashboard?.widgets.some(
                  (candidate) => candidate.id === widget.key,
                );
                const unavailable =
                  savePending ||
                  duplicatePending ||
                  archivePending ||
                  Boolean(restorePendingId) ||
                  Boolean(selectedDashboard?.isDeleted);
                return (
                  <li
                    key={widget.key}
                    className={
                      activeWidgetKey === widget.key
                        ? "bg-accent/50 flex min-w-0 items-start gap-1 rounded-[var(--radius)] p-1"
                        : "flex min-w-0 items-start gap-1 rounded-[var(--radius)] p-1"
                    }
                  >
                    <Button
                      type="button"
                      variant={
                        activeWidgetKey === widget.key ? "secondary" : "ghost"
                      }
                      className="min-h-12 min-w-0 flex-1 flex-col items-start justify-center gap-0.5 overflow-hidden text-left"
                      aria-label={
                        "View " + viewLabel + " " + (index + 1) + ": " + title
                      }
                      aria-pressed={activeWidgetKey === widget.key}
                      onClick={() => setActiveWidgetKey(widget.key)}
                    >
                      <span className="w-full truncate">{title}</span>
                      <span className="text-muted-foreground w-full truncate text-xs">
                        {persisted ? kind : kind + " · Unsaved"}
                      </span>
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-11 shrink-0"
                            aria-label={"Widget options: " + title}
                            disabled={unavailable}
                          />
                        }
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="min-h-11"
                          disabled={index === 0 || unavailable}
                          onClick={() => moveWidget(widget.key, -1)}
                        >
                          Move up
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="min-h-11"
                          disabled={
                            index === draftWidgets.length - 1 || unavailable
                          }
                          onClick={() => moveWidget(widget.key, 1)}
                        >
                          Move down
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="min-h-11"
                          variant="destructive"
                          disabled={unavailable}
                          onClick={() => removeWidget(widget.key)}
                        >
                          Remove widget
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-muted-foreground py-2 text-sm">
              Add a widget to see one current result at a time. New widgets load
              after you save this Dashboard.
            </p>
          )}
        </aside>

        <div className="min-w-0 p-4 sm:p-5">
          {dashboardLoading ? (
            <p role="status" className="text-muted-foreground text-sm">
              Loading Dashboard…
            </p>
          ) : activeWidget ? (
            <DashboardWidgetResults
              widget={activeWidget}
              title={activeTitle}
              persisted={Boolean(activePersistedWidget)}
              snapshot={visibleSnapshot}
              snapshotLoading={snapshotLoading}
              snapshotError={snapshotError}
              tablePage={tablePage}
              tablePageSize={tablePageSize}
              fieldsByModule={fieldsByModule}
              onRefresh={refreshActiveSnapshot}
              setTablePage={setTablePage}
              setTablePageSize={setTablePageSize}
            />
          ) : (
            <section className="flex min-h-64 min-w-0 flex-col justify-center gap-2">
              <h2 className="text-lg font-semibold">
                {selectedDashboard
                  ? "No widgets in this Dashboard"
                  : "Select a Dashboard to begin"}
              </h2>
              <p className="text-muted-foreground max-w-xl text-sm">
                {selectedDashboard
                  ? selectedDashboard.isDeleted
                    ? "Restore this Dashboard to add or change widgets."
                    : "Add a widget to load its current result from OpenView."
                  : "Choose one from your private Dashboards or create a new one."}
              </p>
            </section>
          )}
        </div>
      </div>

      <Dialog
        open={dashboardDialogKind !== null}
        onOpenChange={(open) => {
          if (!open) setDashboardDialogKind(null);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {dashboardDialogKind === "new"
                ? "New Dashboard"
                : "Dashboard settings"}
            </DialogTitle>
            <DialogDescription>
              The name and refresh cadence stay in your draft until you save
              this private Dashboard.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field className="min-w-0 sm:col-span-2">
              <FieldLabel htmlFor="dashboard-name">Dashboard name</FieldLabel>
              <Input
                id="dashboard-name"
                maxLength={200}
                value={dashboardName}
                onChange={(event) => {
                  suppressInitialDefaultSelection();
                  setDashboardName(event.target.value);
                }}
                disabled={
                  selectedDashboard?.isDeleted ||
                  savePending ||
                  archivePending ||
                  Boolean(restorePendingId)
                }
              />
              <FieldDescription>Private to your account.</FieldDescription>
            </Field>
            <Field className="min-w-0 sm:col-span-2">
              <FieldLabel htmlFor="dashboard-refresh-cadence">
                Refresh cadence
              </FieldLabel>
              <Select
                id="dashboard-refresh-cadence"
                className="min-h-11 w-full"
                value={refreshCadence}
                disabled={
                  selectedDashboard?.isDeleted ||
                  savePending ||
                  duplicatePending ||
                  archivePending ||
                  Boolean(restorePendingId)
                }
                onValueChange={(value) => {
                  suppressInitialDefaultSelection();
                  setRefreshCadence(value as OpenViewDashboardRefreshCadence);
                }}
              >
                <option value="manual">Manual</option>
                <option value="one-minute">Every minute</option>
                <option value="five-minutes">Every five minutes</option>
              </Select>
              <FieldDescription>
                Automatic refresh runs only while this page is visible and this
                Dashboard has no unsaved changes.
              </FieldDescription>
            </Field>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setDashboardDialogKind(null)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={widgetDialogOpen} onOpenChange={setWidgetDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Add widget</DialogTitle>
            <DialogDescription>
              Choose one live result. A new widget loads only after you save the
              Dashboard.
            </DialogDescription>
          </DialogHeader>

          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Field className="min-w-0 sm:col-span-2">
              <FieldLabel htmlFor="dashboard-module">Data source</FieldLabel>
              <Select
                id="dashboard-module"
                className="min-h-11 w-full"
                value={builderModuleId}
                disabled={duplicatePending}
                onValueChange={(value) => {
                  suppressInitialDefaultSelection();
                  selectBuilderModule(value);
                  setBuilderDateFieldId("");
                  setBuilderMeasureId("");
                }}
              >
                <option value="">Choose a data source</option>
                {catalogSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </Select>
              {!catalogSources.length && !catalogError ? (
                <FieldDescription>
                  No data sources are available yet. Retry the catalog if this
                  persists.
                </FieldDescription>
              ) : null}
            </Field>
            <Field className="min-w-0">
              <FieldLabel htmlFor="dashboard-widget-type">
                Widget type
              </FieldLabel>
              <Select
                id="dashboard-widget-type"
                className="min-h-11 w-full"
                value={builderWidgetType}
                disabled={duplicatePending}
                onValueChange={(value) => {
                  suppressInitialDefaultSelection();
                  const nextType = value as OpenViewDashboardWidgetType;
                  setBuilderWidgetType(nextType);
                  if (nextType === "summary") setBuilderAggregation("count");
                }}
              >
                <option value="summary">Summary</option>
                <option value="workload">Workload</option>
                <option value="records">Record list</option>
                <option value="chart">Chart</option>
              </Select>
            </Field>

            {builderWidgetType === "chart" ? (
              <Field className="min-w-0">
                <FieldLabel htmlFor="dashboard-chart-type">
                  Chart type
                </FieldLabel>
                <Select
                  id="dashboard-chart-type"
                  className="min-h-11 w-full"
                  value={builderChartType}
                  disabled={duplicatePending}
                  onValueChange={(value) => {
                    suppressInitialDefaultSelection();
                    setBuilderChartType(value as BuilderChartType);
                  }}
                >
                  <option value="bar">By category (bar)</option>
                  <option value="pie">By category (pie)</option>
                  <option value="line">Over time (line)</option>
                </Select>
              </Field>
            ) : null}

            {builderWidgetType === "chart" ||
            builderWidgetType === "workload" ? (
              <Field className="min-w-0">
                <FieldLabel htmlFor="dashboard-aggregation">
                  Aggregation
                </FieldLabel>
                <Select
                  id="dashboard-aggregation"
                  className="min-h-11 w-full"
                  value={builderAggregation}
                  disabled={duplicatePending}
                  onValueChange={(value) => {
                    suppressInitialDefaultSelection();
                    setBuilderAggregation(value as BuilderAggregation);
                  }}
                >
                  <option value="count">Count</option>
                  <option value="sum">Sum</option>
                  <option value="average">Average</option>
                </Select>
              </Field>
            ) : null}

            {(builderWidgetType === "chart" ||
              builderWidgetType === "workload") &&
            builderAggregation !== "count" ? (
              <Field className="min-w-0">
                <FieldLabel htmlFor="dashboard-measure">
                  Numeric measure
                </FieldLabel>
                <Select
                  id="dashboard-measure"
                  className="min-h-11 w-full"
                  value={builderMeasureId}
                  disabled={
                    duplicatePending ||
                    !builderModuleId ||
                    !builderNumericFields.length
                  }
                  onValueChange={(value) => {
                    suppressInitialDefaultSelection();
                    setBuilderMeasureId(value);
                  }}
                >
                  <option value="">Choose a numeric field</option>
                  {builderNumericFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name}
                    </option>
                  ))}
                </Select>
                {!builderNumericFields.length ? (
                  <FieldDescription>
                    Sum and average require a numeric field in this data source.
                  </FieldDescription>
                ) : null}
              </Field>
            ) : null}

            {builderWidgetType === "records" ? (
              <Field className="min-w-0">
                <FieldLabel htmlFor="dashboard-record-field">
                  Display field
                </FieldLabel>
                <Select
                  id="dashboard-record-field"
                  className="min-h-11 w-full"
                  value={builderRecordFieldId}
                  disabled={
                    duplicatePending ||
                    !builderModuleId ||
                    !builderRecordFields.length
                  }
                  onValueChange={(value) => {
                    suppressInitialDefaultSelection();
                    setBuilderRecordFieldId(value);
                  }}
                >
                  <option value="">Choose a field</option>
                  {builderRecordFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name}
                    </option>
                  ))}
                </Select>
                <FieldDescription>
                  The saved query uses this field to display live rows.
                </FieldDescription>
              </Field>
            ) : !builderIsDateSeries ? (
              <Field className="min-w-0">
                <FieldLabel htmlFor="dashboard-dimension">
                  Group records by
                </FieldLabel>
                <Select
                  id="dashboard-dimension"
                  className="min-h-11 w-full"
                  value={builderDimensionId}
                  disabled={
                    duplicatePending ||
                    !builderModuleId ||
                    !builderFields.length
                  }
                  onValueChange={(value) => {
                    suppressInitialDefaultSelection();
                    setBuilderDimensionId(value);
                  }}
                >
                  <option value="">Choose a field</option>
                  {builderFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name}
                    </option>
                  ))}
                </Select>
                <FieldDescription>
                  {builderWidgetType === "summary"
                    ? "Counts matching records across the selected groups."
                    : builderWidgetType === "workload"
                      ? "Compares the selected aggregate across live record groups."
                      : "Creates a categorical chart from live records."}
                </FieldDescription>
                {builderModuleId && !builderFields.length ? (
                  <FieldDescription>
                    This data source has no active categorical fields.
                  </FieldDescription>
                ) : null}
              </Field>
            ) : null}

            {builderIsDateSeries ? (
              <>
                <Field className="min-w-0">
                  <FieldLabel htmlFor="dashboard-date-field">
                    Date field
                  </FieldLabel>
                  <Select
                    id="dashboard-date-field"
                    className="min-h-11 w-full"
                    value={builderDateFieldId}
                    disabled={
                      duplicatePending ||
                      !builderModuleId ||
                      !builderDateFields.length
                    }
                    onValueChange={(value) => {
                      suppressInitialDefaultSelection();
                      setBuilderDateFieldId(value);
                    }}
                  >
                    <option value="">Choose a date field</option>
                    {builderDateFields.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name}
                      </option>
                    ))}
                  </Select>
                  <FieldDescription>
                    Date fields create daily aggregate values.
                  </FieldDescription>
                  {builderModuleId && !builderDateFields.length ? (
                    <FieldDescription>
                      This data source has no active date or datetime fields.
                    </FieldDescription>
                  ) : null}
                </Field>
                <Field className="min-w-0">
                  <FieldLabel htmlFor="dashboard-from-date">
                    Start date
                  </FieldLabel>
                  <Input
                    id="dashboard-from-date"
                    type="date"
                    required
                    disabled={duplicatePending}
                    className="min-h-11 w-full"
                    value={builderFromDate}
                    aria-describedby="dashboard-date-range-description"
                    onChange={(event) => {
                      suppressInitialDefaultSelection();
                      setBuilderFromDate(event.target.value);
                    }}
                  />
                </Field>
                <Field className="min-w-0">
                  <FieldLabel htmlFor="dashboard-to-date">End date</FieldLabel>
                  <Input
                    id="dashboard-to-date"
                    type="date"
                    required
                    disabled={duplicatePending}
                    className="min-h-11 w-full"
                    value={builderToDate}
                    aria-describedby="dashboard-date-range-description"
                    onChange={(event) => {
                      suppressInitialDefaultSelection();
                      setBuilderToDate(event.target.value);
                    }}
                  />
                  <FieldDescription id="dashboard-date-range-description">
                    {builderDateRangeDescription}
                  </FieldDescription>
                </Field>
              </>
            ) : null}
          </div>

          {catalogSourcesHasMore ? (
            <Button
              variant="outline"
              className="min-h-11 self-start"
              disabled={catalogLoadingMore}
              onClick={() => void loadMoreSources()}
            >
              {catalogLoadingMore
                ? "Loading data sources…"
                : "Load more data sources"}
            </Button>
          ) : null}
          {fieldsHasMore ? (
            <Button
              variant="outline"
              className="min-h-11 self-start"
              disabled={fieldsLoadingMore}
              onClick={() => void loadMoreFields()}
            >
              {fieldsLoadingMore ? "Loading fields…" : "Load more fields"}
            </Button>
          ) : null}
          {catalogError ? (
            <Alert role="alert" variant="destructive">
              {catalogError}
              <Button
                className="mt-3 min-h-11"
                variant="outline"
                onClick={retryCatalog}
              >
                Retry catalog
              </Button>
            </Alert>
          ) : null}
          <p role="status" className="text-muted-foreground text-sm">
            {draftWidgets.length} of 12 widgets used.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setWidgetDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              className="min-h-11"
              onClick={submitBuilderWidget}
              disabled={
                !builderCanAddWidget ||
                draftWidgets.length >= 12 ||
                duplicatePending ||
                savePending ||
                Boolean(restorePendingId)
              }
            >
              Add widget
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingNavigation !== null}
        onOpenChange={(open) => {
          if (
            !open &&
            !savePending &&
            !duplicatePending &&
            !archivePending &&
            !restorePendingId
          )
            setPendingNavigation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard unsaved Dashboard changes?
            </AlertDialogTitle>
            <AlertDialogDescription>
              You are moving away from this Dashboard while there are unsaved
              changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={
                savePending ||
                duplicatePending ||
                archivePending ||
                Boolean(restorePendingId)
              }
              onClick={() => setPendingNavigation(null)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={
                savePending ||
                duplicatePending ||
                archivePending ||
                Boolean(restorePendingId)
              }
              onClick={() => {
                const navigation = pendingNavigation;
                setPendingNavigation(null);
                if (!navigation) return;
                setDashboardDialogKind(null);
                setWidgetDialogOpen(false);
                setSelectedDashboard(null);
                setDashboardName("");
                setRefreshCadence("manual");
                setDraftWidgets([]);
                setActiveWidgetKey("");
                lastGoodSnapshotRef.current = null;
                setLastGoodSnapshot(null);
                setSnapshotError("");
                navigation.resume();
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
