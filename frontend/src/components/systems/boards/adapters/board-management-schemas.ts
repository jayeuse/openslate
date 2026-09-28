import { z } from "zod";

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
    size: z.enum(["half", "full"]),
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
    config: widgetConfigSchema,
  })
  .strict();
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
const lifecycleRowStateSchema = z
  .object({
    entity_type: z.string().min(1).max(100),
    entity_id: uuidSchema,
    is_deleted: z.boolean(),
    deleted_at: timestampSchema.nullable(),
    updated_at: timestampSchema,
    state_fingerprint: z.string().max(128),
    byte_count: z.number().int().min(0).nullable(),
  })
  .strict();
const lifecycleBlockerSchema = z
  .object({
    code: z.string().min(1).max(100),
    entity_type: z.string().min(1).max(100),
    entity_id: uuidSchema,
    detail: z.string().max(500),
    conflicting_entity_type: z.string().max(100).nullable(),
    conflicting_entity_id: uuidSchema.nullable(),
    field_id: uuidSchema.nullable(),
    field_name: z.string().max(150).nullable(),
    module_id: uuidSchema.nullable(),
    module_name: z.string().max(150).nullable(),
    department_id: uuidSchema.nullable(),
    department_name: z.string().max(150).nullable(),
  })
  .strict();
const lifecycleImpactSchema = z
  .object({
    target_type: z.literal("board"),
    target_id: uuidSchema,
    operation: z.literal("purge"),
    actor_id: uuidSchema.nullable(),
    rows: z.array(lifecycleRowStateSchema),
    external_impacts: z.array(z.record(z.string(), z.unknown())),
    key_strips: z.array(z.record(z.string(), z.unknown())),
    blockers: z.array(lifecycleBlockerSchema),
    impact_digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const boardPurgePreviewSchema = z
  .object({
    impact: lifecycleImpactSchema,
    token: z.string().min(1).max(128),
    expires_at: timestampSchema,
    confirmation_name: uuidSchema,
  })
  .strict();
export const boardPurgeResultSchema = z
  .object({
    impact: lifecycleImpactSchema,
    operation_id: uuidSchema.nullable(),
  })
  .strict();
export const boardPurgeInputSchema = z
  .object({
    token: z.string().min(1).max(128),
    confirmationName: z.string().trim().min(1).max(150),
    password: z.string().min(1).max(256),
  })
  .strict();
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
export type BoardPurgePreview = z.output<typeof boardPurgePreviewSchema>;
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
