import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { getWorkspaceCalendarSettings } from "../../manage/adapters/workspace-api";
import { openViewReadFetch, trackOpenViewRead } from "./openview-access";
import {
  aggregateBucketKeys,
  aggregateBucketSchema,
  validAggregateBucketWindow,
  type AggregateBucket,
  type AggregateWeekStart,
} from "../domain/aggregate-buckets";
import type { Aggregation } from "../domain/chart-query";
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
  "user",
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
    display_values: z.record(uuidSchema, z.string()),
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
      display_values,
      created_at,
      updated_at,
      deleted_at,
      is_deleted,
      performed_by,
      ...record
    }) => ({
      ...record,
      moduleId: module_id,
      displayValues: display_values,
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
    value: numericDecimalSchema.nullable(),
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
  aggregation: z.enum(["count", "sum", "average", "min", "max", "distinct"]),
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
    bucket: aggregateBucketSchema.default("day"),
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
    bucket: aggregateBucketSchema.default("day"),
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
      (request.aggregation !== "distinct" &&
        !numericTypes.has(request.measure.expectedType))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A measure is required; sum, average, min and max require a numeric field",
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
      if (
        !validAggregateBucketWindow(
          request.fromDate,
          request.toDate,
          request.bucket,
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Date series must contain between 1 and 366 calendar buckets",
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
      (request.aggregation !== "distinct" &&
        !numericTypes.has(request.measure.expectedType))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A measure is required; sum, average, min and max require a numeric field",
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
      if (
        !validAggregateBucketWindow(
          request.fromDate,
          request.toDate,
          request.bucket,
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Date series must contain between 1 and 366 calendar buckets",
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
  aggregation: Aggregation;
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
      bucket?: AggregateBucket;
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
        bucket?: AggregateBucket;
      }
  );

function inclusiveDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
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
  weekStart: AggregateWeekStart,
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

      const keys = aggregateBucketKeys(
        request.fromDate,
        request.toDate,
        request.bucket,
        weekStart,
      );
      const expectedDays = keys.length;
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
          message: "Date series must include every requested calendar bucket",
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
  weekStart: AggregateWeekStart,
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
        const keys = aggregateBucketKeys(
          request.fromDate,
          request.toDate,
          request.bucket,
          weekStart,
        );
        const expectedDays = keys.length;
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
            message:
              "Date-series snapshots must include every requested calendar bucket",
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
    body.bucket = request.bucket;
  }
  return trackOpenViewRead(async () => {
    const weekStart = await workspaceWeekStart([request]);
    return apiFetch(
      "/records/aggregate-query",
      aggregateResponseSchema(request, weekStart),
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  });
}

function snapshotRequestBody(
  request: z.output<typeof aggregateSnapshotRequestSchema>,
) {
  const body: Record<string, unknown> = {
    mode: request.mode,
    module_id: request.moduleId,
    definition: serializeOpenViewQueryDefinition(request.definition),
    aggregation: request.aggregation,
  };
  if (request.measure !== undefined)
    body.measure = wireFieldReference(request.measure);
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
    body.bucket = request.bucket;
  }
  return body;
}

async function workspaceWeekStart(
  requests: readonly (
    | z.output<typeof aggregateSnapshotRequestSchema>
    | z.output<typeof aggregateRequestSchema>
  )[],
): Promise<AggregateWeekStart> {
  if (
    !requests.some(
      (request) => request.mode === "date_series" && request.bucket === "week",
    )
  )
    return "monday";
  const settings = await getWorkspaceCalendarSettings();
  // Reject an unrepresentable or over-limit actual anchor before sending any snapshot.
  for (const request of requests)
    if (request.mode === "date_series" && request.bucket === "week")
      aggregateBucketKeys(
        request.fromDate,
        request.toDate,
        request.bucket,
        settings.week_start,
      );
  return settings.week_start;
}

export async function queryOpenViewAggregateSnapshot(
  raw: OpenViewAggregateSnapshotRequest,
): Promise<OpenViewAggregateSnapshotResult> {
  const request = aggregateSnapshotRequestSchema.parse(raw);
  const body = snapshotRequestBody(request);
  return trackOpenViewRead(async () => {
    const weekStart = await workspaceWeekStart([request]);
    return apiFetch(
      "/records/aggregate-snapshot",
      aggregateSnapshotResponseSchema(request, weekStart),
      {
        method: "POST",
        cache: "no-store",
        body: JSON.stringify(body),
      },
    );
  });
}

export type OpenViewAggregateSnapshotsResult = {
  items: OpenViewAggregateSnapshotResult[];
};

/** Strict complete batch; validation and calendar failure release no partial items. */
export async function queryOpenViewAggregateSnapshots(
  raw: readonly OpenViewAggregateSnapshotRequest[],
): Promise<OpenViewAggregateSnapshotsResult> {
  const requests = z
    .array(aggregateSnapshotRequestSchema)
    .min(1)
    .max(12)
    .parse(raw);
  const body = { queries: requests.map(snapshotRequestBody) };
  return trackOpenViewRead(async () => {
    const weekStart = await workspaceWeekStart(requests);
    const schemas = requests.map((request) =>
      aggregateSnapshotResponseSchema(request, weekStart),
    );
    const schema = z
      .object({ items: z.array(z.unknown()).max(12) })
      .strict()
      .superRefine((response, context) => {
        if (response.items.length !== requests.length) {
          context.addIssue({
            code: "custom",
            message: "Batch snapshots must match every query in order",
          });
          return;
        }
        let buckets = 0;
        for (const [index, item] of response.items.entries()) {
          const parsed = schemas[index].safeParse(item);
          if (!parsed.success)
            context.addIssue({
              code: "custom",
              path: ["items", index],
              message: "Every batch snapshot must be complete and valid",
            });
          else buckets += parsed.data.items.length;
        }
        // Count bytes before nested DTO transforms, including the entire wire wrapper.
        if (
          buckets > 10000 ||
          new TextEncoder().encode(JSON.stringify(response)).byteLength >
            8 * 1024 * 1024
        )
          context.addIssue({
            code: "custom",
            message: "Aggregate batch exceeds 10,000 buckets or 8 MiB",
          });
      })
      .transform((response) => ({
        items: response.items.map((item, index) => schemas[index].parse(item)),
      }));
    return apiFetch("/records/aggregate-snapshots", schema, {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(body),
    });
  });
}
