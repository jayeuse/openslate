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

/** A record as the records APIs return it: live, with no display values. */
export function wireRecord<Data extends Record<string, unknown>>({
  id,
  module_id,
  data,
  display_values = {},
  created_at,
  updated_at,
  deleted_at = null,
  is_deleted = false,
  performed_by = null,
}: {
  id: string;
  module_id: string;
  data: Data;
  display_values?: Record<string, string>;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  is_deleted?: boolean;
  performed_by?: string | null;
}) {
  return {
    id,
    module_id,
    data,
    display_values,
    created_at,
    updated_at,
    deleted_at,
    is_deleted,
    performed_by,
  };
}

/**
 * The organization as `/api/workspace` returns it: "OpenSlate" with no
 * contact details, a Monday week and the Slate theme by default.
 */
export function wireWorkspace({
  id,
  display_name = "OpenSlate",
  legal_name = null,
  description = null,
  contact_email = null,
  contact_phone = null,
  postal_address = null,
  logo_file_id = null,
  locale,
  timezone,
  mark = "OS",
  currency,
  week_start = "monday",
  business_hours = "09:00–18:00",
  theme = "slate",
  revision = 1,
  today,
  purge_enabled,
}: {
  id: string;
  display_name?: string;
  legal_name?: string | null;
  description?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  postal_address?: string | null;
  logo_file_id?: string | null;
  locale: string;
  timezone: string;
  mark?: string;
  currency: string;
  week_start?: "monday" | "sunday";
  business_hours?: string;
  theme?: string;
  revision?: number;
  today: string;
  purge_enabled: boolean;
}) {
  return {
    id,
    display_name,
    legal_name,
    description,
    contact_email,
    contact_phone,
    postal_address,
    logo_file_id,
    locale,
    timezone,
    mark,
    currency,
    week_start,
    business_hours,
    theme,
    revision,
    today,
    purge_enabled,
  };
}

/** A saved view with the definition/presentation-first wire key order. */
export function wireView<
  Definition extends Record<string, unknown>,
  Presentation extends Record<string, unknown>,
>({
  id,
  module_id,
  name,
  is_default = false,
  definition,
  presentation,
  revision = 1,
  is_deleted = false,
  can_edit = true,
  created_at,
  updated_at,
}: {
  id: string;
  module_id: string;
  name: string;
  is_default?: boolean;
  definition: Definition;
  presentation: Presentation;
  revision?: number;
  is_deleted?: boolean;
  can_edit?: boolean;
  created_at: string;
  updated_at: string;
}) {
  return {
    id,
    module_id,
    name,
    is_default,
    definition,
    presentation,
    revision,
    is_deleted,
    can_edit,
    created_at,
    updated_at,
  };
}

/** An aggregate bucket; date/identity labels default to their exact key. */
export function wireBucket({
  key,
  label = key,
  value,
  record_count,
}: {
  key: string | null;
  label?: string | null;
  value: string | number | null | undefined;
  record_count: number;
}) {
  return { key, label, value, record_count };
}
