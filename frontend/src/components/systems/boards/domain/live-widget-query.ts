import { z } from "zod";
import type {
  BoardWidget,
  BoardLegacyWidgetConfig,
} from "../adapters/board-widgets-api";
import type { OpenViewDashboardWidgetConfig } from "../../openview/adapters/dashboards-api";
import type {
  OpenViewAggregateRequest,
  OpenViewAggregateSnapshotRequest,
  OpenViewAggregateSnapshotResult,
} from "../../openview/adapters/analytics-api";
import type { OpenViewQueryDefinition } from "../../openview/adapters/views-api";
import { CATEGORICAL_TYPES } from "../../openview/domain/chart-query";

type RecordRequest = {
  moduleId: string;
  definition: OpenViewQueryDefinition;
  limit: number;
  offset: number;
};

export type BoardWidgetQueryPlan =
  | {
      kind: "reference";
      widgetType: BoardWidget["widgetType"];
      chartId: string;
      moduleId: string;
    }
  | {
      kind: "unavailable";
      reason:
        | "missing-dimension"
        | "unsupported-dimension"
        | "missing-workspace-date"
        | "invalid-workspace-date"
        | "invalid-source";
    }
  | {
      kind: "records";
      widgetType: "summary" | "records";
      request: RecordRequest;
    }
  | {
      kind: "aggregate";
      widgetType: "workload" | "chart";
      visualization: "bar";
      request: OpenViewAggregateRequest;
    }
  | {
      kind: "snapshot";
      widgetType: "chart" | "summary" | "workload";
      visualization: "bar" | "pie" | "line";
      request: OpenViewAggregateSnapshotRequest;
    };

const millisecondsPerDay = 86_400_000;
const pieVisibleGroups = 8;

function definitionFor(
  widget: BoardWidget,
  config: BoardLegacyWidgetConfig,
): OpenViewQueryDefinition {
  return {
    version: 1,
    logic: config.logic,
    columns:
      widget.widgetType === "records"
        ? config.fields.map((field) => ({ ...field }))
        : [],
    filters: config.filters.map((filter) => ({ ...filter })),
    sort: [],
    deleted: "exclude",
    search: null,
    searchFields: [],
  };
}

function aggregateBase(widget: BoardWidget, config: BoardLegacyWidgetConfig) {
  return {
    moduleId: widget.moduleId,
    definition: definitionFor(widget, config),
    aggregation: config.metric === null ? ("count" as const) : ("sum" as const),
    ...(config.metric === null ? {} : { measure: { ...config.metric } }),
  };
}

/**
 * Map a server-listed widget to a record request. This plan never authorizes a
 * record read: each OpenView endpoint still enforces the current records.read
 * capability, and callers must keep a denied source unavailable.
 */
export function buildBoardWidgetQueryPlan(
  widget: BoardWidget,
  options: { workspaceToday?: string } = {},
): BoardWidgetQueryPlan {
  if (widget.chartId !== null)
    return {
      kind: "reference",
      widgetType: widget.widgetType,
      chartId: widget.chartId,
      moduleId: widget.moduleId,
    };
  const config = widget.config;
  if (config === null) return { kind: "unavailable", reason: "invalid-source" };
  if (!("fields" in config))
    return buildNativeBoardWidgetPlan(widget.widgetType, config);
  if (widget.widgetType === "summary" || widget.widgetType === "records") {
    return {
      kind: "records",
      widgetType: widget.widgetType,
      request: {
        moduleId: widget.moduleId,
        definition: definitionFor(widget, config),
        limit: widget.widgetType === "summary" ? 1 : 5,
        offset: 0,
      },
    };
  }

  const dimension = config.fields[0];
  if (!dimension) return { kind: "unavailable", reason: "missing-dimension" };

  if (widget.widgetType === "chart" && config.visualization === "line") {
    if (
      dimension.expectedType !== "date" &&
      dimension.expectedType !== "datetime"
    ) {
      return { kind: "unavailable", reason: "unsupported-dimension" };
    }
    if (options.workspaceToday === undefined) {
      return { kind: "unavailable", reason: "missing-workspace-date" };
    }
    const parsed = z.iso.date().safeParse(options.workspaceToday);
    if (!parsed.success) {
      return { kind: "unavailable", reason: "invalid-workspace-date" };
    }
    // The caller supplies the current date in the workspace timezone. UTC
    // arithmetic only subtracts calendar days, avoiding DST-length days.
    const start =
      Date.parse(`${parsed.data}T00:00:00Z`) - 29 * millisecondsPerDay;
    return {
      kind: "snapshot",
      widgetType: "chart",
      visualization: "line",
      request: {
        ...aggregateBase(widget, config),
        mode: "date_series",
        dateField: { ...dimension },
        fromDate: new Date(start).toISOString().slice(0, 10),
        toDate: parsed.data,
      },
    };
  }

  if (!CATEGORICAL_TYPES.has(dimension.expectedType)) {
    return { kind: "unavailable", reason: "unsupported-dimension" };
  }
  if (widget.widgetType === "chart" && config.visualization === "pie") {
    return {
      kind: "snapshot",
      widgetType: "chart",
      visualization: "pie",
      request: {
        ...aggregateBase(widget, config),
        mode: "groups",
        dimension: { ...dimension },
      },
    };
  }
  return {
    kind: "aggregate",
    widgetType: widget.widgetType,
    visualization: "bar",
    request: {
      ...aggregateBase(widget, config),
      mode: "groups",
      dimension: { ...dimension },
      limit: widget.widgetType === "workload" ? 8 : 12,
      offset: 0,
    },
  };
}

/** Native queries are already validated; preserve their window/metric/definition. */
export function buildNativeBoardWidgetPlan(
  widgetType: BoardWidget["widgetType"],
  config: OpenViewDashboardWidgetConfig,
): BoardWidgetQueryPlan {
  if (widgetType === "records") {
    if ("mode" in config.query)
      return { kind: "unavailable", reason: "invalid-source" };
    return {
      kind: "records",
      widgetType,
      request: {
        moduleId: config.query.moduleId,
        definition: config.query.definition,
        limit: 5,
        offset: 0,
      },
    };
  }
  if (!("mode" in config.query))
    return { kind: "unavailable", reason: "invalid-source" };
  return {
    kind: "snapshot",
    widgetType,
    visualization: "chartType" in config ? config.chartType : "bar",
    request: config.query,
  };
}

export type BoardWidgetPiePoint = {
  key: string;
  label: string;
  value: number;
  recordCount: number;
};

export type BoardWidgetPieProjection =
  | {
      kind: "unavailable";
      reason: "incomplete-snapshot" | "unrepresentable-value";
    }
  | {
      kind: "ready";
      points: BoardWidgetPiePoint[];
      totalGroups: number;
      rolledUpGroups: number;
    };

export function collapseBoardWidgetPie(
  result: OpenViewAggregateSnapshotResult,
  rollUp = true,
): BoardWidgetPieProjection {
  if (
    result.pagination.hasMore ||
    result.pagination.offset !== 0 ||
    result.pagination.total !== result.items.length ||
    result.pagination.count !== result.items.length
  ) {
    return { kind: "unavailable", reason: "incomplete-snapshot" };
  }
  const points: BoardWidgetPiePoint[] = [];
  for (const item of result.items) {
    if (item.value === null) continue;
    const value = Number(item.value);
    if (!Number.isFinite(value) || value < 0) {
      return { kind: "unavailable", reason: "unrepresentable-value" };
    }
    points.push({
      key: item.key === null ? "group:null" : `group:value:${item.key}`,
      label: item.label,
      value,
      recordCount: item.recordCount,
    });
  }
  const rolledUpGroups = rollUp
    ? Math.max(0, points.length - pieVisibleGroups)
    : 0;
  if (rolledUpGroups === 0) {
    return {
      kind: "ready",
      points,
      totalGroups: points.length,
      rolledUpGroups,
    };
  }
  const remaining = points.slice(pieVisibleGroups);
  const otherValue = remaining.reduce((total, point) => total + point.value, 0);
  if (!Number.isFinite(otherValue)) {
    return { kind: "unavailable", reason: "unrepresentable-value" };
  }
  return {
    kind: "ready",
    points: [
      ...points.slice(0, pieVisibleGroups),
      {
        key: "rollup:other",
        label: "Other",
        value: otherValue,
        recordCount: remaining.reduce(
          (total, point) => total + point.recordCount,
          0,
        ),
      },
    ],
    totalGroups: points.length,
    rolledUpGroups,
  };
}
