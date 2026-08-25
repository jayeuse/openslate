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
  | "number"
  | "decimal"
  | "int"
  | "boolean"
  | "date"
  | "datetime"
  | "select";
export type Field = BaseEntity & {
  module_id: string;
  name: string;
  type: FieldType;
  required: boolean;
  position: number;
  config: Record<string, unknown>;
};
export type RecordEntity = BaseEntity & {
  module_id: string;
  data: Record<string, unknown>;
};
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
  ) {
    super(message);
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? body.detail
        : "Request could not be completed";
    throw new ApiError(
      response.status,
      typeof detail === "string" ? detail : "Request could not be completed",
      detail,
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
