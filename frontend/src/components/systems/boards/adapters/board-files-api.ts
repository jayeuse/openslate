import { z } from "zod";
import { ApiContractError, ApiError, apiFetch, apiRequest } from "@/lib/api";

export const MAX_BOARD_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const uuid = z.string().uuid();
const timestamp = z.iso.datetime({ offset: true });
const fileState = z.enum([
  "awaiting_upload",
  "uploading",
  "pending_scan",
  "ready",
  "rejected",
  "deleting",
  "purged",
]);
const fileWire = z
  .object({
    id: uuid,
    purpose: z.literal("board_attachment"),
    record_id: z.null(),
    board_id: uuid,
    creator_id: uuid,
    filename: z.string().min(1).max(255),
    media_type: z.string().max(255).nullable(),
    expected_size: z.number().int().min(1).max(MAX_BOARD_ATTACHMENT_BYTES),
    actual_size: z
      .number()
      .int()
      .min(0)
      .max(MAX_BOARD_ATTACHMENT_BYTES)
      .nullable(),
    state: fileState,
    failure_code: z.string().max(48).nullable(),
    is_deleted: z.literal(false),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict()
  .transform((file) => ({
    id: file.id,
    boardId: file.board_id,
    creatorId: file.creator_id,
    filename: file.filename,
    mediaType: file.media_type,
    expectedSize: file.expected_size,
    actualSize: file.actual_size,
    state: file.state,
    failureCode: file.failure_code,
    createdAt: file.created_at,
    updatedAt: file.updated_at,
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
const reservationInput = z
  .object({
    filename: z.string().min(1).max(255),
    expectedSize: z.number().int().min(1).max(MAX_BOARD_ATTACHMENT_BYTES),
  })
  .strict()
  .superRefine(({ filename }, context) => {
    if (
      filename === "." ||
      filename === ".." ||
      /[\\/\u0000-\u001f\u007f]/.test(filename)
    )
      context.addIssue({
        code: "custom",
        message: "Choose a plain file name.",
      });
  });
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
      kind: "announcement";
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
    : `/boards/${boardId}/announcements/${contentId}/attachments`;
}

function checkedFile(
  file: BoardAttachmentFile,
  boardId: string,
): BoardAttachmentFile {
  if (file.boardId !== boardId) throw new ApiContractError();
  return file;
}

function checkWritableTarget(target: BoardAttachmentTarget): void {
  if (target.kind === "announcement" && target.view !== "draft")
    throw new ApiContractError();
}

async function throwRequestError(response: Response): Promise<never> {
  await response.body?.cancel().catch(() => undefined);
  throw new ApiError(
    response.status,
    "Board file request could not be completed",
  );
}

async function requestFileContent(
  path: string,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<Blob> {
  if (
    !Number.isInteger(expectedSize) ||
    expectedSize < 1 ||
    expectedSize > MAX_BOARD_ATTACHMENT_BYTES
  )
    throw new ApiContractError();
  const response = await apiRequest(path, { cache: "no-store", signal });
  if (!response.ok) return throwRequestError(response);
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const sniffing = response.headers.get("X-Content-Type-Options") ?? "";
  if (
    !/^attachment\s*;/i.test(disposition) ||
    sniffing.toLowerCase() !== "nosniff"
  )
    throw new ApiContractError();
  const declared = response.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) !== expectedSize)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiContractError();
  }
  if (!response.body) throw new ApiContractError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expectedSize || size > MAX_BOARD_ATTACHMENT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ApiContractError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== expectedSize) throw new ApiContractError();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const mediaType =
    response.headers.get("Content-Type") ?? "application/octet-stream";
  return new Blob([bytes.buffer], { type: mediaType });
}

export async function reserveBoardFile(
  rawBoardId: string,
  rawInput: { filename: string; expectedSize: number },
): Promise<BoardAttachmentFile> {
  const boardId = uuid.parse(rawBoardId);
  const input = reservationInput.parse(rawInput);
  const result = await apiFetch(`/boards/${boardId}/files`, fileWire, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({
      filename: input.filename,
      expected_size: input.expectedSize,
    }),
  });
  if (result.boardId !== boardId) throw new ApiContractError();
  return checkedFile(result, boardId);
}

export async function uploadBoardFile(
  rawBoardId: string,
  rawFileId: string,
  content: Blob,
  signal?: AbortSignal,
): Promise<void> {
  const boardId = uuid.parse(rawBoardId);
  const fileId = uuid.parse(rawFileId);
  if (
    !(content instanceof Blob) ||
    content.size < 1 ||
    content.size > MAX_BOARD_ATTACHMENT_BYTES
  )
    throw new ApiContractError();
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
  await response.body?.cancel().catch(() => undefined);
}

export async function scanBoardFile(
  rawBoardId: string,
  rawFileId: string,
  signal?: AbortSignal,
): Promise<BoardAttachmentFile> {
  const boardId = uuid.parse(rawBoardId);
  const fileId = uuid.parse(rawFileId);
  const file = await apiFetch(
    `/boards/${boardId}/files/${fileId}/scan`,
    fileWire,
    {
      method: "POST",
      cache: "no-store",
      signal,
    },
  );
  return checkedFile(file, boardId);
}

export async function readBoardFile(
  rawBoardId: string,
  rawFileId: string,
  signal?: AbortSignal,
): Promise<BoardAttachmentFile> {
  const boardId = uuid.parse(rawBoardId);
  const fileId = uuid.parse(rawFileId);
  const file = await apiFetch(`/boards/${boardId}/files/${fileId}`, fileWire, {
    cache: "no-store",
    signal,
  });
  return checkedFile(file, boardId);
}

export async function listBoardAttachments(
  target: BoardAttachmentTarget,
  rawOptions: BoardAttachmentListOptions = {},
): Promise<BoardAttachmentPage> {
  const { boardId } = ids(target);
  const { signal, ...optionInput } = rawOptions;
  const options = listOptions.parse(optionInput);
  const query = new URLSearchParams();
  if (target.kind === "announcement") query.set("view", target.view);
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
  const suffix = target.kind === "announcement" ? `?view=${target.view}` : "";
  return requestFileContent(
    `${path}/${fileId}/content${suffix}`,
    expectedSize,
    signal,
  );
}
