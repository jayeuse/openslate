import { z } from "zod";
import { ApiContractError, ApiError, apiFetch } from "@/lib/api";

const uuid = z.string().uuid();
const publicationNumber = z.number().int().min(1);
const stateSchema = z
  .object({
    announcement_id: uuid,
    publication_number: publicationNumber,
    read: z.boolean(),
    bookmarked: z.boolean(),
  })
  .strict()
  .transform(({ announcement_id, publication_number, ...flags }) => ({
    announcementId: announcement_id,
    publicationNumber: publication_number,
    ...flags,
  }));
const idsSchema = z
  .array(uuid)
  .min(1)
  .max(25)
  .refine((ids) => new Set(ids).size === ids.length);

export type BoardAnnouncementPersonalState = z.output<typeof stateSchema>;

function safePersonalError(error: ApiError): never {
  const parsed = z
    .object({ code: z.string() })
    .passthrough()
    .safeParse(error.details);
  const code = parsed.success ? parsed.data.code : null;
  if (error.status === 409 && code === "stale_publication")
    throw new ApiError(
      409,
      "Published announcement changed. Refresh before saving.",
      {
        code,
      },
      code,
    );
  if (error.status === 409 && code === "announcement_personal_conflict")
    throw new ApiError(
      409,
      "Announcement state changed. Refresh before saving.",
      {
        code,
      },
      code,
    );
  throw new ApiError(error.status, "Request could not be completed");
}

async function personalJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: RequestInit = {},
): Promise<z.output<Schema>> {
  try {
    return await apiFetch(path, schema, { cache: "no-store", ...init });
  } catch (error) {
    if (error instanceof ApiError) return safePersonalError(error);
    throw error;
  }
}

function itemPath(boardId: string, announcementId: string): string {
  return `/boards/${uuid.parse(boardId)}/announcements/${uuid.parse(announcementId)}/personal`;
}

export async function listBoardAnnouncementPersonal(
  rawBoardId: string,
  rawAnnouncementIds: string[],
): Promise<BoardAnnouncementPersonalState[]> {
  const boardId = uuid.parse(rawBoardId);
  const announcementIds = idsSchema.parse(rawAnnouncementIds);
  const query = new URLSearchParams();
  for (const id of announcementIds) query.append("announcement_id", id);
  const states = await personalJson(
    `/boards/${boardId}/announcement-personal?${query}`,
    z.array(stateSchema).min(1).max(25),
  );
  if (
    states.length !== announcementIds.length ||
    states.some(
      (state, index) => state.announcementId !== announcementIds[index],
    )
  )
    throw new ApiContractError();
  return states;
}

export async function putBoardAnnouncementRead(
  boardId: string,
  announcementId: string,
  rawPublicationNumber: number,
  rawRead: boolean,
): Promise<BoardAnnouncementPersonalState> {
  const number = publicationNumber.parse(rawPublicationNumber);
  const read = z.boolean().parse(rawRead);
  const response = await personalJson(
    `${itemPath(boardId, announcementId)}/read`,
    stateSchema,
    {
      method: "PUT",
      body: JSON.stringify({ publication_number: number, read }),
    },
  );
  if (
    response.announcementId !== announcementId ||
    response.publicationNumber !== number
  )
    throw new ApiContractError();
  return response;
}

export async function putBoardAnnouncementBookmark(
  boardId: string,
  announcementId: string,
  rawPublicationNumber: number,
  rawBookmarked: boolean,
): Promise<BoardAnnouncementPersonalState> {
  const number = publicationNumber.parse(rawPublicationNumber);
  const bookmarked = z.boolean().parse(rawBookmarked);
  const response = await personalJson(
    `${itemPath(boardId, announcementId)}/bookmark`,
    stateSchema,
    {
      method: "PUT",
      body: JSON.stringify({ publication_number: number, bookmarked }),
    },
  );
  if (
    response.announcementId !== announcementId ||
    response.publicationNumber !== number
  )
    throw new ApiContractError();
  return response;
}
