import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";
import { openViewReadFetch } from "./openview-access";
import {
  aggregateConfigInputSchema,
  chartConfigInputSchema,
  recordsConfigInputSchema,
  serializeDashboardWidgetConfig,
  timestampSchema,
  uuidSchema,
  wireAggregateConfigSchema,
  wireChartConfigSchema,
  wireRecordsConfigSchema,
  type OpenViewDashboardAggregateConfig,
  type OpenViewDashboardChartConfig,
  type OpenViewDashboardRecordsConfig,
} from "./dashboard-widget-config";

export {
  dashboardWidgetConfigInputSchema,
  dashboardWidgetWireConfigSchema,
  serializeDashboardWidgetConfig,
} from "./dashboard-widget-config";
export type {
  OpenViewDashboardAggregateConfig,
  OpenViewDashboardChartConfig,
  OpenViewDashboardChartQuery,
  OpenViewDashboardGroupQuery,
  OpenViewDashboardRecordsConfig,
  OpenViewDashboardWidgetConfig,
  OpenViewDashboardWidgetType,
} from "./dashboard-widget-config";

// The 4 × 5 grid (domain/dashboard-grid.ts), repeated here so the shell, which
// reaches this module through the saved-chart reads, does not load the editor
// rules. Every widget covers at least one cell, so the grid bounds the list.
const GRID_COLUMNS = 4;
const GRID_ROWS = 5;
const DASHBOARD_WIDGET_LIMIT = GRID_COLUMNS * GRID_ROWS;

const placementInputSchema = z
  .object({
    column: z
      .number()
      .int()
      .min(0)
      .max(GRID_COLUMNS - 1),
    row: z
      .number()
      .int()
      .min(0)
      .max(GRID_ROWS - 1),
    columnSpan: z.number().int().min(1).max(GRID_COLUMNS),
    rowSpan: z.number().int().min(1).max(GRID_ROWS),
  })
  .strict();
const widgetSourceInputShape = {
  placement: placementInputSchema,
  chartId: uuidSchema.nullable().default(null),
};
function hasOneWidgetSource(chartId: string | null, config: unknown): boolean {
  return (chartId === null) !== (config === null);
}
const dashboardWidgetInputSchema = z.discriminatedUnion("widgetType", [
  z
    .object({
      ...widgetSourceInputShape,
      widgetType: z.literal("chart"),
      config: chartConfigInputSchema.nullable().default(null),
    })
    .strict()
    .refine((widget) => hasOneWidgetSource(widget.chartId, widget.config)),
  z
    .object({
      ...widgetSourceInputShape,
      widgetType: z.literal("summary"),
      config: aggregateConfigInputSchema.nullable().default(null),
    })
    .strict()
    .refine((widget) => hasOneWidgetSource(widget.chartId, widget.config)),
  z
    .object({
      ...widgetSourceInputShape,
      widgetType: z.literal("workload"),
      config: aggregateConfigInputSchema.nullable().default(null),
    })
    .strict()
    .refine((widget) => hasOneWidgetSource(widget.chartId, widget.config)),
  z
    .object({
      ...widgetSourceInputShape,
      widgetType: z.literal("records"),
      config: recordsConfigInputSchema.nullable().default(null),
    })
    .strict()
    .refine((widget) => hasOneWidgetSource(widget.chartId, widget.config)),
]);
const refreshCadenceSchema = z.enum(["manual", "one-minute", "five-minutes"]);
const dashboardPositionSchema = z.number().int().min(0).max(10_000);
const dashboardCreateSchema = z
  .object({
    departmentId: uuidSchema,
    name: z.string().trim().min(1).max(200),
    position: dashboardPositionSchema.default(0),
    refreshCadence: refreshCadenceSchema.default("manual"),
    widgets: z
      .array(dashboardWidgetInputSchema)
      .max(DASHBOARD_WIDGET_LIMIT)
      .default([]),
  })
  .strict();
const dashboardUpdateSchema = z
  .object({
    id: uuidSchema,
    revision: z.number().int().min(1),
    name: z.string().trim().min(1).max(200).optional(),
    position: dashboardPositionSchema.optional(),
    refreshCadence: refreshCadenceSchema.optional(),
    widgets: z
      .array(dashboardWidgetInputSchema)
      .max(DASHBOARD_WIDGET_LIMIT)
      .optional(),
  })
  .strict()
  .superRefine(({ name, position, refreshCadence, widgets }, context) => {
    if (
      name === undefined &&
      position === undefined &&
      refreshCadence === undefined &&
      widgets === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "At least one Dashboard change is required",
      });
    }
  });
const dashboardRevisionRequestSchema = z
  .object({ id: uuidSchema, revision: z.number().int().min(1) })
  .strict();

const paginationSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict()
  .transform(({ has_more, ...pagination }) => ({
    ...pagination,
    hasMore: has_more,
  }));
const wireWidgetBaseShape = {
  id: uuidSchema,
  position: z
    .number()
    .int()
    .min(0)
    .max(DASHBOARD_WIDGET_LIMIT - 1),
  grid_column: z
    .number()
    .int()
    .min(0)
    .max(GRID_COLUMNS - 1)
    .nullable(),
  grid_row: z
    .number()
    .int()
    .min(0)
    .max(GRID_ROWS - 1)
    .nullable(),
  column_span: z.number().int().min(1).max(GRID_COLUMNS).nullable(),
  row_span: z.number().int().min(1).max(GRID_ROWS).nullable(),
  chart_id: uuidSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
};
/** A placement sets all four grid fields, or none (an unplaced migration result). */
function hasWholePlacement(widget: {
  grid_column: number | null;
  grid_row: number | null;
  column_span: number | null;
  row_span: number | null;
}): boolean {
  const values = [
    widget.grid_column,
    widget.grid_row,
    widget.column_span,
    widget.row_span,
  ];
  return (
    values.every((value) => value === null) ||
    values.every((value) => value !== null)
  );
}
function transformWireWidget<
  Widget extends {
    widget_type: "summary" | "workload" | "records" | "chart";
    grid_column: number | null;
    grid_row: number | null;
    column_span: number | null;
    row_span: number | null;
    chart_id: string | null;
    config: unknown;
    created_at: string;
    updated_at: string;
  },
  WidgetType extends "summary" | "workload" | "records" | "chart",
>(widget: Widget, widgetType: WidgetType) {
  const {
    widget_type,
    grid_column,
    grid_row,
    column_span,
    row_span,
    chart_id,
    config,
    created_at,
    updated_at,
    ...rest
  } = widget;
  void widget_type;
  const placement: OpenViewWidgetPlacement | null =
    grid_column === null ||
    grid_row === null ||
    column_span === null ||
    row_span === null
      ? null
      : {
          column: grid_column,
          row: grid_row,
          columnSpan: column_span,
          rowSpan: row_span,
        };
  // The preceding source refinement proves this correlation before mapping.
  const source: DashboardSource<NonNullable<Widget["config"]>> =
    chart_id === null
      ? { chartId: null, config: config as NonNullable<Widget["config"]> }
      : { chartId: chart_id, config: null };
  return {
    ...rest,
    ...source,
    placement,
    widgetType,
    createdAt: created_at,
    updatedAt: updated_at,
  };
}
const wireWidgetSchema = z.discriminatedUnion("widget_type", [
  z
    .object({
      ...wireWidgetBaseShape,
      widget_type: z.literal("chart"),
      config: wireChartConfigSchema.nullable(),
    })
    .strict()
    .refine((widget) => hasOneWidgetSource(widget.chart_id, widget.config))
    .refine(hasWholePlacement)
    .transform((widget) => transformWireWidget(widget, "chart")),
  z
    .object({
      ...wireWidgetBaseShape,
      widget_type: z.literal("summary"),
      config: wireAggregateConfigSchema.nullable(),
    })
    .strict()
    .refine((widget) => hasOneWidgetSource(widget.chart_id, widget.config))
    .refine(hasWholePlacement)
    .transform((widget) => transformWireWidget(widget, "summary")),
  z
    .object({
      ...wireWidgetBaseShape,
      widget_type: z.literal("workload"),
      config: wireAggregateConfigSchema.nullable(),
    })
    .strict()
    .refine((widget) => hasOneWidgetSource(widget.chart_id, widget.config))
    .refine(hasWholePlacement)
    .transform((widget) => transformWireWidget(widget, "workload")),
  z
    .object({
      ...wireWidgetBaseShape,
      widget_type: z.literal("records"),
      config: wireRecordsConfigSchema.nullable(),
    })
    .strict()
    .refine((widget) => hasOneWidgetSource(widget.chart_id, widget.config))
    .refine(hasWholePlacement)
    .transform((widget) => transformWireWidget(widget, "records")),
]);
const dashboardSchema = z
  .object({
    id: uuidSchema,
    department_id: uuidSchema,
    position: z.number().int().min(0),
    name: z.string().min(1).max(200),
    refresh_cadence: refreshCadenceSchema,
    revision: z.number().int().min(1),
    is_deleted: z.boolean(),
    is_home: z.boolean(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
    widgets: z.array(wireWidgetSchema).max(DASHBOARD_WIDGET_LIMIT),
  })
  .strict()
  .superRefine(({ widgets }, context) => {
    widgets.forEach((widget, index) => {
      if (widget.position !== index) {
        context.addIssue({
          code: "custom",
          path: ["widgets", index, "position"],
          message: "Dashboard widget positions must be complete and ordered",
        });
      }
    });
  })
  .transform(
    ({
      department_id,
      is_deleted,
      is_home,
      created_at,
      updated_at,
      refresh_cadence,
      ...dashboard
    }) => ({
      ...dashboard,
      departmentId: department_id,
      isDeleted: is_deleted,
      isHome: is_home,
      createdAt: created_at,
      updatedAt: updated_at,
      refreshCadence: refresh_cadence,
    }),
  );
const dashboardListResponseSchema = z
  .object({
    items: z.array(dashboardSchema),
    pagination: paginationSchema,
  })
  .strict();
const dashboardConflictDetailSchema = z
  .object({
    code: z.enum([
      "stale_revision",
      "dashboard_invalid",
      "dashboard_archived",
      "dashboard_not_archived",
    ]),
    message: z.string().optional(),
    current_revision: z.number().int().min(1).optional(),
  })
  .passthrough();

export type OpenViewDashboardRefreshCadence =
  "manual" | "one-minute" | "five-minutes";
/** Whole cells of the 4 × 5 grid (docs/specs/openview-dashboard.md, BE1). */
export type OpenViewWidgetPlacement = {
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
};
type DashboardSource<Config> =
  { chartId: null; config: Config } | { chartId: string; config: null };
type OpenViewDashboardWidgetBase = {
  id: string;
  position: number;
  /** Null only for a widget the grid migration could not place. */
  placement: OpenViewWidgetPlacement | null;
  createdAt: string;
  updatedAt: string;
};
export type OpenViewDashboardWidget = OpenViewDashboardWidgetBase &
  (
    | ({ widgetType: "chart" } & DashboardSource<OpenViewDashboardChartConfig>)
    | ({
        widgetType: "summary" | "workload";
      } & DashboardSource<OpenViewDashboardAggregateConfig>)
    | ({
        widgetType: "records";
      } & DashboardSource<OpenViewDashboardRecordsConfig>)
  );
export type OpenViewDashboard = {
  id: string;
  /** The department that owns the Dashboard; its managers change it. */
  departmentId: string;
  position: number;
  name: string;
  refreshCadence: OpenViewDashboardRefreshCadence;
  revision: number;
  isDeleted: boolean;
  /** The department's home dashboard (BD3); one active home per department. */
  isHome: boolean;
  createdAt: string;
  updatedAt: string;
  widgets: OpenViewDashboardWidget[];
};
export type OpenViewDashboardPage = {
  items: OpenViewDashboard[];
  pagination: {
    limit: number;
    offset: number;
    count: number;
    total: number;
    hasMore: boolean;
  };
};
type DashboardSourceInput<Config> =
  { chartId?: null; config: Config } | { chartId: string; config?: null };
/** What a widget shows: an inline definition or a saved Chart reference. */
export type OpenViewWidgetSource =
  | ({
      widgetType: "chart";
    } & DashboardSourceInput<OpenViewDashboardChartConfig>)
  | ({
      widgetType: "summary" | "workload";
    } & DashboardSourceInput<OpenViewDashboardAggregateConfig>)
  | ({
      widgetType: "records";
    } & DashboardSourceInput<OpenViewDashboardRecordsConfig>);
export type OpenViewDashboardWidgetInput = {
  placement: OpenViewWidgetPlacement;
} & OpenViewWidgetSource;
export type OpenViewDashboardCreateInput = {
  departmentId: string;
  name: string;
  position?: number;
  refreshCadence?: OpenViewDashboardRefreshCadence;
  widgets?: OpenViewDashboardWidgetInput[];
};
export type OpenViewDashboardUpdateInput = {
  id: string;
  revision: number;
  name?: string;
  position?: number;
  refreshCadence?: OpenViewDashboardRefreshCadence;
  /** Replaces the complete ordered widget list. */
  widgets?: OpenViewDashboardWidgetInput[];
};
export type OpenViewDashboardListOptions = {
  limit?: number;
  offset?: number;
  sortBy?: "position" | "name" | "created_at" | "updated_at";
  sortOrder?: "asc" | "desc";
  search?: string | null;
  deleted?: "exclude" | "include" | "only";
  departmentId?: string;
  /** true lists only home dashboards, false only the others. */
  home?: boolean;
};
export type OpenViewDashboardConflict =
  | {
      code: "stale_revision";
      message?: string;
      currentRevision?: number;
    }
  | {
      code:
        "dashboard_invalid" | "dashboard_archived" | "dashboard_not_archived";
      message?: string;
    };

function serializeWidgets(
  widgets: z.output<typeof dashboardWidgetInputSchema>[],
) {
  return widgets.map((widget) => ({
    widget_type: widget.widgetType,
    grid_column: widget.placement.column,
    grid_row: widget.placement.row,
    column_span: widget.placement.columnSpan,
    row_span: widget.placement.rowSpan,
    chart_id: widget.chartId,
    config:
      widget.config === null
        ? null
        : serializeDashboardWidgetConfig(widget.widgetType, widget.config),
  }));
}

function queryString(values: Record<string, string | number>) {
  return new URLSearchParams(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  ).toString();
}

export async function listOpenViewDashboards(
  raw: OpenViewDashboardListOptions = {},
): Promise<OpenViewDashboardPage> {
  const request = z
    .object({
      limit: z.number().int().min(1).max(100).default(25),
      offset: z.number().int().min(0).default(0),
      sortBy: z
        .enum(["position", "name", "created_at", "updated_at"])
        .optional(),
      sortOrder: z.enum(["asc", "desc"]).default("asc"),
      search: z.string().trim().max(100).nullish(),
      deleted: z.enum(["exclude", "include", "only"]).default("exclude"),
      departmentId: uuidSchema.optional(),
      home: z.boolean().optional(),
    })
    .strict()
    .parse(raw);
  const parameters: Record<string, string | number> = {
    limit: request.limit,
    offset: request.offset,
  };
  if (request.sortBy !== undefined) parameters.sort_by = request.sortBy;
  parameters.sort_order = request.sortOrder;
  if (request.search) parameters.search = request.search;
  parameters.deleted = request.deleted;
  if (request.departmentId) parameters.department_id = request.departmentId;
  if (request.home !== undefined) parameters.home = String(request.home);
  const path = `/dashboards?${queryString(parameters)}`;
  const responseSchema = dashboardListResponseSchema.superRefine(
    ({ items, pagination }, context) => {
      if (
        pagination.limit !== request.limit ||
        pagination.offset !== request.offset ||
        pagination.count !== items.length ||
        pagination.count > pagination.limit ||
        pagination.hasMore !==
          pagination.offset + pagination.count < pagination.total
      ) {
        context.addIssue({
          code: "custom",
          path: ["pagination"],
          message: "Dashboard page does not match the request",
        });
      }
    },
  );
  return openViewReadFetch(path, responseSchema, { cache: "no-store" });
}

export async function getOpenViewDashboard(
  id: string,
): Promise<OpenViewDashboard> {
  const dashboardId = uuidSchema.parse(id);
  return openViewReadFetch(
    `/dashboards/${encodeURIComponent(dashboardId)}`,
    dashboardSchema,
    { cache: "no-store" },
  );
}

export async function createOpenViewDashboard(
  raw: OpenViewDashboardCreateInput,
): Promise<OpenViewDashboard> {
  const input = dashboardCreateSchema.parse(raw);
  return apiFetch("/dashboards", dashboardSchema, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({
      department_id: input.departmentId,
      name: input.name,
      position: input.position,
      refresh_cadence: input.refreshCadence,
      widgets: serializeWidgets(input.widgets),
    }),
  });
}

export async function updateOpenViewDashboard(
  raw: OpenViewDashboardUpdateInput,
): Promise<OpenViewDashboard> {
  const input = dashboardUpdateSchema.parse(raw);
  const body: Record<string, unknown> = { revision: input.revision };
  if (input.name !== undefined) body.name = input.name;
  if (input.position !== undefined) body.position = input.position;
  if (input.refreshCadence !== undefined)
    body.refresh_cadence = input.refreshCadence;
  if (input.widgets !== undefined)
    body.widgets = serializeWidgets(input.widgets);
  return apiFetch(
    `/dashboards/${encodeURIComponent(input.id)}`,
    dashboardSchema,
    {
      method: "PATCH",
      cache: "no-store",
      body: JSON.stringify(body),
    },
  );
}

export async function archiveOpenViewDashboard(raw: {
  id: string;
  revision: number;
}): Promise<void> {
  const { id, revision } = dashboardRevisionRequestSchema.parse(raw);
  await apiFetch(
    `/dashboards/${encodeURIComponent(id)}?${queryString({ revision })}`,
    z.null(),
    { method: "DELETE", cache: "no-store" },
  );
}

export async function restoreOpenViewDashboard(raw: {
  id: string;
  revision: number;
}): Promise<OpenViewDashboard> {
  const { id, revision } = dashboardRevisionRequestSchema.parse(raw);
  return apiFetch(
    `/dashboards/${encodeURIComponent(id)}/restore`,
    dashboardSchema,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ revision }),
    },
  );
}

export function getOpenViewDashboardConflict(
  error: unknown,
): OpenViewDashboardConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = dashboardConflictDetailSchema.safeParse(error.details);
  if (!parsed.success) return null;
  const { code, message, current_revision } = parsed.data;
  if (code === "stale_revision") {
    return {
      code,
      ...(message === undefined ? {} : { message }),
      ...(current_revision === undefined
        ? {}
        : { currentRevision: current_revision }),
    };
  }
  return { code, ...(message === undefined ? {} : { message }) };
}
