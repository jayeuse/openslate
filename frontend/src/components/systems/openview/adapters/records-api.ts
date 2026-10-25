import { z } from "zod";
import { ApiContractError, ApiError, apiFetch } from "@/lib/api";
import {
  assertLifecyclePurgePreviewFor,
  assertLifecyclePurgeResultFor,
  lifecyclePurgeInputSchema,
  lifecyclePurgePreviewSchema,
  lifecyclePurgeResultSchema,
} from "@/lib/lifecycle";
import type {
  LifecyclePurgeInput,
  LifecyclePurgePreview,
} from "@/lib/lifecycle";
import { openViewReadFetch } from "./openview-access";
import { serializeOpenViewQueryDefinition } from "./views-serialization";
import {
  listSchema,
  recordListSchema,
  recordSchema,
  uuidSchema,
  type OpenViewPage,
  type OpenViewQueryDefinition,
  type OpenViewRecord,
} from "./views-schemas";

// Record commands for the OpenView record dialog. Record reads go through
// the OpenView access latch. Writes, links, and history do not: their
// refusal says nothing about records.read, so it must not hide OpenView.

const noContentSchema = z.null();

const relationshipFieldSchema = z
  .object({
    id: uuidSchema,
    module_id: uuidSchema,
    name: z.string().min(1),
    type: z.literal("relationship"),
    is_deleted: z.boolean(),
    position: z.number().int(),
    relationship_target_module_id: uuidSchema.nullable(),
    relationship_multiple_targets: z.boolean().nullable(),
    relationship_multiple_sources: z.boolean().nullable(),
  })
  .transform((field) => ({
    id: field.id,
    moduleId: field.module_id,
    name: field.name,
    isDeleted: field.is_deleted,
    position: field.position,
    targetModuleId: field.relationship_target_module_id,
    multipleTargets: field.relationship_multiple_targets !== false,
    multipleSources: field.relationship_multiple_sources !== false,
  }));
export type OpenViewRelationshipField = z.output<
  typeof relationshipFieldSchema
>;

const relationshipSchema = z
  .object({
    id: uuidSchema,
    field_id: uuidSchema,
    source_record_id: uuidSchema,
    target_record_id: uuidSchema,
    created_at: z.string(),
    visibility: z.enum(["available", "hidden"]),
  })
  .transform((edge) => ({
    id: edge.id,
    fieldId: edge.field_id,
    sourceRecordId: edge.source_record_id,
    targetRecordId: edge.target_record_id,
    createdAt: edge.created_at,
    visibility: edge.visibility,
  }));
export type OpenViewRelationship = z.output<typeof relationshipSchema>;

const auditEntrySchema = z
  .object({
    id: uuidSchema,
    created_at: z.string(),
    performed_by: uuidSchema.nullable(),
    action: z.enum(["create", "update", "delete"]),
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
    actor_label: z.string().nullable(),
  })
  .transform((entry) => ({
    id: entry.id,
    createdAt: entry.created_at,
    performedBy: entry.performed_by,
    action: entry.action,
    before: entry.before,
    after: entry.after,
    actorLabel: entry.actor_label,
  }));
export type OpenViewRecordHistoryEntry = z.output<typeof auditEntrySchema>;

function recordPath(recordId: string): string {
  return `/records/${encodeURIComponent(uuidSchema.parse(recordId))}`;
}

export function getOpenViewRecord(recordId: string): Promise<OpenViewRecord> {
  return openViewReadFetch(recordPath(recordId), recordSchema, {
    cache: "no-store",
  });
}

export function createOpenViewRecord(input: {
  moduleId: string;
  data: Record<string, unknown>;
}): Promise<OpenViewRecord> {
  return apiFetch("/records", recordSchema, {
    method: "POST",
    body: JSON.stringify({
      module_id: uuidSchema.parse(input.moduleId),
      data: input.data,
    }),
  });
}

/** Replaces the active values. `revision` is the `updatedAt` the user last saw. */
export function updateOpenViewRecord(input: {
  recordId: string;
  revision: string;
  data: Record<string, unknown>;
}): Promise<OpenViewRecord> {
  return apiFetch(recordPath(input.recordId), recordSchema, {
    method: "PATCH",
    headers: { "If-Match": `"${input.revision}"` },
    body: JSON.stringify({ data: input.data }),
  });
}

const recordMoveSchema = z
  .object({
    recordId: uuidSchema,
    revision: z.iso.datetime({ offset: true }),
    fieldId: uuidSchema,
    value: z.union([z.string(), z.boolean(), z.null()]),
  })
  .strict();
const compoundRecordMoveSchema = z
  .object({
    recordId: uuidSchema,
    revision: z.iso.datetime({ offset: true }),
    changes: z
      .array(
        z
          .object({
            fieldId: uuidSchema,
            value: z.union([z.string(), z.boolean(), z.null()]),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .refine(
    (item) =>
      new Set(item.changes.map((change) => change.fieldId)).size ===
      item.changes.length,
  );
const recordMoveInputSchema = z.union([
  recordMoveSchema,
  compoundRecordMoveSchema,
]);
const batchResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("updated"),
      record_id: uuidSchema,
      record: recordSchema,
    })
    .strict(),
  z.object({ status: z.literal("stale"), record_id: uuidSchema }).strict(),
  z
    .object({
      status: z.literal("invalid"),
      record_id: uuidSchema,
      errors: z.array(
        z
          .object({
            code: z.string(),
            field_id: uuidSchema.nullable(),
            message: z.string(),
          })
          .strict(),
      ),
      truncated: z.boolean(),
    })
    .strict(),
  z.object({ status: z.literal("forbidden"), record_id: uuidSchema }).strict(),
]);

export type OpenViewRecordMove = z.input<typeof recordMoveInputSchema>;
export type OpenViewRecordMoveResult = z.output<typeof batchResultSchema>;

/** Saves only each selected field, against the revision seen before the move. */
export async function updateOpenViewRecordMoves(input: {
  moduleId: string;
  items: readonly OpenViewRecordMove[];
}): Promise<OpenViewRecordMoveResult[]> {
  const moduleId = uuidSchema.parse(input.moduleId);
  const items = z
    .array(recordMoveInputSchema)
    .min(1)
    .max(100)
    .parse(input.items);
  const requested = new Map(items.map((item) => [item.recordId, item]));
  if (requested.size !== items.length) throw new ApiContractError();
  const response = await apiFetch(
    "/records/batch-update",
    z
      .object({
        results: z.array(batchResultSchema).max(100),
      })
      .strict(),
    {
      method: "POST",
      body: JSON.stringify({
        module_id: moduleId,
        items: items.map((item) => ({
          record_id: item.recordId,
          revision: item.revision,
          ...("changes" in item
            ? {
                changes: item.changes.map(({ fieldId, value }) => ({
                  field_id: fieldId,
                  value,
                })),
              }
            : { field_id: item.fieldId, value: item.value }),
        })),
      }),
    },
  );
  const returned = new Set(response.results.map((result) => result.record_id));
  if (
    response.results.length !== items.length ||
    returned.size !== requested.size
  )
    throw new ApiContractError();
  for (const result of response.results) {
    const item = requested.get(result.record_id);
    if (
      !item ||
      (result.status === "updated" &&
        (result.record.id !== item.recordId ||
          result.record.moduleId !== moduleId ||
          result.record.isDeleted ||
          result.record.deletedAt !== null ||
          ("changes" in item ? item.changes : [item]).some(
            (change) => result.record.data[change.fieldId] !== change.value,
          )))
    )
      throw new ApiContractError();
  }
  return response.results;
}

export async function deleteOpenViewRecord(recordId: string): Promise<void> {
  await apiFetch(recordPath(recordId), noContentSchema, { method: "DELETE" });
}

export function restoreOpenViewRecord(
  recordId: string,
): Promise<OpenViewRecord> {
  return apiFetch(`${recordPath(recordId)}/restore`, recordSchema, {
    method: "POST",
  });
}

export async function previewRecordPurge(
  rawRecordId: string,
): Promise<LifecyclePurgePreview> {
  const recordId = uuidSchema.parse(rawRecordId);
  const preview = await apiFetch(
    `${recordPath(recordId)}/purge/preview`,
    lifecyclePurgePreviewSchema,
    { method: "POST", cache: "no-store" },
  );
  assertLifecyclePurgePreviewFor(preview, "record", recordId);
  return preview;
}

export async function purgeRecord(
  rawRecordId: string,
  rawInput: LifecyclePurgeInput,
): Promise<z.output<typeof lifecyclePurgeResultSchema>> {
  const recordId = uuidSchema.parse(rawRecordId);
  const input = lifecyclePurgeInputSchema.parse(rawInput);
  const result = await apiFetch(
    `${recordPath(recordId)}/purge`,
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
  assertLifecyclePurgeResultFor(result, "record", recordId);
  return result;
}

/** Whether a save was refused because someone else changed the record. */
export function isStaleRecordSave(error: unknown): boolean {
  return error instanceof ApiError && error.status === 412;
}

export function listOpenViewRelationshipFields(
  moduleId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<OpenViewPage<OpenViewRelationshipField>> {
  const query = new URLSearchParams({
    module_id: uuidSchema.parse(moduleId),
    type: "relationship",
    deleted: "exclude",
    limit: String(options.limit ?? 100),
    offset: String(options.offset ?? 0),
  });
  return apiFetch(`/fields?${query}`, listSchema(relationshipFieldSchema), {
    cache: "no-store",
  });
}

/**
 * The relationship fields of every module the person can read, one page. A
 * dashboard may show modules linked to its department either way (BE2).
 */
export function listReadableRelationshipFields(
  signal?: AbortSignal,
): Promise<OpenViewPage<OpenViewRelationshipField>> {
  const query = new URLSearchParams({
    type: "relationship",
    deleted: "exclude",
    limit: "100",
    offset: "0",
  });
  return apiFetch(`/fields?${query}`, listSchema(relationshipFieldSchema), {
    cache: "no-store",
    signal,
  });
}

/** One visible incident-link page; the caller exposes the continuation. */
export function listOpenViewRecordLinks(
  recordId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<OpenViewPage<OpenViewRelationship>> {
  return listOpenViewLinks({ incidentRecordId: recordId, ...options });
}

/** One bounded, server-filtered relationship page. Exact filters support write reconciliation and candidate occupancy. */
export function listOpenViewLinks(options: {
  incidentRecordId?: string;
  fieldId?: string;
  sourceRecordId?: string;
  targetRecordId?: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}): Promise<OpenViewPage<OpenViewRelationship>> {
  const query = new URLSearchParams({
    limit: String(options.limit ?? 100),
    offset: String(options.offset ?? 0),
  });
  for (const [key, value] of Object.entries({
    incident_record_id: options.incidentRecordId,
    field_id: options.fieldId,
    source_record_id: options.sourceRecordId,
    target_record_id: options.targetRecordId,
  }))
    if (value) query.set(key, uuidSchema.parse(value));
  return apiFetch(`/relationships?${query}`, listSchema(relationshipSchema), {
    cache: "no-store",
    signal: options.signal,
  });
}

export function listOpenViewFieldLinks(
  fieldId: string,
  options: { limit: number; offset: number },
): Promise<OpenViewPage<OpenViewRelationship>> {
  return listOpenViewLinks({ fieldId, ...options });
}

export function linkOpenViewRecords(input: {
  fieldId: string;
  sourceRecordId: string;
  targetRecordId: string;
}): Promise<OpenViewRelationship> {
  return apiFetch("/relationships", relationshipSchema, {
    method: "POST",
    body: JSON.stringify({
      field_id: uuidSchema.parse(input.fieldId),
      source_record_id: uuidSchema.parse(input.sourceRecordId),
      target_record_id: uuidSchema.parse(input.targetRecordId),
    }),
  });
}

/** Sets or replaces the one link of a single-target field. */
export async function assignOpenViewRecordLink(input: {
  fieldId: string;
  sourceRecordId: string;
  targetRecordId: string;
}): Promise<void> {
  await apiFetch(
    `/relationships/fields/${encodeURIComponent(uuidSchema.parse(input.fieldId))}/sources/${encodeURIComponent(uuidSchema.parse(input.sourceRecordId))}`,
    relationshipSchema.nullable(),
    {
      method: "PUT",
      body: JSON.stringify({
        target_record_id: uuidSchema.parse(input.targetRecordId),
      }),
    },
  );
}

export async function unlinkOpenViewRecords(
  relationshipId: string,
): Promise<void> {
  await apiFetch(
    `/relationships/${encodeURIComponent(uuidSchema.parse(relationshipId))}`,
    noContentSchema,
    { method: "DELETE" },
  );
}

/** Records of a linked module that match a search, for the link picker. */
export function searchOpenViewLinkTargets(input: {
  moduleId: string;
  definition: OpenViewQueryDefinition;
  limit?: number;
  offset?: number;
}): Promise<OpenViewPage<OpenViewRecord>> {
  return openViewReadFetch("/records/query", recordListSchema, {
    method: "POST",
    body: JSON.stringify({
      module_id: uuidSchema.parse(input.moduleId),
      definition: serializeOpenViewQueryDefinition(input.definition),
      limit: input.limit ?? 50,
      offset: input.offset ?? 0,
    }),
  });
}

/**
 * The record's change history, newest first. Only administrators and
 * managers of the record's department may read it.
 */
export async function listOpenViewRecordHistory(input: {
  recordId: string;
  departmentId: string;
}): Promise<OpenViewRecordHistoryEntry[]> {
  const query = new URLSearchParams({
    entity_id: uuidSchema.parse(input.recordId),
    department_id: uuidSchema.parse(input.departmentId),
    limit: "50",
  });
  const page = await apiFetch(
    `/audit-logs?${query.toString()}`,
    listSchema(auditEntrySchema),
    { cache: "no-store" },
  );
  return page.items;
}
