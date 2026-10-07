import { z } from "zod";
import { ApiContractError, ApiError, apiRequest } from "@/lib/api";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const uuid = z.string().uuid();
const timestamp = z.iso.datetime({ offset: true });

export const fileWireSchema = z
  .object({
    id: uuid,
    purpose: z.enum([
      "record_attachment",
      "board_attachment",
      "library_document",
      "workspace_logo",
    ]),
    record_id: uuid.nullable(),
    department_id: uuid.nullable(),
    board_id: uuid.nullable(),
    creator_id: uuid,
    filename: z.string().min(1).max(255),
    media_type: z.string().max(255).nullable(),
    expected_size: z.number().int().min(1).max(MAX_FILE_BYTES),
    actual_size: z.number().int().min(0).max(MAX_FILE_BYTES).nullable(),
    state: z.enum([
      "awaiting_upload",
      "uploading",
      "ready",
      "rejected",
      "deleting",
      "purged",
    ]),
    failure_code: z.string().max(48).nullable(),
    is_deleted: z.boolean(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export function fileDetails(file: z.output<typeof fileWireSchema>) {
  return {
    id: file.id,
    creatorId: file.creator_id,
    filename: file.filename,
    mediaType: file.media_type,
    expectedSize: file.expected_size,
    actualSize: file.actual_size,
    state: file.state,
    failureCode: file.failure_code,
    createdAt: file.created_at,
    updatedAt: file.updated_at,
  };
}

export type FileDetails = ReturnType<typeof fileDetails>;

const reservationInput = z
  .object({
    filename: z.string().min(1).max(255),
    expectedSize: z.number().int().min(1).max(MAX_FILE_BYTES),
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

export async function reserveFile<T>(
  rawInput: { filename: string; expectedSize: number },
  request: (body: { filename: string; expected_size: number }) => Promise<T>,
): Promise<T> {
  const input = reservationInput.parse(rawInput);
  return request({
    filename: input.filename,
    expected_size: input.expectedSize,
  });
}

/** The scoped request reports unsuccessful HTTP responses before parsing. */
export async function uploadFileContent<T extends { id: string }>(
  fileId: string,
  content: Blob,
  schema: z.ZodType<T>,
  request: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<T> {
  if (
    !(content instanceof Blob) ||
    content.size < 1 ||
    content.size > MAX_FILE_BYTES
  )
    throw new ApiContractError();
  const response = await request();
  const body: unknown = await response.json().catch((error: unknown) => {
    if (signal?.aborted) throw error;
    throw new ApiContractError();
  });
  const result = schema.safeParse(body);
  if (!result.success || result.data.id !== fileId)
    throw new ApiContractError();
  return result.data;
}

export async function throwFileRequestError(
  response: Response,
  message = "File request could not be completed",
): Promise<never> {
  await response.body?.cancel().catch(() => undefined);
  throw new ApiError(response.status, message);
}

export async function requestFileContent(
  path: string,
  expectedSize: number,
  signal?: AbortSignal,
  requestErrorMessage = "File request could not be completed",
): Promise<Blob> {
  if (
    !Number.isInteger(expectedSize) ||
    expectedSize < 1 ||
    expectedSize > MAX_FILE_BYTES
  )
    throw new ApiContractError();
  const response = await apiRequest(path, { cache: "no-store", signal });
  if (!response.ok) return throwFileRequestError(response, requestErrorMessage);
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
      if (size > expectedSize || size > MAX_FILE_BYTES) {
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

export function fileErrorMessage(error: unknown, action: string): string {
  if (error instanceof ApiError) {
    if (String(error.code) === "file_uploads_full")
      return "Too many uploads are still unfinished. Try again later.";
    if (error.status === 409)
      return "This content changed. Try again, or reload the editor.";
    if ([401, 403, 404].includes(error.status))
      return "This content or file is no longer available to you.";
    if (error.status === 413) return "This file is larger than 25 MB.";
    if (error.status === 422)
      return "The file or attachment request was rejected. Check the file and try again.";
  }
  if (error instanceof ApiContractError)
    return "The server returned an invalid attachment response. Refresh and try again.";
  return `Could not ${action}. Try again.`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KB";
  if (value >= 1024) {
    value /= 1024;
    unit = units[1] ?? "MB";
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}
