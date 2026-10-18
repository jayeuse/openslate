"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerWorkspaceSessionClear } from "@/components/systems/shared/runtime/workspace-identity";
import { reportDone } from "@/lib/feedback";
import { parseSandboxDocumentValue } from "../domain/document-parser";
import type {
  SandboxDocumentV4,
  SandboxTrigger,
} from "../domain/document-types";
import { triggerLiteralError, unsavedTriggerChanges } from "./trigger-studio";

/**
 * Unsaved trigger edits. The page owns them, so leaving the Triggers view
 * (a section link, Back, Forward) keeps them, and a copy in session storage
 * survives a reload until the person restores or discards it.
 */
export type TriggerDraft = {
  draft: SandboxTrigger[];
  dirty: boolean;
  pending: boolean;
  /** Triggers added, changed, or deleted since the last save. */
  changes: number;
  /** Ids of triggers that are new or changed in the draft. */
  unsaved: ReadonlySet<string>;
  error: string;
  /** The saved triggers changed after these edits began. */
  baseChanged: boolean;
  /** Edits kept from before a reload, waiting for Restore or Discard. */
  kept: KeptTriggerDraft | null;
  update: (
    next: SandboxTrigger[] | ((current: SandboxTrigger[]) => SandboxTrigger[]),
  ) => void;
  save: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Drops the edits and returns them, so Undo can put them back. */
  discard: () => SandboxTrigger[] | null;
  restore: (edits: SandboxTrigger[]) => void;
  restoreKept: () => void;
  discardKept: () => void;
};

export type KeptTriggerDraft = {
  triggers: SandboxTrigger[];
  /** The saved triggers changed since these edits were kept. */
  baseChanged: boolean;
};

type StoredTriggerDraft = { base: string; triggers: SandboxTrigger[] };
type DraftStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

export const TRIGGER_DRAFT_STORAGE_PREFIX =
  "openslate.sandbox.trigger-draft.v1.";
const MAX_STORED_LENGTH = 1_048_576;

function encode(value: string): string {
  // Encoded dots keep one account's prefix from matching another's.
  return encodeURIComponent(value).replaceAll(".", "%2E");
}

export function triggerDraftUserPrefix(userId: string): string {
  return `${TRIGGER_DRAFT_STORAGE_PREFIX}${encode(userId)}.`;
}

export function triggerDraftStorageKey(
  userId: string,
  orgId: string | null,
): string {
  return `${triggerDraftUserPrefix(userId)}${encode(orgId ?? "session")}`;
}

function browserStorage(): DraftStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Writes the edits, or removes the record when there are none. */
export function writeKeptTriggerDraft(
  storage: DraftStorage | undefined,
  key: string,
  record: StoredTriggerDraft | null,
): void {
  if (!storage) return;
  try {
    if (!record) {
      storage.removeItem(key);
      return;
    }
    const text = JSON.stringify({ version: 1, ...record });
    if (text.length > MAX_STORED_LENGTH) storage.removeItem(key);
    else storage.setItem(key, text);
  } catch {
    // Without storage the edits still live on this page until it unloads.
  }
}

/**
 * Reads kept edits and checks them with the document parser against the
 * current draft, so a damaged or stale record is dropped, not shown.
 */
export function readKeptTriggerDraft(
  storage: DraftStorage | undefined,
  key: string,
  document: SandboxDocumentV4,
): StoredTriggerDraft | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(key);
    if (!text || text.length > MAX_STORED_LENGTH) return null;
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("base" in value) ||
      typeof value.base !== "string" ||
      !("triggers" in value)
    )
      return null;
    const parsed = parseSandboxDocumentValue(
      { ...document, triggers: value.triggers },
      false,
    );
    return { base: value.base, triggers: parsed.triggers };
  } catch {
    return null;
  }
}

/** Removes every kept trigger draft of one account (sign-out). */
export function clearKeptTriggerDrafts(
  userId: string,
  storage: Pick<Storage, "key" | "length" | "removeItem"> | undefined,
): void {
  if (!storage) return;
  try {
    const prefix = triggerDraftUserPrefix(userId);
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Storage that cannot be read holds nothing to clear.
  }
}

export function useTriggerDraft({
  document,
  persist,
  userId,
  orgId,
  confirmed,
}: {
  /** The saved draft; null while the Sandbox loads. */
  document: SandboxDocumentV4 | null;
  /**
   * False while the page holds a draft the server refused (a failed save
   * leaves it on the page). Edits that match it are not saved yet, so they
   * stay until a confirmed save or a reload.
   */
  confirmed: boolean;
  persist: (triggers: SandboxTrigger[]) => Promise<void>;
  userId: string;
  orgId: string | null;
}): TriggerDraft {
  const saved = useMemo(() => document?.triggers ?? [], [document]);
  const savedKey = useMemo(() => JSON.stringify(saved), [saved]);
  const [edits, setEditsState] = useState<SandboxTrigger[] | null>(null);
  // Callbacks read the edits through a ref, so an Undo made later works on
  // the current edits, not the ones from when it was created.
  const editsRef = useRef<SandboxTrigger[] | null>(null);
  const setEdits = useCallback((next: SandboxTrigger[] | null) => {
    editsRef.current = next;
    setEditsState(next);
  }, []);
  const [base, setBase] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [kept, setKept] = useState<StoredTriggerDraft | null>(null);
  const storageKey = triggerDraftStorageKey(userId, orgId);
  const loadedKey = useRef<string | null>(null);

  // Once the draft loads, offer edits kept from before a reload.
  useEffect(() => {
    if (!document || loadedKey.current === storageKey) return;
    loadedKey.current = storageKey;
    const stored = readKeptTriggerDraft(browserStorage(), storageKey, document);
    if (stored && JSON.stringify(stored.triggers) !== savedKey) setKept(stored);
    else writeKeptTriggerDraft(browserStorage(), storageKey, null);
  }, [document, savedKey, storageKey]);

  useEffect(
    () =>
      registerWorkspaceSessionClear(userId, () =>
        clearKeptTriggerDrafts(userId, browserStorage()),
      ),
    [userId],
  );

  const draft = edits ?? saved;
  const draftKey = edits ? JSON.stringify(edits) : savedKey;
  const dirty = edits !== null && draftKey !== savedKey;

  // Keep the edits in session storage while they are unsaved, and remove
  // them once they are saved or discarded. Opening the page writes nothing,
  // so a record that waits for Restore stays until the person decides.
  const stored = useRef(false);
  useEffect(() => {
    if (edits && (dirty || !confirmed)) {
      writeKeptTriggerDraft(browserStorage(), storageKey, {
        base,
        triggers: edits,
      });
      stored.current = true;
    } else if (stored.current) {
      writeKeptTriggerDraft(browserStorage(), storageKey, null);
      stored.current = false;
    }
  }, [base, confirmed, dirty, edits, storageKey]);

  // Edits that match triggers the server confirmed (a reapplied draft) are
  // no longer edits.
  useEffect(() => {
    if (confirmed && !pending && edits && !dirty) setEdits(null);
  }, [confirmed, dirty, edits, pending, setEdits]);

  const unsaved = useMemo(() => {
    if (!dirty || !edits) return new Set<string>();
    const savedById = new Map(saved.map((item) => [item.id, item]));
    return new Set(
      edits
        .filter((item) => {
          const before = savedById.get(item.id);
          return !before || JSON.stringify(before) !== JSON.stringify(item);
        })
        .map((item) => item.id),
    );
  }, [dirty, edits, saved]);

  // Callbacks read the latest saved triggers, draft and design without
  // re-creating themselves on every keystroke.
  const savedRef = useRef({ saved, savedKey });
  const draftRef = useRef(draft);
  const dirtyRef = useRef(dirty);
  const designRef = useRef(document?.design);
  useEffect(() => {
    savedRef.current = { saved, savedKey };
    draftRef.current = draft;
    dirtyRef.current = dirty;
    designRef.current = document?.design;
  });

  const update = useCallback<TriggerDraft["update"]>(
    (next) => {
      const current = savedRef.current;
      const value =
        typeof next === "function"
          ? next(editsRef.current ?? current.saved)
          : next;
      // New edits replace edits kept from before a reload.
      setKept(null);
      setError("");
      // Typing back to the saved triggers leaves nothing to save.
      if (JSON.stringify(value) === current.savedKey) {
        setEdits(null);
        return;
      }
      if (editsRef.current === null) setBase(current.savedKey);
      setEdits(value);
    },
    [setEdits],
  );

  const save = useCallback(async (): Promise<
    { ok: true } | { ok: false; error: string }
  > => {
    // Nothing to save (for example Ctrl+S with no edits) writes nothing.
    if (!dirtyRef.current) return { ok: true };
    const snapshot = structuredClone(draftRef.current);
    const design = designRef.current;
    const validationError = design
      ? snapshot
          .map((recordTrigger) => triggerLiteralError(recordTrigger, design))
          .find((message): message is string => message !== null)
      : undefined;
    if (validationError) {
      setError(validationError);
      return { ok: false, error: validationError };
    }
    setPending(true);
    try {
      await persist(snapshot);
      setEdits(null);
      setError("");
      reportDone("Triggers saved");
      return { ok: true };
    } catch {
      const failure =
        "The trigger change could not be saved. Your draft is still available.";
      setError(failure);
      return { ok: false, error: failure };
    } finally {
      setPending(false);
    }
  }, [persist, setEdits]);

  const discard = useCallback(() => {
    const previous = editsRef.current;
    setEdits(null);
    setError("");
    return previous;
  }, [setEdits]);

  const restore = useCallback(
    (next: SandboxTrigger[]) => {
      setEdits(next);
      setBase(savedRef.current.savedKey);
      setError("");
    },
    [setEdits],
  );

  const restoreKept = useCallback(() => {
    if (!kept) return;
    setEdits(kept.triggers);
    setBase(kept.base);
    setKept(null);
    setError("");
  }, [kept, setEdits]);

  const discardKept = useCallback(() => {
    setKept(null);
    writeKeptTriggerDraft(browserStorage(), storageKey, null);
  }, [storageKey]);

  return {
    draft,
    dirty,
    pending,
    changes: dirty && edits ? unsavedTriggerChanges(edits, saved) : 0,
    unsaved,
    error,
    baseChanged: dirty && base !== savedKey,
    kept: kept
      ? { triggers: kept.triggers, baseChanged: kept.base !== savedKey }
      : null,
    update,
    save,
    discard,
    restore,
    restoreKept,
    discardKept,
  };
}
