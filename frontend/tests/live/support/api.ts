import { assertNoRedirect, validateLoopbackHttpOrigin } from "./preflight";
import { sanitizeEvidence } from "./sanitize";

export type LivePagination = Readonly<{
  limit: number;
  offset: number;
  count: number;
  total: number;
  has_more: boolean;
}>;

export type LiveListResponse<Item> = Readonly<{
  items: readonly Item[];
  pagination: LivePagination;
}>;

export type LiveBaseEntity = Readonly<{
  id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: string | null;
}>;

export type LiveDepartment = LiveBaseEntity &
  Readonly<{ department_name: string }>;

export type LiveAuditLog = Readonly<{
  id: string;
  created_at: string;
  performed_by: string | null;
  action: "create" | "update" | "delete";
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  request_id: string | null;
  request_method: string | null;
  request_path: string | null;
  actor_label: string | null;
  note: string | null;
}>;

export type LiveModule = LiveBaseEntity &
  Readonly<{
    department_id: string;
    module_name: string;
    is_schema_accepted: boolean;
  }>;

export type LiveFieldType =
  | "text"
  | "number"
  | "decimal"
  | "int"
  | "boolean"
  | "date"
  | "datetime"
  | "select"
  | "relationship";

export type LiveField = LiveBaseEntity &
  Readonly<{
    module_id: string;
    name: string;
    type: LiveFieldType;
    required: boolean;
    position: number;
    config: Readonly<Record<string, unknown>>;
    relationship_target_module_id: string | null;
    relationship_multiple_targets: boolean | null;
    relationship_multiple_sources: boolean | null;
  }>;

export type LiveRecord = LiveBaseEntity &
  Readonly<{
    module_id: string;
    data: Readonly<Record<string, unknown>>;
  }>;

export type LiveRelationship = LiveBaseEntity &
  Readonly<{
    field_id: string;
    source_record_id: string;
    target_record_id: string;
    visibility: "available" | "hidden";
    hidden_reasons: readonly string[];
  }>;

export type LiveRole = LiveBaseEntity &
  Readonly<{
    role: string;
    permissions: Readonly<Record<string, unknown>>;
  }>;

export type LiveUser = LiveBaseEntity &
  Readonly<{
    email: string;
    username: string;
    status: "pending" | "active" | "disabled";
    role_id: string;
  }>;

export type LiveQuery = Readonly<
  Record<string, string | number | boolean | undefined>
>;

export type LiveTransport = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type LiveResponseGuard<ResponseBody> = (
  value: unknown,
) => value is ResponseBody;

export class LiveApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly path: string,
  ) {
    super(String(sanitizeEvidence(message)));
    this.name = "LiveApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPagination(value: unknown): value is LivePagination {
  return (
    isRecord(value) &&
    typeof value.limit === "number" &&
    typeof value.offset === "number" &&
    typeof value.count === "number" &&
    typeof value.total === "number" &&
    typeof value.has_more === "boolean"
  );
}

function isListResponse<Item>(value: unknown): value is LiveListResponse<Item> {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    isPagination(value.pagination)
  );
}

function isBaseEntity(value: unknown): value is LiveBaseEntity {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    (value.deleted_at === null || typeof value.deleted_at === "string") &&
    typeof value.is_deleted === "boolean" &&
    (value.performed_by === null || typeof value.performed_by === "string")
  );
}

export function isLiveDepartment(value: unknown): value is LiveDepartment {
  if (!isRecord(value) || !isBaseEntity(value)) return false;
  const department = value as Record<string, unknown>;
  return typeof department.department_name === "string";
}

export function isLiveModule(value: unknown): value is LiveModule {
  if (!isRecord(value) || !isBaseEntity(value)) return false;
  const moduleValue = value as Record<string, unknown>;
  return (
    typeof moduleValue.department_id === "string" &&
    typeof moduleValue.module_name === "string" &&
    typeof moduleValue.is_schema_accepted === "boolean"
  );
}

export function isLiveField(value: unknown): value is LiveField {
  if (!isRecord(value) || !isBaseEntity(value)) return false;
  const field = value as Record<string, unknown>;
  return (
    typeof field.module_id === "string" &&
    typeof field.name === "string" &&
    typeof field.type === "string" &&
    [
      "text",
      "number",
      "decimal",
      "int",
      "boolean",
      "date",
      "datetime",
      "select",
      "relationship",
    ].includes(field.type) &&
    typeof field.required === "boolean" &&
    typeof field.position === "number" &&
    isRecord(field.config) &&
    (field.relationship_target_module_id === null ||
      typeof field.relationship_target_module_id === "string") &&
    (field.relationship_multiple_targets === null ||
      typeof field.relationship_multiple_targets === "boolean") &&
    (field.relationship_multiple_sources === null ||
      typeof field.relationship_multiple_sources === "boolean")
  );
}

export function isLiveAuditLog(value: unknown): value is LiveAuditLog {
  if (!isRecord(value)) return false;
  return (
    "before" in value &&
    "after" in value &&
    typeof value.id === "string" &&
    typeof value.created_at === "string" &&
    (value.performed_by === null || typeof value.performed_by === "string") &&
    (value.action === "create" ||
      value.action === "update" ||
      value.action === "delete") &&
    typeof value.entity_type === "string" &&
    (value.entity_id === null || typeof value.entity_id === "string") &&
    (value.request_id === null || typeof value.request_id === "string") &&
    (value.request_method === null ||
      typeof value.request_method === "string") &&
    (value.request_path === null || typeof value.request_path === "string") &&
    (value.actor_label === null || typeof value.actor_label === "string") &&
    (value.note === null || typeof value.note === "string")
  );
}

export function isLiveRecord(value: unknown): value is LiveRecord {
  if (!isRecord(value) || !isBaseEntity(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.module_id === "string" && isRecord(record.data);
}

export function isLiveRelationship(value: unknown): value is LiveRelationship {
  if (!isRecord(value) || !isBaseEntity(value)) return false;
  const record = value as Record<string, unknown>;
  const hiddenReasons = record.hidden_reasons;
  return (
    typeof record.field_id === "string" &&
    typeof record.source_record_id === "string" &&
    typeof record.target_record_id === "string" &&
    (record.visibility === "available" || record.visibility === "hidden") &&
    Array.isArray(hiddenReasons) &&
    hiddenReasons.every((reason: unknown) => typeof reason === "string")
  );
}

export function isLiveUser(value: unknown): value is LiveUser {
  if (!isRecord(value) || !isBaseEntity(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.email === "string" &&
    typeof record.username === "string" &&
    (record.status === "pending" ||
      record.status === "active" ||
      record.status === "disabled") &&
    typeof record.role_id === "string"
  );
}

export function isLiveRole(value: unknown): value is LiveRole {
  if (!isRecord(value) || !isBaseEntity(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.role === "string" && isRecord(record.permissions);
}

function apiPath(path: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//")) {
    return path;
  }
  if (path === "/api" || path.startsWith("/api/")) return path;
  return path.startsWith("/") ? `/api${path}` : `/api/${path}`;
}

function validateLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new LiveApiError(
      0,
      "Live API list limit must be between 1 and 100",
      "",
    );
  }
  return value;
}

function safeUrl(origin: string, path: string, query?: LiveQuery): URL {
  const validatedOrigin = validateLoopbackHttpOrigin(origin);
  let url: URL;
  try {
    url = new URL(apiPath(path), `${validatedOrigin}/`);
  } catch {
    throw new LiveApiError(0, "Live API path is invalid", path);
  }
  if (url.origin !== validatedOrigin || url.username || url.password) {
    throw new LiveApiError(0, "Live API path left the validated origin", path);
  }
  if (query) {
    if (typeof query.limit === "number") validateLimit(query.limit);
    if (
      typeof query.offset === "number" &&
      (!Number.isInteger(query.offset) || query.offset < 0)
    ) {
      throw new LiveApiError(0, "Live API list offset is invalid", path);
    }
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function responseMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (isRecord(body) && typeof body.detail === "string") return body.detail;
  return "Live API request failed";
}

export type LiveApiClient = Readonly<{
  get: <ResponseBody = unknown>(
    path: string,
    query?: LiveQuery,
    guard?: LiveResponseGuard<ResponseBody>,
  ) => Promise<ResponseBody>;
  list: <Item>(
    path: string,
    query?: LiveQuery,
    guard?: LiveResponseGuard<Item>,
  ) => Promise<LiveListResponse<Item>>;
  listAll: <Item>(
    path: string,
    query?: LiveQuery,
    maxPages?: number,
    guard?: LiveResponseGuard<Item>,
  ) => Promise<readonly Item[]>;
  post: <ResponseBody = unknown>(
    path: string,
    body: unknown,
    guard?: LiveResponseGuard<ResponseBody>,
  ) => Promise<ResponseBody>;
  put: <ResponseBody = unknown>(
    path: string,
    body: unknown,
    guard?: LiveResponseGuard<ResponseBody>,
  ) => Promise<ResponseBody>;
  patch: <ResponseBody = unknown>(
    path: string,
    body: unknown,
    guard?: LiveResponseGuard<ResponseBody>,
  ) => Promise<ResponseBody>;
  delete: <ResponseBody = null>(
    path: string,
    guard?: LiveResponseGuard<ResponseBody>,
  ) => Promise<ResponseBody>;
}>;

export function createLiveApiClient(
  origin: string,
  accessToken?: string,
  transport: LiveTransport = (url, init) => fetch(url, init),
): LiveApiClient {
  const validatedOrigin = validateLoopbackHttpOrigin(origin);

  async function request<ResponseBody>(
    method: string,
    path: string,
    body: unknown,
    query: LiveQuery | undefined,
    guard: LiveResponseGuard<ResponseBody> | undefined,
  ): Promise<ResponseBody> {
    const url = safeUrl(validatedOrigin, path, query);
    const headers = new Headers({ Accept: "application/json" });
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    const init: RequestInit = {
      method,
      headers,
      redirect: "error",
      credentials: "omit",
    };
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      try {
        init.body = JSON.stringify(body);
      } catch {
        throw new LiveApiError(0, "Live API request body is invalid", path);
      }
    }
    const response = await transport(url.toString(), init);
    assertNoRedirect(response.url || url.toString(), validatedOrigin);
    if (!response.ok) {
      throw new LiveApiError(
        response.status,
        await responseMessage(response),
        path,
      );
    }
    const value: unknown =
      response.status === 204 ? null : await response.json().catch(() => null);
    if (guard && !guard(value)) {
      throw new LiveApiError(
        0,
        "Live API returned an invalid response body",
        path,
      );
    }
    return value as ResponseBody;
  }

  async function get<ResponseBody = unknown>(
    path: string,
    query?: LiveQuery,
    guard?: LiveResponseGuard<ResponseBody>,
  ): Promise<ResponseBody> {
    return request("GET", path, undefined, query, guard);
  }

  async function list<Item>(
    path: string,
    query?: LiveQuery,
    guard?: LiveResponseGuard<Item>,
  ): Promise<LiveListResponse<Item>> {
    const value: unknown = await get<unknown>(path, query);
    if (!isListResponse<Item>(value)) {
      throw new LiveApiError(
        0,
        "Live API returned an invalid list response",
        path,
      );
    }
    if (guard && !value.items.every(guard)) {
      throw new LiveApiError(0, "Live API returned an invalid list item", path);
    }
    return value;
  }

  async function listAll<Item>(
    path: string,
    query: LiveQuery = {},
    maxPages = 1000,
    guard?: LiveResponseGuard<Item>,
  ): Promise<readonly Item[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new Error("maxPages must be a positive integer");
    }
    const items: Item[] = [];
    let offset = typeof query.offset === "number" ? query.offset : 0;
    const limit = validateLimit(
      typeof query.limit === "number" ? query.limit : 100,
    );
    for (let page = 0; page < maxPages; page += 1) {
      const response = await list<Item>(
        path,
        {
          ...query,
          limit,
          offset,
        },
        guard,
      );
      items.push(...response.items);
      if (!response.pagination.has_more) return items;
      const nextOffset = response.pagination.offset + response.pagination.count;
      if (nextOffset <= offset) {
        throw new LiveApiError(
          0,
          "Live API returned non-advancing pagination",
          path,
        );
      }
      offset = nextOffset;
    }
    throw new LiveApiError(
      0,
      "Live API exceeded the pagination safety limit",
      path,
    );
  }

  return {
    get,
    list,
    listAll,
    post: (path, body, guard) => request("POST", path, body, undefined, guard),
    put: (path, body, guard) => request("PUT", path, body, undefined, guard),
    patch: (path, body, guard) =>
      request("PATCH", path, body, undefined, guard),
    delete: (path, guard) =>
      request("DELETE", path, undefined, undefined, guard),
  };
}
