import { z } from "zod";
import { ApiContractError, ApiError, apiFetch, apiRequest } from "@/lib/api";
import {
  fileWireSchema,
  reserveFile,
  uploadFileContent,
} from "../../shared/adapters/files-api";
import { getWorkspaceBrand } from "./workspace-api";

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const uuid = z.uuid();
const imageTypes = ["image/png", "image/jpeg"] as const;
export const workspaceLogoFileSchema = fileWireSchema
  .extend({
    purpose: z.literal("workspace_logo"),
    record_id: z.null(),
    board_id: z.null(),
    department_id: z.null(),
    expected_size: z.number().int().min(1).max(MAX_LOGO_BYTES),
    actual_size: z.number().int().min(1).max(MAX_LOGO_BYTES).nullable(),
  })
  .superRefine((file, context) => {
    if (
      file.state === "ready" &&
      (file.actual_size === null ||
        !imageTypes.some((type) => type === file.media_type))
    ) {
      context.addIssue({
        code: "custom",
        message: "Ready logo metadata is invalid",
      });
    }
  });
export type WorkspaceLogoFile = z.output<typeof workspaceLogoFileSchema>;

export function validLogoSelection(file: File): boolean {
  return (
    file.size > 0 &&
    file.size <= MAX_LOGO_BYTES &&
    imageTypes.some((type) => type === file.type)
  );
}

export function reserveWorkspaceLogo(
  file: File,
  signal?: AbortSignal,
): Promise<WorkspaceLogoFile> {
  if (!validLogoSelection(file)) throw new ApiContractError();
  return reserveFile({ filename: file.name, expectedSize: file.size }, (body) =>
    apiFetch("/files", workspaceLogoFileSchema, {
      method: "POST",
      body: JSON.stringify({ ...body, purpose: "workspace_logo" }),
      signal,
    }),
  );
}

async function requireSuccess(response: Response): Promise<Response> {
  if (response.ok) return response;
  const body: unknown = await response.json().catch(() => null);
  const detail: unknown =
    typeof body === "object" && body !== null && "detail" in body
      ? body.detail
      : null;
  const message =
    typeof detail === "string"
      ? detail
      : typeof detail === "object" &&
          detail !== null &&
          "message" in detail &&
          typeof detail.message === "string"
        ? detail.message
        : "The logo request could not be completed.";
  throw new ApiError(response.status, message, detail);
}

export function uploadWorkspaceLogo(
  fileId: string,
  file: File,
  signal?: AbortSignal,
): Promise<WorkspaceLogoFile> {
  const id = uuid.parse(fileId);
  if (!validLogoSelection(file)) throw new ApiContractError();
  return uploadFileContent(
    id,
    file,
    workspaceLogoFileSchema,
    async () =>
      requireSuccess(
        await apiRequest(`/files/${id}/content`, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": "application/octet-stream" },
          signal,
        }),
      ),
    signal,
  );
}

export async function getWorkspaceLogoFile(
  fileId: string,
  signal?: AbortSignal,
): Promise<WorkspaceLogoFile> {
  const id = uuid.parse(fileId);
  const file = await apiFetch(`/files/${id}`, workspaceLogoFileSchema, {
    cache: "no-store",
    signal,
  });
  if (file.id !== id) throw new ApiContractError();
  return file;
}

export async function reconcileWorkspaceLogo(
  fileId: string,
  signal?: AbortSignal,
): Promise<WorkspaceLogoFile> {
  const id = uuid.parse(fileId);
  const file = await apiFetch(
    `/files/${id}/reconcile`,
    workspaceLogoFileSchema,
    { method: "POST", signal },
  );
  if (file.id !== id) throw new ApiContractError();
  return file;
}

const listInput = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
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
  .strict();
export type WorkspaceLogoListInput = z.output<typeof listInput>;

export function listWorkspaceLogoFiles(
  raw: WorkspaceLogoListInput,
  signal?: AbortSignal,
) {
  const input = listInput.parse(raw);
  const parameters = new URLSearchParams({
    purpose: "workspace_logo",
    deleted: "include",
    sort_by: "created_at",
    sort_order: "desc",
    limit: String(input.limit),
    offset: String(input.offset),
  });
  const page = z
    .object({
      items: z.array(workspaceLogoFileSchema).max(input.limit),
      pagination,
    })
    .strict()
    .superRefine((page, context) => {
      const meta = page.pagination;
      if (
        meta.limit !== input.limit ||
        meta.offset !== input.offset ||
        meta.count !== page.items.length ||
        meta.total < meta.count ||
        meta.has_more !== meta.offset + meta.count < meta.total ||
        new Set(page.items.map((file) => file.id)).size !== page.items.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Logo page metadata is invalid",
        });
      }
    });
  return apiFetch(`/files?${parameters}`, page, { cache: "no-store", signal });
}

export class WorkspaceLogoBindingChanged extends Error {
  constructor() {
    super("The organization logo changed while it was loading.");
  }
}

/** Inline content is bounded and bound to a verified File identity before caching. */
export async function getWorkspaceLogo(
  expectedFileId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const expected = uuid.parse(expectedFileId);
  const response = await requireSuccess(
    await apiRequest("/workspace/logo", { cache: "no-store", signal }),
  );
  const type = response.headers
    .get("Content-Type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (
    response.status !== 200 ||
    !imageTypes.some((value) => value === type) ||
    response.headers.get("X-Content-Type-Options")?.toLowerCase() !==
      "nosniff" ||
    !response.headers
      .get("Cache-Control")
      ?.toLowerCase()
      .split(/\s*,\s*/)
      .includes("no-store") ||
    response.body === null
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiContractError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_LOGO_BYTES) throw new ApiContractError();
      // A copied buffer is Blob-compatible and owns no mutable provider stream data.
      chunks.push(new Uint8Array(next.value));
    }
    if (total === 0) throw new ApiContractError();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  const brand = await getWorkspaceBrand(signal);
  signal?.throwIfAborted();
  if (brand.logo_file_id !== expected) throw new WorkspaceLogoBindingChanged();
  return new Blob(chunks, { type });
}
