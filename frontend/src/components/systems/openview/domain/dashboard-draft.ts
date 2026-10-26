import type {
  OpenViewDashboard,
  OpenViewDashboardWidget,
  OpenViewDashboardWidgetInput,
  OpenViewDashboardChartConfig,
  OpenViewDashboardWidgetConfig,
  OpenViewWidgetSource,
} from "../adapters/dashboards-api";
import type { OpenViewPage, OpenViewRecord } from "../adapters/views-api";
import type { OpenViewAggregateSnapshotResult } from "../adapters/analytics-api";
import { serializeDashboardWidgetConfig } from "../adapters/dashboards-api";
import { chartEditorDraftFrom, type ChartEditorDraft } from "./chart-query";
import { widgetKind, type Placement, type WidgetKind } from "./dashboard-grid";
import { ApiContractError } from "@/lib/api";

export const DASHBOARD_PAGE_SIZE = 25;

/**
 * One widget of the layout draft. `key` is the saved widget id, or a local id
 * for a widget added in this edit. A widget the grid migration could not place
 * has no placement until a manager places it (BE1m).
 */
export type DraftWidget = OpenViewWidgetSource & {
  key: string;
  placement: Placement | null;
};

export type DashboardWidgetData = (
  | { kind: "aggregate"; result: OpenViewAggregateSnapshotResult }
  | { kind: "records"; result: OpenViewPage<OpenViewRecord> }
) & {
  config: OpenViewDashboardWidgetConfig;
  sourceStamp: string;
  sourceName: string | null;
};

export type SnapshotState = {
  widgetKey: string;
  configSignature: string;
  data: DashboardWidgetData;
};

/** The source half of a widget: what it shows, without where it sits. */
export function widgetSource(
  widget: OpenViewWidgetSource,
): OpenViewWidgetSource {
  if (widget.chartId != null)
    return {
      widgetType: widget.widgetType,
      chartId: widget.chartId,
      config: null,
    } as OpenViewWidgetSource;
  switch (widget.widgetType) {
    case "chart":
      return { widgetType: "chart", chartId: null, config: widget.config };
    case "summary":
    case "workload":
      return {
        widgetType: widget.widgetType,
        chartId: null,
        config: widget.config,
      };
    case "records":
      return { widgetType: "records", chartId: null, config: widget.config };
  }
}

export function draftWidgetFrom(widget: OpenViewDashboardWidget): DraftWidget {
  return {
    ...widgetSource(widget),
    placement: widget.placement,
    key: widget.id,
  };
}
export function draftWidgetsFrom(dashboard: OpenViewDashboard): DraftWidget[] {
  return [...dashboard.widgets]
    .sort((a, b) => a.position - b.position)
    .map(draftWidgetFrom);
}

/** The saved list; every widget must have a place (Save waits until it does). */
export function inputWidgets(
  widgets: readonly DraftWidget[],
): OpenViewDashboardWidgetInput[] {
  return widgets.map((widget) => {
    if (!widget.placement) throw new Error("Every saved widget needs a place");
    return { ...widgetSource(widget), placement: widget.placement };
  });
}

/**
 * The size-rule kind of a widget. A saved Chart's type is known once its
 * definition is read; until then a chart widget follows the bar rules.
 */
export function draftWidgetKind(
  widget: OpenViewWidgetSource,
  resolved?: OpenViewDashboardWidgetConfig | null,
): WidgetKind {
  const config: OpenViewDashboardWidgetConfig | null =
    widget.config ?? resolved ?? null;
  return widgetKind(
    widget.widgetType,
    config && "chartType" in config
      ? (config as OpenViewDashboardChartConfig).chartType
      : null,
  );
}

export function configSignature(
  widget: DraftWidget | undefined,
  page = 0,
): string {
  return widget
    ? JSON.stringify({
        widgetType: widget.widgetType,
        config: widget.config
          ? serializeDashboardWidgetConfig(widget.widgetType, widget.config)
          : null,
        chartId: widget.chartId ?? null,
        ...(widget.widgetType === "records" ? { page } : {}),
      })
    : "";
}

/** Presentation changes do not change the live query or its paging identity. */
export function dashboardWidgetEditorDraft(
  widget: DraftWidget,
  config: OpenViewDashboardWidgetConfig,
): ChartEditorDraft {
  const query = config.query;
  if (widget.widgetType === "chart" && "chartType" in config)
    return chartEditorDraftFrom({ widgetType: "chart", config });
  if (
    (widget.widgetType === "summary" || widget.widgetType === "workload") &&
    "mode" in query &&
    query.mode === "groups"
  )
    return chartEditorDraftFrom({
      widgetType: widget.widgetType,
      config: { version: 1, query },
    });
  if (widget.widgetType === "records" && !("mode" in query))
    return chartEditorDraftFrom({
      widgetType: "records",
      config: { version: 1, query },
    });
  throw new ApiContractError();
}
