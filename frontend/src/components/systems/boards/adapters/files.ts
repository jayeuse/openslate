import {
  cacheLocalAttachment,
  localAttachmentUrl,
  releaseAllLocalAttachments,
  releaseLocalAttachment,
} from "../../shared/runtime/local-attachments";
import {
  BOARD_ATTACHMENT_TYPES,
  BOARD_INPUT_LIMITS,
  type BoardAttachment,
} from "../domain/model";

export const BOARD_FILE_LIMITS = {
  maxFiles: BOARD_INPUT_LIMITS.maxAttachments,
  maxBytes: BOARD_INPUT_LIMITS.maxAttachmentBytes,
  types: BOARD_ATTACHMENT_TYPES,
} as const;

export type BoardFileAdmissionResult =
  { ok: true; attachments: BoardAttachment[] } | { ok: false; error: string };

function createAttachmentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `sample-board-attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizedMimeType(file: Pick<File, "type">): string {
  return file.type.trim().toLowerCase();
}

function fileError(file: Pick<File, "name" | "size" | "type">): string | null {
  const name = file.name.trim();
  if (!name) return "File name is required.";
  if (name.length > 160)
    return `${name.slice(0, 160)} has a name that is too long.`;
  if (!Number.isInteger(file.size) || file.size < 0)
    return `${name} has an invalid file size.`;
  if (file.size > BOARD_FILE_LIMITS.maxBytes)
    return `${name} exceeds the 10 MiB attachment limit.`;
  if (
    !(BOARD_FILE_LIMITS.types as readonly string[]).includes(
      normalizedMimeType(file),
    )
  )
    return `${name} uses an unsupported file type.`;
  return null;
}

export function createBoardAttachmentMetadata(
  file: Pick<File, "name" | "size" | "type">,
  id = createAttachmentId(),
): BoardAttachment {
  return {
    id,
    name: file.name.trim(),
    size: file.size,
    type: normalizedMimeType(file),
  };
}

/**
 * Validate and append local file metadata. File bytes remain in the existing
 * tab-local registry and never enter the persisted sample snapshot.
 */
export function admitBoardFiles(
  files: readonly File[],
  current: readonly BoardAttachment[],
): BoardFileAdmissionResult {
  if (current.length + files.length > BOARD_FILE_LIMITS.maxFiles)
    return {
      ok: false,
      error: `You can attach up to ${BOARD_FILE_LIMITS.maxFiles} files.`,
    };
  for (const file of files) {
    const error = fileError(file);
    if (error) return { ok: false, error };
  }
  return {
    ok: true,
    attachments: [
      ...current,
      ...files.map((file) => createBoardAttachmentMetadata(file)),
    ],
  };
}

/** Normalize an explicit external URL without fetching or executing it. */
export function isSafeBoardUrl(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || candidate.length > 2048) return null;
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      !parsed.hostname
    )
      return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export const safeBoardUrl = isSafeBoardUrl;

/** Cache bytes using the shared Comms registry; only metadata is persisted. */
export function cacheBoardAttachment(id: string, file: File): string {
  const error = fileError(file);
  if (error) throw new Error(error);
  return cacheLocalAttachment(id, file);
}

export function boardAttachmentUrl(id: string): string | undefined {
  return localAttachmentUrl(id);
}

export function releaseBoardAttachment(id: string): void {
  releaseLocalAttachment(id);
}

export function releaseBoardAttachments(
  attachments: readonly Pick<BoardAttachment, "id">[],
): void {
  for (const attachment of attachments) releaseBoardAttachment(attachment.id);
}

/** Release blob URLs removed from a saved collection while keeping survivors. */
export function releaseRemovedBoardAttachments(
  previous: readonly Pick<BoardAttachment, "id">[],
  next: readonly Pick<BoardAttachment, "id">[],
): void {
  const retained = new Set(next.map((attachment) => attachment.id));
  for (const attachment of previous) {
    if (!retained.has(attachment.id)) releaseBoardAttachment(attachment.id);
  }
}

/** Release all draft or reset-owned board files through the shared registry. */
export function releaseAllBoardAttachments(): void {
  releaseAllLocalAttachments();
}
