import { z } from "zod";

export const ACCESS_DRAFT_STORAGE_PREFIX = "openslate.access.draft.v1.";
export const draftIdentifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const MAX_RECORD_LENGTH = 32_768;
export type AccessDraftOwner =
  "rules" | "identity" | "role" | "group" | "defaults";
const submissionsBegunInDocument = new Set<string>();

export type AccessDraftStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

export type ReadResult<T> = {
  status: "ready" | "uncertain" | "invalid" | "unavailable";
  value: T | null;
};

export function browserStorage(): AccessDraftStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function accessDraftStorageKey(
  userId: string,
  owner: AccessDraftOwner,
): string {
  return `${accessDraftUserStoragePrefix(userId)}${owner}`;
}

export function accessDraftSubmissionNeedsReload(
  userId: string,
  owner: AccessDraftOwner,
): boolean {
  return submissionsBegunInDocument.has(accessDraftStorageKey(userId, owner));
}

export function accessDraftUserStoragePrefix(userId: string): string {
  // encodeURIComponent leaves dots untouched; encode them to keep user keys
  // from prefix-matching another account's key during cleanup.
  return `${ACCESS_DRAFT_STORAGE_PREFIX}${encodeURIComponent(userId).replaceAll(".", "%2E")}.`;
}

export function readDraft<T>(
  userId: string,
  owner: AccessDraftOwner,
  schema: z.ZodType<T>,
  target: (value: T) => string,
  storage: AccessDraftStorage | undefined,
): ReadResult<T> {
  if (!storage) return { status: "unavailable", value: null };
  let raw: string | null;
  try {
    raw = storage.getItem(accessDraftStorageKey(userId, owner));
  } catch {
    return { status: "unavailable", value: null };
  }
  if (raw === null) return { status: "ready", value: null };
  if (raw.length > MAX_RECORD_LENGTH) return { status: "invalid", value: null };
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
  owner: AccessDraftOwner,
  payload: T,
  schema: z.ZodType<T>,
  target: (value: T) => string,
  storage: AccessDraftStorage | undefined,
): boolean {
  if (!storage) return false;
  const parsed = schema.safeParse(payload);
  if (!draftIdentifier.safeParse(userId).success || !parsed.success)
    return false;
  const current = readDraft(userId, owner, schema, target, storage);
  if (current.status === "uncertain" || current.status === "unavailable")
    return false;
  const raw = JSON.stringify({
    version: 1,
    userId,
    owner,
    target: target(parsed.data),
    payload: parsed.data,
  });
  if (raw.length > MAX_RECORD_LENGTH) return false;
  try {
    storage.setItem(accessDraftStorageKey(userId, owner), raw);
    return true;
  } catch {
    return false;
  }
}

export function beginDraftSubmission<T>(
  userId: string,
  owner: AccessDraftOwner,
  payload: T,
  schema: z.ZodType<T>,
  target: (value: T) => string,
  storage: AccessDraftStorage | undefined,
): boolean {
  if (!storage) return false;
  const parsed = schema.safeParse(payload);
  if (!draftIdentifier.safeParse(userId).success || !parsed.success)
    return false;
  if (readDraft(userId, owner, schema, target, storage).status !== "ready")
    return false;
  const key = accessDraftStorageKey(userId, owner);
  const raw = JSON.stringify({
    version: 1,
    userId,
    owner,
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
  owner: AccessDraftOwner,
  schema: z.ZodType<T>,
  target: (value: T) => string,
  storage: AccessDraftStorage | undefined,
  onlyUncertain = false,
): boolean {
  if (!storage) return false;
  const current = readDraft(userId, owner, schema, target, storage);
  if (
    onlyUncertain
      ? current.status !== "uncertain"
      : current.status === "uncertain" || current.status === "unavailable"
  )
    return false;
  const key = accessDraftStorageKey(userId, owner);
  let retired = false;
  try {
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        userId,
        owner,
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
  owner: AccessDraftOwner,
  schema: z.ZodType<T>,
  target: (value: T) => string,
  storage: AccessDraftStorage | undefined,
  confirmed: boolean,
): boolean {
  const key = accessDraftStorageKey(userId, owner);
  if (!confirmed && submissionsBegunInDocument.has(key)) return false;
  if (!clearDraft(userId, owner, schema, target, storage, true)) return false;
  if (confirmed) submissionsBegunInDocument.delete(key);
  return true;
}

export function clearDraftKeys(
  shouldClear: (key: string) => boolean,
  storage: AccessDraftStorage | undefined,
): boolean {
  if (!storage) return false;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key && shouldClear(key)) keys.push(key);
    }
    for (const key of keys) {
      storage.removeItem(key);
      submissionsBegunInDocument.delete(key);
    }
    return true;
  } catch {
    return false;
  }
}

export function clearAccessDraftStorageExcept(
  userId: string | null,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  const keep = userId === null ? null : accessDraftUserStoragePrefix(userId);
  return clearDraftKeys(
    (key) =>
      key.startsWith(ACCESS_DRAFT_STORAGE_PREFIX) &&
      (keep === null || !key.startsWith(keep)),
    storage,
  );
}
