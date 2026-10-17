import { z } from "zod";

import { currentOrganizationId } from "@/lib/organization-context";

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
};
export type FieldType =
  | "text"
  | "long_text"
  | "email"
  | "url"
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
  audit_redacted?: boolean;
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
export type LifecycleTargetType =
  | "department"
  | "module"
  | "field"
  | "record"
  | "file"
  | "board"
  | "report"
  | "board_event";
export type LifecycleOperation = "close" | "purge" | "reopen";
export type LifecycleBlockerCode =
  | "closed_ancestor"
  | "module_name_conflict"
  | "field_name_conflict"
  | "field_position_conflict"
  | "schema_invalid"
  | "record_data_invalid"
  | "title_field_selected"
  | "record_close_unsupported"
  | "purge_board_dependency"
  | "purge_dashboard_dependency"
  | "purge_chart_dependency"
  | "purge_report_dependency"
  | "purge_report_run_dependency"
  | "purge_trigger_dependency"
  | "purge_external_schema_dependency"
  | "purge_file_dependency";
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
  | "password_upstream_rate_limited"
  | "password_upstream_unavailable"
  | "actor_blocked"
  | "actor_mismatch"
  | "preflight_failed"
  | "temporarily_unavailable"
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
  byte_count?: number | null;
};
export type LifecycleExternalImpact = {
  edge_id: string;
  field_id: string;
  external_record_id: string;
  external_record_label: string;
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
export type LifecyclePurgePreviewResponse = LifecyclePreviewResponse & {
  last_successful_backup_at: string | null;
};
export type LifecycleMutationResponse = {
  impact: LifecycleImpact;
  operation_id: string | null;
};
export type LifecycleReopenRequest = { confirmed: true };
export type AuditAction = "create" | "update" | "delete";
export type AuditLog = {
  id: string;
  created_at: string;
  performed_by: string | null;
  action: AuditAction;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  request_id: string | null;
  request_method: string | null;
  request_path: string | null;
  actor_label: string | null;
  note: string | null;
};
export type SecurityEventOutcome =
  "attempt" | "success" | "denied" | "failure" | "partial";
export type SecurityEvent = {
  id: string;
  occurred_at: string;
  event_type: string;
  outcome: SecurityEventOutcome;
  source: string;
  operation_id: string;
  actor_id: string | null;
  subject_id: string | null;
  labels: Record<string, string>;
  fingerprint: string | null;
  reason: string | null;
  request_id: string | null;
  request_method: string | null;
  request_path: string | null;
  metadata: Record<string, unknown>;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    public code?: LifecycleErrorCode,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

const SAFE_API_CONTRACT_ERROR_MESSAGE =
  "The server returned an invalid response";

export class ApiContractError extends Error {
  constructor() {
    super(SAFE_API_CONTRACT_ERROR_MESSAGE);
    this.name = "ApiContractError";
  }
}

function safeApiContractError(): ApiContractError {
  return new ApiContractError();
}

export type ApiFieldErrors = Record<string, string[]>;

export type ApiRequestInit = RequestInit & {
  refreshOnUnauthorized?: boolean;
};

export type ApiFetchMetadata<Schema extends z.ZodType> = {
  data: z.output<Schema>;
  response: Response;
  etag: string | null;
};

const CSRF_COOKIE = "openslate_csrf";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
type RefreshResult = "current" | "refreshed" | "rejected" | "unavailable";
type BrowserLocks = {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T>;
};

type ActivityRenewal = { userId: string; signal: AbortSignal };
let refreshInFlight: {
  promise: Promise<RefreshResult>;
  activity: ActivityRenewal | undefined;
} | null = null;

function isErrorDetail(
  value: unknown,
): value is { code?: unknown; message?: unknown; blockers?: unknown } {
  return typeof value === "object" && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessages(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (isRecord(item) && typeof item.message === "string") {
      return [item.message];
    }
    return [];
  });
}

export function getApiFieldErrors(error: unknown): ApiFieldErrors {
  if (!(error instanceof ApiError) || !isRecord(error.details)) return {};
  const rawErrors = error.details.errors;
  if (Array.isArray(rawErrors)) {
    const fieldErrors: ApiFieldErrors = {};
    for (const item of rawErrors) {
      if (
        !isRecord(item) ||
        typeof item.field_id !== "string" ||
        typeof item.message !== "string"
      ) {
        continue;
      }
      (fieldErrors[item.field_id] ??= []).push(item.message);
    }
    return fieldErrors;
  }
  if (!isRecord(rawErrors)) return {};
  return Object.fromEntries(
    Object.entries(rawErrors)
      .map(([fieldId, messages]) => [fieldId, errorMessages(messages)] as const)
      .filter(([, messages]) => messages.length > 0),
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function csrfToken(): string | null {
  if (typeof document === "undefined") return null;
  for (const segment of document.cookie.split(";")) {
    const [name, ...value] = segment.trim().split("=");
    if (name !== CSRF_COOKIE) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

function requestHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (UNSAFE_METHODS.has(method)) {
    const token = csrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }
  // Each tab works in one organization; without it the session's active
  // organization applies.
  const organization = currentOrganizationId();
  if (organization && !headers.has("X-Org")) headers.set("X-Org", organization);
  return headers;
}

/**
 * Forgets a shared refresh started for the previous account or organization,
 * so later work starts its own session check.
 */
export function resetBrowserSessionRefresh(): void {
  refreshInFlight = null;
}

function navigateToLogin(): void {
  // This module deliberately has no Next router dependency so feature adapters
  // can use it directly. The current protected shell is discarded after a
  // confirmed unusable session.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  if (typeof window !== "undefined") window.location.href = "/login";
}

async function sendApiRequest(
  path: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: requestHeaders(init),
  });
}

async function checkedSession(activity?: ActivityRenewal): Promise<unknown> {
  const response = await sendApiRequest("/auth/session", {
    cache: "no-store",
    signal: activity?.signal,
  });
  if (!response.ok) {
    if (activity) throw new Error("Session verification unavailable");
    return null;
  }
  try {
    return await response.json();
  } catch {
    if (activity) throw new Error("Session verification unavailable");
    return null;
  }
}

async function refreshAfterSessionRecheck(
  activity?: ActivityRenewal,
): Promise<RefreshResult> {
  try {
    if (activity?.signal.aborted) return "rejected";
    const current = await checkedSession(activity);
    const authenticated = isRecord(current) && current.authenticated === true;
    if (activity) {
      // A returning tab must verify its new cookie identity through AppPage.
      // Input from an older workspace never renews another account.
      if (
        !authenticated ||
        current.user_id !== activity.userId ||
        current.setup_required !== false ||
        activity.signal.aborted
      )
        return "rejected";
    } else if (authenticated) return "current";
    const refresh = await sendApiRequest("/auth/refresh", {
      method: "POST",
      cache: "no-store",
      signal: activity?.signal,
    });
    if (refresh.ok) return "refreshed";
    return refresh.status === 401 ? "rejected" : "unavailable";
  } catch {
    return "unavailable";
  }
}

function browserLocks(): BrowserLocks | null {
  if (typeof navigator === "undefined" || !("locks" in navigator)) return null;
  const locks = navigator.locks;
  return locks ? (locks as unknown as BrowserLocks) : null;
}

export async function refreshBrowserSession(
  activity?: ActivityRenewal,
): Promise<RefreshResult> {
  if (refreshInFlight) {
    const previous = refreshInFlight;
    const result = await previous.promise;
    if (activity?.signal.aborted) return "rejected";
    // Each mode keeps its own admission rules: a refused activity probe may
    // still leave a live session that reactive work can refresh. Conversely,
    // another account's work cannot replace this activity's identity check.
    if (
      (activity &&
        (previous.activity?.userId !== activity.userId ||
          previous.activity.signal.aborted)) ||
      (!activity && previous.activity)
    )
      return refreshBrowserSession(activity);
    return result;
  }
  const locks = browserLocks();
  const refresh = locks
    ? locks.request("openslate-auth-refresh", { mode: "exclusive" }, () =>
        refreshAfterSessionRecheck(activity),
      )
    : refreshAfterSessionRecheck(activity);
  const current = { promise: refresh, activity };
  refreshInFlight = current;
  try {
    return await refresh;
  } finally {
    if (refreshInFlight === current) refreshInFlight = null;
  }
}

export async function apiRequest(
  path: string,
  init: ApiRequestInit = {},
): Promise<Response> {
  const { refreshOnUnauthorized = true, ...requestInit } = init;
  const response = await sendApiRequest(path, requestInit);
  if (
    response.status !== 401 ||
    !refreshOnUnauthorized ||
    path === "/auth/refresh" ||
    requestInit.signal?.aborted
  ) {
    return response;
  }

  const refreshed = await refreshBrowserSession();
  if (refreshed !== "current" && refreshed !== "refreshed") {
    if (!requestInit.signal?.aborted) navigateToLogin();
    return response;
  }
  if (response.body) void response.body.cancel().catch(() => undefined);
  return sendApiRequest(path, requestInit);
}

async function parseResponse(
  response: Response,
  signal?: AbortSignal | null,
): Promise<unknown> {
  if (response.status === 204 && response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (
      isAbortError(error) ||
      signal?.aborted ||
      !(error instanceof SyntaxError)
    )
      throw error;
    if (response.ok) throw safeApiContractError();
    body = null;
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? body.detail
        : "Request could not be completed";
    const errorDetail = isErrorDetail(detail) ? detail : undefined;
    const retryHeader = response.headers.get("Retry-After")?.trim();
    const retryAfter =
      retryHeader && /^\d+$/.test(retryHeader)
        ? Number(retryHeader)
        : undefined;
    throw new ApiError(
      response.status,
      typeof detail === "string"
        ? detail
        : typeof errorDetail?.message === "string"
          ? errorDetail.message
          : "Request could not be completed",
      detail,
      typeof errorDetail?.code === "string" ? errorDetail.code : undefined,
      retryAfter !== undefined && Number.isSafeInteger(retryAfter)
        ? retryAfter
        : undefined,
    );
  }
  return body;
}

export async function apiFetchWithMetadata<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: ApiRequestInit = {},
): Promise<ApiFetchMetadata<Schema>> {
  const { refreshOnUnauthorized, ...requestInit } = init;
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const response = await apiRequest(path, {
    ...requestInit,
    refreshOnUnauthorized,
    headers,
  });
  try {
    const body = await parseResponse(response, init.signal);
    try {
      const result = schema.safeParse(body);
      if (!result.success) throw safeApiContractError();
      return {
        data: result.data,
        response,
        etag: response.headers.get("ETag"),
      };
    } catch (error) {
      if (error instanceof ApiContractError) throw error;
      throw safeApiContractError();
    }
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 401 &&
      init.refreshOnUnauthorized !== false &&
      !init.signal?.aborted
    ) {
      navigateToLogin();
      throw error;
    }
    throw error;
  }
}

export async function apiFetch<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: ApiRequestInit = {},
): Promise<z.output<Schema>> {
  return (await apiFetchWithMetadata(path, schema, init)).data;
}
