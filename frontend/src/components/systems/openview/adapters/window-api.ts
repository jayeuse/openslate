import { z } from "zod";
import { openViewReadFetch } from "./openview-access";
import type {
  OpenViewQueryDefinition,
  OpenViewQueryFieldReference,
} from "./views-api";
import { serializeOpenViewQueryDefinition } from "./views-api";

const uuidSchema = z.string().uuid();
const dateFieldReferenceSchema = z
  .object({
    fieldId: uuidSchema,
    expectedType: z.enum(["date", "datetime"]),
  })
  .strict();

const queryBaseShape = {
  moduleId: uuidSchema,
  definition: z.unknown(),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
};
const dateWindowShape = {
  fromDate: z.iso.date(),
  toDate: z.iso.date(),
};

function dateWindowError(fromDate: string, toDate: string): string | null {
  if (toDate < fromDate) return "Window end must be on or after its start";
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const days =
    (Date.parse(`${toDate}T00:00:00.000Z`) -
      Date.parse(`${fromDate}T00:00:00.000Z`)) /
      millisecondsPerDay +
    1;
  return days > 366 ? "Windows may contain at most 366 days" : null;
}

const calendarWindowRequestSchema = z
  .object({
    ...queryBaseShape,
    mode: z.literal("calendar"),
    scope: z.literal("window"),
    dateField: dateFieldReferenceSchema,
    ...dateWindowShape,
  })
  .strict()
  .superRefine(({ fromDate, toDate }, context) => {
    const message = dateWindowError(fromDate, toDate);
    if (message) {
      context.addIssue({ code: "custom", path: ["toDate"], message });
    }
  });
const calendarUndatedRequestSchema = z
  .object({
    ...queryBaseShape,
    mode: z.literal("calendar"),
    scope: z.literal("undated"),
    dateField: dateFieldReferenceSchema,
  })
  .strict();
const timelineWindowRequestSchema = z
  .object({
    ...queryBaseShape,
    mode: z.literal("timeline"),
    scope: z.literal("window"),
    startField: dateFieldReferenceSchema,
    endField: dateFieldReferenceSchema,
    ...dateWindowShape,
  })
  .strict()
  .superRefine(({ fromDate, toDate }, context) => {
    const message = dateWindowError(fromDate, toDate);
    if (message) {
      context.addIssue({ code: "custom", path: ["toDate"], message });
    }
  });
const timelineUnscheduledRequestSchema = z
  .object({
    ...queryBaseShape,
    mode: z.literal("timeline"),
    scope: z.literal("unscheduled"),
    startField: dateFieldReferenceSchema,
    endField: dateFieldReferenceSchema,
  })
  .strict();
const windowQueryRequestSchema = z.union([
  calendarWindowRequestSchema,
  calendarUndatedRequestSchema,
  timelineWindowRequestSchema,
  timelineUnscheduledRequestSchema,
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
  .transform(({ has_more, ...pagination }) => ({
    ...pagination,
    hasMore: has_more,
  }));
const recordSchema = z
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
const windowResponseSchema = z
  .object({
    items: z.array(recordSchema),
    pagination: paginationSchema,
    timezone: z.string().min(1).nullable(),
  })
  .strict();

type WindowQueryBase = {
  moduleId: string;
  definition: OpenViewQueryDefinition;
  limit?: number;
  offset?: number;
};

export type OpenViewWindowQueryRequest =
  | (WindowQueryBase & {
      mode: "calendar";
      scope: "window";
      dateField: OpenViewQueryFieldReference;
      fromDate: string;
      toDate: string;
    })
  | (WindowQueryBase & {
      mode: "calendar";
      scope: "undated";
      dateField: OpenViewQueryFieldReference;
    })
  | (WindowQueryBase & {
      mode: "timeline";
      scope: "window";
      startField: OpenViewQueryFieldReference;
      endField: OpenViewQueryFieldReference;
      fromDate: string;
      toDate: string;
    })
  | (WindowQueryBase & {
      mode: "timeline";
      scope: "unscheduled";
      startField: OpenViewQueryFieldReference;
      endField: OpenViewQueryFieldReference;
    });

export type OpenViewWindowResult = z.output<typeof windowResponseSchema>;

function serializeFieldReference(reference: {
  fieldId: string;
  expectedType: string;
}) {
  return {
    field_id: reference.fieldId,
    expected_type: reference.expectedType,
  };
}

function responseSchemaFor(
  request: z.output<typeof windowQueryRequestSchema>,
  selectedFieldIds: ReadonlySet<string>,
  hasProjectedDatetime: boolean,
) {
  const dateTimeReference =
    hasProjectedDatetime ||
    (request.mode === "calendar"
      ? request.dateField.expectedType === "datetime"
      : request.startField.expectedType === "datetime" ||
        request.endField.expectedType === "datetime");

  return windowResponseSchema.superRefine((response, context) => {
    const { pagination } = response;
    if (pagination.limit !== request.limit) {
      context.addIssue({
        code: "custom",
        path: ["pagination", "limit"],
        message: "Page limit does not match the request",
      });
    }
    if (pagination.offset !== request.offset) {
      context.addIssue({
        code: "custom",
        path: ["pagination", "offset"],
        message: "Page offset does not match the request",
      });
    }
    if (
      pagination.count !== response.items.length ||
      pagination.count > pagination.limit
    ) {
      context.addIssue({
        code: "custom",
        path: ["pagination", "count"],
        message: "Page count does not match the returned items",
      });
    }
    if (
      pagination.hasMore !==
      pagination.offset + pagination.count < pagination.total
    ) {
      context.addIssue({
        code: "custom",
        path: ["pagination", "has_more"],
        message: "Page continuation does not match the total",
      });
    }
    if (dateTimeReference !== (response.timezone !== null)) {
      context.addIssue({
        code: "custom",
        path: ["timezone"],
        message: "Timezone must match the referenced date field types",
      });
    }

    response.items.forEach((record, index) => {
      if (record.moduleId !== request.moduleId) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "module_id"],
          message: "Record belongs to a different module",
        });
      }
      for (const fieldId of Object.keys(record.data)) {
        if (!selectedFieldIds.has(fieldId)) {
          context.addIssue({
            code: "custom",
            path: ["items", index, "data", fieldId],
            message: "Record includes a field outside the query projection",
          });
        }
      }
    });
  });
}

export async function queryOpenViewWindowRecords(
  raw: OpenViewWindowQueryRequest,
): Promise<OpenViewWindowResult> {
  const request = windowQueryRequestSchema.parse(raw);
  const definition = serializeOpenViewQueryDefinition(request.definition);
  const selectedFieldIds = new Set(
    definition.columns.map((reference) => reference.field_id),
  );
  const hasProjectedDatetime = definition.columns.some(
    (reference) => reference.expected_type === "datetime",
  );
  const body: Record<string, unknown> = {
    module_id: request.moduleId,
    definition,
    mode: request.mode,
    scope: request.scope,
    limit: request.limit,
    offset: request.offset,
  };

  if (request.mode === "calendar") {
    body.date_field = serializeFieldReference(request.dateField);
  } else {
    body.start_field = serializeFieldReference(request.startField);
    body.end_field = serializeFieldReference(request.endField);
  }
  if (request.scope === "window") {
    body.from_date = request.fromDate;
    body.to_date = request.toDate;
  }

  return openViewReadFetch(
    "/records/window-query",
    responseSchemaFor(request, selectedFieldIds, hasProjectedDatetime),
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}
