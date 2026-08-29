export type Pagination = {
  limit: number;
  offset: number;
  count: number;
  total: number;
  has_more: boolean;
};
export type ListResponse<T> = { items: T[]; pagination: Pagination };
export type BaseEntity = {
  id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: string | null;
};
export type Department = BaseEntity & { department_name: string };
export type Module = BaseEntity & {
  department_id: string;
  module_name: string;
  is_schema_accepted: boolean;
};
export type FieldType =
  | "text"
  | "number"
  | "decimal"
  | "int"
  | "boolean"
  | "date"
  | "datetime"
  | "select"
  | "relationship";
export type Field = BaseEntity & {
  module_id: string;
  name: string;
  type: FieldType;
  required: boolean;
  position: number;
  config: Record<string, unknown>;
  relationship_target_module_id: string | null;
  relationship_multiple_targets: boolean | null;
  relationship_multiple_sources: boolean | null;
};
export type RecordEntity = BaseEntity & {
  module_id: string;
  data: Record<string, unknown>;
};
export type RelationshipVisibility = "available" | "hidden";
export type RelationshipAvailability = "available" | "hidden" | "all";
export type RelationshipHiddenReason =
  | "field_archived"
  | "source_record_archived"
  | "target_record_archived"
  | "source_module_archived"
  | "target_module_archived";
export type Relationship = BaseEntity & {
  field_id: string;
  source_record_id: string;
  target_record_id: string;
  visibility: RelationshipVisibility;
  hidden_reasons: RelationshipHiddenReason[];
};
export type LifecycleTargetType = "department" | "module" | "field" | "record";
export type LifecycleOperation = "close" | "purge" | "reopen";
export type LifecycleBlockerCode =
  | "closed_ancestor"
  | "module_name_conflict"
  | "field_name_conflict"
  | "field_position_conflict"
  | "schema_invalid"
  | "record_data_invalid"
  | "record_close_unsupported"
  | "purge_external_schema_dependency";
export type LifecycleErrorCode =
  | LifecycleBlockerCode
  | "already_closed"
  | "already_open"
  | "confirmation_required"
  | "confirmation_name_mismatch"
  | "challenge_not_found"
  | "challenge_binding_mismatch"
  | "challenge_expired"
  | "challenge_exhausted"
  | "verification_in_progress"
  | "invalid_credentials"
  | "password_rate_limited"
  | "password_service_unavailable"
  | "purge_disabled"
  | "purge_requires_closed"
  | "impact_changed"
  | (string & {});
export type LifecycleRowState = {
  entity_type: string;
  entity_id: string;
  is_deleted: boolean;
  deleted_at: string | null;
  updated_at: string;
  state_fingerprint: string;
};
export type LifecycleExternalImpact = {
  edge_id: string;
  field_id: string;
  external_record_id: string;
  external_module_id: string;
  external_module_name: string;
  external_module_label?: string;
  external_department_id: string;
  external_department_name: string;
  external_department_label?: string;
};
export type LifecycleKeyStrip = {
  record_id: string;
  module_id: string;
  field_id: string;
  key: string;
};
export type LifecycleBlocker = {
  code: LifecycleBlockerCode;
  entity_type: string;
  entity_id: string;
  detail: string;
  conflicting_entity_type: string | null;
  conflicting_entity_id: string | null;
  field_id: string | null;
  field_name: string | null;
  module_id: string | null;
  module_name: string | null;
  department_id: string | null;
  department_name: string | null;
};
export type LifecycleImpact = {
  target_type: LifecycleTargetType;
  target_id: string;
  operation: LifecycleOperation;
  actor_id: string | null;
  rows: LifecycleRowState[];
  external_impacts: LifecycleExternalImpact[];
  key_strips: LifecycleKeyStrip[];
  blockers: LifecycleBlocker[];
  impact_digest: string;
};
export type LifecyclePreviewResponse = {
  impact: LifecycleImpact;
  token: string;
  expires_at: string;
  confirmation_name: string;
};
export type LifecycleMutationResponse = {
  impact: LifecycleImpact;
  operation_id: string | null;
};
export type LifecycleReopenRequest = { confirmed: true };
export type Role = BaseEntity & {
  role: string;
  permissions: Record<string, unknown>;
};
export type User = BaseEntity & {
  email: string;
  username: string;
  status: "pending" | "active" | "disabled";
  role_id: string;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    public code?: LifecycleErrorCode,
  ) {
    super(message);
  }
}

function isErrorDetail(
  value: unknown,
): value is { code?: unknown; message?: unknown; blockers?: unknown } {
  return typeof value === "object" && value !== null;
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? body.detail
        : "Request could not be completed";
    const errorDetail = isErrorDetail(detail) ? detail : undefined;
    throw new ApiError(
      response.status,
      typeof detail === "string"
        ? detail
        : typeof errorDetail?.message === "string"
          ? errorDetail.message
          : "Request could not be completed",
      detail,
      typeof errorDetail?.code === "string" ? errorDetail.code : undefined,
    );
  }
  return body;
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const response = await fetch(`/bff${path}`, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  try {
    return (await parseResponse(response)) as T;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // This utility has no router instance; hard navigation clears the expired shell.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      if (typeof window !== "undefined") window.location.href = "/login";
      throw error;
    }
    throw error;
  }
}

export function listQuery(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== "") query.set(key, String(value));
  return query.toString();
}
