import { z } from "zod";
import {
  ApiContractError,
  ApiError,
  apiFetch,
  apiRequest,
  type ApiRequestInit,
} from "@/lib/api";
import {
  assertLifecyclePurgePreviewFor,
  assertLifecyclePurgeResultFor,
  lifecyclePurgeInputSchema,
  lifecyclePurgePreviewSchema,
  lifecyclePurgeResultSchema,
  type LifecyclePurgeInput,
  type LifecyclePurgePreview,
  type LifecyclePurgeResult,
} from "@/lib/lifecycle";
import {
  isReadRequest,
  openViewReadFetch,
  trackOpenViewRead,
} from "./openview-access";
import type { OpenViewPage } from "./views-api";
import {
  serializeOpenViewQueryDefinition,
  type OpenViewQueryDefinition,
  type OpenViewQueryFieldReference,
} from "./views-api";

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
  "user",
]);

const fieldReferenceSchema = z
  .object({
    fieldId: uuidSchema,
    expectedType: fieldTypeSchema,
  })
  .strict();
const wireFieldReferenceSchema = z
  .object({
    field_id: uuidSchema,
    expected_type: fieldTypeSchema,
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
const filterSchema = z
  .object({
    ...fieldReferenceSchema.shape,
    operator: filterOperatorSchema,
    value: z
      .union([scalarSchema, z.array(scalarSchema).min(1).max(100)])
      .nullish(),
  })
  .strict();
const wireFilterSchema = z
  .object({
    field_id: uuidSchema,
    expected_type: fieldTypeSchema,
    operator: filterOperatorSchema,
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
const sortSchema = fieldReferenceSchema.extend({
  direction: z.enum(["asc", "desc"]),
});
const wireSortSchema = z
  .object({
    field_id: uuidSchema,
    expected_type: fieldTypeSchema,
    direction: z.enum(["asc", "desc"]),
  })
  .strict()
  .transform(({ field_id, expected_type, direction }) => ({
    fieldId: field_id,
    expectedType: expected_type,
    direction,
  }));

const recipeInputSchema = z
  .object({
    version: z.literal(1).default(1),
    fields: z.array(fieldReferenceSchema).min(1).max(100),
    filters: z.array(filterSchema).max(10).default([]),
    logic: z.enum(["and", "or"]).default("and"),
    sorts: z.array(sortSchema).max(3).default([]),
    groupBy: fieldReferenceSchema.nullish().transform((value) => value ?? null),
    includeRowCount: z.boolean().default(false),
  })
  .strict()
  .superRefine((recipe, context) => {
    const definition: OpenViewQueryDefinition = {
      version: 1,
      columns: recipe.fields,
      filters: recipe.filters,
      logic: recipe.logic,
      sort: recipe.sorts,
      deleted: "exclude",
      search: null,
      searchFields: [],
    };
    try {
      serializeOpenViewQueryDefinition(definition);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Report recipe is invalid",
      });
    }
  });

const wireRecipeSchema = z
  .object({
    version: z.literal(1),
    fields: z.array(wireFieldReferenceSchema).min(1).max(100),
    filters: z.array(wireFilterSchema).max(10),
    logic: z.enum(["and", "or"]),
    sorts: z.array(wireSortSchema).max(3),
    group_by: wireFieldReferenceSchema.nullable(),
    include_row_count: z.boolean(),
  })
  .strict()
  .superRefine((recipe, context) => {
    const definition: OpenViewQueryDefinition = {
      version: 1,
      columns: recipe.fields,
      filters: recipe.filters,
      logic: recipe.logic,
      sort: recipe.sorts,
      deleted: "exclude",
      search: null,
      searchFields: [],
    };
    try {
      serializeOpenViewQueryDefinition(definition);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Report recipe is invalid",
      });
    }
  })
  .transform((recipe) => ({
    version: recipe.version,
    fields: recipe.fields,
    filters: recipe.filters,
    logic: recipe.logic,
    sorts: recipe.sorts,
    groupBy: recipe.group_by,
    includeRowCount: recipe.include_row_count,
  }));

const wireReportSchema = z
  .object({
    id: uuidSchema,
    module_id: uuidSchema,
    name: z.string().min(1).max(80),
    subtitle: z.string().max(160).nullable(),
    revision: z.number().int().min(1),
    recipe: wireRecipeSchema,
    is_deleted: z.boolean(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .transform((report) => ({
    id: report.id,
    moduleId: report.module_id,
    name: report.name,
    subtitle: report.subtitle,
    revision: report.revision,
    recipe: report.recipe,
    isDeleted: report.is_deleted,
    createdAt: report.created_at,
    updatedAt: report.updated_at,
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
  .transform(({ has_more, ...pagination }) => ({
    ...pagination,
    hasMore: has_more,
  }));
const wireReportListSchema = z
  .object({
    items: z.array(wireReportSchema),
    pagination: paginationSchema,
  })
  .strict();

const wireReportRunSchema = z
  .object({
    id: uuidSchema,
    report_id: uuidSchema,
    recipe_revision: z.number().int().min(1),
    row_count: z.number().int().min(0),
    headings: z.array(z.string()).min(1).max(100),
    created_at: timestampSchema,
  })
  .strict()
  .transform((run) => ({
    id: run.id,
    reportId: run.report_id,
    recipeRevision: run.recipe_revision,
    rowCount: run.row_count,
    headings: run.headings,
    createdAt: run.created_at,
  }));
const wireReportRunListSchema = z
  .object({
    items: z.array(wireReportRunSchema),
    pagination: paginationSchema,
  })
  .strict();
const wireSharedReportRunSchema = z
  .object({
    id: uuidSchema,
    report_id: uuidSchema,
    report_name: z.string().min(1).max(80),
    recipe_revision: z.number().int().min(1),
    row_count: z.number().int().min(0),
    headings: z.array(z.string()).min(1).max(100),
    created_at: timestampSchema,
    status: z.literal("succeeded"),
  })
  .strict()
  .transform((run) => ({
    id: run.id,
    reportId: run.report_id,
    reportName: run.report_name,
    recipeRevision: run.recipe_revision,
    rowCount: run.row_count,
    headings: run.headings,
    createdAt: run.created_at,
    status: run.status,
  }));
const wireSharedReportRunListSchema = z
  .object({
    items: z.array(wireSharedReportRunSchema),
    pagination: paginationSchema,
  })
  .strict();

const listOptionsSchema = z
  .object({
    moduleId: uuidSchema.optional(),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    sortBy: z.enum(["name", "created_at", "updated_at"]).optional(),
    sortOrder: z.enum(["asc", "desc"]).optional(),
    search: z.string().max(100).optional(),
    deleted: z.enum(["exclude", "include", "only"]).optional(),
  })
  .strict();
const createInputSchema = z
  .object({
    moduleId: uuidSchema,
    name: z.string().trim().min(1).max(80),
    subtitle: z.string().max(160).nullable().optional(),
    recipe: recipeInputSchema,
  })
  .strict();
const updateInputSchema = z
  .object({
    id: uuidSchema,
    revision: z.number().int().min(1),
    moduleId: uuidSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    subtitle: z.string().max(160).nullable().optional(),
    recipe: recipeInputSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.moduleId === undefined &&
      input.name === undefined &&
      input.subtitle === undefined &&
      input.recipe === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "At least one Report change is required",
      });
    }
  });
const runInputSchema = z
  .object({ reportId: uuidSchema, idempotencyKey: uuidSchema })
  .strict();
const runReadInputSchema = z
  .object({ reportId: uuidSchema, runId: uuidSchema })
  .strict();
const runListOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
const revisionInputSchema = z
  .object({ id: uuidSchema, revision: z.number().int().min(1) })
  .strict();

const reportConflictDetailSchema = z
  .object({
    code: z.literal("stale_revision"),
    current_revision: z.number().int().min(1).optional(),
  })
  .passthrough();
const reportErrorCodeSchema = z.enum([
  "report_invalid",
  "report_archived",
  "report_not_archived",
  "report_source_changed",
  "stale_revision",
]);
const reportErrorMessages: Record<
  z.infer<typeof reportErrorCodeSchema>,
  string
> = {
  report_invalid: "The Report source or selected fields are unavailable",
  report_archived: "Restore the Report before continuing",
  report_not_archived: "Archive the Report before continuing",
  report_source_changed: "The Report source changed while the run was saved",
  stale_revision: "Report changed; reload before saving",
};
const reportNotFoundMessages = new Set([
  "Report not found",
  "Report run not found",
]);

export type OpenViewReportRecipe = z.output<typeof recipeInputSchema>;
export type OpenViewReport = z.output<typeof wireReportSchema>;
export type OpenViewReportRun = z.output<typeof wireReportRunSchema>;
export type OpenViewSharedReportRun = z.output<
  typeof wireSharedReportRunSchema
>;
export type OpenViewReportConflict = {
  code: "stale_revision";
  message?: string;
  currentRevision?: number;
};
export type OpenViewReportCsv = { blob: Blob; filename: string };
export type OpenViewReportListOptions = z.input<typeof listOptionsSchema>;
export type OpenViewReportCreateInput = z.input<typeof createInputSchema>;
export type OpenViewReportUpdateInput = z.input<typeof updateInputSchema>;
export type OpenViewReportRunInput = z.input<typeof runInputSchema>;
export type OpenViewReportRunListOptions = z.input<typeof runListOptionsSchema>;

function queryString(values: Record<string, string | number>): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    parameters.set(key, String(value));
  }
  return parameters.toString();
}

function serializeFieldReference(reference: OpenViewQueryFieldReference) {
  return {
    field_id: reference.fieldId,
    expected_type: reference.expectedType,
  };
}

function serializeReportRecipe(raw: unknown) {
  const recipe = recipeInputSchema.parse(raw);
  const definition: OpenViewQueryDefinition = {
    version: 1,
    columns: recipe.fields,
    filters: recipe.filters,
    logic: recipe.logic,
    sort: recipe.sorts,
    deleted: "exclude",
    search: null,
    searchFields: [],
  };
  const wireDefinition = serializeOpenViewQueryDefinition(definition);
  return {
    version: recipe.version,
    fields: wireDefinition.columns,
    filters: wireDefinition.filters,
    logic: recipe.logic,
    sorts: wireDefinition.sort,
    group_by:
      recipe.groupBy === null ? null : serializeFieldReference(recipe.groupBy),
    include_row_count: recipe.includeRowCount,
  };
}

function throwSafeResponseError(status: number, body: unknown): never {
  const envelope = z
    .object({ detail: z.unknown() })
    .passthrough()
    .safeParse(body);
  if (!envelope.success) {
    throw new ApiError(status, "Request could not be completed");
  }

  const detail = envelope.data.detail;
  if (typeof detail === "string") {
    if (reportNotFoundMessages.has(detail)) {
      throw new ApiError(status, detail, detail);
    }
    throw new ApiError(status, "Request could not be completed");
  }
  const structured = z
    .object({
      code: reportErrorCodeSchema.optional(),
      message: z.string().max(240).optional(),
      current_revision: z.number().int().min(1).optional(),
    })
    .passthrough()
    .safeParse(detail);
  if (!structured.success) {
    throw new ApiError(status, "Request could not be completed");
  }

  const { code, current_revision } = structured.data;
  if (code === undefined) {
    throw new ApiError(status, "Request could not be completed");
  }
  const message = reportErrorMessages[code];
  throw new ApiError(
    status,
    message,
    {
      code,
      message,
      ...(code === "stale_revision" && current_revision !== undefined
        ? { current_revision }
        : {}),
    },
    code,
  );
}

async function throwCsvResponseError(response: Response): Promise<never> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(response.status, "Request could not be completed");
  }
  return throwSafeResponseError(response.status, body);
}

async function safeReportJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init?: ApiRequestInit,
): Promise<z.output<Schema>> {
  try {
    return await (isReadRequest(init) ? openViewReadFetch : apiFetch)(
      path,
      schema,
      init,
    );
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return throwSafeResponseError(error.status, { detail: error.details });
  }
}

export async function listOpenViewReports(
  raw: OpenViewReportListOptions = {},
): Promise<OpenViewPage<OpenViewReport>> {
  const options = listOptionsSchema.parse(raw);
  const values: Record<string, string | number> = {
    ...(options.moduleId === undefined ? {} : { module_id: options.moduleId }),
    limit: options.limit,
    offset: options.offset,
    ...(options.sortBy === undefined ? {} : { sort_by: options.sortBy }),
    ...(options.sortOrder === undefined
      ? {}
      : { sort_order: options.sortOrder }),
    ...(options.search?.trim() ? { search: options.search.trim() } : {}),
    ...(options.deleted === undefined ? {} : { deleted: options.deleted }),
  };
  return safeReportJson(
    `/reports?${queryString(values)}`,
    wireReportListSchema,
    {
      cache: "no-store",
    },
  );
}

export async function getOpenViewReport(
  rawReportId: string,
): Promise<OpenViewReport> {
  const reportId = uuidSchema.parse(rawReportId);
  const report = await safeReportJson(
    `/reports/${encodeURIComponent(reportId)}`,
    wireReportSchema,
    { cache: "no-store" },
  );
  if (report.id !== reportId) throw new ApiContractError();
  return report;
}

export async function createOpenViewReport(
  raw: OpenViewReportCreateInput,
): Promise<OpenViewReport> {
  const input = createInputSchema.parse(raw);
  const body = {
    module_id: input.moduleId,
    name: input.name,
    ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
    recipe: serializeReportRecipe(input.recipe),
  };
  return safeReportJson("/reports", wireReportSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateOpenViewReport(
  raw: OpenViewReportUpdateInput,
): Promise<OpenViewReport> {
  const input = updateInputSchema.parse(raw);
  const body: Record<string, unknown> = { revision: input.revision };
  if (input.moduleId !== undefined) body.module_id = input.moduleId;
  if (input.name !== undefined) body.name = input.name;
  if (input.subtitle !== undefined) body.subtitle = input.subtitle;
  if (input.recipe !== undefined) {
    body.recipe = serializeReportRecipe(input.recipe);
  }

  const report = await safeReportJson(
    `/reports/${encodeURIComponent(input.id)}`,
    wireReportSchema,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  if (report.id !== input.id) throw new ApiContractError();
  return report;
}

export async function archiveOpenViewReport(raw: {
  id: string;
  revision: number;
}): Promise<void> {
  const input = revisionInputSchema.parse(raw);
  await safeReportJson(
    `/reports/${encodeURIComponent(input.id)}?${queryString({ revision: input.revision })}`,
    z.null(),
    { method: "DELETE", cache: "no-store" },
  );
}

export async function restoreOpenViewReport(raw: {
  id: string;
  revision: number;
}): Promise<OpenViewReport> {
  const input = revisionInputSchema.parse(raw);
  const report = await safeReportJson(
    `/reports/${encodeURIComponent(input.id)}/restore`,
    wireReportSchema,
    {
      method: "POST",
      body: JSON.stringify({ revision: input.revision }),
      cache: "no-store",
    },
  );
  if (report.id !== input.id) throw new ApiContractError();
  return report;
}

export async function listOpenViewReportRuns(
  rawReportId: string,
  rawOptions: OpenViewReportRunListOptions = {},
): Promise<OpenViewPage<OpenViewReportRun>> {
  const reportId = uuidSchema.parse(rawReportId);
  const options = runListOptionsSchema.parse(rawOptions);
  const page = await safeReportJson(
    `/reports/${encodeURIComponent(reportId)}/runs?${queryString(options)}`,
    wireReportRunListSchema,
    { cache: "no-store" },
  );
  if (page.items.some((run) => run.reportId !== reportId)) {
    throw new ApiContractError();
  }
  return page;
}

export async function listOpenViewSharedReportRuns(
  rawOptions: OpenViewReportRunListOptions = {},
): Promise<OpenViewPage<OpenViewSharedReportRun>> {
  const options = runListOptionsSchema.parse(rawOptions);
  const page = await safeReportJson(
    `/reports/shared-runs?${queryString(options)}`,
    wireSharedReportRunListSchema,
    { cache: "no-store" },
  );
  if (
    page.pagination.limit !== options.limit ||
    page.pagination.offset !== options.offset ||
    page.items.length !== page.pagination.count
  ) {
    throw new ApiContractError();
  }
  return page;
}

export async function createOpenViewReportRun(
  raw: OpenViewReportRunInput,
): Promise<OpenViewReportRun> {
  const input = runInputSchema.parse(raw);
  const run = await safeReportJson(
    `/reports/${encodeURIComponent(input.reportId)}/runs`,
    wireReportRunSchema,
    {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      cache: "no-store",
    },
  );
  if (run.reportId !== input.reportId) throw new ApiContractError();
  return run;
}

export async function getOpenViewReportRun(
  rawReportId: string,
  rawRunId: string,
): Promise<OpenViewReportRun> {
  const input = runReadInputSchema.parse({
    reportId: rawReportId,
    runId: rawRunId,
  });
  const run = await safeReportJson(
    `/reports/${encodeURIComponent(input.reportId)}/runs/${encodeURIComponent(input.runId)}`,
    wireReportRunSchema,
    { cache: "no-store" },
  );
  if (run.id !== input.runId || run.reportId !== input.reportId) {
    throw new ApiContractError();
  }
  return run;
}

export async function downloadOpenViewReportRunCsv(
  rawReportId: string,
  rawRunId: string,
): Promise<OpenViewReportCsv> {
  const input = runReadInputSchema.parse({
    reportId: rawReportId,
    runId: rawRunId,
  });
  // The CSV output needs records.read like every Report read.
  const response = await trackOpenViewRead(async () => {
    const reply = await apiRequest(
      `/reports/${encodeURIComponent(input.reportId)}/runs/${encodeURIComponent(input.runId)}/csv`,
      { cache: "no-store" },
    );
    if (!reply.ok) return throwCsvResponseError(reply);
    return reply;
  });

  const contentType = response.headers
    .get("Content-Type")
    ?.replaceAll(" ", "")
    .toLowerCase();
  if (contentType !== "text/csv;charset=utf-8" && contentType !== "text/csv") {
    throw new ApiContractError();
  }
  if (
    response.headers.get("Content-Disposition") !==
    `attachment; filename="report-${input.runId}.csv"`
  ) {
    throw new ApiContractError();
  }

  const bytes = await response.arrayBuffer();
  return {
    blob: new Blob([bytes], { type: "text/csv;charset=utf-8" }),
    filename: `report-${input.runId}.csv`,
  };
}

export function getOpenViewReportConflict(
  error: unknown,
): OpenViewReportConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = reportConflictDetailSchema.safeParse(error.details);
  if (!parsed.success) return null;
  return {
    code: parsed.data.code,
    message: reportErrorMessages.stale_revision,
    ...(parsed.data.current_revision === undefined
      ? {}
      : { currentRevision: parsed.data.current_revision }),
  };
}

export async function previewReportPurge(
  rawReportId: string,
): Promise<LifecyclePurgePreview> {
  const reportId = uuidSchema.parse(rawReportId);
  const preview = await apiFetch(
    `/reports/${encodeURIComponent(reportId)}/purge/preview`,
    lifecyclePurgePreviewSchema,
    { method: "POST", cache: "no-store" },
  );
  assertLifecyclePurgePreviewFor(preview, "report", reportId);
  return preview;
}

export async function purgeReport(
  rawReportId: string,
  rawInput: LifecyclePurgeInput,
): Promise<LifecyclePurgeResult> {
  const reportId = uuidSchema.parse(rawReportId);
  const input = lifecyclePurgeInputSchema.parse(rawInput);
  const result = await apiFetch(
    `/reports/${encodeURIComponent(reportId)}/purge`,
    lifecyclePurgeResultSchema,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({
        token: input.token,
        confirmation_name: input.confirmationName,
        password: input.password,
      }),
    },
  );
  assertLifecyclePurgeResultFor(result, "report", reportId);
  return result;
}
