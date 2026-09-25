import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";
import type { AudienceRef } from "../domain/model";

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
const audienceOptionKindSchema = z.enum(["role", "user"]);
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

const audienceInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("private") }).strict(),
  z.object({ kind: z.literal("everyone") }).strict(),
  z.object({ kind: z.literal("role"), id: uuidSchema }).strict(),
  z.object({ kind: z.literal("identity"), id: uuidSchema }).strict(),
]);
const wireAudienceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("private"),
      role_id: z.null().optional(),
      user_id: z.null().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("everyone"),
      role_id: z.null().optional(),
      user_id: z.null().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("role"),
      role_id: uuidSchema,
      user_id: z.null().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("user"),
      role_id: z.null().optional(),
      user_id: uuidSchema,
    })
    .strict(),
]);

const savedViewResponseSchema = z
  .object({
    id: uuidSchema,
    module_id: uuidSchema,
    owner_id: uuidSchema,
    name: z.string().min(1).max(200),
    visibility: z.enum(["private", "workspace"]),
    audience: wireAudienceSchema.optional(),
    definition: wireQueryDefinitionSchema,
    presentation: wirePresentationSchema,
    revision: z.number().int().min(1),
    is_deleted: z.boolean(),
    can_edit: z.boolean(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .superRefine((view, context) => {
    if (
      view.audience &&
      view.visibility !==
        (view.audience.kind === "private" ? "private" : "workspace")
    ) {
      context.addIssue({
        code: "custom",
        message: "Visibility must agree with audience",
      });
    }
  })
  .transform((view) => ({
    id: view.id,
    moduleId: view.module_id,
    ownerId: view.owner_id,
    name: view.name,
    audience: view.audience
      ? toDomainAudience(view.audience)
      : view.visibility === "private"
        ? ({ kind: "private" } as const)
        : ({ kind: "everyone" } as const),
    visibility: view.visibility,
    definition: view.definition,
    presentation: view.presentation,
    revision: view.revision,
    isDeleted: view.is_deleted,
    canEdit: view.can_edit,
    createdAt: view.created_at,
    updatedAt: view.updated_at,
  }));

function toDomainAudience(
  audience: z.output<typeof wireAudienceSchema>,
): AudienceRef {
  switch (audience.kind) {
    case "private":
      return { kind: "private" };
    case "everyone":
      return { kind: "everyone" };
    case "role":
      return { kind: "role", id: audience.role_id };
    case "user":
      return { kind: "identity", id: audience.user_id };
  }
}

function toWireAudience(audience: z.input<typeof audienceInputSchema>) {
  const validAudience = audienceInputSchema.parse(audience);
  switch (validAudience.kind) {
    case "private":
      return { kind: "private" as const };
    case "everyone":
      return { kind: "everyone" as const };
    case "role":
      return { kind: "role" as const, role_id: validAudience.id };
    case "identity":
      return { kind: "user" as const, user_id: validAudience.id };
  }
}

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
const audienceOptionSchema = z
  .object({
    kind: audienceOptionKindSchema,
    id: uuidSchema,
    label: z.string().min(1),
  })
  .strict()
  .transform(({ kind, id, label }) => ({
    kind: kind === "user" ? ("identity" as const) : kind,
    id,
    label,
  }));
const defaultSchema = z
  .object({
    module_id: uuidSchema,
    view_id: uuidSchema,
    revision: z.number().int().min(1),
  })
  .strict()
  .transform(({ module_id, view_id, revision }) => ({
    moduleId: module_id,
    viewId: view_id,
    revision,
  }));
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
const audienceOptionListSchema = listSchema(audienceOptionSchema);
const savedViewListSchema = listSchema(savedViewResponseSchema);
const defaultListSchema = listSchema(defaultSchema);
const recordListSchema = listSchema(recordSchema);

const savedViewCreateSchema = z
  .object({
    moduleId: uuidSchema,
    name: z.string().min(1).max(200),
    audience: audienceInputSchema,
    definition: queryDefinitionSchema,
    presentation: presentationSchema,
  })
  .strict();
const savedViewUpdateSchema = z
  .object({
    id: uuidSchema,
    revision: z.number().int().min(1),
    name: z.string().min(1).max(200).optional(),
    audience: audienceInputSchema.optional(),
    definition: queryDefinitionSchema.optional(),
    presentation: presentationSchema.optional(),
  })
  .strict()
  .superRefine((update, context) => {
    if (
      update.name === undefined &&
      update.audience === undefined &&
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
const defaultSetSchema = z
  .object({ moduleId: uuidSchema, viewId: uuidSchema })
  .strict();
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
export type OpenViewAudienceOption = z.output<typeof audienceOptionSchema>;
export type OpenViewPersonalDefault = z.output<typeof defaultSchema>;
export type OpenViewRecord = z.output<typeof recordSchema>;
export type OpenViewConflict = {
  code: "stale_revision";
  message?: string;
  currentRevision?: number;
};

function pageQuery(options: { limit?: number; offset?: number } = {}) {
  return pageRequestSchema.parse(options);
}

function queryString(values: Record<string, string | number>): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    parameters.set(key, String(value));
  }
  return parameters.toString();
}

export function serializeOpenViewQueryDefinition(
  raw: unknown,
): z.input<typeof wireQueryDefinitionSchema> {
  const definition = queryDefinitionSchema.parse(raw);
  const wireDefinition = {
    version: definition.version,
    logic: definition.logic,
    columns: definition.columns.map(({ fieldId, expectedType }) => ({
      field_id: fieldId,
      expected_type: expectedType,
    })),
    filters: definition.filters.map(({ fieldId, expectedType, ...filter }) => ({
      field_id: fieldId,
      expected_type: expectedType,
      ...filter,
    })),
    sort: definition.sort.map(({ fieldId, expectedType, direction }) => ({
      field_id: fieldId,
      expected_type: expectedType,
      direction,
    })),
    deleted: definition.deleted,
    search: definition.search,
    search_fields: definition.searchFields.map(({ fieldId, expectedType }) => ({
      field_id: fieldId,
      expected_type: expectedType,
    })),
  };
  wireQueryDefinitionSchema.parse(wireDefinition);
  return wireDefinition;
}

function serializePresentation(raw: OpenViewPresentation) {
  const presentation = presentationSchema.parse(raw);
  return {
    version: presentation.version,
    layout: presentation.layout,
    column_field_ids: presentation.columnFieldIds,
    pinned_field_ids: presentation.pinnedFieldIds,
    density: presentation.density,
    wrap: presentation.wrap,
    card_size: presentation.cardSize,
    primary_field_id: presentation.primaryFieldId,
    secondary_field_id: presentation.secondaryFieldId,
    date_field_id: presentation.dateFieldId,
    timeline_start_field_id: presentation.timelineStartFieldId ?? null,
    timeline_end_field_id: presentation.timelineEndFieldId ?? null,
    timeline_deadline_field_id: presentation.timelineDeadlineFieldId ?? null,
    timeline_progress_field_id: presentation.timelineProgressFieldId ?? null,
    group_by_field_id: presentation.groupByFieldId,
    date_range: presentation.dateRange,
    scale: presentation.scale,
  };
}

export async function listOpenViewDataSources(
  options: { limit?: number; offset?: number } = {},
): Promise<OpenViewPage<OpenViewDataSource>> {
  const page = pageQuery(options);
  return apiFetch(
    `/views/data-sources?${queryString(page)}`,
    dataSourceListSchema,
  );
}

export async function listOpenViewDataSourceFields(
  moduleId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<OpenViewPage<OpenViewDataSourceField>> {
  const validModuleId = uuidSchema.parse(moduleId);
  const page = pageQuery(options);
  const result = await apiFetch(
    `/views/data-sources/${encodeURIComponent(validModuleId)}/fields?${queryString(page)}`,
    listSchema(fieldSchema).superRefine((fields, context) => {
      if (fields.items.some((field) => field.moduleId !== validModuleId)) {
        context.addIssue({
          code: "custom",
          message: "Field module must match the requested data source",
        });
      }
    }),
  );
  return result;
}

export async function listOpenViewAudienceOptions(
  kind: "role" | "user",
  options: { limit?: number; offset?: number } = {},
): Promise<OpenViewPage<OpenViewAudienceOption>> {
  const validKind = audienceOptionKindSchema.parse(kind);
  const page = pageQuery(options);
  return apiFetch(
    `/views/audience-options?${queryString({ kind: validKind, ...page })}`,
    audienceOptionListSchema,
  );
}

export async function listOpenViewSavedViews(options: {
  moduleId: string;
  limit?: number;
  offset?: number;
  deleted?: "exclude" | "include" | "only";
}): Promise<OpenViewPage<OpenViewSavedView>> {
  const { moduleId, limit, offset, deleted } =
    savedViewListRequestSchema.parse(options);
  const parameters: Record<string, string | number> = {
    module_id: moduleId,
    limit,
    offset,
  };
  if (deleted !== undefined) parameters.deleted = deleted;
  return apiFetch(`/views?${queryString(parameters)}`, savedViewListSchema);
}

export async function getOpenViewSavedView(
  id: string,
): Promise<OpenViewSavedView> {
  const viewId = uuidSchema.parse(id);
  return apiFetch(
    `/views/${encodeURIComponent(viewId)}`,
    savedViewResponseSchema,
  );
}

export async function createOpenViewSavedView(
  raw: z.input<typeof savedViewCreateSchema>,
): Promise<OpenViewSavedView> {
  const input = savedViewCreateSchema.parse(raw);
  const body = {
    module_id: input.moduleId,
    name: input.name,
    audience: toWireAudience(input.audience),
    definition: serializeOpenViewQueryDefinition(input.definition),
    presentation: serializePresentation(input.presentation),
  };
  return apiFetch("/views", savedViewResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateOpenViewSavedView(
  raw: z.input<typeof savedViewUpdateSchema>,
): Promise<OpenViewSavedView> {
  const input = savedViewUpdateSchema.parse(raw);
  const body: Record<string, unknown> = { revision: input.revision };
  if (input.name !== undefined) body.name = input.name;
  if (input.audience !== undefined)
    body.audience = toWireAudience(input.audience);
  if (input.definition !== undefined) {
    body.definition = serializeOpenViewQueryDefinition(input.definition);
  }
  if (input.presentation !== undefined) {
    body.presentation = serializePresentation(input.presentation);
  }
  return apiFetch(
    `/views/${encodeURIComponent(input.id)}`,
    savedViewResponseSchema,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

export async function archiveOpenViewSavedView(raw: {
  id: string;
  revision: number;
}): Promise<void> {
  const input = archiveSchema.parse(raw);
  const query = queryString({ revision: input.revision });
  await apiFetch(`/views/${encodeURIComponent(input.id)}?${query}`, z.null(), {
    method: "DELETE",
  });
}

export async function restoreOpenViewSavedView(raw: {
  id: string;
  revision: number;
}): Promise<OpenViewSavedView> {
  const input = restoreSchema.parse(raw);
  return apiFetch(
    `/views/${encodeURIComponent(input.id)}/restore`,
    savedViewResponseSchema,
    { method: "POST", body: JSON.stringify({ revision: input.revision }) },
  );
}

export async function listOpenViewPersonalDefaults(
  options: { limit?: number; offset?: number } = {},
): Promise<OpenViewPage<OpenViewPersonalDefault>> {
  const page = pageQuery(options);
  return apiFetch(`/views/defaults?${queryString(page)}`, defaultListSchema);
}

export async function setOpenViewPersonalDefault(raw: {
  moduleId: string;
  viewId: string;
}): Promise<OpenViewPersonalDefault> {
  const input = defaultSetSchema.parse(raw);
  return apiFetch(
    `/views/defaults/${encodeURIComponent(input.moduleId)}`,
    defaultSchema,
    {
      method: "PUT",
      body: JSON.stringify({ view_id: input.viewId }),
    },
  );
}

export async function unsetOpenViewPersonalDefault(
  moduleId: string,
): Promise<void> {
  const validModuleId = uuidSchema.parse(moduleId);
  await apiFetch(
    `/views/defaults/${encodeURIComponent(validModuleId)}`,
    z.null(),
    { method: "DELETE" },
  );
}

export async function queryOpenViewRecords(raw: {
  moduleId: string;
  definition: OpenViewQueryDefinition;
  limit?: number;
  offset?: number;
}): Promise<OpenViewPage<OpenViewRecord>> {
  const input = recordQuerySchema.parse(raw);
  return apiFetch("/records/query", recordListSchema, {
    method: "POST",
    body: JSON.stringify({
      module_id: input.moduleId,
      definition: serializeOpenViewQueryDefinition(input.definition),
      limit: input.limit,
      offset: input.offset,
    }),
  });
}

const staleRevisionDetailSchema = z
  .object({
    code: z.literal("stale_revision"),
    message: z.string().optional(),
    current_revision: z.number().int().min(1).optional(),
  })
  .passthrough();

export function getOpenViewConflict(error: unknown): OpenViewConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = staleRevisionDetailSchema.safeParse(error.details);
  if (!parsed.success) return null;
  return {
    code: parsed.data.code,
    ...(parsed.data.message === undefined
      ? {}
      : { message: parsed.data.message }),
    ...(parsed.data.current_revision === undefined
      ? {}
      : { currentRevision: parsed.data.current_revision }),
  };
}
