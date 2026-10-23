import { z } from "zod";

import {
  accessDraftUserStoragePrefix,
  browserStorage,
  encodeKeyPart,
  submissionsBegunInDocument,
  type AccessDraftStorage,
} from "./draft-journal-session";

export {
  ACCESS_DRAFT_STORAGE_PREFIX,
  abandonUncertainDrafts,
  accessDraftJournalGeneration,
  accessDraftsHoldUncertainSave,
  accessDraftUserStoragePrefix,
  browserStorage,
  clearAccessDraftStorageExcept,
  clearDraftKeys,
  type AccessDraftStorage,
} from "./draft-journal-session";

export const draftIdentifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const MAX_RECORD_LENGTH = 32_768;
export type AccessDraftOwner =
  "identity" | "group" | "settings" | "invite" | "group-create";
/**
 * Where a draft lives: an owner with one slot, or an owner with one slot per
 * target (a person or a group), so editing one target never replaces the
 * kept draft of another.
 */
export type AccessDraftSlot =
  AccessDraftOwner | { owner: AccessDraftOwner; id: string };
function slotOwner(slot: AccessDraftSlot): AccessDraftOwner {
  return typeof slot === "string" ? slot : slot.owner;
}

export type ReadResult<T> = {
  status: "ready" | "uncertain" | "invalid" | "unavailable";
  value: T | null;
};

export function accessDraftStorageKey(
  userId: string,
  slot: AccessDraftSlot,
): string {
  const prefix = accessDraftUserStoragePrefix(userId);
  return typeof slot === "string"
    ? `${prefix}${slot}`
    : `${prefix}${slot.owner}.${encodeKeyPart(slot.id)}`;
}

export function accessDraftSubmissionNeedsReload(
  userId: string,
  slot: AccessDraftSlot,
): boolean {
  return submissionsBegunInDocument.has(accessDraftStorageKey(userId, slot));
}

export function readDraft<T>(
  userId: string,
  slot: AccessDraftSlot,
  schema: z.ZodType<T>,
  target: (value: T) => string,
  storage: AccessDraftStorage | undefined,
): ReadResult<T> {
  if (!storage) return { status: "unavailable", value: null };
  let raw: string | null;
  try {
    raw = storage.getItem(accessDraftStorageKey(userId, slot));
  } catch {
    return { status: "unavailable", value: null };
  }
  if (raw === null) return { status: "ready", value: null };
  if (raw.length > MAX_RECORD_LENGTH) return { status: "invalid", value: null };
  const owner = slotOwner(slot);
  try {
    const data: unknown = JSON.parse(raw);
    const retired = z
      .object({
        version: z.literal(1),
        userId: draftIdentifier,
        owner: z.literal(owner),
        target: z.literal("retired"),
        state: z.literal("retired"),
      })
      .strict()
      .safeParse(data);
    if (retired.success)
      return retired.data.userId === userId
        ? { status: "ready", value: null }
        : { status: "invalid", value: null };
    const record = z
      .object({
        version: z.literal(1),
        userId: draftIdentifier,
        owner: z.literal(owner),
        target: z.string().min(1).max(600),
        state: z.literal("uncertain").optional(),
        payload: schema,
      })
      .strict()
      .safeParse(data);
    if (
      !record.success ||
      record.data.userId !== userId ||
      record.data.target !== target(record.data.payload)
    )
      return { status: "invalid", value: null };
    return {
      status: record.data.state === "uncertain" ? "uncertain" : "ready",
      value: record.data.payload,
    };
  } catch {
    return { status: "invalid", value: null };
  }
}

export function writeDraft<T>(
  userId: string,
  slot: AccessDraftSlot,
  payload: T,
  schema: z.ZodType<T>,
  target: (value: T) => string,
  storage: AccessDraftStorage | undefined,
): boolean {
  if (!storage) return false;
  const parsed = schema.safeParse(payload);
  if (!draftIdentifier.safeParse(userId).success || !parsed.success)
    return false;
  const current = readDraft(userId, slot, schema, target, storage);
  if (current.status === "uncertain" || current.status === "unavailable")
    return false;
  const raw = JSON.stringify({
    version: 1,
    userId,
    owner: slotOwner(slot),
    target: target(parsed.data),
    payload: parsed.data,
  });
  if (raw.length > MAX_RECORD_LENGTH) return false;
  try {
    storage.setItem(accessDraftStorageKey(userId, slot), raw);
    return true;
  } catch {
    return false;
  }
}

export function beginDraftSubmission<T>(
  userId: string,
  slot: AccessDraftSlot,
  payload: T,
  schema: z.ZodType<T>,
  target: (value: T) => string,
  storage: AccessDraftStorage | undefined,
): boolean {
  if (!storage) return false;
  const parsed = schema.safeParse(payload);
  if (!draftIdentifier.safeParse(userId).success || !parsed.success)
    return false;
  if (readDraft(userId, slot, schema, target, storage).status !== "ready")
    return false;
  const key = accessDraftStorageKey(userId, slot);
  const raw = JSON.stringify({
    version: 1,
    userId,
    owner: slotOwner(slot),
    target: target(parsed.data),
    state: "uncertain",
    payload: parsed.data,
  });
  if (raw.length > MAX_RECORD_LENGTH) return false;
  try {
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) return false;
    submissionsBegunInDocument.add(key);
    return true;
  } catch {
    return false;
  }
}

export function clearDraft<T>(
  userId: string,
  slot: AccessDraftSlot,
  schema: z.ZodType<T>,
  target: (value: T) => string,
  storage: AccessDraftStorage | undefined,
  onlyUncertain = false,
): boolean {
  if (!storage) return false;
  const current = readDraft(userId, slot, schema, target, storage);
  if (
    onlyUncertain
      ? current.status !== "uncertain"
      : current.status === "uncertain" || current.status === "unavailable"
  )
    return false;
  const key = accessDraftStorageKey(userId, slot);
  let retired = false;
  try {
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        userId,
        owner: slotOwner(slot),
        target: "retired",
        state: "retired",
      }),
    );
    retired = true;
  } catch {
    // Removal may still succeed when writing is unavailable.
  }
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return retired;
  }
}

export function finishUncertainDraft<T>(
  userId: string,
  slot: AccessDraftSlot,
  schema: z.ZodType<T>,
  target: (value: T) => string,
  storage: AccessDraftStorage | undefined,
  confirmed: boolean,
): boolean {
  const key = accessDraftStorageKey(userId, slot);
  if (!confirmed && submissionsBegunInDocument.has(key)) return false;
  if (!clearDraft(userId, slot, schema, target, storage, true)) return false;
  if (confirmed) submissionsBegunInDocument.delete(key);
  return true;
}

/**
 * Discard an editable draft. True when no editable draft remains in this
 * browser afterwards; false when one is still kept (the storage refused the
 * change) or the slot holds a save that may have completed.
 */
export function discardDraft<T>(
  userId: string,
  slot: AccessDraftSlot,
  schema: z.ZodType<T>,
  target: (value: T) => string,
  storage: AccessDraftStorage | undefined,
): boolean {
  // Without storage nothing was ever kept.
  if (!storage) return true;
  if (clearDraft(userId, slot, schema, target, storage)) return true;
  const after = readDraft(userId, slot, schema, target, storage);
  return after.status === "ready" && after.value === null;
}

/**
 * Removes this account's drafts from the earlier journal, which kept one
 * person and one group draft per account. Per-target slots replaced it.
 */
export function removeSingleSlotDrafts(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  for (const owner of ["identity", "group"] as const) {
    try {
      storage.removeItem(accessDraftStorageKey(userId, owner));
    } catch {
      // A kept old record is never read again; sign-out clears it.
    }
  }
}
