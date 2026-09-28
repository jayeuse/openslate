import { z } from "zod";
import { ApiContractError, ApiError, apiRequest } from "@/lib/api";
import { throwSafeBoardError } from "./board-management-requests";
import {
  EXPORT_FILENAME,
  uuidSchema,
  bundleSchema,
  boardSchema,
} from "./board-management-schemas";
import type {
  PortableBoardBundle,
  BoardManagementBoard,
  BoardConfigurationDownload,
} from "./board-management-schemas";

const MAX_BUNDLE_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

async function readBoundedBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > limit)
  ) {
    throw new ApiContractError();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ApiContractError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function inspectBundleJson(text: string): string | null {
  let cursor = 0;
  let versionToken: string | null = null;
  const whitespace = () => {
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
  };
  const readString = (): string => {
    const begin = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (text[cursor++] === '"') break;
    }
    const value: unknown = JSON.parse(text.slice(begin, cursor));
    if (typeof value !== "string") throw new ApiContractError();
    return value;
  };
  const visit = (root = false): void => {
    whitespace();
    if (text[cursor] === "{") {
      cursor += 1;
      const keys = new Set<string>();
      whitespace();
      while (text[cursor] !== "}") {
        const key = readString();
        if (keys.has(key)) throw new ApiContractError();
        keys.add(key);
        whitespace();
        cursor += 1;
        whitespace();
        const valueStart = cursor;
        visit();
        if (root && key === "version")
          versionToken = text.slice(valueStart, cursor);
        whitespace();
        if (text[cursor] === ",") {
          cursor += 1;
          whitespace();
        } else break;
      }
      cursor += 1;
    } else if (text[cursor] === "[") {
      cursor += 1;
      whitespace();
      while (text[cursor] !== "]") {
        visit();
        whitespace();
        if (text[cursor] === ",") {
          cursor += 1;
          whitespace();
        } else break;
      }
      cursor += 1;
    } else if (text[cursor] === '"') readString();
    else
      while (cursor < text.length && !/[\s,}\]]/.test(text[cursor] ?? ""))
        cursor += 1;
  };
  visit(true);
  return versionToken;
}

function parseBundleBytes(bytes: Uint8Array): PortableBoardBundle {
  if (
    bytes.byteLength > MAX_BUNDLE_BYTES ||
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) {
    throw new ApiContractError();
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (inspectBundleJson(text) !== "3") throw new ApiContractError();
    const parsed = bundleSchema.safeParse(value);
    if (!parsed.success) throw new ApiContractError();
    return parsed.data;
  } catch {
    throw new ApiContractError();
  }
}

async function throwRawResponseError(response: Response): Promise<never> {
  try {
    const bytes = await readBoundedBytes(response, MAX_ERROR_BYTES);
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const envelope = z
      .object({ detail: z.unknown() })
      .passthrough()
      .safeParse(body);
    return throwSafeBoardError(
      response.status,
      envelope.success ? envelope.data.detail : undefined,
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(response.status, "Request could not be completed");
  }
}

async function parseRawJson<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.output<Schema>> {
  if (!response.ok) return throwRawResponseError(response);
  const type = response.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(type))
    throw new ApiContractError();
  const bytes = await readBoundedBytes(response, MAX_BUNDLE_BYTES);
  try {
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiContractError();
    return parsed.data;
  } catch {
    throw new ApiContractError();
  }
}

export async function downloadBoardConfiguration(
  rawBoardId: string,
): Promise<BoardConfigurationDownload> {
  const boardId = uuidSchema.parse(rawBoardId);
  const response = await apiRequest(
    `/boards/${encodeURIComponent(boardId)}/configuration`,
    {
      cache: "no-store",
    },
  );
  if (!response.ok) return throwRawResponseError(response);
  const type = response.headers.get("Content-Type") ?? "";
  if (
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(type) ||
    response.headers.get("Content-Disposition") !==
      `attachment; filename="${EXPORT_FILENAME}"`
  ) {
    throw new ApiContractError();
  }
  const bytes = await readBoundedBytes(response, MAX_BUNDLE_BYTES);
  const bundle = parseBundleBytes(bytes);
  const exact = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  exact.set(bytes);
  return {
    blob: new Blob([exact.buffer], { type: "application/json" }),
    filename: EXPORT_FILENAME,
    bundle,
  };
}

export async function importBoardConfiguration(
  raw: Blob,
): Promise<BoardManagementBoard> {
  if (!(raw instanceof Blob) || raw.size > MAX_BUNDLE_BYTES) {
    throw new Error("Choose a valid Board configuration no larger than 1 MiB");
  }
  const bytes = new Uint8Array(await raw.arrayBuffer());
  try {
    parseBundleBytes(bytes);
  } catch {
    throw new Error("Choose a valid Board configuration no larger than 1 MiB");
  }
  const response = await apiRequest("/boards/import", {
    method: "POST",
    cache: "no-store",
    body: raw,
    headers: { "Content-Type": "application/octet-stream" },
  });
  return parseRawJson(response, boardSchema);
}
