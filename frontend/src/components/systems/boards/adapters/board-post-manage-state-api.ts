import { z } from "zod";
import { ApiContractError, apiFetch } from "@/lib/api";

const uuid = z.string().uuid();
const response = z
  .object({
    id: uuid,
    status: z.enum(["draft", "scheduled", "published", "archived"]),
    board_revision: z.number().int().min(1),
    post_revision: z.number().int().min(1),
    published_before: z.boolean(),
  })
  .strict()
  .transform(
    ({ board_revision, post_revision, published_before, ...item }) => ({
      ...item,
      boardRevision: board_revision,
      postRevision: post_revision,
      publishedBefore: published_before,
    }),
  );

export type BoardPostManageState = z.output<typeof response>;

export async function getBoardPostManageState(
  rawBoardId: string,
  rawPostId: string,
): Promise<BoardPostManageState> {
  const boardId = uuid.parse(rawBoardId);
  const postId = uuid.parse(rawPostId);
  const state = await apiFetch(
    `/boards/${boardId}/posts/${postId}/manage-state`,
    response,
    { cache: "no-store" },
  );
  if (state.id !== postId) throw new ApiContractError();
  return state;
}
