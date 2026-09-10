import { ApiError, type BaseEntity, type FieldType } from "./api";

const NUMERIC_INPUT_PATTERN =
  /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$/;
export type QueryField = { field_id: string; expected_type: FieldType };
export type QueryFilter = QueryField & { operator: string; value: unknown };
export type QueryDefinition = {
  version: 1;
  columns: QueryField[];
  filters: QueryFilter[];
  sort: (QueryField & { direction: "asc" | "desc" })[];
  deleted: "exclude" | "include" | "only";
  search: string | null;
};
export type SavedView = BaseEntity & {
  module_id: string;
  owner_id: string;
  name: string;
  revision: number;
  visibility: "private" | "workspace";
  definition: QueryDefinition;
};
export function queryValue(
  type: string,
  operator: string,
  value: string,
): unknown {
  if (operator === "empty" || operator === "not_empty") return null;
  if (operator === "in") return value.split(",").map((item) => item.trim());
  if (type === "boolean") return value === "true";
  if (type === "number" || type === "int") {
    if (!NUMERIC_INPUT_PATTERN.test(value)) return value;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return value;
    return type === "int" && !Number.isSafeInteger(parsed) ? value : parsed;
  }
  return value;
}
export function queryOperators(type: string): string[] {
  const common = ["eq", "empty", "not_empty"];
  if (type === "text") return [...common, "contains", "prefix"];
  if (type === "select") return [...common, "in"];
  if (["number", "decimal", "int", "date", "datetime"].includes(type))
    return [...common, "lt", "lte", "gt", "gte"];
  return common;
}
export async function exportRecords(
  module_id: string,
  definition: QueryDefinition,
): Promise<Blob> {
  const response = await fetch("/bff/records/export", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ module_id, definition, limit: 25, offset: 0 }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail =
      body && typeof body === "object" && "detail" in body ? body.detail : null;
    const message =
      typeof detail === "string"
        ? detail
        : detail &&
            typeof detail === "object" &&
            "message" in detail &&
            typeof detail.message === "string"
          ? detail.message
          : "Export could not be completed";
    throw new ApiError(response.status, message);
  }
  return response.blob();
}
