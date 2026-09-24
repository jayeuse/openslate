import { z } from "zod";
import { ApiContractError, ApiError, apiFetch } from "@/lib/api";

const uuid = z.string().uuid();
const authorSchema = z
  .object({ id: uuid, label: z.string().min(1).max(100) })
  .strict();
const choicesSchema = z.array(authorSchema).max(500);
export type BoardAnnouncementAuthorChoice = z.infer<typeof authorSchema>;

export async function listBoardAnnouncementAuthors(
  rawBoardId: string,
): Promise<BoardAnnouncementAuthorChoice[]> {
  const boardId = uuid.parse(rawBoardId);
  let choices: BoardAnnouncementAuthorChoice[];
  try {
    choices = await apiFetch(
      `/boards/${boardId}/announcement-authors`,
      choicesSchema,
      { cache: "no-store" },
    );
  } catch (error) {
    if (error instanceof ApiError)
      throw new ApiError(error.status, "Author choices are unavailable");
    throw error;
  }
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length)
    throw new ApiContractError();
  return choices;
}
