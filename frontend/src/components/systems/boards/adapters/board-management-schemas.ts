import { z } from "zod";
export const uuidSchema = z.string().uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const named = (limit: number) =>
  z
    .string()
    .min(1)
    .max(limit)
    .refine((value) => value.trim().length > 0);
export const boardScopeSchema = z.enum(["company", "department", "project"]);
export const accessLevelSchema = z.enum(["read", "write", "manage"]);
export const boardSchema = z
  .object({
    id: uuidSchema,
    scope: boardScopeSchema,
    department_id: uuidSchema.nullable(),
    name: named(200),
    description: z.string().nullable(),
    status: z.enum(["active", "archived"]),
    revision: z.number().int().min(1),
    level: accessLevelSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .refine(
    (board) =>
      (board.scope === "department") === (board.department_id !== null),
  )
  .transform((board) => ({
    id: board.id,
    scope: board.scope,
    departmentId: board.department_id,
    name: board.name,
    description: board.description,
    status: board.status,
    revision: board.revision,
    level: board.level,
    createdAt: board.created_at,
    updatedAt: board.updated_at,
  }));
const paginationSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict()
  .refine(({ count, limit }) => count <= limit)
  .transform(({ has_more, ...page }) => ({ ...page, hasMore: has_more }));
export const boardListSchema = z
  .object({ items: z.array(boardSchema), pagination: paginationSchema })
  .strict()
  .refine(({ items, pagination }) => items.length === pagination.count);
export const boardListOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    sortBy: z.enum(["name", "created_at", "updated_at"]).default("name"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
    status: z.enum(["active", "archived", "all"]).default("active"),
    search: z.string().trim().min(1).max(100).optional(),
    scope: boardScopeSchema.optional(),
    departmentId: uuidSchema.optional(),
  })
  .strict();
export const boardCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().nullable().optional(),
  })
  .strict();
export const revisionSchema = z.number().int().min(1);
export const boardUpdateSchema = boardCreateSchema
  .partial()
  .extend({ revision: revisionSchema })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "revision"));

export type BoardManagementBoard = z.output<typeof boardSchema>;
export type BoardManagementPage = z.output<typeof boardListSchema>;
export type BoardListOptions = z.input<typeof boardListOptionsSchema>;
export type BoardCreateInput = z.input<typeof boardCreateSchema>;
export type BoardUpdateInput = z.input<typeof boardUpdateSchema>;
export type BoardScope = z.output<typeof boardScopeSchema>;
export type BoardAccessLevel = z.output<typeof accessLevelSchema>;
export const boardGroupsSchema = z
  .object({
    board_id: uuidSchema,
    revision: z.number().int().min(1),
    groups: z
      .array(
        z
          .object({
            group_id: uuidSchema,
            name: z.string().min(1).max(200),
            level: accessLevelSchema,
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .transform((value) => ({
    boardId: value.board_id,
    revision: value.revision,
    groups: value.groups.map((group) => ({
      groupId: group.group_id,
      name: group.name,
      level: group.level,
    })),
  }));
export const boardGroupsInputSchema = z
  .object({
    revision: revisionSchema,
    groups: z
      .array(
        z.object({ groupId: uuidSchema, level: accessLevelSchema }).strict(),
      )
      .max(100)
      .refine(
        (groups) =>
          new Set(groups.map((group) => group.groupId)).size === groups.length,
      ),
  })
  .strict();
export type BoardGroups = z.output<typeof boardGroupsSchema>;
export type BoardGroupsInput = z.input<typeof boardGroupsInputSchema>;
