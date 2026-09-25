import { z } from "zod";
import type { BoardWidget } from "../adapters/board-widgets-api";
import type {
  OpenViewAggregateRequest,
  OpenViewAggregateSnapshotRequest,
  OpenViewAggregateSnapshotResult,
} from "../../openview/adapters/analytics-api";
import type { OpenViewQueryDefinition } from "../../openview/adapters/views-api";

type RecordRequest = {
  moduleId: string;
  definition: OpenViewQueryDefinition;
  limit: number;
  offset: number;
};

export type BoardWidgetQueryPlan =
  | {
      kind: "unavailable";
      reason:
        | "missing-dimension"
        | "unsupported-dimension"
        | "missing-workspace-date"
        | "invalid-workspace-date";
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
      widgetType: "chart";
      visualization: "pie" | "line";
      request: OpenViewAggregateSnapshotRequest;
    };

const categoricalTypes = new Set([
  "text",
  "long_text",
  "email",
  "url",
  "boolean",
  "select",
]);
const millisecondsPerDay = 86_400_000;
const pieVisibleGroups = 8;

function definitionFor(widget: BoardWidget): OpenViewQueryDefinition {
  return {
    version: 1,
    logic: widget.config.logic,
    columns:
      widget.widgetType === "records"
        ? widget.config.fields.map((field) => ({ ...field }))
        : [],
    filters: widget.config.filters.map((filter) => ({ ...filter })),
    sort: [],
    deleted: "exclude",
    search: null,
    searchFields: [],
  };
}

function aggregateBase(widget: BoardWidget) {
  return {
    moduleId: widget.moduleId,
    definition: definitionFor(widget),
    aggregation:
      widget.config.metric === null ? ("count" as const) : ("sum" as const),
    ...(widget.config.metric === null
      ? {}
      : { measure: { ...widget.config.metric } }),
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
  if (widget.widgetType === "summary" || widget.widgetType === "records") {
    return {
      kind: "records",
      widgetType: widget.widgetType,
      request: {
        moduleId: widget.moduleId,
        definition: definitionFor(widget),
        limit: widget.widgetType === "summary" ? 1 : 5,
        offset: 0,
      },
    };
  }

  const dimension = widget.config.fields[0];
  if (!dimension) return { kind: "unavailable", reason: "missing-dimension" };

  if (widget.widgetType === "chart" && widget.config.visualization === "line") {
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
        ...aggregateBase(widget),
        mode: "date_series",
        dateField: { ...dimension },
        fromDate: new Date(start).toISOString().slice(0, 10),
        toDate: parsed.data,
      },
    };
  }

  if (!categoricalTypes.has(dimension.expectedType)) {
    return { kind: "unavailable", reason: "unsupported-dimension" };
  }
  if (widget.widgetType === "chart" && widget.config.visualization === "pie") {
    return {
      kind: "snapshot",
      widgetType: "chart",
      visualization: "pie",
      request: {
        ...aggregateBase(widget),
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
      ...aggregateBase(widget),
      mode: "groups",
      dimension: { ...dimension },
      limit: widget.widgetType === "workload" ? 8 : 12,
      offset: 0,
    },
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
  const rolledUpGroups = Math.max(0, points.length - pieVisibleGroups);
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
