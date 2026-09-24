import { z } from "zod";
import {
  ApiContractError,
  ApiError,
  apiFetch,
  type ApiRequestInit,
} from "@/lib/api";

const uuidSchema = z.string().uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const revisionSchema = z.number().int().min(1);
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
const operatorSchema = z.enum([
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
const scalarSchema = z.union([
  z.string().max(4000),
  z.boolean(),
  z.number().finite(),
]);
const filterValueSchema = z.union([
  scalarSchema,
  z.array(scalarSchema).min(1).max(100),
]);
const inputFieldSchema = z
  .object({ fieldId: uuidSchema, expectedType: fieldTypeSchema })
  .strict();
const wireFieldSchema = z
  .object({ field_id: uuidSchema, expected_type: fieldTypeSchema })
  .strict()
  .transform(({ field_id, expected_type }) => ({
    fieldId: field_id,
    expectedType: expected_type,
  }));

type FilterRule = {
  expectedType: z.output<typeof fieldTypeSchema>;
  operator: z.output<typeof operatorSchema>;
  value?: z.output<typeof filterValueSchema> | null;
};

function validFilter(filter: FilterRule): boolean {
  const empty = ["empty", "not_empty", "blank", "not_blank"];
  if (empty.includes(filter.operator)) {
    if (filter.value != null) return false;
  } else if (
    filter.value == null ||
    (filter.operator === "in") !== Array.isArray(filter.value)
  ) {
    return false;
  }
  const allowed = new Set<string>(["eq", "neq", ...empty]);
  if (["text", "long_text", "email", "url"].includes(filter.expectedType)) {
    ["contains", "prefix", "suffix"].forEach((operator) =>
      allowed.add(operator),
    );
  } else if (filter.expectedType === "select") {
    ["contains", "in"].forEach((operator) => allowed.add(operator));
  } else if (
    ["number", "decimal", "int", "date", "datetime"].includes(
      filter.expectedType,
    )
  ) {
    ["lt", "lte", "gt", "gte"].forEach((operator) => allowed.add(operator));
  }
  return allowed.has(filter.operator);
}

const inputFilterSchema = inputFieldSchema
  .extend({ operator: operatorSchema, value: filterValueSchema.nullish() })
  .strict()
  .refine(validFilter);
const wireFilterSchema = z
  .object({
    field_id: uuidSchema,
    expected_type: fieldTypeSchema,
    operator: operatorSchema,
    value: filterValueSchema.nullable(),
  })
  .strict()
  .transform(({ field_id, expected_type, ...filter }) => ({
    fieldId: field_id,
    expectedType: expected_type,
    ...filter,
  }))
  .refine(validFilter);

function validConfig(config: {
  fields: Array<{ fieldId: string }>;
  metric: { expectedType: z.output<typeof fieldTypeSchema> } | null;
}): boolean {
  return (
    new Set(config.fields.map((field) => field.fieldId)).size ===
      config.fields.length &&
    (config.metric === null ||
      ["number", "decimal", "int"].includes(config.metric.expectedType))
  );
}

const inputConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    fields: z.array(inputFieldSchema).max(24).default([]),
    filters: z.array(inputFilterSchema).max(8).default([]),
    logic: z.enum(["and", "or"]).default("and"),
    metric: inputFieldSchema.nullable().default(null),
    visualization: z.enum(["bar", "line", "pie"]).default("bar"),
    size: z.enum(["half", "full"]).default("half"),
    refresh: z.enum(["manual", "one-minute", "five-minutes"]).default("manual"),
    pinned: z.boolean().default(false),
  })
  .strict()
  .refine(validConfig);
const wireConfigSchema = z
  .object({
    version: z.literal(1),
    fields: z.array(wireFieldSchema).max(24),
    filters: z.array(wireFilterSchema).max(8),
    logic: z.enum(["and", "or"]),
    metric: wireFieldSchema.nullable(),
    visualization: z.enum(["bar", "line", "pie"]),
    size: z.enum(["half", "full"]),
    refresh: z.enum(["manual", "one-minute", "five-minutes"]),
    pinned: z.boolean(),
  })
  .strict()
  .refine(validConfig);

const inputAudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("everyone") }).strict(),
  z.object({ kind: z.literal("private") }).strict(),
  z.object({ kind: z.literal("role"), roleId: uuidSchema }).strict(),
  z.object({ kind: z.literal("user"), userId: uuidSchema }).strict(),
]);
const wireAudienceSchema = z
  .object({
    kind: z.enum(["everyone", "private", "role", "user"]),
    role_id: uuidSchema.nullable(),
    user_id: uuidSchema.nullable(),
  })
  .strict()
  .refine(
    ({ kind, role_id, user_id }) =>
      (kind === "role" && role_id !== null && user_id === null) ||
      (kind === "user" && user_id !== null && role_id === null) ||
      ((kind === "everyone" || kind === "private") &&
        role_id === null &&
        user_id === null),
  )
  .transform(({ kind, role_id, user_id }) => ({
    kind,
    roleId: role_id,
    userId: user_id,
  }));

const inputWidgetSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    widgetType: z.enum(["summary", "workload", "records", "chart"]),
    moduleId: uuidSchema,
    config: inputConfigSchema,
    audience: inputAudienceSchema,
  })
  .strict();
const wireWidgetSchema = z
  .object({
    id: uuidSchema,
    board_id: uuidSchema,
    name: z.string().min(1).max(80),
    widget_type: z.enum(["summary", "workload", "records", "chart"]),
    module_id: uuidSchema,
    position: z.number().int().min(0).max(11),
    config: wireConfigSchema,
    audience: wireAudienceSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .transform(
    ({
      board_id,
      widget_type,
      module_id,
      created_at,
      updated_at,
      ...widget
    }) => ({
      ...widget,
      boardId: board_id,
      widgetType: widget_type,
      moduleId: module_id,
      createdAt: created_at,
      updatedAt: updated_at,
    }),
  );
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
const listResponseSchema = z
  .object({
    items: z.array(wireWidgetSchema).max(12),
    pagination: paginationSchema,
    board_revision: revisionSchema,
  })
  .strict()
  .refine(({ items, pagination }) => items.length === pagination.count)
  .transform(({ board_revision, ...page }) => ({
    ...page,
    boardRevision: board_revision,
  }));
const mutationResponseSchema = z
  .object({ widget: wireWidgetSchema, board_revision: revisionSchema })
  .strict()
  .transform(({ board_revision, ...response }) => ({
    ...response,
    boardRevision: board_revision,
  }));
const orderResponseSchema = z
  .object({
    items: z.array(wireWidgetSchema).max(12),
    board_revision: revisionSchema,
  })
  .strict()
  .transform(({ board_revision, ...response }) => ({
    ...response,
    boardRevision: board_revision,
  }));
const listOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    sortBy: z.enum(["position", "created_at"]).default("position"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();
const orderInputSchema = z
  .array(uuidSchema)
  .min(1)
  .max(12)
  .refine((ids) => new Set(ids).size === ids.length);

export type BoardWidget = z.output<typeof wireWidgetSchema>;
export type BoardWidgetInput = z.input<typeof inputWidgetSchema>;
export type BoardWidgetPage = z.output<typeof listResponseSchema>;
export type BoardWidgetMutation = z.output<typeof mutationResponseSchema>;
export type BoardWidgetOrder = z.output<typeof orderResponseSchema>;
export type BoardWidgetListOptions = z.input<typeof listOptionsSchema>;

const safeCodes: Record<string, string> = {
  stale_revision: "Board changed; reload before saving",
  board_archived: "Restore the Board before changing widgets",
  widget_invalid: "Unable to save Board widget",
  audience_invalid: "The selected audience is unavailable",
  widget_limit: "A Board can contain at most 12 widgets",
  widget_order_invalid: "Order must contain the visible Board widgets",
};

function throwSafeWidgetError(error: ApiError): never {
  const detail = error.details;
  if (
    error.status === 404 &&
    (detail === "Board not found" || detail === "Board widget not found")
  ) {
    throw new ApiError(404, detail);
  }
  const parsed = z.object({ code: z.string() }).passthrough().safeParse(detail);
  if (error.status === 409 && parsed.success) {
    const message = Object.hasOwn(safeCodes, parsed.data.code)
      ? safeCodes[parsed.data.code]
      : undefined;
    if (message) {
      throw new ApiError(
        409,
        message,
        { code: parsed.data.code, message },
        parsed.data.code,
      );
    }
  }
  throw new ApiError(error.status, "Request could not be completed");
}

async function safeWidgetJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: ApiRequestInit = {},
): Promise<z.output<Schema>> {
  try {
    return await apiFetch(path, schema, { cache: "no-store", ...init });
  } catch (error) {
    if (error instanceof ApiError) return throwSafeWidgetError(error);
    throw error;
  }
}

function queryString(values: Record<string, string | number>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    query.set(key, String(value));
  return query.toString();
}

function serializeField(field: z.output<typeof inputFieldSchema>) {
  return { field_id: field.fieldId, expected_type: field.expectedType };
}

function serializeWidget(widget: z.output<typeof inputWidgetSchema>) {
  const audience =
    widget.audience.kind === "role"
      ? { kind: "role", role_id: widget.audience.roleId }
      : widget.audience.kind === "user"
        ? { kind: "user", user_id: widget.audience.userId }
        : { kind: widget.audience.kind };
  return {
    name: widget.name,
    widget_type: widget.widgetType,
    module_id: widget.moduleId,
    config: {
      ...widget.config,
      fields: widget.config.fields.map(serializeField),
      filters: widget.config.filters.map((filter) => ({
        ...serializeField(filter),
        operator: filter.operator,
        value: filter.value ?? null,
      })),
      metric: widget.config.metric && serializeField(widget.config.metric),
    },
    audience,
  };
}

function boardWidgetPath(boardId: string): string {
  return `/boards/${encodeURIComponent(boardId)}/widgets`;
}

function checkBoardId(widget: BoardWidget, boardId: string): void {
  if (widget.boardId !== boardId) throw new ApiContractError();
}

export async function listBoardWidgets(
  rawBoardId: string,
  rawOptions: BoardWidgetListOptions = {},
): Promise<BoardWidgetPage> {
  const boardId = uuidSchema.parse(rawBoardId);
  const options = listOptionsSchema.parse(rawOptions);
  const page = await safeWidgetJson(
    `${boardWidgetPath(boardId)}?${queryString({
      limit: options.limit,
      offset: options.offset,
      sort_by: options.sortBy,
      sort_order: options.sortOrder,
    })}`,
    listResponseSchema,
  );
  page.items.forEach((widget) => checkBoardId(widget, boardId));
  return page;
}

export async function createBoardWidget(
  rawBoardId: string,
  rawRevision: number,
  rawWidget: BoardWidgetInput,
): Promise<BoardWidgetMutation> {
  const boardId = uuidSchema.parse(rawBoardId);
  const revision = revisionSchema.parse(rawRevision);
  const widget = inputWidgetSchema.parse(rawWidget);
  const response = await safeWidgetJson(
    boardWidgetPath(boardId),
    mutationResponseSchema,
    {
      method: "POST",
      body: JSON.stringify({ revision, widget: serializeWidget(widget) }),
    },
  );
  checkBoardId(response.widget, boardId);
  return response;
}

export async function updateBoardWidget(
  rawBoardId: string,
  rawWidgetId: string,
  rawRevision: number,
  rawWidget: BoardWidgetInput,
): Promise<BoardWidgetMutation> {
  const boardId = uuidSchema.parse(rawBoardId);
  const widgetId = uuidSchema.parse(rawWidgetId);
  const revision = revisionSchema.parse(rawRevision);
  const widget = inputWidgetSchema.parse(rawWidget);
  const response = await safeWidgetJson(
    `${boardWidgetPath(boardId)}/${encodeURIComponent(widgetId)}`,
    mutationResponseSchema,
    {
      method: "PATCH",
      body: JSON.stringify({ revision, widget: serializeWidget(widget) }),
    },
  );
  checkBoardId(response.widget, boardId);
  if (response.widget.id !== widgetId) throw new ApiContractError();
  return response;
}

export async function duplicateBoardWidget(
  rawBoardId: string,
  rawWidgetId: string,
  rawRevision: number,
): Promise<BoardWidgetMutation> {
  const boardId = uuidSchema.parse(rawBoardId);
  const widgetId = uuidSchema.parse(rawWidgetId);
  const revision = revisionSchema.parse(rawRevision);
  const response = await safeWidgetJson(
    `${boardWidgetPath(boardId)}/${encodeURIComponent(widgetId)}/duplicate`,
    mutationResponseSchema,
    { method: "POST", body: JSON.stringify({ revision }) },
  );
  checkBoardId(response.widget, boardId);
  if (response.widget.id === widgetId) throw new ApiContractError();
  return response;
}

export async function reorderBoardWidgets(
  rawBoardId: string,
  rawRevision: number,
  rawWidgetIds: string[],
): Promise<BoardWidgetOrder> {
  const boardId = uuidSchema.parse(rawBoardId);
  const revision = revisionSchema.parse(rawRevision);
  const widgetIds = orderInputSchema.parse(rawWidgetIds);
  const response = await safeWidgetJson(
    `${boardWidgetPath(boardId)}/order`,
    orderResponseSchema,
    {
      method: "PUT",
      body: JSON.stringify({ revision, widget_ids: widgetIds }),
    },
  );
  response.items.forEach((widget) => checkBoardId(widget, boardId));
  if (
    response.items.length !== widgetIds.length ||
    response.items.some((widget, index) => widget.id !== widgetIds[index])
  ) {
    throw new ApiContractError();
  }
  return response;
}

export async function deleteBoardWidget(
  rawBoardId: string,
  rawWidgetId: string,
  rawRevision: number,
): Promise<void> {
  const boardId = uuidSchema.parse(rawBoardId);
  const widgetId = uuidSchema.parse(rawWidgetId);
  const revision = revisionSchema.parse(rawRevision);
  await safeWidgetJson(
    `${boardWidgetPath(boardId)}/${encodeURIComponent(widgetId)}?${queryString({ revision })}`,
    z.null(),
    { method: "DELETE" },
  );
}
