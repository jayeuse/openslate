import type {
  OpenViewQueryDefinition,
  serializeOpenViewQueryDefinition,
} from "../../src/components/systems/openview/adapters/views-api";

// OpenView query definitions with no columns, filters, sort or search. A
// test passes only the fields it varies; the keys keep the order the API
// schema lists them in.

type WireQueryDefinition = ReturnType<typeof serializeOpenViewQueryDefinition>;

/** An empty query definition as the API sends it (`search_fields`). */
export function emptyWireQuery(
  fields: Partial<WireQueryDefinition> = {},
): WireQueryDefinition {
  return {
    version: 1,
    logic: "and",
    columns: [],
    filters: [],
    sort: [],
    deleted: "exclude",
    search: null,
    search_fields: [],
    ...fields,
  };
}

/** An empty parsed query definition (`searchFields`). */
export function emptyQuery(
  fields: Partial<OpenViewQueryDefinition> = {},
): OpenViewQueryDefinition {
  return {
    version: 1,
    logic: "and",
    columns: [],
    filters: [],
    sort: [],
    deleted: "exclude",
    search: null,
    searchFields: [],
    ...fields,
  };
}
