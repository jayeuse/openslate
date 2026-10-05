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

const uuid = z.string().uuid();
export type LibraryFileSort = "created_at" | "updated_at" | "name" | "size";
export type LibraryFileDeleted = "exclude" | "include" | "only";
export type LibraryFileCriteria = {
  search: string;
  sortBy: LibraryFileSort;
  sortOrder: "asc" | "desc";
  deleted: LibraryFileDeleted;
};
export const libraryFileDefaults: LibraryFileCriteria = {
  search: "",
  sortBy: "created_at",
  sortOrder: "desc",
  deleted: "exclude",
};
const listInput = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    search: z.string().trim().max(100).default(""),
    sortBy: z
      .enum(["created_at", "updated_at", "name", "size"])
      .default("created_at"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
    deleted: z.enum(["exclude", "include", "only"]).default("exclude"),
  })
  .strict();
const pagination = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict()
  .transform(({ has_more, ...page }) => ({ ...page, hasMore: has_more }));

function libraryFileSchema(departmentId: string) {
  return fileWireSchema
    .extend({
      purpose: z.literal("library_document"),
      department_id: z.literal(departmentId),
      record_id: z.null(),
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
      departmentId: file.department_id,
      isDeleted: file.is_deleted,
    }));
}

export type LibraryFile = z.output<ReturnType<typeof libraryFileSchema>>;
export type LibraryFilePage = {
  items: LibraryFile[];
  pagination: z.output<typeof pagination>;
  creatorLabels: Record<string, string>;
  storageUsedBytes: number;
};

function checkedFile(file: LibraryFile, fileId: string): LibraryFile {
  if (file.id !== fileId) throw new ApiContractError();
  return file;
}

export async function listLibraryFiles(
  rawDepartmentId: string,
  options: Partial<LibraryFileCriteria> & {
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  } = {},
): Promise<LibraryFilePage> {
  const departmentId = uuid.parse(rawDepartmentId);
  const { signal, ...rawInput } = options;
  const input = listInput.parse(rawInput);
  const parameters = new URLSearchParams({
    purpose: "library_document",
    department_id: departmentId,
    limit: String(input.limit),
    offset: String(input.offset),
    sort_by: input.sortBy,
    sort_order: input.sortOrder,
    deleted: input.deleted,
  });
  if (input.search) parameters.set("search", input.search);
  const schema = z
    .object({
      items: z.array(libraryFileSchema(departmentId)).max(100),
      pagination,
      creator_labels: z.record(uuid, z.string().min(1)),
      storage_used_bytes: z.number().int().min(0),
    })
    .strict()
    .superRefine((page, context) => {
      const metadata = page.pagination;
      const creatorIds = new Set(page.items.map((file) => file.creatorId));
      if (
        new Set(page.items.map((file) => file.id)).size !== page.items.length ||
        page.items.some((file) =>
          input.deleted === "exclude"
            ? file.isDeleted
            : input.deleted === "only"
              ? !file.isDeleted
              : false,
        ) ||
        metadata.limit !== input.limit ||
        metadata.offset !== input.offset ||
        metadata.count !== page.items.length ||
        metadata.count > metadata.limit ||
        (metadata.count > 0 &&
          metadata.total < metadata.offset + metadata.count) ||
        metadata.hasMore !==
          metadata.offset + metadata.count < metadata.total ||
        (metadata.hasMore && metadata.count === 0) ||
        Object.keys(page.creator_labels).some((id) => !creatorIds.has(id))
      )
        context.addIssue({
          code: "custom",
          message: "File page does not match the requested library",
        });
    })
    .transform(({ creator_labels, storage_used_bytes, ...page }) => ({
      ...page,
      creatorLabels: creator_labels,
      storageUsedBytes: storage_used_bytes,
    }));
  return apiFetch(`/files?${parameters}`, schema, {
    cache: "no-store",
    signal,
  });
}

export async function getLibraryFile(
  rawDepartmentId: string,
  rawFileId: string,
  signal?: AbortSignal,
): Promise<LibraryFile> {
  const departmentId = uuid.parse(rawDepartmentId);
  const fileId = uuid.parse(rawFileId);
  return checkedFile(
    await apiFetch(`/files/${fileId}`, libraryFileSchema(departmentId), {
      cache: "no-store",
      signal,
    }),
    fileId,
  );
}

export async function reserveLibraryFile(
  rawDepartmentId: string,
  input: { filename: string; expectedSize: number },
  signal?: AbortSignal,
): Promise<LibraryFile> {
  const departmentId = uuid.parse(rawDepartmentId);
  const file = await reserveFile(input, (body) =>
    apiFetch("/files", libraryFileSchema(departmentId), {
      method: "POST",
      cache: "no-store",
      signal,
      body: JSON.stringify({
        purpose: "library_document",
        department_id: departmentId,
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

export async function uploadLibraryFile(
  rawDepartmentId: string,
  rawFileId: string,
  content: Blob,
  signal?: AbortSignal,
): Promise<LibraryFile> {
  const departmentId = uuid.parse(rawDepartmentId);
  const fileId = uuid.parse(rawFileId);
  return uploadFileContent(
    fileId,
    content,
    libraryFileSchema(departmentId),
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
  );
}

export async function archiveLibraryFile(
  rawDepartmentId: string,
  rawFileId: string,
  signal?: AbortSignal,
): Promise<LibraryFile> {
  const departmentId = uuid.parse(rawDepartmentId);
  const fileId = uuid.parse(rawFileId);
  const file = checkedFile(
    await apiFetch(
      `/files/${fileId}/archive`,
      libraryFileSchema(departmentId),
      {
        method: "POST",
        cache: "no-store",
        signal,
      },
    ),
    fileId,
  );
  if (!file.isDeleted || ["deleting", "purged"].includes(file.state))
    throw new ApiContractError();
  return file;
}

export async function reopenLibraryFile(
  rawDepartmentId: string,
  rawFileId: string,
  signal?: AbortSignal,
): Promise<LibraryFile> {
  const departmentId = uuid.parse(rawDepartmentId);
  const fileId = uuid.parse(rawFileId);
  const file = checkedFile(
    await apiFetch(`/files/${fileId}/reopen`, libraryFileSchema(departmentId), {
      method: "POST",
      cache: "no-store",
      signal,
    }),
    fileId,
  );
  if (file.isDeleted || ["deleting", "purged"].includes(file.state))
    throw new ApiContractError();
  return file;
}

export function downloadLibraryFile(
  file: LibraryFile,
  signal?: AbortSignal,
): Promise<Blob> {
  if (file.state !== "ready") throw new ApiContractError();
  const fileId = uuid.parse(file.id);
  return requestFileContent(
    `/files/${fileId}/content`,
    file.actualSize ?? file.expectedSize,
    signal,
  );
}
