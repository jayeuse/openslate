import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import {
  ApiContractError,
  ApiError,
  apiFetchWithMetadata,
  apiRequest,
} from "@/lib/api";
import {
  retryAfterSeconds,
  retryFilesBusy,
} from "../../shared/adapters/files-api";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import {
  conditionalOptions,
  requestOptions,
  privateResponse,
  requirePrivateNoStore,
  structurePageSchema,
  versioned,
} from "./structure-contract";

const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
function schedulePath(id: string) {
  z.uuid().parse(id);
  return `/comms/scheduled-messages/${encodeURIComponent(id)}`;
}
function exportPath(id: string) {
  z.uuid().parse(id);
  return `/comms/exports/${encodeURIComponent(id)}`;
}
function queryString(request: object) {
  return new URLSearchParams(
    Object.entries(request).map(([key, value]) => [key, String(value)]),
  ).toString();
}
function sameScheduleRequest(
  actual: z.output<typeof S.scheduleRequestSchema>,
  expected: z.output<typeof S.scheduleRequestSchema>,
) {
  const { send_at: actualTime, ...actualFields } = actual;
  const { send_at: expectedTime, ...expectedFields } = expected;
  if (JSON.stringify(actualFields) !== JSON.stringify(expectedFields))
    return false;
  // The backend's AwareDatetime truncates input fractions after six digits.
  // Compare that supported instant exactly; never truncate the acknowledgment
  // or use Date's millisecond precision, which would conflate microseconds.
  const expectedMicroseconds = expectedTime.replace(/(\.\d{6})\d+/, "$1");
  try {
    return Temporal.Instant.compare(actualTime, expectedMicroseconds) === 0;
  } catch {
    return false;
  }
}
function scheduleSchemaFor(
  context: C.CommsContext,
  id?: string,
  request?: z.output<typeof S.scheduleRequestSchema>,
) {
  return S.scheduleSchema.refine(
    (value) =>
      value.org_id === context.org_id &&
      (id === undefined || value.id === id) &&
      (request === undefined || sameScheduleRequest(value.request, request)),
  );
}
function exportSchemaFor(context: C.CommsContext, id?: string) {
  return S.exportJobSchema.refine(
    (value) =>
      value.org_id === context.org_id && (id === undefined || value.id === id),
  );
}

export async function listSchedules(
  context: C.CommsContext,
  input: C.TimeListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.Schedule>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.timeListRequestSchema.parse(input);
  return privateResponse(
    await apiFetchWithMetadata(
      `/comms/scheduled-messages?${queryString(request)}`,
      structurePageSchema(scheduleSchemaFor(bound), request),
      { ...requestOptions(bound, options), method: "GET" },
    ),
  );
}
export async function getSchedule(
  context: C.CommsContext,
  id: string,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Schedule>> {
  const bound = S.commsContextSchema.parse(context);
  const result = await apiFetchWithMetadata(
    schedulePath(id),
    scheduleSchemaFor(bound, id),
    { ...requestOptions(bound, options), method: "GET" },
  );
  privateResponse(result);
  return versioned(result);
}
export async function createSchedule(
  context: C.CommsContext,
  input: C.ScheduleRequest,
  options: C.RequestOptions = {},
): Promise<C.Versioned<C.Schedule>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.scheduleRequestSchema.parse(input);
  const result = await apiFetchWithMetadata(
    "/comms/scheduled-messages",
    scheduleSchemaFor(bound, undefined, request).refine(
      (value) => value.author_id === bound.user_id,
    ),
    {
      ...requestOptions(bound, options),
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  privateResponse(result, 201);
  return versioned(result, [201], "/comms/scheduled-messages");
}
export async function updateSchedule(
  context: C.CommsContext,
  id: string,
  input: C.ScheduleRequest,
  options: C.ConditionalOptions,
): Promise<C.Versioned<C.Schedule>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.scheduleRequestSchema.parse(input);
  const result = await apiFetchWithMetadata(
    schedulePath(id),
    scheduleSchemaFor(bound, id, request),
    {
      ...conditionalOptions(bound, options),
      method: "PUT",
      body: JSON.stringify(request),
    },
  );
  privateResponse(result);
  return versioned(result);
}
/** Cancellation of this wait never sends a compensating job cancellation (ID28). */
export async function sendScheduleNow(
  context: C.CommsContext,
  id: string,
  options: C.ConditionalOptions,
): Promise<C.Schedule> {
  const bound = S.commsContextSchema.parse(context);
  return privateResponse(
    await apiFetchWithMetadata(
      `${schedulePath(id)}/send`,
      scheduleSchemaFor(bound, id),
      {
        ...conditionalOptions(bound, options),
        method: "POST",
      },
    ),
  );
}
export async function cancelSchedule(
  context: C.CommsContext,
  id: string,
  options: C.ConditionalOptions,
): Promise<C.Schedule> {
  const bound = S.commsContextSchema.parse(context);
  return privateResponse(
    await apiFetchWithMetadata(
      `${schedulePath(id)}/cancellation`,
      scheduleSchemaFor(bound, id).refine(
        (value) => value.status === "cancelled",
      ),
      {
        ...conditionalOptions(bound, options),
        method: "POST",
      },
    ),
  );
}
export async function listExports(
  context: C.CommsContext,
  input: C.TimeListRequest = {},
  options: C.RequestOptions = {},
): Promise<C.Page<C.ExportJob>> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.timeListRequestSchema.parse(input);
  return privateResponse(
    await apiFetchWithMetadata(
      `/comms/exports?${queryString(request)}`,
      structurePageSchema(exportSchemaFor(bound), request),
      {
        ...requestOptions(bound, options),
        method: "GET",
      },
    ),
  );
}
export async function startExport(
  context: C.CommsContext,
  input: C.ExportRequest,
  options: C.RequestOptions | C.FreshAdminOptions = {},
): Promise<C.ExportJob> {
  const bound = S.commsContextSchema.parse(context);
  const request = S.exportRequestSchema.parse(input);
  const proof =
    "password" in options
      ? {
          password: S.purgeRequestSchema.shape.password.parse(options.password),
        }
      : {};
  const selected = new Set(request.conversation_ids);
  const result = await apiFetchWithMetadata(
    "/comms/exports",
    exportSchemaFor(bound).refine(
      (value) =>
        value.requested_by === bound.user_id &&
        value.request.format === request.format &&
        value.request.reason === request.reason &&
        value.request.after === request.after &&
        value.request.before === request.before &&
        value.request.conversation_ids.length === selected.size &&
        value.request.conversation_ids.every((id) => selected.has(id)),
    ),
    {
      ...requestOptions(bound, options),
      method: "POST",
      body: JSON.stringify({ ...request, ...proof }),
    },
  );
  const job = privateResponse(result, 201);
  if (
    result.response.headers.get("Location") !== `/api/comms/exports/${job.id}`
  )
    throw new ApiContractError();
  return job;
}
export async function getExport(
  context: C.CommsContext,
  id: string,
  options: C.RequestOptions = {},
): Promise<C.ExportJob> {
  const bound = S.commsContextSchema.parse(context);
  return privateResponse(
    await apiFetchWithMetadata(exportPath(id), exportSchemaFor(bound, id), {
      ...requestOptions(bound, options),
      method: "GET",
    }),
  );
}

function safeFilename(value: string, extension: string): boolean {
  return (
    S.attachmentReservationSchema.shape.filename.safeParse(value).success &&
    !/[\u007f-\u009f]/.test(value) &&
    value.toLowerCase().endsWith(`.${extension}`)
  );
}
function downloadFilename(header: string | null, extension: string): string {
  const value = header?.trim() ?? "";
  const attachment = /^attachment(?=\s*;)/i.exec(value);
  if (!attachment) throw new ApiContractError();
  const parameters =
    /;\s*(filename\*?)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))\s*/giy;
  const names = new Map<string, string>();
  let offset = attachment[0].length;
  while (offset < value.length) {
    parameters.lastIndex = offset;
    const match = parameters.exec(value);
    if (!match) throw new ApiContractError();
    offset = parameters.lastIndex;
    const key = match[1].toLowerCase();
    if (names.has(key)) throw new ApiContractError();
    let name: string;
    if (key === "filename*") {
      const encoded = /^UTF-8'[a-z0-9-]*'([a-z0-9!#$&+.^_`|~%\-]+)$/i.exec(
        match[3] ?? "",
      );
      if (!encoded) throw new ApiContractError();
      try {
        name = decodeURIComponent(encoded[1]);
      } catch {
        throw new ApiContractError();
      }
    } else {
      if (
        match[2] === undefined &&
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(match[3])
      )
        throw new ApiContractError();
      name =
        match[2] === undefined ? match[3] : match[2].replace(/\\(.)/g, "$1");
      if (/[^\u0020-\u007e]/.test(name)) throw new ApiContractError();
    }
    if (!safeFilename(name, extension)) throw new ApiContractError();
    names.set(key, name);
  }
  const filename = names.get("filename*") ?? names.get("filename");
  if (!filename) throw new ApiContractError();
  return filename;
}
async function readBytes(
  response: Response,
  signal: AbortSignal | undefined,
  maximum: number,
  length: number | null = null,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) {
    signal?.throwIfAborted();
    if (length !== null && length !== 0) throw new ApiContractError();
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maximum || (length !== null && size > length))
        throw new ApiContractError();
      chunks.push(value);
    }
    if (length !== null && size !== length) throw new ApiContractError();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function downloadError(
  response: Response,
  signal?: AbortSignal,
): Promise<never> {
  let code: string | undefined;
  try {
    const body: unknown = JSON.parse(
      new TextDecoder().decode(
        await readBytes(response, signal, MAX_ERROR_BYTES),
      ),
    );
    const failure = S.commsFailureSchema.safeParse({
      status: response.status,
      body,
    });
    const detail = failure.success ? failure.data.body.detail : undefined;
    if (
      typeof detail === "object" &&
      detail !== null &&
      "code" in detail &&
      typeof detail.code === "string"
    )
      code = detail.code;
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof ApiContractError))
      throw error;
  }
  throw new ApiError(
    response.status,
    "Export could not be downloaded.",
    undefined,
    code,
    retryAfterSeconds(response),
  );
}

export async function downloadExport(
  context: C.CommsContext,
  id: string,
  options: C.DownloadOptions = {},
): Promise<C.BinaryDownload> {
  const bound = S.commsContextSchema.parse(context);
  const response = await retryFilesBusy(
    async () => {
      const response = await apiRequest(`${exportPath(id)}/content`, {
        ...requestOptions(bound, options),
        method: "GET",
        redirect: "error",
      });
      if (!response.ok) return downloadError(response, options.signal);
      return response;
    },
    { signal: options.signal, onWaiting: options.on_waiting },
  );
  let filename: string, media_type: string, length: number | null;
  try {
    requirePrivateNoStore(response.headers);
    media_type = response.headers.get("Content-Type")?.trim() ?? "";
    const extension = /^text\/csv(?:;\s*charset=(?:utf-8|"utf-8"))?$/i.test(
      media_type,
    )
      ? "csv"
      : /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/i.test(
            media_type,
          )
        ? "xlsx"
        : null;
    if (
      response.status !== 200 ||
      !extension ||
      response.headers.get("X-Content-Type-Options")?.trim().toLowerCase() !==
        "nosniff"
    )
      throw new ApiContractError();
    filename = downloadFilename(
      response.headers.get("Content-Disposition"),
      extension,
    );
    const declared = response.headers.get("Content-Length");
    length = declared === null ? null : Number(declared);
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) ||
        length === null ||
        !Number.isSafeInteger(length) ||
        length > MAX_EXPORT_BYTES)
    )
      throw new ApiContractError();
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = await readBytes(
    response,
    options.signal,
    MAX_EXPORT_BYTES,
    length,
  );
  return {
    bytes: new Blob([bytes.buffer], { type: media_type }),
    filename,
    media_type,
  };
}
