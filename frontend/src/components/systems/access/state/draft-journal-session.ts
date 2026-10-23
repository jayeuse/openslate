// The part of the Access draft journal that every signed-in page needs: the
// key format, clearing on sign-out or an organization switch, and the check
// for a save that may have completed. It has no schema code, so the workspace
// shell can load it without the editors' journal (draft-journal-storage.ts).

export const ACCESS_DRAFT_STORAGE_PREFIX = "openslate.access.draft.v1.";

/** Keys whose save began in this document; draft-journal-storage writes them. */
export const submissionsBegunInDocument = new Set<string>();
// Advances whenever every account's drafts are cleared (sign-out, an account
// or organization switch). A save that answers after a newer generation
// began writes nothing back.
let journalGeneration = 0;

export function accessDraftJournalGeneration(): number {
  return journalGeneration;
}

export function encodeKeyPart(value: string): string {
  // encodeURIComponent leaves dots untouched; encode them so one part can
  // never prefix-match another.
  return encodeURIComponent(value).replaceAll(".", "%2E");
}

export type AccessDraftStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

export function browserStorage(): AccessDraftStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function accessDraftUserStoragePrefix(userId: string): string {
  // Encoded dots keep user keys from prefix-matching another account's key
  // during cleanup.
  return `${ACCESS_DRAFT_STORAGE_PREFIX}${encodeKeyPart(userId)}.`;
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
  // Clearing every account's drafts (sign-out, an account or organization
  // switch) starts a new generation; keeping one account's drafts does not.
  if (userId === null) journalGeneration += 1;
  const keep = userId === null ? null : accessDraftUserStoragePrefix(userId);
  return clearDraftKeys(
    (key) =>
      key.startsWith(ACCESS_DRAFT_STORAGE_PREFIX) &&
      (keep === null || !key.startsWith(keep)),
    storage,
  );
}

function uncertainKeys(userId: string, storage: AccessDraftStorage): string[] {
  const prefix = accessDraftUserStoragePrefix(userId);
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    try {
      const record: unknown = JSON.parse(storage.getItem(key) ?? "null");
      if (
        typeof record === "object" &&
        record !== null &&
        "state" in record &&
        record.state === "uncertain"
      )
        keys.push(key);
    } catch {
      // An unreadable record is not a save that may have completed.
    }
  }
  return keys;
}

/**
 * Whether this account's journal holds a save that may have completed. It
 * stays in the journal after its editor closes, so the page guards ask about
 * it before an organization switch or a sign-out clears it.
 */
export function accessDraftsHoldUncertainSave(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    return uncertainKeys(userId, storage).length > 0;
  } catch {
    return false;
  }
}

/** Forgets this account's saves that may have completed, after a person chose to discard them. */
export function abandonUncertainDrafts(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return true;
  try {
    for (const key of uncertainKeys(userId, storage)) {
      storage.removeItem(key);
      submissionsBegunInDocument.delete(key);
    }
    return true;
  } catch {
    return false;
  }
}
