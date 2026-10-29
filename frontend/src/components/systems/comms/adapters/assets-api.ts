import { z } from "zod";
import {
  ApiContractError,
  ApiError,
  apiFetchWithMetadata,
  apiRequest,
} from "@/lib/api";
import {
  retryAfterSeconds,
  retryFilesBusy,
  throwFileRequestError,
  uploadFileContent,
} from "../../shared/adapters/files-api";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import {
  requestOptions,
  responseData,
  structurePageSchema,
} from "./structure-contract";

// Comms uses the platform's 10 MiB admission, not the older shared UI ceiling.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function contentPath(conversationId: string, fileId: string) {
  z.uuid().parse(conversationId);
  z.uuid().parse(fileId);
  return `/comms/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}/content`;
}
function fileSchemaFor(context: C.CommsContext, conversationId: string) {
  return S.fileSchema.refine(
    (value) =>
      value.org_id === context.org_id &&
      value.conversation_id === conversationId &&
      value.creator_id === context.user_id &&
      !value.is_deleted,
  );
}
async function fileError(response: Response): Promise<never> {
  const body: unknown = await response.json().catch((error: unknown) => {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  });
  const parsed = z
    .object({ detail: z.object({ code: z.string() }) })
    .safeParse(body);
  if (parsed.success)
    throw new ApiError(
      response.status,
      "File request could not be completed",
      undefined,
      parsed.data.detail.code,
      retryAfterSeconds(response),
    );
  return throwFileRequestError(response);
}
async function invalidDownload(response: Response): Promise<never> {
  await response.body?.cancel().catch(() => undefined);
  throw new ApiContractError();
}

export async function reserveAttachment(
  context: C.CommsContext,
  conversationId: string,
  input: C.AttachmentReservation,
  options: C.RequestOptions = {},
): Promise<C.CommsFile> {
  const bound = S.commsContextSchema.parse(context);
  z.uuid().parse(conversationId);
  const request = S.attachmentReservationSchema.parse(input);
  const result = await apiFetchWithMetadata(
    `/comms/conversations/${encodeURIComponent(conversationId)}/files`,
    fileSchemaFor(bound, conversationId).refine(
      (value) =>
        value.state === "awaiting_upload" &&
        value.filename === request.filename &&
        value.expected_size === request.expected_size &&
        value.actual_size === null,
    ),
    {
      ...requestOptions(bound, options),
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  const data = responseData(result, 201);
  if (
    result.response.headers.get("Location") !==
    `/api/comms/conversations/${conversationId}/files/${data.id}`
  )
    throw new ApiContractError();
  return data;
}

export async function uploadAttachment(
  context: C.CommsContext,
  conversationId: string,
  fileId: string,
  bytes: Blob,
  options: C.UploadOptions = {},
): Promise<C.CommsFile> {
  const bound = S.commsContextSchema.parse(context);
  z.uuid().parse(conversationId);
  z.uuid().parse(fileId);
  if (!(bytes instanceof Blob)) throw new ApiContractError();
  S.attachmentReservationSchema.shape.expected_size.parse(bytes.size);
  options.signal?.throwIfAborted();
  const progress = (loaded_bytes: number) => {
    try {
      options.on_progress?.({ loaded_bytes, total_bytes: bytes.size });
    } catch {
      /* An observer cannot change whether the upload succeeded. */
    }
  };
  progress(0);
  const data = await uploadFileContent(
    fileId,
    bytes,
    fileSchemaFor(bound, conversationId).refine(
      (value) =>
        value.state === "ready" &&
        value.expected_size === bytes.size &&
        value.actual_size === bytes.size,
    ),
    async () => {
      const response = await apiRequest(contentPath(conversationId, fileId), {
        ...requestOptions(bound, options),
        method: "PUT",
        body: bytes,
        redirect: "error",
        headers: {
          "X-Org": bound.org_id,
          "Content-Type": "application/octet-stream",
        },
      });
      if (!response.ok) return fileError(response);
      if (response.status !== 200) return invalidDownload(response);
      return response;
    },
    options.signal,
    options.on_waiting,
  );
  progress(bytes.size);
  return data;
}

export async function downloadAttachment(
  context: C.CommsContext,
  conversationId: string,
  fileId: string,
  options: C.DownloadOptions = {},
): Promise<C.BinaryDownload> {
  const bound = S.commsContextSchema.parse(context);
  const response = await retryFilesBusy(
    async () => {
      const response = await apiRequest(contentPath(conversationId, fileId), {
        ...requestOptions(bound, options),
        method: "GET",
        redirect: "error",
      });
      if (!response.ok) return fileError(response);
      return response;
    },
    { signal: options.signal, onWaiting: options.on_waiting },
  );
  const encoded = response.headers
    .get("Content-Disposition")
    ?.match(/^attachment;\s*filename\*=UTF-8''([^;\r\n]+)$/i)?.[1];
  let filename: string;
  try {
    filename = decodeURIComponent(encoded ?? "");
  } catch {
    return invalidDownload(response);
  }
  const media_type = response.headers.get("Content-Type")?.trim();
  const declared = response.headers.get("Content-Length");
  const length = declared === null ? null : Number(declared);
  if (
    response.status !== 200 ||
    !media_type ||
    !S.attachmentReservationSchema.shape.filename.safeParse(filename).success ||
    response.headers.get("X-Content-Type-Options")?.trim().toLowerCase() !==
      "nosniff" ||
    !response.headers
      .get("Cache-Control")
      ?.toLowerCase()
      .split(",")
      .some((value) => value.trim() === "no-store") ||
    (declared !== null &&
      (!/^\d+$/.test(declared) ||
        !S.attachmentReservationSchema.shape.expected_size.safeParse(length)
          .success)) ||
    !response.body
  )
    return invalidDownload(response);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      options.signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ATTACHMENT_BYTES || (length !== null && size > length))
        throw new ApiContractError();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (size === 0 || (length !== null && size !== length))
    throw new ApiContractError();
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes: new Blob([buffer.buffer], { type: media_type }),
    filename,
    media_type,
  };
}

export async function getRecordReference(
  context: C.CommsContext,
  conversationId: string,
  referenceId: string,
  options: C.RequestOptions = {},
): Promise<C.RecordReference> {
  const bound = S.commsContextSchema.parse(context);
  z.uuid().parse(conversationId);
  z.uuid().parse(referenceId);
  return responseData(
    await apiFetchWithMetadata(
      `/comms/conversations/${encodeURIComponent(conversationId)}/record-references/${encodeURIComponent(referenceId)}`,
      S.recordReferenceSchema.refine((value) => value.id === referenceId),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}

export async function listLinkedRecords(
  context: C.CommsContext,
  input: C.TimeListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.RecordReference>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.timeListRequestSchema.parse(input);
  const query = new URLSearchParams(
    Object.entries(request).map(([key, value]) => [key, String(value)]),
  );
  return responseData(
    await apiFetchWithMetadata(
      `/comms/record-references?${query}`,
      structurePageSchema(S.recordReferenceSchema, request),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}
