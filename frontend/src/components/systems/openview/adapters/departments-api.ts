import { z } from "zod";
import { apiFetch } from "@/lib/api";

const uuid = z.string().uuid();
const timestamp = z.iso.datetime({ offset: true });
const departmentSchema = z
  .object({
    id: uuid,
    department_name: z.string().trim().min(1).max(150),
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: timestamp.nullable(),
    is_deleted: z.literal(false),
    performed_by: uuid.nullable(),
  })
  .strict()
  .transform(({ id, department_name }) => ({ id, name: department_name }));
const pageSchema = z
  .object({
    items: z.array(departmentSchema),
    pagination: z
      .object({
        limit: z.number().int().min(1).max(100),
        offset: z.number().int().min(0),
        count: z.number().int().min(0),
        total: z.number().int().min(0),
        has_more: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .refine(({ items, pagination }) => items.length === pagination.count);

/** A department the signed-in user can read something in. */
export type OpenViewDepartment = z.output<typeof departmentSchema>;

/**
 * Lists the departments the user can read, which own Dashboards, and name the
 * department of each data source. The server returns only readable ones.
 */
export function listOpenViewDepartments(
  options: {
    limit?: number;
    offset?: number;
    search?: string;
    /** "created" is the Sandbox order: department ids are time-ordered. */
    order?: "name" | "created";
    signal?: AbortSignal;
  } = {},
) {
  const query = new URLSearchParams({
    limit: String(options.limit ?? 100),
    offset: String(options.offset ?? 0),
    sort_by: options.order === "created" ? "created_at" : "department_name",
    sort_order: "asc",
    deleted: "exclude",
  });
  if (options.search?.trim()) query.set("search", options.search.trim());
  return apiFetch(
    `/departments?${query}`,
    pageSchema.transform(({ items, pagination }) => ({
      items,
      pagination: { ...pagination, hasMore: pagination.has_more },
    })),
    { cache: "no-store", signal: options.signal },
  );
}

export function getOpenViewDepartment(
  id: string,
  signal?: AbortSignal,
): Promise<OpenViewDepartment> {
  return apiFetch(
    `/departments/${encodeURIComponent(uuid.parse(id))}`,
    departmentSchema.refine((item) => item.id === id),
    { cache: "no-store", signal },
  );
}
