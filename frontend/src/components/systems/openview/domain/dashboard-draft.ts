import type {
  OpenViewDashboard,
  OpenViewDashboardWidget,
  OpenViewDashboardWidgetInput,
  OpenViewDashboardWidgetConfig,
} from "../adapters/dashboards-api";
import type { OpenViewPage, OpenViewRecord } from "../adapters/views-api";
import type { OpenViewAggregateSnapshotResult } from "../adapters/analytics-api";
import { serializeDashboardWidgetConfig } from "../adapters/dashboards-api";
import { chartEditorDraftFrom, type ChartEditorDraft } from "./chart-query";
import { ApiContractError } from "@/lib/api";

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
  return [...dashboard.widgets]
    .sort((a, b) => a.position - b.position)
    .map(draftWidgetFrom);
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
