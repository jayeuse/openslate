import type {
  BoardWidget,
  BoardWidgetInput,
} from "../adapters/board-widgets-api";
import type { OpenViewDataSourceField } from "../../openview/adapters/views-api";
import {
  chartEditorDraftFrom,
  changeChartEditorWidgetType,
  compileChartEditorDraft,
  newChartEditorDraft,
  type ChartEditorDraft,
  type ChartSourceDraft,
} from "../../openview/domain/chart-query";
import { buildBoardWidgetQueryPlan } from "./live-widget-query";
import { ApiContractError } from "@/lib/api";

export type WidgetCreationDraft = {
  name: string;
  size: BoardWidget["size"];
  pinned: boolean;
  query: ChartSourceDraft;
};

export function blankWidgetCreation(): WidgetCreationDraft {
  return {
    name: "",
    size: "M",
    pinned: false,
    query: {
      chartId: null,
      inline: changeChartEditorWidgetType(
        newChartEditorDraft("", []),
        "summary",
        [],
      ),
    },
  };
}

/** Legacy instructions are an editor projection, never a silently rewritten saved query. */
export function queryDraftFromBoardWidget(
  widget: BoardWidget,
  workspaceToday?: string,
): ChartSourceDraft {
  const config = widget.config;
  if (widget.chartId !== null)
    return {
      chartId: widget.chartId,
      inline: changeChartEditorWidgetType(
        newChartEditorDraft(widget.moduleId, []),
        widget.widgetType,
        [],
      ),
    };
  if (config === null) throw new ApiContractError();
  if ("fields" in config) {
    const fresh = newChartEditorDraft(widget.moduleId, []);
    const plan = buildBoardWidgetQueryPlan(widget, { workspaceToday });
    const definition = {
      ...fresh.definition,
      columns: widget.widgetType === "records" ? config.fields : [],
      filters: config.filters,
      logic: config.logic,
    };
    if (widget.widgetType === "records")
      return {
        chartId: null,
        inline: chartEditorDraftFrom({
          widgetType: "records",
          config: {
            version: 1,
            query: { moduleId: widget.moduleId, definition },
          },
        }),
      };
    // Summary instructions historically count matching records, even if a metric/field was stored.
    // No group is preselected: choosing one is the user's explicit normalization decision.
    const base = chartEditorDraftFrom({
      widgetType: "records",
      config: {
        version: 1,
        query: { moduleId: widget.moduleId, definition },
      },
    });
    const aggregate = {
      ...base,
      aggregation:
        widget.widgetType === "summary"
          ? ("count" as const)
          : (config.aggregation ??
            (config.metric === null ? ("count" as const) : ("sum" as const))),
      measure: widget.widgetType === "summary" ? null : config.metric,
      dateField: null,
      fromDate: "",
      toDate: "",
    };
    if (widget.widgetType === "chart" && config.visualization === "line")
      return {
        chartId: null,
        inline: {
          ...aggregate,
          widgetType: "chart",
          mode: "date_series",
          chartType: "line",
          bucket: "day",
          dateField: config.fields[0] ?? null,
          fromDate:
            plan.kind === "snapshot" && plan.request.mode === "date_series"
              ? plan.request.fromDate
              : "",
          toDate:
            plan.kind === "snapshot" && plan.request.mode === "date_series"
              ? plan.request.toDate
              : "",
        },
      };
    const groups = {
      ...aggregate,
      mode: "groups" as const,
      dimension:
        widget.widgetType === "summary" ? null : (config.fields[0] ?? null),
    };
    return {
      chartId: null,
      inline:
        widget.widgetType === "chart"
          ? {
              ...groups,
              widgetType: "chart",
              chartType: config.visualization === "pie" ? "pie" : "bar",
            }
          : { ...groups, widgetType: widget.widgetType },
    };
  }
  if (widget.widgetType === "chart" && "chartType" in config)
    return {
      chartId: null,
      inline: chartEditorDraftFrom({ widgetType: "chart", config }),
    };
  if (widget.widgetType === "records" && !("mode" in config.query))
    return {
      chartId: null,
      inline: chartEditorDraftFrom({
        widgetType: "records",
        config: { version: 1, query: config.query },
      }),
    };
  if (
    (widget.widgetType === "summary" || widget.widgetType === "workload") &&
    "mode" in config.query &&
    config.query.mode === "groups"
  )
    return {
      chartId: null,
      inline: chartEditorDraftFrom({
        widgetType: widget.widgetType,
        config: { version: 1, query: config.query },
      }),
    };
  throw new ApiContractError();
}

export function compileBoardWidgetDraft(
  source: BoardWidget,
  value: ChartEditorDraft,
  fields: OpenViewDataSourceField[],
): BoardWidgetInput["config"] | null {
  if (
    source.widgetType === "summary" &&
    source.config !== null &&
    "fields" in source.config &&
    value.mode === "groups" &&
    value.dimension === null &&
    value.aggregation === "count" &&
    value.measure === null &&
    value.dateField === null &&
    !value.fromDate &&
    !value.toDate
  ) {
    // Reuse the records grammar to validate filters without manufacturing a grouped Summary.
    const compiled = compileChartEditorDraft(
      changeChartEditorWidgetType(value, "records", fields),
      fields,
    );
    if (
      !compiled ||
      compiled.widgetType !== "records" ||
      compiled.config.query.definition.filters.length > 8
    )
      return null;
    const { refresh, ...legacy } = source.config;
    void refresh;
    return {
      ...legacy,
      aggregation:
        legacy.aggregation ?? (legacy.metric === null ? "count" : "sum"),
      filters: compiled.config.query.definition.filters,
      logic: compiled.config.query.definition.logic,
    };
  }
  return compileChartEditorDraft(value, fields)?.config ?? null;
}

export function createWidgetInput(
  draft: WidgetCreationDraft,
  fields: OpenViewDataSourceField[],
): BoardWidgetInput | null {
  const config =
    draft.query.chartId === null
      ? compileChartEditorDraft(draft.query.inline, fields)?.config
      : null;
  if (draft.query.chartId === null && !config) return null;
  return {
    name: draft.name.trim(),
    widgetType: draft.query.inline.widgetType,
    moduleId: draft.query.inline.moduleId,
    size: draft.size,
    pinned: draft.pinned,
    chartId: draft.query.chartId,
    config: config ?? null,
  };
}
