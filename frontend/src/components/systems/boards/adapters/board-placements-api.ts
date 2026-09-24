import { z } from "zod";
import {
  ApiContractError,
  ApiError,
  apiFetch,
  type ApiRequestInit,
} from "@/lib/api";

const uuidSchema = z.string().uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const revisionSchema = z.number().int().min(1);
const placementSchema = z
  .object({
    id: uuidSchema,
    board_id: uuidSchema,
    record_id: uuidSchema,
    module_id: uuidSchema.nullable(),
    available: z.boolean(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .refine(({ available, module_id }) => available === (module_id !== null))
  .transform(
    ({
      board_id,
      record_id,
      module_id,
      created_at,
      updated_at,
      ...placement
    }) => ({
      ...placement,
      boardId: board_id,
      recordId: record_id,
      moduleId: module_id,
      createdAt: created_at,
      updatedAt: updated_at,
    }),
  );
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
const listSchema = z
  .object({
    items: z.array(placementSchema),
    pagination: paginationSchema,
    board_revision: revisionSchema,
  })
  .strict()
  .refine(({ items, pagination }) => items.length === pagination.count)
  .transform(({ board_revision, ...page }) => ({
    ...page,
    boardRevision: board_revision,
  }));
const mutationSchema = z
  .object({ placement: placementSchema, board_revision: revisionSchema })
  .strict()
  .transform(({ board_revision, ...result }) => ({
    ...result,
    boardRevision: board_revision,
  }));
const listOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    sortBy: z.enum(["created_at", "updated_at"]).default("created_at"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();

export type BoardPlacement = z.output<typeof placementSchema>;
export type BoardPlacementPage = z.output<typeof listSchema>;
export type BoardPlacementMutation = z.output<typeof mutationSchema>;
export type BoardPlacementListOptions = z.input<typeof listOptionsSchema>;

const safeCodes: Record<string, string> = {
  stale_revision: "Board changed; reload before saving",
  board_archived: "Restore the Board before changing shortcuts",
  record_unavailable: "The selected record is unavailable",
  placement_exists: "This record is already linked to the Board",
  placement_invalid: "The record shortcut could not be saved",
};

function throwSafePlacementError(error: ApiError): never {
  const detail = error.details;
  if (
    error.status === 404 &&
    (detail === "Board not found" || detail === "Board placement not found")
  ) {
    throw new ApiError(404, detail);
  }
  const parsed = z.object({ code: z.string() }).passthrough().safeParse(detail);
  if (error.status === 409 && parsed.success) {
    const message = Object.hasOwn(safeCodes, parsed.data.code)
      ? safeCodes[parsed.data.code]
      : undefined;
    if (message) {
      throw new ApiError(
        409,
        message,
        { code: parsed.data.code, message },
        parsed.data.code,
      );
    }
  }
  throw new ApiError(error.status, "Request could not be completed");
}

async function safePlacementJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: ApiRequestInit = {},
): Promise<z.output<Schema>> {
  try {
    return await apiFetch(path, schema, { cache: "no-store", ...init });
  } catch (error) {
    if (error instanceof ApiError) return throwSafePlacementError(error);
    throw error;
  }
}

function queryString(values: Record<string, string | number>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    query.set(key, String(value));
  return query.toString();
}

function placementsPath(boardId: string): string {
  return `/boards/${encodeURIComponent(boardId)}/placements`;
}

export async function listBoardPlacements(
  rawBoardId: string,
  rawOptions: BoardPlacementListOptions = {},
): Promise<BoardPlacementPage> {
  const boardId = uuidSchema.parse(rawBoardId);
  const options = listOptionsSchema.parse(rawOptions);
  const page = await safePlacementJson(
    `${placementsPath(boardId)}?${queryString({
      limit: options.limit,
      offset: options.offset,
      sort_by: options.sortBy,
      sort_order: options.sortOrder,
    })}`,
    listSchema,
  );
  if (page.items.some((placement) => placement.boardId !== boardId))
    throw new ApiContractError();
  return page;
}

export async function createBoardPlacement(
  rawBoardId: string,
  rawRevision: number,
  rawRecordId: string,
): Promise<BoardPlacementMutation> {
  const boardId = uuidSchema.parse(rawBoardId);
  const revision = revisionSchema.parse(rawRevision);
  const recordId = uuidSchema.parse(rawRecordId);
  const created = await safePlacementJson(
    placementsPath(boardId),
    mutationSchema,
    {
      method: "POST",
      body: JSON.stringify({ revision, record_id: recordId }),
    },
  );
  if (
    created.placement.boardId !== boardId ||
    created.placement.recordId !== recordId
  )
    throw new ApiContractError();
  return created;
}

export async function deleteBoardPlacement(
  rawBoardId: string,
  rawPlacementId: string,
  rawRevision: number,
): Promise<void> {
  const boardId = uuidSchema.parse(rawBoardId);
  const placementId = uuidSchema.parse(rawPlacementId);
  const revision = revisionSchema.parse(rawRevision);
  await safePlacementJson(
    `${placementsPath(boardId)}/${encodeURIComponent(placementId)}?${queryString({ revision })}`,
    z.null(),
    { method: "DELETE" },
  );
}
