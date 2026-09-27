import { z } from "zod";
import { openViewReadFetch } from "./openview-access";
import {
  serializeOpenViewQueryDefinition,
  type OpenViewQueryDefinition,
  type OpenViewQueryFieldReference,
  type OpenViewQueryFieldType,
  type OpenViewRecord,
} from "./views-api";

const uuidSchema = z.string().uuid();
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
const fieldReferenceSchema = z
  .object({
    fieldId: uuidSchema,
    expectedType: fieldTypeSchema,
  })
  .strict();
const groupSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), value: z.string() }).strict(),
  z.object({ kind: z.literal("unspecified") }).strict(),
]);

const paginationSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict()
  .transform(({ has_more, ...page }) => ({ ...page, hasMore: has_more }));
const wirePaginationSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict();
const wireDateSeriesPaginationSchema = z
  .object({
    limit: z.number().int().min(1).max(366),
    offset: z.number().int().min(0),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict();
const dateSeriesPaginationSchema = wireDateSeriesPaginationSchema.transform(
  ({ has_more, ...page }) => ({ ...page, hasMore: has_more }),
);

const wireRecordSchema = z
  .object({
    id: uuidSchema,
    module_id: uuidSchema,
    data: z.record(uuidSchema, z.unknown()),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    deleted_at: z.iso.datetime({ offset: true }).nullable(),
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
const recordGroupSchema = z
  .object({
    value: z.string().nullable(),
    label: z.string(),
    count: z.number().int().min(0),
  })
  .strict();
const wireGroupedResponseSchema = z
  .object({
    items: z.array(wireRecordSchema),
    pagination: wirePaginationSchema.nullable(),
    groups: z.array(recordGroupSchema),
    group_pagination: wirePaginationSchema,
    selected_group: groupSelectorSchema.nullable(),
  })
  .strict();

const numericDecimalSchema = z.union([
  z.number().finite(),
  z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/),
]);
const aggregateDatumSchema = z
  .object({
    key: z.string().nullable(),
    label: z.string(),
    value: numericDecimalSchema,
    record_count: z.number().int().min(0),
  })
  .strict()
  .transform(({ record_count, ...datum }) => ({
    ...datum,
    recordCount: record_count,
  }));
const wireAggregateResponseSchema = z
  .object({
    items: z.array(aggregateDatumSchema),
    pagination: z.union([wirePaginationSchema, wireDateSeriesPaginationSchema]),
  })
  .strict();
const wireAggregateSnapshotPaginationSchema = z
  .object({
    limit: z.number().int().min(1).max(10_000),
    offset: z.number().int().min(0),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict();
const aggregateSnapshotPaginationSchema =
  wireAggregateSnapshotPaginationSchema.transform(({ has_more, ...page }) => ({
    ...page,
    hasMore: has_more,
  }));
const wireAggregateSnapshotResponseSchema = z
  .object({
    items: z.array(aggregateDatumSchema),
    pagination: wireAggregateSnapshotPaginationSchema,
  })
  .strict();

const groupedRequestSchema = z
  .object({
    moduleId: uuidSchema,
    definition: z.unknown(),
    groupBy: fieldReferenceSchema,
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    groupLimit: z.number().int().min(1).max(100).default(100),
    groupOffset: z.number().int().min(0).default(0),
    selectedGroup: groupSelectorSchema.nullable().optional(),
  })
  .strict();

const aggregateBaseSchema = z.object({
  moduleId: uuidSchema,
  definition: z.unknown(),
  aggregation: z.enum(["count", "sum", "average"]),
  measure: fieldReferenceSchema.optional(),
});
const groupedAggregateRequestSchema = aggregateBaseSchema
  .extend({
    mode: z.literal("groups"),
    dimension: fieldReferenceSchema,
    limit: z.number().int().min(1).max(100).default(12),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
const dateSeriesAggregateRequestSchema = aggregateBaseSchema
  .extend({
    mode: z.literal("date_series"),
    dateField: fieldReferenceSchema,
    fromDate: z.iso.date(),
    toDate: z.iso.date(),
  })
  .strict();
const groupedAggregateSnapshotRequestSchema = aggregateBaseSchema
  .extend({
    mode: z.literal("groups"),
    dimension: fieldReferenceSchema,
    dateField: fieldReferenceSchema.optional(),
    fromDate: z.iso.date().optional(),
    toDate: z.iso.date().optional(),
  })
  .strict();
const dateSeriesAggregateSnapshotRequestSchema = aggregateBaseSchema
  .extend({
    mode: z.literal("date_series"),
    dateField: fieldReferenceSchema,
    fromDate: z.iso.date(),
    toDate: z.iso.date(),
  })
  .strict();
const aggregateRequestSchema = z
  .discriminatedUnion("mode", [
    groupedAggregateRequestSchema,
    dateSeriesAggregateRequestSchema,
  ])
  .superRefine((request, context) => {
    const numericTypes = new Set<OpenViewQueryFieldType>([
      "number",
      "decimal",
      "int",
    ]);
    if (request.aggregation === "count") {
      if (request.measure !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Count does not accept a measure field",
        });
      }
    } else if (
      request.measure === undefined ||
      !numericTypes.has(request.measure.expectedType)
    ) {
      context.addIssue({
        code: "custom",
        message: "Sum and average require a numeric measure field",
      });
    }

    if (request.mode === "date_series") {
      if (
        request.dateField.expectedType !== "date" &&
        request.dateField.expectedType !== "datetime"
      ) {
        context.addIssue({
          code: "custom",
          message: "Date series require a date or datetime field",
        });
      }
      const days = inclusiveDays(request.fromDate, request.toDate);
      if (days < 1 || days > 366) {
        context.addIssue({
          code: "custom",
          message: "Date series windows must contain between 1 and 366 days",
        });
      }
    }
  });
const aggregateSnapshotRequestSchema = z
  .discriminatedUnion("mode", [
    groupedAggregateSnapshotRequestSchema,
    dateSeriesAggregateSnapshotRequestSchema,
  ])
  .superRefine((request, context) => {
    const numericTypes = new Set<OpenViewQueryFieldType>([
      "number",
      "decimal",
      "int",
    ]);
    if (request.aggregation === "count") {
      if (request.measure !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Count does not accept a measure field",
        });
      }
    } else if (
      request.measure === undefined ||
      !numericTypes.has(request.measure.expectedType)
    ) {
      context.addIssue({
        code: "custom",
        message: "Sum and average require a numeric measure field",
      });
    }

    if (request.mode === "groups") {
      const hasDateWindow =
        request.dateField !== undefined ||
        request.fromDate !== undefined ||
        request.toDate !== undefined;
      if (hasDateWindow) {
        if (!request.dateField || !request.fromDate || !request.toDate) {
          context.addIssue({
            code: "custom",
            message:
              "Grouped date windows require a date field and both bounds",
          });
        } else if (
          request.dateField.expectedType !== "date" &&
          request.dateField.expectedType !== "datetime"
        ) {
          context.addIssue({
            code: "custom",
            message: "Grouped date windows require a date or datetime field",
          });
        } else if (
          inclusiveDays(request.fromDate, request.toDate) < 1 ||
          inclusiveDays(request.fromDate, request.toDate) > 366
        ) {
          context.addIssue({
            code: "custom",
            message: "Grouped date windows must contain between 1 and 366 days",
          });
        }
      }
    }

    if (request.mode === "date_series") {
      if (
        request.dateField.expectedType !== "date" &&
        request.dateField.expectedType !== "datetime"
      ) {
        context.addIssue({
          code: "custom",
          message: "Date series require a date or datetime field",
        });
      }
      const days = inclusiveDays(request.fromDate, request.toDate);
      if (days < 1 || days > 366) {
        context.addIssue({
          code: "custom",
          message: "Date series windows must contain between 1 and 366 days",
        });
      }
    }
  });

export type OpenViewGroupSelector =
  { kind: "value"; value: string } | { kind: "unspecified" };
export type OpenViewAnalyticsPagination = z.output<typeof paginationSchema>;
export type OpenViewRecordGroup = z.infer<typeof recordGroupSchema>;
export type OpenViewGroupedRecordsResult = {
  items: OpenViewRecord[];
  pagination: OpenViewAnalyticsPagination | null;
  groups: OpenViewRecordGroup[];
  groupPagination: OpenViewAnalyticsPagination;
  selectedGroup: OpenViewGroupSelector | null;
};
export type OpenViewAggregateDatum = z.output<typeof aggregateDatumSchema>;
export type OpenViewAggregateResult = {
  items: OpenViewAggregateDatum[];
  pagination: OpenViewAnalyticsPagination;
};
export type OpenViewAggregateSnapshotPagination = z.output<
  typeof aggregateSnapshotPaginationSchema
>;
export type OpenViewAggregateSnapshotResult = {
  items: OpenViewAggregateDatum[];
  pagination: OpenViewAggregateSnapshotPagination;
};
export type OpenViewGroupedRecordsRequest = {
  moduleId: string;
  definition: OpenViewQueryDefinition;
  groupBy: OpenViewQueryFieldReference;
  limit?: number;
  offset?: number;
  groupLimit?: number;
  groupOffset?: number;
  selectedGroup?: OpenViewGroupSelector | null;
};
type OpenViewAggregateRequestBase = {
  moduleId: string;
  definition: OpenViewQueryDefinition;
  aggregation: "count" | "sum" | "average";
  measure?: OpenViewQueryFieldReference;
};
export type OpenViewAggregateRequest =
  | (OpenViewAggregateRequestBase & {
      mode: "groups";
      dimension: OpenViewQueryFieldReference;
      limit?: number;
      offset?: number;
    })
  | (OpenViewAggregateRequestBase & {
      mode: "date_series";
      dateField: OpenViewQueryFieldReference;
      fromDate: string;
      toDate: string;
    });
export type OpenViewAggregateSnapshotRequest = OpenViewAggregateRequestBase &
  (
    | {
        mode: "groups";
        dimension: OpenViewQueryFieldReference;
        dateField?: OpenViewQueryFieldReference;
        fromDate?: string;
        toDate?: string;
      }
    | {
        mode: "date_series";
        dateField: OpenViewQueryFieldReference;
        fromDate: string;
        toDate: string;
      }
  );

function inclusiveDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

function dailyKeys(from: string, length: number): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}

function wireFieldReference(reference: OpenViewQueryFieldReference) {
  const parsed = fieldReferenceSchema.parse(reference);
  return {
    field_id: parsed.fieldId,
    expected_type: parsed.expectedType,
  };
}

function sameGroupSelector(
  left: OpenViewGroupSelector | null,
  right: OpenViewGroupSelector | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "unspecified") return right.kind === "unspecified";
  return right.kind === "value" && left.value === right.value;
}

function groupedResponseSchema(
  request: z.output<typeof groupedRequestSchema>,
  allowedFieldIds: ReadonlySet<string>,
) {
  return wireGroupedResponseSchema
    .superRefine((response, context) => {
      const expectedSelection = request.selectedGroup ?? null;
      if (!sameGroupSelector(response.selected_group, expectedSelection)) {
        context.addIssue({
          code: "custom",
          message: "Selected group does not match the request",
        });
      }
      if (response.selected_group === null) {
        if (response.items.length > 0 || response.pagination !== null) {
          context.addIssue({
            code: "custom",
            message: "Unselected group responses cannot include member rows",
          });
        }
      } else if (response.pagination === null) {
        context.addIssue({
          code: "custom",
          message: "Selected group responses require member pagination",
        });
      }
      if (
        response.pagination !== null &&
        response.pagination.count !== response.items.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Member pagination count must match its page",
        });
      }
      if (response.group_pagination.count !== response.groups.length) {
        context.addIssue({
          code: "custom",
          message: "Group pagination count must match its page",
        });
      }
      for (const item of response.items) {
        if (item.moduleId !== request.moduleId) {
          context.addIssue({
            code: "custom",
            message: "Grouped records must belong to the requested data source",
          });
        }
        if (Object.keys(item.data).some((key) => !allowedFieldIds.has(key))) {
          context.addIssue({
            code: "custom",
            message: "Grouped records cannot include unselected fields",
          });
        }
      }
    })
    .transform(({ group_pagination, selected_group, ...response }) => ({
      ...response,
      pagination:
        response.pagination === null
          ? null
          : paginationSchema.parse(response.pagination),
      groupPagination: paginationSchema.parse(group_pagination),
      selectedGroup: selected_group,
    }));
}

function aggregateResponseSchema(
  request: z.output<typeof aggregateRequestSchema>,
) {
  return wireAggregateResponseSchema
    .superRefine((response, context) => {
      const { pagination, items } = response;
      if (pagination.count !== items.length) {
        context.addIssue({
          code: "custom",
          message: "Aggregate pagination count must match its page",
        });
      }
      if (request.mode === "groups") {
        if (
          pagination.limit !== request.limit ||
          pagination.offset !== request.offset ||
          pagination.offset + pagination.count > pagination.total ||
          pagination.has_more !==
            pagination.offset + pagination.count < pagination.total
        ) {
          context.addIssue({
            code: "custom",
            message: "Aggregate group pagination does not match the request",
          });
        }
        return;
      }

      const expectedDays = inclusiveDays(request.fromDate, request.toDate);
      const keys = dailyKeys(request.fromDate, expectedDays);
      if (
        items.length !== expectedDays ||
        items.some(
          (item, index) =>
            item.key !== keys[index] || item.label !== keys[index],
        ) ||
        pagination.limit !== expectedDays ||
        pagination.offset !== 0 ||
        pagination.count !== expectedDays ||
        pagination.total !== expectedDays ||
        pagination.has_more
      ) {
        context.addIssue({
          code: "custom",
          message: "Date series must include every requested local day",
        });
      }
    })
    .transform(({ items, pagination }) => ({
      items,
      pagination:
        request.mode === "date_series"
          ? dateSeriesPaginationSchema.parse(pagination)
          : paginationSchema.parse(pagination),
    }));
}

function aggregateSnapshotResponseSchema(
  request: z.output<typeof aggregateSnapshotRequestSchema>,
) {
  return wireAggregateSnapshotResponseSchema
    .superRefine((response, context) => {
      const { pagination, items } = response;
      if (
        pagination.offset !== 0 ||
        pagination.count !== items.length ||
        pagination.total !== items.length ||
        pagination.has_more ||
        pagination.limit < items.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Aggregate snapshots must contain the complete result",
        });
      }

      if (request.mode === "date_series") {
        const expectedDays = inclusiveDays(request.fromDate, request.toDate);
        const keys = dailyKeys(request.fromDate, expectedDays);
        if (
          items.length !== expectedDays ||
          items.some(
            (item, index) =>
              item.key !== keys[index] || item.label !== keys[index],
          ) ||
          pagination.limit !== expectedDays
        ) {
          context.addIssue({
            code: "custom",
            message: "Date-series snapshots must include every requested day",
          });
        }
      }
    })
    .transform(({ items, pagination }) => ({
      items,
      pagination: aggregateSnapshotPaginationSchema.parse(pagination),
    }));
}

export async function queryOpenViewGroupedRecords(
  raw: OpenViewGroupedRecordsRequest,
): Promise<OpenViewGroupedRecordsResult> {
  const request = groupedRequestSchema.parse(raw);
  const definition = serializeOpenViewQueryDefinition(request.definition);
  const allowedFieldIds = new Set(
    definition.columns.map(({ field_id }) => field_id),
  );
  const body: Record<string, unknown> = {
    module_id: request.moduleId,
    definition,
    group_by: wireFieldReference(request.groupBy),
    limit: request.limit,
    offset: request.offset,
    group_limit: request.groupLimit,
    group_offset: request.groupOffset,
  };
  if (request.selectedGroup !== undefined) {
    body.selected_group = request.selectedGroup;
  }
  return openViewReadFetch(
    "/records/grouped-query",
    groupedResponseSchema(request, allowedFieldIds),
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export async function queryOpenViewAggregates(
  raw: OpenViewAggregateRequest,
): Promise<OpenViewAggregateResult> {
  const request = aggregateRequestSchema.parse(raw);
  const body: Record<string, unknown> = {
    mode: request.mode,
    module_id: request.moduleId,
    definition: serializeOpenViewQueryDefinition(request.definition),
    aggregation: request.aggregation,
  };
  if (request.measure !== undefined) {
    body.measure = wireFieldReference(request.measure);
  }
  if (request.mode === "groups") {
    body.dimension = wireFieldReference(request.dimension);
    body.limit = request.limit;
    body.offset = request.offset;
  } else {
    body.date_field = wireFieldReference(request.dateField);
    body.from_date = request.fromDate;
    body.to_date = request.toDate;
  }
  return openViewReadFetch(
    "/records/aggregate-query",
    aggregateResponseSchema(request),
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export async function queryOpenViewAggregateSnapshot(
  raw: OpenViewAggregateSnapshotRequest,
): Promise<OpenViewAggregateSnapshotResult> {
  const request = aggregateSnapshotRequestSchema.parse(raw);
  const body: Record<string, unknown> = {
    mode: request.mode,
    module_id: request.moduleId,
    definition: serializeOpenViewQueryDefinition(request.definition),
    aggregation: request.aggregation,
  };
  if (request.measure !== undefined) {
    body.measure = wireFieldReference(request.measure);
  }
  if (request.mode === "groups") {
    body.dimension = wireFieldReference(request.dimension);
    if (request.dateField !== undefined) {
      body.date_field = wireFieldReference(request.dateField);
      body.from_date = request.fromDate;
      body.to_date = request.toDate;
    }
  } else {
    body.date_field = wireFieldReference(request.dateField);
    body.from_date = request.fromDate;
    body.to_date = request.toDate;
  }
  return openViewReadFetch(
    "/records/aggregate-snapshot",
    aggregateSnapshotResponseSchema(request),
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(body),
    },
  );
}
