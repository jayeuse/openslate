/**
 * Hidden calendars are a per-viewer convenience (BR52): kept in this
 * browser's storage, per account and board. Storage can be missing or
 * blocked (a private window, cleared site data), so every read and write is
 * guarded and the calendar shows everything without it.
 */

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

export function hiddenCalendarsKey(viewerId: string, boardId: string): string {
  return `openslate.boards.calendar.hidden.${viewerId}.${boardId}`;
}

export function browserStorage(): Storage {
  return globalThis.localStorage;
}

export function readHiddenCalendars(
  storage: () => ReadableStorage,
  key: string,
): string[] {
  try {
    const value: unknown = JSON.parse(storage().getItem(key) ?? "[]");
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function writeHiddenCalendars(
  storage: () => WritableStorage,
  key: string,
  ids: readonly string[],
): void {
  try {
    storage().setItem(key, JSON.stringify(ids));
  } catch {
    // The choice still applies until the page closes.
  }
}

/** My calendar's hidden calendars, kept apart from every board's own. */
export function myCalendarHiddenKey(viewerId: string): string {
  return hiddenCalendarsKey(viewerId, "my-calendar");
}
