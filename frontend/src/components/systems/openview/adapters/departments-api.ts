import { z } from "zod";
import { ApiContractError, apiFetch } from "@/lib/api";

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
export async function listOpenViewDepartments(
  signal?: AbortSignal,
): Promise<OpenViewDepartment[]> {
  const departments: OpenViewDepartment[] = [];
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = await apiFetch(
      `/departments?limit=100&offset=${offset}&sort_by=department_name&sort_order=asc&deleted=exclude`,
      pageSchema,
      { cache: "no-store", signal },
    );
    if (page.pagination.offset !== offset) throw new ApiContractError();
    departments.push(...page.items);
    if (!page.pagination.has_more || page.items.length === 0) break;
    offset += page.items.length;
  }
  return departments;
}
