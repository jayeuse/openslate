import { z } from "zod";

import {
  browserStorage,
  discardDraft,
  readDraft,
  writeDraft,
  type AccessDraftOwner,
  type AccessDraftStorage,
} from "./draft-journal-storage";

// The Invite, Create group, and invitation settings forms in the per-tab
// journal. Back and Forward have no guard, so these forms keep their input
// here and come back when the person returns, as the person and group
// drafts do.

const uuid = z.uuid();
const days = z.string().max(6);

const inviteSchema = z.strictObject({
  email: z.string().max(320),
  /** Null until edited: the username follows the email address. */
  username: z.string().max(100).nullable(),
  display_name: z.string().max(200),
  job_title: z.string().max(200),
  role: z.enum(["admin", "member", "guest"]),
  group_ids: z.array(uuid).max(500),
  sponsor_user_id: z.string().max(64),
  /** Null until edited: the days follow the invitation settings. */
  days: days.nullable(),
});
export type InviteDraft = z.output<typeof inviteSchema>;

const groupCreateSchema = z.strictObject({
  name: z.string().max(200),
  description: z.string().max(2000),
  member_ids: z.array(uuid).max(100),
});
export type GroupCreateDraft = z.output<typeof groupCreateSchema>;

const invitationSettingsSchema = z.strictObject({
  invitationExpiryDays: days.optional(),
  guestDurationDays: days.optional(),
});
export type InvitationSettingsDraft = z.output<typeof invitationSettingsSchema>;

function formJournal<T>(owner: AccessDraftOwner, schema: z.ZodType<T>) {
  const target = () => owner;
  return {
    /** The kept form, or null when there is none or it cannot be used. */
    read(
      userId: string,
      storage: AccessDraftStorage | undefined = browserStorage(),
    ): T | null {
      const result = readDraft(userId, owner, schema, target, storage);
      return result.status === "ready" ? result.value : null;
    },
    write(
      userId: string,
      value: T,
      storage: AccessDraftStorage | undefined = browserStorage(),
    ): boolean {
      return writeDraft(userId, owner, value, schema, target, storage);
    },
    /** False while the browser still keeps the form. */
    discard(
      userId: string,
      storage: AccessDraftStorage | undefined = browserStorage(),
    ): boolean {
      return discardDraft(userId, owner, schema, target, storage);
    },
  };
}

export const inviteDraftJournal = formJournal("invite", inviteSchema);
export const groupCreateDraftJournal = formJournal(
  "group-create",
  groupCreateSchema,
);
export const invitationSettingsDraftJournal = formJournal(
  "settings",
  invitationSettingsSchema,
);
