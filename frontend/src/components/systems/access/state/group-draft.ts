import { z } from "zod";

import type { GroupDetails } from "../helpers/groups";
import type { AccessGroupAccessEntry } from "./api-contracts";
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

// The group editor's drafts in the per-tab journal ("group" owner): one
// record for the open group with a draft per section. A save marks the
// record uncertain with the section it sent, so a save that got no answer
// is reviewed instead of being sent twice.

export type GroupSection = "details" | "members" | "access";

type Edit<Value> = { baseline: Value; draft: Value };

export type StoredGroupDraft = {
  groupId: string;
  details: Edit<GroupDetails> | null;
  members: Edit<string[]> | null;
  access: Edit<AccessGroupAccessEntry[]> | null;
  /** The section a save sent; set only while that save is unanswered. */
  sending: GroupSection | null;
};

const uuid = z.uuid();
const detailsSchema = z.strictObject({
  name: z.string().max(200),
  description: z.string().max(2000),
});
const membersSchema = z.array(uuid).max(100);
const accessSchema = z
  .array(
    z.strictObject({
      department_id: uuid,
      module_id: uuid.nullable(),
      level: z.enum(["read", "write", "manage"]),
    }),
  )
  .max(500);

function edit<Value extends z.ZodType>(value: Value) {
  return z.strictObject({ baseline: value, draft: value }).nullable();
}

const storedSchema: z.ZodType<StoredGroupDraft> = z.strictObject({
  groupId: uuid,
  details: edit(detailsSchema),
  members: edit(membersSchema),
  access: edit(accessSchema),
  sending: z.enum(["details", "members", "access"]).nullable(),
});

const target = (value: StoredGroupDraft) => `group:${value.groupId}`;
const OWNER = "group";

export function readGroupDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): ReadResult<StoredGroupDraft> {
  return readDraft(userId, OWNER, storedSchema, target, storage);
}

export function writeGroupDraft(
  userId: string,
  value: StoredGroupDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return writeDraft(userId, OWNER, value, storedSchema, target, storage);
}

export function clearGroupDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraft(userId, OWNER, storedSchema, target, storage);
}

export function beginGroupSubmission(
  userId: string,
  value: StoredGroupDraft,
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
 * when a person discards an uncertain save after reviewing the current group.
 */
export function finishGroupSubmission(
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
