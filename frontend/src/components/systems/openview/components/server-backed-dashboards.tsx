"use client";

import {
  changeChartEditorWidgetType,
  editorFieldReference,
  newChartEditorDraft,
  isCategoricalField,
  type ChartSourceDraft,
} from "../domain/chart-query";
import { DashboardWidgetEditor } from "./dashboard-widget-editor";
import {
  queryDashboardWidgetData,
  resolveDashboardWidgetDefinition,
} from "../adapters/dashboard-queries";
import { getOpenViewChart, chartMatchesWidget } from "../adapters/charts-api";
import { ApiContractError, ApiError } from "@/lib/api";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { ChevronDown } from "lucide-react";
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
import { SearchSelect } from "@/components/ui/search-select";
import {
  useOpenViewDepartmentNames,
  useOpenViewDepartmentPicker,
  useOpenViewSource,
} from "../hooks/use-openview-catalog";
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
import { apiErrorMessage } from "@/lib/api-errors";
import { useQuery } from "@tanstack/react-query";
import { useOpenViewAccessDenied } from "../adapters/openview-access";
import { authMeOptions } from "../adapters/openview-queries";
import {
  canManageOpenView,
  managedDepartmentIds,
} from "../domain/manage-access";
import {
  archiveOpenViewDashboard,
  createOpenViewDashboard,
  getOpenViewDashboardConflict,
  restoreOpenViewDashboard,
  updateOpenViewDashboard,
  type OpenViewDashboard,
  type OpenViewDashboardWidgetInput,
  type OpenViewDashboardRefreshCadence,
  type OpenViewDashboardWidgetSize,
} from "../adapters/dashboards-api";
import {
  getOpenViewDataSourceField,
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  type OpenViewDataSource,
  type OpenViewDataSourceField,
} from "../adapters/views-api";
import { parseOpenViewUrl, serializeOpenViewUrl } from "../domain/model";
import {
  draftWidgetsFrom,
  inputWidgets,
  type DraftWidget,
  type DashboardWidgetData,
  dashboardWidgetEditorDraft,
} from "../domain/dashboard-draft";
import { DashboardWidgetGrid } from "./dashboard-widget-grid";
import { useDashboardResource } from "../hooks/use-dashboard-resource";

type PendingNavigation = {
  href: string;
  resume: () => void;
} | null;
type DashboardDialogKind = "new" | "settings" | null;

export default function ServerBackedDashboards() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  // A refused OpenView read anywhere hides Dashboards data too; the reads
  // report through the adapters (openview-access.ts).
  const accessDenied = useOpenViewAccessDenied();
  const urlState = parseOpenViewUrl(`${pathname}?${searchParams.toString()}`);
  const routeDashboardId =
    urlState.section === "dashboards" ? urlState.dashboard : undefined;
  const [showArchived, setShowArchived] = useState(false);
  const [pendingNavigation, setPendingNavigation] =
    useState<PendingNavigation>(null);
  const [selectedDashboard, setSelectedDashboard] =
    useState<OpenViewDashboard | null>(null);
  const [dashboardDialogKind, setDashboardDialogKind] =
    useState<DashboardDialogKind>(null);
  const dashboardBeforeNew = useRef<OpenViewDashboard | null>(null);
  const [widgetDialogOpen, setWidgetDialogOpen] = useState(false);
  const [dashboardReloading, setDashboardReloading] = useState(false);
  const [routeClearPending, setRouteClearPending] = useState(false);
  const [dashboardError, setDashboardError] = useState("");
  const [notice, setNotice] = useState("");
  const [dashboardName, setDashboardName] = useState("");
  const [refreshCadence, setRefreshCadence] =
    useState<OpenViewDashboardRefreshCadence>("manual");
  const [draftWidgets, setDraftWidgets] = useState<DraftWidget[]>([]);
  const [editingWidgetKey, setEditingWidgetKey] = useState<string | null>(null);
  const [builderSize, setBuilderSize] =
    useState<OpenViewDashboardWidgetSize>("M");
  const editorRead = useRef<AbortController | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [duplicatePending, setDuplicatePending] = useState(false);
  const [archivePending, setArchivePending] = useState(false);
  const [restorePendingId, setRestorePendingId] = useState("");
  // The department of a new Dashboard; a saved one keeps its own.
  const [newDepartmentId, setNewDepartmentId] = useState("");
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
  const [builder, setBuilder] = useState<ChartSourceDraft>({
    inline: newChartEditorDraft("", []),
    chartId: null,
  });
  const builderModuleId = builder.inline.moduleId;
  const builderSource = useOpenViewSource(catalogSources, builderModuleId);
  const builderReferenceIds =
    editingWidgetKey === null
      ? ""
      : [
          ...new Set(
            [
              ...builder.inline.definition.columns,
              ...builder.inline.definition.sort,
              ...builder.inline.definition.searchFields,
              ...builder.inline.filters,
              ...(builder.inline.mode === "records"
                ? []
                : [
                    builder.inline.measure,
                    builder.inline.dateField,
                    ...(builder.inline.mode === "groups"
                      ? [builder.inline.dimension]
                      : []),
                  ].filter((reference) => reference !== null)),
            ].map((reference) => reference.fieldId),
          ),
        ].join(",");
  const freshBuilderModule = useRef("");
  const [builderFieldsLoading, setBuilderFieldsLoading] = useState(false);
  const [builderPending, setBuilderPending] = useState(false);
  const [builderError, setBuilderError] = useState("");
  const [builderPreview, setBuilderPreview] = useState<{
    signature: string;
    data: DashboardWidgetData;
  } | null>(null);
  const builderRead = useRef<AbortController | null>(null);
  const fieldRequestSequence = useRef(0);
  const restorePendingRef = useRef("");
  const skipRouteLoadForId = useRef("");
  // Arriving with no Dashboard chosen opens the first one by position, once.
  const firstDashboardSettled = useRef(false);

  const resource = useDashboardResource(
    showArchived,
    routeDashboardId,
    routeClearPending,
  );
  const {
    dashboards,
    hasMore: dashboardListHasMore,
    loading: dashboardListLoading,
    loadingMore: dashboardListLoadingMore,
    error: dashboardListError,
    refreshList: refreshDashboardList,
    loadMore: loadMoreDashboards,
  } = resource;
  const dashboardLoading =
    dashboardReloading ||
    Boolean(
      routeDashboardId && !routeClearPending && resource.detail.isPending,
    );
  const dashboardPickerBusy =
    dashboardLoading ||
    routeClearPending ||
    savePending ||
    archivePending ||
    Boolean(restorePendingId);

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
            apiErrorMessage(
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
    const controller = new AbortController();
    const sequence = ++fieldRequestSequence.current;
    setFieldsLoadingMore(false);
    if (!builderModuleId) {
      setFieldsHasMore(false);
      setFieldOffset(0);
      return;
    }
    setCatalogError("");
    setFieldsHasMore(false);
    setFieldOffset(0);
    setBuilderFieldsLoading(true);
    void listOpenViewDataSourceFields(builderModuleId, {
      limit: 100,
      offset: 0,
    })
      .then(async (page) => {
        // An existing query can reference fields outside this bounded page.
        // Resolve only those IDs; never crawl or silently replace the query.
        const referenced = await Promise.all(
          builderReferenceIds
            .split(",")
            .filter((id) => id && !page.items.some((field) => field.id === id))
            .map((id) =>
              getOpenViewDataSourceField(
                builderModuleId,
                id,
                controller.signal,
              ),
            ),
        );
        if (!active || fieldRequestSequence.current !== sequence) return;
        setFieldsByModule((current) => ({
          ...current,
          [builderModuleId]: [...page.items, ...referenced],
        }));
        setFieldOffset(page.items.length);
        setFieldsHasMore(page.pagination.hasMore);
        if (freshBuilderModule.current === builderModuleId) {
          freshBuilderModule.current = "";
          const first = page.items.find(isCategoricalField);
          setBuilder((current) =>
            current.inline.moduleId === builderModuleId &&
            current.inline.mode === "groups" &&
            !current.inline.dimension &&
            first
              ? {
                  ...current,
                  inline: {
                    ...current.inline,
                    dimension: editorFieldReference(first),
                  },
                }
              : current,
          );
        }
        setBuilderFieldsLoading(false);
      })
      .catch((error: unknown) => {
        if (active && fieldRequestSequence.current === sequence) {
          setBuilderFieldsLoading(false);
          setCatalogError(
            apiErrorMessage(error, "The field catalog could not be loaded."),
          );
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [builderModuleId, builderReferenceIds, catalogRetry]);

  useEffect(() => {
    if (!routeDashboardId) {
      setRouteClearPending(false);
      return;
    }
    if (skipRouteLoadForId.current === routeDashboardId) {
      skipRouteLoadForId.current = "";
      return;
    }
    setSelectedDashboard(null);
    setDashboardName("");
    setDraftWidgets([]);
    setDashboardError("");
    setNotice("");
  }, [routeDashboardId]);

  const widgetsChanged = selectedDashboard
    ? JSON.stringify(inputWidgets(draftWidgetsFrom(selectedDashboard))) !==
      JSON.stringify(inputWidgets(draftWidgets))
    : draftWidgets.length > 0;
  const draftDirty = selectedDashboard
    ? dashboardName !== selectedDashboard.name ||
      refreshCadence !== selectedDashboard.refreshCadence ||
      widgetsChanged
    : Boolean(dashboardName.trim()) ||
      refreshCadence !== "manual" ||
      draftWidgets.length > 0;
  const incomingDashboard = resource.detail.data;
  const changedElsewhere = Boolean(
    incomingDashboard &&
    selectedDashboard &&
    incomingDashboard.id === selectedDashboard.id &&
    incomingDashboard.revision !== selectedDashboard.revision,
  );
  useEffect(() => {
    if (
      routeClearPending ||
      !routeDashboardId ||
      !incomingDashboard ||
      incomingDashboard.id !== routeDashboardId ||
      savePending ||
      duplicatePending ||
      archivePending ||
      restorePendingId
    )
      return;
    if (
      selectedDashboard?.id === incomingDashboard.id &&
      (draftDirty || selectedDashboard === incomingDashboard)
    )
      return;
    applyDashboard(incomingDashboard);
  }, [
    incomingDashboard,
    routeDashboardId,
    routeClearPending,
    selectedDashboard,
    draftDirty,
    savePending,
    duplicatePending,
    archivePending,
    restorePendingId,
  ]);
  useEffect(() => {
    if (resource.detail.error && !resource.detail.isFetching)
      setDashboardError(
        apiErrorMessage(
          resource.detail.error,
          "This Dashboard could not be loaded.",
        ),
      );
  }, [resource.detail.error, resource.detail.isFetching]);
  const firstDashboardId = dashboards[0]?.id;
  useEffect(() => {
    if (firstDashboardSettled.current || dashboardListLoading || showArchived)
      return;
    firstDashboardSettled.current = true;
    if (
      !firstDashboardId ||
      accessDenied ||
      routeDashboardId ||
      selectedDashboard ||
      dashboardDialogKind ||
      draftDirty
    )
      return;
    router.replace(
      serializeOpenViewUrl({
        section: "dashboards",
        dashboard: firstDashboardId,
      }) as Route,
      { scroll: false },
    );
  }, [
    accessDenied,
    dashboardDialogKind,
    dashboardListLoading,
    draftDirty,
    firstDashboardId,
    routeDashboardId,
    router,
    selectedDashboard,
    showArchived,
  ]);
  // Dashboards belong to departments. Readers of a department see its
  // Dashboards; only its managers create, change, archive or restore them.
  const identity = useQuery(authMeOptions());
  const managed = managedDepartmentIds(identity.data);
  const [departmentSearch, setDepartmentSearch] = useState("");
  const departmentNames = useOpenViewDepartmentNames([
    ...dashboards.map((dashboard) => dashboard.departmentId),
    ...(selectedDashboard ? [selectedDashboard.departmentId] : []),
    ...(newDepartmentId ? [newDepartmentId] : []),
  ]);
  const initialDepartmentId = [...departmentNames.keys()].find(
    (id) => managed === "all" || managed.has(id),
  );
  const selectedDepartmentId =
    selectedDashboard?.departmentId ??
    (newDepartmentId || initialDepartmentId || "");
  const departmentPicker = useOpenViewDepartmentPicker(
    departmentSearch,
    selectedDepartmentId,
  );
  const manageableDepartments = departmentPicker.items.filter(
    (department) => managed === "all" || managed.has(department.id),
  );
  const draftDepartmentId =
    selectedDepartmentId ||
    manageableDepartments[0]?.id ||
    (managed !== "all" ? [...managed][0] : "") ||
    "";
  const canCreateDashboards =
    managed === "all" ? departmentPicker.items.length > 0 : managed.size > 0;
  const canManageDashboard = selectedDashboard
    ? canManageOpenView(identity.data, selectedDashboard.departmentId)
    : canCreateDashboards;
  // A widget reads a data source of the Dashboard's own department.
  const departmentSources = catalogSources.filter(
    (source) => source.departmentId === draftDepartmentId,
  );
  if (
    builderSource?.departmentId === draftDepartmentId &&
    !departmentSources.some((source) => source.id === builderSource.id)
  )
    departmentSources.push(builderSource);
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
  const builderSignature = JSON.stringify(builder);
  const [refusedBuilderChartId, setRefusedBuilderChartId] = useState<
    string | null
  >(null);
  useEffect(() => {
    builderRead.current?.abort();
    setBuilderPending(false);
    setBuilderPreview(null);
    setBuilderError("");
    return () => builderRead.current?.abort();
  }, [builderSignature, widgetDialogOpen, routeDashboardId, accessDenied]);
  const withdrawBuilderPreview = useCallback(() => {
    builderRead.current?.abort();
    setBuilderPending(false);
    setBuilderPreview(null);
  }, []);
  useEffect(() => {
    const suspend = () => {
      if (document.hidden) withdrawBuilderPreview();
    };
    document.addEventListener("visibilitychange", suspend);
    return () => document.removeEventListener("visibilitychange", suspend);
  }, [withdrawBuilderPreview]);

  useEffect(() => {
    if (!widgetDialogOpen) {
      editorRead.current?.abort();
      setEditorLoading(false);
    }
  }, [widgetDialogOpen]);
  useEffect(
    () => () => editorRead.current?.abort(),
    [routeDashboardId, accessDenied],
  );

  function updateDashboardUrl(id?: string) {
    if (!id && routeClearPending) return;
    setRouteClearPending(!id && Boolean(routeDashboardId));
    router.push(
      serializeOpenViewUrl({ section: "dashboards", dashboard: id }) as Route,
      { scroll: false },
    );
  }

  function selectBuilderModule(moduleId: string) {
    if (moduleId === builderModuleId) return;
    fieldRequestSequence.current += 1;
    setFieldsLoadingMore(false);
    setFieldOffset(0);
    setFieldsHasMore(false);
    freshBuilderModule.current = moduleId;
    setBuilder({
      inline: newChartEditorDraft(moduleId, fieldsByModule[moduleId] ?? []),
      chartId: null,
    });
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
    selectBuilderModule(widgets[0]?.config?.query.moduleId ?? "");
  }

  function beginNewDashboard() {
    firstDashboardSettled.current = true;
    if (selectedDashboard && draftDirty) {
      setNotice("Save this Dashboard before switching to a new one.");
      return;
    }
    dashboardBeforeNew.current = selectedDashboard;
    if (selectedDashboard || routeDashboardId) {
      setSelectedDashboard(null);
      setDashboardName("");
      setRefreshCadence("manual");
      setDraftWidgets([]);
      updateDashboardUrl();
    }
    setNotice("");
    setDashboardDialogKind("new");
  }

  function cancelNewDashboard() {
    if (dashboardBeforeNew.current) {
      applyDashboard(dashboardBeforeNew.current);
      updateDashboardUrl(dashboardBeforeNew.current.id);
    } else {
      setDashboardName("");
      setRefreshCadence("manual");
      setDraftWidgets([]);
    }
    dashboardBeforeNew.current = null;
    setDashboardDialogKind(null);
  }

  function chooseDashboard(dashboardId: string) {
    if (!dashboardId || dashboardId === selectedDashboard?.id) return;
    firstDashboardSettled.current = true;
    if (draftDirty) {
      setNotice("Save this Dashboard before switching to another one.");
      return;
    }
    setNotice("");
    updateDashboardUrl(dashboardId);
  }

  function beginAddWidget(saved: boolean) {
    editorRead.current?.abort();
    setEditorLoading(false);
    setEditingWidgetKey(null);
    setBuilderSize("M");
    const moduleId = departmentSources[0]?.id ?? "";
    freshBuilderModule.current = moduleId;
    setBuilder({
      inline: newChartEditorDraft(moduleId, fieldsByModule[moduleId] ?? []),
      chartId: saved ? "" : null,
    });
    setRefusedBuilderChartId(null);
    setWidgetDialogOpen(true);
  }

  async function beginEditWidget(widget: DraftWidget) {
    if (
      !canManageDashboard ||
      savePending ||
      duplicatePending ||
      selectedDashboard?.isDeleted
    )
      return;
    editorRead.current?.abort();
    setEditingWidgetKey(widget.key);
    setBuilderSize(widget.size ?? "M");
    setBuilder({
      inline: widget.config
        ? dashboardWidgetEditorDraft(widget, widget.config)
        : changeChartEditorWidgetType(
            newChartEditorDraft("", []),
            widget.widgetType,
            [],
          ),
      chartId: widget.chartId ?? null,
    });
    setRefusedBuilderChartId(null);
    setWidgetDialogOpen(true);
    setEditorLoading(true);
    setBuilderError("");
    const controller = new AbortController();
    editorRead.current = controller;
    try {
      const resolved = await resolveDashboardWidgetDefinition(
        widget,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      setBuilder({
        inline: dashboardWidgetEditorDraft(widget, resolved.config),
        chartId: widget.chartId ?? null,
      });
      // Read current field metadata, even when the previous dialog used this module.
      setCatalogRetry((value) => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (widget.chartId) setRefusedBuilderChartId(widget.chartId);
        setBuilderError(
          apiErrorMessage(
            error,
            "This widget cannot be edited right now. Your Dashboard draft is retained; retry the widget.",
          ),
        );
      }
    } finally {
      if (!controller.signal.aborted) setEditorLoading(false);
    }
  }

  async function submitBuilderWidget(input: OpenViewDashboardWidgetInput) {
    if (
      builderPending ||
      editorLoading ||
      (editingWidgetKey === null && draftWidgets.length >= 12)
    )
      return;
    const controller = new AbortController();
    builderRead.current?.abort();
    builderRead.current = controller;
    setBuilderPending(true);
    setBuilderError("");
    try {
      if (input.chartId != null) {
        const chart = await getOpenViewChart(input.chartId, controller.signal);
        if (!chartMatchesWidget(chart, input.widgetType))
          throw new ApiContractError();
      }
      controller.signal.throwIfAborted();
      const next: DraftWidget = {
        ...input,
        size: builderSize,
        key: editingWidgetKey ?? crypto.randomUUID(),
      };
      setDraftWidgets((current) =>
        editingWidgetKey === null
          ? [...current, next]
          : current.map((widget) =>
              widget.key === editingWidgetKey ? next : widget,
            ),
      );
      setNotice("");
      setWidgetDialogOpen(false);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (input.chartId) setRefusedBuilderChartId(input.chartId);
        setBuilderError(
          apiErrorMessage(
            error,
            "Saved Chart is unavailable. Retry or choose another source.",
          ),
        );
      }
    } finally {
      if (!controller.signal.aborted) setBuilderPending(false);
    }
  }

  async function previewBuilder(input: OpenViewDashboardWidgetInput) {
    if (builderPending || editorLoading || accessDenied || document.hidden)
      return;
    const controller = new AbortController();
    builderRead.current?.abort();
    builderRead.current = controller;
    setBuilderPending(true);
    setBuilderError("");
    setBuilderPreview(null);
    try {
      const data = await queryDashboardWidgetData(
        input,
        0,
        5,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      setBuilderPreview({ signature: builderSignature, data });
    } catch (error) {
      if (!controller.signal.aborted) {
        if (
          input.chartId &&
          (error instanceof ApiContractError ||
            (error instanceof ApiError &&
              error.code === "chart_source_unavailable"))
        )
          setRefusedBuilderChartId(input.chartId);
        setBuilderError(
          apiErrorMessage(
            error,
            "Preview is unavailable. Your draft is retained; retry.",
          ),
        );
      }
    } finally {
      if (!controller.signal.aborted) setBuilderPending(false);
    }
  }

  function toggleArchivedList() {
    if (draftDirty) {
      setNotice("Save this Dashboard before changing the list view.");
      return;
    }
    firstDashboardSettled.current = true;
    setShowArchived((value) => !value);
    if (selectedDashboard || routeDashboardId) {
      setSelectedDashboard(null);
      setDashboardName("");
      setRefreshCadence("manual");
      setDraftWidgets([]);
      updateDashboardUrl();
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
        apiErrorMessage(error, "More data sources could not be loaded."),
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
        [moduleId]: [
          ...(current[moduleId] ?? []),
          ...page.items.filter(
            (field) =>
              !current[moduleId]?.some((existing) => existing.id === field.id),
          ),
        ],
      }));
      setFieldOffset(offset + page.items.length);
      setFieldsHasMore(page.pagination.hasMore);
    } catch (error) {
      if (fieldRequestSequence.current !== sequence) return;
      setCatalogError(
        apiErrorMessage(error, "More fields could not be loaded."),
      );
    } finally {
      if (fieldRequestSequence.current === sequence)
        setFieldsLoadingMore(false);
    }
  }

  function removeWidget(key: string) {
    const next = draftWidgets.filter((widget) => widget.key !== key);
    setDraftWidgets(next);
  }

  function moveWidget(key: string, direction: -1 | 1) {
    const index = draftWidgets.findIndex((widget) => widget.key === key);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= draftWidgets.length) return;
    const next = [...draftWidgets];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(nextIndex, 0, moved);
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
            departmentId: draftDepartmentId,
            name: dashboardName,
            refreshCadence,
            widgets,
          });
      resource.remember(saved);
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
          apiErrorMessage(
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
        departmentId: selectedDashboard.departmentId,
        position: selectedDashboard.position,
        name: `Copy of ${selectedDashboard.name}`.slice(0, 200),
        refreshCadence: selectedDashboard.refreshCadence,
        widgets: inputWidgets(draftWidgetsFrom(selectedDashboard)),
      });
      resource.remember(duplicate);
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
      setNotice("Dashboard duplicated. The original is unchanged.");
    } catch (error) {
      setDashboardError(
        apiErrorMessage(error, "The Dashboard could not be duplicated."),
      );
    } finally {
      setDuplicatePending(false);
    }
  }

  async function reloadSelectedDashboard(discardDraft = false) {
    if (!selectedDashboard || (draftDirty && !discardDraft) || dashboardLoading)
      return;
    setDashboardReloading(true);
    setDashboardError("");
    try {
      applyDashboard(await resource.reload(selectedDashboard.id));
      setNotice("Dashboard reloaded.");
    } catch (error) {
      setDashboardError(
        apiErrorMessage(error, "The Dashboard could not be reloaded."),
      );
    } finally {
      setDashboardReloading(false);
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
      refreshDashboardList();
      setNotice("Dashboard archived.");
      updateDashboardUrl();
    } catch (error) {
      const conflict = getOpenViewDashboardConflict(error);
      setDashboardError(
        conflict?.message ??
          apiErrorMessage(error, "The Dashboard could not be archived."),
      );
    } finally {
      setArchivePending(false);
    }
  }

  async function restoreDashboard(dashboard: OpenViewDashboard) {
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
      resource.remember(restored);
      applyDashboard(restored);
      refreshDashboardList();
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
          apiErrorMessage(error, "The Dashboard could not be restored."),
      );
    } finally {
      restorePendingRef.current = "";
      setRestorePendingId("");
    }
  }

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
            Dashboards
          </h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            Keep useful live results together. Each Dashboard belongs to a
            department, and everyone who can read the department sees it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canCreateDashboards ? (
            <Button
              variant="outline"
              className="min-h-11"
              disabled={
                savePending ||
                duplicatePending ||
                archivePending ||
                Boolean(restorePendingId)
              }
              onClick={beginNewDashboard}
            >
              New Dashboard
            </Button>
          ) : null}
          <Button
            variant="outline"
            className="min-h-11"
            disabled={
              savePending ||
              duplicatePending ||
              archivePending ||
              Boolean(restorePendingId)
            }
            onClick={toggleArchivedList}
          >
            {showArchived ? "Show active" : "Show archived"}
          </Button>
        </div>
      </header>

      {notice ? <Alert role="status">{notice}</Alert> : null}
      {draftDirty && changedElsewhere && !accessDenied ? (
        <Alert role="status">Changed by someone else — review latest</Alert>
      ) : null}
      {dashboardError ? (
        <Alert role="alert" variant="destructive">
          {dashboardError}
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

      {/* A refused OpenView read hides every Dashboard, widget, and data
          source until an authorized read succeeds; drafts stay in state. */}
      {accessDenied ? (
        <Alert role="alert" variant="destructive">
          OpenView data is unavailable. Sign in or ask for access, then retry.
          <Button
            className="mt-3 min-h-11"
            variant="outline"
            onClick={() => {
              // Retry every read the section shows, including the active
              // widget whose refusal may have set the latch.
              refreshDashboardList();
              retryCatalog();
            }}
          >
            Retry
          </Button>
        </Alert>
      ) : (
        <>
          <section
            aria-label="Dashboard context"
            className="border-border bg-card grid min-w-0 gap-4 rounded-[var(--radius)] border p-4 lg:grid-cols-[minmax(0,1fr)_auto]"
          >
            <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(13rem,0.8fr)_minmax(0,1fr)] sm:items-end">
              <div className="min-w-0">
                <h2 className="mb-1 text-sm font-medium">
                  {showArchived
                    ? "Archived dashboards"
                    : "Department dashboards"}
                </h2>
                <Field className="min-w-0">
                  <FieldLabel htmlFor="dashboard-context">Dashboard</FieldLabel>
                  {/* Native disabled only before the first list; a busy picker
                      keeps keyboard focus (disabling a focused control drops it)
                      and ignores changes until the pending work ends. */}
                  <Select
                    id="dashboard-context"
                    className="min-h-11 w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                    value={selectedDashboard?.id ?? ""}
                    disabled={dashboardListLoading}
                    aria-disabled={dashboardPickerBusy || undefined}
                    onValueChange={(id) => {
                      if (!dashboardPickerBusy) chooseDashboard(id);
                    }}
                  >
                    <option value="">
                      {showArchived
                        ? "Choose an archived Dashboard"
                        : "Choose a Dashboard"}
                    </option>
                    {dashboardChoices.map((dashboard) => (
                      <option key={dashboard.id} value={dashboard.id}>
                        {dashboard.name}
                        {departmentNames.get(dashboard.departmentId)
                          ? ` · ${departmentNames.get(dashboard.departmentId)}`
                          : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2
                    data-slot="section-title"
                    className="truncate text-base font-semibold"
                  >
                    {selectedDashboard
                      ? dashboardName || selectedDashboard.name
                      : dashboardName || "No dashboard selected"}
                  </h2>
                  {selectedDashboard ? (
                    <>
                      <Badge variant="outline">
                        {departmentNames.get(selectedDashboard.departmentId) ??
                          "Department"}
                      </Badge>
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
                      ". Shared with everyone who can read this department."
                    : dashboardName || draftWidgets.length
                      ? "Unsaved draft · " + cadenceDescription
                      : "Choose a Dashboard."}
                </p>
              </div>
            </div>

            <div className="flex min-w-0 flex-wrap items-end gap-2">
              {draftDirty && canManageDashboard ? (
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
              {canManageDashboard ? (
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
                    {canManageDashboard ? (
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
                    ) : null}
                    {selectedDashboard && canManageDashboard ? (
                      <DropdownMenuSeparator />
                    ) : null}
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
                          {duplicatePending
                            ? "Duplicating…"
                            : "Duplicate Dashboard"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="min-h-11"
                          disabled={dashboardLoading || duplicatePending}
                          onClick={() =>
                            void reloadSelectedDashboard(draftDirty)
                          }
                        >
                          {draftDirty
                            ? "Discard draft and reload"
                            : "Reload saved Dashboard"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="min-h-11"
                          disabled={
                            archivePending || duplicatePending || draftDirty
                          }
                          onClick={() => void archiveDashboard()}
                        >
                          {archivePending ? "Archiving…" : "Archive Dashboard"}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                    {selectedDashboard?.isDeleted && canManageDashboard ? (
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
              ) : selectedDashboard && !selectedDashboard.isDeleted ? (
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={dashboardLoading}
                  onClick={() => void reloadSelectedDashboard(false)}
                >
                  Reload saved Dashboard
                </Button>
              ) : null}
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

          <DashboardWidgetGrid
            key={selectedDashboard?.id ?? "draft"}
            dashboard={
              selectedDashboard?.id === routeDashboardId
                ? selectedDashboard
                : null
            }
            widgets={draftWidgets}
            dirty={draftDirty}
            loading={dashboardLoading}
            canManage={canManageDashboard}
            pending={
              savePending ||
              duplicatePending ||
              archivePending ||
              Boolean(restorePendingId)
            }
            onAdd={beginAddWidget}
            onEdit={(widget) => void beginEditWidget(widget)}
            onMove={moveWidget}
            onRemove={removeWidget}
          />

          <Dialog
            open={dashboardDialogKind !== null}
            onOpenChange={(open) => {
              if (!open) {
                if (dashboardDialogKind === "new") cancelNewDashboard();
                else setDashboardDialogKind(null);
              }
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
                  The department, name and refresh cadence stay in your draft
                  until you save this Dashboard.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-2 grid gap-4 sm:grid-cols-2">
                <Field className="min-w-0 sm:col-span-2">
                  <SearchSelect
                    id="dashboard-department"
                    label="Department"
                    value={draftDepartmentId}
                    options={manageableDepartments.map((department) => ({
                      value: department.id,
                      label: department.name,
                    }))}
                    selectedOption={
                      departmentPicker.selected
                        ? {
                            value: departmentPicker.selected.id,
                            label: departmentPicker.selected.name,
                          }
                        : departmentNames.has(draftDepartmentId)
                          ? {
                              value: draftDepartmentId,
                              label: departmentNames.get(draftDepartmentId)!,
                            }
                          : undefined
                    }
                    disabled={
                      Boolean(selectedDashboard) ||
                      draftWidgets.length > 0 ||
                      savePending
                    }
                    search={departmentSearch}
                    onSearchChange={setDepartmentSearch}
                    loading={departmentPicker.loading}
                    error={departmentPicker.error}
                    onRetry={departmentPicker.retry}
                    hasMore={departmentPicker.hasMore}
                    onLoadMore={() => void departmentPicker.loadMore()}
                    loadingMore={departmentPicker.loadingMore}
                    onValueChange={(value) => {
                      setNewDepartmentId(value);
                      selectBuilderModule("");
                    }}
                  />
                  <FieldDescription>
                    {selectedDashboard
                      ? "A Dashboard stays in its department."
                      : draftWidgets.length
                        ? "Remove the widgets to choose another department."
                        : "Widgets can read only this department's data."}
                  </FieldDescription>
                </Field>
                <Field className="min-w-0 sm:col-span-2">
                  <FieldLabel htmlFor="dashboard-name">
                    Dashboard name
                  </FieldLabel>
                  <Input
                    id="dashboard-name"
                    maxLength={200}
                    value={dashboardName}
                    onChange={(event) => {
                      setDashboardName(event.target.value);
                    }}
                    disabled={
                      selectedDashboard?.isDeleted ||
                      savePending ||
                      archivePending ||
                      Boolean(restorePendingId)
                    }
                  />
                  <FieldDescription>
                    Everyone who can read the department sees this name.
                  </FieldDescription>
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
                      setRefreshCadence(
                        value as OpenViewDashboardRefreshCadence,
                      );
                    }}
                  >
                    <option value="manual">Manual</option>
                    <option value="one-minute">Every minute</option>
                    <option value="five-minutes">Every five minutes</option>
                  </Select>
                  <FieldDescription>
                    Automatic refresh runs only while this page is visible and
                    this Dashboard has no unsaved changes.
                  </FieldDescription>
                </Field>
              </div>
              <DialogFooter>
                {dashboardDialogKind === "new" ? (
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={cancelNewDashboard}
                  >
                    Cancel
                  </Button>
                ) : null}
                <Button
                  variant={
                    dashboardDialogKind === "new" ? "default" : "outline"
                  }
                  className="min-h-11"
                  onClick={() => {
                    dashboardBeforeNew.current = null;
                    setDashboardDialogKind(null);
                  }}
                >
                  {dashboardDialogKind === "new" ? "Continue" : "Done"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <DashboardWidgetEditor
            open={widgetDialogOpen}
            onOpenChange={setWidgetDialogOpen}
            editing={editingWidgetKey !== null}
            value={builder}
            size={builderSize}
            onSizeChange={setBuilderSize}
            onTypeChange={(type) =>
              setBuilder({
                ...builder,
                chartId: builder.chartId === null ? null : "",
                inline: changeChartEditorWidgetType(
                  builder.inline,
                  type,
                  fieldsByModule[builderModuleId] ?? [],
                ),
              })
            }
            onChange={(next) => {
              setRefusedBuilderChartId(null);
              if (next.inline.moduleId !== builderModuleId)
                freshBuilderModule.current = next.inline.moduleId;
              setBuilder(next);
            }}
            busy={builderPending}
            sourceLoading={editorLoading}
            disabled={
              savePending || duplicatePending || Boolean(restorePendingId)
            }
            widgetCount={draftWidgets.length}
            refusedChartId={refusedBuilderChartId}
            onRetrySource={() => setRefusedBuilderChartId(null)}
            onUnavailable={withdrawBuilderPreview}
            error={builderError}
            preview={builderPreview}
            onPreview={(input) => void previewBuilder(input)}
            onApply={(input) => void submitBuilderWidget(input)}
            fieldsByModule={fieldsByModule}
            catalog={{
              sources: departmentSources,
              sourcesLoading: false,
              sourcesError: "",
              sourcesHasMore: catalogSourcesHasMore,
              fields: fieldsByModule[builderModuleId] ?? [],
              fieldsLoading: builderFieldsLoading,
              fieldsError: catalogError,
              fieldsHasMore,
              metadataError: "",
              metadataRetryTarget: null,
              metadataLoading: catalogLoadingMore || fieldsLoadingMore,
              sourceName:
                departmentSources.find(
                  (source) => source.id === builderModuleId,
                )?.name ?? "Data source",
            }}
            actions={{
              retryCatalog,
              retryFields: retryCatalog,
              loadMoreSources,
              loadMoreFields,
            }}
          />
        </>
      )}

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
