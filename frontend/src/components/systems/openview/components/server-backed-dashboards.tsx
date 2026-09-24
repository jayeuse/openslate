"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
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
  type OpenViewDashboardChartConfig,
  type OpenViewDashboardWidget,
  type OpenViewDashboardWidgetInput,
} from "../adapters/dashboards-api";
import {
  queryOpenViewAggregateSnapshot,
  type OpenViewAggregateSnapshotResult,
} from "../adapters/analytics-api";
import {
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  type OpenViewDataSource,
  type OpenViewDataSourceField,
  type OpenViewQueryDefinition,
} from "../adapters/views-api";
import { parseOpenViewUrl, serializeOpenViewUrl } from "../domain/model";
import { OpenViewChartPreview } from "./chart-preview";

const PAGE_SIZE = 25;
const PREVIEW_POINTS = 12;
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
type BuilderAggregation = OpenViewDashboardChartConfig["query"]["aggregation"];

type DraftWidget = {
  key: string;
  config: OpenViewDashboardChartConfig;
};
type SnapshotState = {
  widgetKey: string;
  configSignature: string;
  result: OpenViewAggregateSnapshotResult;
};
type PendingNavigation = {
  href: string;
  resume: () => void;
} | null;

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function draftWidgetsFrom(dashboard: OpenViewDashboard): DraftWidget[] {
  return dashboard.widgets.map((widget) => ({
    key: widget.id,
    config: widget.config,
  }));
}

function widgetTitle(
  widget: OpenViewDashboardWidget | DraftWidget,
  fieldsByModule: Record<string, OpenViewDataSourceField[]>,
): string {
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
    (candidate) => candidate.id === query.dimension.fieldId,
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

function chartValues(
  result: OpenViewAggregateSnapshotResult,
  completeSeries: boolean,
) {
  const items = completeSeries
    ? result.items
    : result.items.slice(0, PREVIEW_POINTS);
  return items.map((item, index) => ({
    key: `dashboard-point-${index}`,
    label: item.label,
    value: Number.isFinite(Number(item.value)) ? Number(item.value) : 0,
  }));
}

function lastValidTablePage(currentPage: number, itemCount: number): number {
  return Math.min(
    currentPage,
    Math.max(0, Math.ceil(itemCount / PAGE_SIZE) - 1),
  );
}

function inputWidgets(widgets: DraftWidget[]): OpenViewDashboardWidgetInput[] {
  return widgets.map(({ config }) => ({ widgetType: "chart", config }));
}

function configSignature(widget: DraftWidget | undefined): string {
  return widget ? JSON.stringify(widget.config) : "";
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
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [routeClearPending, setRouteClearPending] = useState(false);
  const [dashboardError, setDashboardError] = useState("");
  const [notice, setNotice] = useState("");
  const [dashboardName, setDashboardName] = useState("");
  const [draftWidgets, setDraftWidgets] = useState<DraftWidget[]>([]);
  const [activeWidgetKey, setActiveWidgetKey] = useState("");
  const [savePending, setSavePending] = useState(false);
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
  const [builderChartType, setBuilderChartType] =
    useState<BuilderChartType>("bar");
  const [builderAggregation, setBuilderAggregation] =
    useState<BuilderAggregation>("count");
  const [builderDimensionId, setBuilderDimensionId] = useState("");
  const [builderMeasureId, setBuilderMeasureId] = useState("");
  const [builderDateFieldId, setBuilderDateFieldId] = useState("");
  const [builderFromDate, setBuilderFromDate] = useState("");
  const [builderToDate, setBuilderToDate] = useState("");
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState("");
  const [lastGoodSnapshot, setLastGoodSnapshot] =
    useState<SnapshotState | null>(null);
  const [tablePage, setTablePage] = useState(0);
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
      limit: PAGE_SIZE,
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
        setBuilderDimensionId((current) =>
          categoricalFields.some((field) => field.id === current)
            ? current
            : (categoricalFields[0]?.id ?? ""),
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
  const activeSignature = configSignature(activeWidget);
  const visibleSnapshot =
    activeWidget &&
    lastGoodSnapshot?.widgetKey === activeWidget.key &&
    lastGoodSnapshot.configSignature === activeSignature
      ? lastGoodSnapshot
      : null;
  const widgetsChanged = selectedDashboard
    ? JSON.stringify(
        selectedDashboard.widgets.map((widget) => widget.config),
      ) !== JSON.stringify(draftWidgets.map((widget) => widget.config))
    : draftWidgets.length > 0;
  const draftDirty = selectedDashboard
    ? dashboardName !== selectedDashboard.name || widgetsChanged
    : Boolean(dashboardName.trim()) || draftWidgets.length > 0;
  draftDirtyRef.current = draftDirty;
  const navigationGuard = useCallback(
    (href: string, resume: () => void) => {
      if (savePending || archivePending || restorePendingId) return false;
      if (!draftDirty) return true;
      if (
        typeof window !== "undefined" &&
        new URL(href, window.location.origin).href === window.location.href
      )
        return true;
      setPendingNavigation({ href, resume });
      return false;
    },
    [archivePending, draftDirty, restorePendingId, savePending],
  );
  useWorkspaceNavigationGuard(navigationGuard);
  useEffect(() => {
    void refreshDashboardDefault(true);
    return () => {
      dashboardDefaultRequestSequence.current += 1;
    };
  }, [refreshDashboardDefault]);
  const activeTitle = activeWidget
    ? widgetTitle(activeWidget, fieldsByModule)
    : "";
  const builderIsDateSeries = builderChartType === "line";
  const builderFields = (fieldsByModule[builderModuleId] ?? []).filter(
    isCategoricalField,
  );
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
  const builderDateRangeDescription =
    !builderFromDate || !builderToDate
      ? "Choose an inclusive start and end date spanning 1 to 366 days."
      : builderDateRangeDays === null
        ? "The end date must be on or after the start date."
        : builderDateRangeDays > 366
          ? "The inclusive date range cannot exceed 366 days."
          : `Both dates are included (${builderDateRangeDays} ${builderDateRangeDays === 1 ? "day" : "days"}).`;
  const activeIsDateSeries = activeWidget?.config.query.mode === "date_series";
  const chartPreview = visibleSnapshot
    ? chartValues(visibleSnapshot.result, Boolean(activeIsDateSeries))
    : [];
  const chartPointDescription = activeIsDateSeries
    ? `${chartPreview.length} daily points; point labels and dots are suppressed`
    : `${chartPreview.length} categories`;
  const snapshotRows = visibleSnapshot?.result.items ?? [];
  const tablePageCount = Math.max(
    1,
    Math.ceil(snapshotRows.length / PAGE_SIZE),
  );
  const boundedTablePage = Math.min(tablePage, tablePageCount - 1);
  const firstRowIndex = boundedTablePage * PAGE_SIZE;
  const visibleRows = snapshotRows.slice(
    firstRowIndex,
    firstRowIndex + PAGE_SIZE,
  );

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
    const signature = configSignature(activeWidget);
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
    setSnapshotLoading(true);
    setSnapshotError("");
    void queryOpenViewAggregateSnapshot(activeWidget.config.query)
      .then((result) => {
        if (!active || requestSequence.current !== sequence) return;
        const next = {
          widgetKey: activeWidget.key,
          configSignature: signature,
          result,
        };
        lastGoodSnapshotRef.current = next;
        setLastGoodSnapshot(next);
        setTablePage((current) =>
          lastValidTablePage(current, result.items.length),
        );
      })
      .catch((error: unknown) => {
        if (active && requestSequence.current === sequence)
          setSnapshotError(
            safeMessage(error, "This chart could not be refreshed."),
          );
      })
      .finally(() => {
        if (active && requestSequence.current === sequence)
          setSnapshotLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activePersistedWidget, activeWidget]);

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
    if (draftDirty) {
      setNotice("Save this Dashboard before switching to a new one.");
      return;
    }
    routeLoadSequence.current += 1;
    setSelectedDashboard(null);
    setDashboardName("");
    setDraftWidgets([]);
    setActiveWidgetKey("");
    lastGoodSnapshotRef.current = null;
    setLastGoodSnapshot(null);
    setSnapshotError("");
    updateDashboardUrl();
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
        limit: PAGE_SIZE,
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
    if (builderChartType === "line") return;
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
    const next = { key: crypto.randomUUID(), config };
    suppressInitialDefaultSelection();
    setDraftWidgets((current) => [...current, next]);
    setActiveWidgetKey(next.key);
    setNotice("");
  }

  function addLineChart() {
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
    const next = { key: crypto.randomUUID(), config };
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
            widgets,
          })
        : await createOpenViewDashboard({ name: dashboardName, widgets });
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
    if (!selectedDashboard || archivePending) return;
    setArchivePending(true);
    setDashboardError("");
    try {
      await archiveOpenViewDashboard({
        id: selectedDashboard.id,
        revision: selectedDashboard.revision,
      });
      setSelectedDashboard(null);
      setDashboardName("");
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
    if (!activeWidget || !activePersistedWidget) return;
    const signature = configSignature(activeWidget);
    const sequence = ++requestSequence.current;
    setSnapshotLoading(true);
    setSnapshotError("");
    void queryOpenViewAggregateSnapshot(activeWidget.config.query)
      .then((result) => {
        if (requestSequence.current !== sequence) return;
        const next = {
          widgetKey: activeWidget.key,
          configSignature: signature,
          result,
        };
        lastGoodSnapshotRef.current = next;
        setLastGoodSnapshot(next);
        setTablePage((current) =>
          lastValidTablePage(current, result.items.length),
        );
      })
      .catch((error: unknown) => {
        if (requestSequence.current === sequence)
          setSnapshotError(
            safeMessage(
              error,
              "Refresh failed; the last successful snapshot remains visible.",
            ),
          );
      })
      .finally(() => {
        if (requestSequence.current === sequence) setSnapshotLoading(false);
      });
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-muted-foreground text-sm">OpenView / Dashboards</p>
          <h1 id="dashboard-page-title" className="mt-1 text-2xl font-semibold">
            Private dashboards
          </h1>
          <p className="text-muted-foreground mt-2 max-w-3xl text-sm">
            Save chart layouts for your own use. This page currently supports
            live chart widgets only.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            disabled={
              savePending ||
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

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(15rem,0.7fr)_minmax(0,1.7fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>
              {showArchived ? "Archived dashboards" : "Your dashboards"}
            </CardTitle>
            <CardDescription>
              Only you can view these Dashboards.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {dashboardListLoading ? (
              <p role="status" className="text-muted-foreground text-sm">
                Loading Dashboards…
              </p>
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
            {!dashboardListLoading &&
            !dashboardListError &&
            dashboards.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {showArchived
                  ? "No archived Dashboards."
                  : "No Dashboards yet. Create one to get started."}
              </p>
            ) : null}
            <ul className="flex flex-col gap-2">
              {dashboards.map((dashboard) => (
                <li
                  key={dashboard.id}
                  className="flex flex-wrap items-center gap-2"
                >
                  <Button
                    variant={
                      selectedDashboard?.id === dashboard.id
                        ? "secondary"
                        : "outline"
                    }
                    className="min-h-11 min-w-0 flex-1 justify-start text-left"
                    disabled={
                      dashboardLoading ||
                      routeClearPending ||
                      savePending ||
                      archivePending ||
                      dashboardDefaultPending ||
                      Boolean(restorePendingId)
                    }
                    aria-current={
                      selectedDashboard?.id === dashboard.id
                        ? "page"
                        : undefined
                    }
                    onClick={() => {
                      if (
                        draftDirty &&
                        selectedDashboard?.id !== dashboard.id
                      ) {
                        setNotice(
                          "Save this Dashboard before switching to another one.",
                        );
                        return;
                      }
                      setNotice("");
                      updateDashboardUrl(dashboard.id);
                    }}
                  >
                    <span className="truncate">{dashboard.name}</span>
                  </Button>
                  {dashboardDefaultId === dashboard.id ? (
                    <Badge variant="secondary">Default</Badge>
                  ) : null}
                  {dashboard.isDeleted ? (
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
                  ) : null}
                </li>
              ))}
            </ul>
            {dashboardListHasMore ? (
              <Button
                variant="outline"
                className="min-h-11"
                disabled={dashboardListLoadingMore}
                onClick={() => void loadMoreDashboards()}
              >
                {dashboardListLoadingMore ? "Loading…" : "Load more Dashboards"}
              </Button>
            ) : null}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>
              {selectedDashboard?.name ?? "Create a private Dashboard"}
            </CardTitle>
            <CardDescription>
              {selectedDashboard
                ? `Revision ${selectedDashboard.revision} · private to your account`
                : "Only you can view this Dashboard."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-6">
            {dashboardLoading ? (
              <p role="status" className="text-muted-foreground text-sm">
                Loading Dashboard…
              </p>
            ) : null}
            <div className="flex flex-wrap items-end gap-3">
              <Field className="min-w-56 flex-1">
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
              <Button
                className="min-h-11"
                onClick={() => void saveDashboard()}
                disabled={
                  savePending ||
                  routeClearPending ||
                  archivePending ||
                  Boolean(restorePendingId) ||
                  !dashboardName.trim() ||
                  !draftDirty ||
                  selectedDashboard?.isDeleted
                }
              >
                {savePending ? "Saving…" : "Save Dashboard"}
              </Button>
              {selectedDashboard ? (
                <>
                  {!selectedDashboard.isDeleted ? (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={
                        dashboardDefaultLoading ||
                        dashboardDefaultPending ||
                        archivePending ||
                        Boolean(restorePendingId)
                      }
                      aria-busy={dashboardDefaultPending}
                      onClick={() => void toggleDashboardDefault()}
                    >
                      {dashboardDefaultPending
                        ? "Updating default…"
                        : dashboardDefaultId === selectedDashboard.id
                          ? "Clear default"
                          : "Set as default"}
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    className="min-h-11"
                    disabled={dashboardLoading}
                    onClick={() => void reloadSelectedDashboard(draftDirty)}
                  >
                    {draftDirty
                      ? "Discard draft and reload"
                      : "Reload saved Dashboard"}
                  </Button>
                  {selectedDashboard.isDeleted ? (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={
                        draftDirty ||
                        archivePending ||
                        Boolean(restorePendingId)
                      }
                      aria-busy={restorePendingId === selectedDashboard.id}
                      onClick={() => void restoreDashboard(selectedDashboard)}
                    >
                      Restore Dashboard
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={
                        archivePending || draftDirty || dashboardDefaultPending
                      }
                      onClick={() => void archiveDashboard()}
                    >
                      {archivePending ? "Archiving…" : "Archive Dashboard"}
                    </Button>
                  )}
                </>
              ) : null}
            </div>

            <section
              aria-labelledby="dashboard-chart-widgets"
              className="flex min-w-0 flex-col gap-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2
                  id="dashboard-chart-widgets"
                  className="text-lg font-semibold"
                >
                  Chart widgets
                </h2>
                <p role="status" className="text-muted-foreground text-sm">
                  {draftWidgets.length} of 12 chart widgets
                </p>
              </div>
              {!selectedDashboard?.isDeleted ? (
                <div className="grid min-w-0 gap-3 md:grid-cols-2 md:items-end xl:grid-cols-4">
                  <Field className="min-w-0">
                    <FieldLabel htmlFor="dashboard-module">Module</FieldLabel>
                    <Select
                      id="dashboard-module"
                      className="min-h-11 w-full"
                      value={builderModuleId}
                      onValueChange={(value) => {
                        suppressInitialDefaultSelection();
                        selectBuilderModule(value);
                        setBuilderDateFieldId("");
                        setBuilderMeasureId("");
                      }}
                    >
                      <option value="">Choose a module</option>
                      {catalogSources.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field className="min-w-0">
                    <FieldLabel htmlFor="dashboard-chart-type">
                      Chart type
                    </FieldLabel>
                    <Select
                      id="dashboard-chart-type"
                      className="min-h-11 w-full"
                      value={builderChartType}
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
                  <Field className="min-w-0">
                    <FieldLabel htmlFor="dashboard-aggregation">
                      Aggregation
                    </FieldLabel>
                    <Select
                      id="dashboard-aggregation"
                      className="min-h-11 w-full"
                      value={builderAggregation}
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
                  {builderAggregation !== "count" ? (
                    <Field className="min-w-0">
                      <FieldLabel htmlFor="dashboard-measure">
                        Numeric measure
                      </FieldLabel>
                      <Select
                        id="dashboard-measure"
                        className="min-h-11 w-full"
                        value={builderMeasureId}
                        disabled={
                          !builderModuleId || !builderNumericFields.length
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
                          Sum and average require a numeric field.
                        </FieldDescription>
                      ) : null}
                    </Field>
                  ) : null}
                  {!builderIsDateSeries ? (
                    <Field className="min-w-0">
                      <FieldLabel htmlFor="dashboard-dimension">
                        Group records by
                      </FieldLabel>
                      <Select
                        id="dashboard-dimension"
                        className="min-h-11 w-full"
                        value={builderDimensionId}
                        disabled={!builderModuleId || !builderFields.length}
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
                        Creates a categorical Count chart from live records.
                      </FieldDescription>
                    </Field>
                  ) : (
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
                            !builderModuleId || !builderDateFields.length
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
                          Date and date-time fields create daily aggregate
                          values.
                        </FieldDescription>
                      </Field>
                      <Field className="min-w-0">
                        <FieldLabel htmlFor="dashboard-from-date">
                          Start date
                        </FieldLabel>
                        <Input
                          id="dashboard-from-date"
                          type="date"
                          required
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
                        <FieldLabel htmlFor="dashboard-to-date">
                          End date
                        </FieldLabel>
                        <Input
                          id="dashboard-to-date"
                          type="date"
                          required
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
                  )}
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={
                      builderIsDateSeries ? addLineChart : addGroupedChart
                    }
                    disabled={
                      !builderIsDateSeries
                        ? !builderModuleId ||
                          !builderFields.some(
                            (field) => field.id === builderDimensionId,
                          ) ||
                          !builderMeasureValid ||
                          draftWidgets.length >= 12 ||
                          savePending ||
                          Boolean(restorePendingId)
                        : !builderModuleId ||
                          !builderDateField ||
                          !builderDateRangeValid ||
                          !builderMeasureValid ||
                          draftWidgets.length >= 12 ||
                          savePending ||
                          Boolean(restorePendingId)
                    }
                  >
                    {builderIsDateSeries
                      ? "Add line chart widget"
                      : builderChartType === "pie"
                        ? "Add pie chart widget"
                        : "Add chart widget"}
                  </Button>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Restore this Dashboard before editing its chart widgets.
                </p>
              )}
              {catalogSourcesHasMore ? (
                <Button
                  variant="outline"
                  className="min-h-11 self-start"
                  disabled={catalogLoadingMore}
                  onClick={() => void loadMoreSources()}
                >
                  {catalogLoadingMore
                    ? "Loading modules…"
                    : "Load more modules"}
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

              {draftWidgets.length ? (
                <ol className="flex min-w-0 flex-col gap-3">
                  {draftWidgets.map((widget, index) => {
                    const title = widgetTitle(widget, fieldsByModule);
                    const persisted = selectedDashboard?.widgets.some(
                      (candidate) => candidate.id === widget.key,
                    );
                    return (
                      <li
                        key={widget.key}
                        className="border-border flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--radius)] border p-3"
                      >
                        <Button
                          type="button"
                          variant={
                            activeWidgetKey === widget.key
                              ? "secondary"
                              : "outline"
                          }
                          className="min-h-11 min-w-0 flex-1 justify-start text-left"
                          aria-pressed={activeWidgetKey === widget.key}
                          onClick={() => setActiveWidgetKey(widget.key)}
                        >
                          {persisted
                            ? `View chart ${index + 1}: ${title}`
                            : `Chart ${index + 1}: ${title}`}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={
                            index === 0 ||
                            savePending ||
                            archivePending ||
                            Boolean(restorePendingId)
                          }
                          onClick={() => moveWidget(widget.key, -1)}
                          aria-label={`Move chart ${index + 1} up`}
                        >
                          Move up
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={
                            index === draftWidgets.length - 1 ||
                            savePending ||
                            archivePending ||
                            Boolean(restorePendingId)
                          }
                          onClick={() => moveWidget(widget.key, 1)}
                          aria-label={`Move chart ${index + 1} down`}
                        >
                          Move down
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={
                            savePending ||
                            archivePending ||
                            Boolean(restorePendingId) ||
                            selectedDashboard?.isDeleted
                          }
                          onClick={() => removeWidget(widget.key)}
                          aria-label={`Remove chart ${index + 1}`}
                        >
                          Remove
                        </Button>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Add a chart widget to this Dashboard. No sample records are
                  copied.
                </p>
              )}
            </section>

            {activeWidget ? (
              <section
                aria-labelledby="dashboard-chart-preview"
                className="border-border flex min-w-0 flex-col gap-4 border-t pt-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2
                      id="dashboard-chart-preview"
                      className="text-lg font-semibold"
                    >
                      {activeTitle}
                    </h2>
                    <p className="text-muted-foreground text-sm">
                      {activePersistedWidget
                        ? "One authorized complete aggregate snapshot for the selected widget."
                        : "Save this Dashboard to load a live snapshot for the widget."}
                    </p>
                  </div>
                  {activePersistedWidget ? (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={snapshotLoading}
                      onClick={refreshActiveSnapshot}
                    >
                      {snapshotLoading ? "Refreshing…" : "Refresh now"}
                    </Button>
                  ) : null}
                </div>
                {snapshotError ? (
                  <Alert role="alert" variant="destructive">
                    {snapshotError}
                    {visibleSnapshot
                      ? " The last successful snapshot remains visible."
                      : " Retry when the service is available."}
                    {activePersistedWidget && !snapshotLoading ? (
                      <Button
                        className="mt-3 min-h-11"
                        variant="outline"
                        onClick={refreshActiveSnapshot}
                      >
                        Retry chart
                      </Button>
                    ) : null}
                  </Alert>
                ) : null}
                {visibleSnapshot ? (
                  <>
                    <p role="status" className="text-muted-foreground text-sm">
                      {activeIsDateSeries
                        ? `Showing all ${snapshotRows.length} days in chronological order.`
                        : `Preview shows up to ${Math.min(PREVIEW_POINTS, snapshotRows.length)} of ${snapshotRows.length} chart buckets. The complete values remain in the table.`}
                    </p>
                    <div
                      role="group"
                      aria-label={`${activeTitle} chart preview, ${chartPointDescription}`}
                    >
                      <OpenViewChartPreview
                        data={chartPreview}
                        type={activeWidget.config.chartType}
                        valueLabel={
                          activeWidget.config.query.aggregation === "count"
                            ? "Records"
                            : activeWidget.config.query.aggregation
                        }
                        showLabels={false}
                        showLegend={false}
                        allowDecimals={
                          activeWidget.config.query.aggregation !== "count"
                        }
                        className="border-border/70 bg-muted/15 h-[18rem] w-full rounded-[var(--radius)] border p-3"
                      />
                    </div>
                    <div className="flex min-w-0 flex-col gap-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h3 className="font-semibold">
                            {activeIsDateSeries
                              ? "Complete date series data"
                              : "Complete aggregate data"}
                          </h3>
                          <p
                            role="status"
                            className="text-muted-foreground text-sm"
                          >
                            {snapshotRows.length
                              ? `${firstRowIndex + 1}–${Math.min(firstRowIndex + PAGE_SIZE, snapshotRows.length)} of ${snapshotRows.length} ${activeIsDateSeries ? "daily values" : "aggregate groups"}`
                              : `0 ${activeIsDateSeries ? "daily values" : "aggregate groups"}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            className="min-h-11"
                            disabled={boundedTablePage === 0}
                            onClick={() =>
                              setTablePage((page) => Math.max(0, page - 1))
                            }
                          >
                            Previous data page
                          </Button>
                          <Button
                            variant="outline"
                            className="min-h-11"
                            disabled={boundedTablePage + 1 >= tablePageCount}
                            onClick={() =>
                              setTablePage((page) =>
                                Math.min(tablePageCount - 1, page + 1),
                              )
                            }
                          >
                            Next data page
                          </Button>
                        </div>
                      </div>
                      <div className="min-w-0 overflow-x-auto">
                        <Table aria-label={`Complete data for ${activeTitle}`}>
                          <TableCaption>
                            Page {boundedTablePage + 1} of {tablePageCount}. The
                            table pages the complete authorized snapshot.
                          </TableCaption>
                          <TableHeader>
                            <TableRow>
                              <TableHead>
                                {activeIsDateSeries ? "Date" : "Group"}
                              </TableHead>
                              <TableHead>Value</TableHead>
                              <TableHead>Record count</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {visibleRows.map((item, index) => (
                              <TableRow
                                key={`${item.key ?? item.label}-${firstRowIndex + index}`}
                              >
                                <TableCell>{item.label}</TableCell>
                                <TableCell>{String(item.value)}</TableCell>
                                <TableCell>{item.recordCount}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  </>
                ) : snapshotLoading ? (
                  <p role="status" className="text-muted-foreground text-sm">
                    Loading the selected chart snapshot…
                  </p>
                ) : activePersistedWidget && !snapshotError ? (
                  <p className="text-muted-foreground text-sm">
                    No aggregate data is available yet.
                  </p>
                ) : null}
              </section>
            ) : null}
          </CardContent>
        </Card>
      </div>
      <AlertDialog
        open={pendingNavigation !== null}
        onOpenChange={(open) => {
          if (!open && !savePending && !archivePending && !restorePendingId)
            setPendingNavigation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard unsaved Dashboard changes?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your current Dashboard draft has unsaved changes. Continuing will
              discard them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={
                savePending || archivePending || Boolean(restorePendingId)
              }
              onClick={() => setPendingNavigation(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={
                savePending || archivePending || Boolean(restorePendingId)
              }
              onClick={() => {
                const transition = pendingNavigation;
                if (!transition) return;
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
