// API wire bodies for mocks and fixtures. Each builder takes the fields a
// test varies and fills in the rest with the values most rows share; the keys
// keep the order the rows spelled them in.

/** A field of a data source (`/api/views/data-sources/<id>/fields`). */
export function wireField({
  id,
  module_id,
  name,
  type,
  required = false,
  position,
  config = {},
}: {
  id: string;
  module_id: string;
  name: string;
  type: string;
  required?: boolean;
  position: number;
  config?: Record<string, unknown>;
}) {
  return { id, module_id, name, type, required, position, config };
}

/** A Board as `/api/boards` returns it: an active project Board by default. */
export function wireBoard<Description extends string | null>({
  id,
  scope = "project",
  department_id = null,
  name,
  description,
  status = "active",
  revision = 1,
  level,
  created_at,
  updated_at,
}: {
  id: string;
  scope?: "project" | "department";
  department_id?: string | null;
  name: string;
  description: Description;
  status?: "active" | "archived";
  revision?: number;
  level: "read" | "write" | "manage";
  created_at: string;
  updated_at: string;
}) {
  return {
    id,
    scope,
    department_id,
    name,
    description,
    status,
    revision,
    level,
    created_at,
    updated_at,
  };
}
