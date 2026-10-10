import { z } from "zod";

import { ApiContractError, ApiError, apiFetch, apiRequest } from "@/lib/api";

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
  target_label: z.string().min(1),
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

function auditFilterParams(
  request: Omit<ManageAuditListRequest, "limit" | "offset">,
): URLSearchParams {
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
  return params;
}

export function manageAuditListPath(request: ManageAuditListRequest): string {
  const params = auditFilterParams(request);
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
  search = "",
): Promise<ManageAuditOptions> {
  const query = new URLSearchParams();
  if (search.trim()) query.set("search", search.trim());
  return apiFetch(
    `/audit-logs/options${query.size ? `?${query}` : ""}`,
    auditLogOptionsSchema,
    {
      cache: "no-store",
      signal,
    },
  );
}

export async function getManageAuditExportPreview(
  request: Omit<ManageAuditListRequest, "limit" | "offset">,
  signal?: AbortSignal,
): Promise<ManageAuditListResponse> {
  const page = await listManageAuditLogs(
    { ...request, limit: 10, offset: 0 },
    signal,
  );
  if (page.pagination.total > 10_000) throw new AuditExportLimitError();
  return page;
}

export type ManageAuditCsv = { blob: Blob; filename: string; count: number };

const CSV_HEADER =
  '"Date","User","Entity","Action","Target","Before","After"\r\n';
const exportCountSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(10_000));

export async function downloadManageAuditCsv(
  request: Omit<ManageAuditListRequest, "limit" | "offset">,
  signal?: AbortSignal,
): Promise<ManageAuditCsv> {
  const response = await apiRequest(
    `/audit-logs/export?${auditFilterParams(request)}`,
    { cache: "no-store", signal },
  );
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const detail = z
      .object({ detail: z.object({ code: z.string() }) })
      .safeParse(body);
    const code = detail.success ? detail.data.detail.code : undefined;
    if (response.status === 409 && code === "audit_export_limit")
      throw new AuditExportLimitError();
    throw new ApiError(
      response.status,
      "Request could not be completed",
      undefined,
      code,
    );
  }
  const count = exportCountSchema.safeParse(
    response.headers.get("X-Audit-Export-Count"),
  );
  if (
    response.headers.get("Content-Type")?.replaceAll(" ", "").toLowerCase() !==
      "text/csv;charset=utf-8" ||
    response.headers.get("Content-Disposition") !==
      'attachment; filename="openslate-audit.csv"' ||
    response.headers.get("Cache-Control") !== "no-store" ||
    !count.success
  )
    throw new ApiContractError();
  const bytes = await response.arrayBuffer();
  const header = count.data === 0 ? CSV_HEADER.slice(0, -2) : CSV_HEADER;
  if (
    new TextDecoder().decode(bytes.slice(0, header.length)) !== header ||
    (count.data === 0 && bytes.byteLength !== header.length)
  )
    throw new ApiContractError();
  return {
    blob: new Blob([bytes], { type: "text/csv;charset=utf-8" }),
    filename: "openslate-audit.csv",
    count: count.data,
  };
}
