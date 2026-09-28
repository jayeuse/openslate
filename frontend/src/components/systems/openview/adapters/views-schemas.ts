import { z } from "zod";

const uuidSchema = z.string().uuid();
const timestampSchema = z.iso.datetime({ offset: true });

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
]);
const queryFieldTypeSchema = fieldTypeSchema;
const viewLayoutSchema = z.enum([
  "table",
  "grid",
  "kanban",
  "calendar",
  "timeline",
  "gallery",
]);

const pageRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
const savedViewListRequestSchema = z
  .object({
    moduleId: uuidSchema,
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
    deleted: z.enum(["exclude", "include", "only"]).optional(),
  })
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
const queryFilterSchema = z
  .object({
    fieldId: uuidSchema,
    expectedType: queryFieldTypeSchema,
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
  .superRefine((filter, context) => {
    const emptyOperators = new Set([
      "empty",
      "not_empty",
      "blank",
      "not_blank",
    ]);
    if (emptyOperators.has(filter.operator)) {
      if (filter.value !== undefined && filter.value !== null) {
        context.addIssue({
          code: "custom",
          message: "Empty checks do not accept a value",
        });
      }
    } else if (filter.value === undefined || filter.value === null) {
      context.addIssue({
        code: "custom",
        message: "Comparison requires a value",
      });
    } else if ((filter.operator === "in") !== Array.isArray(filter.value)) {
      context.addIssue({
        code: "custom",
        message: "Only membership accepts a list",
      });
    }

    const basic = new Set<string>([
      "eq",
      "neq",
      "empty",
      "not_empty",
      "blank",
      "not_blank",
    ]);
    const supported = new Set(basic);
    if (["text", "long_text", "email", "url"].includes(filter.expectedType)) {
      ["contains", "prefix", "suffix"].forEach((operator) =>
        supported.add(operator),
      );
    } else if (filter.expectedType === "select") {
      ["contains", "in"].forEach((operator) => supported.add(operator));
    } else if (
      ["number", "decimal", "int", "date", "datetime"].includes(
        filter.expectedType,
      )
    ) {
      ["lt", "lte", "gt", "gte"].forEach((operator) => supported.add(operator));
    }
    if (!supported.has(filter.operator)) {
      context.addIssue({
        code: "custom",
        message: "Operator is unsupported for this field type",
      });
    }
  });
const querySortSchema = queryFieldReferenceSchema.extend({
  direction: z.enum(["asc", "desc"]),
});
const queryDefinitionSchema = z
  .object({
    version: z.literal(1),
    logic: z.enum(["and", "or"]),
    columns: z.array(queryFieldReferenceSchema).max(100),
    filters: z.array(queryFilterSchema).max(10),
    sort: z.array(querySortSchema).max(3),
    deleted: z.enum(["exclude", "include", "only"]),
    search: z.string().max(240).nullable(),
    searchFields: z.array(queryFieldReferenceSchema).max(100),
  })
  .strict()
  .superRefine((definition, context) => {
    for (const fieldList of [definition.columns, definition.sort]) {
      if (
        new Set(fieldList.map(({ fieldId }) => fieldId)).size !==
        fieldList.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Duplicate field references are not permitted",
        });
      }
    }
  });
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
  }))
  .pipe(queryFilterSchema);
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
  .transform(({ search_fields, ...definition }) => ({
    ...definition,
    searchFields: search_fields,
  }))
  .pipe(queryDefinitionSchema);

const presentationSchema = z
  .object({
    version: z.literal(1),
    layout: viewLayoutSchema,
    columnFieldIds: z.array(uuidSchema).max(20),
    pinnedFieldIds: z.array(uuidSchema).max(1),
    density: z.enum(["comfortable", "compact"]),
    wrap: z.boolean(),
    cardSize: z.enum(["comfortable", "compact"]),
    primaryFieldId: uuidSchema.nullable(),
    secondaryFieldId: uuidSchema.nullable(),
    dateFieldId: uuidSchema.nullable(),
    timelineStartFieldId: uuidSchema.nullable().optional(),
    timelineEndFieldId: uuidSchema.nullable().optional(),
    timelineDeadlineFieldId: uuidSchema.nullable().optional(),
    timelineProgressFieldId: uuidSchema.nullable().optional(),
    groupByFieldId: uuidSchema.nullable(),
    dateRange: z.enum(["week", "month", "quarter", "year"]),
    scale: z.enum(["month", "list"]).nullable(),
  })
  .strict()
  .superRefine((presentation, context) => {
    if (
      presentation.pinnedFieldIds.some(
        (fieldId) => !presentation.columnFieldIds.includes(fieldId),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Pinned fields must also be visible columns",
      });
    }
  });
const wirePresentationSchema = z
  .object({
    version: z.literal(1),
    layout: viewLayoutSchema,
    column_field_ids: z.array(uuidSchema).max(20),
    pinned_field_ids: z.array(uuidSchema).max(1),
    density: z.enum(["comfortable", "compact"]),
    wrap: z.boolean(),
    card_size: z.enum(["comfortable", "compact"]),
    primary_field_id: uuidSchema.nullable(),
    secondary_field_id: uuidSchema.nullable(),
    date_field_id: uuidSchema.nullable(),
    timeline_start_field_id: uuidSchema.nullable().optional(),
    timeline_end_field_id: uuidSchema.nullable().optional(),
    timeline_deadline_field_id: uuidSchema.nullable().optional(),
    timeline_progress_field_id: uuidSchema.nullable().optional(),
    group_by_field_id: uuidSchema.nullable(),
    date_range: z.enum(["week", "month", "quarter", "year"]),
    scale: z.enum(["month", "list"]).nullable(),
  })
  .strict()
  .transform(
    ({
      column_field_ids,
      pinned_field_ids,
      card_size,
      primary_field_id,
      secondary_field_id,
      date_field_id,
      timeline_start_field_id,
      timeline_end_field_id,
      timeline_deadline_field_id,
      timeline_progress_field_id,
      group_by_field_id,
      date_range,
      scale,
      ...presentation
    }) => ({
      ...presentation,
      columnFieldIds: column_field_ids,
      pinnedFieldIds: pinned_field_ids,
      cardSize: card_size,
      primaryFieldId: primary_field_id,
      secondaryFieldId: secondary_field_id,
      dateFieldId: date_field_id,
      ...(timeline_start_field_id === undefined
        ? {}
        : { timelineStartFieldId: timeline_start_field_id }),
      ...(timeline_end_field_id === undefined
        ? {}
        : { timelineEndFieldId: timeline_end_field_id }),
      ...(timeline_deadline_field_id === undefined
        ? {}
        : { timelineDeadlineFieldId: timeline_deadline_field_id }),
      ...(timeline_progress_field_id === undefined
        ? {}
        : { timelineProgressFieldId: timeline_progress_field_id }),
      groupByFieldId: group_by_field_id,
      dateRange: date_range,
      scale,
    }),
  );

const savedViewResponseSchema = z
  .object({
    id: uuidSchema,
    module_id: uuidSchema,
    name: z.string().min(1).max(200),
    is_default: z.boolean(),
    definition: wireQueryDefinitionSchema,
    presentation: wirePresentationSchema,
    revision: z.number().int().min(1),
    is_deleted: z.boolean(),
    can_edit: z.boolean(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .transform((view) => ({
    id: view.id,
    moduleId: view.module_id,
    name: view.name,
    isDefault: view.is_default,
    definition: view.definition,
    presentation: view.presentation,
    revision: view.revision,
    isDeleted: view.is_deleted,
    canEdit: view.can_edit,
    createdAt: view.created_at,
    updatedAt: view.updated_at,
  }));

const dataSourceSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1),
    department_id: uuidSchema,
  })
  .strict()
  .transform(({ id, name, department_id }) => ({
    id,
    name,
    departmentId: department_id,
  }));
const fieldSchema = z
  .object({
    id: uuidSchema,
    module_id: uuidSchema,
    name: z.string().min(1),
    type: fieldTypeSchema,
    required: z.boolean(),
    position: z.number().int().min(0),
    config: z.record(z.string(), z.unknown()),
  })
  .strict()
  .transform(({ module_id, ...field }) => ({ ...field, moduleId: module_id }));
const recordSchema = z
  .object({
    id: uuidSchema,
    module_id: uuidSchema,
    data: z.record(z.string(), z.unknown()),
    created_at: timestampSchema,
    updated_at: timestampSchema,
    deleted_at: timestampSchema.nullable(),
    is_deleted: z.boolean(),
    performed_by: uuidSchema.nullable(),
  })
  .strict()
  .transform(
    ({
      module_id,
      created_at,
      updated_at,
      deleted_at,
      is_deleted,
      performed_by,
      ...record
    }) => ({
      ...record,
      moduleId: module_id,
      createdAt: created_at,
      updatedAt: updated_at,
      deletedAt: deleted_at,
      isDeleted: is_deleted,
      performedBy: performed_by,
    }),
  );

function listSchema<Item extends z.ZodType>(item: Item) {
  return z
    .object({ items: z.array(item), pagination: paginationSchema })
    .strict();
}

const dataSourceListSchema = listSchema(dataSourceSchema);
const savedViewListSchema = listSchema(savedViewResponseSchema);
const recordListSchema = listSchema(recordSchema);

const savedViewCreateSchema = z
  .object({
    moduleId: uuidSchema,
    name: z.string().min(1).max(200),
    isDefault: z.boolean().default(false),
    definition: queryDefinitionSchema,
    presentation: presentationSchema,
  })
  .strict();
const savedViewUpdateSchema = z
  .object({
    id: uuidSchema,
    revision: z.number().int().min(1),
    name: z.string().min(1).max(200).optional(),
    isDefault: z.boolean().optional(),
    definition: queryDefinitionSchema.optional(),
    presentation: presentationSchema.optional(),
  })
  .strict()
  .superRefine((update, context) => {
    if (
      update.name === undefined &&
      update.isDefault === undefined &&
      update.definition === undefined &&
      update.presentation === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "At least one change is required",
      });
    }
  });
const archiveSchema = z
  .object({ id: uuidSchema, revision: z.number().int().min(1) })
  .strict();
const restoreSchema = archiveSchema;
const recordQuerySchema = z
  .object({
    moduleId: uuidSchema,
    definition: queryDefinitionSchema,
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export type OpenViewQueryFieldType = z.infer<typeof queryFieldTypeSchema>;
export type OpenViewQueryFieldReference = z.infer<
  typeof queryFieldReferenceSchema
>;
export type OpenViewQueryFilter = z.infer<typeof queryFilterSchema>;
export type OpenViewQueryDefinition = z.infer<typeof queryDefinitionSchema>;
export type OpenViewPresentation = z.infer<typeof presentationSchema>;
export type OpenViewSavedView = z.output<typeof savedViewResponseSchema>;
export type OpenViewPage<T> = {
  items: T[];
  pagination: z.output<typeof paginationSchema>;
};
export type OpenViewDataSource = z.output<typeof dataSourceSchema>;
export type OpenViewDataSourceField = z.output<typeof fieldSchema>;
export type OpenViewRecord = z.output<typeof recordSchema>;
export type OpenViewConflict = {
  code: "stale_revision";
  message?: string;
  currentRevision?: number;
};

export {
  archiveSchema,
  dataSourceListSchema,
  fieldSchema,
  listSchema,
  pageRequestSchema,
  presentationSchema,
  queryDefinitionSchema,
  recordListSchema,
  recordQuerySchema,
  restoreSchema,
  savedViewCreateSchema,
  savedViewListRequestSchema,
  savedViewListSchema,
  savedViewResponseSchema,
  savedViewUpdateSchema,
  wireQueryDefinitionSchema,
  uuidSchema,
};
