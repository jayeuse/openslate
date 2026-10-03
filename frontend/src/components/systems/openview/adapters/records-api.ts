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
  if (preview.confirmation_name !== recordId) throw new ApiContractError();
  return preview;
}

export async function purgeRecord(
  rawRecordId: string,
  rawInput: LifecyclePurgeInput,
): Promise<z.output<typeof lifecyclePurgeResultSchema>> {
  const recordId = uuidSchema.parse(rawRecordId);
  const input = lifecyclePurgeInputSchema.parse(rawInput);
  if (input.confirmationName !== recordId) throw new ApiContractError();
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

export async function listOpenViewRelationshipFields(
  moduleId: string,
): Promise<OpenViewRelationshipField[]> {
  const query = new URLSearchParams({
    module_id: uuidSchema.parse(moduleId),
    type: "relationship",
    limit: "100",
  });
  const page = await apiFetch(
    `/fields?${query.toString()}`,
    listSchema(relationshipFieldSchema),
    { cache: "no-store" },
  );
  return page.items
    .filter((field) => !field.isDeleted)
    .sort((left, right) => left.position - right.position);
}

const RECORD_LINK_PAGE_SIZE = 100;
// A record with more links than this is refused rather than shown incomplete.
const RECORD_LINK_MAX_PAGES = 50;

/** Every visible link that starts or ends at the record (the panel treats it as complete). */
export async function listOpenViewRecordLinks(
  recordId: string,
): Promise<OpenViewRelationship[]> {
  const incident = uuidSchema.parse(recordId);
  const links: OpenViewRelationship[] = [];
  for (let pageIndex = 0; pageIndex < RECORD_LINK_MAX_PAGES; pageIndex += 1) {
    const query = new URLSearchParams({
      incident_record_id: incident,
      limit: String(RECORD_LINK_PAGE_SIZE),
      offset: String(pageIndex * RECORD_LINK_PAGE_SIZE),
    });
    const page = await apiFetch(
      `/relationships?${query.toString()}`,
      listSchema(relationshipSchema),
      { cache: "no-store" },
    );
    links.push(...page.items);
    if (!page.pagination.hasMore) return links;
  }
  throw new ApiContractError();
}

/** One page of a link field's visible links. */
export function listOpenViewFieldLinks(
  fieldId: string,
  options: { limit: number; offset: number },
): Promise<OpenViewPage<OpenViewRelationship>> {
  const query = new URLSearchParams({
    field_id: uuidSchema.parse(fieldId),
    limit: String(options.limit),
    offset: String(options.offset),
  });
  return apiFetch(
    `/relationships?${query.toString()}`,
    listSchema(relationshipSchema),
    { cache: "no-store" },
  );
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
}): Promise<OpenViewPage<OpenViewRecord>> {
  return openViewReadFetch("/records/query", recordListSchema, {
    method: "POST",
    body: JSON.stringify({
      module_id: uuidSchema.parse(input.moduleId),
      definition: serializeOpenViewQueryDefinition(input.definition),
      limit: 50,
      offset: 0,
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
