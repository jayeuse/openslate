import type {
  OpenViewDashboard,
  OpenViewDashboardWidget,
  OpenViewDashboardWidgetInput,
  OpenViewDashboardWidgetConfig,
} from "../adapters/dashboards-api";
import type { OpenViewPage, OpenViewRecord } from "../adapters/views-api";
import type { OpenViewAggregateSnapshotResult } from "../adapters/analytics-api";

export const DASHBOARD_PAGE_SIZE = 25;

export type DraftWidget = OpenViewDashboardWidgetInput & {
  key: string;
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

export function draftWidgetFrom(widget: OpenViewDashboardWidget): DraftWidget {
  return { ...widget, key: widget.id };
}
export function draftWidgetsFrom(dashboard: OpenViewDashboard): DraftWidget[] {
  return dashboard.widgets.map(draftWidgetFrom);
}
export function inputWidgets(
  widgets: DraftWidget[],
): OpenViewDashboardWidgetInput[] {
  return widgets.map((widget) => {
    const presentation = { size: widget.size ?? "M" };
    if (widget.chartId != null)
      return {
        ...presentation,
        widgetType: widget.widgetType,
        chartId: widget.chartId,
        config: null,
      };
    switch (widget.widgetType) {
      case "chart":
        return {
          ...presentation,
          widgetType: "chart",
          chartId: null,
          config: widget.config,
        };
      case "summary":
      case "workload":
        return {
          ...presentation,
          widgetType: widget.widgetType,
          chartId: null,
          config: widget.config,
        };
      case "records":
        return {
          ...presentation,
          widgetType: "records",
          chartId: null,
          config: widget.config,
        };
    }
  });
}

export function configSignature(
  widget: DraftWidget | undefined,
  page = 0,
): string {
  return widget
    ? JSON.stringify({
        widgetType: widget.widgetType,
        config: widget.config,
        chartId: widget.chartId ?? null,
        size: widget.size ?? "M",
        ...(widget.widgetType === "records" ? { page } : {}),
      })
    : "";
}

export function lastValidTablePage(
  currentPage: number,
  itemCount: number,
): number {
  return Math.min(
    currentPage,
    Math.max(0, Math.ceil(itemCount / DASHBOARD_PAGE_SIZE) - 1),
  );
}
