import { z } from "zod";
import { ApiContractError, apiFetch, apiRequest } from "@/lib/api";
import {
  fileDetails,
  fileWireSchema,
  requestFileContent,
  reserveFile,
  throwFileRequestError,
  uploadFileContent,
} from "../../shared/adapters/files-api";
import { openViewReadFetch, trackOpenViewRead } from "./openview-access";
import { listSchema, pageRequestSchema, uuidSchema } from "./views-schemas";

function recordFileSchema(recordId: string) {
  return fileWireSchema
    .extend({
      purpose: z.literal("record_attachment"),
      record_id: z.literal(recordId),
      department_id: z.null(),
      board_id: z.null(),
    })
    .superRefine((file, context) => {
      if (
        file.state === "ready" &&
        (file.actual_size !== file.expected_size || file.media_type === null)
      )
        context.addIssue({
          code: "custom",
          message: "Ready file metadata is incomplete",
        });
    })
    .transform((file) => ({
      ...fileDetails(file),
      isDeleted: file.is_deleted,
    }));
}

export type RecordFile = z.output<ReturnType<typeof recordFileSchema>>;

function checkedFile(file: RecordFile, fileId: string): RecordFile {
  if (file.id !== fileId) throw new ApiContractError();
  return file;
}

export async function listRecordFiles(
  rawRecordId: string,
  options: { limit?: number; offset?: number; signal?: AbortSignal } = {},
) {
  const recordId = uuidSchema.parse(rawRecordId);
  const { signal, ...rawPage } = options;
  const page = pageRequestSchema.parse(rawPage);
  const parameters = new URLSearchParams({
    purpose: "record_attachment",
    record_id: recordId,
    deleted: "exclude",
    limit: String(page.limit),
    offset: String(page.offset),
  });
  return openViewReadFetch(
    `/files?${parameters}`,
    listSchema(recordFileSchema(recordId)).superRefine((result, context) => {
      const pagination = result.pagination;
      if (
        result.items.some((file) => file.isDeleted) ||
        new Set(result.items.map((file) => file.id)).size !==
          result.items.length ||
        pagination.limit !== page.limit ||
        pagination.offset !== page.offset ||
        pagination.count !== result.items.length ||
        pagination.count > pagination.limit ||
        (pagination.count > 0 &&
          pagination.total < pagination.offset + pagination.count) ||
        (pagination.hasMore && pagination.count === 0)
      )
        context.addIssue({
          code: "custom",
          message: "File page does not match the requested record",
        });
    }),
    { cache: "no-store", signal },
  );
}

export async function getRecordFile(
  rawRecordId: string,
  rawFileId: string,
  signal?: AbortSignal,
): Promise<RecordFile> {
  const recordId = uuidSchema.parse(rawRecordId);
  const fileId = uuidSchema.parse(rawFileId);
  return checkedFile(
    await openViewReadFetch(`/files/${fileId}`, recordFileSchema(recordId), {
      cache: "no-store",
      signal,
    }),
    fileId,
  );
}

export async function reserveRecordFile(
  rawRecordId: string,
  input: { filename: string; expectedSize: number },
  signal?: AbortSignal,
): Promise<RecordFile> {
  const recordId = uuidSchema.parse(rawRecordId);
  const file = await reserveFile(input, (body) =>
    apiFetch("/files", recordFileSchema(recordId), {
      method: "POST",
      cache: "no-store",
      signal,
      body: JSON.stringify({
        purpose: "record_attachment",
        record_id: recordId,
        ...body,
      }),
    }),
  );
  if (
    file.isDeleted ||
    file.state !== "awaiting_upload" ||
    file.filename !== input.filename ||
    file.expectedSize !== input.expectedSize
  )
    throw new ApiContractError();
  return file;
}

export async function uploadRecordFile(
  rawRecordId: string,
  rawFileId: string,
  content: Blob,
  signal?: AbortSignal,
  onWaiting?: (waiting: boolean) => void,
): Promise<RecordFile> {
  const recordId = uuidSchema.parse(rawRecordId);
  const fileId = uuidSchema.parse(rawFileId);
  return uploadFileContent(
    fileId,
    content,
    recordFileSchema(recordId),
    async () => {
      const response = await apiRequest(`/files/${fileId}/content`, {
        method: "PUT",
        cache: "no-store",
        body: content,
        headers: { "Content-Type": "application/octet-stream" },
        signal,
      });
      if (!response.ok) return throwFileRequestError(response);
      return response;
    },
    signal,
    onWaiting,
  );
}

export async function archiveRecordFile(
  rawRecordId: string,
  rawFileId: string,
  signal?: AbortSignal,
): Promise<RecordFile> {
  const recordId = uuidSchema.parse(rawRecordId);
  const fileId = uuidSchema.parse(rawFileId);
  const file = checkedFile(
    await apiFetch(`/files/${fileId}/archive`, recordFileSchema(recordId), {
      method: "POST",
      cache: "no-store",
      signal,
    }),
    fileId,
  );
  if (!file.isDeleted) throw new ApiContractError();
  return file;
}

export function downloadRecordFile(
  file: RecordFile,
  signal?: AbortSignal,
  onWaiting?: (waiting: boolean) => void,
) {
  if (file.state !== "ready" || file.isDeleted) throw new ApiContractError();
  const fileId = uuidSchema.parse(file.id);
  return trackOpenViewRead(() =>
    requestFileContent(
      `/files/${fileId}/content`,
      file.actualSize ?? file.expectedSize,
      signal,
      undefined,
      onWaiting,
    ),
  );
}
