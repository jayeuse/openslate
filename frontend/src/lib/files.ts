import { z } from "zod";
import { ApiError, apiFetch, listQuery, type Pagination } from "./api";
export const fileSchema = z.object({
  id: z.string(),
  purpose: z.enum(["record_attachment", "library_document", "workspace_logo"]),
  record_id: z.string().nullable(),
  creator_id: z.string(),
  filename: z.string(),
  media_type: z.string().nullable(),
  expected_size: z.number(),
  actual_size: z.number().nullable(),
  state: z.enum([
    "awaiting_upload",
    "uploading",
    "pending_scan",
    "ready",
    "rejected",
    "deleting",
    "purged",
  ]),
  failure_code: z.string().nullable(),
  is_deleted: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ManagedFile = z.infer<typeof fileSchema>;
export type FilePurpose = ManagedFile["purpose"];
export const DOCUMENT_ACCEPT = ".pdf,.jpg,.jpeg,.png,.docx,.xlsx,.pptx";
export const LOGO_ACCEPT = ".jpg,.jpeg,.png";
export const fileStateLabels: Record<ManagedFile["state"], string> = {
  awaiting_upload: "Waiting for upload",
  uploading: "Upload outcome pending",
  pending_scan: "Scanning in background",
  ready: "Ready",
  rejected: "Rejected",
  deleting: "Deletion pending",
  purged: "Permanently deleted",
};
export function fileSelectionError(
  file: { name: string; size: number },
  logo = false,
): string | null {
  const maximum = (logo ? 2 : 25) * 1024 * 1024;
  if (file.size === 0) return "Choose a non-empty file.";
  if (file.size > maximum)
    return `Choose a file no larger than ${logo ? 2 : 25} MiB.`;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (
    !(
      logo
        ? ["jpg", "jpeg", "png"]
        : ["pdf", "jpg", "jpeg", "png", "docx", "xlsx", "pptx"]
    ).includes(extension ?? "")
  )
    return logo
      ? "Choose a JPEG or PNG image."
      : "Choose a PDF, JPEG, PNG, DOCX, XLSX or PPTX file.";
  return null;
}
export async function reserveFile(
  file: File,
  purpose: FilePurpose,
  recordId?: string,
): Promise<ManagedFile> {
  const reason = fileSelectionError(file, purpose === "workspace_logo");
  if (reason) throw new Error(reason);
  return fileSchema.parse(
    await apiFetch<unknown>("/files", {
      method: "POST",
      body: JSON.stringify({
        purpose,
        record_id: recordId ?? null,
        filename: file.name,
        expected_size: file.size,
      }),
    }),
  );
}
async function binaryResponse(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`/bff${path}`, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail =
      body && typeof body === "object" && "detail" in body ? body.detail : null;
    const message =
      typeof detail === "string"
        ? detail
        : detail &&
            typeof detail === "object" &&
            "message" in detail &&
            typeof detail.message === "string"
          ? detail.message
          : "File transfer could not be completed.";
    throw new ApiError(response.status, message);
  }
  return response;
}
export async function uploadFile(id: string, file: File): Promise<ManagedFile> {
  const response = await binaryResponse(
    `/files/${encodeURIComponent(id)}/content`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
      signal: AbortSignal.timeout(125_000),
    },
  );
  return fileSchema.parse(await response.json());
}
export async function fileAction(
  id: string,
  action: "scan" | "archive" | "reopen" | "reconcile",
): Promise<ManagedFile> {
  return fileSchema.parse(
    await apiFetch<unknown>(`/files/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      signal: AbortSignal.timeout(action === "scan" ? 15_000 : 125_000),
    }),
  );
}
export async function listFiles(
  purpose: FilePurpose,
  recordId: string | undefined,
  offset: number,
  signal?: AbortSignal,
): Promise<{ items: ManagedFile[]; pagination: Pagination }> {
  const schema = z.object({
    items: z.array(fileSchema),
    pagination: z.object({
      limit: z.number(),
      offset: z.number(),
      count: z.number(),
      total: z.number(),
      has_more: z.boolean(),
    }),
  });
  return schema.parse(
    await apiFetch<unknown>(
      `/files?${listQuery({ purpose, record_id: recordId, limit: 25, offset, deleted: "include", sort_by: "created_at", sort_order: "desc" })}`,
      { signal },
    ),
  );
}
export async function downloadFile(file: ManagedFile): Promise<void> {
  const response = await binaryResponse(
    `/files/${encodeURIComponent(file.id)}/content`,
    { signal: AbortSignal.timeout(125_000) },
  );
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function canRetryScan(file: ManagedFile): boolean {
  return (
    file.state === "pending_scan" &&
    !file.is_deleted &&
    ["scan_exhausted", "scan_suspended", "scan_adoption_required"].includes(
      file.failure_code ?? "",
    )
  );
}
export function fileFailureMessage(code: string): string {
  const messages: Record<string, string> = {
    upload_unresolved:
      "The upload outcome is unresolved. An administrator can reconcile this upload.",
    scan_unavailable:
      "Scanning is temporarily unavailable. Background retries are scheduled.",
    scan_exhausted:
      "Automatic scan retries are exhausted. Retry scanning when the service is available.",
    scan_suspended:
      "Scanning is blocked by access or record status. An authorized writer can retry once access is restored and the record is open.",
    scan_adoption_required:
      "An authorized writer must retry scanning to resume this file.",
    scan_execution_unresolved:
      "The scan execution is unresolved. Ask an operator to resolve it before retrying.",
    scan_integrity_error:
      "File integrity validation failed. Upload a new file.",
    scan_policy_rejected:
      "This file was rejected by scanning policy. Upload an allowed file.",
    scan_infected:
      "Malware was detected. This file cannot be used or downloaded.",
  };
  return (
    messages[code] ??
    "This file is unavailable. Refresh its status or contact an administrator."
  );
}
