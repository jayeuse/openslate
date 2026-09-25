import type {
  OpenViewDashboard,
  OpenViewDashboardWidget,
  OpenViewDashboardWidgetInput,
} from "../adapters/dashboards-api";
import type { OpenViewPage, OpenViewRecord } from "../adapters/views-api";
import type { OpenViewAggregateSnapshotResult } from "../adapters/analytics-api";

export const DASHBOARD_PAGE_SIZE = 25;

export type DraftWidget = OpenViewDashboardWidgetInput & {
  key: string;
};

export type DashboardWidgetData =
  | { kind: "aggregate"; result: OpenViewAggregateSnapshotResult }
  | { kind: "records"; result: OpenViewPage<OpenViewRecord> };

export type SnapshotState = {
  widgetKey: string;
  configSignature: string;
  data: DashboardWidgetData;
};

export function draftWidgetFrom(widget: OpenViewDashboardWidget): DraftWidget {
  switch (widget.widgetType) {
    case "chart":
      return { key: widget.id, widgetType: "chart", config: widget.config };
    case "summary":
    case "workload":
      return {
        key: widget.id,
        widgetType: widget.widgetType,
        config: widget.config,
      };
    case "records":
      return { key: widget.id, widgetType: "records", config: widget.config };
  }
}

export function draftWidgetsFrom(dashboard: OpenViewDashboard): DraftWidget[] {
  return dashboard.widgets.map(draftWidgetFrom);
}

export function inputWidgets(
  widgets: DraftWidget[],
): OpenViewDashboardWidgetInput[] {
  return widgets.map((widget) => {
    switch (widget.widgetType) {
      case "chart":
        return { widgetType: "chart", config: widget.config };
      case "summary":
      case "workload":
        return { widgetType: widget.widgetType, config: widget.config };
      case "records":
        return { widgetType: "records", config: widget.config };
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
