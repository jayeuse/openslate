import { z } from "zod";
import {
  aggregateBucketSchema,
  validAggregateBucketWindow,
} from "../../openview/domain/aggregate-buckets";

export const EXPORT_FILENAME = "board-configuration.json";
export const uuidSchema = z.string().uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const named = (limit: number) =>
  z
    .string()
    .min(1)
    .max(limit)
    .refine((value) => value.trim().length > 0);
const fieldTypeSchema = z.enum([
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
const fieldSchema = z
  .object({
    name: named(150),
    expected_type: fieldTypeSchema,
  })
  .strict();
const scalarSchema = z.union([
  z.string().max(4000),
  z.boolean(),
  z.number().finite(),
]);
const filterOperatorSchema = z.enum([
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
]);
const filterSchema = fieldSchema
  .extend({
    operator: filterOperatorSchema,
    value: z
      .union([scalarSchema, z.array(scalarSchema).min(1).max(100)])
      .nullish(),
  })
  .strict()
  .superRefine((filter, context) => {
    const withoutValue = ["empty", "not_empty", "blank", "not_blank"];
    if (withoutValue.includes(filter.operator)) {
      if (filter.value != null)
        context.addIssue({ code: "custom", message: "Invalid filter value" });
    } else if (
      filter.value == null ||
      (filter.operator === "in") !== Array.isArray(filter.value)
    ) {
      context.addIssue({ code: "custom", message: "Invalid filter value" });
    }
    const allowed = new Set<string>(
      filter.expected_type === "user"
        ? withoutValue
        : ["eq", "neq", ...withoutValue],
    );
    if (["text", "long_text", "email", "url"].includes(filter.expected_type)) {
      ["contains", "prefix", "suffix"].forEach((operator) =>
        allowed.add(operator),
      );
    } else if (filter.expected_type === "select") {
      ["contains", "in"].forEach((operator) => allowed.add(operator));
    } else if (
      ["number", "decimal", "int", "date", "datetime"].includes(
        filter.expected_type,
      )
    ) {
      ["lt", "lte", "gt", "gte"].forEach((operator) => allowed.add(operator));
    }
    if (!allowed.has(filter.operator)) {
      context.addIssue({
        code: "custom",
        message: "Unsupported filter operator",
      });
    }
  });
const widgetConfigSchema = z
  .object({
    fields: z.array(fieldSchema).max(24),
    filters: z.array(filterSchema).max(8),
    logic: z.enum(["and", "or"]),
    metric: fieldSchema.nullable(),
    visualization: z.enum(["bar", "line", "pie"]),
    size: z.enum(["S", "M", "L", "half", "full"]),
    refresh: z.enum(["manual", "one-minute", "five-minutes"]),
    pinned: z.boolean(),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      new Set(config.fields.map((field) => field.name)).size !==
      config.fields.length
    ) {
      context.addIssue({ code: "custom", message: "Duplicate widget fields" });
    }
    if (
      config.metric &&
      !["number", "decimal", "int"].includes(config.metric.expected_type)
    ) {
      context.addIssue({ code: "custom", message: "Metric must be numeric" });
    }
  });
const namedSortSchema = fieldSchema
  .extend({ direction: z.enum(["asc", "desc"]).default("asc") })
  .strict();
const namedDefinitionSchema = z
  .object({
    version: z.literal(1).default(1),
    columns: z.array(fieldSchema).max(100).default([]),
    filters: z.array(filterSchema).max(10).default([]),
    logic: z.enum(["and", "or"]).default("and"),
    sort: z.array(namedSortSchema).max(3).default([]),
    search_fields: z.array(fieldSchema).max(100).default([]),
    deleted: z.enum(["exclude", "include", "only"]).default("exclude"),
    search: z
      .string()
      .max(240)
      .nullable()
      .default(null)
      .transform((value) => value?.trim() || null),
  })
  .strict()
  .superRefine((definition, context) => {
    for (const references of [definition.columns, definition.sort]) {
      if (
        new Set(references.map((reference) => reference.name)).size !==
        references.length
      )
        context.addIssue({
          code: "custom",
          message: "Duplicate named query references",
        });
    }
  });
const namedAggregateShape = {
  definition: namedDefinitionSchema,
  aggregation: z
    .enum(["count", "sum", "average", "min", "max", "distinct"])
    .default("count"),
  measure: fieldSchema.nullable().default(null),
};
function namedMeasureIsValid(query: {
  aggregation: string;
  measure: { expected_type: string } | null;
}): boolean {
  if (query.aggregation === "count") return query.measure === null;
  if (!query.measure) return false;
  return (
    query.aggregation === "distinct" ||
    ["number", "decimal", "int"].includes(query.measure.expected_type)
  );
}
const namedGroupsSchema = z
  .object({
    ...namedAggregateShape,
    mode: z.literal("groups"),
    dimension: fieldSchema,
    date_field: fieldSchema.nullable().default(null),
    from_date: z.iso.date().nullable().default(null),
    to_date: z.iso.date().nullable().default(null),
  })
  .strict()
  .superRefine((query, context) => {
    if (!namedMeasureIsValid(query))
      context.addIssue({ code: "custom", message: "Invalid named measure" });
    if (
      query.date_field === null &&
      query.from_date === null &&
      query.to_date === null
    )
      return;
    if (
      !query.date_field ||
      !["date", "datetime"].includes(query.date_field.expected_type) ||
      !query.from_date ||
      !query.to_date ||
      query.to_date < query.from_date ||
      (Date.parse(`${query.to_date}T00:00:00Z`) -
        Date.parse(`${query.from_date}T00:00:00Z`)) /
        86_400_000 +
        1 >
        366
    )
      context.addIssue({
        code: "custom",
        message: "Invalid named grouped date window",
      });
  });
const namedDateSeriesSchema = z
  .object({
    ...namedAggregateShape,
    mode: z.literal("date_series"),
    date_field: fieldSchema,
    from_date: z.iso.date(),
    to_date: z.iso.date(),
    bucket: aggregateBucketSchema.default("day"),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      !namedMeasureIsValid(query) ||
      !["date", "datetime"].includes(query.date_field.expected_type) ||
      !validAggregateBucketWindow(query.from_date, query.to_date, query.bucket)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid named calendar query",
      });
  });
const namedRecordsSchema = z
  .object({ definition: namedDefinitionSchema })
  .strict();
const normalizedPresentation = {
  version: z.literal(1).default(1),
  size: z.enum(["S", "M", "L"]),
  refresh: z.literal("manual"),
  pinned: z.boolean(),
};
const normalizedChartSchema = z
  .object({
    ...normalizedPresentation,
    chart_type: z.enum(["bar", "line", "pie"]),
    query: z.union([namedGroupsSchema, namedDateSeriesSchema]),
  })
  .strict()
  .refine(
    (config) =>
      (config.chart_type === "line") === (config.query.mode === "date_series"),
  );
const normalizedAggregateSchema = z
  .object({ ...normalizedPresentation, query: namedGroupsSchema })
  .strict();
const normalizedRecordsSchema = z
  .object({ ...normalizedPresentation, query: namedRecordsSchema })
  .strict();
const portableConfigSchema = z.union([
  widgetConfigSchema,
  normalizedChartSchema,
  normalizedAggregateSchema,
  normalizedRecordsSchema,
]);

const sourceSchema = z
  .object({
    department_name: named(150),
    module_name: named(150),
  })
  .strict();
const widgetSchema = z
  .object({
    name: named(80),
    widget_type: z.enum(["summary", "workload", "records", "chart"]),
    source: sourceSchema,
    config: portableConfigSchema,
  })
  .strict()
  .superRefine((widget, context) => {
    if ("fields" in widget.config) return;
    const config = widget.config;
    const valid =
      widget.widget_type === "chart"
        ? "chart_type" in config
        : !("chart_type" in config) &&
          (widget.widget_type === "records"
            ? !("mode" in config.query)
            : "mode" in config.query && config.query.mode === "groups");
    if (!valid)
      context.addIssue({
        code: "custom",
        message: "Widget type does not match named query",
      });
  });
export const bundleSchema = z
  .object({
    kind: z.literal("openslate-board"),
    version: z.literal(3),
    configuration: z
      .object({
        name: named(200),
        description: z.string().max(240).nullable(),
        widgets: z.array(widgetSchema).max(12),
      })
      .strict(),
  })
  .strict();
export const boardScopeSchema = z.enum(["company", "department", "project"]);
export const accessLevelSchema = z.enum(["read", "write", "manage"]);
export const boardSchema = z
  .object({
    id: uuidSchema,
    scope: boardScopeSchema,
    department_id: uuidSchema.nullable(),
    name: named(200),
    description: z.string().nullable(),
    status: z.enum(["active", "archived"]),
    revision: z.number().int().min(1),
    level: accessLevelSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .refine(
    (board) =>
      (board.scope === "department") === (board.department_id !== null),
  )
  .transform((board) => ({
    id: board.id,
    scope: board.scope,
    departmentId: board.department_id,
    name: board.name,
    description: board.description,
    status: board.status,
    revision: board.revision,
    level: board.level,
    createdAt: board.created_at,
    updatedAt: board.updated_at,
  }));
const paginationSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict()
  .refine(({ count, limit }) => count <= limit)
  .transform(({ has_more, ...page }) => ({ ...page, hasMore: has_more }));
export const boardListSchema = z
  .object({ items: z.array(boardSchema), pagination: paginationSchema })
  .strict()
  .refine(({ items, pagination }) => items.length === pagination.count);
export const boardListOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    sortBy: z.enum(["name", "created_at", "updated_at"]).default("name"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
    status: z.enum(["active", "archived", "all"]).default("active"),
    search: z.string().trim().min(1).max(100).optional(),
    scope: boardScopeSchema.optional(),
    departmentId: uuidSchema.optional(),
  })
  .strict();
export const boardCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().nullable().optional(),
  })
  .strict();
export const revisionSchema = z.number().int().min(1);
export const boardUpdateSchema = boardCreateSchema
  .partial()
  .extend({ revision: revisionSchema })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "revision"));

export type PortableBoardBundle = z.output<typeof bundleSchema>;
export type BoardManagementBoard = z.output<typeof boardSchema>;
export type BoardManagementPage = z.output<typeof boardListSchema>;
export type BoardListOptions = z.input<typeof boardListOptionsSchema>;
export type BoardCreateInput = z.input<typeof boardCreateSchema>;
export type BoardUpdateInput = z.input<typeof boardUpdateSchema>;
export type BoardScope = z.output<typeof boardScopeSchema>;
export type BoardAccessLevel = z.output<typeof accessLevelSchema>;
export type BoardConfigurationDownload = {
  blob: Blob;
  filename: typeof EXPORT_FILENAME;
  bundle: PortableBoardBundle;
};

export const boardGroupsSchema = z
  .object({
    board_id: uuidSchema,
    revision: z.number().int().min(1),
    groups: z
      .array(
        z
          .object({
            group_id: uuidSchema,
            name: z.string().min(1).max(200),
            level: accessLevelSchema,
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .transform((value) => ({
    boardId: value.board_id,
    revision: value.revision,
    groups: value.groups.map((group) => ({
      groupId: group.group_id,
      name: group.name,
      level: group.level,
    })),
  }));
export const boardGroupsInputSchema = z
  .object({
    revision: revisionSchema,
    groups: z
      .array(
        z.object({ groupId: uuidSchema, level: accessLevelSchema }).strict(),
      )
      .max(100)
      .refine(
        (groups) =>
          new Set(groups.map((group) => group.groupId)).size === groups.length,
      ),
  })
  .strict();
export type BoardGroups = z.output<typeof boardGroupsSchema>;
export type BoardGroupsInput = z.input<typeof boardGroupsInputSchema>;
