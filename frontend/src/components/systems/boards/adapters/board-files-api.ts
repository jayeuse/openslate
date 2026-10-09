import { z } from "zod";
import { ApiContractError, apiFetch, apiRequest } from "@/lib/api";
import {
  assertLifecyclePurgePreviewFor,
  lifecyclePurgeInputSchema,
  lifecyclePurgePreviewSchema,
  type LifecyclePurgeInput,
} from "@/lib/lifecycle";
import {
  fileDetails,
  fileWireSchema,
  MAX_FILE_BYTES,
  requestFileContent,
  reserveFile,
  throwFileRequestError,
  uploadFileContent,
} from "../../shared/adapters/files-api";

export const MAX_BOARD_ATTACHMENT_BYTES = MAX_FILE_BYTES;

const uuid = z.string().uuid();
const BOARD_FILE_REQUEST_ERROR = "Board file request could not be completed";
const fileWire = fileWireSchema
  .extend({
    purpose: z.literal("board_attachment"),
    record_id: z.null(),
    department_id: z.null(),
    board_id: uuid,
    is_deleted: z.literal(false),
  })
  .transform((file) => ({
    ...fileDetails(file),
    boardId: file.board_id,
  }));
const attachmentListWire = z
  .object({
    items: z.array(fileWire),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict()
  .transform(({ items, has_more, ...page }) => ({
    items,
    ...page,
    hasMore: has_more,
  }));
const listOptions = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
const revisions = z
  .object({
    boardRevision: z.number().int().min(1),
    contentRevision: z.number().int().min(1),
  })
  .strict();

export type BoardAttachmentFile = z.output<typeof fileWire>;
export type BoardAttachmentPage = z.output<typeof attachmentListWire>;
export type BoardAttachmentVersions = z.output<typeof revisions>;
export type BoardAttachmentTarget =
  | { kind: "event"; boardId: string; contentId: string }
  | {
      kind: "post";
      boardId: string;
      contentId: string;
      view: "published" | "draft";
    };
export type BoardAttachmentListOptions = z.input<typeof listOptions> & {
  signal?: AbortSignal;
};

function ids(target: BoardAttachmentTarget) {
  const boardId = uuid.parse(target.boardId);
  const contentId = uuid.parse(target.contentId);
  return { boardId, contentId };
}

function contentPath(target: BoardAttachmentTarget): string {
  const { boardId, contentId } = ids(target);
  return target.kind === "event"
    ? `/boards/${boardId}/events/${contentId}/attachments`
    : `/boards/${boardId}/posts/${contentId}/attachments`;
}

function checkedFile(
  file: BoardAttachmentFile,
  boardId: string,
): BoardAttachmentFile {
  if (file.boardId !== boardId) throw new ApiContractError();
  return file;
}

function checkWritableTarget(target: BoardAttachmentTarget): void {
  if (target.kind === "post" && target.view !== "draft")
    throw new ApiContractError();
}

async function throwRequestError(response: Response): Promise<never> {
  return throwFileRequestError(response, BOARD_FILE_REQUEST_ERROR);
}

export async function reserveBoardFile(
  rawBoardId: string,
  rawInput: { filename: string; expectedSize: number },
): Promise<BoardAttachmentFile> {
  const boardId = uuid.parse(rawBoardId);
  const result = await reserveFile(rawInput, (body) =>
    apiFetch(`/boards/${boardId}/files`, fileWire, {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(body),
    }),
  );
  if (result.boardId !== boardId) throw new ApiContractError();
  return checkedFile(result, boardId);
}

export async function uploadBoardFile(
  rawBoardId: string,
  rawFileId: string,
  content: Blob,
  signal?: AbortSignal,
): Promise<BoardAttachmentFile> {
  const boardId = uuid.parse(rawBoardId);
  const fileId = uuid.parse(rawFileId);
  const result = await uploadFileContent(
    fileId,
    content,
    fileWire,
    async () => {
      const response = await apiRequest(
        `/boards/${boardId}/files/${fileId}/content`,
        {
          method: "PUT",
          cache: "no-store",
          body: content,
          headers: { "Content-Type": "application/octet-stream" },
          signal,
        },
      );
      if (!response.ok) return throwRequestError(response);
      return response;
    },
    signal,
  );
  return checkedFile(result, boardId);
}

export async function listBoardAttachments(
  target: BoardAttachmentTarget,
  rawOptions: BoardAttachmentListOptions = {},
): Promise<BoardAttachmentPage> {
  const { boardId } = ids(target);
  const { signal, ...optionInput } = rawOptions;
  const options = listOptions.parse(optionInput);
  const query = new URLSearchParams();
  if (target.kind === "post") query.set("view", target.view);
  query.set("limit", String(options.limit));
  query.set("offset", String(options.offset));
  const page = await apiFetch(
    `${contentPath(target)}?${query.toString()}`,
    attachmentListWire,
    { cache: "no-store", signal },
  );
  if (
    page.items.some(
      (file) => file.boardId !== boardId || file.state !== "ready",
    )
  )
    throw new ApiContractError();
  return page;
}

export async function attachBoardFile(
  target: BoardAttachmentTarget,
  rawFileId: string,
  rawVersions: BoardAttachmentVersions,
): Promise<BoardAttachmentFile> {
  checkWritableTarget(target);
  const { boardId } = ids(target);
  const fileId = uuid.parse(rawFileId);
  const version = revisions.parse(rawVersions);
  const result = await apiFetch(contentPath(target), fileWire, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({
      file_id: fileId,
      board_revision: version.boardRevision,
      content_revision: version.contentRevision,
    }),
  });
  if (result.id !== fileId || result.state !== "ready")
    throw new ApiContractError();
  return checkedFile(result, boardId);
}

export async function detachBoardFile(
  target: BoardAttachmentTarget,
  rawFileId: string,
  rawVersions: BoardAttachmentVersions,
): Promise<void> {
  checkWritableTarget(target);
  const fileId = uuid.parse(rawFileId);
  const version = revisions.parse(rawVersions);
  const response = await apiRequest(`${contentPath(target)}/${fileId}`, {
    method: "DELETE",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      board_revision: version.boardRevision,
      content_revision: version.contentRevision,
    }),
  });
  if (!response.ok) return throwRequestError(response);
  if (response.status !== 204) throw new ApiContractError();
}

export async function downloadBoardAttachment(
  target: BoardAttachmentTarget,
  rawFileId: string,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<Blob> {
  const fileId = uuid.parse(rawFileId);
  const path = contentPath(target);
  const suffix = target.kind === "post" ? `?view=${target.view}` : "";
  return requestFileContent(
    `${path}/${fileId}/content${suffix}`,
    expectedSize,
    signal,
    BOARD_FILE_REQUEST_ERROR,
  );
}

const unlinkedFileWire = fileWireSchema
  .extend({
    purpose: z.literal("board_attachment"),
    record_id: z.null(),
    department_id: z.null(),
    board_id: uuid,
  })
  .transform((file) => ({
    ...fileDetails(file),
    boardId: file.board_id,
    isDeleted: file.is_deleted,
  }));
const unlinkedPageWire = z
  .object({
    items: z.array(unlinkedFileWire),
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
  .refine(
    ({ items, pagination: p }) =>
      items.length === p.count &&
      p.count <= p.limit &&
      p.offset + p.count <= Math.max(p.total, p.offset) &&
      p.has_more === p.offset + p.count < p.total,
  )
  .transform(({ items, pagination: { has_more, ...page } }) => ({
    items,
    pagination: { ...page, hasMore: has_more },
  }));
export type BoardUnlinkedFile = z.output<typeof unlinkedFileWire>;
export type BoardUnlinkedFilePage = z.output<typeof unlinkedPageWire>;

export async function listUnlinkedBoardFiles(
  rawBoardId: string,
  options: { deleted: "exclude" | "only"; offset: number; limit?: number },
  signal?: AbortSignal,
): Promise<BoardUnlinkedFilePage> {
  const boardId = uuid.parse(rawBoardId);
  const params = z
    .object({
      deleted: z.enum(["exclude", "only"]),
      offset: z.number().int().min(0),
      limit: z.number().int().min(1).max(100).default(25),
    })
    .parse(options);
  const query = new URLSearchParams({
    deleted: params.deleted,
    limit: String(params.limit),
    offset: String(params.offset),
  });
  const page = await apiFetch(
    `/boards/${boardId}/files?${query}`,
    unlinkedPageWire,
    { cache: "no-store", signal },
  );
  if (
    page.pagination.offset !== params.offset ||
    page.pagination.limit !== params.limit ||
    page.items.some(
      (file) =>
        file.boardId !== boardId ||
        file.isDeleted !== (params.deleted === "only"),
    )
  )
    throw new ApiContractError();
  return page;
}

export async function archiveUnlinkedBoardFile(
  rawBoardId: string,
  rawFileId: string,
): Promise<BoardUnlinkedFile> {
  const boardId = uuid.parse(rawBoardId),
    fileId = uuid.parse(rawFileId);
  const file = await apiFetch(
    `/boards/${boardId}/files/${fileId}/archive`,
    unlinkedFileWire,
    { method: "POST", cache: "no-store" },
  );
  if (file.boardId !== boardId || file.id !== fileId || !file.isDeleted)
    throw new ApiContractError();
  return file;
}

export async function previewBoardFilePurge(
  rawBoardId: string,
  rawFileId: string,
) {
  const boardId = uuid.parse(rawBoardId),
    fileId = uuid.parse(rawFileId);
  const preview = await apiFetch(
    `/boards/${boardId}/files/${fileId}/purge/preview`,
    lifecyclePurgePreviewSchema,
    { method: "POST", cache: "no-store" },
  );
  assertLifecyclePurgePreviewFor(preview, "file", fileId);
  return preview;
}

export async function purgeBoardFile(
  rawBoardId: string,
  rawFileId: string,
  rawInput: LifecyclePurgeInput,
): Promise<BoardUnlinkedFile> {
  const boardId = uuid.parse(rawBoardId),
    fileId = uuid.parse(rawFileId);
  const input = lifecyclePurgeInputSchema.parse(rawInput);
  const file = await apiFetch(
    `/boards/${boardId}/files/${fileId}/purge`,
    unlinkedFileWire,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({
        token: input.token,
        confirmation_name: input.confirmationName,
        password: input.password,
      }),
    },
  );
  if (
    file.boardId !== boardId ||
    file.id !== fileId ||
    !file.isDeleted ||
    file.state !== "purged" ||
    file.filename !== input.confirmationName
  )
    throw new ApiContractError();
  return file;
}
