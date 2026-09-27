import { z } from "zod";
import { ApiContractError, apiFetch } from "@/lib/api";

const uuid = z.string().uuid();
const kindSchema = z.enum(["user", "department"]);
const choiceSchema = z
  .object({ id: uuid, label: z.string().min(1).max(150) })
  .strict();
const pageSchema = z
  .object({
    items: z.array(choiceSchema).max(100),
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
  .strict();

export type BoardContentAudienceKind = z.infer<typeof kindSchema>;
export type BoardContentAudienceChoice = z.infer<typeof choiceSchema>;

export async function listBoardContentAudienceTargets(
  rawBoardId: string,
  rawKind: BoardContentAudienceKind,
  rawSearch: string,
  rawOffset = 0,
): Promise<{ items: BoardContentAudienceChoice[]; hasMore: boolean }> {
  const boardId = uuid.parse(rawBoardId);
  const kind = kindSchema.parse(rawKind);
  const search = z.string().max(100).parse(rawSearch.trim());
  const offset = z.number().int().min(0).parse(rawOffset);
  const query = new URLSearchParams({
    kind,
    search,
    limit: "25",
    offset: String(offset),
  });
  const page = await apiFetch(
    `/boards/${boardId}/content-audience-targets?${query}`,
    pageSchema,
    { cache: "no-store" },
  );
  if (
    page.pagination.limit !== 25 ||
    page.pagination.offset !== offset ||
    page.pagination.count !== page.items.length ||
    page.pagination.total < offset + page.items.length ||
    new Set(page.items.map((item) => item.id)).size !== page.items.length
  )
    throw new ApiContractError();
  return { items: page.items, hasMore: page.pagination.has_more };
}
