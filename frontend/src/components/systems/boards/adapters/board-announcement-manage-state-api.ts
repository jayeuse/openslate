import { z } from "zod";
import { ApiContractError, apiFetch } from "@/lib/api";

const uuid = z.string().uuid();
const response = z
  .object({
    id: uuid,
    status: z.enum(["draft", "scheduled", "published", "archived"]),
    board_revision: z.number().int().min(1),
    announcement_revision: z.number().int().min(1),
  })
  .strict()
  .transform(({ board_revision, announcement_revision, ...item }) => ({
    ...item,
    boardRevision: board_revision,
    announcementRevision: announcement_revision,
  }));

export type BoardAnnouncementManageState = z.output<typeof response>;

export async function getBoardAnnouncementManageState(
  rawBoardId: string,
  rawAnnouncementId: string,
): Promise<BoardAnnouncementManageState> {
  const boardId = uuid.parse(rawBoardId);
  const announcementId = uuid.parse(rawAnnouncementId);
  const state = await apiFetch(
    `/boards/${boardId}/announcements/${announcementId}/manage-state`,
    response,
    { cache: "no-store" },
  );
  if (state.id !== announcementId) throw new ApiContractError();
  return state;
}
