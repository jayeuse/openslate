import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";
import { openViewReadFetch } from "./openview-access";
import {
  archiveSchema,
  audienceOptionKindSchema,
  audienceOptionListSchema,
  defaultListSchema,
  defaultSchema,
  defaultSetSchema,
  dataSourceListSchema,
  fieldSchema,
  listSchema,
  pageRequestSchema,
  recordListSchema,
  recordQuerySchema,
  restoreSchema,
  savedViewCreateSchema,
  savedViewListRequestSchema,
  savedViewListSchema,
  savedViewResponseSchema,
  savedViewUpdateSchema,
  uuidSchema,
} from "./views-schemas";
import {
  serializeOpenViewQueryDefinition,
  serializeOpenViewAudience,
  serializeOpenViewPresentation,
} from "./views-serialization";
import type {
  OpenViewAudienceOption,
  OpenViewConflict,
  OpenViewDataSource,
  OpenViewDataSourceField,
  OpenViewPage,
  OpenViewPersonalDefault,
  OpenViewQueryDefinition,
  OpenViewRecord,
  OpenViewSavedView,
} from "./views-schemas";

export type {
  OpenViewAudienceOption,
  OpenViewConflict,
  OpenViewDataSource,
  OpenViewDataSourceField,
  OpenViewPage,
  OpenViewPersonalDefault,
  OpenViewPresentation,
  OpenViewQueryDefinition,
  OpenViewQueryFieldReference,
  OpenViewQueryFieldType,
  OpenViewQueryFilter,
  OpenViewRecord,
  OpenViewSavedView,
} from "./views-schemas";
export { serializeOpenViewQueryDefinition };

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

export async function listOpenViewDataSources(
  options: { limit?: number; offset?: number } = {},
): Promise<OpenViewPage<OpenViewDataSource>> {
  const page = pageQuery(options);
  return openViewReadFetch(
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
  const result = await openViewReadFetch(
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
  kind: "user",
  options: { limit?: number; offset?: number } = {},
): Promise<OpenViewPage<OpenViewAudienceOption>> {
  const validKind = audienceOptionKindSchema.parse(kind);
  const page = pageQuery(options);
  return openViewReadFetch(
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
  return openViewReadFetch(
    `/views?${queryString(parameters)}`,
    savedViewListSchema,
  );
}

export async function getOpenViewSavedView(
  id: string,
): Promise<OpenViewSavedView> {
  const viewId = uuidSchema.parse(id);
  return openViewReadFetch(
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
    audience: serializeOpenViewAudience(input.audience),
    definition: serializeOpenViewQueryDefinition(input.definition),
    presentation: serializeOpenViewPresentation(input.presentation),
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
    body.audience = serializeOpenViewAudience(input.audience);
  if (input.definition !== undefined) {
    body.definition = serializeOpenViewQueryDefinition(input.definition);
  }
  if (input.presentation !== undefined) {
    body.presentation = serializeOpenViewPresentation(input.presentation);
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
  return openViewReadFetch(
    `/views/defaults?${queryString(page)}`,
    defaultListSchema,
  );
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
  return openViewReadFetch("/records/query", recordListSchema, {
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
