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
const listSchema = z
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

export type BoardDepartmentChoice = z.output<typeof departmentSchema>;

export async function listBoardDepartments(
  signal?: AbortSignal,
): Promise<BoardDepartmentChoice[]> {
  const all: BoardDepartmentChoice[] = [];
  let offset = 0;
  while (true) {
    const page = await apiFetch(
      `/departments?limit=100&offset=${offset}&sort_by=department_name&sort_order=asc&deleted=exclude`,
      listSchema,
      { cache: "no-store", signal },
    );
    if (page.pagination.offset !== offset || page.pagination.limit !== 100)
      throw new ApiContractError();
    all.push(...page.items);
    if (!page.pagination.has_more) return all;
    if (page.items.length === 0 || offset + page.items.length <= offset)
      throw new ApiContractError();
    offset += page.items.length;
  }
}
