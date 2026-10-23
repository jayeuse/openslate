import { z } from "zod";

import type { PersonDraft } from "../helpers/people";
import {
  accessDraftSubmissionNeedsReload,
  beginDraftSubmission,
  browserStorage,
  clearDraft,
  discardDraft,
  finishUncertainDraft,
  readDraft,
  writeDraft,
  type AccessDraftStorage,
  type ReadResult,
} from "./draft-journal-storage";

// The person editor's drafts in the per-tab journal ("identity" owner), one
// record per person. It keeps unsaved details across a reload and marks a
// save that was sent but not answered as uncertain, so the editor asks for a
// review instead of sending it twice.

const personDraftSchema: z.ZodType<PersonDraft> = z.strictObject({
  username: z.string().max(100),
  display_name: z.string().max(200),
  job_title: z.string().max(200),
  role: z.enum(["admin", "member", "guest"]),
  sponsor_user_id: z.string().max(64),
  expires_on: z.string().max(10),
});

export type StoredPersonDraft = {
  personId: string;
  baseline: PersonDraft;
  draft: PersonDraft;
};

const storedSchema: z.ZodType<StoredPersonDraft> = z.strictObject({
  personId: z.uuid(),
  baseline: personDraftSchema,
  draft: personDraftSchema,
});

const target = (value: StoredPersonDraft) => `person:${value.personId}`;
const OWNER = "identity";
/** One journal slot per person, so a kept draft of one never replaces another's. */
const slot = (personId: string) => ({ owner: OWNER, id: personId }) as const;

export function readPersonDraft(
  userId: string,
  personId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): ReadResult<StoredPersonDraft> {
  return readDraft(userId, slot(personId), storedSchema, target, storage);
}

export function writePersonDraft(
  userId: string,
  value: StoredPersonDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return writeDraft(
    userId,
    slot(value.personId),
    value,
    storedSchema,
    target,
    storage,
  );
}

export function clearPersonDraft(
  userId: string,
  personId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraft(userId, slot(personId), storedSchema, target, storage);
}

/** Discard the editable draft; false while the browser still keeps it. */
export function discardPersonDraft(
  userId: string,
  personId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return discardDraft(userId, slot(personId), storedSchema, target, storage);
}

export function beginPersonSubmission(
  userId: string,
  value: StoredPersonDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return beginDraftSubmission(
    userId,
    slot(value.personId),
    value,
    storedSchema,
    target,
    storage,
  );
}

/** A save of this target was sent from this page and may still land. */
export function personSubmissionNeedsReload(
  userId: string,
  personId: string,
): boolean {
  return accessDraftSubmissionNeedsReload(userId, slot(personId));
}

/**
 * End an uncertain save. `confirmed` is true when the server answered; false
 * when a person discards an uncertain save after reviewing the current state.
 */
export function finishPersonSubmission(
  userId: string,
  personId: string,
  confirmed: boolean,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return finishUncertainDraft(
    userId,
    slot(personId),
    storedSchema,
    target,
    storage,
    confirmed,
  );
}
