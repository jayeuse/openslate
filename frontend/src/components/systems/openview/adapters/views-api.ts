import { z } from "zod";
import { ApiContractError, ApiError, apiFetch } from "@/lib/api";
import { openViewReadFetch } from "./openview-access";
import {
  archiveSchema,
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
  serializeOpenViewPresentation,
} from "./views-serialization";
import type {
  OpenViewConflict,
  OpenViewDataSource,
  OpenViewDataSourceField,
  OpenViewPage,
  OpenViewQueryDefinition,
  OpenViewRecord,
  OpenViewSavedView,
} from "./views-schemas";

export type {
  OpenViewConflict,
  OpenViewDataSource,
  OpenViewDataSourceField,
  OpenViewPage,
  OpenViewPresentation,
  OpenViewQueryDefinition,
  OpenViewQueryFieldReference,
  OpenViewQueryFieldType,
  OpenViewQueryFilter,
  OpenViewRecord,
  OpenViewSavedView,
} from "./views-schemas";
export { serializeOpenViewQueryDefinition };

const assignableUserSchema = z
  .object({
    id: uuidSchema,
    display_name: z.string().nullable(),
    username: z.string().min(1),
  })
  .strict()
  .transform(({ id, display_name, username }) => ({
    id,
    displayName: display_name,
    username,
  }));
export type OpenViewAssignableUser = z.output<typeof assignableUserSchema>;

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

/** Resolve a selected primitive field without crawling its catalog. */
export async function getOpenViewDataSourceField(
  moduleId: string,
  fieldId: string,
  signal?: AbortSignal,
): Promise<OpenViewDataSourceField> {
  const requestedModuleId = uuidSchema.parse(moduleId);
  const id = uuidSchema.parse(fieldId);
  const raw = await openViewReadFetch(
    `/fields/${encodeURIComponent(id)}`,
    z.object({
      id: uuidSchema,
      module_id: uuidSchema,
      name: z.string().min(1),
      type: z.string(),
      required: z.boolean(),
      position: z.number().int().min(0),
      config: z.record(z.string(), z.unknown()),
      is_deleted: z.boolean(),
    }),
    { cache: "no-store", signal },
  );
  if (raw.id !== id || raw.module_id !== requestedModuleId || raw.is_deleted)
    throw new ApiContractError();
  return fieldSchema.parse({
    id: raw.id,
    module_id: raw.module_id,
    name: raw.name,
    type: raw.type,
    required: raw.required,
    position: raw.position,
    config: raw.config,
  });
}

/** Resolve a selected active source through the existing module detail route. */
export async function getOpenViewDataSource(
  moduleId: string,
  signal?: AbortSignal,
): Promise<OpenViewDataSource> {
  const id = uuidSchema.parse(moduleId);
  const raw = await openViewReadFetch(
    `/modules/${encodeURIComponent(id)}`,
    z.object({
      id: uuidSchema,
      department_id: uuidSchema,
      module_name: z.string().min(1),
      title_field_id: uuidSchema.nullable(),
      is_deleted: z.boolean(),
    }),
    { cache: "no-store", signal },
  );
  if (raw.id !== id || raw.is_deleted) throw new ApiContractError();
  return {
    id,
    name: raw.module_name,
    departmentId: raw.department_id,
    titleFieldId: raw.title_field_id,
  };
}

export async function listOpenViewAssignableUsers(
  moduleId: string,
  options: { limit?: number; offset?: number; search?: string } = {},
): Promise<OpenViewPage<OpenViewAssignableUser>> {
  const validModuleId = uuidSchema.parse(moduleId);
  const { search: rawSearch, ...rawPage } = options;
  const page = pageQuery(rawPage);
  const search = z.string().trim().max(100).optional().parse(rawSearch);
  const query = queryString({
    ...page,
    ...(search ? { search } : {}),
  });
  return openViewReadFetch(
    `/modules/${encodeURIComponent(validModuleId)}/assignable-users?${query}`,
    listSchema(assignableUserSchema),
    { cache: "no-store" },
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
    is_default: input.isDefault,
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
  if (input.isDefault !== undefined) body.is_default = input.isDefault;
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
