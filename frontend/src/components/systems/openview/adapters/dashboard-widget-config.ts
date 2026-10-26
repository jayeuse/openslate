/**
 * The native definitions of dashboard widgets and saved Charts: the wire
 * schemas, the input checks and the serializer. Saved-chart reads use these,
 * and the shell reaches them through the Charts list, so they stay apart from
 * the dashboard reads and the editor (budget: tests/http/comms-js-budget).
 */
import { z } from "zod";
import {
  aggregateBucketSchema,
  validAggregateBucketWindow,
} from "../domain/aggregate-buckets";
import type { Aggregation } from "../domain/chart-query";
import type { OpenViewAggregateSnapshotRequest } from "./analytics-api";
import type {
  OpenViewQueryDefinition,
  OpenViewQueryFieldReference,
  OpenViewQueryFieldType,
} from "./views-api";
import { serializeOpenViewQueryDefinition } from "./views-api";

export const uuidSchema = z.string().uuid();
export const timestampSchema = z.iso.datetime({ offset: true });
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
  "user",
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
    aggregation: z.enum(["count", "sum", "average", "min", "max", "distinct"]),
    measure: wireQueryFieldReferenceSchema.nullable(),
    date_field: wireQueryFieldReferenceSchema,
    from_date: z.iso.date(),
    to_date: z.iso.date(),
    bucket: aggregateBucketSchema.default("day"),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      !validAggregateBucketWindow(query.from_date, query.to_date, query.bucket)
    ) {
      context.addIssue({
        code: "custom",
        path: ["to_date"],
        message:
          "Dashboard date series must contain between 1 and 366 calendar buckets",
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
    bucket: query.bucket,
  }));

const wireGroupQuerySchema = z
  .object({
    mode: z.literal("groups"),
    module_id: uuidSchema,
    definition: wireQueryDefinitionSchema,
    aggregation: z.enum(["count", "sum", "average", "min", "max", "distinct"]),
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

export const wireChartConfigSchema = z
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
export const wireAggregateConfigSchema = z
  .object({
    version: z.literal(1),
    query: wireGroupQuerySchema,
  })
  .strict();
export const wireRecordsConfigSchema = z
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

/** Complete native inline configurations shared by Dashboard and Board reads. */
export const dashboardWidgetWireConfigSchema = z.union([
  wireChartConfigSchema,
  wireAggregateConfigSchema,
  wireRecordsConfigSchema,
]);

const queryBaseInputShape = {
  moduleId: uuidSchema,
  definition: z.unknown(),
  aggregation: z.enum(["count", "sum", "average", "min", "max", "distinct"]),
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
    bucket: aggregateBucketSchema.default("day"),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      !validAggregateBucketWindow(query.fromDate, query.toDate, query.bucket)
    ) {
      context.addIssue({
        code: "custom",
        path: ["toDate"],
        message:
          "Dashboard date series must contain between 1 and 366 calendar buckets",
      });
    }
    validateMeasure(query.aggregation, query.measure, context);
  });
const snapshotQueryInputSchema = z.discriminatedUnion("mode", [
  groupQueryInputSchema,
  dateSeriesQueryInputSchema,
]);
export const chartConfigInputSchema = z
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
export const aggregateConfigInputSchema = z
  .object({
    version: z.literal(1),
    query: groupQueryInputSchema,
  })
  .strict();
export const recordsConfigInputSchema = z
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
export const dashboardWidgetConfigInputSchema = z.union([
  chartConfigInputSchema,
  aggregateConfigInputSchema,
  recordsConfigInputSchema,
]);

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
  aggregation: Aggregation;
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

export function inclusiveDays(fromDate: string, toDate: string): number {
  return (
    (Date.parse(`${toDate}T00:00:00.000Z`) -
      Date.parse(`${fromDate}T00:00:00.000Z`)) /
      (24 * 60 * 60 * 1000) +
    1
  );
}

export function validateMeasure(
  aggregation: Aggregation,
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
  } else if (
    measure == null ||
    (aggregation !== "distinct" && !numericFieldTypes.has(measure.expectedType))
  ) {
    context.addIssue({
      code: "custom",
      path: ["measure"],
      message:
        "A measure is required; sum, average, min and max require a numeric field",
    });
  }
}

function serializeSnapshotQuery(
  query: {
    mode: "groups" | "date_series";
    moduleId: string;
    definition: unknown;
    aggregation: Aggregation;
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
    bucket: date.bucket,
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

/** Serialize the existing native definition; never turn a reference into inline config. */
export function serializeDashboardWidgetConfig(
  widgetType: OpenViewDashboardWidgetType,
  config: unknown,
) {
  switch (widgetType) {
    case "chart":
      return serializeChartConfig(config);
    case "summary":
    case "workload":
      return serializeAggregateConfig(config);
    case "records":
      return serializeRecordsConfig(config);
  }
}
