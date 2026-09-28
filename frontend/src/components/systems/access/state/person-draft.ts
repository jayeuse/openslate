import { z } from "zod";

import type { PersonDraft } from "../helpers/people";
import {
  beginDraftSubmission,
  browserStorage,
  clearDraft,
  finishUncertainDraft,
  readDraft,
  writeDraft,
  type AccessDraftStorage,
  type ReadResult,
} from "./draft-journal-storage";

// The person editor's draft in the per-tab journal ("identity" owner). It
// keeps unsaved details across a reload and marks a save that was sent but
// not answered as uncertain, so the editor asks for a review instead of
// sending it twice.

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

export function readPersonDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): ReadResult<StoredPersonDraft> {
  return readDraft(userId, OWNER, storedSchema, target, storage);
}

export function writePersonDraft(
  userId: string,
  value: StoredPersonDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return writeDraft(userId, OWNER, value, storedSchema, target, storage);
}

export function clearPersonDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraft(userId, OWNER, storedSchema, target, storage);
}

export function beginPersonSubmission(
  userId: string,
  value: StoredPersonDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return beginDraftSubmission(
    userId,
    OWNER,
    value,
    storedSchema,
    target,
    storage,
  );
}

/**
 * End an uncertain save. `confirmed` is true when the server answered; false
 * when a person discards an uncertain save after reviewing the current state.
 */
export function finishPersonSubmission(
  userId: string,
  confirmed: boolean,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return finishUncertainDraft(
    userId,
    OWNER,
    storedSchema,
    target,
    storage,
    confirmed,
  );
}
