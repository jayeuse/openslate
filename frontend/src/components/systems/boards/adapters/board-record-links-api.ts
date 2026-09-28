import { z } from "zod";
import { ApiContractError, apiFetch } from "@/lib/api";
import type { BoardAttachmentVersions } from "./board-files-api";

const uuid = z.string().uuid();
const linkSchema = z
  .object({
    id: uuid,
    record_id: uuid,
    module_id: uuid,
    label: z.string().min(1).max(100),
    available: z.boolean(),
    url: z.string().nullable(),
  })
  .strict()
  .superRefine((link, context) => {
    const expected = `/openview?module=${link.module_id}&record=${link.record_id}`;
    if (link.url !== (link.available ? expected : null))
      context.addIssue({
        code: "custom",
        message: "Invalid Board record link URL",
      });
  })
  .transform(({ record_id, module_id, ...link }) => ({
    ...link,
    recordId: record_id,
    moduleId: module_id,
  }));
const pageSchema = z
  .object({
    items: z.array(linkSchema).max(20),
    limit: z.literal(20),
    offset: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict();

export type BoardRecordLink = z.output<typeof linkSchema>;
export type BoardRecordLinkTarget =
  | { kind: "event"; boardId: string; contentId: string }
  | {
      kind: "post";
      boardId: string;
      contentId: string;
      view: "draft" | "published";
    };
export type BoardEditableRecordLinkTarget =
  | { kind: "event"; boardId: string; contentId: string }
  | { kind: "post"; boardId: string; contentId: string; view: "draft" };

function path(target: BoardRecordLinkTarget): string {
  const boardId = uuid.parse(target.boardId);
  const contentId = uuid.parse(target.contentId);
  return `/boards/${boardId}/${target.kind === "event" ? "events" : "posts"}/${contentId}/record-links`;
}

export async function listBoardRecordLinks(
  target: BoardRecordLinkTarget,
  offset = 0,
): Promise<{ items: BoardRecordLink[]; hasMore: boolean }> {
  const requestedOffset = z.number().int().min(0).parse(offset);
  const view = target.kind === "post" ? `&view=${target.view}` : "";
  const page = await apiFetch(
    `${path(target)}?limit=20&offset=${requestedOffset}${view}`,
    pageSchema,
    { cache: "no-store" },
  );
  if (page.offset !== requestedOffset) throw new ApiContractError();
  return { items: page.items, hasMore: page.has_more };
}

export async function addBoardRecordLink(
  target: BoardEditableRecordLinkTarget,
  rawRecordId: string,
  versions: BoardAttachmentVersions,
): Promise<BoardRecordLink> {
  const recordId = uuid.parse(rawRecordId);
  const link = await apiFetch(path(target), linkSchema, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({
      record_id: recordId,
      board_revision: versions.boardRevision,
      content_revision: versions.contentRevision,
    }),
  });
  if (link.recordId !== recordId) throw new ApiContractError();
  return link;
}

export async function removeBoardRecordLink(
  target: BoardEditableRecordLinkTarget,
  rawLinkId: string,
  versions: BoardAttachmentVersions,
): Promise<void> {
  const linkId = uuid.parse(rawLinkId);
  await apiFetch(`${path(target)}/${linkId}`, z.null(), {
    method: "DELETE",
    cache: "no-store",
    body: JSON.stringify({
      board_revision: versions.boardRevision,
      content_revision: versions.contentRevision,
    }),
  });
}
