// The rules of the Access draft registry, apart from React. Each open
// editor registers one entry; guards ask about, and discard, only the
// entries in their scope.

export type RegisteredDraft = {
  /** Unsaved edits that the editor can discard. */
  dirty: boolean;
  /** A save is in flight. */
  pending: boolean;
  /** Discards the edits; false when they are still kept. */
  discard: () => boolean | void;
};

/** Which registered drafts a guard owns. */
export type DraftScope = (id: string) => boolean;

export const everyDraft: DraftScope = () => true;

/**
 * Discards every unsaved draft in `scope`. Nothing is discarded while a draft
 * in scope is saving. False when a draft in scope is saving or could not be
 * discarded; drafts outside the scope are never touched.
 */
export function discardDraftsIn(
  drafts: Iterable<readonly [string, RegisteredDraft]>,
  scope: DraftScope,
): boolean {
  const owned = [...drafts].filter(([id]) => scope(id));
  if (owned.some(([, draft]) => draft.pending)) return false;
  for (const [, draft] of owned)
    if (draft.dirty && draft.discard() === false) return false;
  return true;
}
