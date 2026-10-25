"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  LayoutGrid,
  MoreHorizontal,
  Plus,
  RefreshCw,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DialogFrameFooter,
  DialogFrameHeader,
  dialogFrameContentClass,
} from "@/components/ui/dialog-frame";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { departmentNavigationOptions } from "@/components/department-navigation";
import {
  dashboardHref,
  departmentNavigation,
} from "@/components/department-navigation-model";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";
import {
  dashboardKeys,
  dashboardListOptions,
} from "../adapters/dashboard-queries";
import {
  archiveOpenViewDashboard,
  createOpenViewDashboard,
  getOpenViewDashboardConflict,
  restoreOpenViewDashboard,
  updateOpenViewDashboard,
  type OpenViewDashboard,
  type OpenViewDashboardRefreshCadence,
} from "../adapters/dashboards-api";
import { getOpenViewDashboardLayoutIssues } from "../adapters/dashboard-layout-issues";
import { useOpenViewAccessDenied } from "../adapters/openview-access";
import {
  authMeOptions,
  catalogFirstPageOptions,
} from "../adapters/openview-queries";
import { useDepartmentDashboards } from "../hooks/use-dashboard-resource";
import {
  useDashboardAggregateSnapshots,
  useDashboardVisibility,
} from "../hooks/use-dashboard-snapshot";
import {
  configSignature,
  draftWidgetKind,
  draftWidgetsFrom,
  inputWidgets,
  type DraftWidget,
} from "../domain/dashboard-draft";
import {
  PRESETS,
  SIZE_RULES,
  firstFreePlacement,
  freeCells,
  freeSpaceAt,
  layoutIssues,
  sizesAt,
  type GridItem,
  type Placement,
  type Preset,
  type WidgetKind,
} from "../domain/dashboard-grid";
import { canManageOpenView } from "../domain/manage-access";
import { parseOpenViewUrl, serializeOpenViewUrl } from "../domain/model";
import {
  DashboardChartBuilder,
  type BuilderRequest,
  type BuilderResult,
} from "./dashboard-chart-builder";
import { DashboardLayout, type LayoutSpace } from "./dashboard-layout";

const WIDE_QUERY = "(min-width: 64rem)";
const NARROW_QUERY = "(max-width: 47.99rem)";

function subscribeQuery(query: string) {
  return (onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  };
}
const subscribeWide = subscribeQuery(WIDE_QUERY);
const subscribeNarrow = subscribeQuery(NARROW_QUERY);

/** Edit mode works from 1024px (BD7); phones stack the widgets (BD12). */
function useScreen() {
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
  return { wide, narrow };
}

/** The newest snapshot of a dashboard, for "Refreshed 2 min ago". */
function useRefreshedAt(dashboardId: string) {
  const client = useQueryClient();
  const cache = client.getQueryCache();
  return useSyncExternalStore(
    (onChange) => cache.subscribe(onChange),
    () =>
      Math.max(
        0,
        ...cache
          .findAll({ queryKey: dashboardKeys.dashboardSnapshots(dashboardId) })
          .map((query) => query.state.dataUpdatedAt),
      ),
    () => 0,
  );
}

function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

function refreshedText(at: number, now: number) {
  if (!at) return "Not refreshed yet";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "Refreshed just now";
  if (minutes < 60) return `Refreshed ${minutes} min ago`;
  return `Refreshed ${Math.floor(minutes / 60)} h ago`;
}

const CADENCE_TEXT: Record<OpenViewDashboardRefreshCadence, string> = {
  manual: "refreshes when you ask",
  "one-minute": "every minute",
  "five-minutes": "every 5 minutes",
};

type LayoutEdit = {
  /** null: the department has no dashboard yet; Save layout creates it. */
  dashboardId: string | null;
  revision: number | null;
  widgets: DraftWidget[];
  spaces: LayoutSpace[];
  /** Kinds chosen in this edit (a saved chart's kind is known from its read). */
  kinds: Map<string, WidgetKind>;
  base: string;
};

function layoutSignature(widgets: readonly DraftWidget[]) {
  return JSON.stringify(
    widgets.map((widget) => [
      widget.key,
      configSignature(widget),
      widget.placement,
    ]),
  );
}

type PendingNavigation = { href: string; resume: () => void } | null;

export default function ServerBackedDashboards() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const client = useQueryClient();
  const accessDenied = useOpenViewAccessDenied();
  const urlState = parseOpenViewUrl(`${pathname}?${searchParams.toString()}`);
  const fromCharts = searchParams.get("section") === "charts";
  const departmentId = fromCharts ? undefined : urlState.department;
  const dashboardId = fromCharts ? undefined : urlState.dashboard;
  const savedListRequested =
    fromCharts || searchParams.get("builder") === "saved";

  const departmentsQuery = useQuery(departmentNavigationOptions());
  const modulesQuery = useQuery(catalogFirstPageOptions());
  const sources = modulesQuery.data?.items ?? [];
  const departmentNames = new Map(
    (departmentsQuery.data?.items ?? []).map((item) => [item.id, item.name]),
  );
  const readable =
    departmentsQuery.data && modulesQuery.data
      ? departmentNavigation(
          departmentsQuery.data.items,
          modulesQuery.data.items,
        )
      : null;
  const identity = useQuery(authMeOptions());
  const resource = useDepartmentDashboards(departmentId, dashboardId);
  const shown = resource.shown;
  const effectiveDepartmentId = departmentId ?? shown?.departmentId ?? "";
  const departmentName =
    departmentNames.get(effectiveDepartmentId) ?? "Department";
  const canManage = canManageOpenView(identity.data, effectiveDepartmentId);
  const { wide, narrow } = useScreen();

  // A dashboard page names its department in the address, so the sidebar and
  // the breadcrumb follow it: the first readable department, or the one a
  // dashboard link belongs to. The old Charts address opens the saved charts.
  const firstDepartmentId = readable?.[0]?.id;
  useEffect(() => {
    if (departmentId) return;
    const target = dashboardId ? shown?.departmentId : firstDepartmentId;
    if (!target) return;
    const href = serializeOpenViewUrl({
      section: "dashboards",
      department: target,
      dashboard: dashboardId,
    });
    router.replace(
      (savedListRequested ? `${href}&builder=saved` : href) as Route,
      { scroll: false },
    );
  }, [
    dashboardId,
    departmentId,
    firstDepartmentId,
    router,
    savedListRequested,
    shown?.departmentId,
  ]);

  const [edit, setEdit] = useState<LayoutEdit | null>(null);
  const [issues, setIssues] = useState<Map<string, string[]>>(new Map());
  const [builder, setBuilder] = useState<
    | (BuilderRequest & {
        anchor: Placement | null;
        spaceKey?: string;
        editKey?: string;
      })
    | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [presetChoice, setPresetChoice] = useState<Preset | null>(null);
  const [pendingNavigation, setPendingNavigation] =
    useState<PendingNavigation>(null);

  const viewWidgets = shown ? draftWidgetsFrom(shown) : [];
  const widgets = edit ? edit.widgets : viewWidgets;
  const dirty = Boolean(
    edit && (layoutSignature(edit.widgets) !== edit.base || edit.spaces.length),
  );
  const visible = useDashboardVisibility();
  const editShown =
    edit && edit.dashboardId === shown?.id ? shown : edit ? null : shown;
  const aggregate = useDashboardAggregateSnapshots(
    editShown ?? null,
    widgets,
    visible,
    Boolean(edit),
  );
  const kinds = new Map<string, WidgetKind>(
    widgets.map((widget) => [
      widget.key,
      edit?.kinds.get(widget.key) ??
        draftWidgetKind(
          widget,
          aggregate.reads.get(widget.key)?.snapshot?.data.config,
        ),
    ]),
  );
  const items: GridItem[] = [
    ...widgets.map((widget) => ({
      key: widget.key,
      placement: widget.placement,
    })),
    ...(edit?.spaces ?? []).map((space) => ({
      key: space.key,
      placement: space.placement,
    })),
  ];
  const refreshedAt = useRefreshedAt(shown?.id ?? "");
  const now = useNow(Boolean(shown));

  // Leaving with unsaved layout changes asks first (BD9).
  const guard = useCallback(
    (href: string, resume: () => void) => {
      if (!dirty) {
        setEdit(null);
        return true;
      }
      if (saving) return false;
      setPendingNavigation({ href, resume });
      return false;
    },
    [dirty, saving],
  );
  useWorkspaceNavigationGuard(guard);

  // The old Charts links open the builder's saved-chart list for a manager.
  useEffect(() => {
    if (!savedListRequested || fromCharts || !departmentId) return;
    if (resource.loading || identity.isPending) return;
    router.replace(
      serializeOpenViewUrl({
        section: "dashboards",
        department: departmentId,
        dashboard: dashboardId,
      }) as Route,
      { scroll: false },
    );
    if (
      !canManage ||
      !wide ||
      (shown && !shown.isHome && shown !== resource.home)
    )
      return;
    const base = shown ? draftWidgetsFrom(shown) : [];
    const next: LayoutEdit = {
      dashboardId: shown?.id ?? null,
      revision: shown?.revision ?? null,
      widgets: base,
      spaces: [],
      kinds: new Map(),
      base: layoutSignature(base),
    };
    setEdit(next);
    openAdd(next, null, true);
    // Runs once when the request and the data arrive.
  }, [savedListRequested, departmentId, resource.loading, identity.isPending]);

  function startEdit(
    from: OpenViewDashboard | null,
    spaces: LayoutSpace[] = [],
  ) {
    const base = from ? draftWidgetsFrom(from) : [];
    const next: LayoutEdit = {
      dashboardId: from?.id ?? null,
      revision: from?.revision ?? null,
      widgets: base,
      spaces,
      kinds: new Map(),
      base: layoutSignature(base),
    };
    setEdit(next);
    setIssues(new Map());
    setError("");
    setConflict(false);
    setNotice("");
    return next;
  }

  function presetSpaces(preset: Preset): LayoutSpace[] {
    return preset.spaces.map((space, index) => ({
      ...space,
      key: `space-${preset.id}-${index}-${Date.now()}`,
    }));
  }

  function editItems(current: LayoutEdit): GridItem[] {
    return [
      ...current.widgets.map((widget) => ({
        key: widget.key,
        placement: widget.placement,
      })),
      ...current.spaces.map((space) => ({
        key: space.key,
        placement: space.placement,
      })),
    ];
  }

  function openAdd(
    current: LayoutEdit,
    cell: { column: number; row: number } | null,
    saved = false,
  ) {
    const all = editItems(current);
    const anchor =
      cell ??
      freeCells(all).find(({ column, row }) => freeSpaceAt(all, column, row));
    setBuilder({
      mode: "add",
      kind: null,
      widget: null,
      size: null,
      savedList: saved,
      anchor: anchor
        ? { column: anchor.column, row: anchor.row, columnSpan: 1, rowSpan: 1 }
        : null,
      sizes: (kind) =>
        anchor ? sizesAt(all, anchor.column, anchor.row, kind) : [],
    });
  }

  function openSpace(key: string) {
    if (!edit) return;
    const space = edit.spaces.find((candidate) => candidate.key === key);
    if (!space) return;
    const all = editItems(edit);
    setBuilder({
      mode: "add",
      kind: space.kind,
      widget: null,
      size: {
        columns: space.placement.columnSpan,
        rows: space.placement.rowSpan,
      },
      savedList: false,
      anchor: space.placement,
      spaceKey: key,
      sizes: (kind) =>
        sizesAt(all, space.placement.column, space.placement.row, kind, key),
    });
  }

  function openEdit(current: LayoutEdit, key: string) {
    const widget = current.widgets.find((candidate) => candidate.key === key);
    if (!widget?.placement) return;
    const placement = widget.placement;
    const all = editItems(current);
    setBuilder({
      mode: "edit",
      kind: kinds.get(key) ?? null,
      widget,
      size: { columns: placement.columnSpan, rows: placement.rowSpan },
      savedList: false,
      anchor: placement,
      editKey: key,
      sizes: (kind) => sizesAt(all, placement.column, placement.row, kind, key),
    });
  }

  function applyBuilder(result: BuilderResult) {
    if (!edit || !builder?.anchor) return;
    const placement = {
      column: builder.anchor.column,
      row: builder.anchor.row,
      columnSpan: result.size.columns,
      rowSpan: result.size.rows,
    };
    const key = builder.editKey ?? crypto.randomUUID();
    const widget = { ...result.source, key, placement } as DraftWidget;
    const nextKinds = new Map(edit.kinds);
    nextKinds.set(key, result.kind);
    setEdit({
      ...edit,
      kinds: nextKinds,
      widgets: builder.editKey
        ? edit.widgets.map((candidate) =>
            candidate.key === key ? widget : candidate,
          )
        : [...edit.widgets, widget],
      spaces: builder.spaceKey
        ? edit.spaces.filter((space) => space.key !== builder.spaceKey)
        : edit.spaces,
    });
    setIssues(new Map());
    setBuilder(null);
  }

  function place(key: string, placement: Placement) {
    if (!edit) return;
    setIssues(new Map());
    setEdit({
      ...edit,
      widgets: edit.widgets.map((widget) =>
        widget.key === key ? { ...widget, placement } : widget,
      ),
      spaces: edit.spaces.map((space) =>
        space.key === key ? { ...space, placement } : space,
      ),
    });
  }

  function remove(current: LayoutEdit, key: string) {
    setIssues(new Map());
    setEdit({
      ...current,
      widgets: current.widgets.filter((widget) => widget.key !== key),
    });
  }

  function applyPreset(preset: Preset) {
    setPresetChoice(null);
    if (!edit) {
      startEdit(null, presetSpaces(preset));
      return;
    }
    setIssues(new Map());
    setEdit({ ...edit, widgets: [], spaces: presetSpaces(preset) });
  }

  async function saveLayout() {
    if (!edit || saving) return;
    if (!dirty && edit.dashboardId) {
      setEdit(null);
      return;
    }
    const local = layoutIssues(
      edit.widgets.flatMap((widget) =>
        widget.placement
          ? [
              {
                kind: kinds.get(widget.key) ?? "bar",
                placement: widget.placement,
              },
            ]
          : [],
      ),
    );
    if (local.length) {
      setIssues(issueMap(edit.widgets, local));
      return;
    }
    setSaving(true);
    setError("");
    setConflict(false);
    try {
      const widgetsInput = inputWidgets(edit.widgets);
      const saved =
        edit.dashboardId && edit.revision
          ? await updateOpenViewDashboard({
              id: edit.dashboardId,
              revision: edit.revision,
              widgets: widgetsInput,
            })
          : await createOpenViewDashboard({
              departmentId: effectiveDepartmentId,
              name: `${departmentName} dashboard`,
              widgets: widgetsInput,
            });
      resource.remember(saved);
      setEdit(null);
      setIssues(new Map());
      setNotice("Layout saved.");
    } catch (failure) {
      const layout = getOpenViewDashboardLayoutIssues(failure);
      const conflicted = getOpenViewDashboardConflict(failure);
      if (layout) setIssues(issueMap(edit.widgets, layout));
      else if (conflicted?.code === "stale_revision") setConflict(true);
      else
        setError(
          apiErrorMessage(
            failure,
            "The layout could not be saved. Your changes are still here.",
          ),
        );
    } finally {
      setSaving(false);
    }
  }

  function refreshAll() {
    aggregate.refresh();
    setRefreshSignal((value) => value + 1);
  }

  const unplaced = edit?.widgets.filter((widget) => !widget.placement) ?? [];
  const emptyCells = edit ? freeCells(items).length : 0;
  const isHome = Boolean(
    shown && (shown.isHome || shown.id === resource.home?.id),
  );
  const editReason = !wide ? "Edit the layout on a larger screen." : null;
  const saveReason = saving
    ? "Saving…"
    : unplaced.length
      ? "Place or remove the widgets that are not on the grid"
      : null;
  const title =
    edit && !edit.dashboardId
      ? `${departmentName} dashboard`
      : (shown?.name ?? `${departmentName} dashboard`);
  const meta = shown
    ? [
        refreshedText(refreshedAt, now),
        CADENCE_TEXT[shown.refreshCadence],
        ...(isHome ? [] : ["not the home dashboard"]),
      ].join(" · ")
    : null;
  const listLoaded = !resource.loading && !resource.error;
  const noDashboard = listLoaded && !shown && !edit && !dashboardId;
  // After the last active dashboard is archived, its managers restore it
  // from the setup state, which has no dashboard menu.
  const archivedList = useQuery({
    ...dashboardListOptions(effectiveDepartmentId, true),
    enabled: noDashboard && canManage && Boolean(effectiveDepartmentId),
  });
  const hasArchived = (archivedList.data?.items.length ?? 0) > 0;

  const headerActions =
    edit || !shown ? null : (
      <>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          onClick={refreshAll}
        >
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
        <DashboardMenu
          canManage={canManage}
          isHome={isHome}
          others={resource.others}
          home={resource.home}
          shown={shown}
          departmentId={effectiveDepartmentId}
          onSettings={() => setSettingsOpen(true)}
          onArchive={() => setArchiveOpen(true)}
          onArchived={() => setArchivedOpen(true)}
          onOpen={(id) =>
            router.push(
              serializeOpenViewUrl({
                section: "dashboards",
                department: effectiveDepartmentId,
                dashboard: id === resource.home?.id ? undefined : id,
              }) as Route,
              { scroll: false },
            )
          }
        />
        {canManage && isHome ? (
          <DisabledReason reason={editReason}>
            <Button
              type="button"
              className="min-h-11"
              onClick={() => startEdit(shown)}
            >
              <LayoutGrid aria-hidden="true" />
              Edit layout
            </Button>
          </DisabledReason>
        ) : null}
      </>
    );

  if (accessDenied)
    return (
      <div className="openview-ui slim-ui flex min-w-0 flex-col">
        <PageHeader title="Dashboard" />
        <Alert role="alert" variant="destructive">
          OpenView data is unavailable. Sign in or ask for access, then retry.
          <Button
            className="mt-3 min-h-11"
            variant="outline"
            onClick={() => void resource.reload()}
          >
            Retry
          </Button>
        </Alert>
      </div>
    );

  return (
    <div className="openview-ui slim-ui flex min-h-0 min-w-0 flex-col xl:flex-1">
      <div className="shrink-0">
        <PageHeader
          title={title}
          description={
            meta ? <span className="tabular-nums">{meta}</span> : undefined
          }
          actions={headerActions}
        />
      </div>
      {edit ? (
        <div
          role="toolbar"
          aria-label="Edit layout"
          className="bg-popover mb-3 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
        >
          <span className="text-muted-foreground mr-auto text-sm">
            Drag a chart to move it, drag its corner to resize it, or use its
            menu.{" "}
            {emptyCells === 1 ? "1 empty cell." : `${emptyCells} empty cells.`}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="ghost" className="min-h-11" />
              }
            >
              <LayoutGrid aria-hidden="true" />
              Presets
              <ChevronDown
                aria-hidden="true"
                className="text-muted-foreground"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="slim-ui min-w-48">
              {PRESETS.map((preset) => (
                <DropdownMenuItem
                  key={preset.id}
                  className="min-h-11 xl:min-h-8"
                  onClick={() =>
                    edit.widgets.length || edit.spaces.length
                      ? setPresetChoice(preset)
                      : applyPreset(preset)
                  }
                >
                  {preset.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DisabledReason reason={emptyCells ? null : "The grid is full"}>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() => openAdd(edit, null)}
            >
              <Plus aria-hidden="true" />
              Add widget
            </Button>
          </DisabledReason>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={saving}
            onClick={() => {
              setEdit(null);
              setIssues(new Map());
              setConflict(false);
              setError("");
            }}
          >
            Cancel
          </Button>
          <DisabledReason reason={saveReason} stable>
            <Button
              type="button"
              className="min-h-11"
              onClick={() => void saveLayout()}
            >
              {saving ? "Saving…" : "Save layout"}
            </Button>
          </DisabledReason>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="sr-only">
          {notice}
        </p>
      ) : null}
      {conflict ? (
        <Alert role="alert" className="mb-3 flex flex-wrap items-center gap-3">
          <span className="mr-auto">
            Someone changed this dashboard while you were editing. Your layout
            is still here.
          </span>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              setEdit(null);
              setConflict(false);
              void resource.reload();
            }}
          >
            Discard my changes and reload
          </Button>
        </Alert>
      ) : null}
      {issues.size ? (
        <Alert role="alert" variant="destructive" className="mb-3">
          The layout was not saved:{" "}
          {issues.size === 1
            ? "one widget breaks"
            : `${issues.size} widgets break`}{" "}
          the grid rules. Each is marked below.
        </Alert>
      ) : null}
      {error || resource.error ? (
        <Alert role="alert" variant="destructive" className="mb-3">
          {error || resource.error}
          {resource.error ? (
            <Button
              className="mt-3 min-h-11"
              variant="outline"
              onClick={() => void resource.reload()}
            >
              Retry
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {unplaced.length ? (
        <section
          aria-label="Not on the grid"
          className="mb-3 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm"
        >
          <span className="font-medium">Not on the grid</span>
          {unplaced.map((widget) => {
            const kind = kinds.get(widget.key) ?? "bar";
            const rule = SIZE_RULES[kind];
            const spot = firstFreePlacement(items, {
              columns: rule.minColumns,
              rows: rule.minRows,
            });
            return (
              <span key={widget.key} className="flex items-center gap-1">
                <span className="text-muted-foreground">{rule.label}</span>
                <DisabledReason
                  reason={spot ? null : "No free space; make room first"}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11"
                    onClick={() => spot && place(widget.key, spot)}
                  >
                    Place it
                  </Button>
                </DisabledReason>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  onClick={() => remove(edit!, widget.key)}
                >
                  Remove
                </Button>
              </span>
            );
          })}
        </section>
      ) : null}

      {resource.loading ? (
        <div
          role="status"
          aria-label="Loading the dashboard"
          className="grid grid-cols-4 grid-rows-[repeat(5,7rem)] gap-3 max-md:flex max-md:flex-col xl:min-h-0 xl:flex-1 xl:grid-rows-[repeat(5,minmax(7rem,1fr))]"
        >
          {PRESETS[0].spaces.map((space, index) => (
            <div
              key={index}
              style={{
                gridColumn: `${space.placement.column + 1} / span ${space.placement.columnSpan}`,
                gridRow: `${space.placement.row + 1} / span ${space.placement.rowSpan}`,
              }}
              className="bg-muted/50 rounded-lg border max-md:h-32"
            />
          ))}
        </div>
      ) : noDashboard && !effectiveDepartmentId && readable?.length === 0 ? (
        <section className="flex flex-col gap-1 py-6">
          <h2 className="text-lg font-semibold">No dashboard yet</h2>
          <p className="text-muted-foreground text-sm">
            Dashboards appear here once you can read a department.
          </p>
        </section>
      ) : noDashboard && effectiveDepartmentId ? (
        <EmptyDashboard
          departmentName={departmentName}
          canManage={canManage}
          wide={wide}
          onPreset={(preset) => applyPreset(preset)}
          onEmpty={() => startEdit(null)}
          onArchived={hasArchived ? () => setArchivedOpen(true) : undefined}
        />
      ) : shown || edit ? (
        <DashboardLayout
          label={`${title}, 4 columns by 5 rows`}
          dashboard={editShown ?? null}
          widgets={widgets}
          spaces={edit?.spaces ?? []}
          kinds={kinds}
          reads={aggregate.reads}
          issues={issues}
          sources={sources}
          departmentNames={departmentNames}
          refreshSignal={refreshSignal}
          stacked={narrow && !edit}
          view={
            canManage && isHome && wide && shown
              ? {
                  onEdit: (key) => openEdit(startEdit(shown), key),
                  onRemove: (key) => remove(startEdit(shown), key),
                }
              : undefined
          }
          edit={
            edit
              ? {
                  onPlace: place,
                  onEditWidget: (key) => openEdit(edit, key),
                  onRemoveWidget: (key) => remove(edit, key),
                  onAddAt: (column, row) => openAdd(edit, { column, row }),
                  onFillSpace: openSpace,
                  onRemoveSpace: (key) =>
                    setEdit({
                      ...edit,
                      spaces: edit.spaces.filter((space) => space.key !== key),
                    }),
                }
              : null
          }
        />
      ) : null}

      <DashboardChartBuilder
        request={builder}
        dashboard={editShown ?? null}
        dashboardName={title}
        departmentId={effectiveDepartmentId}
        departmentNames={departmentNames}
        sources={sources}
        onClose={() => setBuilder(null)}
        onApply={applyBuilder}
      />
      {shown && settingsOpen ? (
        <SettingsDialog
          dashboard={shown}
          onClose={() => setSettingsOpen(false)}
          onSaved={(saved) => {
            resource.remember(saved);
            setSettingsOpen(false);
          }}
        />
      ) : null}
      {shown ? (
        <ArchiveDialog
          open={archiveOpen}
          dashboard={shown}
          onClose={() => setArchiveOpen(false)}
          onArchived={() => {
            setArchiveOpen(false);
            void client.invalidateQueries({ queryKey: dashboardKeys.all });
            if (dashboardId)
              router.push(dashboardHref(effectiveDepartmentId) as Route, {
                scroll: false,
              });
          }}
        />
      ) : null}
      {archivedOpen ? (
        <ArchivedDashboards
          departmentId={effectiveDepartmentId}
          departmentName={departmentName}
          onClose={() => setArchivedOpen(false)}
          onRestored={(restored) => {
            resource.remember(restored);
            setArchivedOpen(false);
            void client.invalidateQueries({ queryKey: dashboardKeys.all });
          }}
        />
      ) : null}
      <AlertDialog
        open={presetChoice !== null}
        onOpenChange={(open) => {
          if (!open) setPresetChoice(null);
        }}
      >
        <AlertDialogContent className="slim-ui">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Replace the layout with {presetChoice?.label}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The widgets on the grid come off this dashboard when you save.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setPresetChoice(null)}
            >
              Keep this layout
            </Button>
            <Button
              className="min-h-11"
              onClick={() => presetChoice && applyPreset(presetChoice)}
            >
              Replace the layout
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={pendingNavigation !== null}
        onOpenChange={(open) => {
          if (!open) setPendingNavigation(null);
        }}
      >
        <AlertDialogContent className="slim-ui">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Leave without saving the layout?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your changes to {title} are not saved yet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setPendingNavigation(null)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              onClick={() => {
                const navigation = pendingNavigation;
                setPendingNavigation(null);
                setEdit(null);
                navigation?.resume();
              }}
            >
              Discard and leave
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function issueMap(
  widgets: readonly DraftWidget[],
  list: readonly { index: number; message: string }[],
) {
  // The index counts the saved list: placed widgets in draft order.
  const placed = widgets.filter((widget) => widget.placement);
  const map = new Map<string, string[]>();
  for (const issue of list) {
    const key = placed[issue.index]?.key;
    if (key) map.set(key, [...(map.get(key) ?? []), `${issue.message}.`]);
  }
  return map;
}

function DashboardMenu(props: {
  canManage: boolean;
  isHome: boolean;
  shown: OpenViewDashboard;
  home: OpenViewDashboard | null;
  others: readonly OpenViewDashboard[];
  departmentId: string;
  onSettings: () => void;
  onArchive: () => void;
  onArchived: () => void;
  onOpen: (id: string) => void;
}) {
  const links = [
    ...(props.home && !props.isHome ? [props.home] : []),
    ...props.others.filter((other) => other.id !== props.shown.id),
  ];
  if (!props.canManage && !links.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label="More dashboard actions"
          />
        }
      >
        <MoreHorizontal aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="slim-ui min-w-56">
        {props.canManage ? (
          <DropdownMenuItem
            className="min-h-11 xl:min-h-8"
            onClick={props.onSettings}
          >
            Settings…
          </DropdownMenuItem>
        ) : null}
        {links.length ? (
          <>
            {props.canManage ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-muted-foreground px-2 pt-1.5 pb-0.5 text-xs font-medium">
                Other dashboards
              </DropdownMenuLabel>
              {links.map((dashboard) => (
                <DropdownMenuItem
                  key={dashboard.id}
                  className="min-h-11 xl:min-h-8"
                  onClick={() => props.onOpen(dashboard.id)}
                >
                  {dashboard.name}
                  {dashboard.id === props.home?.id ? (
                    <span className="text-muted-foreground ml-auto text-xs">
                      home
                    </span>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        ) : null}
        {props.canManage ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="min-h-11 xl:min-h-8"
              onClick={props.onArchived}
            >
              Archived dashboards…
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11 xl:min-h-8"
              variant="destructive"
              onClick={props.onArchive}
            >
              Archive this dashboard…
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** BD3: a department with no dashboard teaches with its presets. */
function EmptyDashboard(props: {
  departmentName: string;
  canManage: boolean;
  wide: boolean;
  onPreset: (preset: Preset) => void;
  onEmpty: () => void;
  /** Offered to managers when the department has archived dashboards. */
  onArchived?: () => void;
}) {
  if (!props.canManage)
    return (
      <section className="flex flex-col gap-1 py-6">
        <h2 role="heading" aria-level={2} className="text-lg font-semibold">
          No dashboard yet
        </h2>
        <p className="text-muted-foreground text-sm">
          The managers of {props.departmentName} have not set one up.
        </p>
      </section>
    );
  return (
    <section
      aria-labelledby="dashboard-setup-title"
      className="flex flex-col gap-4 py-2"
    >
      <h2 id="dashboard-setup-title" className="text-lg font-semibold">
        Set up the {props.departmentName} dashboard
      </h2>
      {props.wide ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => props.onPreset(preset)}
              className="bg-card focus-visible:ring-ring flex flex-col gap-2 rounded-lg border p-3 text-left hover:border-(--ink-muted) focus-visible:ring-2 focus-visible:outline-none"
            >
              <span
                aria-hidden="true"
                className="bg-muted/60 grid aspect-[4/3] grid-cols-4 grid-rows-5 gap-1 rounded-md p-1.5"
              >
                {preset.spaces.map((space, index) => (
                  <span
                    key={index}
                    style={{
                      gridColumn: `${space.placement.column + 1} / span ${space.placement.columnSpan}`,
                      gridRow: `${space.placement.row + 1} / span ${space.placement.rowSpan}`,
                    }}
                    className="bg-card rounded-sm border"
                  />
                ))}
              </span>
              <span className="font-medium">{preset.label}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={props.onEmpty}
            className="bg-card focus-visible:ring-ring flex flex-col gap-2 rounded-lg border border-dashed p-3 text-left hover:border-(--ink-muted) focus-visible:ring-2 focus-visible:outline-none"
          >
            <span
              aria-hidden="true"
              className="bg-muted/30 grid aspect-[4/3] place-items-center rounded-md"
            >
              <Plus className="text-muted-foreground size-5" />
            </span>
            <span className="font-medium">Start empty</span>
          </button>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          Set up the dashboard on a larger screen.
        </p>
      )}
      {props.onArchived ? (
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 self-start"
          onClick={props.onArchived}
        >
          Archived dashboards…
        </Button>
      ) : null}
    </section>
  );
}

function SettingsDialog(props: {
  dashboard: OpenViewDashboard;
  onClose: () => void;
  onSaved: (dashboard: OpenViewDashboard) => void;
}) {
  const [name, setName] = useState(props.dashboard.name);
  const [cadence, setCadence] = useState(props.dashboard.refreshCadence);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setPending(true);
    setError("");
    try {
      props.onSaved(
        await updateOpenViewDashboard({
          id: props.dashboard.id,
          revision: props.dashboard.revision,
          name: name.trim(),
          refreshCadence: cadence,
        }),
      );
    } catch (failure) {
      const conflict = getOpenViewDashboardConflict(failure);
      setError(
        conflict?.code === "stale_revision"
          ? "Someone changed this dashboard. Close and open Settings again."
          : apiErrorMessage(failure, "The settings could not be saved."),
      );
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className={cn(dialogFrameContentClass, "sm:max-w-md")}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogFrameHeader
            title={<DialogTitle>Dashboard settings</DialogTitle>}
            closeLabel="Close settings"
            onClose={props.onClose}
          />
          <Field>
            <FieldLabel htmlFor="dashboard-name">Name</FieldLabel>
            <Input
              id="dashboard-name"
              value={name}
              maxLength={200}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="dashboard-refresh">Refresh</FieldLabel>
            <Select
              id="dashboard-refresh"
              value={cadence}
              disabled={pending}
              onValueChange={(value) =>
                setCadence(value as OpenViewDashboardRefreshCadence)
              }
            >
              <option value="manual">When someone asks</option>
              <option value="one-minute">Every minute</option>
              <option value="five-minutes">Every 5 minutes</option>
            </Select>
          </Field>
          {error ? (
            <p role="alert" className="text-danger-text text-sm">
              {error}
            </p>
          ) : null}
          <DialogFrameFooter>
            <DialogFooter className="mt-0">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={props.onClose}
              >
                Cancel
              </Button>
              <DisabledReason
                reason={
                  !name.trim()
                    ? "Give the dashboard a name"
                    : pending
                      ? "Saving…"
                      : null
                }
                stable
              >
                <Button type="submit" className="min-h-11">
                  Save settings
                </Button>
              </DisabledReason>
            </DialogFooter>
          </DialogFrameFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveDialog(props: {
  open: boolean;
  dashboard: OpenViewDashboard;
  onClose: () => void;
  onArchived: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <AlertDialogContent className="slim-ui">
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {props.dashboard.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            People stop seeing it. A manager can restore it from Archived
            dashboards.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-danger-text text-sm">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={pending}
            onClick={props.onClose}
          >
            Keep it
          </Button>
          <Button
            variant="destructive"
            className="min-h-11"
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError("");
              void archiveOpenViewDashboard({
                id: props.dashboard.id,
                revision: props.dashboard.revision,
              })
                .then(() => {
                  setPending(false);
                  props.onArchived();
                })
                .catch((failure: unknown) => {
                  setPending(false);
                  setError(
                    getOpenViewDashboardConflict(failure)?.message ??
                      apiErrorMessage(
                        failure,
                        "The dashboard could not be archived.",
                      ),
                  );
                });
            }}
          >
            {pending ? "Archiving…" : "Archive"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ArchivedDashboards(props: {
  departmentId: string;
  departmentName: string;
  onClose: () => void;
  onRestored: (dashboard: OpenViewDashboard) => void;
}) {
  const list = useQuery(dashboardListOptions(props.departmentId, true));
  const [pendingId, setPendingId] = useState("");
  const [error, setError] = useState("");
  const items = list.data?.items ?? [];
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className={cn(dialogFrameContentClass, "sm:max-w-md")}>
        <DialogFrameHeader
          title={<DialogTitle>Archived dashboards</DialogTitle>}
          closeLabel="Close archived dashboards"
          onClose={props.onClose}
        />
        {list.isPending ? (
          <p role="status" className="text-muted-foreground text-sm">
            Loading…
          </p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {props.departmentName} has no archived dashboards.
          </p>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {items.map((dashboard) => (
              <li
                key={dashboard.id}
                className="flex min-h-11 items-center gap-2 px-2 xl:min-h-10"
              >
                <span className="min-w-0 flex-1 truncate">
                  {dashboard.name}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={Boolean(pendingId)}
                  aria-label={`Restore ${dashboard.name}`}
                  onClick={() => {
                    setPendingId(dashboard.id);
                    setError("");
                    void restoreOpenViewDashboard({
                      id: dashboard.id,
                      revision: dashboard.revision,
                    })
                      .then(props.onRestored)
                      .catch((failure: unknown) =>
                        setError(
                          getOpenViewDashboardConflict(failure)?.message ??
                            apiErrorMessage(
                              failure,
                              "The dashboard could not be restored.",
                            ),
                        ),
                      )
                      .finally(() => setPendingId(""));
                  }}
                >
                  {pendingId === dashboard.id ? "Restoring…" : "Restore"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error ? (
          <p role="alert" className="text-danger-text text-sm">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
