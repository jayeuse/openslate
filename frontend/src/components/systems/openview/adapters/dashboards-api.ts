import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";
import type { OpenViewAggregateSnapshotRequest } from "./analytics-api";
import type {
  OpenViewQueryDefinition,
  OpenViewQueryFieldReference,
  OpenViewQueryFieldType,
} from "./views-api";
import { serializeOpenViewQueryDefinition } from "./views-api";

const uuidSchema = z.string().uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const queryFieldTypeSchema = z.enum([
  "text",
  "long_text",
  "email",
  "url",
  "number",
  "decimal",
  "int",
  "boolean",
  "date",
  "datetime",
  "select",
]);
const numericFieldTypes = new Set<OpenViewQueryFieldType>([
  "number",
  "decimal",
  "int",
]);

const queryFieldReferenceSchema = z
  .object({
    fieldId: uuidSchema,
    expectedType: queryFieldTypeSchema,
  })
  .strict();
const wireQueryFieldReferenceSchema = z
  .object({
    field_id: uuidSchema,
    expected_type: queryFieldTypeSchema,
  })
  .strict()
  .transform(({ field_id, expected_type }) => ({
    fieldId: field_id,
    expectedType: expected_type,
  }));

const scalarSchema = z.union([
  z.string().max(4000),
  z.boolean(),
  z.number().finite(),
]);
const wireQueryFilterSchema = z
  .object({
    field_id: uuidSchema,
    expected_type: queryFieldTypeSchema,
    operator: z.enum([
      "eq",
      "neq",
      "lt",
      "lte",
      "gt",
      "gte",
      "contains",
      "prefix",
      "suffix",
      "in",
      "empty",
      "not_empty",
      "blank",
      "not_blank",
    ]),
    value: z
      .union([scalarSchema, z.array(scalarSchema).min(1).max(100)])
      .nullish(),
  })
  .strict()
  .transform(({ field_id, expected_type, ...filter }) => ({
    fieldId: field_id,
    expectedType: expected_type,
    ...filter,
  }));
const wireQuerySortSchema = z
  .object({
    field_id: uuidSchema,
    expected_type: queryFieldTypeSchema,
    direction: z.enum(["asc", "desc"]),
  })
  .strict()
  .transform(({ field_id, expected_type, direction }) => ({
    fieldId: field_id,
    expectedType: expected_type,
    direction,
  }));
const wireQueryDefinitionSchema = z
  .object({
    version: z.literal(1),
    logic: z.enum(["and", "or"]),
    columns: z.array(wireQueryFieldReferenceSchema).max(100),
    filters: z.array(wireQueryFilterSchema).max(10),
    sort: z.array(wireQuerySortSchema).max(3),
    deleted: z.enum(["exclude", "include", "only"]),
    search: z.string().max(240).nullable(),
    search_fields: z.array(wireQueryFieldReferenceSchema).max(100),
  })
  .strict()
  .superRefine((wire, context) => {
    const definition = mapWireDefinition(wire);
    try {
      serializeOpenViewQueryDefinition(definition);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Dashboard chart query is invalid",
      });
    }
  })
  .transform(mapWireDefinition);

function mapWireDefinition(wire: {
  version: 1;
  logic: "and" | "or";
  columns: Array<z.output<typeof wireQueryFieldReferenceSchema>>;
  filters: Array<z.output<typeof wireQueryFilterSchema>>;
  sort: Array<z.output<typeof wireQuerySortSchema>>;
  deleted: "exclude" | "include" | "only";
  search: string | null;
  search_fields: Array<z.output<typeof wireQueryFieldReferenceSchema>>;
}): OpenViewQueryDefinition {
  return {
    version: wire.version,
    logic: wire.logic,
    columns: wire.columns,
    filters: wire.filters,
    sort: wire.sort,
    deleted: wire.deleted,
    search: wire.search,
    searchFields: wire.search_fields,
  };
}

const wireDateSeriesQuerySchema = z
  .object({
    mode: z.literal("date_series"),
    module_id: uuidSchema,
    definition: wireQueryDefinitionSchema,
    aggregation: z.enum(["count", "sum", "average"]),
    measure: wireQueryFieldReferenceSchema.nullable(),
    date_field: wireQueryFieldReferenceSchema,
    from_date: z.iso.date(),
    to_date: z.iso.date(),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.to_date < query.from_date ||
      inclusiveDays(query.from_date, query.to_date) > 366
    ) {
      context.addIssue({
        code: "custom",
        path: ["to_date"],
        message: "Dashboard date series must contain between 1 and 366 days",
      });
    }
    validateMeasure(query.aggregation, query.measure, context);
    if (
      query.date_field.expectedType !== "date" &&
      query.date_field.expectedType !== "datetime"
    ) {
      context.addIssue({
        code: "custom",
        path: ["date_field", "expected_type"],
        message: "Dashboard date series requires a date or datetime field",
      });
    }
  })
  .transform((query) => ({
    mode: query.mode,
    moduleId: query.module_id,
    definition: query.definition,
    aggregation: query.aggregation,
    ...(query.measure === null ? {} : { measure: query.measure }),
    dateField: query.date_field,
    fromDate: query.from_date,
    toDate: query.to_date,
  }));

const wireGroupQuerySchema = z
  .object({
    mode: z.literal("groups"),
    module_id: uuidSchema,
    definition: wireQueryDefinitionSchema,
    aggregation: z.enum(["count", "sum", "average"]),
    measure: wireQueryFieldReferenceSchema.nullable(),
    dimension: wireQueryFieldReferenceSchema,
    date_field: wireQueryFieldReferenceSchema.nullish(),
    from_date: z.iso.date().nullish(),
    to_date: z.iso.date().nullish(),
  })
  .strict()
  .superRefine((query, context) => {
    validateMeasure(query.aggregation, query.measure, context);
    const hasDateWindow =
      query.date_field != null ||
      query.from_date != null ||
      query.to_date != null;
    if (!hasDateWindow) return;
    if (
      !query.date_field ||
      !["date", "datetime"].includes(query.date_field.expectedType) ||
      !query.from_date ||
      !query.to_date ||
      query.to_date < query.from_date ||
      inclusiveDays(query.from_date, query.to_date) > 366
    )
      context.addIssue({
        code: "custom",
        path: ["date_field"],
        message: "Dashboard grouped date window is invalid",
      });
  })
  .transform((query) => ({
    mode: query.mode,
    moduleId: query.module_id,
    definition: query.definition,
    aggregation: query.aggregation,
    ...(query.measure === null ? {} : { measure: query.measure }),
    dimension: query.dimension,
    ...(query.date_field && query.from_date && query.to_date
      ? {
          dateField: query.date_field,
          fromDate: query.from_date,
          toDate: query.to_date,
        }
      : {}),
  }));

const wireSnapshotQuerySchema = z.discriminatedUnion("mode", [
  wireGroupQuerySchema,
  wireDateSeriesQuerySchema,
]);

const wireChartConfigSchema = z
  .object({
    version: z.literal(1),
    chart_type: z.enum(["bar", "line", "pie"]),
    query: wireSnapshotQuerySchema,
  })
  .strict()
  .superRefine(({ chart_type, query }, context) => {
    if ((chart_type === "line") !== (query.mode === "date_series")) {
      context.addIssue({
        code: "custom",
        path: ["query", "mode"],
        message:
          "Line charts require date series; bar and pie charts require groups",
      });
    }
  })
  .transform(({ version, chart_type, query }) => ({
    version,
    chartType: chart_type,
    query,
  }));
const wireAggregateConfigSchema = z
  .object({
    version: z.literal(1),
    query: wireGroupQuerySchema,
  })
  .strict();
const wireRecordsConfigSchema = z
  .object({
    version: z.literal(1),
    query: z
      .object({
        module_id: uuidSchema,
        definition: wireQueryDefinitionSchema,
      })
      .strict()
      .transform(({ module_id, definition }) => ({
        moduleId: module_id,
        definition,
      })),
  })
  .strict();

const queryBaseInputShape = {
  moduleId: uuidSchema,
  definition: z.unknown(),
  aggregation: z.enum(["count", "sum", "average"]),
  measure: queryFieldReferenceSchema.optional(),
};
const groupQueryInputSchema = z
  .object({
    ...queryBaseInputShape,
    mode: z.literal("groups"),
    dimension: queryFieldReferenceSchema,
    dateField: queryFieldReferenceSchema.optional(),
    fromDate: z.iso.date().optional(),
    toDate: z.iso.date().optional(),
  })
  .strict()
  .superRefine((query, context) => {
    validateMeasure(query.aggregation, query.measure, context);
    const hasDateWindow =
      query.dateField !== undefined ||
      query.fromDate !== undefined ||
      query.toDate !== undefined;
    if (!hasDateWindow) return;
    if (
      !query.dateField ||
      !["date", "datetime"].includes(query.dateField.expectedType) ||
      !query.fromDate ||
      !query.toDate ||
      query.toDate < query.fromDate ||
      inclusiveDays(query.fromDate, query.toDate) > 366
    )
      context.addIssue({
        code: "custom",
        path: ["dateField"],
        message: "Dashboard grouped date window is invalid",
      });
  });
const dateSeriesQueryInputSchema = z
  .object({
    ...queryBaseInputShape,
    mode: z.literal("date_series"),
    dateField: z
      .object({
        fieldId: uuidSchema,
        expectedType: z.enum(["date", "datetime"]),
      })
      .strict(),
    fromDate: z.iso.date(),
    toDate: z.iso.date(),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.toDate < query.fromDate ||
      inclusiveDays(query.fromDate, query.toDate) > 366
    ) {
      context.addIssue({
        code: "custom",
        path: ["toDate"],
        message: "Dashboard date series must contain between 1 and 366 days",
      });
    }
    validateMeasure(query.aggregation, query.measure, context);
  });
const snapshotQueryInputSchema = z.discriminatedUnion("mode", [
  groupQueryInputSchema,
  dateSeriesQueryInputSchema,
]);
const chartConfigInputSchema = z
  .object({
    version: z.literal(1),
    chartType: z.enum(["bar", "line", "pie"]),
    query: snapshotQueryInputSchema,
  })
  .strict()
  .superRefine(({ chartType, query }, context) => {
    if ((chartType === "line") !== (query.mode === "date_series")) {
      context.addIssue({
        code: "custom",
        path: ["query", "mode"],
        message:
          "Line charts require date series; bar and pie charts require groups",
      });
    }
  });
const aggregateConfigInputSchema = z
  .object({
    version: z.literal(1),
    query: groupQueryInputSchema,
  })
  .strict();
const recordsConfigInputSchema = z
  .object({
    version: z.literal(1),
    query: z
      .object({
        moduleId: uuidSchema,
        definition: z.unknown(),
      })
      .strict()
      .superRefine((query, context) => {
        try {
          serializeOpenViewQueryDefinition(
            query.definition as OpenViewQueryDefinition,
          );
        } catch {
          context.addIssue({
            code: "custom",
            path: ["definition"],
            message: "Dashboard record query is invalid",
          });
        }
      }),
  })
  .strict();
const dashboardWidgetInputSchema = z.discriminatedUnion("widgetType", [
  z
    .object({ widgetType: z.literal("chart"), config: chartConfigInputSchema })
    .strict(),
  z
    .object({
      widgetType: z.literal("summary"),
      config: aggregateConfigInputSchema,
    })
    .strict(),
  z
    .object({
      widgetType: z.literal("workload"),
      config: aggregateConfigInputSchema,
    })
    .strict(),
  z
    .object({
      widgetType: z.literal("records"),
      config: recordsConfigInputSchema,
    })
    .strict(),
]);
const refreshCadenceSchema = z.enum(["manual", "one-minute", "five-minutes"]);
const dashboardCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    refreshCadence: refreshCadenceSchema.default("manual"),
    widgets: z.array(dashboardWidgetInputSchema).max(12).default([]),
  })
  .strict();
const dashboardUpdateSchema = z
  .object({
    id: uuidSchema,
    revision: z.number().int().min(1),
    name: z.string().trim().min(1).max(200).optional(),
    refreshCadence: refreshCadenceSchema.optional(),
    widgets: z.array(dashboardWidgetInputSchema).max(12).optional(),
  })
  .strict()
  .superRefine(({ name, refreshCadence, widgets }, context) => {
    if (
      name === undefined &&
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
  position: z.number().int().min(0).max(11),
  created_at: timestampSchema,
  updated_at: timestampSchema,
};
function transformWireWidget<
  Widget extends {
    widget_type: "summary" | "workload" | "records" | "chart";
    created_at: string;
    updated_at: string;
  },
  WidgetType extends "summary" | "workload" | "records" | "chart",
>(widget: Widget, widgetType: WidgetType) {
  const { widget_type, created_at, updated_at, ...rest } = widget;
  void widget_type;
  return {
    ...rest,
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
      config: wireChartConfigSchema,
    })
    .strict()
    .transform((widget) => transformWireWidget(widget, "chart")),
  z
    .object({
      ...wireWidgetBaseShape,
      widget_type: z.literal("summary"),
      config: wireAggregateConfigSchema,
    })
    .strict()
    .transform((widget) => transformWireWidget(widget, "summary")),
  z
    .object({
      ...wireWidgetBaseShape,
      widget_type: z.literal("workload"),
      config: wireAggregateConfigSchema,
    })
    .strict()
    .transform((widget) => transformWireWidget(widget, "workload")),
  z
    .object({
      ...wireWidgetBaseShape,
      widget_type: z.literal("records"),
      config: wireRecordsConfigSchema,
    })
    .strict()
    .transform((widget) => transformWireWidget(widget, "records")),
]);
const dashboardSchema = z
  .object({
    id: uuidSchema,
    owner_id: uuidSchema,
    name: z.string().min(1).max(200),
    refresh_cadence: refreshCadenceSchema,
    revision: z.number().int().min(1),
    is_deleted: z.boolean(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
    widgets: z.array(wireWidgetSchema).max(12),
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
      owner_id,
      is_deleted,
      created_at,
      updated_at,
      refresh_cadence,
      ...dashboard
    }) => ({
      ...dashboard,
      ownerId: owner_id,
      isDeleted: is_deleted,
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
const dashboardDefaultSchema = z
  .object({ dashboard_id: uuidSchema.nullable() })
  .strict()
  .transform(({ dashboard_id }) => ({ dashboardId: dashboard_id }));
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

export type OpenViewDashboardChartQuery = OpenViewAggregateSnapshotRequest;
export type OpenViewDashboardChartConfig = {
  version: 1;
  chartType: "bar" | "line" | "pie";
  query: OpenViewDashboardChartQuery;
};
export type OpenViewDashboardAggregateConfig = {
  version: 1;
  query: OpenViewDashboardGroupQuery;
};
export type OpenViewDashboardGroupQuery = {
  mode: "groups";
  moduleId: string;
  definition: OpenViewQueryDefinition;
  aggregation: "count" | "sum" | "average";
  measure?: OpenViewQueryFieldReference;
  dimension: OpenViewQueryFieldReference;
  dateField?: OpenViewQueryFieldReference;
  fromDate?: string;
  toDate?: string;
};
export type OpenViewDashboardRecordsConfig = {
  version: 1;
  query: {
    moduleId: string;
    definition: OpenViewQueryDefinition;
  };
};
export type OpenViewDashboardWidgetType =
  "summary" | "workload" | "records" | "chart";
export type OpenViewDashboardWidgetConfig =
  | OpenViewDashboardChartConfig
  | OpenViewDashboardAggregateConfig
  | OpenViewDashboardRecordsConfig;
export type OpenViewDashboardRefreshCadence =
  "manual" | "one-minute" | "five-minutes";
type OpenViewDashboardWidgetBase = {
  id: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};
export type OpenViewDashboardWidget =
  | (OpenViewDashboardWidgetBase & {
      widgetType: "chart";
      config: OpenViewDashboardChartConfig;
    })
  | (OpenViewDashboardWidgetBase & {
      widgetType: "summary" | "workload";
      config: OpenViewDashboardAggregateConfig;
    })
  | (OpenViewDashboardWidgetBase & {
      widgetType: "records";
      config: OpenViewDashboardRecordsConfig;
    });
export type OpenViewDashboard = {
  id: string;
  ownerId: string;
  name: string;
  refreshCadence: OpenViewDashboardRefreshCadence;
  revision: number;
  isDeleted: boolean;
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
export type OpenViewDashboardDefault = { dashboardId: string | null };
export type OpenViewDashboardWidgetInput =
  | {
      widgetType: "chart";
      config: OpenViewDashboardChartConfig;
    }
  | {
      widgetType: "summary" | "workload";
      config: OpenViewDashboardAggregateConfig;
    }
  | {
      widgetType: "records";
      config: OpenViewDashboardRecordsConfig;
    };
export type OpenViewDashboardCreateInput = {
  name: string;
  refreshCadence?: OpenViewDashboardRefreshCadence;
  widgets?: OpenViewDashboardWidgetInput[];
};
export type OpenViewDashboardUpdateInput = {
  id: string;
  revision: number;
  name?: string;
  refreshCadence?: OpenViewDashboardRefreshCadence;
  /** Replaces the complete ordered widget list. */
  widgets?: OpenViewDashboardWidgetInput[];
};
export type OpenViewDashboardListOptions = {
  limit?: number;
  offset?: number;
  sortBy?: "name" | "created_at" | "updated_at";
  sortOrder?: "asc" | "desc";
  search?: string | null;
  deleted?: "exclude" | "include" | "only";
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

function inclusiveDays(fromDate: string, toDate: string): number {
  return (
    (Date.parse(`${toDate}T00:00:00.000Z`) -
      Date.parse(`${fromDate}T00:00:00.000Z`)) /
      (24 * 60 * 60 * 1000) +
    1
  );
}

function validateMeasure(
  aggregation: "count" | "sum" | "average",
  measure: OpenViewQueryFieldReference | null | undefined,
  context: z.RefinementCtx,
) {
  if (aggregation === "count") {
    if (measure !== undefined && measure !== null) {
      context.addIssue({
        code: "custom",
        path: ["measure"],
        message: "Count does not accept a measure field",
      });
    }
  } else if (measure == null || !numericFieldTypes.has(measure.expectedType)) {
    context.addIssue({
      code: "custom",
      path: ["measure"],
      message: "Sum and average require a numeric measure field",
    });
  }
}

function serializeSnapshotQuery(
  query: {
    mode: "groups" | "date_series";
    moduleId: string;
    definition: unknown;
    aggregation: "count" | "sum" | "average";
    measure?: OpenViewQueryFieldReference;
  } & Record<string, unknown>,
) {
  const wireDefinition = serializeOpenViewQueryDefinition(
    query.definition as OpenViewQueryDefinition,
  );
  const common = {
    module_id: query.moduleId,
    definition: wireDefinition,
    aggregation: query.aggregation,
    measure: query.measure
      ? {
          field_id: query.measure.fieldId,
          expected_type: query.measure.expectedType,
        }
      : null,
  };
  if (query.mode === "groups") {
    const group = query as typeof query & {
      dimension: OpenViewQueryFieldReference;
      dateField?: OpenViewQueryFieldReference;
      fromDate?: string;
      toDate?: string;
    };
    return {
      ...common,
      mode: query.mode,
      dimension: {
        field_id: group.dimension.fieldId,
        expected_type: group.dimension.expectedType,
      },
      ...(group.dateField && group.fromDate && group.toDate
        ? {
            date_field: {
              field_id: group.dateField.fieldId,
              expected_type: group.dateField.expectedType,
            },
            from_date: group.fromDate,
            to_date: group.toDate,
          }
        : {}),
    };
  }
  const date = query as typeof query & {
    dateField: OpenViewQueryFieldReference;
    fromDate: string;
    toDate: string;
  };
  return {
    ...common,
    mode: query.mode,
    date_field: {
      field_id: date.dateField.fieldId,
      expected_type: date.dateField.expectedType,
    },
    from_date: date.fromDate,
    to_date: date.toDate,
  };
}

function serializeChartConfig(config: unknown) {
  const parsed = chartConfigInputSchema.parse(config);
  return {
    version: parsed.version,
    chart_type: parsed.chartType,
    query: serializeSnapshotQuery(parsed.query),
  };
}

function serializeAggregateConfig(config: unknown) {
  const parsed = aggregateConfigInputSchema.parse(config);
  return {
    version: parsed.version,
    query: serializeSnapshotQuery(parsed.query),
  };
}

function serializeRecordsConfig(config: unknown) {
  const parsed = recordsConfigInputSchema.parse(config);
  return {
    version: parsed.version,
    query: {
      module_id: parsed.query.moduleId,
      definition: serializeOpenViewQueryDefinition(
        parsed.query.definition as OpenViewQueryDefinition,
      ),
    },
  };
}

function serializeWidgetConfig(
  widget: z.output<typeof dashboardWidgetInputSchema>,
) {
  switch (widget.widgetType) {
    case "chart":
      return serializeChartConfig(widget.config);
    case "summary":
    case "workload":
      return serializeAggregateConfig(widget.config);
    case "records":
      return serializeRecordsConfig(widget.config);
  }
}

function serializeWidgets(
  widgets: z.output<typeof dashboardWidgetInputSchema>[],
) {
  return widgets.map((widget) => ({
    widget_type: widget.widgetType,
    config: serializeWidgetConfig(widget),
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
      sortBy: z.enum(["name", "created_at", "updated_at"]).optional(),
      sortOrder: z.enum(["asc", "desc"]).default("asc"),
      search: z.string().trim().max(100).nullish(),
      deleted: z.enum(["exclude", "include", "only"]).default("exclude"),
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
  return apiFetch(path, responseSchema, { cache: "no-store" });
}

export async function getOpenViewDashboard(
  id: string,
): Promise<OpenViewDashboard> {
  const dashboardId = uuidSchema.parse(id);
  return apiFetch(
    `/dashboards/${encodeURIComponent(dashboardId)}`,
    dashboardSchema,
    { cache: "no-store" },
  );
}

export async function getOpenViewDashboardDefault(): Promise<OpenViewDashboardDefault> {
  return apiFetch("/dashboards/default", dashboardDefaultSchema, {
    cache: "no-store",
  });
}

export async function setOpenViewDashboardDefault(
  id: string | null,
): Promise<OpenViewDashboardDefault> {
  const dashboardId = uuidSchema.nullable().parse(id);
  return apiFetch("/dashboards/default", dashboardDefaultSchema, {
    method: "PUT",
    cache: "no-store",
    body: JSON.stringify({ dashboard_id: dashboardId }),
  });
}

export async function createOpenViewDashboard(
  raw: OpenViewDashboardCreateInput,
): Promise<OpenViewDashboard> {
  const input = dashboardCreateSchema.parse(raw);
  return apiFetch("/dashboards", dashboardSchema, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({
      name: input.name,
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
