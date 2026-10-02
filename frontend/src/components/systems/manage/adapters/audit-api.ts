import { z } from "zod";

import { apiFetch } from "@/lib/api";

const auditActionSchema = z.enum(["create", "update", "delete"]);

const auditLogSchema = z.object({
  id: z.uuid(),
  created_at: z.iso.datetime({ offset: true }),
  performed_by: z.uuid().nullable(),
  action: auditActionSchema,
  entity_type: z.string().min(1).max(50),
  entity_id: z.uuid().nullable(),
  department_id: z.uuid().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  request_id: z.uuid().nullable(),
  request_method: z.string().nullable(),
  request_path: z.string().nullable(),
  actor_label: z.string().nullable(),
  actor_name: z.string().nullable(),
  note: z.string().nullable(),
});

const auditLogListSchema = z.object({
  items: z.array(auditLogSchema),
  pagination: z.object({
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    has_more: z.boolean(),
  }),
});

const auditLogOptionsSchema = z.object({
  entity_types: z.array(z.string().min(1).max(50)),
  actors: z.array(
    z.object({
      performed_by: z.uuid(),
      actor_label: z.string().nullable(),
      actor_name: z.string().nullable(),
    }),
  ),
});

export type ManageAuditAction = z.output<typeof auditActionSchema>;
export type ManageAuditLog = z.output<typeof auditLogSchema>;
export type ManageAuditListResponse = z.output<typeof auditLogListSchema>;
export type ManageAuditOptions = z.output<typeof auditLogOptionsSchema>;

export class AuditExportLimitError extends Error {
  constructor() {
    super(
      "Audit exports support up to 10,000 entries. Narrow your filters and try again.",
    );
    this.name = "AuditExportLimitError";
  }
}

export type ManageAuditListRequest = {
  search?: string;
  action?: ManageAuditAction;
  entityType?: string;
  performedBy?: string;
  createdAfter?: string;
  createdBefore?: string;
  sortOrder: "asc" | "desc";
  limit: number;
  offset: number;
};

export function manageAuditListPath(request: ManageAuditListRequest): string {
  const params = new URLSearchParams();
  if (request.action) params.set("action", request.action);
  if (request.entityType) params.set("entity_type", request.entityType);
  if (request.performedBy) params.set("performed_by", request.performedBy);
  if (request.createdAfter) params.set("created_after", request.createdAfter);
  if (request.createdBefore)
    params.set("created_before", request.createdBefore);
  const search = request.search?.trim();
  if (search) params.set("search", search);
  params.set("sort_by", "created_at");
  params.set("sort_order", request.sortOrder);
  params.set("limit", String(request.limit));
  params.set("offset", String(request.offset));
  return `/audit-logs?${params.toString()}`;
}

export function listManageAuditLogs(
  request: ManageAuditListRequest,
  signal?: AbortSignal,
): Promise<ManageAuditListResponse> {
  return apiFetch(manageAuditListPath(request), auditLogListSchema, {
    cache: "no-store",
    signal,
  });
}

export function getManageAuditLog(
  id: string,
  signal?: AbortSignal,
): Promise<ManageAuditLog> {
  return apiFetch(`/audit-logs/${encodeURIComponent(id)}`, auditLogSchema, {
    cache: "no-store",
    signal,
  });
}

export function getManageAuditOptions(
  signal?: AbortSignal,
): Promise<ManageAuditOptions> {
  return apiFetch("/audit-logs/options", auditLogOptionsSchema, {
    cache: "no-store",
    signal,
  });
}

export async function listAllManageAuditLogs(
  request: Omit<ManageAuditListRequest, "limit" | "offset">,
  signal?: AbortSignal,
): Promise<ManageAuditLog[]> {
  const items: ManageAuditLog[] = [];
  let offset = 0;
  while (true) {
    const page = await listManageAuditLogs(
      { ...request, limit: 100, offset },
      signal,
    );
    if (
      page.pagination.total > 10_000 ||
      items.length + page.items.length > 10_000
    )
      throw new AuditExportLimitError();
    items.push(...page.items);
    if (!page.pagination.has_more || page.items.length === 0) return items;
    offset += page.items.length;
  }
}
